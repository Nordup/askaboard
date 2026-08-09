import Foundation

/// Where sessions live on disk: one JSON file per session, plus an index.
///
/// It was a single `session.json` for as long as there was a single session.
/// The layout now is a `Sessions/` directory keyed by `LearningSession.id` and
/// an `index.json` beside it, because the switcher needs to list sessions
/// without opening them — see `SessionSummary`.
///
/// **The index is a cache, not the record.** Every summary in it is derivable
/// from the session file it names, and `rebuildIndex()` does exactly that. It
/// exists so listing four sessions costs one small read instead of four large
/// ones; nothing is lost if it is deleted, and a session file with no index
/// entry is recovered rather than orphaned.
struct SessionPersistence {
    /// The directory sessions are written into. Injectable only so a test can
    /// point a store at a temporary directory — which is what makes *when* the
    /// store saves an assertable fact rather than something a reader has to take
    /// on trust. Nothing in the app passes it.
    let directoryURL: URL

    /// The thumbnails a deleted session takes with it.
    ///
    /// Derived from `directoryURL` rather than constructed as a bare
    /// `AttachmentStore()` inside `delete(id:)`. That default resolves to the
    /// real Application Support directory whatever this store was pointed at, so
    /// a test deleting a session out of a temporary directory wrote
    /// `bySession.json` into the user's own data — and the promise that a
    /// deleted session takes its sidecar with it could not be asserted at all.
    /// Production is unchanged: `defaultDirectoryURL` is what
    /// `AttachmentStore()`'s own default is built from.
    let attachmentStore: AttachmentStore

    init(directoryURL: URL? = nil, attachmentStore: AttachmentStore? = nil) {
        let resolved = directoryURL ?? Self.defaultDirectoryURL
        self.directoryURL = resolved
        self.attachmentStore = attachmentStore
            ?? AttachmentStore(directoryURL: resolved.appendingPathComponent("Attachments"))
    }

    static var defaultDirectoryURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("MathTutor")
    }

    /// The single-session file this store replaced. Still read once, by
    /// `migrateLegacySessionIfNeeded()`, and never written.
    var legacyFileURL: URL { directoryURL.appendingPathComponent("session.json") }

    private var sessionsURL: URL { directoryURL.appendingPathComponent("Sessions") }
    private var indexURL: URL { directoryURL.appendingPathComponent("index.json") }

    private func fileURL(for id: UUID) -> URL {
        sessionsURL.appendingPathComponent(id.uuidString + ".json")
    }

    // MARK: - Reading

    /// The session that was open last, or the most recent one, or `nil` when
    /// there is nothing stored at all.
    ///
    /// Falls through rather than trusting `lastOpened` blindly: an id naming a
    /// file that is gone must not leave the app with no session when there are
    /// three others sitting right there.
    func loadCurrent() -> LearningSession? {
        migrateLegacySessionIfNeeded()
        let index = loadIndex()
        if let id = index.lastOpened, let session = load(id: id) { return session }
        for summary in index.sessions {
            if let session = load(id: summary.id) { return session }
        }
        return nil
    }

    func load(id: UUID) -> LearningSession? {
        guard let data = try? Data(contentsOf: fileURL(for: id)) else { return nil }
        return try? JSONDecoder().decode(LearningSession.self, from: data)
    }

    func loadIndex() -> SessionIndex {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode(SessionIndex.self, from: data) else {
            return .empty
        }
        return index
    }

    // MARK: - Writing

    /// Writes the session and folds its summary into the index, in that order.
    ///
    /// Order matters on a crash: an index entry pointing at a file that was
    /// never written is a switcher row that opens nothing, while a session file
    /// the index has not caught up with is recovered by `rebuildIndex()`.
    func save(_ session: LearningSession) {
        guard write(session) else { return }
        writeIndex(loadIndex().upserting(SessionSummary(session)).opened(session.id))
    }

    /// Marks a session as the one to restore at launch, without rewriting it.
    func markOpened(_ id: UUID) {
        writeIndex(loadIndex().opened(id))
    }

    /// Forgets a session entirely — its file, its index entry, and the
    /// thumbnails of anything the learner attached to it.
    func delete(id: UUID) {
        try? FileManager.default.removeItem(at: fileURL(for: id))
        attachmentStore.deleteAll(for: id)
        writeIndex(loadIndex().removing(id: id))
    }

    // MARK: - Index recovery

    /// Rebuilds the index from the session files themselves.
    ///
    /// The one place that pays the cost the index exists to avoid, so it runs
    /// only when the index is missing or has fallen behind the directory —
    /// after a crash between the two writes in `save`, or with the index file
    /// deleted out from under the app.
    @discardableResult
    func rebuildIndex() -> SessionIndex {
        let existing = loadIndex()
        let files = (try? FileManager.default.contentsOfDirectory(
            at: sessionsURL,
            includingPropertiesForKeys: nil
        )) ?? []
        let summaries = files
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> SessionSummary? in
                guard let id = UUID(uuidString: url.deletingPathExtension().lastPathComponent),
                      let session = load(id: id) else { return nil }
                return SessionSummary(session)
            }
            .sorted { $0.lastSavedAt > $1.lastSavedAt }
        let lastOpened = summaries.contains(where: { $0.id == existing.lastOpened })
            ? existing.lastOpened
            : summaries.first?.id
        let rebuilt = SessionIndex(lastOpened: lastOpened, sessions: summaries)
        writeIndex(rebuilt)
        return rebuilt
    }

    /// True when the index no longer describes what is on disk.
    func indexNeedsRebuild() -> Bool {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: sessionsURL,
            includingPropertiesForKeys: nil
        )) ?? []
        let onDisk = Set(
            files
                .filter { $0.pathExtension == "json" }
                .compactMap { UUID(uuidString: $0.deletingPathExtension().lastPathComponent) }
        )
        return onDisk != Set(loadIndex().sessions.map(\.id))
    }

    // MARK: - Migration

    /// Moves a pre-switcher `session.json` into the new layout, once.
    ///
    /// This runs against a real learner's only saved session, so it copies
    /// before it deletes and leaves the original in place if the write fails.
    /// A launch that cannot migrate keeps a readable legacy file and tries again
    /// next time, which is the outcome that loses nothing.
    func migrateLegacySessionIfNeeded() {
        let legacy = legacyFileURL
        guard FileManager.default.fileExists(atPath: legacy.path) else { return }
        guard let data = try? Data(contentsOf: legacy),
              let session = try? JSONDecoder().decode(LearningSession.self, from: data) else {
            // Unreadable rather than absent. Renaming it aside stops the app
            // retrying a decode that will never succeed, without deleting
            // something a person might still want to recover by hand.
            try? FileManager.default.moveItem(at: legacy, to: legacy.appendingPathExtension("unreadable"))
            return
        }
        guard write(session) else { return }
        writeIndex(loadIndex().upserting(SessionSummary(session)).opened(session.id))
        try? FileManager.default.removeItem(at: legacy)
    }

    // MARK: - Disk

    @discardableResult
    private func write(_ session: LearningSession) -> Bool {
        do {
            try FileManager.default.createDirectory(at: sessionsURL, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(session)
            try data.write(to: fileURL(for: session.id), options: .atomic)
            return true
        } catch {
            // Persistence is best-effort for the local prototype. The in-memory
            // session remains usable.
            return false
        }
    }

    private func writeIndex(_ index: SessionIndex) {
        do {
            try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(index)
            try data.write(to: indexURL, options: .atomic)
        } catch {
            // See `write`. A lost index is rebuilt from the session files.
        }
    }
}
