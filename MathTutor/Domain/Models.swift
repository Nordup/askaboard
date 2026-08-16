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
///
/// There is deliberately no `none`. Because there is no translation layer, this
/// list *is* the wire contract: `BackendTutorService.body(for:)` sends the raw
/// value and the server refuses anything outside
/// `REASONING_EFFORT_ALLOWLIST` (`server/app/config.py`) with a 422 at body
/// validation, before the turn reaches a provider. `none` shipped here once and
/// the provider does not accept it, so every case this enum adds must be added
/// to that allowlist in the same change — see
/// `testEveryEffortIsOnTheServerAllowlist`. A case the server rejects is not a
/// slower turn; it is a session that cannot take a turn at all.
enum ReasoningEffort: String, CaseIterable, Codable, Hashable, Identifiable, Sendable {
    case low
    case medium
    case high
    case xhigh
    case max

    static let defaultValue: ReasoningEffort = .high

    var id: String { rawValue }

    var displayName: String {
        switch self {
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
        case .low: "Light reasoning"
        case .medium: "Balanced depth"
        case .high: "Deep reasoning"
        case .xhigh: "Extra-deep reasoning"
        case .max: "Maximum depth"
        }
    }

    /// Unknown values should not make an otherwise valid saved session
    /// undecodable after the provider adds a new effort level.
    ///
    /// This is also what repairs a session saved while `none` was still a case.
    /// That session persisted `"none"`, and every turn it sent 422'd until the
    /// learner picked a different effort by hand. Falling back to `high` here
    /// means it heals on the next load rather than staying stuck.
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
    /// What the tutor did to produce this message. `nil` on every learner
    /// message, and on every tutor message written before the trail existed —
    /// which is what the decoder below defaults.
    var activity: ActivityTrail?
    /// Whether this message arrived through a live voice call — a spoken
    /// learner utterance's transcript, or the voice model's own kept small
    /// talk. Defaults off, and decodes off for every session written before
    /// voice existed — the same migration `attachments` and `activity` carry.
    var isVoice: Bool = false

    init(
        id: UUID = UUID(),
        role: MessageRole,
        text: String,
        createdAt: Date = .now,
        signal: LearningSignal? = nil,
        attachments: [MessageAttachment] = [],
        activity: ActivityTrail? = nil,
        isVoice: Bool = false
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.signal = signal
        self.attachments = attachments
        self.activity = activity
        self.isVoice = isVoice
    }

    private enum CodingKeys: String, CodingKey {
        case id, role, text, createdAt, signal, attachments, activity, isVoice
    }

    /// Written out for two lines of it: `attachments` and `activity`.
    ///
    /// Swift's synthesised decoder does **not** fall back to a stored
    /// property's default value when its key is missing — it throws
    /// `keyNotFound`. Every session written before attachments existed lacks
    /// that key, and every session written before the activity trail existed
    /// lacks this one; `LearningSession` decodes `messages` with a plain
    /// `try`, so one legacy message would take the whole session down and
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
        activity = try container.decodeIfPresent(ActivityTrail.self, forKey: .activity)
        isVoice = try container.decodeIfPresent(Bool.self, forKey: .isVoice) ?? false
    }
}

