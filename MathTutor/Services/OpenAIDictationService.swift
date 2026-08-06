import AVFAudio
import AudioToolbox
import Foundation
import os

/// Dictation as two halves: `AVAudioEngine` records what the student says, and OpenAI's
/// transcription endpoint turns the finished recording into text.
///
/// The order matters to the product, not just to the code. Apple's recogniser wrote words into
/// the composer *while* the student spoke; a file transcription cannot, because there is no
/// file until the student stops. So a session now has two phases with about a second between
/// them, and `DictationPhase` is how the composer is told which one it is in.
@MainActor
final class OpenAIDictationService: DictationService {
    /// How long one recording may run.
    ///
    /// The endpoint rejects files over 25 MB. At 16 kHz mono 16-bit that ceiling is about
    /// thirteen minutes, and this stops at one: a spoken maths question is a few seconds, a
    /// child thinking out loud is a few more, and a minute is far past both while being about
    /// 1.9 MB — under a tenth of the limit, so no arithmetic slip about the format can reach
    /// it. Reaching the cap ends the recording the same way a second tap does, transcribing
    /// what was said, rather than failing an upload the student cannot see coming.
    ///
    /// This is a ceiling, not the silence timeout the composer still refuses to have: it ends
    /// a microphone left open by accident, and it never cuts off a student mid-thought at a
    /// pause. Apple's own guidance is the same number — *"plan for a one-minute limit on audio
    /// duration... similar to the one for keyboard-related dictation"* — and because reaching
    /// it transcribes rather than discards, nothing is lost at the boundary, which is what
    /// keeps WCAG 2.2.1 out of it. The composer's elapsed label is the warning.
    nonisolated static let captureLimit: TimeInterval = 60

    /// The recording's whole allocation, taken once before the engine starts so the audio
    /// thread never grows a buffer.
    ///
    /// A function of the rate the hardware actually gave us rather than the one that was asked
    /// for: if the route comes back at 48 kHz the ceiling is three times the bytes for the same
    /// minute, and it is the minute that is the promise.
    nonisolated static func byteLimit(sampleRate: Double) -> Int {
        Int(captureLimit * sampleRate) * (WAVFile.bitsPerSample / 8)
    }

    private let apiKeyReader: @Sendable () -> String?
    private let session: URLSession
    private let engine = AVAudioEngine()
    /// What the route actually recorded at, which is what the WAV header has to say.
    private var captureSampleRate = Double(WAVFile.sampleRate)

    /// The one value the main actor and CoreAudio's render thread both touch.
    ///
    /// The tap block is called on a real-time audio thread, so it cannot hop to the main actor
    /// to reach the recording — a hop would drop buffers, and the buffer itself is not
    /// `Sendable` to carry across. `OSAllocatedUnfairLock` is the stdlib's own answer for
    /// non-`Sendable` state shared this way: the lock is `Sendable`, so the tap closure can be
    /// `@Sendable` and capture nothing else, and the unchecked accessors say plainly that the
    /// guarantee here is the lock rather than the type system.
    private let recording = OSAllocatedUnfairLock<Recording?>(uncheckedState: nil)

    private var continuation: AsyncThrowingStream<DictationTranscript, any Error>.Continuation?
    private var transcription: Task<Void, Never>?
    private var ceiling: Task<Void, Never>?
    private var isCapturing = false

    /// How loud the microphone is right now, 0…1, or 0 when nothing is being captured.
    ///
    /// Read rather than published: the meter samples this at ~20 Hz from its own timeline, so
    /// pushing twenty state changes a second through the view tree would buy nothing and
    /// re-render the whole composer for each one.
    var inputLevel: Double { recording.withLockUnchecked { $0?.level ?? 0 } }

    /// The same credential `TutorServiceRouter` uses, read the same way. There is deliberately
    /// no second path: a dictation-only key would be a second thing to explain to a parent and
    /// a second thing to leak.
    init(
        keychain: KeychainStore = KeychainStore(),
        apiKeyReader: (@Sendable () -> String?)? = nil,
        session: URLSession = .shared
    ) {
        self.apiKeyReader = apiKeyReader ?? { keychain.readAPIKey() }
        self.session = session
    }

