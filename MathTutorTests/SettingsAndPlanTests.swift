import CoreGraphics
import SwiftUI
import XCTest
@testable import MathTutor

/// Boards 10–13's load-bearing numbers, and the two rules that are easiest to break by
/// accident: the plan's lane must not reach for `--color-correct`, and `btn/destructive`
/// must not reach for any colour at all.
///
/// Everything here is asserted against a metrics value type rather than a rendered view.
/// The boards state arithmetic — `18 + 16 + 90 = 124`, `22 + 14 + 265 = 301` — and the
/// arithmetic is what catches a wrong inset; a snapshot of the result would only tell you
/// that something moved.
final class SettingsAndPlanTests: XCTestCase {
    // MARK: - Board 10 · the settings window

    /// The design's two free numbers, and the two centrings that place them.
    ///
    /// 308 and 256 are not typed in as constants anywhere in the app — they are
    /// `(1376 − 760) ÷ 2` and `28 + (976 − 520) ÷ 2`, run on the screen the app is actually
    /// on. Asserting them here is what proves the arithmetic reproduces the board rather than
    /// that someone transcribed two offsets.
    func testTheWindowIsTheDesignsSizeCentredOnTheReferenceScreen() {
        let window = SettingsWindowMetrics.reference
        XCTAssertEqual(window.size, CGSize(width: 760, height: 520))
        XCTAssertEqual(window.origin, CGPoint(x: 308, y: 256))
        XCTAssertEqual(window.size, SettingsWindowMetrics.designSize, "nothing clamps at 1376 × 1032")

        XCTAssertEqual(window.origin.x, (ScreenLayout.screenWidth - window.size.width) / 2)
        XCTAssertEqual(
            window.origin.y,
            ScreenLayout.contentTop + (ScreenLayout.contentHeight - window.size.height) / 2
        )
    }

    /// A window that will not fit shrinks before it moves, and never leaves the content band.
    ///
    /// This is the case board 10 never had an opinion about: the design's screen has room and
    /// the smallest supported iPad does not. The old screen answered it by scrolling a
    /// top-aligned column; a window has no column to scroll, so it gives up size instead —
    /// which is the same answer the tool rail gives when its fixed chain outgrows the band.
    func testTheWindowClampsToTheBandRatherThanOverflowingIt() {
        for device in Self.devices {
            let layout = device.layout
            let window = SettingsWindowMetrics(layout: layout)

            XCTAssertLessThanOrEqual(window.size.width, SettingsWindowMetrics.designSize.width, device.name)
            XCTAssertLessThanOrEqual(window.size.height, SettingsWindowMetrics.designSize.height, device.name)
            XCTAssertGreaterThanOrEqual(window.origin.y, layout.contentTop, device.name)
            XCTAssertLessThanOrEqual(
                window.origin.y + window.size.height, layout.contentBottom, device.name
            )
            XCTAssertGreaterThanOrEqual(window.origin.x, layout.safeAreaLeading, device.name)
            XCTAssertLessThanOrEqual(
                window.origin.x + window.size.width,
                layout.size.width - layout.safeAreaTrailing,
                device.name
            )
        }
    }

    /// A 768pt-tall iPad is 456 short of the 894pt chain the old screen carried, and had to
    /// scroll. The window is 520 and simply fits, which is the redesign's one unambiguous win
    /// on small screens.
    func testTheShortestSupportedBandHoldsTheWholeWindow() {
        let short = SettingsWindowMetrics(
            layout: ScreenLayout(
                size: CGSize(width: 1024, height: 768),
                safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
            )
        )
        XCTAssertEqual(short.size, SettingsWindowMetrics.designSize, "no clamping at 1024 × 768")
    }

    func testThePaneMeasureIsWhatIsLeftAfterTheSidebar() {
        let window = SettingsWindowMetrics.reference
        XCTAssertEqual(window.paneWidth, 544, "760 − 216")
        XCTAssertEqual(window.paneContentWidth, 480, "544 − 32 × 2")
        XCTAssertEqual(window.navItemWidth, 184, "216 − 16 × 2")
    }

    /// The rule under the pane header must not move when you change tabs.
    ///
    /// Every pane's lede is written to two lines at the 480pt measure, and the header is
    /// pinned to the height that implies. If someone shortens a lede to one line, the header
    /// still measures 116 and this test still passes — which is the point. What it catches is
    /// someone deciding the header should hug.
    func testThePaneHeaderIsPinnedSoTheRuleDoesNotJump() {
        XCTAssertEqual(SettingsWindowMetrics.headerHeight, 116, "34 + 10 + 22 × 2 + 28")
        XCTAssertEqual(SettingsWindowMetrics.paneLedeLines, 2)
        XCTAssertEqual(SettingsWindowMetrics.paneTitleStyle, .title)
        XCTAssertEqual(SettingsWindowMetrics.paneLedeStyle.size, DS.Size.label)
        XCTAssertEqual(
            SettingsWindowMetrics.paneLedeStyle.leading,
            DS.Leading.control,
            "the label size in the control line box — 18 would set two wrapped lines too tight"
        )
    }