enum LearningSignal: String, Codable, Sendable {
    case dontKnow
    case evaluate
    /// A tutor turn delegated by the live voice model — `send_to_tutor`'s
    /// request riding the normal pipeline. Carried on the wire (`signal:
    /// "voice"`) and on the synthetic request message only; the learner's own
    /// spoken turns are marked with `TutorMessage.isVoice` instead.
    case voice
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
    /// Which realtime model the next voice call opens on. Sits beside
    /// `selectedModel` rather than in a preference store because it is the same
    /// kind of choice with the same lifecycle: it rides the session file and a
    /// reset returns it to the default.
    var selectedVoiceModel: VoiceModelChoice
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
        selectedVoiceModel: VoiceModelChoice = .mini,
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
        self.selectedVoiceModel = selectedVoiceModel
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
        case selectedVoiceModel
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
        // `try?` on top of `ModelChoice`'s own lenient decoder, for the reason
        // `reasoningEffort` below carries both: the decoder repairs an unknown
        // model *id*, and this repairs a file with no `selectedModel` key at all.
        // Swift throws `keyNotFound` rather than reaching the initialiser then,
        // so one guard does not imply the other.
        selectedModel = (try? container.decode(ModelChoice.self, forKey: .selectedModel))
            ?? .defaultValue
        // Older session files do not have this key. Keep those sessions intact
        // and opt them into the same default used for a new session.
        reasoningEffort = (try? container.decode(ReasoningEffort.self, forKey: .reasoningEffort)) ?? .defaultValue
        // Same fallback, same reason: a session file written before voice was
        // selectable opens on the default rather than failing to load. Those
        // files predate the setting, so they carry no preference to respect —
        // they take today's default, which is Mini.
        selectedVoiceModel = (try? container.decode(VoiceModelChoice.self, forKey: .selectedVoiceModel)) ?? .mini
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
            selectedModel: .defaultValue,
            reasoningEffort: .defaultValue,
            selectedVoiceModel: .mini,
            startedAt: .now,
            lastSavedAt: .now
        )
    }
}

/// Which model thinks about a turn, across the two provider families the server
/// routes to.
///
/// The raw values are the wire contract, not display strings: `TurnRequest`
/// carries them unchanged and the server refuses anything outside
/// `MODEL_ALLOWLIST` (`server/app/config.py`) with a 422 at body validation,
/// before it picks a provider. So a case added here is a case added there, in
/// the same change, and a typo in one of these literals is not a wrong model —
/// it is a session that cannot take a turn at all.
///
/// The two families do not offer the same reasoning depths. That is what
/// `supportedEfforts` and `clamp(_:)` below are for.
enum ModelChoice: String, Codable, CaseIterable, Sendable, Identifiable {
    case sol = "gpt-5.6-sol"
    case terra = "gpt-5.6-terra"
    case luna = "gpt-5.6-luna"
    case flash = "gemini-3.7-flash"
    case flashLite = "gemini-3.5-flash-lite"

    var id: String { rawValue }
    var displayName: String {
        switch self {
        case .sol: return "Sol"
        case .terra: return "Terra"
        case .luna: return "Luna"
        case .flash: return "Flash"
        case .flashLite: return "Flash-Lite"
        }
    }

    /// What the route is for, in the register `VoiceModelChoice.caption` set: the
    /// honest trade rather than a sales line.
    ///
    /// Neither Gemini caption says "cheapest". Flash-Lite bills $0.30 / $2.50 per
    /// 1M against Luna's $0.20 / $1.20, so the cheapest model in this row is
    /// still Luna, and the saving a Gemini route buys is against Terra and Sol. A
    /// caption that claimed otherwise would read as a recommendation to move off
    /// the default, and it would be wrong.
    var caption: String {
        switch self {
        case .sol: return "Focused route"
        case .terra: return "Balanced route"
        case .luna: return "Vision route"
        case .flash: return "Wide context"
        case .flashLite: return "Cheaper, less capable"
        }
    }

    func caption(for reasoningEffort: ReasoningEffort) -> String {
        let effort = "\(reasoningEffort.displayName) reasoning"
        switch self {
        case .sol: return "\(effort) route"
        case .terra: return "Balanced route · \(effort)"
        case .luna: return "Vision route · \(effort)"
        case .flash: return "Wide context · \(effort)"
        case .flashLite: return "Cheaper route · \(effort)"
        }
    }

