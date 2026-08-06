import Foundation

struct SessionPersistence {
    private var fileURL: URL {
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