    /// *"Radius is chosen by how big the surface is, not by taste."*
    func testTheWindowTakesTheBigSurfaceRadiusAndTheNewElevation() {
        XCTAssertEqual(SettingsWindowMetrics.radius, DS.Radius.xxxl)
        XCTAssertEqual(SettingsWindowMetrics.fill, DS.Color.surface)
        XCTAssertEqual(SettingsWindowMetrics.elevation, .modal)
        // The level the scale did not previously go to, and the reason it had to: 02 · Panel
        // over a whitened backdrop leaves the window with no edge.
        XCTAssertGreaterThan(Elevation.modalLift.alpha, Elevation.panelLift.alpha)
        XCTAssertEqual(Elevation.modal.layers.count, 2, "lift then contact, like 02 and 03")
        // The contact layer is 02 · Panel's outer alpha exactly, which is what keeps this
        // level to *one* genuinely new number after the shadow was pulled back from its first,
        // much heavier draft.
        XCTAssertEqual(Elevation.modalContact.alpha, Elevation.panelLift.alpha, accuracy: 0.0002)
        XCTAssertLessThan(Elevation.modalLift.alpha, 0.1, "pulled back from the 0.141 first draft")
        XCTAssertEqual(Elevation.modalLift.blur, 40)
        XCTAssertEqual(Elevation.modalLift.y, 16)
    }

    /// The sidebar's rule is the one stroke in the window, and it is the sanctioned one.
    func testTheOnlyStrokeInTheWindowIsTheDividerToken() {
        XCTAssertEqual(SettingsWindowMetrics.rule, DS.Color.divider)
        XCTAssertEqual(SettingsWindowMetrics.ruleWidth, 1)
        XCTAssertEqual(SettingRowMetrics.rule, DS.Color.divider)
    }

    // MARK: - nav/item

    /// The selection is the tool slot's rule applied to a different kind of slot: the same
    /// `--radius-lg` and the same `--color-brand-tint`, and no fourth spend of brand colour.
    func testNavItemSelectionReusesTheSelectedToolSlotsVocabulary() {
        XCTAssertEqual(SettingsNavItemMetrics.radius, DS.Radius.lg)
        // The rail's selected tool slot draws `RoundedRectangle(DS.Radius.lg).fill(brandTint)`
        // — see `ToolRailParts`. `select/option` used to be the other citation for this rule;
        // it was retired with the old board 10, so the rail is the only one left.
        XCTAssertEqual(SettingsNavItemMetrics.fill(isSelected: true), DS.Color.brandTint)
        XCTAssertEqual(SettingsNavItemMetrics.fill(isSelected: false), .clear)
    }

    /// Where it parts company with `select/option`, which is identical in both states.
    func testNavItemLabelChangesWithTheStateUnlikeAnOptionCard() {
        XCTAssertEqual(SettingsNavItemMetrics.labelStyle(isSelected: true).weight, .semibold)
        XCTAssertEqual(SettingsNavItemMetrics.labelStyle(isSelected: false).weight, .medium)
        XCTAssertEqual(SettingsNavItemMetrics.labelColor(isSelected: true), DS.Color.ink)
        XCTAssertEqual(SettingsNavItemMetrics.labelColor(isSelected: false), DS.Color.inkSecondary)
    }

    func testEveryPaneHasANavLabelAHeadingAndALede() {
        XCTAssertEqual(SettingsPane.allCases, [.tutor, .apiKey, .session])
        for pane in SettingsPane.allCases {
            XCTAssertFalse(pane.navLabel.isEmpty, pane.rawValue)
            XCTAssertEqual(pane.title, pane.navLabel, "the heading confirms the nav item, it does not rename it")
            XCTAssertFalse(pane.lede.isEmpty, pane.rawValue)
        }
    }

    // MARK: - row/setting

    func testTheChevronSlotIsFixedSoTheMarksShareALane() {
        // The failure this prevents: two rows whose values are different widths putting their
        // chevrons in different columns.
        XCTAssertEqual(SettingRowMetrics.chevronSlot, 20)
        XCTAssertEqual(SettingRowMetrics.chevronGlyph, 16)
        XCTAssertGreaterThan(SettingRowMetrics.chevronSlot, SettingRowMetrics.chevronGlyph)
    }

    func testTheRowIsTallerThanItsLabelStackByDesign() {
        XCTAssertEqual(SettingRowMetrics.labelStackHeight, 44, "22 + 4 + 18")
        XCTAssertEqual(SettingRowMetrics.height, 120)
        XCTAssertGreaterThan(SettingRowMetrics.height, SettingRowMetrics.labelStackHeight)
    }

    /// The label is the question and the value is the answer, so the value sits a weight below.
    func testTheRowsValueIsLighterThanItsLabel() {
        XCTAssertEqual(SettingRowMetrics.labelStyle.weight, .semibold)
        XCTAssertEqual(SettingRowMetrics.valueStyle.weight, .medium)
        XCTAssertEqual(SettingRowMetrics.labelStyle.size, DS.Size.body)
        XCTAssertEqual(SettingRowMetrics.valueStyle.size, DS.Size.body)
    }

    // MARK: - The backdrop