    /// There is a key to transcribe with.
    ///
    /// Unlike the recogniser this replaced, the credential *is* part of whether the button is
    /// drawn at all. A refused microphone still gets a mic — that refusal is recoverable and
    /// the button is the only route to the recovery — but a first run with no key has nothing
    /// behind dictation at all, and a mic that can only ever raise a notice is exactly the
    /// dead control this design does not have anywhere.
    var isSupported: Bool { credential != nil }

    var availability: DictationAvailability {
        .resolve(
            microphone: AVAudioApplication.shared.recordPermission,
            hasCredential: credential != nil
        )
    }

    /// One permission now, where there were two. Speech recognition was Apple's framework's
    /// own, and asking for it while never calling that framework would be a permission taken
    /// for nothing.
    func requestAuthorization() async -> DictationAvailability {
        if AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        return availability
    }

    func start() throws -> AsyncThrowingStream<DictationTranscript, any Error> {
        guard credential != nil else { throw DictationError.unavailable }
        cancel()

        do {
            let audioSession = AVAudioSession.sharedInstance()
            try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
            // Asking the route itself for 16 kHz is what keeps the tap's work to a format
            // change and not a resample: `AVAudioConverter` can only convert a buffer in one
            // call when the rate does not change, and the block form that does resample is
            // handed a non-`Sendable` buffer through a `@Sendable` closure. This is a
            // preference, not a guarantee — whatever the hardware answers with is recorded and
            // sent, and the endpoint resamples anyway.
            try? audioSession.setPreferredSampleRate(Double(WAVFile.sampleRate))
            try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            throw DictationError.audioUnavailable
        }

        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        // A route with no sample rate is a device with no microphone attached — the
        // simulator's usual state. Installing a tap on it traps inside CoreAudio, so this is
        // the difference between the "dictation isn't available" notice and a crash.
        guard inputFormat.sampleRate > 0 else {
            deactivateSession()
            throw DictationError.audioUnavailable
        }

        // Mono 16-bit at whatever rate the route gave us: WAV's own format, so the file is the
        // samples with a 44-byte header in front and no encoder in the middle.
        guard let uploadFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: inputFormat.sampleRate,
            channels: 1,
            interleaved: true
        ), let converter = AVAudioConverter(from: inputFormat, to: uploadFormat) else {
            deactivateSession()
            throw DictationError.audioUnavailable
        }

        captureSampleRate = inputFormat.sampleRate
        recording.withLockUnchecked {
            $0 = Recording(
                converter: converter,
                format: uploadFormat,
                byteLimit: Self.byteLimit(sampleRate: inputFormat.sampleRate)
            )
        }

        let recording = self.recording
        input.installTap(onBus: 0, bufferSize: 1024, format: inputFormat) { @Sendable buffer, _ in
            recording.withLockUnchecked { $0?.append(buffer) }
        }

        let (stream, continuation) = AsyncThrowingStream<DictationTranscript, any Error>.makeStream()
        self.continuation = continuation
        continuation.onTermination = { [weak self] _ in
            Task { @MainActor in self?.cancel() }
        }
        // Set before the engine starts so the failure below tears the tap back down through
        // the one path that knows how.
        isCapturing = true

        do {
            engine.prepare()
            try engine.start()
        } catch {
            cancel()
            throw DictationError.audioUnavailable
        }

