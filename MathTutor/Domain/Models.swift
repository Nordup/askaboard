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
    let text: String
    let createdAt: Date
    var signal: LearningSignal?

    init(id: UUID = UUID(), role: MessageRole, text: String, createdAt: Date = .now, signal: LearningSignal? = nil) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.signal = signal
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
    var messages: [TutorMessage]
    var plan: SessionPlan?
    var exercise: Exercise?
    var drawingData: Data?
    var selectedModel: ModelChoice
    var reasoningEffort: ReasoningEffort
    var startedAt: Date
    var lastSavedAt: Date

    init(
        messages: [TutorMessage],
        plan: SessionPlan?,
        exercise: Exercise?,
        drawingData: Data?,
        selectedModel: ModelChoice,
        reasoningEffort: ReasoningEffort = .defaultValue,
        startedAt: Date,
        lastSavedAt: Date
    ) {
        self.messages = messages
        self.plan = plan
        self.exercise = exercise
        self.drawingData = drawingData
        self.selectedModel = selectedModel
        self.reasoningEffort = reasoningEffort
        self.startedAt = startedAt
        self.lastSavedAt = lastSavedAt
    }

    private enum CodingKeys: String, CodingKey {
        case messages
        case plan
        case exercise
        case drawingData
        case selectedModel
        case reasoningEffort
        case startedAt
        case lastSavedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        messages = try container.decode([TutorMessage].self, forKey: .messages)
        plan = try container.decodeIfPresent(SessionPlan.self, forKey: .plan)
        exercise = try container.decodeIfPresent(Exercise.self, forKey: .exercise)
        drawingData = try container.decodeIfPresent(Data.self, forKey: .drawingData)
        selectedModel = try container.decode(ModelChoice.self, forKey: .selectedModel)
        // Older session files do not have this key. Keep those sessions intact
        // and opt them into the same default used for a new session.
        reasoningEffort = (try? container.decode(ReasoningEffort.self, forKey: .reasoningEffort)) ?? .defaultValue
        startedAt = try container.decode(Date.self, forKey: .startedAt)
        lastSavedAt = try container.decode(Date.self, forKey: .lastSavedAt)
    }

    static let empty = LearningSession(
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
        case .luna: return "Default route"
        }
    }

    func caption(for reasoningEffort: ReasoningEffort) -> String {
        let effort = "\(reasoningEffort.displayName) reasoning"
        switch self {
        case .sol: return "\(effort) route"
        case .terra: return "Balanced route · \(effort)"
        case .luna: return "Default route · \(effort)"
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
    var signal: LearningSignal?
    var model: ModelChoice
    var reasoningEffort: ReasoningEffort

    init(
        messages: [TutorMessage],
        goal: String?,
        exercise: Exercise?,
        plan: SessionPlan?,
        imageData: Data?,
        imageRegionDescription: String?,
        signal: LearningSignal?,
        model: ModelChoice,
        reasoningEffort: ReasoningEffort = .defaultValue
    ) {
        self.messages = messages
        self.goal = goal
        self.exercise = exercise
        self.plan = plan
        self.imageData = imageData
        self.imageRegionDescription = imageRegionDescription
        self.signal = signal
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
        signal: LearningSignal?,
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
            signal: signal,
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

    /// A plan and board exercise are one workspace contract. Treat a response
    /// that contains only one half as unstructured chat so stale state cannot
    /// accidentally be paired with a new value.
    static func coherentPair(_ plan: SessionPlan?, _ exercise: Exercise?) -> (plan: SessionPlan?, exercise: Exercise?) {
        guard let plan, let exercise else { return (nil, nil) }
        return (plan, exercise)
    }
}

enum TutorServiceError: LocalizedError, Sendable {
    case missingAPIKey
    case invalidResponse
    case network(String)

    var errorDescription: String? {
        switch self {
        case .missingAPIKey: return "Add an OpenAI API key in Settings to use live tutoring."
        case .invalidResponse: return "The tutor returned an unreadable response."
        case .network(let message): return message
        }
    }
}