    /// **White, not ink** — the redesign's premise, and the easiest thing here to "fix" back
    /// into a conventional dark scrim.
    func testTheBackdropWhitensTheBoardRatherThanDimmingIt() {
        XCTAssertEqual(SettingsBackdropMetrics.scrim, DS.Color.surface.opacity(0.4))
        XCTAssertNotEqual(SettingsBackdropMetrics.scrim, DS.Color.ink.opacity(0.4))
    }

    /// The same halving `Elevation.Layer.shadowRadius` does, for the same reason: CSS states
    /// the full width of the Gaussian and SwiftUI takes half of it.
    func testTheBackdropBlurIsHalvedOutOfCSS() {
        XCTAssertEqual(SettingsBackdropMetrics.designBlur, 2)
        XCTAssertEqual(SettingsBackdropMetrics.blurRadius, 1)
        XCTAssertEqual(SettingsBackdropMetrics.blurRadius, SettingsBackdropMetrics.designBlur / 2)
    }

    // MARK: - btn/destructive

    func testDestructiveButtonHugsItsLabelAndSitsBelowTheKeyField() {
        XCTAssertEqual(DestructiveButtonMetrics.height, 44)
        XCTAssertEqual(DestructiveButtonMetrics.paddingInline, 20)
        XCTAssertEqual(DestructiveButtonMetrics.width(labelWidth: 114), 154, "Remove API key")
        // One step below the field it stands under, which is what stops the pane reading as
        // two controls of equal weight.
        XCTAssertLessThan(DestructiveButtonMetrics.height, KeyFieldMetrics.height)
    }

    /// **This test asserts a loss, and says so.**
    ///
    /// The old rule was that a destructive control is the only thing in the product with no
    /// elevation — everything safe is lifted, and the things that destroy sit *in* the
    /// surface. The redesign gives it the same white-and-elevation-03 footing as the key
    /// field, so that signal is gone and the pane's lede carries the warning alone.
    ///
    /// What has *not* changed is that the button still spends no colour. If the design ever
    /// decides the shape signal needs replacing, replacing it with red is the thing this test
    /// exists to make someone argue for out loud.
    func testDestructiveButtonStillCarriesNoDangerColour() {
        XCTAssertEqual(DestructiveButtonMetrics.fill, DS.Color.surface)
        XCTAssertEqual(DestructiveButtonMetrics.elevation, .control)
        // "NOT for destructive, warning or validation UI" — `--color-incorrect`'s own words.
        XCTAssertNotEqual(DestructiveButtonMetrics.fill, DS.Color.incorrect)
        XCTAssertNotEqual(DestructiveButtonMetrics.fill, DS.Color.penRed)
        XCTAssertEqual(DestructiveButtonMetrics.radius, DS.Radius.lg, "not a capsule any more")
    }

    // MARK: - btn/primary

    func testPrimaryButtonPanelHeightIsTheComposersSlot() {
        // Derived, not free: it is whatever the panel composer is, so the two occupants of the
        // panel's bottom slot stay interchangeable. It came down 58 → 50 with the pill.
        XCTAssertEqual(PrimaryButtonMetrics.panel.height, 50)
        XCTAssertEqual(PrimaryButtonMetrics.panel.height, ComposerMetrics.panel.height)
        XCTAssertEqual(PrimaryButtonMetrics.panel.height, PanelActionSlotMetrics.height)
        XCTAssertTrue(PrimaryButtonMetrics.panel.fillsColumn)
        XCTAssertEqual(PrimaryButtonMetrics.panel.paddingInline, 0, "the label is centred, not inset")
    }

