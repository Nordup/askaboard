import Foundation

enum AppAppearance: String, CaseIterable, Codable, Identifiable, Sendable {
    case light
    case system
    case dark

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .light: "Light"
        case .system: "System"
        case .dark: "Dark"
        }
    }
}

enum AppearancePreference {
    static let key = "mathTutor.appearance"
    static let defaultValue: AppAppearance = .light

    static func load(from defaults: UserDefaults = .standard) -> AppAppearance {
        guard let rawValue = defaults.string(forKey: key),
              let appearance = AppAppearance(rawValue: rawValue) else {
            return defaultValue
        }
        return appearance
    }

    static func save(_ appearance: AppAppearance, to defaults: UserDefaults = .standard) {
        defaults.set(appearance.rawValue, forKey: key)
    }
}

/// Controls how much reasoning the tutor model should spend on a response.
///
/// The raw values intentionally mirror the Responses API contract so a value
/// can be persisted and forwarded without a translation layer. `high` is the
/// default for both new sessions and sessions saved before this setting was
/// introduced.
enum ReasoningEffort: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case none
    case low
    case medium
    case high
    case xhigh
    case max

    static let defaultValue: ReasoningEffort = .high

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .none: "None"
        case .low: "Low"
        case .medium: "Medium"
        case .high: "High"
        case .xhigh: "X-High"
        case .max: "Max"
        }
    }

    /// A concise, lower-case label for compact status lines.
    var statusName: String { rawValue }

    /// Explain the speed/depth trade-off in the settings picker.
    var caption: String {
        switch self {
        case .none: "Fastest replies"
        case .low: "Light reasoning"
        case .medium: "Balanced depth"
        case .high: "Deep reasoning"
        case .xhigh: "Extra-deep reasoning"
        case .max: "Maximum depth"
        }
    }

    /// Unknown values should not make an otherwise valid saved session
    /// undecodable after the provider adds a new effort level.
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = ReasoningEffort(rawValue: rawValue) ?? .defaultValue
    }
}

enum MessageRole: String, Codable, Sendable {
    case tutor
    case learner
    case system
}

struct TutorMessage: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    let role: MessageRole
    /// Mutable so a streaming tutor turn can grow this message's text in
    /// place, one `.textDelta` at a time, rather than replacing the message.
    var text: String
    let createdAt: Date
    var signal: LearningSignal?
    /// Files sent with this turn. Empty for every message that predates the
    /// composer's attach button, which is what the default in `init` and the
    /// decoder's own defaulting are for — a session already on disk was
    /// written without this key.
    var attachments: [MessageAttachment] = []

    init(
        id: UUID = UUID(),
        role: MessageRole,
        text: String,
        createdAt: Date = .now,
        signal: LearningSignal? = nil,
        attachments: [MessageAttachment] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.signal = signal
        self.attachments = attachments
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, createdAt, signal, attachments
    }

    /// Written out for one line of it: `attachments`.
    ///
    /// Swift's synthesised decoder does **not** fall back to a stored
    /// property's default value when its key is missing — it throws
    /// `keyNotFound`. Every session written before attachments existed lacks
    /// the key, and `LearningSession` decodes `messages` with a plain `try`,
    /// so one legacy message would take the whole session down and
    /// `SessionPersistence.load` would return nil for it. A default value is
    /// not a migration; this is.
    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        role = try container.decode(MessageRole.self, forKey: .role)
        text = try container.decode(String.self, forKey: .text)
        createdAt = try container.decode(Date.self, forKey: .createdAt)
        signal = try container.decodeIfPresent(LearningSignal.self, forKey: .signal)
        attachments = try container.decodeIfPresent([MessageAttachment].self, forKey: .attachments) ?? []
    }
}

enum LearningSignal: String, Codable, Sendable {
    case dontKnow
    case evaluate
}

struct SessionPlan: Codable, Sendable, Equatable {
    var title: String
    var goal: String
    var outcomes: [String]
    var steps: [String]
    var currentStep: Int

    static let radicalEquation = SessionPlan(
        title: "Radical equations, one careful step at a time",
        goal: "Solve a radical equation and check that every answer works in the original problem.",
        outcomes: [
            "Isolate a square root without losing the domain clue.",
            "Square both sides deliberately and simplify.",
            "Check candidates in the equation you started with."
        ],
        steps: [
            "Notice the domain and isolate the radical.",
            "Square both sides, then solve the resulting equation.",
            "Substitute each candidate back into the original equation."
        ],
        currentStep: 0
    )
}

struct Exercise: Codable, Sendable, Equatable {
    var title: String
    var prompt: String
    var hint: String
    var context: String