    /// The reasoning depths this model actually accepts, shallowest first.
    ///
    /// Gemini's `thinking_level` is low / medium / high; the gpt-5.6 route takes
    /// five. The picker reads this so it never shows a level the request cannot
    /// carry, which is the whole reason the effort row is model-dependent.
    ///
    /// **The order is load-bearing, and it looks incidental.** Both arrays run
    /// shallow to deep because `clamp(_:)` takes `last` as the deepest supported
    /// level. Sort one of them any other way and a clamp lands on a shallower
    /// depth than the learner asked for, quietly.
    var supportedEfforts: [ReasoningEffort] {
        switch self {
        case .sol, .terra, .luna: [.low, .medium, .high, .xhigh, .max]
        case .flash, .flashLite: [.low, .medium, .high]
        }
    }

    /// `effort` if this model accepts it, otherwise the deepest one it does.
    ///
    /// Lossy on purpose. Restoring the original depth when the learner switches
    /// back would mean storing one effort per family, and two efforts behind one
    /// row is a trap — the row would show a level the next turn did not use.
    func clamp(_ effort: ReasoningEffort) -> ReasoningEffort {
        supportedEfforts.contains(effort) ? effort : (supportedEfforts.last ?? .high)
    }

    /// What a session opens on, and what an unreadable saved choice falls back
    /// to. `LearningSession.empty` reads it too, so the two cannot drift.
    ///
    /// Luna rather than any other row, and it is the safe answer for the
    /// fallback as well as the pleasant one for a new session: it supports all
    /// five reasoning depths, so a session whose `reasoningEffort` decoded
    /// successfully never lands on a model that cannot carry it.
    static let defaultValue: ModelChoice = .luna

    /// An unknown model id must not make a saved session undecodable.
    ///
    /// The same guard `ReasoningEffort` above already has, and it was the one
    /// missing member of the set. `LearningSession.init(from:)` decodes this
    /// with a plain `try`, so a `session.json` naming a model this build does
    /// not have — a row renamed on the server, a file written by a newer build,
    /// a provider retiring a name — took the **whole file** down:
    /// `SessionPersistence.load` returns nil for it, and the learner loses every
    /// message, the plan, and the board along with a model choice nobody could
    /// have kept anyway.
    ///
    /// Falling back means the session opens on Luna and the learner can pick
    /// again from a row that is really there. That is what already happens for
    /// `reasoningEffort`, `selectedVoiceModel`, `boardScene` and the session
    /// `id`; this field was the only one still able to destroy the file.
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = try container.decode(String.self)
        self = ModelChoice(rawValue: rawValue) ?? .defaultValue
    }
}

/// Which realtime model holds a live voice call.
///
/// The other half of `ModelChoice`, and the reason it is a separate type: these
/// are a different provider family on a different price sheet, and the two
/// choices are independent — a learner can think on Sol and speak on Mini.
///
/// **Mini is the default since 2026-08-16, reversing the founder decision that
/// shipped with voice mode.** That decision — never a mini variant as the
/// default, because the mini is weakest exactly where voice leans hardest,
/// reliably calling `send_to_tutor` rather than ad-libbing an answer out loud —
/// lost to cost. Voice audio bills at $32/$64 per million on Full against
/// $10/$20 on Mini, and voice was 80% of the last session's spend *on the mini*.
///
/// So the trade now runs the other way: Mini is what a session opens on, and
/// Full is the deliberate upgrade when the tutor starts answering instead of
/// delegating. If that failure shows up in practice, this default is the first
/// thing to reconsider.
enum VoiceModelChoice: String, Codable, CaseIterable, Sendable, Identifiable {
    case full = "gpt-realtime-2.1"
    case mini = "gpt-realtime-2.1-mini"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .full: return "Full"
        case .mini: return "Mini"
        }
    }

    /// The honest trade, not a sales line: the reason to stay on Full is that it
    /// hands work to the tutor when it should, and the reason to pick Mini is
    /// that it costs roughly a third as much per minute.
    var caption: String {
        switch self {
        case .full: return "Best tool use"
        case .mini: return "Cheaper, less reliable"
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
