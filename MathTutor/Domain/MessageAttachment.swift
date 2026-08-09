import Foundation

/// A file the learner attached to a turn, as much of it as the app keeps.
///
/// **Not the file.** The original lives on the server, which is the only place
/// that ever held it: the device uploads bytes and stores the thumbnail that
/// comes back, so a 20MB Keynote costs this device a few kilobytes and the app
/// never learns what a `.key` is.
///
/// `id` is the server's — the id `POST /v1/attachments` minted and the id a
/// turn names in `attachment_ids`. It is also the thumbnail's filename in
/// `AttachmentStore`, which is why nothing here carries a path.
struct MessageAttachment: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    /// What the learner called it, as shown on the chip.
    let filename: String
    /// `image` | `pdf` | `text`, as the server decided. Held as a string
    /// rather than an enum because the ladder is the server's to extend — a
    /// document rung is a live possibility — and a device that has not been
    /// updated should draw an unknown kind as a chip rather than fail to
    /// decode the whole session.
    let kind: String
    let pageCount: Int
}