        ceiling = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.captureLimit))
            guard !Task.isCancelled else { return }
            // The same act as the student's second tap: the words they did say are still
            // transcribed and still theirs.
            self?.stop()
        }
        Self.playEarcon(.start)
        return stream
    }

    /// The student has finished speaking. The microphone closes here; the stream stays open
    /// for as long as the words take to come back.
    func stop() {
        guard isCapturing, let continuation else { return }
        let audio = endCapture()

        guard let key = credential else {
            continuation.finish(throwing: DictationError.unavailable)
            self.continuation = nil
            return
        }
        // Nothing was said, or the tap never delivered a buffer. Not a failure and not worth a
        // notice — the composer simply holds what it held before.
        guard !audio.isEmpty else {
            continuation.finish()
            self.continuation = nil
            return
        }

        // Says the microphone has closed before the first word can possibly arrive, so the
        // composer can change what it is showing at the moment the student stops talking
        // rather than a second later.
        continuation.yield(DictationTranscript(text: "", isFinal: false, phase: .transcribing))

        let client = OpenAITranscriptionClient(apiKey: key, session: session)
        let file = WAVFile.data(pcm16: audio, sampleRate: Int(captureSampleRate))
        // Captures the continuation and the request, and nothing of `self`: the upload is not
        // the service's state, and cancelling the task is the only hold it needs to keep.
        transcription = Task {
            do {
                for try await reading in client.readings(for: file) {
                    continuation.yield(reading)
                    if reading.isFinal { break }
                }
                continuation.finish()
            } catch {
                continuation.finish(throwing: (error as? DictationError) ?? .recognitionFailed)
            }
        }
    }

    /// Everything a session allocates, released in the reverse of the order it was taken, and
    /// safe to run twice: the stream's own termination handler calls this too, so a session
    /// the student abandons and one that ends by itself arrive at the same place.
    func cancel() {
        ceiling?.cancel()
        ceiling = nil
        if isCapturing { _ = endCapture() }
        transcription?.cancel()
        transcription = nil

        // Cleared before the stream is finished, so the re-entrant call from `onTermination`
        // finds nothing left to do rather than recursing.
        let continuation = self.continuation
        self.continuation = nil
        continuation?.finish()
    }

    /// The key, read at the moment it is needed and never held between sessions. Whitespace
    /// counts as absent, the same rule `TutorServiceRouter` applies.
    private var credential: String? {
        guard let key = apiKeyReader()?.trimmingCharacters(in: .whitespacesAndNewlines),
              !key.isEmpty else { return nil }
        return key
    }

    /// Closes the microphone and takes the recording out of the lock. Never writes it anywhere:
    /// the audio exists as one `Data` in memory, is handed to one request, and is released with
    /// the request.
    private func endCapture() -> Data {
        isCapturing = false
        ceiling?.cancel()
        ceiling = nil

        engine.inputNode.removeTap(onBus: 0)
        engine.stop()

        let audio = recording.withLockUnchecked { state -> Data in
            let samples = state?.samples ?? Data()
            state = nil
            return samples
        }

        deactivateSession()
        Self.playEarcon(.stop)
        return audio
    }

    /// Handing the audio route back is what un-ducks whatever was playing before.
    private func deactivateSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// The sounds at the two ends of a recording.
    ///
    /// Apple's own speech guidance is to *"display a visual indicator and play sounds at the
    /// beginning and end of speech recognition"*, and Amazon's is blunter about why: the sound
    /// *"allows the customer to know your assistant has heard their request without looking at
    /// the screen"* — which is the whole of the feedback for a student who cannot see the meter.
    ///
    /// The system's own record-start and record-stop sounds rather than bundled assets: they
    /// are the ones this student has already learned from keyboard dictation, and they are two
    /// values instead of two files. Note that the `record` category *"doesn't respond to the
    /// silence switch"*, so these will sound on a silenced iPad — which is the intent, since a
    /// silenced iPad is exactly where a student cannot tell the microphone opened.
    ///
    /// The start tone overlaps the first moment of the recording, because the microphone is
    /// already open by the time it sounds. That is the right trade: a transcriber returns
    /// nothing for a beep, and delaying the tone until the tone had finished would mean
    /// delaying the moment the student can start speaking.
    enum Earcon: SystemSoundID {
        case start = 1113
        case stop = 1114
    }

    nonisolated static func playEarcon(_ earcon: Earcon) {
        AudioServicesPlaySystemSound(earcon.rawValue)
    }
}

// MARK: - What the audio thread writes into

