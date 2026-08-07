import SwiftUI

/// The two things dictation has to say that the design never drew.
///
/// Board 05 open question 18, verbatim: *"`btn/voice` appears in every composer with no
/// recording, listening, or permission state designed."* Board 14's answer for the *thread's*
/// failures — a tutor message with a recovery chip, no box and no colour — is the right idiom
/// for something the tutor did. Neither of these is: one is iOS holding a permission the
/// student has to go and change, and the other is the platform declining. Both are answered
/// on the system's own surface for exactly that, which invents no visual value at all and
/// keeps the composer's own row untouched.
enum DictationNotice: String, Identifiable, Sendable {
    /// Refused or restricted. Not a dead button: iOS shows its permission alert once per
    /// install, so every tap after that has to offer the only route that still works.
    ///
    /// The copy deliberately does not promise a deep link: `openSettingsURLString` only ever
    /// opens the app's own settings pane, never the Microphone toggle itself.
    case permission
    /// A microphone that cannot be opened at all — no input route, or another app holding it.
    /// A transcription that failed is *not* this: it is a composer note, because the composer
    /// is where the student was and a modal alert over the board is not.
    case unavailable

    var id: String { rawValue }

    var title: String {
        switch self {
        case .permission: "Dictation needs the microphone"
        case .unavailable: "Dictation isn't available right now"
        }
    }

    /// Plain, and about the student's next move rather than about the API that failed. Nothing
    /// here is ever built from a provider's error text: it can quote what was heard.
    var message: String {
        switch self {
        case .permission:
            "The microphone is turned off for Math Tutor. You can turn it back on in Settings, or type your question instead."
        case .unavailable:
            "Math Tutor couldn't open the microphone just now. You can type your question instead."
        }
    }
}

/// The one line above the composer when a session ends with nothing to show for it.
///
/// Board 15 §02. Not an alert and not a chip: the retry is the mic, 12pt below and already
/// under the student's thumb, so a second control would be a second thing to dismiss.
enum DictationNote: String, Identifiable, Sendable {
    /// Nothing was said — or nothing that survived the hallucination guard.
    case empty
    /// The transcription failed after its retries.
    case failed

    var id: String { rawValue }

    /// *"I didn't catch anything that time."* — Google's conversation-design rule is not to say
    /// "I didn't hear you", because the student probably did not say anything and being told
    /// they were not heard reads as an accusation. This says the tutor missed it, and does not
    /// claim to have heard silence.
    var text: String {
        switch self {
        case .empty: "I didn't catch anything that time."
        case .failed: "That didn't come back as text. You can try again, or type it."
        }
    }
}

/// The mic button's whole behaviour: what a tap means, what happens to the text, and what
/// ends a session.
///
/// **Tap to start, tap to stop — not hold-to-talk.** The design draws one bare hit area with
/// no pressed state and no second frame, so a press-and-hold gesture would need an appearance
/// nothing in the boards provides. Apple's own two voice surfaces — keyboard dictation and
/// Messages audio — are both tap-toggles that offer hold only as an accelerator.
///
/// The accessibility argument is the one that closes it, and the commonly-cited criterion is
/// the wrong one: **WCAG 2.5.2 does not rule hold out** (its down-event only starts recording,
/// so it passes via Abort-or-Undo). What bites is **2.1.1 Keyboard**, which requires operation
/// *"without requiring specific timings for individual keystrokes"* and names a key that must
/// be held as a failure — covering hardware keyboards, Full Keyboard Access and Switch Control.
/// And VoiceOver has no variable-duration press at all: it maps "touch and hold" to a **triple
/// tap**, a discrete event, so a hold-to-talk mic would start and instantly stop a recording.
///
/// The product reason stands beside it: the student is holding an Apple Pencil in the hand that
/// is not tapping, and is thinking aloud in sentences long enough that a held finger becomes
/// the thing they are concentrating on.
///
/// **Typed text is kept.** Dictation appends to whatever is already in the field rather than
/// replacing it, so a student who typed half a question and then decided to say the rest
/// loses nothing. Nothing about the mic is destructive, which is what lets it be a plain
/// toggle with no confirmation.
///
/// **A session has two phases.** The microphone is open, and then what was said is transcribed
/// — the words arrive over about a second *after* the student stops talking, because the
/// provider transcribes a finished recording rather than a live stream. The second tap is
/// therefore the middle of the session, not the end of it, and the composer says which phase
/// it is in so a student never reads the wait as the app having quit on them.
///
/// **A session ends** when the transcript is complete, on send, and on the tutor changing shape
/// underneath it. The one thing that ends it on a clock is `BackendDictationService.captureLimit`
/// — a ceiling on the recording, not the silence timeout this composer still refuses to have,
/// which would cut off the student who is thinking and is precisely the student this app is for.
@MainActor
final class DictationController: ObservableObject {
    /// True while a session is running, in either phase. The wait for a permission alert is
    /// deliberately not part of it — the system's own alert is on screen, and a second
    /// indicator behind it would be the app claiming to be listening while it is not.
    @Published private(set) var isListening = false