    static let radicalEquation = Exercise(
        title: "Try this",
        prompt: "Solve  √(x + 5) = x − 1.  Show your reasoning, then check every candidate in the original equation.",
        hint: "Before squaring, ask: what must be true about x − 1?",
        context: "A learner is solving √(x + 5) = x − 1. Preserve their method and coach the next smallest useful step."
    )
}

struct LearningSession: Codable, Sendable, Equatable {
    /// Identifies this session to the backend, which rebuilds conversation
    /// context from the turns it has stored against this id. A fresh session
    /// must get a fresh id — see `empty` below — or its turns would land in
    /// whatever server-side conversation the previous session's id named.
    var id: UUID
    var messages: [TutorMessage]
    var plan: SessionPlan?
    var exercise: Exercise?
    var drawingData: Data?
    /// The tutor-authored semantic scene, separate from learner ink.
    ///
    /// Older session files do not carry this key; they decode to an empty
    /// scene so a saved session never fails to load just because it predates
    /// semantic drawing.
    var boardScene: BoardScene = .empty
    var selectedModel: ModelChoice
    var reasoningEffort: ReasoningEffort
    var startedAt: Date
    var lastSavedAt: Date

    init(
        id: UUID = UUID(),
        messages: [TutorMessage],
        plan: SessionPlan?,
        exercise: Exercise?,
        drawingData: Data?,
        boardScene: BoardScene = .empty,
        selectedModel: ModelChoice,
        reasoningEffort: ReasoningEffort = .defaultValue,
        startedAt: Date,
        lastSavedAt: Date
    ) {
        self.id = id
        self.messages = messages
        self.plan = plan
        self.exercise = exercise
        self.drawingData = drawingData
        self.boardScene = boardScene
        self.selectedModel = selectedModel
        self.reasoningEffort = reasoningEffort
        self.startedAt = startedAt
        self.lastSavedAt = lastSavedAt
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case messages
        case plan
        case exercise
        case drawingData
        case boardScene
        case selectedModel
        case reasoningEffort
        case startedAt
        case lastSavedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // Older session files do not have this key. Give them a fresh id
        // rather than fail to decode — a session that has never carried an
        // id has never opened a server-side session under one either, so
        // there is nothing on the backend for a fresh id to disconnect it
        // from.
        id = (try? container.decode(UUID.self, forKey: .id)) ?? UUID()
        messages = try container.decode([TutorMessage].self, forKey: .messages)
        plan = try container.decodeIfPresent(SessionPlan.self, forKey: .plan)
        exercise = try container.decodeIfPresent(Exercise.self, forKey: .exercise)
        drawingData = try container.decodeIfPresent(Data.self, forKey: .drawingData)
        boardScene = (try? container.decodeIfPresent(BoardScene.self, forKey: .boardScene)) ?? .empty
        selectedModel = try container.decode(ModelChoice.self, forKey: .selectedModel)
        // Older session files do not have this key. Keep those sessions intact
        // and opt them into the same default used for a new session.
        reasoningEffort = (try? container.decode(ReasoningEffort.self, forKey: .reasoningEffort)) ?? .defaultValue
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        lastSavedAt = try container.decode(Date.self, forKey: .lastSavedAt)
    }

    /// A computed property, not `static let`: every access must mint a brand
    /// new `id` (and a fresh `startedAt`/`lastSavedAt`). A stored constant
    /// would hand every reset in the process's lifetime the same id as the
    /// first, and the backend would keep stitching "fresh" sessions onto the
    /// very first one's transcript.
    static var empty: LearningSession {
        LearningSession(
            messages: [],
            plan: nil,
            exercise: nil,
            drawingData: nil,
            selectedModel: .luna,
            reasoningEffort: .defaultValue,
            startedAt: .now,
            lastSavedAt: .now
        )
    }
}

enum ModelChoice: String, Codable, CaseIterable, Sendable, Identifiable {
    case sol = "gpt-5.6-sol"
    case terra = "gpt-5.6-terra"
    case luna = "gpt-5.6-luna"

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .sol: return "Sol"
        case .terra: return "Terra"
        case .luna: return "Luna"
        }
    }

    var caption: String {
        switch self {
        case .sol: return "Focused route"
        case .terra: return "Balanced route"
        case .luna: return "Vision route"
        }
    }

    func caption(for reasoningEffort: ReasoningEffort) -> String {
        let effort = "\(reasoningEffort.displayName) reasoning"
        switch self {
        case .sol: return "\(effort) route"
        case .terra: return "Balanced route · \(effort)"
        case .luna: return "Vision route · \(effort)"
        }
    }
}

