import AVFoundation
import Foundation
import WebRTC

enum VoiceAudioSessionEvent {
    /// `detail` names the interrupter as far as AVFoundation is willing to say: the reason
    /// code, whether the app was suspended, and the raw `userInfo` behind both.
    case interruptionBegan(detail: String)
    case interruptionEnded(shouldResume: Bool, detail: String)
    case routeChanged(reason: String, output: String)
    case mediaServicesReset
    case configurationFailed(String)
}

/// Owns the audio session for the live voice call — port of the sleep app's
/// `AudioSessionController` (docs/research/voice-mode/sleep-app-voice-stack.md §1, lessons
/// 1–3, 11, 13).
///
/// **One owner, and it is `RTCAudioSession`.** WebRTC's iOS audio device module is built
/// around 48 kHz / 10 ms buffers and assumes it is the only thing touching the session; a
/// preferred IO buffer or sample rate set outside its configuration lock is the textbook cause
/// of periodic-dropout crackle. Every mutation here goes through `lockForConfiguration` /
/// `setConfiguration`, and **nothing asks for a buffer size or a sample rate** — never prefer
/// 24 kHz on the device even though the wire format says 24 kHz; WebRTC resamples anyway.
///
/// Coexistence with dictation: `BackendDictationService` runs its own `AVAudioEngine` on its
/// own `.record` session, which must never overlap a live call (two audio units fighting for
/// one microphone is sleep lesson 3). The UI gates dictation on
/// `VoiceAudioSessionController.isVoiceSessionActive` / `VoiceSessionControlling.isActive`,
/// and the voice engine refuses to start while dictation is capturing
/// (`VoiceSessionHooks.isDictationActive`).
@MainActor
final class VoiceAudioSessionController {

    static let category: AVAudioSession.Category = .playAndRecord

    /// `.videoChat` rather than `.voiceChat`: both keep echo cancellation (an open microphone
    /// next to a loudspeaker needs it), but `.voiceChat` band-boosts and compresses speech for
    /// the receiver, which makes the built-in speaker sound harsh — and the tutor plays through
    /// the iPad's speaker.
    static let mode: AVAudioSession.Mode = .videoChat

    /// `.defaultToSpeaker` because a tutoring session is a room, not a phone call — it only
    /// decides receiver-versus-speaker when there is no better route, and a connected headset
    /// outranks it. A2DP for headphones at full bandwidth. **No `.allowBluetoothHFP`**: HFP is
    /// the only profile that can carry a Bluetooth microphone, so offering it to
    /// `.playAndRecord` makes iOS take it for both directions and collapse the whole session to
    /// mono 8–16 kHz telephone quality (sleep lesson 13).
    static let options: AVAudioSession.CategoryOptions = [.defaultToSpeaker, .allowBluetoothA2DP]

    /// Whether a live voice call owns the audio session right now. The composer reads this to
    /// keep dictation's microphone away from the call's (the reverse of the gate in
    /// `VoiceSessionHooks.isDictationActive`).
    private(set) static var isVoiceSessionActive = false

    var onEvent: ((VoiceAudioSessionEvent) -> Void)?

    // nonisolated(unsafe): deinit must remove block-based observers, and deinit is
    // nonisolated in Swift 6. Every other access is MainActor-only, and by the time
    // deinit runs no other reference exists.
    private nonisolated(unsafe) var observers: [NSObjectProtocol] = []
    private var isActive = false

    deinit {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    /// Configures and activates the session through WebRTC's own lock. Must be called before
    /// the peer connection is created.
    func activate() throws {
        let rtcConfig = RTCAudioSessionConfiguration.webRTC()
        rtcConfig.category = Self.category.rawValue
        rtcConfig.mode = Self.mode.rawValue
        rtcConfig.categoryOptions = Self.options
        // Sample rate and IO buffer duration are deliberately left at WebRTC's own values
        // (48 kHz, 10 ms). See the type comment; this line is the whole of lesson 1.
        RTCAudioSessionConfiguration.setWebRTC(rtcConfig)

        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        do {
            try rtcSession.setConfiguration(rtcConfig, active: true)
        } catch {
            onEvent?(.configurationFailed("RTCAudioSession: \(error.localizedDescription)"))
            throw error
        }
        isActive = true
        Self.isVoiceSessionActive = true

        startObserving()
        onEvent?(.routeChanged(reason: "activated", output: Self.describeCurrentOutput()))
    }

    /// Re-asserts the configuration and re-activates through WebRTC's lock. The recovery half
    /// of an interruption: `AVAudioSession` does not guarantee an `.ended` notification, so
    /// something other than that notification has to be able to bring the session back.
    ///
    /// Returns whether the session is active afterwards, so the caller can tell "recovered"
    /// from "still gone" instead of assuming.
    @discardableResult
    func reactivate() -> Bool {
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }

        let rtcConfig = RTCAudioSessionConfiguration.webRTC()
        rtcConfig.category = Self.category.rawValue
        rtcConfig.mode = Self.mode.rawValue
        rtcConfig.categoryOptions = Self.options
        do {
            try rtcSession.setConfiguration(rtcConfig, active: true)
            isActive = true
            Self.isVoiceSessionActive = true
            return true
        } catch {
            onEvent?(.configurationFailed("reactivate: \(error.localizedDescription)"))
            return false
        }
    }

