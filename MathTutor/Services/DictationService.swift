import AVFAudio
import Foundation

/// What dictation will be able to do, answered without starting anything and without putting a
/// single alert in front of the student.
///
/// The composer asks this before every session because all four answers are reachable at any
/// moment: a permission can be revoked in Settings, and the API key the transcription runs on
/// can be removed in the app's own Settings mid-lesson.
enum DictationAvailability: Equatable, Sendable {
    /// The microphone is granted and there is a credential to transcribe with.
    case ready
    /// Nothing has been asked yet. The first tap on the mic is the ask.
    case needsPermission
    /// Refused, or off-limits under Screen Time or a managed profile. iOS shows its own
    /// permission alert exactly once per install, so asking again from here does nothing —
    /// which is why the caller has to lead somewhere else instead.
    case denied
    /// Nothing to transcribe with: no API key. Not a refusal, and not something a permission
    /// alert can fix.
    case unavailable
}

/// One reading of what the student has said.
///
/// This carries the running transcript rather than a delta, so the composer replaces what it
/// wrote last time instead of accumulating half-heard words. The provider streams appends; the
/// service adds them up before yielding, because that is the contract the composer was built
/// against and it survives the next backend too.
struct DictationTranscript: Equatable, Sendable {
    let text: String
    /// The end of the transcript. A session that reaches this ends on its own, without a
    /// second tap.
    let isFinal: Bool
    /// Defaults to `.transcribing` because every reading that carries words is one: text only
    /// exists after the recording has closed.
    var phase: DictationPhase = .transcribing
}

/// Only ever the *shape* of a failure. Nothing here carries a transcript or a provider error
/// string: this is a child speaking, and an error is a plausible place for a few of their
/// words to end up in a crash log.
enum DictationError: Error, Equatable, Sendable {
    /// Nothing to transcribe with, or a credential the provider will not accept.
    case unavailable
    /// The microphone could not be opened — no input route, or another app holding it.
    case audioUnavailable
    /// The transcription did not arrive: the network, the provider, or a stream that stopped
    /// mid-sentence.
    case recognitionFailed
}

/// Dictation behind the seam `TutorService` already establishes: the UI depends on this
/// protocol, and tests drive `ScriptedDictationService` rather than a microphone the
/// simulator cannot give them. Swapping Apple's recogniser for OpenAI's transcription endpoint
/// replaced one conformance and left the fake, the controller's shape and every test that
/// drives it standing — which is what the seam is for. It cost the protocol one verb, because
/// ending a recording and abandoning one used to be the same act and no longer are.
///
/// `@MainActor` rather than the `Sendable` value-type shape `TutorService` uses, because what
/// sits underneath is the opposite kind of thing. `AVAudioEngine` and its nodes are
/// non-`Sendable` reference types with no isolation of their own, so the honest answer is to
/// pin them to one actor and let the compiler prove nothing else touches them. The single
/// crossing that remains — the audio tap, which CoreAudio calls on a render thread — is named
/// and locked where it happens, rather than waved away with `@unchecked Sendable` over the
/// whole class.
@MainActor
protocol DictationService: AnyObject {
    /// Whether the product should offer dictation at all. False means no mic button, not a
    /// disabled one: this design has no disabled controls anywhere.
    var isSupported: Bool { get }

    /// Passive. Must never prompt.
    var availability: DictationAvailability { get }

    /// How loud the microphone is right now, 0…1, and 0 when nothing is being captured.
    ///
    /// A polled value rather than a published one or a second stream: the composer's meter
    /// samples it at ~20 Hz from its own timeline, and pushing twenty state changes a second
    /// through the view tree would re-render the whole composer for each of them.
    var inputLevel: Double { get }

    /// Asks for the microphone if it has not been asked for yet, and reports where that
    /// leaves us.
    func requestAuthorization() async -> DictationAvailability

    /// Opens the microphone. The stream carries the running transcript and ends when the
    /// transcript is complete, when the session is cancelled, or with a `DictationError`.
    ///
    /// `sessionID` is the store's `LearningSession.id`, read once for the whole recording — a
    /// session does not change mid-capture. `BackendDictationService` sends it as the
    /// `session_id` form field `server/app/api/dictation.py` requires; the server 404s an
    /// unknown one, so a caller that mints a fresh id here rather than forwarding the real one
    /// would fail every upload. Conformers with nothing server-side to attach it to
    /// (`ScriptedDictationService`) simply ignore it.
    func start(sessionID: UUID) throws -> AsyncThrowingStream<DictationTranscript, any Error>

    /// The student has finished speaking. Closes the microphone and transcribes what was
    /// said — the stream stays open until the words arrive. Idempotent, because both the
    /// student and the app can end a recording.
    func stop()

    /// Abandon the session: nothing further will arrive, and any recording still in hand is
    /// dropped rather than uploaded.
    ///
    /// A separate verb from `stop()` because the two used to be the same act and no longer
    /// are. Sending, or leaving the surface the composer is on, must not upload a recording
    /// whose text would land in a field that has since been cleared.
    func cancel()
}

extension DictationService {
    /// A service with nothing in flight has nothing to abandon, so the honest default is the
    /// end it already implements.
    func cancel() { stop() }
}

// MARK: - Reading the one permission

extension DictationAvailability {
    /// The four-way answer from the microphone permission and whether there is a credential,
    /// kept as a pure function so every combination can be tested on a machine with no
    /// microphone.
    ///
    /// The credential is consulted first: without a key there is nothing behind the button,
    /// and asking a child for their microphone to feed an endpoint the app cannot call would
    /// be a permission taken under false pretences.
    ///
    /// `restricted` folds into `denied` deliberately: the two differ in *who* said no, and
    /// nothing the app can do about it differs. Either way the next tap has to lead the
    /// student somewhere other than a second permission alert that will never appear.
    static func resolve(
        microphone: AVAudioApplication.recordPermission,
        hasCredential: Bool
    ) -> Self {
        guard hasCredential else { return .unavailable }

        switch microphone {
        case .denied: return .denied
        case .undetermined: return .needsPermission
        case .granted: return .ready
        @unknown default: return .unavailable
        }
    }
}