struct TutorRequest: Sendable {
    var messages: [TutorMessage]
    var goal: String?
    var exercise: Exercise?
    var plan: SessionPlan?
    var imageData: Data?
    var imageRegionDescription: String?
    /// The learner's whole board as it stands right now, sent on **every** turn
    /// that has ink on it.
    ///
    /// Not the same thing as `imageData`, and the difference is the whole point.
    /// `imageData` is a region the learner picked out and pointed at — an
    /// explicit "look at this". This is the board simply being *available*, so
    /// the tutor can decide for itself whether answering needs a look and crop
    /// whatever part of it it wants through `view_board`. Without it, a learner
    /// who typed "check" and nothing else got a tutor answering from the
    /// transcript alone, because whether the board was visible depended on their
    /// having armed a selection first.
    ///
    /// Rendered larger than an attachment: it is the original the server crops
    /// from, so its resolution is the ceiling on how closely the tutor can read
    /// a single line. See `CanvasCapture.boardData()`.
    var boardOverview: Data?
    var boardManifest: String?
    /// The device's compact account of the current board state: coordinate
    /// system, visible logical rectangle, learner ink bounds/clusters, and the
    /// exact tutor scene. Sent on every turn, like the overview, so the model
    /// can see and revise its own semantic output.
    var boardScene: String?
    /// Files the learner attached in the composer, already uploaded through
    /// `POST /v1/attachments`. Ids rather than bytes: conversion has already
    /// happened server-side, so this turn carries a reference to something the
    /// tutor can already read.
    ///
    /// Not the same thing as `imageData`, which stays exactly what it was — a
    /// region rendered from the live canvas. A lassoed region is not a file and
    /// routing it through an upload would add a round trip to the product's
    /// most common interaction.
    var attachmentIDs: [UUID] = []
    var signal: LearningSignal?
    /// The learner's `LearningSession.id`, carried through so the backend can
    /// rebuild this turn's conversation context from what it has stored
    /// against that session rather than starting a new one every turn.
    /// Defaulted only so existing test fixtures that predate this field keep
    /// compiling without naming it; every production call site threads the
    /// session's real id.
    var sessionID: UUID
    var model: ModelChoice
    var reasoningEffort: ReasoningEffort

    init(
        messages: [TutorMessage],
        goal: String?,
        exercise: Exercise?,
        plan: SessionPlan?,
        imageData: Data?,
        imageRegionDescription: String?,
        // Defaulted so every existing call site and test fixture keeps
        // compiling without naming it; the production path threads the real
        // board through `TutorStore.requestTutor`.
        boardOverview: Data? = nil,
        boardManifest: String? = nil,
        boardScene: String? = nil,
        attachmentIDs: [UUID] = [],
        signal: LearningSignal?,
        sessionID: UUID = UUID(),
        model: ModelChoice,
        reasoningEffort: ReasoningEffort = .defaultValue
    ) {
        self.messages = messages
        self.goal = goal
        self.exercise = exercise
        self.plan = plan
        self.imageData = imageData
        self.imageRegionDescription = imageRegionDescription
        self.boardOverview = boardOverview
        self.boardManifest = boardManifest
        self.boardScene = boardScene
        self.attachmentIDs = attachmentIDs
        self.signal = signal
        self.sessionID = sessionID
        self.model = model
        self.reasoningEffort = reasoningEffort
    }

    /// Preserve a natural initializer order for callers that group the
    /// selected effort before the model while keeping the original memberwise
    /// order source-compatible.
    init(
        messages: [TutorMessage],
        goal: String?,
        exercise: Exercise?,
        plan: SessionPlan?,
        imageData: Data?,
        imageRegionDescription: String?,
        boardOverview: Data? = nil,
        boardManifest: String? = nil,
        boardScene: String? = nil,
        attachmentIDs: [UUID] = [],
        signal: LearningSignal?,
        sessionID: UUID = UUID(),
        reasoningEffort: ReasoningEffort,
        model: ModelChoice
    ) {
        self.init(
            messages: messages,
            goal: goal,
            exercise: exercise,
            plan: plan,
            imageData: imageData,
            imageRegionDescription: imageRegionDescription,
            boardOverview: boardOverview,
            boardManifest: boardManifest,
            boardScene: boardScene,
            attachmentIDs: attachmentIDs,
            signal: signal,
            sessionID: sessionID,
            model: model,
            reasoningEffort: reasoningEffort
        )
    }

    var conversationText: String {
        messages.map { "\($0.role.rawValue): \($0.text)" }.joined(separator: "\n")
    }
}

struct TutorReply: Sendable, Equatable {
    var text: String
    var plan: SessionPlan?
    var exercise: Exercise?
}

enum TutorServiceError: LocalizedError, Sendable {
    /// This build has no usable credential for its backend, so no request can
    /// be made at all. Not a user-fixable condition and not a screen: the app
    /// has no setup surface any more, so this surfaces as an ordinary failure
    /// in the thread like any other unreachable-tutor case.
    case notConfigured
    case invalidResponse
    case network(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "The tutor could not be reached."
        case .invalidResponse: return "The tutor returned an unreadable response."
        case .network(let message): return message
        }
    }
}
