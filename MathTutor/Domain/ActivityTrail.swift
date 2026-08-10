import Foundation

/// What one tutor turn did, in the order it did it.
///
/// The thread shows this above the reply — open while the turn runs, closed to
/// `Worked for 1m 15s` after it ends. It exists because a reasoning turn is
/// otherwise several minutes of one word: the server has always sent the
/// reasoning summary and a phase, and the device has always thrown the first
/// away and reduced the second to a spinner.
///
/// `Codable` and saved with the session, unlike `BoardView` — but note what is
/// *not* here. A step holds a `UUID` for its board crop, never the bytes. A
/// `TutorMessage` is written into the session's file on every save, so PNGs in
/// this type would be rewritten for the rest of the session. `BoardCropStore`
/// holds the bytes beside the session instead.
struct ActivityTrail: Codable, Equatable, Sendable {
    var items: [TrailItem] = []

    /// How long the learner waited, set on `.done`.
    ///
    /// Measured on the device rather than sent by the server, because the
    /// number the label claims is the wait as the learner experienced it, and
    /// that includes the network. Stays `nil` on a turn that failed: a trail
    /// with no duration is what tells the view to say nothing rather than
    /// report a time it never measured.
    var duration: TimeInterval?

    var isEmpty: Bool { items.isEmpty }

    /// Adds reasoning text to the trailing reasoning item, or starts one.
    ///
    /// Deltas arrive one fragment at a time and belong to whichever run of
    /// thought is current. A step between two fragments genuinely separates
    /// them — the tutor thought, acted, then thought again — so a step ends the
    /// run and the next delta starts a new item.
    mutating func appendReasoning(_ text: String) {
        if case let .reasoning(id, existing) = items.last {
            items[items.count - 1] = .reasoning(id: id, text: existing + text)
            return
        }
        items.append(.reasoning(id: UUID(), text: text))
    }

    /// Files a step, replacing the row with the same id if there is one.
    ///
    /// Every step arrives twice — general label, then specific — so this is the
    /// normal path, not an edge case. The existing row's `imageID` is carried
    /// across: the refinement is built by the translator from tool arguments
    /// and cannot know about a crop the device rendered in the meantime.
    mutating func upsert(_ step: TrailStep) {
        let index = items.firstIndex { item in
            if case let .step(existing) = item { return existing.id == step.id }
            return false
        }
        guard let index else {
            items.append(.step(step))
            return
        }
        var merged = step
        if merged.imageID == nil, case let .step(existing) = items[index] {
            merged.imageID = existing.imageID
        }
        items[index] = .step(merged)
    }

    /// Attaches a rendered crop to the step that asked for it.
    mutating func setImage(_ imageID: UUID, forStep id: String) {
        let index = items.firstIndex { item in
            if case let .step(existing) = item { return existing.id == id }
            return false
        }
        guard let index, case let .step(existing) = items[index] else { return }
        var updated = existing
        updated.imageID = imageID
        items[index] = .step(updated)
    }
}

/// One row of the trail.
enum TrailItem: Codable, Equatable, Sendable, Identifiable {
    /// A run of reasoning summary. Grows in place as deltas arrive.
    case reasoning(id: UUID, text: String)
    case step(TrailStep)

    var id: String {
        switch self {
        case let .reasoning(id, _): return id.uuidString
        case let .step(step): return step.id
        }
    }
}

/// One tool call, named for the learner.
struct TrailStep: Codable, Equatable, Sendable, Identifiable {
    /// The server's `call_id`. A `String`, not a `UUID`: it is the provider's
    /// identifier and this device does not get to choose its shape.
    let id: String
    var tool: String
    var label: String
    /// The board crop this step produced, by the id `BoardCropStore` files it
    /// under. Only a `view_board` step ever has one.
    var imageID: UUID?

    init(id: String, tool: String, label: String, imageID: UUID? = nil) {
        self.id = id
        self.tool = tool
        self.label = label
        self.imageID = imageID
    }
}
