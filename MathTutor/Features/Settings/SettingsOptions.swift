import Foundation

/// One `select/option`'s content and state, independent of how it is drawn.
///
/// The pickers are the only part of board 10 with behaviour, and the behaviour is entirely
/// "which one of these carries the selected fill". Modelling that here rather than inside
/// the view is what lets a test assert the transition without rendering SwiftUI — and it is
/// also where the board's copy is pinned against `ModelChoice` / `ReasoningEffort`, so a
/// caption renamed in the domain fails a test instead of silently changing the screen.
struct SettingsOption<Value: Hashable & Sendable>: Identifiable, Equatable, Sendable {
    let value: Value
    let title: String
    let caption: String
    let isSelected: Bool

    var id: Value { value }
}

extension SettingsOption where Value == ModelChoice {
    /// Board 10's `Tutor model` row: Sol / Terra / Luna, in `allCases` order.
    static func models(selected: ModelChoice) -> [Self] {
        ModelChoice.allCases.map {
            Self(value: $0, title: $0.displayName, caption: $0.caption, isSelected: $0 == selected)
        }
    }
}

extension SettingsOption where Value == VoiceModelChoice {
    /// Board 10's `Voice model` row: Full / Mini, in `allCases` order.
    static func voiceModels(selected: VoiceModelChoice) -> [Self] {
        VoiceModelChoice.allCases.map {
            Self(value: $0, title: $0.displayName, caption: $0.caption, isSelected: $0 == selected)
        }
    }
}

extension SettingsOption where Value == ReasoningEffort {
    /// Board 10's `Reasoning effort` row, for the model that is selected: five
    /// levels under a gpt-5.6 route, three under a Gemini one.
    ///
    /// `model.supportedEfforts` rather than `ReasoningEffort.allCases`, and the
    /// difference is not a safety filter. `ReasoningEffort` is already the set
    /// the backend accepts, so a filter over *it* would only hide a case that
    /// should not exist — which is how `None` reached this picker and 422'd
    /// every turn the learner then sent. What this reads instead is the set the
    /// **selected model** accepts: Gemini's `thinking_level` takes low / medium
    /// / high, so a row that listed X-High under Flash would offer a depth the
    /// request cannot carry, and the turn would 422 all the same.
    static func efforts(for model: ModelChoice, selected: ReasoningEffort) -> [Self] {
        model.supportedEfforts.map {
            Self(value: $0, title: $0.displayName, caption: $0.caption, isSelected: $0 == selected)
        }
    }
}

// `rows(_:across:)` used to live here, splitting the six efforts into the board's 2 × 3 grid
// — *"produced by wrapping a 740 row, not by a grid definition."* The redesign put the options
// behind a menu on `row/setting`, so there is no grid left to lay out and the function went
// with it. `models(selected:)` and `efforts(for:selected:)` kept the shape they had: what the
// picker row needs is exactly what the cards needed — the options, in order, with one marked.