    /// Releases the session (and the microphone indicator with it). Safe to call twice; safe
    /// to call without an `activate()`.
    func deactivate() {
        Self.isVoiceSessionActive = false
        stopObserving()
        guard isActive else { return }
        isActive = false
        let rtcSession = RTCAudioSession.sharedInstance()
        rtcSession.lockForConfiguration()
        try? rtcSession.setActive(false)
        rtcSession.unlockForConfiguration()
    }

    var hasRecordPermission: Bool {
        AVAudioApplication.shared.recordPermission == .granted
    }

    func requestRecordPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    static func describeCurrentOutput() -> String {
        let outputs = AVAudioSession.sharedInstance().currentRoute.outputs
        guard !outputs.isEmpty else { return "none" }
        return outputs.map { $0.portType.rawValue }.joined(separator: ",")
    }

    // MARK: - Private

    private func startObserving() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            // Notification is not Sendable; extract the primitives before the actor hop.
            let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let optionsRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt
            let reasonRaw = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt
            MainActor.assumeIsolated {
                self?.handleInterruption(typeRaw: typeRaw, optionsRaw: optionsRaw, reasonRaw: reasonRaw)
            }
        })

        observers.append(center.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: session,
            queue: .main
        ) { [weak self] note in
            let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
            MainActor.assumeIsolated { self?.handleRouteChange(reasonRaw: reasonRaw) }
        })

        observers.append(center.addObserver(
            forName: AVAudioSession.mediaServicesWereResetNotification,
            object: session,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleMediaServicesReset() }
        })
    }

    private func stopObserving() {
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    private func handleInterruption(typeRaw: UInt?, optionsRaw: UInt?, reasonRaw: UInt?) {
        guard let raw = typeRaw,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }

        let detail = Self.describeInterruption(reasonRaw: reasonRaw)

        switch type {
        case .began:
            onEvent?(.interruptionBegan(detail: detail))
        case .ended:
            var shouldResume = false
            if let optionsRaw {
                shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume)
            }
            if shouldResume {
                let rtcSession = RTCAudioSession.sharedInstance()
                rtcSession.lockForConfiguration()
                do {
                    try rtcSession.setActive(true)
                    isActive = true
                } catch {
                    onEvent?(.configurationFailed("resume after interruption: \(error.localizedDescription)"))
                    shouldResume = false
                }
                rtcSession.unlockForConfiguration()
            }
            onEvent?(.interruptionEnded(shouldResume: shouldResume, detail: detail))
        @unknown default:
            break
        }
    }

    /// Everything the notification carries, in one line. The reason key is the field that
    /// names the interrupter; the raw `userInfo` dump behind it is there because Apple keeps
    /// adding keys, and a log that only prints what this build knew about cannot answer next
    /// year's question.
    private static func describeInterruption(reasonRaw: UInt?) -> String {
        var parts: [String] = []

        if let raw = reasonRaw {
            parts.append("reason=\(reasonName(raw))(\(raw))")
        } else {
            parts.append("reason=absent")
        }
        // `AVAudioSessionInterruptionWasSuspendedKey` is deliberately not read: deprecated in
        // iOS 14.5, and `reason=app_was_suspended` above carries the same fact.
        parts.append("route=\(describeCurrentOutput())")
        return parts.joined(separator: " ")
    }

    /// `AVAudioSession.InterruptionReason` raw values. Spelled out rather than switched over
    /// the enum so a deprecated case does not turn a diagnostic into a warning, and a value
    /// this SDK has never heard of still prints as a number instead of vanishing.
    private static func reasonName(_ raw: UInt) -> String {
        switch raw {
        case 0: return "default"
        case 1: return "app_was_suspended"
        case 2: return "built_in_mic_muted"
        case 3: return "route_disconnected"
        default: return "unknown"
        }
    }

    private func handleRouteChange(reasonRaw: UInt?) {
        let reason = reasonRaw.flatMap { AVAudioSession.RouteChangeReason(rawValue: $0) }
        let description: String
        switch reason {
        case .newDeviceAvailable: description = "new_device"
        case .oldDeviceUnavailable: description = "device_removed"
        case .categoryChange: description = "category_change"
        case .override: description = "override"
        case .wakeFromSleep: description = "wake"
        case .noSuitableRouteForCategory: description = "no_route"
        case .routeConfigurationChange: description = "route_config"
        case .unknown, .none: description = "unknown"
        @unknown default: description = "unknown"
        }

        // A disappearing route (headphones pulled out) must not silently kill the call:
        // reassert the session so audio falls back to the built-in speaker and microphone.
        if reason == .oldDeviceUnavailable || reason == .noSuitableRouteForCategory {
            reactivate()
        }

        onEvent?(.routeChanged(reason: description, output: Self.describeCurrentOutput()))
    }

    /// The media server crashed out from under the app; every audio object the process held is
    /// dead (sleep lesson 11). The session is rebuilt here; the coordinator re-enables the
    /// microphone track when it sees the event.
    private func handleMediaServicesReset() {
        isActive = false
        onEvent?(.mediaServicesReset)
        do {
            try activate()
        } catch {
            onEvent?(.configurationFailed("media services reset: \(error.localizedDescription)"))
        }
    }
}
