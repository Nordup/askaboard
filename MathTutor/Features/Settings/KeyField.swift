import SwiftUI

/// `field/key` — no longer a re-skin of `Composer · wide`.
///
/// It was one, and the old comment here said so: *"Box model is identical to `Composer ·
/// wide`"*, 740 × 80, `--radius-full`, with `btn/send`'s 56pt violet disc on the trailing
/// edge. Every one of those cues belongs to a thing you type into and then send. This field
/// mostly holds a value you already stored, and the disc was the loudest object in a window
/// whose job is to show you that value — so the redesign takes the field down to a control
/// rather than a composer, and swaps the disc for a text action.
///
/// | | was | now |
/// | --- | --- | --- |
/// | box | 740 × 80 | pane measure × 56 |
/// | radius | `--radius-full` | `--radius-lg` 14 |
/// | value | `--text-lead` 21, sans | 15 / 22, **mono** |
/// | action | `btn/send`, 56pt violet disc | `Replace`, brand text |
///
/// The mono is the one genuinely new thing and it is the one thing this file has to justify:
/// Typography's rule was that `--font-mono` *"must never reach a screen"*. A masked key is
/// the case that rule did not consider — the mask is 24 identical bullets, and a proportional
/// face sets them at a pitch that makes the run's length hard to read at a glance. See
/// `DS.FontFamily`, and note that the face that actually renders is the system's monospaced
/// one, because IBM Plex Mono is not in the bundle.
enum KeyFieldMetrics {
    /// Fills the pane's measure, so it carries no width of its own — the same rule every
    /// other control in the window follows.
    static let height: CGFloat = 56
    static let radius = DS.Radius.lg
    static let fill = DS.Color.surface
    static let elevation: Elevation = .control

    /// Both component-internal literals rather than tokens, per Foundations rule 11. 18
    /// happens to equal `--space-panel-inset` and 16 `--spacing-4`; binding either would move
    /// this field the day an unrelated token moved.
    static let paddingLeading: CGFloat = 18
    static let paddingTrailing: CGFloat = 16
    /// Value → action. A minimum: the action is pinned to the trailing edge.
    static let gap = DS.Space.s4

    /// 15 / 22 · 400 · ink, monospaced. `--color-ink` and not `--color-ink-tertiary`,
    /// because this is a filled field and not a placeholder.
    static let textStyle = TextStyle(
        size: DS.Size.label, leading: DS.Leading.control, weight: .regular, family: .mono
    )
    /// 15 / 18 · 600 · brand. Foundations allows brand colour in three places and this is
    /// not one of them — but it replaces `btn/send`, which *is* one of them, so the budget
    /// is unchanged and the spend moved from a 56pt disc to seven characters of text.
    static let actionStyle: DS.TextStyle = .label
    static let actionColor = DS.Color.brand

    /// What is left for the value once the action, the gap and the two paddings come off.
    static func textWidth(inColumn column: CGFloat, actionWidth: CGFloat) -> CGFloat {
        max(0, column - paddingLeading - paddingTrailing - gap - actionWidth)
    }
}

/// How a stored key is shown once it is in the Keychain.
///
/// Board 10's literal is `sk-proj-` + **24 × U+2022 BULLET** + `7Q4F`. The bullet run is a
/// fixed length rather than the key's own, so the mask leaks neither the key's characters
/// nor its length; only the vendor prefix — which is on every project key and is not secret
/// — and the last four survive.
enum APIKeyMask {
    static let bullet = "\u{2022}"
    static let bulletCount = 24
    static let revealedCount = 4
    /// The prefix is only looked for in the opening characters, so a hyphen further into a
    /// key's random body can never widen what is revealed. `sk-proj-` is 8.
    static let prefixScope = 12

    static func masked(_ key: String) -> String {
        let body = key.dropLast(revealedCount)
        let scope = body.prefix(prefixScope)
        let prefix = scope.range(of: "-", options: .backwards).map { String(scope[..<$0.upperBound]) } ?? ""
        return prefix + String(repeating: bullet, count: bulletCount) + String(key.suffix(revealedCount))
    }
}

/// The API-key row: a secure field, and a text action that commits it.
///
/// The key is handed straight to `TutorStore.saveAPIKey`, which is the Keychain and nothing
/// else. It is never written to `UserDefaults`, never logged, and `draft` is cleared by the
/// caller the moment the save succeeds.
///
/// Board 10 draws only the filled resting state — *"no focused / empty / error state for
/// this field is drawn anywhere in the file"* — so there is no placeholder, no focus ring
/// (rule 1: the product has no borders) and no validation copy. The pane heading directly
/// above names the field; `accessibilityLabel` says the same thing to VoiceOver, which
/// otherwise gets an unlabelled secure field.
struct KeyField: View {
    /// What is being typed. Transient view state — nothing persists it.
    @Binding var draft: String
    /// The mask for the key already in the Keychain, or `nil` when there is none.
    let storedMask: String?
    /// The pane's measure.
    let width: CGFloat
    let onSave: () -> Void

    var body: some View {
        HStack(spacing: KeyFieldMetrics.gap) {
            field
            action
        }
        .padding(.leading, KeyFieldMetrics.paddingLeading)
        .padding(.trailing, KeyFieldMetrics.paddingTrailing)
        .frame(width: width, height: KeyFieldMetrics.height)
        .background(
            KeyFieldMetrics.fill,
            in: RoundedRectangle(cornerRadius: KeyFieldMetrics.radius, style: .circular)
        )
        .elevation(KeyFieldMetrics.elevation)
    }

    private var field: some View {
        ZStack(alignment: .leading) {
            // The resting state the board draws. It is not a placeholder — it is the value,
            // which is why it takes `--color-ink`.
            if draft.isEmpty, let storedMask {
                Text(verbatim: storedMask)
                    .textStyle(KeyFieldMetrics.textStyle)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }

            SecureField("", text: $draft)
                .textFieldStyle(.plain)
                .textContentType(.password)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.done)
                .onSubmit(onSave)
                .textStyle(KeyFieldMetrics.textStyle)
                .foregroundStyle(DS.Color.ink)
                .tint(DS.Color.brand)
                .accessibilityLabel("OpenAI API key")
                .accessibilityIdentifier("api-key-field")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// `Replace`, where `btn/send` used to be.
    ///
    /// The label does not change with the field's state, and that is deliberate: a control
    /// that read `Save` on an empty field and `Replace` on a filled one would be a fourth
    /// state of a component the design draws exactly one state of.
    private var action: some View {
        Button(action: onSave) {
            Text(verbatim: SettingsCopy.replaceKey)
                .textStyle(KeyFieldMetrics.actionStyle)
                .foregroundStyle(KeyFieldMetrics.actionColor)
                .lineLimit(1)
                .fixedSize()
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Save API key")
        .accessibilityIdentifier("save-api-key")
    }
}
