import Foundation

/// Where one attachment is on its way to the server.
enum PendingAttachmentState: Equatable {
    /// The upload request is in flight. This is the whole of "converting" —
    /// there is no server-side status to poll, and a 200 means done.
    case uploading
    case ready(MessageAttachment, thumbnail: Data)
    /// The server's own sentence, shown on the chip. Never a generic message:
    /// the refusal names the file and suggests a way out, and it was written
    /// for exactly this spot.
    case failed(String)
}

/// One chip in the composer's attachment card.
///
/// `id` is local and minted the moment the learner picks the file, not the
/// server's — the chip has to exist before there is anything to call it.
struct PendingAttachment: Identifiable, Equatable {
    let id: UUID
    let filename: String
    var state: PendingAttachmentState
}

/// What is attached to the message the learner is currently writing.
///
/// Separate from `TutorStore` because its lifetime is the *draft*, not the
/// session: everything here is discarded the moment the turn is sent or the
/// learner removes it, and none of it is persisted. The store learns about an
/// attachment exactly once, when the send happens.
///
/// The upload closure is injected so the tests above never touch a network.
@MainActor
final class ComposerAttachments: ObservableObject {
    /// `MAX_ATTACHMENTS_PER_TURN` in `server/app/config.py`. Stated here too so
    /// the composer can decline a sixth chip rather than letting the learner
    /// pick a file and find out at send time.
    static let limit = 5

    typealias Upload = @Sendable (Data, String, String, UUID) async throws -> UploadedAttachment

    @Published private(set) var pending: [PendingAttachment] = []

    /// True while `readyForSend()` is waiting. The composer stops accepting new
    /// attachments for that stretch: a file picked mid-send belongs to the next
    /// message, not this one, and the caller clears the draft as soon as the
    /// send returns.
    @Published private(set) var isSending = false

    private let upload: Upload
    private var tasks: [UUID: Task<Void, Never>] = [:]

    init(upload: @escaping Upload) {
        self.upload = upload
    }

    convenience init(configuration: BackendConfiguration) {
        let uploader = AttachmentUploader(configuration: configuration)
        self.init { data, filename, contentType, sessionID in
            try await uploader.upload(
                data, filename: filename, contentType: contentType, sessionID: sessionID
            )
        }
    }

    var isEmpty: Bool { pending.isEmpty }
    var isFull: Bool { pending.count >= Self.limit }

    /// Shows the chip, then starts the upload behind it.
    ///
    /// In that order on purpose: the learner picked a file and the feedback for
    /// that tap is the chip, not a spinner somewhere else. The upload runs in a
    /// task keyed by the chip's id so `remove` can cancel it.
    func add(data: Data, filename: String, contentType: String, sessionID: UUID) {
        guard !isFull, !isSending else { return }
        let id = UUID()
        pending.append(PendingAttachment(id: id, filename: filename, state: .uploading))

        tasks[id] = Task { [weak self] in
            guard let self else { return }
            do {
                let uploaded = try await self.upload(data, filename, contentType, sessionID)
                self.update(id, to: .ready(uploaded.attachment, thumbnail: uploaded.thumbnail))
            } catch {
                // `Task.isCancelled` rather than `catch is CancellationError`:
                // URLSession surfaces cancellation as `URLError(.cancelled)`, so
                // matching on the Swift error type misses every real cancelled
                // upload and only ever caught the test double's `Task.sleep`.
                guard !Task.isCancelled else { return }
                self.update(id, to: .failed(Self.sentence(for: error)))
            }
        }
    }

    func remove(_ id: UUID) {
        tasks[id]?.cancel()
        tasks[id] = nil
        pending.removeAll { $0.id == id }
    }

    /// Everything that is going to be sent, once everything in flight has
    /// landed.
    ///
    /// Awaiting the tasks rather than filtering for `.ready` is the whole
    /// point: a learner who hits send while a six-page PDF is still converting
    /// must not have it silently dropped. A failed attachment is excluded —
    /// its chip is still on screen saying why.
    ///
    /// Snapshot the draft as it stands *now*: this call sends these and only
    /// these. Waiting on a snapshot of the tasks but building the result from
    /// the live `pending` array (a first version of this method did exactly
    /// that) let an attachment added mid-send be either included in a send it
    /// was never part of, or dropped and then destroyed by the caller's
    /// `clear()` — the same "silently dropped" failure this method exists to
    /// prevent, just relocated. `isSending` closes the window that made this
    /// possible (see `add`), and `inThisSend` makes the result correct even
    /// so: `sending` is the id list at call time, and both what is awaited and
    /// what is returned are pinned to it.
    ///
    /// `await tasks[id]?.value` re-reads `tasks` fresh at each step rather
    /// than holding a `Task` reference across a suspension — `remove(_:)`
    /// cancelling and dropping an id mid-wait is simply skipped (`tasks[id]`
    /// is `nil` by the time this line runs for it) rather than awaited on a
    /// stale reference. Either way the wait is bounded: a task's own body
    /// treats cancellation as a fast exit (see `add`), so this never hangs on
    /// a chip the learner just removed.
    func readyForSend() async -> [UploadedAttachment] {
        isSending = true
        defer { isSending = false }

        let sending = pending.map(\.id)
        for id in sending {
            await tasks[id]?.value
        }

        let inThisSend = Set(sending)
        return pending.compactMap { attachment in
            guard inThisSend.contains(attachment.id),
                  case let .ready(message, thumbnail) = attachment.state else { return nil }
            return UploadedAttachment(attachment: message, thumbnail: thumbnail)
        }
    }

    /// After a send, or a session switch. Cancels anything still in flight —
    /// an upload for a draft that no longer exists has nowhere to land.
    func clear() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
        pending = []
    }

    private func update(_ id: UUID, to state: PendingAttachmentState) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].state = state
    }

    private static func sentence(for error: Error) -> String {
        if case let TutorServiceError.network(message) = error { return message }
        return "That file couldn’t be attached."
    }
}