/// The recording, in the format it will be uploaded in.
///
/// Conversion happens on the audio thread rather than at the end, because the alternative is
/// holding every float buffer for the length of the recording and converting a minute of audio
/// in one burst on the main actor. `AVAudioConverter` is a non-`Sendable` reference type, which
/// is why this whole struct lives behind the service's unfair lock.
private struct Recording {
    let converter: AVAudioConverter
    let format: AVAudioFormat
    /// Where the recording stops. Belongs to the recording rather than to the tap because the
    /// tap is called on a thread that must not be handed a decision to make.
    let byteLimit: Int
    private(set) var samples: Data
    /// The recording reached its ceiling. The tap stops appending immediately; the session is
    /// ended a moment later by the main actor, which is the side that can transcribe.
    private(set) var isFull = false

    /// How loud the last buffer was, 0…1, smoothed.
    ///
    /// This is the number the composer's meter is made of, and the reason it is computed here
    /// rather than animated in the view: a meter driven by a timer would move identically for a
    /// working microphone, a muted one, a Smart Folio closed over the mic array and a student
    /// sitting too far away. Motion that is *caused by* the microphone is the only honest
    /// indicator, and App Store guideline 2.5.14 requires the app — not the OS's orange dot —
    /// to show one while recording.
    private(set) var level: Double = 0

    init(converter: AVAudioConverter, format: AVAudioFormat, byteLimit: Int) {
        self.converter = converter
        self.format = format
        self.byteLimit = byteLimit
        // The whole minute, allocated before the engine starts, so nothing the audio thread
        // does can grow this buffer.
        samples = Data(capacity: byteLimit)
    }

    mutating func append(_ buffer: AVAudioPCMBuffer) {
        guard !isFull, buffer.frameLength > 0 else { return }
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength) else { return }

        // The one-call form, which is available precisely because the rate does not change: a
        // float-to-integer change and a downmix need no buffering, so there is no input block
        // and nothing non-`Sendable` crosses a closure.
        do {
            try converter.convert(to: converted, from: buffer)
        } catch {
            return
        }

        guard converted.frameLength > 0, let channel = converted.int16ChannelData else { return }
        let frames = UnsafeBufferPointer(start: channel[0], count: Int(converted.frameLength))
        level = DictationLevel.smoothed(level, towards: DictationLevel.level(rms: Self.rms(of: frames)))
        samples.append(frames)
        if samples.count >= byteLimit { isFull = true }
    }

    /// The buffer's root mean square, 0…1. RMS rather than peak because a meter should follow
    /// how loud the student *sounds*, not how loud one sample was.
    static func rms(of frames: UnsafeBufferPointer<Int16>) -> Double {
        guard !frames.isEmpty else { return 0 }
        var sumOfSquares = 0.0
        for frame in frames {
            let sample = Double(frame) / Double(Int16.max)
            sumOfSquares += sample * sample
        }
        return (sumOfSquares / Double(frames.count)).squareRoot()
    }
}

// MARK: - The meter's arithmetic

/// How an amplitude becomes a bar height, kept as values so it can be asserted on a machine
/// with no microphone — which is every machine this project's tests run on.
enum DictationLevel {
    /// Where the meter's floor sits. A quiet room is around −50 dBFS, so anything below it is
    /// silence as far as the bars are concerned and the meter rests as five dots.
    static let floorDecibels: Double = -50

    /// One-pole smoothing, fast up and slow down, so a bar rises with the syllable and falls
    /// back over a few frames instead of flickering once per buffer.
    static let attack: Double = 0.5
    static let release: Double = 0.15

    /// Decibels rather than raw amplitude because loudness is logarithmic: a linear bar spends
    /// its whole travel in the top of the range and reads as motionless for ordinary speech.
    static func level(rms: Double) -> Double {
        guard rms > 0 else { return 0 }
        let decibels = 20 * log10(rms)
        return min(1, max(0, 1 - decibels / floorDecibels))
    }

    static func smoothed(_ current: Double, towards target: Double) -> Double {
        let coefficient = target > current ? attack : release
        return current + (target - current) * coefficient
    }
}
