import Foundation

/// One region of the board the tutor asked to see, and the device drew.
///
/// **Not from the design** — board 05 open question 7 records that the design
/// never drew the tutor looking at anything. Board 14 does, and this is its
/// value: the picture plus the words the model was given for it.
///
/// Deliberately not `Codable`. These belong to the turn you are reading, not to
/// the session: a `TutorMessage` is written into the session's file on every save,
/// so attaching a few hundred kilobytes of PNG to one would rewrite them on
/// every later save for the rest of the session. `TutorStore.boardViews` holds
/// them beside the thread for as long as the app runs, and a thread restored
/// from disk shows the replies without the views — which is honest, because the
/// pictures were never saved.
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