    /// Which half of the running session this is. Meaningless while `isListening` is false,
    /// which is what `voiceState` folds into one answer for the composer.
    @Published private(set) var phase: DictationPhase = .capturing

    /// When the microphone opened, for the composer's elapsed label.
    @Published private(set) var startedAt = Date()

    /// The alert the student is being shown, if any. Only ever permission or a microphone that
    /// will not open — a failed transcription is a `note`.
    @Published var notice: DictationNotice?

    /// The one line above the composer after a session that produced nothing. Cleared by the
    /// next tap of anything, never on a timer.
    @Published private(set) var note: DictationNote?

    private let service: any DictationService
    private var isRunning = false
    /// The student ended this session themselves, so its silence needs no explaining.
    private var isCancelled = false

    /// The `LearningSession` a recording attaches to server-side. `TutorPanel`/`TutorFullScreen`
    /// keep this current from `TutorStore.session.id` (the store, not this controller, owns
    /// which session is live) — see their `.task(id:)` — because `DictationController` itself
    /// is constructed with no store in reach. Read fresh at the start of every session rather
    /// than threaded through `toggle(text:)`'s signature, so every existing call site (and
    /// every test built on one) stays as it was. `BackendDictationService` sends this as the
    /// `session_id` the server 404s without; a service with no server-side session
    /// (`ScriptedDictationService`) ignores it.
    var sessionID = UUID()

    /// One session's worth of work. Internal so a test can await a scripted session ending
    /// rather than sleeping for a moment and hoping.
    private(set) var session: Task<Void, Never>?

    init(service: any DictationService = DictationServiceRouter()) {
        self.service = service
    }

    /// Whether the platform can dictate at all, which is the only question `Composer` asks
    /// before drawing the button.
    var isOffered: Bool { service.isSupported }

    /// What the composer's mic should be showing: the phase of the session running right now,
    /// or `nil` when none is.
    var voiceState: DictationPhase? { isListening ? phase : nil }

    /// Everything the composer needs to draw a running session, or `nil` when none is.
    var composerDictation: ComposerDictation? {
        guard isListening else { return nil }
        return ComposerDictation(
            phase: phase,
            startedAt: startedAt,
            // Read on demand at the meter's own ~20 Hz rather than republished.
            level: { [weak self] in self?.service.inputLevel ?? 0 },
            onCancel: { [weak self] in self?.cancel() }
        )
    }

    /// The composer's note line, if a session ended with nothing to show.
    var noteText: String? { note?.text }

    /// The composer's `onVoice`, or `nil` when there is nothing behind it.
    ///
    /// `Composer` makes the mic's presence an availability question rather than a scale
    /// question, so this is where "available" is actually decided — and why a first run with no
    /// API key gets the design's other composer, not a broken one.
    func voiceHandler(text: Binding<String>) -> (() -> Void)? {
        guard isOffered else { return nil }
        return { [weak self] in self?.toggle(text: text) }
    }

    /// The mic. One control, two meanings: start, and "I've finished — transcribe it".
    ///
    /// The mic is not shown at all while transcribing (the microphone has already closed, so a
    /// control offering to close it would be describing something that already happened), which
    /// is why there is no third case here. Taking a transcription back is `cancel()`, on its own
    /// control in the leading slot.
    func toggle(text: Binding<String>) {
        // Any tap clears the last session's note. It never expires on a timer: a line that
        // vanishes while a student is still reading it is worse than one that waits.
        note = nil

        guard !isRunning else {
            if phase == .capturing { service.stop() }
            return
        }
        isRunning = true
        phase = .capturing
        startedAt = Date()
        session = Task { [weak self] in
            await self?.run(text: text)
            self?.isRunning = false
        }
    }