    func testPrimaryButtonFullScreenHugsItsLabel() {
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.height, 64)
        XCTAssertFalse(PrimaryButtonMetrics.fullScreen.fillsColumn)
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.paddingInline, DS.Space.s8)
        // label 156 + 32 × 2 = 220, the board's measured width for "Start on the board".
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.width(labelWidth: 156), 220)
        // Deliberately lighter than the 80pt full-screen composer above it.
        XCTAssertNotEqual(PrimaryButtonMetrics.fullScreen.height, ComposerMetrics.fullScreen.height)
    }

    /// A filled button fills *its* column, not the one the design drew it in.
    ///
    /// This never bit in the panel — `--container-panel` is the one fixed-width surface in the
    /// product, so its content column is 301 wherever the app runs. The plan's CTA is the copy
    /// of this button that travels to the reading column, and there 301 and 740 are neither of
    /// them a constant the button may assume.
    func testThePrimaryButtonFillsTheColumnItIsLaidOutInAndNotTheDesignsOwn() {
        XCTAssertEqual(PrimaryButtonMetrics.panel.columnWidth, DS.Container.panelContent)
        XCTAssertEqual(PrimaryButtonMetrics.panel.frameWidth, DS.Container.panelContent)
        XCTAssertEqual(PrimaryButtonMetrics.for(.panel, width: 644).frameWidth, 644)

        // Full screen hugs its label, so it has no column to fill and hands `.frame` nothing
        // at all — the width is the label's, and stays the label's in a narrower column.
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.columnWidth, DS.Container.column)
        XCTAssertNil(PrimaryButtonMetrics.fullScreen.frameWidth)
        XCTAssertNil(PrimaryButtonMetrics.for(.fullScreen, width: 644).frameWidth)
        XCTAssertEqual(PrimaryButtonMetrics.for(.fullScreen, width: 644).width(labelWidth: 156), 220)
    }

    func testPrimaryButtonIsTheOnlyNewVioletAndCarriesElevationAtBothScales() {
        XCTAssertEqual(PrimaryButtonMetrics.panel.elevation, .control)
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.elevation, .control)
        XCTAssertEqual(PrimaryButtonMetrics.panel.labelStyle.weight, .semibold)
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.labelStyle.size, 20)
        XCTAssertEqual(PrimaryButtonMetrics.fullScreen.labelStyle.weight, .semibold)
    }

    // MARK: - field/key

    /// **`field/key` stopped being a re-skin of `Composer · wide`, and that is the point.**
    ///
    /// This test used to assert the opposite: every number read off `ComposerMetrics
    /// .fullScreen`, so the field followed the composer's pill wherever it went. The redesign
    /// cuts that tie deliberately — a control that holds a value you already stored should not
    /// inherit the geometry of a thing you type into and send. So the relationship assertions
    /// became *in*equalities, and they are the ones that fail if someone reconnects them.
    func testKeyFieldIsNoLongerTheWideComposer() {
        XCTAssertEqual(KeyFieldMetrics.height, 56)
        XCTAssertEqual(KeyFieldMetrics.radius, DS.Radius.lg)
        XCTAssertEqual(KeyFieldMetrics.paddingLeading, 18)
        XCTAssertEqual(KeyFieldMetrics.paddingTrailing, 16)
        XCTAssertEqual(KeyFieldMetrics.gap, DS.Space.s4)
        XCTAssertEqual(KeyFieldMetrics.elevation, .control)

        XCTAssertNotEqual(KeyFieldMetrics.height, ComposerMetrics.fullScreen.height)
        XCTAssertNotEqual(KeyFieldMetrics.textStyle.size, ComposerMetrics.fullScreen.placeholderStyle.size)
    }

    /// The one place in the product a family other than Source Sans 3 renders, and the rule it
    /// overturned: Typography used to say `--font-mono` *"must never reach a screen"*.
    func testTheStoredKeyIsSetMonospaced() {
        XCTAssertEqual(KeyFieldMetrics.textStyle.family, .mono)
        XCTAssertEqual(KeyFieldMetrics.textStyle.size, DS.Size.label)
        XCTAssertEqual(KeyFieldMetrics.textStyle.leading, DS.Leading.control)
        // A filled value, not a placeholder, so it stays at regular weight and full ink.
        XCTAssertEqual(KeyFieldMetrics.textStyle.weight, .regular)
        // Every other style on the scale is untouched by the new axis.
        XCTAssertTrue(TextStyle.scale.allSatisfy { $0.family == .sans })
    }

    /// `Replace` spends the brand colour that `btn/send`'s violet disc used to, so the
    /// three-place budget Foundations sets is unchanged — the spend just got much smaller.
    func testTheKeyFieldsActionInheritsTheSendDiscsBrandBudget() {
        XCTAssertEqual(KeyFieldMetrics.actionColor, DS.Color.brand)
        XCTAssertEqual(KeyFieldMetrics.actionStyle, .label)
        // 480 − 18 − 16 − 16 − 62 = 368 for the value.
        XCTAssertEqual(KeyFieldMetrics.textWidth(inColumn: 480, actionWidth: 62), 368)
    }

    func testAPIKeyMaskRevealsOnlyThePrefixAndTheLastFour() {
        let key = "sk-proj-" + String(repeating: "A", count: 32) + "7Q4F"
        let masked = APIKeyMask.masked(key)

        XCTAssertEqual(masked, "sk-proj-" + String(repeating: "\u{2022}", count: 24) + "7Q4F")
        XCTAssertFalse(masked.contains("A"), "no character of the key's body survives the mask")
        XCTAssertEqual(masked.count, 36, "8 + 24 + 4 — the board's literal")
    }

    func testAPIKeyMaskHidesTheKeysLength() {
        let short = APIKeyMask.masked("sk-proj-" + String(repeating: "A", count: 4) + "7Q4F")
        let long = APIKeyMask.masked("sk-proj-" + String(repeating: "A", count: 400) + "7Q4F")
        XCTAssertEqual(short, long, "a fixed bullet run, so the mask leaks no length either")
    }

    func testAPIKeyMaskNeverWidensPastTheVendorPrefix() {
        // A hyphen deep inside a key's body must not be mistaken for the prefix delimiter.
        let masked = APIKeyMask.masked("sk-proj-AAAAAAAA-SECRET-BODY-7Q4F")
        XCTAssertTrue(masked.hasPrefix("sk-proj-"))
        XCTAssertFalse(masked.contains("SECRET"))
    }

    // MARK: - The pickers

    func testModelOptionsAreTheBoardsThreeRoutesInOrder() {
        let options = SettingsOption.models(selected: .luna)
        XCTAssertEqual(options.map(\.title), ["Sol", "Terra", "Luna"])
        XCTAssertEqual(options.map(\.caption), ["Focused route", "Balanced route", "Default route"])
        XCTAssertEqual(options.filter(\.isSelected).map(\.value), [.luna])
    }

    func testEffortOptionsAreTheBoardsSixLevelsInOrder() {
        let options = SettingsOption.efforts(selected: .high)
        XCTAssertEqual(options.map(\.title), ["None", "Low", "Medium", "High", "X-High", "Max"])
        XCTAssertEqual(
            options.map(\.caption),
            [
                "Fastest replies", "Light reasoning", "Balanced depth",
                "Deep reasoning", "Extra-deep reasoning", "Maximum depth",
            ]
        )
        XCTAssertEqual(options.filter(\.isSelected).map(\.value), [.high])
    }

    func testExactlyOneOptionIsSelectedAtEveryValue() {
        for model in ModelChoice.allCases {
            XCTAssertEqual(SettingsOption.models(selected: model).filter(\.isSelected).count, 1)
        }
        for effort in ReasoningEffort.allCases {
            XCTAssertEqual(SettingsOption.efforts(selected: effort).filter(\.isSelected).count, 1)
        }
    }

    @MainActor
    func testPickingAModelMovesTheSelectedFillAndPersistsToTheStore() {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        XCTAssertEqual(store.session.selectedModel, .luna)

        store.setModel(.sol)

        let options = SettingsOption.models(selected: store.session.selectedModel)
        XCTAssertEqual(store.session.selectedModel, .sol)
        XCTAssertEqual(options.filter(\.isSelected).map(\.value), [.sol])
        // What the row shows on its trailing edge is the selected option's title, which is
        // the redesign's whole replacement for nine cards with one tinted fill.
        XCTAssertEqual(options.first(where: \.isSelected)?.title, ModelChoice.sol.displayName)
    }

    @MainActor
    func testPickingAnEffortMovesTheSelectedFillAndPersistsToTheStore() {
        let store = TutorStore(service: DemoTutorService())
        store.resetSession()
        XCTAssertEqual(store.session.reasoningEffort, .high)

        store.setReasoningEffort(.max)

        let options = SettingsOption.efforts(selected: store.session.reasoningEffort)
        XCTAssertEqual(store.session.reasoningEffort, .max)
        XCTAssertEqual(options.filter(\.isSelected).map(\.value), [.max])

        store.setReasoningEffort(.none)
        XCTAssertEqual(
            SettingsOption.efforts(selected: store.session.reasoningEffort).filter(\.isSelected).map(\.value),
            [ReasoningEffort.none]
        )
    }

    // MARK: - Board 11 · first run

    func testNoKeyBlockIsOneHundredAndFiftySixOnTheBoardsWrap() {
        // 34 + 12 + 3 × 24 + 20 + 18 = 156
        XCTAssertEqual(NoAPIKeyMetrics.blockHeight(bodyLines: 3), 156)
        XCTAssertEqual(NoAPIKeyMetrics.bodyWidth, 277, "301 − 24, the panel greeting's measure")
        // "short and centred" leading, not the 17 / 25 of running message text.
        XCTAssertEqual(NoAPIKeyMetrics.bodyStyle.leading, DS.Leading.snug)
    }

    func testNoKeyFlowMatchesTheBoardsFiveEightFour() {
        // 18 + 32 + 248 + 90 + 40 + 156 = 584
        XCTAssertEqual(NoAPIKeyMetrics.flowBottom(bodyLines: 3), 584)
        XCTAssertEqual(NoAPIKeyMetrics.orb.metrics.frame, CGSize(width: 96, height: 90))
    }

    func testTheActionSlotIsTheComposersSlot() {
        XCTAssertEqual(PanelActionSlotMetrics.height, ComposerMetrics.panel.height)
        XCTAssertEqual(PanelActionSlotMetrics.bottomInset, DS.Space.panelInset)

        // The panel's height is the screen's content band — 976 on the board's own screen,
        // 692 on the shortest iPad the app runs on. Neither is the panel's own number, which
        // is why the slot is anchored to the bottom rather than measured down from the top.
        let reference = ScreenLayout.reference.contentHeight
        let shortest = ScreenLayout(
            size: CGSize(width: 1024, height: 768),
            safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
        ).contentHeight
        XCTAssertEqual(reference, 976)
        XCTAssertEqual(shortest, 692)

        XCTAssertEqual(
            PanelActionSlotMetrics.top(inPanelOfHeight: reference),
            908,
            "where boards 05 / 08 / 11 / 12 all put it — `976 − 18 − 50`"
        )
        // The slot sits on the panel's floor with the 18pt inset under it whatever height the
        // panel is given — the property an absolute 860 could not have, and the reason the
        // button does not float mid-panel on a shorter iPad.
        for height in [reference, shortest] {
            XCTAssertEqual(
                PanelActionSlotMetrics.top(inPanelOfHeight: height)
                    + PanelActionSlotMetrics.height
                    + PanelActionSlotMetrics.bottomInset,
                height,
                "panel of \(height)"
            )
        }
        // A panel too short to hold the slot at all puts it on its own top edge rather than
        // above it — a negative offset is a layout error, not a small panel.
        XCTAssertEqual(PanelActionSlotMetrics.top(inPanelOfHeight: 0), 0)
    }

    func testFirstRunCopyDoesNotClaimTheKeyNeverLeavesTheDevice() {
        // `06 §Open questions 9`: board 11's sentence is a false security claim and board
        // 10's is the accurate one. The accurate wording ships.
        XCTAssertFalse(NoAPIKeyCopy.body.contains("never leaves"))
        XCTAssertTrue(NoAPIKeyCopy.body.contains("Keychain"))
        XCTAssertTrue(NoAPIKeyCopy.body.contains("OpenAI"))
        // The accurate sentence moved from a section caption to the API-key pane's lede when
        // settings became a window; it is still the one that ships.
        XCTAssertEqual(
            SettingsPane.apiKey.lede,
            "Kept in this device's Keychain. It is sent to OpenAI and nowhere else."
        )
    }

    // MARK: - Boards 12 / 13 · the plan

    func testPanelPlanIsFiveHundredAndNinetySevenOnTheBoardsWrap() {
        // Board 12: rows 1 and 3 of Steps wrap, rows 1 and 2 of Outcomes wrap. 597 rather than
        // the board's 605 because the plan's tail is `btn/primary`, which is the panel
        // composer's height by derivation and came down 8 with it.
        XCTAssertEqual(
            SessionPlanMetrics.panel.height(stepLines: [2, 1, 2, 1], outcomeLines: [2, 2, 1]),
            597
        )
        XCTAssertEqual(SessionPlanMetrics.panel.action.height, ComposerMetrics.panel.height)
    }

    func testFullScreenPlanIsSixHundredAndEightWithEveryRowOnOneLine() {
        XCTAssertEqual(
            SessionPlanMetrics.fullScreen.height(stepLines: [1, 1, 1, 1], outcomeLines: [1, 1, 1]),
            608
        )
    }

    func testPlanStackHeightsAreTheBoardsBlocks() {
        // Panel: 50 + 12 + 25 + 12 + 50 + 12 + 25 = 186 · 50 + 8 + 50 + 8 + 25 = 141
        let panel = SessionPlanMetrics.panel
        XCTAssertEqual(panel.lane.stackHeight(lines: [2, 1, 2, 1], gap: panel.stepGap), 186)
        XCTAssertEqual(panel.lane.stackHeight(lines: [2, 2, 1], gap: panel.outcomeGap), 141)

        // Full screen: 24 × 4 + 20 × 3 = 156 · 24 × 3 + 12 × 2 = 96
        let wide = SessionPlanMetrics.fullScreen
        XCTAssertEqual(wide.lane.stackHeight(lines: [1, 1, 1, 1], gap: wide.stepGap), 156)
        XCTAssertEqual(wide.lane.stackHeight(lines: [1, 1, 1], gap: wide.outcomeGap), 96)
    }

    func testTheLaneIsExactlyItsColumnAtBothScales() {
        // 22 + 14 + 265 = 301 · 24 + 16 + 700 = 740
        XCTAssertEqual(PlanLaneMetrics.panel.width, DS.Container.panelContent)
        XCTAssertEqual(PlanLaneMetrics.panel.textWidth, 265)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.width, DS.Container.column)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.textWidth, 700)
    }

    func testTheLaneSlotSitsOnItsOwnLineBox() {
        // The slot's height is the row's leading, which is what keeps a wrapped row
        // top-aligned and a single-line row optically centred.
        XCTAssertEqual(PlanLaneMetrics.panel.slotWidth, 22)
        XCTAssertEqual(PlanLaneMetrics.panel.slotHeight, DS.Leading.body)
        XCTAssertEqual(PlanLaneMetrics.panel.slotHeight, PlanLaneMetrics.panel.textStyle.leading)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.slotWidth, 24)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.slotHeight, DS.Leading.snug)
        XCTAssertEqual(
            PlanLaneMetrics.fullScreen.slotHeight,
            PlanLaneMetrics.fullScreen.textStyle.leading
        )
    }

    func testTheNumberStaysQuieterThanTheTextItLabels() {
        // 15 → 17 while the body steps 17 → 20.
        XCTAssertEqual(PlanLaneMetrics.panel.numberStyle.size, 15)
        XCTAssertEqual(PlanLaneMetrics.panel.textStyle.size, 17)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.numberStyle.size, 17)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.textStyle.size, 20)
        XCTAssertEqual(PlanLaneMetrics.panel.numberStyle.weight, .semibold)
        XCTAssertEqual(PlanLaneMetrics.fullScreen.textStyle.weight, .regular)
    }

    func testThePlansCheckIsIconGreyAndNotTheCorrectnessGreen() {
        // The lane shares its geometry with the evaluation findings, which is exactly why
        // `--color-correct` leaks here first. A plan outcome is not a verdict on the
        // student's work: "a finished plan step is done, not correct."
        XCTAssertEqual(PlanLaneMetrics.markTint, DS.Color.icon)
        XCTAssertNotEqual(PlanLaneMetrics.markTint, DS.Color.correct)
        XCTAssertNotEqual(PlanLaneMetrics.markTint, DS.Color.incorrect)
    }

    func testThePlanIsUnboxed() {
        // There is no fill, radius, shadow or padding to assert — the absence is the
        // property. What can be pinned is that the block is exactly its column wide, which
        // is what a card would have broken with its own padding.
        XCTAssertEqual(SessionPlanMetrics.panel.width, DS.Container.panelContent)
        XCTAssertEqual(SessionPlanMetrics.fullScreen.width, DS.Container.column)
        XCTAssertEqual(SessionPlanMetrics.panel.width, PlanLaneMetrics.panel.width)
        XCTAssertEqual(SessionPlanMetrics.fullScreen.width, PlanLaneMetrics.fullScreen.width)
    }

    /// The bug the plan had, and the last one of its kind on this surface.
    ///
    /// `--container-column` is 740; the reading column is not. `ScreenLayout.columnWidth` is
    /// `min(740, region − 2 × edge)`, so a portrait iPad hands the thread 644 and the plan drew
    /// 740 in it — 96 points off the end of the column every other child of that thread had
    /// already learned to take. It is reachable only in the full-screen-plus-thread state, the
    /// one cell of the state table the design never drew, which is why it outlived the sweep
    /// that fixed the composer, the bubble, the chips and the failure beside it.
    func testThePlanIsTheColumnItIsLaidOutInAtEveryScreen() {
        for device in Self.devices {
            for scale in ChatScale.allCases {
                let width = Self.column(scale, on: device.layout)
                let plan = SessionPlanMetrics.for(scale, width: width)
                let context = "\(scale.rawValue) at \(device.name) · \(width)"

                XCTAssertEqual(plan.width, width, context)
                // The lane is the block's own row, so a plan that narrowed while its steps
                // stayed 740 would be the same bug one level down. `22 + 14 + 265 = 301` is
                // this subtraction run at the design's column; it closes on every other.
                XCTAssertEqual(plan.lane.width, width, accuracy: 0.001, context)
                XCTAssertGreaterThan(plan.lane.textWidth, 0, context)
                // And the CTA fills the column it is in rather than the one the board drew.
                XCTAssertEqual(plan.action.columnWidth, width, context)
                XCTAssertEqual(plan.action.frameWidth, scale == .panel ? width : nil, context)
            }
        }
    }

    /// The other half of the same rule: the column moves the frame and **nothing else**.
    ///
    /// Board 05: *"Treat the greeting/chips/composer as two variants, not one responsive
    /// view."* The plan is the same kind of thing, and the failure mode a width parameter
    /// invites is the opposite of the one it fixes — a narrower reading column quietly
    /// restyling board 13's plan into board 12's. The display headline does not drop to 26
    /// because the screen got smaller.
    func testANarrowerColumnDoesNotRestyleThePlan() {
        for scale in ChatScale.allCases {
            let design = SessionPlanMetrics.for(scale)
            let narrow = SessionPlanMetrics.for(scale, width: 480)
            let context = scale.rawValue

            XCTAssertEqual(narrow.scale, design.scale, context)
            XCTAssertEqual(narrow.kickerStyle, design.kickerStyle, context)
            XCTAssertEqual(narrow.titleStyle, design.titleStyle, context)
            XCTAssertEqual(narrow.goalStyle, design.goalStyle, context)
            XCTAssertEqual(narrow.goalLines, design.goalLines, context)
            XCTAssertEqual(narrow.outcomesLabelStyle, design.outcomesLabelStyle, context)
            XCTAssertEqual(narrow.titleTopMargin, design.titleTopMargin, context)
            XCTAssertEqual(narrow.goalTopMargin, design.goalTopMargin, context)
            XCTAssertEqual(narrow.stepsTopMargin, design.stepsTopMargin, context)
            XCTAssertEqual(narrow.stepGap, design.stepGap, context)
            XCTAssertEqual(narrow.outcomesLabelTopMargin, design.outcomesLabelTopMargin, context)
            XCTAssertEqual(narrow.outcomesTopMargin, design.outcomesTopMargin, context)
            XCTAssertEqual(narrow.outcomeGap, design.outcomeGap, context)
            XCTAssertEqual(narrow.actionTopMargin, design.actionTopMargin, context)

            // The lane's slot, gap, type and mark are the scale's; a digit does not shrink.
            XCTAssertEqual(narrow.lane.slotWidth, design.lane.slotWidth, context)
            XCTAssertEqual(narrow.lane.slotHeight, design.lane.slotHeight, context)
            XCTAssertEqual(narrow.lane.gap, design.lane.gap, context)
            XCTAssertEqual(narrow.lane.textStyle, design.lane.textStyle, context)
            XCTAssertEqual(narrow.lane.numberStyle, design.lane.numberStyle, context)
            XCTAssertEqual(narrow.lane.markSize, design.lane.markSize, context)

            XCTAssertEqual(narrow.action.height, design.action.height, context)
            XCTAssertEqual(narrow.action.paddingInline, design.action.paddingInline, context)
            XCTAssertEqual(narrow.action.labelStyle, design.action.labelStyle, context)
            XCTAssertEqual(narrow.action.fillsColumn, design.action.fillsColumn, context)

            // Which leaves exactly two numbers that moved, and one of them is derived.
            XCTAssertEqual(narrow.width, 480, context)
            XCTAssertEqual(
                narrow.lane.textWidth,
                480 - design.lane.slotWidth - design.lane.gap,
                context
            )
            // The block's height is made of leadings and margins, none of which is the
            // column's, so a given wrap costs the same at 480 as it does on the board.
            XCTAssertEqual(
                narrow.height(stepLines: [1, 1, 1, 1], outcomeLines: [1, 1, 1]),
                design.height(stepLines: [1, 1, 1, 1], outcomeLines: [1, 1, 1]),
                context
            )
        }
    }

    /// And the design's own two answer exactly what they answered before, which is what keeps
    /// every published number in this file measuring the boards rather than measuring the
    /// function that now produces them.
    func testTheBoardsOwnColumnsAreUnchangedByTheParameter() {
        XCTAssertEqual(SessionPlanMetrics.for(.panel, width: DS.Container.panelContent), .panel)
        XCTAssertEqual(SessionPlanMetrics.for(.fullScreen, width: DS.Container.column), .fullScreen)
        XCTAssertEqual(SessionPlanMetrics.for(.panel), .panel)
        XCTAssertEqual(SessionPlanMetrics.for(.fullScreen), .fullScreen)

        XCTAssertEqual(PlanLaneMetrics.for(.panel, width: DS.Container.panelContent), .panel)
        XCTAssertEqual(PlanLaneMetrics.for(.fullScreen, width: DS.Container.column), .fullScreen)
        XCTAssertEqual(PrimaryButtonMetrics.for(.panel, width: DS.Container.panelContent), .panel)
        XCTAssertEqual(PrimaryButtonMetrics.for(.fullScreen, width: DS.Container.column), .fullScreen)

        // 644 is the portrait iPad's reading column: 604 of lane text where the board measured
        // 700, and a plan block 96 points narrower than the one that was drawn.
        let portrait = SessionPlanMetrics.for(.fullScreen, width: 644)
        XCTAssertEqual(portrait.width, 644)
        XCTAssertEqual(portrait.lane.textWidth, 604)
        XCTAssertEqual(portrait.width, SessionPlanMetrics.fullScreen.width - 96)
    }

    /// Nothing here is a column the app can reach — they are the columns a bug reaches. The
    /// requirement is only that the plan hands `.frame` a number it can draw.
    func testThePlanProducesNoNegativeFrameAtAnImpossibleColumn() {
        for width in [CGFloat(0), 1, 36, -400] {
            for scale in ChatScale.allCases {
                let plan = SessionPlanMetrics.for(scale, width: width)
                let context = "\(scale.rawValue) at \(width)"

                XCTAssertGreaterThanOrEqual(plan.width, 0, context)
                XCTAssertGreaterThanOrEqual(plan.lane.width, 0, context)
                XCTAssertGreaterThanOrEqual(plan.lane.textWidth, 0, context)
                XCTAssertGreaterThanOrEqual(plan.action.columnWidth, 0, context)
                XCTAssertGreaterThanOrEqual(plan.action.frameWidth ?? 0, 0, context)
                XCTAssertGreaterThan(plan.height(stepLines: [1], outcomeLines: [1]), 0, context)
            }
        }
    }

    // MARK: - The screens these are checked on

    /// One screen board 10 has to lay itself out on, as the layout model computes it — taken
    /// from `ScreenLayout` rather than re-derived, so a metric checked here is checked against
    /// the app's own arithmetic and not against a second copy of it living in a test.
    private struct Device {
        let name: String
        let layout: ScreenLayout
    }

    /// The column a scale is actually laid out in on a given screen: the panel's derived
    /// content width, or the reading column. Taken from the app's own arithmetic rather than a
    /// second copy of it living in a test, for the reason `Device` is — a metric checked
    /// against a private re-derivation is only ever proved to agree with the test.
    private static func column(_ scale: ChatScale, on layout: ScreenLayout) -> CGFloat {
        switch scale {
        case .panel: TutorPanelMetrics.contentWidth(for: layout.panelWidth)
        case .fullScreen: layout.columnWidth
        }
    }

    /// The reference board, then the widest and narrowest iPads in both orientations: the two
    /// ends of the range, where the band starts highest and lowest.
    private static let devices: [Device] = [
        Device(name: "reference (design board)", layout: .reference),
        Device(
            name: "iPad Pro 13\" landscape",
            layout: ScreenLayout(
                size: CGSize(width: 1376, height: 1032),
                safeArea: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0)
            )
        ),
        Device(
            name: "iPad Pro 13\" portrait",
            layout: ScreenLayout(
                size: CGSize(width: 1032, height: 1376),
                safeArea: EdgeInsets(top: 24, leading: 0, bottom: 20, trailing: 0)
            )
        ),
        Device(
            name: "iPad 9.7\" landscape",
            layout: ScreenLayout(
                size: CGSize(width: 1024, height: 768),
                safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
            )
        ),
        Device(
            name: "iPad 9.7\" portrait",
            layout: ScreenLayout(
                size: CGSize(width: 768, height: 1024),
                safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
            )
        ),
    ]
}
