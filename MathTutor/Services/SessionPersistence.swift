import Foundation

struct SessionPersistence {
    /// Where the session is written. Defaults to the app's real location and is
    /// injectable only so a test can point a store at a temporary directory —
    /// which is what makes *when* the store saves an assertable fact rather than
    /// something a reader has to take on trust. Nothing in the app passes it.
    let fileURL: URL

    init(fileURL: URL? = nil) {
        self.fileURL = fileURL ?? Self.defaultFileURL
    }

    static var defaultFileURL: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("MathTutor/session.json")
    }

    func load() -> LearningSession? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(LearningSession.self, from: data)
    }

    func save(_ session: LearningSession) {
        do {
            try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(session)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            // Persistence is best-effort for the local prototype. The in-memory session remains usable.
        }
    }
}
