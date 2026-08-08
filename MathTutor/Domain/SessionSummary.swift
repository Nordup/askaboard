import Foundation

/// One row of the session switcher, without the session behind it.
///
/// The switcher needs a name and a date for four or five sessions; a
/// `LearningSession` carries the whole board — a serialized `PKDrawing` runs to
/// hundreds of kilobytes — plus every message ever sent. Reading all of them to
/// draw a menu would load megabytes to render four lines of text, on the main
/// actor, every time the menu opens. So the summaries are written alongside the
/// sessions and read on their own.
struct SessionSummary: Codable, Sendable, Equatable, Identifiable {
    let id: UUID
    var title: String
    var lastSavedAt: Date
    var messageCount: Int

    init(id: UUID, title: String, lastSavedAt: Date, messageCount: Int) {
        self.id = id
        self.title = title
        self.lastSavedAt = lastSavedAt
        self.messageCount = messageCount
    }

    init(_ session: LearningSession) {
        self.init(
            id: session.id,
            title: session.title,
            lastSavedAt: session.lastSavedAt,
            messageCount: session.messages.count
        )
    }
}

/// What sessions exist, and which one was open last.
///
/// Ordered most-recent-first and kept that way by `upserting`, so a reader never
/// sorts and the order on disk is the order the menu draws.
struct SessionIndex: Codable, Sendable, Equatable {
    var lastOpened: UUID?
    var sessions: [SessionSummary]

    static let empty = SessionIndex(lastOpened: nil, sessions: [])

    init(lastOpened: UUID? = nil, sessions: [SessionSummary] = []) {
        self.lastOpened = lastOpened
        self.sessions = sessions
    }

    /// Replaces the entry for `summary.id` and moves it to the front, or adds it
    /// there. Saving a session is what makes it the most recent, so there is no
    /// separate "touch" — the two facts are the same event.
    func upserting(_ summary: SessionSummary) -> SessionIndex {
        var updated = self
        updated.sessions.removeAll { $0.id == summary.id }
        updated.sessions.insert(summary, at: 0)
        return updated
    }

    func removing(id: UUID) -> SessionIndex {
        var updated = self
        updated.sessions.removeAll { $0.id == id }
        if updated.lastOpened == id { updated.lastOpened = nil }
        return updated
    }

    func opened(_ id: UUID) -> SessionIndex {
        var updated = self
        updated.lastOpened = id
        return updated
    }
}

extension LearningSession {
    /// What a session with nothing in it is called. Not "Untitled": the switcher
    /// row it lands on is one the learner can open and carry on with, and a
    /// brand new session is exactly what it is.
    static let untitledName = "New session"

    /// The name the session switcher shows.
    ///
    /// Derived rather than stored, and derived in this order on purpose. The
    /// tutor already names the work: `SessionPlan.title` is written for a human
    /// ("Radical equations, one careful step at a time") the moment a turn
    /// produces a plan, so there is no naming step to put in front of a learner
    /// and nothing to keep in sync. Before a plan exists the learner's own first
    /// words are the best name available, and before those there is nothing to
    /// name and the session is what it says it is.
    ///
    /// **Not persisted.** A stored title would go stale the moment the plan
    /// changed, and the only way to notice would be a switcher row that no
    /// longer matches the session it opens. `SessionSummary` snapshots it for
    /// the index, which is a cache of this and is rewritten on every save.
    var title: String {
        if let plan, let clause = Self.leadingClause(of: plan.title) { return clause }
        if let opening = messages.first(where: {
            $0.role == .learner && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }) {
            return Self.condensed(opening.text)
        }
        return Self.untitledName
    }

    /// A plan title up to its first break in sense.
    ///
    /// Plan titles are written as a headline plus a promise — *"Radical
    /// equations, one careful step at a time"* — and the switcher has room for
    /// the headline. Cutting at the first comma, colon or dash is what makes
    /// "Radical equations" out of that, and a title with no such break is
    /// already the headline and is returned whole.
    ///
    /// The four-character floor keeps a leading fragment from winning: "No, we
    /// square both sides first" must not become "No". `nil` for a title that is
    /// blank, so the caller falls through to the learner's own words rather than
    /// showing an empty row.
    static func leadingClause(of title: String) -> String? {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let breaks: Set<Character> = [",", ":", ";", "—", "–"]
        guard let stop = trimmed.firstIndex(where: { breaks.contains($0) }) else {
            return condensed(trimmed)
        }
        let head = trimmed[..<stop].trimmingCharacters(in: .whitespacesAndNewlines)
        return head.count >= 4 ? condensed(head) : condensed(trimmed)
    }

    /// One line, single-spaced, short enough for a switcher row.
    ///
    /// The limit is generous because both places this is drawn — the header
    /// button and the menu row — truncate with an ellipsis of their own at
    /// whatever width they have. This one exists so the *index on disk* never
    /// carries a paragraph, which is what a learner who pastes a whole homework
    /// question into the composer would otherwise put there.
    static func condensed(_ text: String, limit: Int = 48) -> String {
        let firstLine = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
        let collapsed = firstLine.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard collapsed.count > limit else { return collapsed }
        let clipped = collapsed.prefix(limit)
        // Prefer a word boundary, but not one so early that the name loses its
        // subject — a 48-character run with its only space at index 3 is better
        // cut mid-word than reduced to that first word.
        if let lastSpace = clipped.lastIndex(of: " "),
           clipped.distance(from: clipped.startIndex, to: lastSpace) >= limit / 2 {
            return clipped[..<lastSpace].trimmingCharacters(in: .whitespaces) + "…"
        }
        return clipped.trimmingCharacters(in: .whitespaces) + "…"
    }
}