// MARK: - The live-configured default

/// `DictationController`'s default service. Mirrors `TutorServiceRouter`: it re-reads the
/// configuration on every call rather than deciding once at launch, so the two routers cannot
/// disagree about whether a tutor is reachable.
///
/// That mattered more when a token could be typed in or removed mid-lesson. It is compiled in
/// now and cannot change while the app runs — but reading it per call costs nothing and is one
/// less invariant to hold in your head than a cached answer would be.
@MainActor
final class DictationServiceRouter: DictationService {
    private let configurationReader: @Sendable () -> BackendConfiguration?
    /// The service backing the session currently in flight. `nil` between sessions, so every
    /// `start(sessionID:)` re-resolves configuration instead of reusing a stale instance, and
    /// `stop()`/`cancel()`/`inputLevel` route to the one actually holding the microphone.
    private var current: BackendDictationService?

    init(configurationReader: (@Sendable () -> BackendConfiguration?)? = nil) {
        self.configurationReader = configurationReader ?? { BackendConfiguration.load() }
    }

    /// Unlike `OpenAIDictationService.isSupported`, this is never baked into one instance's
    /// stored state — see the type's own doc comment.
    var isSupported: Bool { configurationReader() != nil }

    var availability: DictationAvailability {
        .resolve(microphone: AVAudioApplication.shared.recordPermission, hasCredential: configurationReader() != nil)
    }

    var inputLevel: Double { current?.inputLevel ?? 0 }

    func requestAuthorization() async -> DictationAvailability {
        if AVAudioApplication.shared.recordPermission == .undetermined {
            _ = await AVAudioApplication.requestRecordPermission()
        }
        return availability
    }

    func start(sessionID: UUID) throws -> AsyncThrowingStream<DictationTranscript, any Error> {
        guard let configuration = configurationReader() else { throw DictationError.unavailable }
        let service = BackendDictationService(configuration: configuration)
        current = service
        return try service.start(sessionID: sessionID)
    }

    func stop() { current?.stop() }

    func cancel() {
        current?.cancel()
        current = nil
    }
}

// MARK: - The one without a microphone

/// Dictation with nothing behind it: the states a real session moves through, in whatever
/// order a test or a preview asks for them. `DemoTutorService` is the same idea for the tutor.
///
/// It exists because the interesting half of this feature is unreachable on a simulator —
/// permission refusals, a missing key, a stream that stops mid-sentence — and none of those
/// should have to be reproduced by hand to be covered.
@MainActor
final class ScriptedDictationService: DictationService {
    var isSupported: Bool
    var availability: DictationAvailability
    /// What the student's answer to the permission alert turns `availability` into.
    var authorizationOutcome: DictationAvailability
    /// The running transcript one session yields, in order.
    var script: [DictationTranscript]
    /// A session that cannot open the microphone at all.
    var startError: DictationError?
    /// What the meter is told the microphone is hearing. Settable so a preview can hold a bar
    /// still and a test can assert what silence draws.
    var inputLevel: Double = 0

    private(set) var authorizationRequests = 0
    private(set) var startCount = 0
    private(set) var stopCount = 0
    private(set) var cancelCount = 0
    /// The `sessionID` `start(sessionID:)` was last called with, so a test can assert
    /// `DictationController` threads the store's real session through rather than a fresh id.
    private(set) var lastSessionID: UUID?

    private var continuation: AsyncThrowingStream<DictationTranscript, any Error>.Continuation?

    init(
        isSupported: Bool = true,
        availability: DictationAvailability = .ready,
        authorizationOutcome: DictationAvailability = .ready,
        script: [DictationTranscript] = [],
        startError: DictationError? = nil
    ) {
        self.isSupported = isSupported
        self.availability = availability
        self.authorizationOutcome = authorizationOutcome
        self.script = script
        self.startError = startError
    }

    func requestAuthorization() async -> DictationAvailability {
        authorizationRequests += 1
        availability = authorizationOutcome
        return availability
    }

    func start(sessionID: UUID) throws -> AsyncThrowingStream<DictationTranscript, any Error> {
        startCount += 1
        lastSessionID = sessionID
        if let startError { throw startError }

        let (stream, continuation) = AsyncThrowingStream<DictationTranscript, any Error>.makeStream()
        self.continuation = continuation
        // Buffered rather than paced: a test asserting what the composer holds should not have
        // to model how fast a person talks, or how long an upload takes.
        for line in script { continuation.yield(line) }
        if script.last?.isFinal == true {
            continuation.finish()
            self.continuation = nil
        }
        return stream
    }

    func stop() {
        stopCount += 1
        continuation?.finish()
        continuation = nil
    }

    /// With no recording and no upload in hand, abandoning is the same act as ending — the
    /// count is what a test needs, so it is recorded and then handed to `stop()`.
    func cancel() {
        cancelCount += 1
        stop()
    }

    /// A transcription that gives up in the middle — the one failure a student can hit that
    /// neither permission nor a missing key predicts.
    func failInFlight(_ error: DictationError = .recognitionFailed) {
        continuation?.finish(throwing: error)
        continuation = nil
    }

    /// One reading, delivered after the session has started, so a test can drive the two
    /// phases in the order a real session moves through them.
    func yield(_ transcript: DictationTranscript) {
        continuation?.yield(transcript)
        if transcript.isFinal {
            continuation?.finish()
            continuation = nil
        }
    }
}
