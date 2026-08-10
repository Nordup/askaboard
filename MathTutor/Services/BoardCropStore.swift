import Foundation

/// The board regions the tutor asked to see, kept beside the sessions they
/// belong to.
///
/// `AttachmentStore` says a board crop is re-derivable and a photograph of
/// homework is not, and that is why crops were never saved. That reasoning
/// holds only while the board has not changed since — and a trail that
/// survives a relaunch is exactly the case where it has. Re-rendering the
/// region later would show today's board and label it as what the tutor
/// looked at last week, which is worse than showing nothing at all.
///
/// PNG rather than `AttachmentStore`'s JPEG: the source is ink on white, where
/// JPEG's ringing is at its most visible and its saving at its smallest.
struct BoardCropStore {
    /// Injectable only so a test can point at a temporary directory. Nothing
    /// in the app passes it.
    let directoryURL: URL

    init(directoryURL: URL? = nil) {
        self.directoryURL = directoryURL
            ?? SessionPersistence.defaultDirectoryURL.appendingPathComponent("BoardCrops")
    }

    private var cropsURL: URL { directoryURL.appendingPathComponent("Crops") }
    private var indexURL: URL { directoryURL.appendingPathComponent("bySession.json") }

    private func fileURL(for id: UUID) -> URL {
        cropsURL.appendingPathComponent(id.uuidString + ".png")
    }

    /// Writes the crop and only then folds it into the index, in that order. A
    /// failed write must not leave an index entry pointing at a file that was
    /// never created — a crop `deleteAll` believes it owns and `crop(for:)` can
    /// never return.
    func save(_ png: Data, for id: UUID, in sessionID: UUID) {
        guard write(png, for: id) else { return }

        var index = loadIndex()
        index[sessionID.uuidString, default: []].append(id)
        writeIndex(index)
    }

    func crop(for id: UUID) -> Data? {
        try? Data(contentsOf: fileURL(for: id))
    }

    /// Forgets every crop a session owns. Called when the session is deleted —
    /// the one place these files would otherwise accumulate forever.
    func deleteAll(for sessionID: UUID) {
        var index = loadIndex()
        for id in index[sessionID.uuidString] ?? [] {
            try? FileManager.default.removeItem(at: fileURL(for: id))
        }
        index[sessionID.uuidString] = nil
        writeIndex(index)
    }

    @discardableResult
    private func write(_ png: Data, for id: UUID) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: cropsURL, withIntermediateDirectories: true
            )
            try png.write(to: fileURL(for: id), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// Keyed by `sessionID.uuidString` rather than `UUID` itself: `Dictionary`
    /// only encodes as a JSON object when `Key` is `String` or `Int`.
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
