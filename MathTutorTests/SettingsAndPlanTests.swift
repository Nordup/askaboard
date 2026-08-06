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
    // MARK: - Board 10 · region map

    func testSettingsColumnIsTheFullScreenReadingColumn() {
        // Board 10 reuses board 07's centring rule: 68 + (1376 − 68 − 740) ÷ 2.
        let settings = SettingsScreenMetrics.reference
        XCTAssertEqual(settings.columnX, 352)
        XCTAssertEqual(settings.columnWidth, 740)
        XCTAssertEqual(
            settings.columnX,
            ScreenLayout.peekWidth + (ScreenLayout.screenWidth - ScreenLayout.peekWidth - 740) / 2
        )

        // And it is board 07's column rather than a second copy of it, at every screen —
        // which is the whole claim "board 07's shell with its reading content replaced" makes.
        for device in Self.devices {
            let here = SettingsScreenMetrics(layout: device.layout)
            XCTAssertEqual(here.columnX, device.layout.columnX, device.name)
            XCTAssertEqual(here.columnWidth, device.layout.columnWidth, device.name)
            XCTAssertEqual(here.contentTop, device.layout.contentTop, device.name)
            XCTAssertEqual(here.contentHeight, device.layout.contentHeight, device.name)
        }
    }

    func testSettingsGroundIsWhiteNotTheScreenGrey() {
        // "#FFFFFF — literal, *not* var(--color-surface-screen). Same exception board 07 takes."
        XCTAssertEqual(SettingsScreenMetrics.ground, DS.Color.surface)
        XCTAssertNotEqual(SettingsScreenMetrics.ground, DS.Color.surfaceScreen)
    }

    func testSettingsBlocksLandWhereTheBoardMeasuresThem() {
        let settings = SettingsScreenMetrics.reference
        XCTAssertEqual(settings.titleY, 124)
        XCTAssertEqual(settings.modelSectionY, 220)
        XCTAssertEqual(settings.effortSectionY, 392)
        XCTAssertEqual(settings.keySectionY, 670)
        XCTAssertEqual(settings.irreversibleSectionY, 850)
    }

    /// The chain is the board's; only where it starts is the device's.
    ///
    /// Board 10's five numbers are `contentTop` plus a fixed run of gaps and block heights, so
    /// on a screen whose band starts 16 points higher every one of them moves 16 points and the
    /// distances between them do not move at all. That is the difference between a layout that
    /// was ported and one that was transcribed.
    func testSettingsBlocksTravelWithTheBandAndKeepTheirRhythm() {
        let reference = SettingsScreenMetrics.reference
        for device in Self.devices {
            let here = SettingsScreenMetrics(layout: device.layout)
            let shift = device.layout.contentTop - reference.contentTop
            XCTAssertEqual(here.titleY, reference.titleY + shift, device.name)
            XCTAssertEqual(here.modelSectionY, reference.modelSectionY + shift, device.name)
            XCTAssertEqual(here.effortSectionY, reference.effortSectionY + shift, device.name)
            XCTAssertEqual(here.keySectionY, reference.keySectionY + shift, device.name)
            XCTAssertEqual(here.irreversibleSectionY, reference.irreversibleSectionY + shift, device.name)
            // 962 − 68 = 894, everywhere: the column's own height is a property of the chain.
            XCTAssertEqual(here.columnHeight, reference.columnHeight, device.name)
        }
    }

    /// Where the 42pt slack runs out, which is a state board 10 never had to have an opinion
    /// about — the design's screen has room and the smallest supported iPad does not.
    ///
    /// The screen stays top-aligned and the band scrolls, so nothing moves where it fits and
    /// nothing is unreachable where it does not. What must never happen is the last section
    /// being drawn below the band with no way to get to it, which is what a negative slack in a
    /// non-scrolling column means.
    func testTheShortestSupportedBandIsTheOneThatHasToScroll() {
        let short = SettingsScreenMetrics(
            layout: ScreenLayout(
                size: CGSize(width: 1024, height: 768),
                safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
            )
        )
        XCTAssertEqual(short.columnHeight, SettingsScreenMetrics.reference.columnHeight)
        XCTAssertLessThan(short.unusedSlack, 0, "a 768pt iPad cannot hold the 894pt chain")
        XCTAssertGreaterThan(short.columnHeight, short.contentHeight)
    }

    func testSettingsSectionHeightsAreTheirOwnArithmetic() {
        XCTAssertEqual(SettingsScreenMetrics.modelSectionHeight, 124, "18 + 16 + 90")
        XCTAssertEqual(SettingsScreenMetrics.effortSectionHeight, 230, "18 + 16 + 196")
        XCTAssertEqual(SettingsScreenMetrics.keySectionHeight, 136, "18 + 4 + 18 + 16 + 80")
        XCTAssertEqual(SettingsScreenMetrics.irreversibleSectionHeight, 112, "18 + 4 + 18 + 16 + 56")
    }

    func testSettingsIsTopAlignedAndNotStretched() {
        XCTAssertEqual(SettingsScreenMetrics.reference.contentBottom, 962)
        XCTAssertEqual(SettingsScreenMetrics.reference.unusedSlack, 42)
        XCTAssertEqual(ScreenLayout.contentBottom, 1004)
    }

    func testTheLastSectionGapIsFortyFourAsMeasuredNotFortyEight() {
        // `06 §Open questions 8`: the first three gaps are 48 and the last is 44, which
        // "reads as an off-by-4 rather than a decision" — recorded as measured, not
        // corrected. If the designer settles on 48, this test is the thing that fails.
        XCTAssertEqual(SettingsScreenMetrics.sectionGap, 48)
        XCTAssertEqual(SettingsScreenMetrics.lastSectionGap, 44)
        XCTAssertNotEqual(SettingsScreenMetrics.lastSectionGap, SettingsScreenMetrics.sectionGap)
    }

    func testSettingsControlsRowIsThePanelsOwnGeometry() {
        XCTAssertEqual(SettingsScreenMetrics.controlsHeight, TutorPanelMetrics.controlsHeight)
        XCTAssertEqual(SettingsScreenMetrics.controlButton, TutorPanelMetrics.controlButton)
        XCTAssertEqual(SettingsScreenMetrics.controlTapTarget, 44, "32pt drawn, 44pt tappable")
    }

    // MARK: - select/option

    func testSelectOptionWidthIsDerivedFromTheColumn() {
        XCTAssertEqual(SelectOptionMetrics.width(inColumn: DS.Container.column), 236)
        XCTAssertEqual(SelectOptionMetrics.width(inColumn: DS.Container.column), SelectOptionMetrics.size.width)
        // "Row width 236 × 3 + 16 × 2 = 740 exactly."
        XCTAssertEqual(
            SelectOptionMetrics.size.width * 3 + SelectOptionMetrics.gap * 2,
            DS.Container.column
        )
    }

    func testSelectOptionHeightIsWhatItsChildStackNeeds() {
        // 20 + 24 + 4 + 22 + 20 = 90
        XCTAssertEqual(SelectOptionMetrics.stackedHeight, 90)
        XCTAssertEqual(SelectOptionMetrics.stackedHeight, SelectOptionMetrics.size.height)
        // 236 − 22 × 2 = 192
        XCTAssertEqual(SelectOptionMetrics.contentWidth, 192)
        // 90 × 2 + 16 = 196
        XCTAssertEqual(SelectOptionMetrics.gridHeight(rows: 2), 196)
    }

    func testSelectOptionStatesDifferOnlyInFill() {
        XCTAssertEqual(SelectOptionMetrics.fill(isSelected: false), DS.Color.surface)
        XCTAssertEqual(SelectOptionMetrics.fill(isSelected: true), DS.Color.brandTint)
        // "No border, no ring, no checkmark, no weight change, no shadow change." The type
        // and elevation are single constants precisely so there is no per-state variant to
        // drift; these assert the values the shared constants hold.
        XCTAssertEqual(SelectOptionMetrics.elevation, .control)
        XCTAssertEqual(SelectOptionMetrics.radius, DS.Radius.lg)
        XCTAssertEqual(SelectOptionMetrics.titleStyle.size, 20)
        XCTAssertEqual(SelectOptionMetrics.titleStyle.weight, .medium)
        XCTAssertEqual(SelectOptionMetrics.captionStyle.size, 17)
        XCTAssertEqual(SelectOptionMetrics.captionStyle.leading, 22)
    }

    // MARK: - btn/destructive

    func testDestructiveButtonWidthsMatchTheBoardsLabels() {
        XCTAssertEqual(DestructiveButtonMetrics.height, 56)
        XCTAssertEqual(DestructiveButtonMetrics.paddingInline, 28)
        XCTAssertEqual(DestructiveButtonMetrics.width(labelWidth: 114), 170, "Remove API key")
        XCTAssertEqual(DestructiveButtonMetrics.width(labelWidth: 127), 183, "Reset this session")
    }

    func testDestructiveButtonIsRecessedAndCarriesNoDangerColour() {
        // The whole destructive signal: bubble grey, and the only control in the product
        // with no elevation. Everything safe is lifted; this sits *in* the surface.
        XCTAssertEqual(DestructiveButtonMetrics.fill, DS.Color.surfaceBubble)
        XCTAssertNil(DestructiveButtonMetrics.elevation)
        // "NOT for destructive, warning or validation UI" — `--color-incorrect`'s own words.
        XCTAssertNotEqual(DestructiveButtonMetrics.fill, DS.Color.incorrect)
        XCTAssertNotEqual(DestructiveButtonMetrics.fill, DS.Color.penRed)
    }

    // MARK: - btn/primary

    func testPrimaryButtonPanelHeightIsTheComposersSlot() {
        XCTAssertEqual(PrimaryButtonMetrics.panel.height, 58)
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

    func testKeyFieldIsTheWideComposersBoxModel() {
        XCTAssertEqual(KeyFieldMetrics.width, 740)
        XCTAssertEqual(KeyFieldMetrics.height, 80)
        XCTAssertEqual(KeyFieldMetrics.paddingLeading, DS.Space.s8)
        XCTAssertEqual(KeyFieldMetrics.paddingTrailing, DS.Space.s3)
        XCTAssertEqual(KeyFieldMetrics.gap, 18)
        XCTAssertEqual(KeyFieldMetrics.saveButton, 56)
        // 740 − 32 − 12 − 56 − 18 = 622, the design's measured text box.
        XCTAssertEqual(KeyFieldMetrics.textWidth, 622)
        // A filled value, not a placeholder — `--text-lead` at `--color-ink`.
        XCTAssertEqual(KeyFieldMetrics.textStyle.size, 21)
        XCTAssertEqual(KeyFieldMetrics.textStyle.leading, 30)
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

    func testEffortGridIsTwoRowsOfThree() {
        let rows = SettingsOption.rows(
            SettingsOption.efforts(selected: .high),
            across: SelectOptionMetrics.columns
        )
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].map(\.title), ["None", "Low", "Medium"])
        XCTAssertEqual(rows[1].map(\.title), ["High", "X-High", "Max"])
        // Row 2's first cell is the selected one on the board.
        XCTAssertTrue(rows[1][0].isSelected)
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
        XCTAssertEqual(
            SelectOptionMetrics.fill(isSelected: options[0].isSelected),
            DS.Color.brandTint
        )
        XCTAssertEqual(
            SelectOptionMetrics.fill(isSelected: options[2].isSelected),
            DS.Color.surface
        )
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

        // The panel's height is the screen's content band — 936 on the board's own screen,
        // 692 on the shortest iPad the app runs on. Neither is the panel's own number, which
        // is why the slot is anchored to the bottom rather than measured down from the top.
        let reference = ScreenLayout.reference.contentHeight
        let shortest = ScreenLayout(
            size: CGSize(width: 1024, height: 768),
            safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
        ).contentHeight
        XCTAssertEqual(reference, 936)
        XCTAssertEqual(shortest, 692)

        XCTAssertEqual(
            PanelActionSlotMetrics.top(inPanelOfHeight: reference),
            860,
            "where boards 05 / 08 / 11 / 12 all put it"
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
        XCTAssertEqual(
            SettingsCopy.keyCaption,
            "Kept in this device's Keychain. It is sent to OpenAI and nowhere else."
        )
    }

    // MARK: - Boards 12 / 13 · the plan

    func testPanelPlanIsSixHundredAndFiveOnTheBoardsWrap() {
        // Board 12: rows 1 and 3 of Steps wrap, rows 1 and 2 of Outcomes wrap.
        XCTAssertEqual(
            SessionPlanMetrics.panel.height(stepLines: [2, 1, 2, 1], outcomeLines: [2, 2, 1]),
            605
        )
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
