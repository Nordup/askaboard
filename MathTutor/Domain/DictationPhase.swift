import Foundation

/// Which half of a dictation session is running.
///
/// Apple's recogniser had only one half: text appeared *while* the student spoke. Transcribing
/// a finished recording has two — the microphone is open, and then what was said is turned into
/// text — with about a second between them. A student who cannot tell those apart reads the
/// second one as the app having stopped, so the phase is something the session reports rather
/// than something the composer guesses.
///
/// A domain value rather than part of the service seam, for the same reason `BoardTool` is one:
/// the composer draws a state, and it should not have to import a microphone to know which.
enum DictationPhase: Equatable, Sendable {
    /// The microphone is open. Nothing has been transcribed yet, and nothing can be: the
    /// recording is transcribed whole, after it ends.
    case capturing
    /// The microphone is closed and the words are arriving.
    case transcribing
}
