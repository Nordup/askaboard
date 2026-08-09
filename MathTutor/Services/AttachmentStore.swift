import Foundation

/// Thumbnails for sent attachments, beside the sessions they belong to.
///
/// One flat directory keyed by the server's attachment id, plus a per-session
/// index so deleting a session can find its files. Flat rather than nested by
/// session because the thread draws a chip from an id and nothing else: a
/// nested layout would mean every read needed to know which session it was in,
/// which is a lookup to avoid a `removeItem`.
///
/// A photo of homework is not re-derivable the way a board crop is — which is
/// why this exists at all, and why `selectionViews` stays in memory.
struct AttachmentStore {
    /// Injectable only so a test can point at a temporary directory. Nothing
    /// in the app passes it.
    let directoryURL: URL

    init(directoryURL: URL? = nil) {
        self.directoryURL = directoryURL
            ?? SessionPersistence.defaultDirectoryURL.appendingPathComponent("Attachments")
    }

    private var thumbnailsURL: URL { directoryURL.appendingPathComponent("Thumbnails") }
    private var indexURL: URL { directoryURL.appendingPathComponent("bySession.json") }

    private func fileURL(for id: UUID) -> URL {
        thumbnailsURL.appendingPathComponent(id.uuidString + ".jpg")
    }

    /// Writes the thumbnail and only then folds it into the index, in that
    /// order — mirroring `SessionPersistence.save`'s `guard write(...) else
    /// { return }`. A failed write (full disk, sandbox denial) must not leave
    /// an index entry pointing at a file that was never created, which is a
    /// thumbnail `deleteAll` believes it owns and `thumbnail(for:)` can never
    /// return.
    func save(_ thumbnail: Data, for id: UUID, in sessionID: UUID) {
        guard write(thumbnail, for: id) else { return }

        var index = loadIndex()
        index[sessionID.uuidString, default: []].append(id)
        writeIndex(index)
    }

    func thumbnail(for id: UUID) -> Data? {
        try? Data(contentsOf: fileURL(for: id))
    }

    /// Forgets every thumbnail a session owns. Called when the session is
    /// deleted — the one place these files would otherwise accumulate forever.
    func deleteAll(for sessionID: UUID) {
        var index = loadIndex()
        for id in index[sessionID.uuidString] ?? [] {
            try? FileManager.default.removeItem(at: fileURL(for: id))
        }
        index[sessionID.uuidString] = nil
        writeIndex(index)
    }

    @discardableResult
    private func write(_ thumbnail: Data, for id: UUID) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: thumbnailsURL, withIntermediateDirectories: true
            )
            try thumbnail.write(to: fileURL(for: id), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// Keyed by `sessionID.uuidString` rather than `UUID` itself: `Dictionary`
    /// only encodes as a JSON object when `Key` is `String` or `Int`, so a
    /// `[UUID: [UUID]]` index would silently encode as a flat alternating
    /// array — round-trippable, but not the JSON object `bySession.json`'s
    /// name and doc comment claim it is.
    private func loadIndex() -> [String: [UUID]] {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode([String: [UUID]].self, from: data) else {
            return [:]
        }
        return index
    }

    private func writeIndex(_ index: [String: [UUID]]) {
        try? FileManager.default.createDirectory(
            at: directoryURL, withIntermediateDirectories: true
        )
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