    /// Discard: the recording, or the request in flight. What the composer's leading cross does.
    func cancel() {
        guard isRunning else { return }
        isCancelled = true
        service.cancel()
    }

    /// Send, and any change of surface underneath the composer.
    ///
    /// `cancel` rather than `stop`: sending takes the composer's text and empties the field, so
    /// finishing the transcription would drop the last thing the student said into a message
    /// they have already sent.
    func stop() {
        guard isRunning else { return }
        isCancelled = true
        service.cancel()
    }

    private func run(text: Binding<String>) async {
        switch await resolvedAvailability() {
        case .ready:
            break
        case .needsPermission, .denied:
            notice = .permission
            return
        case .unavailable:
            notice = .unavailable
            return
        }

        let base = text.wrappedValue
        let transcripts: AsyncThrowingStream<DictationTranscript, any Error>
        do {
            transcripts = try service.start(sessionID: sessionID)
        } catch {
            notice = .unavailable
            return
        }

        isCancelled = false
        isListening = true
        phase = .capturing
        startedAt = Date()
        defer {
            isListening = false
            phase = .capturing
            service.cancel()
        }

        var heard = ""
        do {
            for try await transcript in transcripts {
                // The phase leads the words: the service says the microphone has closed at the
                // moment it closes, so the composer stops claiming to listen while it waits.
                phase = transcript.phase
                // Partial text goes into the field as it arrives, which is what `stream=true`
                // is for: a student who sees "sign" where they said "sine" can fix it before
                // they send rather than discovering it afterwards — and they cannot self-monitor
                // a speech error the way they can a typing error, so the visible text *is* the
                // correction mechanism. Each reading carries the whole running transcript, so
                // this rewrites rather than appends.
                heard = transcript.text
                text.wrappedValue = Self.merged(base: base, transcript: heard)
                if transcript.isFinal { break }
            }
        } catch {
            // The provider's own words never reach here — `DictationError` has no room to carry
            // them — and the failure is told where the student was, not in an alert over the
            // board.
            text.wrappedValue = base
            note = .failed
            return
        }

        // A cancelled session says nothing at all: the student asked for it to stop, and a line
        // explaining that nothing arrived would be the app arguing with them.
        guard !isCancelled else {
            text.wrappedValue = base
            return
        }

        // Nothing was said — or nothing that survived the server's own hallucination guard
        // (`server/app/tutor/vocabulary.py`, `is_silence`). That guard used to run here, on
        // the summed deltas; now the server empties the authoritative `done` text itself
        // before the client ever sees it, so an empty final reading *is* the silence verdict.
        if heard.isEmpty {
            text.wrappedValue = base
            note = .empty
        }
    }

    /// Asks only when there is something to ask. An already-refused permission goes straight
    /// to the notice, because iOS will not show its alert a second time.
    private func resolvedAvailability() async -> DictationAvailability {
        let current = service.availability
        guard current == .needsPermission else { return current }
        return await service.requestAuthorization()
    }

    /// Dictation continues a sentence rather than starting the field over.
    static func merged(base: String, transcript: String) -> String {
        guard !base.isEmpty else { return transcript }
        guard !transcript.isEmpty else { return base }
        return base.hasSuffix(" ") ? base + transcript : base + " " + transcript
    }
}

// MARK: - The notice

extension View {
    /// The permission and unavailability answers, on the one surface this app does not have to
    /// draw itself.
    func dictationNotice(_ controller: DictationController) -> some View {
        modifier(DictationNoticeModifier(controller: controller))
    }
}

private struct DictationNoticeModifier: ViewModifier {
    @ObservedObject var controller: DictationController
    @Environment(\.openURL) private var openURL

    func body(content: Content) -> some View {
        content.alert(
            controller.notice?.title ?? "",
            isPresented: isPresented,
            presenting: controller.notice
        ) { notice in
            if notice == .permission {
                // The route the second tap needs. Without it the mic is a control that has
                // told the student what is wrong and left them no way to fix it.
                Button("Open Settings") { openSettings() }
                Button("Not now", role: .cancel) {}
            } else {
                Button("OK", role: .cancel) {}
            }
        } message: { notice in
            Text(verbatim: notice.message)
        }
    }

    private var isPresented: Binding<Bool> {
        Binding(
            get: { controller.notice != nil },
            set: { if !$0 { controller.notice = nil } }
        )
    }

    private func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        openURL(url)
    }
}
