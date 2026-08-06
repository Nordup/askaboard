import SwiftUI

/// `field/key` — a re-skin of `Composer · wide`, not a new component.
///
/// Board 10: *"Box model is identical to `Composer · wide`"*, so every number here is read
/// off `ComposerMetrics.fullScreen` rather than restated. The two differences are the text
/// colour — `--color-ink`, because this is a filled field and not a placeholder — and what
/// the trailing disc does.
enum KeyFieldMetrics {
    static let width = ComposerMetrics.fullScreen.width
    static let height = ComposerMetrics.fullScreen.height
    static let paddingLeading = ComposerMetrics.fullScreen.paddingLeading
    static let paddingTrailing = ComposerMetrics.fullScreen.paddingTrailing
    static let gap = ComposerMetrics.fullScreen.gap
    static let saveButton = ComposerMetrics.fullScreen.sendButtonSize
    static let saveGlyph = ComposerMetrics.fullScreen.sendGlyphSize
    /// `--text-lead` 21 / 30 at `--color-ink` — the one place the lead style carries a
    /// *filled* value rather than a placeholder.
    static let textStyle: DS.TextStyle = .lead
    static let elevation: Elevation = .control

    /// `740 − 32 − 12 − 56 − 18 = 622`, the design's measured text box.
    static var textWidth: CGFloat { textWidth(inColumn: width) }

    /// The same subtraction in a column of any width — the pill is the section's width, and
    /// the text box is what is left once the disc, the gap and the two paddings come off.
    /// The composer this is a re-skin of narrows the same way, for the same reason.
    static func textWidth(inColumn column: CGFloat) -> CGFloat {
        max(0, column - paddingLeading - paddingTrailing - saveButton - gap)
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

/// The API-key row: a secure field in a composer pill, and a send disc that saves it.
///
/// The key is handed straight to `TutorStore.saveAPIKey`, which is the Keychain and nothing
/// else. It is never written to `UserDefaults`, never logged, and `draft` is cleared by the
/// caller the moment the save succeeds.
///
/// Board 10 draws only the filled resting state — *"no focused / empty / error state for
/// this field is drawn anywhere in the file"* — so there is no placeholder, no focus ring
/// (rule 1: the product has no borders) and no validation copy. The section heading directly
/// above names the field; `accessibilityLabel` says the same thing to VoiceOver, which
/// otherwise gets an unlabelled secure field.
struct KeyField: View {
    /// What is being typed. Transient view state — nothing persists it.
    @Binding var draft: String
    /// The mask for the key already in the Keychain, or `nil` when there is none.
    let storedMask: String?
    /// The column the pill fills. `nil` takes the 740 the board drew it at.
    var width: CGFloat?
    let onSave: () -> Void

    private var column: CGFloat { width ?? KeyFieldMetrics.width }

    var body: some View {
        HStack(spacing: KeyFieldMetrics.gap) {
            field
            saveButton
        }
        .padding(.leading, KeyFieldMetrics.paddingLeading)
        .padding(.trailing, KeyFieldMetrics.paddingTrailing)
        .frame(width: column, height: KeyFieldMetrics.height)
        .background(DS.Color.surface, in: Capsule())
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

    /// `btn/send` 56, reused from `03 §7.2`. Drawn here rather than through
    /// `ComposerSendButton` for one reason: that component's accessibility label is "Send
    /// message", and this disc saves a credential. Every metric still comes from the
    /// composer's own.
    private var saveButton: some View {
        Button(action: onSave) {
            IconView(.composerSend, size: KeyFieldMetrics.saveGlyph)
                .frame(width: KeyFieldMetrics.saveButton, height: KeyFieldMetrics.saveButton)
                .background(DS.Color.brand, in: Circle())
                .elevation(.control)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Save API key")
        .accessibilityIdentifier("save-api-key")
    }
}
