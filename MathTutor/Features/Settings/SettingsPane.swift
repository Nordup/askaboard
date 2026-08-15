import Foundation

/// The two groups the settings window is divided into, and the only thing the sidebar and
/// the content pane have to agree about.
///
/// The redesigned board 10 replaced four stacked sections with a sidebar and one pane at a
/// time. The grouping is not a re-cut of the old sections so much as a re-cut of what they
/// were *about*: the two pickers are both "how the tutor answers", and resetting is part of
/// owning a session. So `Irreversible` does not survive as a group, and the warning that used
/// to be a shared caption is stated in the pane's own lede, in the terms of that pane.
///
/// There is no credential pane. The app holds no API key — the backend does — and its
/// address is a constant rather than a setting, so there is nothing here for a student to
/// configure and nothing about the deployment for this window to show. See
/// `BackendConfiguration`.
///
/// `CaseIterable` is the sidebar's running order, so adding a pane adds a nav item and
/// nothing else has to be told.
enum SettingsPane: String, CaseIterable, Identifiable, Sendable {
    case tutor
    case session

    var id: String { rawValue }

    /// The sidebar's label. Short, because the column is 216 wide and the labels sit in a
    /// vertical lane with 12pt of inset — anything longer would wrap and break the 44pt row.
    var navLabel: String {
        switch self {
        case .tutor: "Tutor"
        case .session: "Session"
        }
    }

    /// The pane's own heading. Same string as the nav label, deliberately: the sidebar is
    /// the table of contents and the heading is the confirmation, and a heading that renamed
    /// the thing you just tapped would make the two read as different places.
    var title: String { navLabel }

    /// The paragraph under the heading. Every pane has one and they are all two lines at the
    /// pane's measure, which is what lets `SettingsWindowMetrics.headerHeight` be a constant
    /// and the rule under it land at the same y in both — see that property.
    var lede: String {
        switch self {
        case .tutor:
            "How the tutor thinks and speaks. Changes apply to your next message; the "
                + "conversation so far is left alone."
        case .session:
            "Resetting clears the conversation and the goal it was working towards. It does "
                + "not touch your board or its ink."
        }
    }

    var accessibilityIdentifier: String { "settings-pane-\(rawValue)" }
}

/// The window's literal copy, minus the per-pane strings `SettingsPane` already owns.
enum SettingsCopy {
    static let modelLabel = "Tutor model"
    /// Row captions are new with the redesign. The old screen said what a section *was*
    /// through its heading alone; a row has a value on the right, so the caption's job is to
    /// say what changing that value does.
    static let modelCaption = "Which route answers you"
    static let effortLabel = "Reasoning effort"
    static let effortCaption = "How long it thinks before replying"
    static let voiceModelLabel = "Voice model"
    /// The row belongs in the Tutor pane because the pane's own lede already
    /// promises it — "How the tutor thinks **and speaks**".
    static let voiceModelCaption = "Which voice answers out loud"

    static let resetSession = "Reset this session"

    static let close = "Close settings"
}
