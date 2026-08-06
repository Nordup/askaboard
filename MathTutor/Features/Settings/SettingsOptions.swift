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

extension SettingsOption where Value == ReasoningEffort {
    /// Board 10's `Reasoning effort` grid: None / Low / Medium · High / X-High / Max.
    static func efforts(selected: ReasoningEffort) -> [Self] {
        ReasoningEffort.allCases.map {
            Self(value: $0, title: $0.displayName, caption: $0.caption, isSelected: $0 == selected)
        }
    }
}

extension SettingsOption {
    /// *"The 2 × 3 grid is produced by wrapping a 740 row, not by a grid definition."*
    ///
    /// Laid out explicitly rather than wrapped, for the same reason `SuggestionList` does:
    /// a re-flow is a behaviour a fixed single-device layout never asks for, and it would
    /// make the section's measured height depend on the copy.
    static func rows(_ options: [Self], across columns: Int) -> [[Self]] {
        guard columns > 0 else { return [options] }
        return stride(from: 0, to: options.count, by: columns).map { start in
            Array(options[start ..< min(start + columns, options.count)])
        }
    }
}
