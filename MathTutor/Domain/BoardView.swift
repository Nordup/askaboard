import Foundation

/// One region of the board the tutor asked to see, and the device drew.
///
/// **Not from the design** — board 05 open question 7 records that the design
/// never drew the tutor looking at anything. Board 14 does, and this is its
/// value: the picture plus the words the model was given for it.
///
/// Deliberately not `Codable`, and that half still holds: a `TutorMessage` is
/// written into the session's file on every save, so attaching a few hundred
/// kilobytes of PNG to one would rewrite them for the rest of the session.
///
/// What has changed is where the bytes go instead. This type used to be the
/// tutor's own board crops as well, held in a `TutorStore.boardViews` dictionary
/// that lived only as long as the app did — a thread restored from disk showed
/// the replies without the pictures. The activity trail needs those crops to
/// survive a relaunch, so they now go to `BoardCropStore` on disk and a
/// `TrailStep` carries only their `UUID`. `TutorStore.boardViews` is gone.
///
/// What is left here is the *learner's* own marqueed selection
/// (`TutorStore.selectionViews`), which is a different claim and still in
/// memory only.
struct BoardView: Identifiable, Sendable, Equatable {
    let id: UUID
    let imageData: Data
    /// What region this is, in the same words the model was given for it —
    /// "Showing x 40–70%, y 20–55% of the board." It is the only label
    /// VoiceOver has for an image of someone's handwriting.
    let detail: String

    init(id: UUID = UUID(), imageData: Data, detail: String) {
        self.id = id
        self.imageData = imageData
        self.detail = detail
    }
}
