import CoreGraphics
import SwiftUI
import XCTest
@testable import MathTutor

/// The conversation surface's geometry, asserted against the boards.
///
/// Everything here runs on a value type rather than on a rendered view, which is the point:
/// a number that can only be checked by measuring a `View` is a number that lives inside a
/// view body, and a number inside a view body is one nobody can diff against the design.
///
/// Since the surface became size-driven there are two kinds of assertion here, and keeping
/// them apart is the whole design. The boards' published numbers are asserted at the width
/// each board was drawn at — 301 and 740 — because that is what makes them a diff against the
/// design rather than against the code. Everything else is asserted at every column a real
/// iPad produces, and is either about a value the column must *not* move (`ChatScale`'s
/// discrete treatment) or about one it must (the row, the grid, the measures).
final class ChatComponentTests: XCTestCase {
    // MARK: - Sources

    func testASourceCardNamesItsTitleAndDomain() {
        let source = TutorSource(
            id: "w",
            title: "Radical equations: roots and domains",
            url: "https://math.example.org/radical-equations",
            snippet: "Check every candidate in the original equation."
        )

        XCTAssertEqual(source.displayDomain, "math.example.org")
        XCTAssertEqual(
            SourcesView.cardLabel(for: source),
            "Radical equations: roots and domains, math.example.org"
        )
        XCTAssertEqual(SourcesView.sectionLabel(count: 1), "1 source")
        XCTAssertEqual(SourcesView.sectionLabel(count: 3), "3 sources")
    }

    func testASourceCardOnlyOpensHTTPURLs() {
        let web = TutorSource(
            id: "w", title: "Radical equations",
            url: "https://math.example.org/radical-equations", snippet: nil
        )
        XCTAssertNotNil(web.destinationURL)

        let javascript = TutorSource(
            id: "j", title: "Not a link", url: "javascript:alert(1)", snippet: nil
        )
        XCTAssertNil(javascript.destinationURL)
    }

    func testAReloadedMessageDrawsItsStoredSources() {
        let source = TutorSource(
            id: "w", title: "Radical equations",
            url: "https://math.example.org/radical-equations", snippet: nil
        )
        var message = TutorMessage(role: .tutor, text: "Check the original equation.")
        message.sources = [source]

        let item = ChatThreadItem(message)
        XCTAssertEqual(item.message.sources, [source])
    }

    // MARK: - Greeting blocks

    func testPanelGreetingIsFiveHundredAndTwentyTwoAndEveryStepAddsUp() {
        let greeting = GreetingMetrics.panel

        XCTAssertEqual(greeting.width, 301)
        // "Title | 301 × 34 | 26 / 34 · 600"
        XCTAssertEqual(greeting.titleTopMargin, 0)
        XCTAssertEqual(greeting.titleHeight, 34)
        XCTAssertEqual(greeting.titleStyle, .title)
        // "Subtitle | 277 wide, 17 / 24, margin-top: 10" — two wrapped lines.
        XCTAssertEqual(greeting.subtitleTopMargin, 10)
        XCTAssertEqual(greeting.subtitleWidth, 277)
        XCTAssertEqual(greeting.subtitleHeight, 48)
        XCTAssertEqual(greeting.subtitleStyle, .bodyCentred)
        // "Suggestions | margin-top: 32, height 278"
        XCTAssertEqual(greeting.suggestionsTopMargin, DS.Space.s8)
        XCTAssertEqual(greeting.suggestionsHeight, 278)
        // "padding-bottom: 120 — lifts the block off the composer"
        XCTAssertEqual(greeting.bottomPadding, 120)

        // 34 + 10 + 48 + 32 + 278 + 120
        XCTAssertEqual(greeting.totalHeight, 522)
        XCTAssertNil(greeting.orbSize, "The panel's orb is a sibling above the block, not a child of it.")
    }

    func testFullScreenGreetingIsTwoHundredAndSixtyEightAndEveryStepAddsUp() {
        let greeting = GreetingMetrics.fullScreen

        XCTAssertEqual(greeting.width, 740)
        XCTAssertEqual(greeting.orbSize, CGSize(width: 150, height: 142))
        XCTAssertEqual(greeting.titleTopMargin, 34)
        XCTAssertEqual(greeting.titleHeight, 48)
        XCTAssertEqual(greeting.titleStyle, .display)
        XCTAssertEqual(greeting.subtitleTopMargin, 14)
        XCTAssertEqual(greeting.subtitleHeight, 30)
        XCTAssertEqual(greeting.subtitleStyle, .lead)
        XCTAssertNil(greeting.suggestionsTopMargin, "Screen 07 places the chip grid as its own region.")
        XCTAssertEqual(greeting.bottomPadding, 0)

        // 142 + 34 + 48 + 14 + 30
        XCTAssertEqual(greeting.totalHeight, 268)
    }

    func testTheGreetingScalesTheHeadlineHarderThanTheBody() {
        // "roughly 1.5× on display, 1.2× on body — that widening ratio is the type rule to
        // carry into any other two-width component." A single multiplier cannot do both.
        let panel = GreetingMetrics.panel
        let full = GreetingMetrics.fullScreen

        XCTAssertEqual(full.titleStyle.size / panel.titleStyle.size, 40 / 26, accuracy: 0.001)
        XCTAssertEqual(full.subtitleStyle.size / panel.subtitleStyle.size, 21 / 17, accuracy: 0.001)
    }

    // MARK: - The attachment stack

    func testComposerCardFollowsTheDerivedLaw() {
        let stack = AttachmentStackMetrics.composer(.panel)

        XCTAssertEqual(stack.width, 301)
        XCTAssertEqual(stack.bodyHeight, 50)
        // A capsule's effective radius is half its height: 50 ÷ 2. Every number below moved
        // with the pill when it came down 58 → 50; the card's own 38pt band did not.
        XCTAssertEqual(stack.bodyTopRadius, 25)
        // cardHeight = visibleBand + radiusOfShapeOnTop → 38 + 25.
        XCTAssertEqual(stack.derivedCardHeight, 63)
        XCTAssertEqual(stack.cardHeight, 63)
        XCTAssertTrue(stack.followsDerivedLaw)

        XCTAssertEqual(stack.visibleBand, 38)
        XCTAssertEqual(stack.overlap, 25)
        XCTAssertEqual(stack.totalHeight, 88)
        // At 301 wide with a 25 radius, that straight run is 301 − 2 × 25 = 251pt.
        XCTAssertEqual(stack.straightTopRun, 251)
        // 301 − 20 − 16, "fills the card's visible band exactly".
        XCTAssertEqual(stack.labelRowWidth, 265)
    }

    func testSentSelectionKeepsTheMeasuredSixtySevenAndBreaksTheLaw() {
        let stack = AttachmentStackMetrics.sentMessage

        XCTAssertEqual(stack.width, 224)
        XCTAssertEqual(stack.bodyHeight, 58)
        XCTAssertEqual(stack.bodyTopRadius, DS.Radius.bubble)
        XCTAssertEqual(stack.visibleBand, 38)
        XCTAssertEqual(stack.cardHeight, 67)
        XCTAssertEqual(stack.overlap, 29)
        XCTAssertEqual(stack.totalHeight, 96)
        XCTAssertEqual(stack.labelRowWidth, 188)

        // The law gives 38 + 18 = 56; the file has 67, inherited from the composer copy.
        // Visually safe — 67 > 56 covers the bubble's corner curves — but 11pt is hidden
        // for nothing. Both numbers stay reachable so whichever the designer settles on is
        // a one-line change.
        XCTAssertEqual(stack.derivedCardHeight, 56)
        XCTAssertFalse(stack.followsDerivedLaw)
        XCTAssertEqual(stack.cardHeight - stack.derivedCardHeight, 11)
    }

    func testEveryCardExtendsPastTheCurvesOfTheShapeOnTop() {
        // The failure the Wrong diagram draws: a card that stops at the visible band leaves
        // the corner curves uncovered and the background bites into them.
        let cards: [AttachmentStackMetrics] = [
            .composer(.panel),
            .composer(.fullScreen),
            .composerChips(.panel, width: DS.Container.panelContent),
            .composerChips(.fullScreen, width: DS.Container.column),
            .sentMessage,
            .sentChips(in: DS.Container.panelContent),
            // `sentChipsAlone` is deliberately absent and must stay absent: it is the one
            // instance with *no shape on top*, so there are no curves for it to extend
            // past and its card is exactly its visible band. See
            // `testTheSentChipsCardHasNothingHiddenAndNothingReserved`.
        ]
        for stack in cards {
            XCTAssertGreaterThanOrEqual(stack.cardHeight, stack.derivedCardHeight)
            XCTAssertLessThan(stack.straightTopRun, stack.width)
        }
    }

    func testFullScreenCardIsTheBoardsOwnExtrapolation() {
        // Board 03 §11.12: no full-screen card exists, and "the capsule radius (80 ÷ 2 = 40,
        // implying a 40pt overlap and 40pt top radii by the derived law) are all unverified
        // extrapolations". The law, applied — not a new number.
        let stack = AttachmentStackMetrics.composer(.fullScreen)

        XCTAssertEqual(stack.width, 740)
        XCTAssertEqual(stack.bodyHeight, 68)
        XCTAssertEqual(stack.bodyTopRadius, 34)
        // 52 + 34. The wide band is 52, not the panel's 38 — see `CardStyle.fullScreen`.
        XCTAssertEqual(stack.cardHeight, 86)
        XCTAssertTrue(stack.followsDerivedLaw)
        // "band + pill goes 88 → 120, the same 1.36" the pill itself stepped by.
        XCTAssertEqual(stack.totalHeight, 120)
    }

    // MARK: - Thread rhythm

    /// Screen 08's thread, child by child: `msg/tutor`, `msg/student`, … and `btn/orb` last.
    private static let threadChildHeights: [CGFloat] = [50, 49, 50, 49, 50, 74, 75, 96, 50, 46]
    private static let threadAuthors: [MessageRole?] = [
        .tutor, .learner, .tutor, .learner, .tutor, .learner, .tutor, .learner, .tutor, nil,
    ]

    func testTheGapIsTwentyTwoBetweenEveryPairRegardlessOfAuthor() {
        let thread = ThreadMetrics.panel
        let offsets = thread.offsets(childHeights: Self.threadChildHeights, in: 810)

        XCTAssertEqual(thread.gap, 22)
        XCTAssertEqual(thread.gap, DS.Space.messageGap)

        for index in 0 ..< offsets.count - 1 {
            let gap = offsets[index + 1] - (offsets[index] + Self.threadChildHeights[index])
            XCTAssertEqual(
                gap,
                22,
                "\(String(describing: Self.threadAuthors[index])) → "
                    + "\(String(describing: Self.threadAuthors[index + 1])) should be 22 like every other pair."
            )
        }

        // Not one same-author run is tighter, and the orb participates in the rhythm.
        XCTAssertEqual(Set(Self.threadAuthors.compactMap { $0 }).count, 2)
        XCTAssertNil(Self.threadAuthors.last!, "btn/orb is a normal flow child at the end of the list.")
    }

    func testTheThreadIsBottomAnchoredAndSlackLandsOnTop() {
        let thread = ThreadMetrics.panel

        // Items sum 589 + nine 22pt gaps 198 = 787; + 18 bottom padding + the 80pt top-fade
        // band above the first message = 885.
        XCTAssertEqual(Self.threadChildHeights.reduce(0, +), 589)
        XCTAssertEqual(thread.bottomPadding, 18)
        XCTAssertEqual(thread.topPadding, ScrollFadeMetrics.top(for: .panel).height)
        XCTAssertEqual(thread.contentHeight(childHeights: Self.threadChildHeights), 885)

        // Bottom-anchored inside the panel the boards were drawn at (936): the slack and the
        // top padding land above the first child, and every gap below is board 03's 22.
        XCTAssertEqual(
            thread.offsets(childHeights: Self.threadChildHeights, in: 936),
            [131, 203, 274, 346, 417, 489, 585, 682, 800, 872]
        )
    }

    func testAThreadTallerThanItsColumnStartsAtItsOwnTopPadding() {
        // Slack clamps at 0 rather than going negative, which would pull the first message
        // up off the top of the thread instead of letting it scroll — and the first message
        // keeps its air above, so scrolled all the way back it rests clear of the fade
        // instead of half-washed inside it.
        let thread = ThreadMetrics.panel
        let offsets = thread.offsets(childHeights: Self.threadChildHeights, in: 400)
        XCTAssertEqual(offsets.first, thread.topPadding)
    }

    func testTheFullScreenThreadTakesBoardThirteensNewSpec() {
        // "the panel-scale message spec has been carried up to the 740 column for the first
        // time" — 17/25 → 21/30, a 520 cap and 16/24 padding. Radius and gap do not scale.
        let messages = MessageMetrics.fullScreen
        let thread = ThreadMetrics.fullScreen

        XCTAssertEqual(messages.rowWidth, 740)
        XCTAssertEqual(messages.textStyle, .lead)
        XCTAssertEqual(messages.textStyle.size, 21)
        XCTAssertEqual(messages.textStyle.leading, 30)
        XCTAssertEqual(messages.bubbleMaxWidth, 520)
        XCTAssertEqual(messages.bubblePaddingBlock, 16)
        XCTAssertEqual(messages.bubblePaddingInline, 24)
        // Measured on the board: two wrapped lines → 16 + 30 × 2 + 16 = 92.
        XCTAssertEqual(messages.bubbleHeight(lines: 2), 92)

        XCTAssertEqual(messages.bubbleRadius, MessageMetrics.panel.bubbleRadius)
        XCTAssertEqual(thread.gap, ThreadMetrics.panel.gap)
        // `Thread · wide` carries no padding; the panel's 18 is there to clear its inset.
        XCTAssertEqual(thread.bottomPadding, 0)
        // No fade over this thread's head, so the air above the first message is the content
        // band's own 28 rather than the panel's 80pt fade band.
        XCTAssertEqual(thread.topPadding, DS.Space.edge)
    }

    // MARK: - Failure & recovery

    func testTheNetworkErrorStackIsOneFiftyOne() {
        let error = ChatErrorMetrics.panel

        // "A failure is a tutor message, not a system alert: same 17/25 text."
        XCTAssertEqual(error.messageStyle, .body)
        XCTAssertEqual(error.chipTopMargin, 16)
        XCTAssertEqual(error.reassuranceTopMargin, 12)
        XCTAssertEqual(error.reassuranceStyle.size, 15)
        XCTAssertEqual(error.reassuranceStyle.leading, 18)

        // The recovery chip is the suggestion chip reused unchanged — every box-model value.
        XCTAssertEqual(error.chip, SuggestionChipMetrics.panel)

        // 25 + 16 + 62 + 12 + 36, the specimen the board measures.
        XCTAssertEqual(error.height(messageLines: 1, reassuranceLines: 2), 151)
    }

    /// Board 14's stack was measured in the panel and drawn nowhere else, and it was still
    /// 301 wide inside a 740 thread — a failure told in a column the thread does not have.
    ///
    /// *"A failure is a tutor message, not a system alert: same 17/25 text, same left edge"* —
    /// **same as the messages around it** is the specification, so the copy takes the thread's
    /// own text style at that scale and the stack takes the thread's own row.
    func testTheFailureIsToldInTheThreadsOwnColumn() {
        XCTAssertEqual(ChatErrorMetrics.for(.panel, width: DS.Container.panelContent), .panel)

        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let error = ChatErrorMetrics.for(scale, width: width)
                let context = "\(scale.rawValue) at \(column.name) · \(width)"

                XCTAssertEqual(error.width, width, context)
                XCTAssertEqual(error.messageStyle, MessageMetrics.for(scale, width: width).textStyle, context)
                XCTAssertEqual(error.chip, SuggestionChipMetrics.for(scale, width: width), context)
                XCTAssertLessThanOrEqual(error.chip.width, width, context)
                // The two margins and the reassurance line are stated once by the board and
                // have no second value anywhere, so they do not step with the scale.
                XCTAssertEqual(error.chipTopMargin, ChatErrorMetrics.panel.chipTopMargin, context)
                XCTAssertEqual(error.reassuranceTopMargin, ChatErrorMetrics.panel.reassuranceTopMargin, context)
                XCTAssertEqual(error.reassuranceStyle, ChatErrorMetrics.panel.reassuranceStyle, context)
            }
        }

        // 17/25 in the panel and 21/30 in the reading column, which is board 13's step and not
        // a new one invented here.
        XCTAssertEqual(ChatErrorMetrics.for(.fullScreen, width: DS.Container.column).messageStyle, .lead)
    }

    func testTheRecoveryCopyAndGlyphAreTheBoards() {
        XCTAssertEqual(ChatErrorState.networkMessage, "I couldn't reach the tutor service just now.")
        XCTAssertEqual(ChatErrorState.networkAction, "Try again")
        XCTAssertEqual(
            ChatErrorState.networkReassurance,
            "Nothing was lost — what you wrote is still in the composer."
        )
        XCTAssertEqual(ChatErrorState.network(onRetry: {}).actionIcon, .uiRetry)
        // "recovery chips take var(--color-icon), not var(--color-brand), because a repair
        // is not a suggestion."
        XCTAssertEqual(Icon.uiRetry.glyph.colorToken, "--color-icon")
    }

    func testTheThinkingIndicatorFitsOneBodyLineBox() {
        // "The 25 pt height is the whole idea: the indicator occupies exactly one
        // --leading-body line box, so replacing it with the first line of the reply causes
        // zero layout shift."
        XCTAssertEqual(ThinkingIndicator.dotSize, 6)
        XCTAssertEqual(ThinkingIndicator.dimmedOpacity, 0.35)
        XCTAssertEqual(ThinkingIndicator.cycle, 1.2)
        XCTAssertEqual(ThinkingIndicator.stagger, 0.16)
        // Width 6 × 3 + 8 × 2 = 34, on a 25pt row.
        XCTAssertEqual(3 * ThinkingIndicator.dotSize + 2 * DS.Space.s2, 34)
        XCTAssertEqual(DS.Leading.body, 25)
    }

    func testTheStreamingCaretIsAStepNotAFade() {
        // "2 × 22 · radius-full · var(--color-ink)", where 22 = --leading-control
        // "optically centred in the 25 line box".
        XCTAssertEqual(StreamingCaret.width, 2)
        XCTAssertEqual(DS.Leading.control, 22)
        XCTAssertEqual(StreamingCaret.cycle, 1.06)

        // On for half the cycle, off for the other half — a square wave, not a ramp.
        let start = Date(timeIntervalSinceReferenceDate: 0)
        XCTAssertTrue(StreamingCaret.isVisible(at: start))
        XCTAssertFalse(StreamingCaret.isVisible(at: start.addingTimeInterval(0.6)))
        XCTAssertTrue(StreamingCaret.isVisible(at: start.addingTimeInterval(1.1)))
    }

    // MARK: - Activity trail

    /// Board 14 §04: "Under a minute the label drops the minutes entirely — `Worked for 8s`,
    /// never `Worked for 0m 8s`." Asserted on the model rather than the rendered row, matching
    /// this file's own rule: a number only a rendered `View` can check is a number nobody can
    /// diff against the design.
    func testAFinishedTrailReportsItsDuration() {
        var trail = ActivityTrail()
        trail.appendReasoning("Checking the domain")
        trail.duration = 75
        XCTAssertEqual(ActivityTrailView.summaryLabel(for: trail), "Worked for 1m 15s")
    }

    func testASubMinuteTrailOmitsTheMinutes() {
        var trail = ActivityTrail()
        trail.duration = 8
        XCTAssertEqual(ActivityTrailView.summaryLabel(for: trail), "Worked for 8s")
    }

    /// `duration` stays `nil` for a turn that failed or is still running — `ActivityTrail`'s
    /// own doc comment: "a trail with no duration is what tells the view to say nothing rather
    /// than report a time it never measured."
    func testAnUnfinishedTrailHasNoSummary() {
        var trail = ActivityTrail()
        trail.appendReasoning("Checking")
        XCTAssertNil(ActivityTrailView.summaryLabel(for: trail))
    }

    func testAnEmptyTrailDrawsNothing() {
        XCTAssertTrue(ActivityTrail().isEmpty)
    }

    // MARK: - Bubbles

    func testBubbleHeightIsTwelvePlusTwentyFivePerLinePlusTwelve() {
        let messages = MessageMetrics.panel

        XCTAssertEqual(messages.bubbleHeight(lines: 1), 49)
        XCTAssertEqual(messages.bubbleHeight(lines: 2), 74)
        XCTAssertEqual(messages.bubbleMaxWidth, 224)
        XCTAssertEqual(messages.bubbleRadius, DS.Radius.bubble)
        // "Note the 22 line-height, not the 25 used by every other message."
        XCTAssertEqual(messages.textStyle.leading, 25)
        XCTAssertEqual(messages.selectionTextStyle.leading, 22)
        XCTAssertEqual(messages.selectionTextStyle.size, messages.textStyle.size)
    }

    // MARK: - Composer

    /// **The pill came down a step**, and this test came down with it. Everything in the row
    /// stepped in proportion — paddings, gap and both button boxes — with the one documented
    /// exception that the *glyphs* did not: `composer/send` still renders at 22 and
    /// `composer/voice` at 20, because those are the sizes `design/icons.json` publishes and
    /// scaling a box is a layout change while inventing a 19 is a new render size.
    func testPanelComposerMeasuresThreeHundredAndOneByFifty() {
        let composer = ComposerMetrics.panel

        XCTAssertEqual(composer.width, 301)
        XCTAssertEqual(composer.height, 50)
        XCTAssertEqual(composer.paddingLeading, 18)
        XCTAssertEqual(composer.paddingTrailing, 6)
        XCTAssertEqual(composer.gap, 10)
        XCTAssertEqual(composer.marqueeSize, 24)
        XCTAssertEqual(composer.voiceButtonSize, 34)
        XCTAssertEqual(composer.sendButtonSize, 38)
        XCTAssertEqual(composer.sendGlyphSize, 22, "the glyph did not step with its box")
        XCTAssertEqual(composer.placeholder, "Ask anything...")
        XCTAssertEqual(composer.placeholderStyle, .bodyControl)
        XCTAssertFalse(composer.sendIsRaised, "The panel send button carries no shadow.")

        // 301 − 18 − 24 − 10 − 151 − 10 − 34 − 10 − 38 − 6 = 0. The row closing exactly is
        // what proves the paddings and the gap are right.
        XCTAssertEqual(composer.placeholderWidth(includingMarquee: true), 151)
        // With a selection attached the composer grows the card: 38 visible + 50 pill.
        XCTAssertEqual(composer.height(showing: .label), 88)
        // And with files it grows the *other* card, which is 14 points taller: a chip
        // carrying a 32pt thumbnail does not go into a 38pt band, so the band is 52.
        XCTAssertEqual(composer.height(showing: .chips), 102)
        XCTAssertEqual(composer.height(showing: .none), 50)
    }

    func testFullScreenComposerMeasuresSevenHundredAndFortyBySixtyEight() {
        let composer = ComposerMetrics.fullScreen

        XCTAssertEqual(composer.width, 740)
        XCTAssertEqual(composer.height, 68)
        XCTAssertEqual(composer.paddingLeading, DS.Space.s7)
        XCTAssertEqual(composer.paddingTrailing, DS.Space.s2)
        XCTAssertEqual(composer.gap, DS.Space.s4)
        XCTAssertEqual(composer.voiceButtonSize, 46)
        XCTAssertEqual(composer.voiceGlyphSize, 26, "the glyph did not step with its box")
        XCTAssertEqual(composer.sendButtonSize, 52)
        XCTAssertEqual(composer.sendGlyphSize, 26, "the glyph did not step with its box")
        XCTAssertEqual(composer.placeholder, "Ask me anything...")
        XCTAssertTrue(composer.sendIsRaised, "The full-screen send button is the one that carries a shadow.")

        // 740 − 28 − 574 − 16 − 46 − 16 − 52 − 8 = 0, the same subtraction at the wide scale.
        XCTAssertEqual(composer.placeholderWidth(includingMarquee: false), 574)
    }

    /// The bug the composer had: `--container-column` is 740 and the reading column is not.
    ///
    /// `ScreenLayout.columnWidth` is `min(740, region − 2 × edge)`, so a portrait iPad gives
    /// 644 — and a 740pt pill in a 644pt column hangs 96 points off the end of it. The width is
    /// the column's; every other number is the scale's and does not move.
    func testTheComposerIsTheColumnItIsLaidOutInAndTheRowStillCloses() {
        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let composer = ComposerMetrics.for(scale, width: width)
                let context = "\(scale.rawValue) at \(column.name) · \(width)"

                XCTAssertEqual(composer.width, width, context)
                // The card behind an attached selection is edge-to-edge with the pill, so it
                // narrows with it — a 740 card behind a 644 pill is the notch rule broken.
                XCTAssertEqual(composer.attachment.width, width, context)

                // The row closes on whatever the column is: the text lane is the only child
                // with give in it, which is what `flex-grow: 1` says about it on board 07.
                let marquee = scale == .panel
                let children = (marquee ? composer.marqueeSize : 0)
                    + composer.voiceButtonSize + composer.sendButtonSize
                let gaps = composer.gap * CGFloat(marquee ? 3 : 2)
                XCTAssertEqual(
                    composer.placeholderWidth(includingMarquee: marquee)
                        + composer.paddingLeading + composer.paddingTrailing + children + gaps,
                    width,
                    accuracy: 0.001,
                    context
                )
            }
        }

        // The design's own two are unchanged, which is what keeps every published number above
        // measuring the board rather than measuring this function.
        XCTAssertEqual(ComposerMetrics.for(.panel, width: DS.Container.panelContent), .panel)
        XCTAssertEqual(ComposerMetrics.for(.fullScreen, width: DS.Container.column), .fullScreen)
        // 740 − 28 − 8 − 46 − 52 − 2 × 16 = 574 at the design's column; 478 at a 644 one.
        XCTAssertEqual(
            ComposerMetrics.for(.fullScreen, width: 644).placeholderWidth(includingMarquee: false),
            478
        )
    }

    func testBothScalesOfferVoiceAndTheMarqueeAtTheSizesTheDesignDraws() {
        // The two asymmetries board 03 calls unresolved: "do not copy the current asymmetry
        // into code as if it were intentional." Both controls exist at both scales, and
        // neither size is invented — 38/52 for voice come off screens 05 and 07, and the
        // marquee keeps its one documented render size.
        XCTAssertEqual(ComposerMetrics.panel.voiceGlyphSize, 20)
        XCTAssertEqual(ComposerMetrics.fullScreen.voiceGlyphSize, 26)
        XCTAssertEqual(Icon.composerVoice.glyph.productRenderSizes, [20, 26])

        XCTAssertEqual(ComposerMetrics.panel.marqueeSize, Icon.uiSelectionMarker.renderSize)
        XCTAssertEqual(ComposerMetrics.fullScreen.marqueeSize, Icon.uiSelectionMarker.renderSize)
        XCTAssertEqual(Icon.uiSelectionMarker.glyph.productRenderSizes, [24])
    }

    /// The resting height is not a number the row is squeezed into — it *is* the row.
    ///
    /// Which is the whole mechanism by which the pill can grow with what is typed into it: the
    /// tallest child plus the vertical padding twice. Both scales close on the design's own
    /// height from their own send button, `38 + 2 × 6 = 50` and `52 + 2 × 8 = 68`, and that
    /// padding coming out equal to `paddingTrailing` at both scales is the check that the send
    /// button is inset uniformly from the pill's edge rather than only from its end.
    func testTheRestingPillIsItsSendButtonPlusUniformPadding() {
        for scale in ChatScale.allCases {
            let composer = ComposerMetrics.for(scale)
            let context = scale.rawValue

            XCTAssertEqual(composer.paddingVertical, composer.paddingTrailing, context)
            XCTAssertEqual(composer.sendButtonSize + 2 * composer.paddingVertical, composer.height, context)
            // The box every fixed child of the row keeps, so one line of text and the three
            // glyphs stay centred exactly where the design centres them.
            XCTAssertEqual(composer.innerHeight, composer.sendButtonSize, context)
            // The dictation cancel borrows the marquee's slot, and its 44pt target overhangs
            // that slot rather than sizing it — a target taller than the interior would make
            // the pill grow for as long as the microphone was open.
            XCTAssertLessThanOrEqual(composer.marqueeSize, composer.innerHeight, context)
        }

        XCTAssertEqual(ComposerMetrics.panel.paddingVertical, 6)
        XCTAssertEqual(ComposerMetrics.fullScreen.paddingVertical, DS.Space.s2)
    }

    /// **Not from the design** — board 03 §11.11 draws the empty pill and nothing else. Five
    /// wrapped lines at either scale, and then the text scrolls inside a pill that holds still.
    func testTheComposerGrowsToFiveLinesAndStops() {
        XCTAssertEqual(ComposerMetrics.maxLines, 5)

        for scale in ChatScale.allCases {
            let composer = ComposerMetrics.for(scale)
            let context = scale.rawValue

            // Five lines in the same interior every other state uses — a `max`, not a sum: the
            // pill does not move at all until the text outgrows the send button.
            XCTAssertEqual(
                composer.maxHeight,
                max(composer.innerHeight, composer.placeholderStyle.height(lines: 5))
                    + 2 * composer.paddingVertical,
                accuracy: 0.001,
                context
            )
            XCTAssertGreaterThan(composer.maxHeight, composer.height, context)
            // A shallow slice of its own surface either way, against the 976pt safe band the
            // design draws both surfaces in.
            XCTAssertLessThan(composer.maxHeight, 200, context)
        }

        // Hand-computed at Source Sans 3's 1.326em, the same way the type tests do it.
        // The panel: five 22.54pt boxes with no spacing between them — `bodyControl` asks for
        // a 22pt line box the face draws taller, and SwiftUI cannot compress a line — plus
        // 2 × 6. 112.71 + 12.
        XCTAssertEqual(ComposerMetrics.panel.maxHeight, 5 * 17 * 1.326 + 12, accuracy: 0.05)
        // The reading column: five 27.85pt boxes and the four 2.15pt gaps that make `lead`'s
        // 30pt line box, plus 2 × 8. 147.85 + 16.
        let leadBox: CGFloat = 21 * 1.326
        let leadSpacing: CGFloat = 30 - leadBox
        XCTAssertEqual(
            ComposerMetrics.fullScreen.maxHeight,
            5 * leadBox + 4 * leadSpacing + 16,
            accuracy: 0.05
        )

        // One line of either style still fits the interior with room to spare, which is why
        // the first line costs nothing and the resting pill is the design's to the point.
        for scale in ChatScale.allCases {
            let composer = ComposerMetrics.for(scale)
            XCTAssertLessThan(
                composer.placeholderStyle.height(lines: 1),
                composer.innerHeight,
                scale.rawValue
            )
        }
    }

    /// Board 03's radius formula is half the height — evaluated at the **resting** height and
    /// held there, because a capsule re-derived from a five-line pill is a 70pt stadium, and
    /// the card behind an attached selection is cut to this exact curve.
    func testTheGrownPillKeepsTheRestingCapsulesRadius() {
        XCTAssertEqual(ComposerMetrics.panel.cornerRadius, 25)
        XCTAssertEqual(ComposerMetrics.fullScreen.cornerRadius, 34)

        for scale in ChatScale.allCases {
            let composer = ComposerMetrics.for(scale)
            XCTAssertEqual(composer.cornerRadius, composer.height / 2, scale.rawValue)
            XCTAssertEqual(composer.attachment.bodyTopRadius, composer.cornerRadius, scale.rawValue)
            // The stack's resting geometry is untouched by any of this: the pill grows out of
            // its top, so `totalHeight` is still the band plus the pill the design draws.
            XCTAssertEqual(
                composer.height(showing: .label),
                composer.attachment.visibleBand + composer.height,
                scale.rawValue
            )
            // The same law for the taller card, against its own band — which is the
            // property a single "attached" height could not state.
            XCTAssertEqual(
                composer.height(showing: .chips),
                composer.attachment(showing: .chips).visibleBand + composer.height,
                scale.rawValue
            )
        }
    }

    func testPanelRowClosesExactlyWithThePlus() {
        // 301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0
        let composer = ComposerMetrics.panel
        XCTAssertEqual(composer.plusSize, 20)
        XCTAssertEqual(composer.placeholderWidth(includingPlus: true, includingMarquee: true), 121)
    }

    func testFullScreenRowClosesExactlyWithThePlus() {
        // No marquee full-screen — the wide composer has never had one, because
        // full-screen hides the board there would be to lasso from. `TutorFullScreen`
        // passes `.unavailable` and no toggle handler, and board 03 says the glyph's
        // presence is a property of whether there is a board to lasso, not of scale.
        let composer = ComposerMetrics.fullScreen
        XCTAssertEqual(composer.plusSize, 20)
        XCTAssertEqual(composer.placeholderWidth(includingPlus: true, includingMarquee: false), 538)
    }

    func testThePlusKeepsItsOnePublishedRenderSizeAtBothScales() {
        // `ui/plus` publishes exactly one render size. Stepping it to 24 to match
        // the marquee would add a size to a documented icon set to tidy an
        // alignment — the thing the composer's own doc comment warns against.
        XCTAssertEqual(ComposerMetrics.panel.plusSize, Icon.uiPlus.renderSize)
        XCTAssertEqual(ComposerMetrics.fullScreen.plusSize, Icon.uiPlus.renderSize)
    }

    func testPlaceholderWidthWithoutThePlusIsUnchanged() {
        // Every existing caller and specimen passes no plus, and must get exactly
        // what it got before.
        XCTAssertEqual(ComposerMetrics.panel.placeholderWidth(includingMarquee: true), 151)
        XCTAssertEqual(ComposerMetrics.fullScreen.placeholderWidth(includingMarquee: false), 574)
    }

    func testTheRowClosesAtEveryColumnWidthWithThePlus() {
        // Both marquee states, because the two surfaces differ: the panel draws it
        // and the full-screen column does not.
        for scale in [ChatScale.panel, .fullScreen] {
            for width in [CGFloat(301), 337, 644, 740] {
                for marquee in [true, false] {
                    let composer = ComposerMetrics.for(scale, width: width)
                    let children = composer.plusSize + (marquee ? composer.marqueeSize : 0)
                        + composer.voiceButtonSize + composer.sendButtonSize
                    let gaps = composer.gap * CGFloat(marquee ? 4 : 3)
                    XCTAssertEqual(
                        composer.placeholderWidth(includingPlus: true, includingMarquee: marquee),
                        width - composer.paddingLeading - composer.paddingTrailing - children - gaps,
                        "\(scale) at \(width), marquee: \(marquee)"
                    )
                }
            }
        }
    }

    // MARK: - Suggestion chips

    func testPanelChipsAreThreeHundredAndOneBySixtyTwoInATwoHundredAndSeventyEightColumn() {
        let chip = SuggestionChipMetrics.panel

        XCTAssertEqual(chip.width, 301)
        XCTAssertEqual(chip.height, 62)
        XCTAssertEqual(chip.radius, DS.Radius.lg)
        XCTAssertEqual(chip.paddingLeading, 18)
        XCTAssertEqual(chip.gap, 14)
        XCTAssertEqual(chip.iconSize, 22)
        // "label --text-body 17 / --leading-control 22 · 500" — measured on two boards.
        XCTAssertEqual(chip.labelStyle.size, 17)
        XCTAssertEqual(chip.labelStyle.leading, 22)
        XCTAssertEqual(chip.labelStyle.weight, .medium)
        XCTAssertEqual(chip.listGap, 10)
        XCTAssertEqual(chip.columns, 1)
        XCTAssertEqual(chip.rows, 4)
        // 4 × 62 + 3 × 10
        XCTAssertEqual(chip.containerHeight, 278)
    }

    func testFullScreenChipsAreThreeHundredAndSixtyBySeventyFourInATwoByTwo() {
        let chip = SuggestionChipMetrics.fullScreen

        XCTAssertEqual(chip.width, 360)
        XCTAssertEqual(chip.height, 74)
        XCTAssertEqual(chip.paddingLeading, 22)
        XCTAssertEqual(chip.gap, 16)
        XCTAssertEqual(chip.iconSize, 24)
        XCTAssertEqual(chip.listGap, 20)
        XCTAssertEqual(chip.columns, 2)
        XCTAssertEqual(chip.rows, 2)
        // 2 × 74 + 20, and 360 × 2 + 20 = 740 exactly.
        XCTAssertEqual(chip.containerHeight, 168)
        XCTAssertEqual(2 * chip.width + chip.listGap, chip.containerWidth)

        // "the same as panel, deliberately not scaled"
        XCTAssertEqual(chip.radius, SuggestionChipMetrics.panel.radius)
    }

    func testTheFourChipsCarryTheDesignsCopyAndGlyphs() {
        XCTAssertEqual(
            Suggestion.allCases.map(\.label),
            [
                "Explain this concept",
                "Give me an example",
                "Create an exercise",
                "I don't understand this",
            ]
        )
        XCTAssertEqual(
            Suggestion.allCases.map(\.icon),
            [.chipExplain, .chipExample, .chipExercise, .chipConfused]
        )
    }

    // MARK: - Scroll fade

    /// "The two ends are no longer one curve mirrored, and that is the design." The old
    /// board drew one shared 4-stop gradient (`ScrollFadeMetrics.standard`); the current
    /// design gives the top and bottom edges their own ramp, plateau, peak and curve, so
    /// the replacement tests are split the same way rather than forced back into one.
    func testTheTopFadesRampAndPlateauAreTheBoardsTwoNumbersPerScale() {
        let panel = ScrollFadeMetrics.top(for: .panel)
        let full = ScrollFadeMetrics.top(for: .fullScreen)

        XCTAssertEqual(panel.edge, .top)
        XCTAssertEqual(panel.curve, .easeOut)
        // "Longer than a line on purpose" — 60 in the panel, 56 in the reading column.
        XCTAssertEqual(panel.ramp, 60)
        XCTAssertEqual(full.ramp, 56)
        // "solid 20 then ramp" in the panel; 8 in the reading column, which has no 18pt
        // panel inset above its controls to clear.
        XCTAssertEqual(panel.plateau, 20)
        XCTAssertEqual(full.plateau, 8)
        // The top fade always dissolves all the way to the surface colour — "gone".
        XCTAssertEqual(panel.peak, 1)
        XCTAssertEqual(full.peak, 1)
        // height = ramp + plateau: 80 in the panel, 64 in the reading column — "its whole
        // fade is 64 rather than 80" for exactly that reason.
        XCTAssertEqual(panel.height, 80)
        XCTAssertEqual(full.height, 64)
    }

    func testTheBottomFadesRampIsOneNumberBothScales() {
        // "One number, both scales, every screen."
        XCTAssertEqual(ScrollFadeMetrics.bottomRamp, 32)
        // "the single value that makes it a veil rather than a wipe."
        XCTAssertEqual(ScrollFadeMetrics.bottomPeak, 0.8)

        let fade = ScrollFadeMetrics.bottom(coveringComposer: 96)
        XCTAssertEqual(fade.edge, .bottom)
        XCTAssertEqual(fade.curve, .smoothstep)
        XCTAssertEqual(fade.ramp, 32)
        XCTAssertEqual(fade.plateau, 64, "the composer's own band, minus the 32pt ramp")
        XCTAssertEqual(fade.peak, ScrollFadeMetrics.bottomPeak)
        // "`band` is composer-top to surface-floor, and both halves of that matter" —
        // height *is* the band rather than a fraction derived from it.
        XCTAssertEqual(fade.height, 96)
    }

    func testAComposerBandShorterThanTheRampSqueezesRatherThanOverflows() {
        // "A band shorter than the ramp is squeezed rather than overflowed: the fade still
        // ends on the floor, it just has less room to get there."
        let squeezed = ScrollFadeMetrics.bottom(coveringComposer: 20)
        XCTAssertEqual(squeezed.ramp, 20)
        XCTAssertEqual(squeezed.plateau, 0)
        XCTAssertEqual(squeezed.height, 20)

        // Exactly the ramp's own length leaves no plateau at all.
        let exact = ScrollFadeMetrics.bottom(coveringComposer: 32)
        XCTAssertEqual(exact.ramp, 32)
        XCTAssertEqual(exact.plateau, 0)

        // A band that cannot exist clamps to nothing rather than handing `.frame` a
        // negative side.
        XCTAssertEqual(ScrollFadeMetrics.bottom(coveringComposer: -10).height, 0)
        XCTAssertEqual(ScrollFadeMetrics.bottom(coveringComposer: -10).ramp, 0)
    }

    func testTheTopFadeIsSolidAtTheEdgeAndGoneByTheFloor() {
        // "Solid at the surface's own top edge, dissolving downward."
        let fade = ScrollFadeMetrics.top(for: .panel)
        let opacities = fade.stops.map(\.opacity)

        XCTAssertEqual(fade.stops.first?.location, 0)
        XCTAssertEqual(fade.stops.first?.opacity, 1)
        XCTAssertEqual(fade.stops.last?.location, 1)
        XCTAssertEqual(fade.stops.last?.opacity, 0)
        // Monotonic — a ramp, not a gradient to `.clear`, which would grey-shift the middle.
        XCTAssertEqual(opacities, opacities.sorted(by: >))
    }

    func testTheBottomFadeIsTransparentAtTheTopAndHeldAtTheVeilByTheFloor() {
        // "Transparent where the thread is still fully legible, up to `peak` over the
        // ramp, and `peak` held from there to the floor."
        let fade = ScrollFadeMetrics.bottom(coveringComposer: 96)
        let opacities = fade.stops.map(\.opacity)

        XCTAssertEqual(fade.stops.first?.location, 0)
        XCTAssertEqual(fade.stops.first?.opacity, 0)
        XCTAssertEqual(fade.stops.last?.location, 1)
        XCTAssertEqual(fade.stops.last?.opacity, ScrollFadeMetrics.bottomPeak)
        XCTAssertEqual(opacities, opacities.sorted(by: <))
    }

    func testTheCurvesAreFlatWhereTheyMeetThePlateauAndClampPastTheirOwnBand() {
        // "α(s) = 1 − (1 − s)². Zero slope where it meets the plateau, slope 2 where it
        // leaves transparency." At the midpoint that is 1 − 0.5² = 0.75.
        XCTAssertEqual(ScrollFadeMetrics.Curve.easeOut.opacity(atRampFraction: 0), 0)
        XCTAssertEqual(ScrollFadeMetrics.Curve.easeOut.opacity(atRampFraction: 0.5), 0.75)
        XCTAssertEqual(ScrollFadeMetrics.Curve.easeOut.opacity(atRampFraction: 1), 1)

        // "α(s) = 3s² − 2s³. Zero slope at *both* ends." At the midpoint 3(0.5²) − 2(0.5³)
        // = 0.75 − 0.25 = 0.5 — the reason it exists as a second case rather than a shared
        // curve: `easeOut`'s onset at s = 0 is not flat.
        XCTAssertEqual(ScrollFadeMetrics.Curve.smoothstep.opacity(atRampFraction: 0), 0)
        XCTAssertEqual(ScrollFadeMetrics.Curve.smoothstep.opacity(atRampFraction: 0.5), 0.5)
        XCTAssertEqual(ScrollFadeMetrics.Curve.smoothstep.opacity(atRampFraction: 1), 1)

        // "`s` runs 0 … 1. Clamped, so a caller cannot drive a gradient past its own band."
        XCTAssertEqual(
            ScrollFadeMetrics.Curve.easeOut.opacity(atRampFraction: -5),
            ScrollFadeMetrics.Curve.easeOut.opacity(atRampFraction: 0)
        )
        XCTAssertEqual(
            ScrollFadeMetrics.Curve.smoothstep.opacity(atRampFraction: 5),
            ScrollFadeMetrics.Curve.smoothstep.opacity(atRampFraction: 1)
        )
    }

    // MARK: - The scale itself

    func testTheTwoScalesAreOneDesignAtTwoSizesAndNotOneMultiplier() {
        XCTAssertEqual(ChatScale.panel.contentWidth, DS.Container.panelContent)
        XCTAssertEqual(ChatScale.fullScreen.contentWidth, DS.Container.column)

        // No single factor produces the design's steps, which is why the scale is a lookup:
        // chip height 1.19×, chip icon 1.09×, title 1.54×, body 1.24×, chip radius 1.00×.
        let ratios: [CGFloat] = [
            SuggestionChipMetrics.fullScreen.height / SuggestionChipMetrics.panel.height,
            SuggestionChipMetrics.fullScreen.iconSize / SuggestionChipMetrics.panel.iconSize,
            GreetingMetrics.fullScreen.titleStyle.size / GreetingMetrics.panel.titleStyle.size,
            SuggestionChipMetrics.fullScreen.radius / SuggestionChipMetrics.panel.radius,
        ]
        XCTAssertEqual(Set(ratios.map { ($0 * 100).rounded() }).count, ratios.count)
    }

    // MARK: - The columns the real devices produce

    func testTheReadingColumnIsTheDesignsSevenFortyInLandscapeAndNarrowerInPortrait() {
        // Every iPad in landscape clears 740 + 2 × 28 + the 68pt peek, so the column the
        // design drew survives intact on all of them — which is why nothing above this line
        // had to change. Portrait is where `min(740, region − 2 × edge)` starts biting, and
        // it is the case this whole file exists to cover.
        XCTAssertEqual(
            Column.landscape.map(\.fullScreen),
            [740, 740, 740, 740, 740],
            "13-inch, 11-inch, Air, 10.2-inch and 9.7-inch in landscape"
        )
        XCTAssertEqual(
            Column.portrait.map(\.fullScreen),
            [740, 710, 696, 686, 644],
            "the same five in portrait: only the 13-inch still fits the full column"
        )
        // The panel is `--container-panel` at every size — board 02 calls it "the only
        // fixed-width surface in the product" — so its column never moves off 301.
        for column in Column.all {
            XCTAssertEqual(column.panel, DS.Container.panelContent, column.name)
        }
    }

    /// The one property that must hold no matter what: `ChatScale` picks the treatment and
    /// the column picks nothing but sizes and positions.
    func testTheDiscreteDesignTreatmentNeverMovesWithTheColumn() {
        for scale in ChatScale.allCases {
            let reference = Reference(scale)
            for column in Column.all {
                let width = column.width(scale)
                let here = Reference(scale, width: width)
                XCTAssertEqual(here, reference, "\(scale.rawValue) at \(column.name) · \(width)")
            }
        }
        // And the two treatments are still different from each other, or the assertion above
        // would pass on a surface that had collapsed into one variant.
        XCTAssertNotEqual(Reference(.panel), Reference(.fullScreen))
    }

    /// Every value the treatment fixes: type, chip box model, icon sizes, paddings, radii,
    /// rhythm. Collected in one place so a new width-sensitive property has to be added here
    /// deliberately rather than slipping through.
    private struct Reference: Equatable {
        let messageText: DS.TextStyle
        let messagePaddingBlock: CGFloat
        let messagePaddingInline: CGFloat
        let messageRadius: CGFloat
        let paragraphGap: CGFloat
        let selectionText: DS.TextStyle

        let threadGap: CGFloat
        let threadBottomPadding: CGFloat
        /// The top fade is the one member of the scroll-fade family that `ChatScale` alone
        /// decides — `topRamp`/plateau differ 60/56 and 20/8 by scale and by nothing else.
        /// The bottom fade takes no `ChatScale` at all (`bottom(coveringComposer:)` is a
        /// function of the composer's band, not the scale), so it has no place in a
        /// per-scale reference and is not asserted here.
        let topFade: ScrollFadeMetrics

        let chipHeight: CGFloat
        let chipRadius: CGFloat
        let chipPaddingLeading: CGFloat
        let chipGap: CGFloat
        let chipIcon: CGFloat
        let chipLabel: DS.TextStyle
        let chipListGap: CGFloat

        let titleStyle: DS.TextStyle
        let titleHeight: CGFloat
        let titleTopMargin: CGFloat
        let subtitleStyle: DS.TextStyle
        let subtitleHeight: CGFloat
        let subtitleTopMargin: CGFloat
        let orbSize: CGSize?
        let greetingBottomPadding: CGFloat

        let composerHeight: CGFloat
        let composerPaddingLeading: CGFloat
        let composerPaddingTrailing: CGFloat
        let composerGap: CGFloat
        let composerMarquee: CGFloat
        let composerVoice: CGFloat
        let composerSend: CGFloat
        let composerPlaceholder: String
        let composerPlaceholderStyle: DS.TextStyle
        let composerSendIsRaised: Bool
        let composerAttachedHeight: CGFloat

        let errorChipTopMargin: CGFloat
        let errorMessageStyle: DS.TextStyle
        let errorReassuranceStyle: DS.TextStyle

        init(_ scale: ChatScale, width: CGFloat? = nil) {
            let message = MessageMetrics.for(scale, width: width ?? scale.contentWidth)
            let thread = ThreadMetrics.for(scale, width: width ?? scale.contentWidth)
            let chip = SuggestionChipMetrics.for(scale, width: width ?? scale.contentWidth)
            let greeting = GreetingMetrics.for(scale, width: width ?? scale.contentWidth)

            messageText = message.textStyle
            messagePaddingBlock = message.bubblePaddingBlock
            messagePaddingInline = message.bubblePaddingInline
            messageRadius = message.bubbleRadius
            paragraphGap = message.paragraphGap
            selectionText = message.selectionTextStyle

            threadGap = thread.gap
            threadBottomPadding = thread.bottomPadding
            topFade = .top(for: scale)

            chipHeight = chip.height
            chipRadius = chip.radius
            chipPaddingLeading = chip.paddingLeading
            chipGap = chip.gap
            chipIcon = chip.iconSize
            chipLabel = chip.labelStyle
            chipListGap = chip.listGap

            titleStyle = greeting.titleStyle
            titleHeight = greeting.titleHeight
            titleTopMargin = greeting.titleTopMargin
            subtitleStyle = greeting.subtitleStyle
            subtitleHeight = greeting.subtitleHeight
            subtitleTopMargin = greeting.subtitleTopMargin
            orbSize = greeting.orbSize
            greetingBottomPadding = greeting.bottomPadding

            let composer = ComposerMetrics.for(scale, width: width ?? scale.contentWidth)
            composerHeight = composer.height
            composerPaddingLeading = composer.paddingLeading
            composerPaddingTrailing = composer.paddingTrailing
            composerGap = composer.gap
            composerMarquee = composer.marqueeSize
            composerVoice = composer.voiceButtonSize
            composerSend = composer.sendButtonSize
            composerPlaceholder = composer.placeholder
            composerPlaceholderStyle = composer.placeholderStyle
            composerSendIsRaised = composer.sendIsRaised
            // The card's visible band is the label row's height and the pill's is the scale's,
            // so the stack's total is a treatment number even though its width is not.
            composerAttachedHeight = composer.height(showing: .label)

            let error = ChatErrorMetrics.for(scale, width: width ?? scale.contentWidth)
            errorChipTopMargin = error.chipTopMargin
            errorMessageStyle = error.messageStyle
            errorReassuranceStyle = error.reassuranceStyle
        }
    }

    // MARK: - The suggestion grid at a narrower column

    func testTheGridIsTwoUpOnlyInTheRowTheDesignDrewItIn() {
        // 360 is not an independent number: it is half of 740 once the 20pt gap comes out,
        // which is the arithmetic the board writes as "360 × 2 + 20 = 740 exactly".
        XCTAssertEqual(SuggestionChipMetrics.fullScreenChipWidth, 360)
        XCTAssertEqual(2 * SuggestionChipMetrics.fullScreenChipWidth + DS.Space.s5, DS.Container.column)

        XCTAssertEqual(SuggestionChipMetrics.columns(.fullScreen, in: 740), 2)
        XCTAssertEqual(SuggestionChipMetrics.columns(.fullScreen, in: 739), 1, "The pair no longer fits")
        // `flex-shrink: 0` on the chip is the design saying "wrap, do not squeeze", so the
        // 360s do not give — the row does.
        XCTAssertEqual(SuggestionChipMetrics.for(.fullScreen, width: 739).width, 739)
        XCTAssertEqual(SuggestionChipMetrics.for(.fullScreen, width: 740).width, 360)
    }

    func testTheGridWrapsToOneUpOnEveryColumnNarrowerThanTheDesigns() {
        for column in Column.all {
            let width = column.fullScreen
            let chip = SuggestionChipMetrics.for(.fullScreen, width: width)
            let expected = width >= DS.Container.column ? 2 : 1

            XCTAssertEqual(chip.columns, expected, "\(column.name) · \(width)")
            XCTAssertEqual(chip.rows, expected == 2 ? 2 : 4, column.name)
            // 2 × 74 + 20 where the design's row survives; 4 × 74 + 3 × 20 where it wraps.
            XCTAssertEqual(chip.containerHeight, expected == 2 ? 168 : 356, column.name)
            // A wrapped chip fills the reading column rather than sitting at 360 with the
            // rest of the row empty: "the chip's width is set by its column".
            XCTAssertEqual(chip.width, expected == 2 ? 360 : width, column.name)
            // Whatever it wrapped to, a wrapped chip is never narrower than the one the
            // design measured — which is the point of wrapping instead of shrinking.
            XCTAssertGreaterThanOrEqual(chip.width, SuggestionChipMetrics.fullScreenChipWidth, column.name)
        }
    }

    func testThePanelStackIsOneUpAtEveryWidthItCouldEverHave() {
        for width in Column.all.map(\.panel) + [200, 100, 36] {
            let chip = SuggestionChipMetrics.for(.panel, width: width)
            XCTAssertEqual(chip.columns, 1, "panel at \(width)")
            XCTAssertEqual(chip.rows, Suggestion.allCases.count, "panel at \(width)")
            XCTAssertEqual(chip.width, width, "The chip is its column, at any column")
        }
    }

    func testEveryChipRowFillsItsColumnExactlyAndNothingOverlaps() {
        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let chip = SuggestionChipMetrics.for(scale, width: width)
                let row = CGFloat(chip.columns) * chip.width + CGFloat(chip.columns - 1) * chip.listGap

                XCTAssertEqual(row, chip.containerWidth, accuracy: 0.001, "\(scale.rawValue) at \(column.name)")
                XCTAssertEqual(chip.containerWidth, width, "\(scale.rawValue) at \(column.name)")
                XCTAssertGreaterThan(chip.width, 0, "\(scale.rawValue) at \(column.name)")
                XCTAssertLessThanOrEqual(chip.width, width, "\(scale.rawValue) at \(column.name)")
                // Every chip still has room for its own contents: icon, gap and the leading
                // padding come off before a single glyph of label is drawn.
                XCTAssertGreaterThan(
                    chip.width - chip.paddingLeading - chip.iconSize - chip.gap,
                    0,
                    "\(scale.rawValue) at \(column.name): no room left for the label"
                )
            }
        }
    }

    // MARK: - The bubble's measure at a narrower column

    func testTheBubbleMeasureShrinksWithTheColumnAndKeepsItsGutter() {
        // The design's two caps, restated as the run of row they leave clear: 301 − 224 and
        // 740 − 520. That gutter is what the cap is for, so it is what holds.
        XCTAssertEqual(MessageMetrics.panel.bubbleGutter, 77)
        XCTAssertEqual(MessageMetrics.fullScreen.bubbleGutter, 220)

        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let message = MessageMetrics.for(scale, width: width)
                let drawn = MessageMetrics.for(scale)

                XCTAssertEqual(message.rowWidth, width, "\(scale.rawValue) at \(column.name)")
                XCTAssertGreaterThan(message.bubbleMaxWidth, 0, "\(scale.rawValue) at \(column.name)")
                // A measure only ever shrinks.
                XCTAssertLessThanOrEqual(
                    message.bubbleMaxWidth,
                    drawn.bubbleMaxWidth,
                    "\(scale.rawValue) at \(column.name): never wider than the design's cap"
                )
                // And the row it is pinned into always has room left beside it, or the
                // asymmetry the whole thread is built on stops reading.
                XCTAssertGreaterThanOrEqual(
                    message.bubbleGutter,
                    drawn.bubbleGutter,
                    "\(scale.rawValue) at \(column.name): the gutter is what is held"
                )
            }
        }

        // The narrowest reading column any iPad produces: 644 − 220.
        XCTAssertEqual(MessageMetrics.for(.fullScreen, width: 644).bubbleMaxWidth, 424)
        XCTAssertEqual(MessageMetrics.for(.fullScreen, width: 740).bubbleMaxWidth, 520)
        // Padding is a treatment, not a measure, so a 424 bubble still wraps at 16 / 24.
        XCTAssertEqual(MessageMetrics.for(.fullScreen, width: 644).bubbleHeight(lines: 2), 92)
    }

    func testTheSelectionStackNeverOutgrowsTheRowItIsPinnedInto() {
        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let stack = MessageMetrics.for(scale, width: width).selection

                // Board 13 leaves this stack undrawn in the reading column, so it keeps the
                // panel's 224 at both scales — every column the app has is wider than that.
                XCTAssertEqual(stack.width, 224, "\(scale.rawValue) at \(column.name)")
                XCTAssertEqual(stack.totalHeight, 96, "\(scale.rawValue) at \(column.name)")
                XCTAssertLessThanOrEqual(stack.width, width, "\(scale.rawValue) at \(column.name)")
                XCTAssertGreaterThan(stack.labelRowWidth, 0, "\(scale.rawValue) at \(column.name)")
            }
        }
        // The clamp only fires on a row that could never have drawn the design anyway, and
        // when it does it produces a stack, not a negative frame.
        let squeezed = AttachmentStackMetrics.sentMessage(in: 120)
        XCTAssertEqual(squeezed.width, 120)
        XCTAssertEqual(squeezed.labelRowWidth, 84)
        XCTAssertEqual(AttachmentStackMetrics.sentMessage(in: 20).labelRowWidth, 0)
    }

    // MARK: - The greeting at a narrower column

    func testGreetingBlocksKeepTheirTotalsAndStayInternallyConsistentAtEveryColumn() {
        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let greeting = GreetingMetrics.for(scale, width: width)

                XCTAssertEqual(greeting.width, width, "\(scale.rawValue) at \(column.name)")
                // The measure never exceeds the column it is centred in.
                XCTAssertGreaterThan(greeting.subtitleWidth, 0, "\(scale.rawValue) at \(column.name)")
                XCTAssertLessThanOrEqual(greeting.subtitleWidth, width, "\(scale.rawValue) at \(column.name)")
                if let orb = greeting.orbSize {
                    XCTAssertLessThanOrEqual(orb.width, width, "\(scale.rawValue) at \(column.name)")
                }

                // Every step is a type leading or a margin, and none of those is a function
                // of the column — so the block that measures 522 and 268 at the design's
                // widths measures the same at every other.
                let sum = (greeting.orbSize?.height ?? 0)
                    + greeting.titleTopMargin + greeting.titleHeight
                    + greeting.subtitleTopMargin + greeting.subtitleHeight
                    + (greeting.suggestionsTopMargin ?? 0) + (greeting.suggestionsHeight ?? 0)
                    + greeting.bottomPadding
                XCTAssertEqual(greeting.totalHeight, sum, "\(scale.rawValue) at \(column.name)")
                XCTAssertEqual(
                    greeting.totalHeight,
                    scale == .panel ? 522 : 268,
                    "\(scale.rawValue) at \(column.name)"
                )
            }
        }
    }

    func testThePanelSubtitleCapIsAMeasureAndNotAnInset() {
        // 277 forces the 2-line wrap in a 301 column. A column narrower than 277 forces it
        // without help, so the cap has nothing left to do but stay inside its column.
        XCTAssertEqual(GreetingMetrics.for(.panel, width: 301).subtitleWidth, 277)
        XCTAssertEqual(GreetingMetrics.for(.panel, width: 400).subtitleWidth, 277, "A measure does not grow")
        XCTAssertEqual(GreetingMetrics.for(.panel, width: 260).subtitleWidth, 260)
        // Full-screen the subtitle is unconstrained, which at this scale means the column.
        for column in Column.all {
            let width = column.fullScreen
            XCTAssertEqual(GreetingMetrics.for(.fullScreen, width: width).subtitleWidth, width, column.name)
        }
    }

    // MARK: - The thread at a narrower column

    func testTheThreadKeepsItsBottomAnchorAndTwentyTwoRhythmAtEveryColumn() {
        for column in Column.all {
            for scale in ChatScale.allCases {
                let width = column.width(scale)
                let thread = ThreadMetrics.for(scale, width: width)

                XCTAssertEqual(thread.width, width, "\(scale.rawValue) at \(column.name)")
                XCTAssertEqual(thread.gap, DS.Space.messageGap, "\(scale.rawValue) at \(column.name)")

                let offsets = thread.offsets(childHeights: Self.threadChildHeights, in: 936)
                XCTAssertEqual(offsets.count, Self.threadChildHeights.count, column.name)
                XCTAssertGreaterThanOrEqual(
                    offsets.first ?? -1,
                    thread.topPadding,
                    "\(scale.rawValue) at \(column.name)"
                )
                for index in 0 ..< offsets.count - 1 {
                    XCTAssertEqual(
                        offsets[index + 1] - (offsets[index] + Self.threadChildHeights[index]),
                        22,
                        "\(scale.rawValue) at \(column.name): pair \(index)"
                    )
                }
                // Bottom-anchored: the last child's bottom clears the padding and nothing
                // else, at every width.
                let last = (offsets.last ?? 0) + (Self.threadChildHeights.last ?? 0)
                XCTAssertEqual(last + thread.bottomPadding, 936, accuracy: 0.001, column.name)

                // A thread taller than its column starts at its own top padding and scrolls
                // rather than being pulled up off its own first message.
                XCTAssertEqual(
                    thread.offsets(childHeights: Self.threadChildHeights, in: 100).first,
                    thread.topPadding,
                    "\(scale.rawValue) at \(column.name)"
                )
            }
        }
    }

    // MARK: - Screen 07's column, as a flow

    /// The reference case, to the point. Screen 07's own rhythm:
    ///
    /// ```
    /// 162 greeting top · 430 bottom · 174 gap · 604 grid top · 772 bottom · 164 gap · 936
    /// composer top · 1004 composer bottom
    /// ```
    ///
    /// Every one of those is now a result rather than a constant, and this is the test that
    /// says the results are still the board's. **Two things moved them since the board was
    /// transcribed**, and both are the app's, not this test's: the status bar is gone, so the
    /// content band starts at 28 rather than 68, and the pill came down 80 → 68, which hands
    /// the block twelve more points of slack.
    func testTheReadingColumnReproducesScreenSevenOnTheBoardsOwnScreen() {
        // `.fullScreen` explicitly: the boards still state the big variant, and this test
        // pins the design's arithmetic. The live surface currently draws the panel
        // treatment instead — see `TutorFullScreen.scale` and the panel-treatment test.
        let column = TutorColumnMetrics(layout: .reference, scale: .fullScreen)

        XCTAssertEqual(column.x, 352)
        XCTAssertEqual(column.width, 740)
        XCTAssertEqual(column.top, 28, "no status bar: the band starts at the screen's own edge inset")
        XCTAssertEqual(column.greetingHeight, 268)
        XCTAssertEqual(column.suggestionsHeight, 168)
        XCTAssertEqual(column.composerTop(showing: .none), 936)
        XCTAssertEqual(column.bottom, 1004)
        XCTAssertEqual(column.floor, 1032)
        XCTAssertEqual(column.underhang, 28, "the screen's edge inset below the content band")

        // The reference band affords the design's air, so both gaps hold their drawn values.
        XCTAssertEqual(column.startGapAboveSuggestions, 174)
        XCTAssertEqual(column.startGapBelowSuggestions, 164)

        // The block is bottom-anchored in the thread's own band and clears the composer, the
        // underhang and the designed 164 — `68 + 28 + 164 = 260` — so its bottom lands on
        // 772, the grid on 604, and the greeting on 162, with all the slack above it.
        XCTAssertEqual(column.startClearing, 260)
        XCTAssertEqual(column.floor - column.startClearing, 772)
        XCTAssertEqual(
            column.floor - column.startClearing - column.suggestionsHeight,
            604
        )
        XCTAssertEqual(
            column.floor - column.startClearing - column.startContentHeight,
            162
        )

        // Board 13's thread lane runs the screen's own edges, not the content band's: a
        // scroll view clips to its frame, so a frame starting at `contentTop` cut the text
        // at a hard white edge on the way out, and one stopping at `contentBottom` cut it
        // 28 points shy of the screen's foot. See `threadTop` and `threadHeight`.
        XCTAssertEqual(column.threadTop, 0)
        XCTAssertEqual(column.threadHeight, column.floor)
        XCTAssertEqual(column.threadClearing, 120, "68 pill + 28 underhang + 24 gap")
    }

    /// The reason the constants had to go: the grid wraps to one chip a row below 740 and
    /// doubles in height, so a grid pinned at 592 ran 188 points into the composer.
    func testTheReadingColumnStaysCorrectWhenTheGridWrapsOrTheScreenShortens() {
        for device in Column.all {
            let column = TutorColumnMetrics(layout: device.layout, scale: .fullScreen)
            let context = "\(device.name) · column \(column.width)"

            // Bottom-anchored in the thread's band, the chips sit exactly the drawn gap
            // above the resting composer at every width — the design's 164 where the band
            // affords it, its compressed share where it does not, and never less than the
            // 24pt floor.
            XCTAssertEqual(
                column.composerTop(showing: .none) - (column.floor - column.startClearing),
                column.startGapBelowSuggestions,
                accuracy: 0.001,
                context
            )
            XCTAssertLessThanOrEqual(
                column.startGapBelowSuggestions,
                TutorColumnMetrics.suggestionsToComposer,
                context
            )
            XCTAssertGreaterThanOrEqual(
                column.startGapBelowSuggestions,
                TutorColumnMetrics.startGapFloor,
                context
            )
            // Both gaps compress in one proportion, so the block keeps its shape: whenever
            // one is compressed the ratio matches the design's 174 : 164 (until the floor
            // catches the smaller one).
            if column.startGapAboveSuggestions < TutorColumnMetrics.greetingToSuggestions,
                column.startGapAboveSuggestions > TutorColumnMetrics.startGapFloor,
                column.startGapBelowSuggestions > TutorColumnMetrics.startGapFloor {
                XCTAssertEqual(
                    column.startGapAboveSuggestions / column.startGapBelowSuggestions,
                    TutorColumnMetrics.greetingToSuggestions
                        / TutorColumnMetrics.suggestionsToComposer,
                    accuracy: 0.001,
                    context
                )
            }
            // The drawn gap above the chips is the one inside the block's rigid run.
            XCTAssertEqual(
                column.startContentHeight,
                column.greetingHeight + column.startGapAboveSuggestions
                    + column.suggestionsHeight,
                accuracy: 0.001,
                context
            )

            // The start state runs in the thread's own lane: screen top to screen floor.
            XCTAssertEqual(column.threadTop, 0, context)
            XCTAssertEqual(column.threadHeight, column.floor, context)
        }

        // The wrapped case, spelled out. A 9.7-inch iPad in portrait gives a 644pt column,
        // so the grid doubles to 356 and the rigid run outgrows the design's air — and the
        // air is what gives: the budget left once greeting, grid and pill have their heights
        // is 268, shared 174 : 164, and the whole state fits the screen exactly. `top +
        // content + clearing = floor`, which is `ChatScrollColumn`'s exact-fit case: no
        // scroll, nothing clipped, orb on the content top.
        let portrait = TutorColumnMetrics(
            layout: ScreenLayout(
                size: CGSize(width: 768, height: 1024),
                safeArea: EdgeInsets(top: 20, leading: 0, bottom: 0, trailing: 0)
            ),
            scale: .fullScreen
        )
        XCTAssertEqual(portrait.width, 644)
        XCTAssertEqual(portrait.suggestionsHeight, 356)
        XCTAssertLessThan(portrait.startGapAboveSuggestions, 174)
        XCTAssertLessThan(portrait.startGapBelowSuggestions, 164)
        // The whole composition fits the screen — no scroll — but not by pressing the hero
        // into the corner: the air above the greeting keeps its 134 : 174 share of the
        // compression, so the block still hangs below the band's top.
        XCTAssertLessThanOrEqual(
            portrait.top + portrait.startContentHeight + portrait.startClearing,
            portrait.floor,
            "this column no longer scrolls"
        )
        let portraitAir = portrait.floor - portrait.startClearing
            - portrait.startContentHeight - portrait.top
        XCTAssertGreaterThan(portraitAir, 0, "the hero keeps air above it")
        XCTAssertEqual(
            portraitAir / portrait.startGapAboveSuggestions,
            TutorColumnMetrics.greetingTopAir / TutorColumnMetrics.greetingToSuggestions,
            accuracy: 0.001,
            "all three airs compress in one proportion"
        )
        // The design's own screen still holds the full 174/164 with the full 134 above.
        let reference = TutorColumnMetrics(layout: .reference, scale: .fullScreen)
        XCTAssertEqual(
            reference.floor - reference.startClearing
                - reference.startContentHeight - reference.top,
            TutorColumnMetrics.greetingTopAir
        )

        // A band genuinely too short for even the floored gaps — a Split View window — is
        // the one that still scrolls, greeting over the screen edge exactly as the thread's
        // history goes, with `ChatScrollColumn` clipping at the screen edge and nowhere else.
        let short = TutorColumnMetrics(
            layout: ScreenLayout(size: CGSize(width: 900, height: 560), safeArea: EdgeInsets()),
            scale: .fullScreen
        )
        XCTAssertEqual(short.startGapAboveSuggestions, TutorColumnMetrics.startGapFloor)
        XCTAssertEqual(short.startGapBelowSuggestions, TutorColumnMetrics.startGapFloor)
        XCTAssertGreaterThan(
            short.top + short.startContentHeight + short.startClearing,
            short.floor,
            "this is the column that has to scroll"
        )
        // Even then, every chip is above the composer rather than under it.
        XCTAssertLessThan(
            short.floor - short.startClearing,
            short.composerTop(showing: .none)
        )
    }

    /// The card an attached selection grows behind the pill must not push the column above it.
    ///
    /// Board 07 draws no card in the wide composer at all; the app shows one because a
    /// selection made on the board has to be visible before it is sent. It grows into its own
    /// 52pt band, and the greeting jumping 52 points the moment a selection is attached would
    /// be the composer redrawing the screen behind it.
    func testAnAttachedSelectionGrowsTheComposerWithoutMovingTheColumn() {
        let column = TutorColumnMetrics(layout: .reference, scale: .fullScreen)

        XCTAssertEqual(
            column.composerTop(showing: .label),
            column.composerTop(showing: .none) - AttachmentStackMetrics.composer(.fullScreen).visibleBand
        )
        // And the chips card is the *other* band — 64, not 52 — which is the whole reason
        // this takes a card rather than a bool: a composer holding a file is 132 tall where
        // one holding a lassoed region is 120, and everything that reserves room for a grown
        // composer used to be told 120 either way.
        XCTAssertEqual(
            column.composerTop(showing: .chips),
            column.composerTop(showing: .none)
                - AttachmentStackMetrics.composerChips(.fullScreen, width: column.width).visibleBand
        )
        XCTAssertEqual(column.bottom - column.composerTop(showing: .label), 120)
        XCTAssertEqual(column.bottom - column.composerTop(showing: .chips), 132)
        // Both lanes above are measured off the resting composer, so neither moves: the
        // start block's clearance and the thread's band hold their resting numbers.
        XCTAssertEqual(column.startClearing, 260)
        XCTAssertEqual(column.floor - column.startClearing - column.startContentHeight, 162)
        XCTAssertEqual(column.threadHeight, column.floor)
    }

    // MARK: - The attach menu's anchor

    /// Board 16 puts the menu's bottom edge `gapAbovePill` clear of the pill's top, and the
    /// pill's top moves: the card grows the composer **upward** out of the slot. Anchored on
    /// the slot's own band — which is the *resting* pill, deliberately, so the fade and the
    /// thread's clearance never move — the menu is drawn over the chips the learner just
    /// made. With one file in the panel that is 44 of the card's 52 points covered, on the
    /// very tap that adds the second file.
    func testTheAttachMenuClearsWhicheverCardTheComposerIsDrawing() {
        let slot = ComposerSlotMetrics.panel(surfaceWidth: DS.Container.panel)
        let composer = ComposerMetrics.for(.panel, width: DS.Container.panelContent)
        // The panel the boards were drawn at.
        let surface: CGFloat = 936

        // Resting: the card's bottom lands exactly `gapAbovePill` above the pill's top,
        // which is the surface floor less the slot's whole band.
        let resting = slot.attachMenuTop(in: surface, over: composer.height(showing: .none))
        XCTAssertEqual(
            resting + AttachMenu.height + AttachMenu.gapAbovePill,
            surface - slot.band
        )

        // And with a card behind the pill the menu rises by exactly that card's visible
        // band — 38 for the lassoed region, 52 for the chips — rather than staying put.
        for card in [ComposerCard.label, .chips] {
            XCTAssertEqual(
                slot.attachMenuTop(in: surface, over: composer.height(showing: card)),
                resting - composer.attachment(showing: card).visibleBand,
                "\(card)"
            )
        }
        XCTAssertEqual(resting - slot.attachMenuTop(in: surface, over: composer.height(showing: .chips)), 52)

        // A surface too short to hold the card pins it to the top rather than pushing it
        // out through the surface's own edge.
        XCTAssertEqual(slot.attachMenuTop(in: 100, over: composer.height(showing: .chips)), 0)
    }

    /// The reading column asks the same question of the same function, with the **screen's**
    /// floor as its surface: its underhang is the 28pt edge inset below the content band,
    /// exactly as the panel's is its 18pt inset above the panel floor.
    func testTheReadingColumnsAttachMenuUsesTheSameAnchor() {
        let column = TutorColumnMetrics(layout: .reference, scale: .fullScreen)
        let slot = ComposerSlotMetrics.fullScreen(
            columnWidth: column.width,
            underhang: column.underhang,
            scale: .fullScreen
        )
        let composer = ComposerMetrics.for(.fullScreen, width: column.width)

        XCTAssertEqual(slot.underhang, 28)
        XCTAssertEqual(slot.band, 96, "pill top to screen floor, fade and all")

        for card in ComposerCard.allCases {
            XCTAssertEqual(
                slot.attachMenuTop(in: column.floor, over: composer.height(showing: card))
                    + AttachMenu.height + AttachMenu.gapAbovePill,
                column.composerTop(showing: card),
                "The menu's bottom edge is the composer's top, less the gap — \(card)"
            )
        }
    }

    // MARK: - The panel treatment on the reading column

    /// The experiment the live surface currently ships — see `TutorFullScreen.scale`: the
    /// reading column drawn at the panel's own treatment, capped at a readable measure.
    /// Everything here is relative to the panel metrics rather than re-typed, so the test
    /// says "the column really is the panel treatment" and not a second copy of its numbers.
    func testThePanelTreatmentCapsTheColumnAndTakesThePanelMetrics() {
        // The live default is the experiment.
        XCTAssertEqual(TutorColumnMetrics.liveScale, .panel)

        let column = TutorColumnMetrics(layout: .reference, scale: .panel)

        // The reference screen's 740 is capped to the readable measure, re-centred on the
        // same region centre: `(1376 − 600) ÷ 2 = 388`.
        XCTAssertEqual(column.width, TutorColumnMetrics.panelTreatmentColumnCap)
        XCTAssertEqual(column.width, 600)
        XCTAssertEqual(column.x, 388)

        // Every treatment number is the panel's, measured in this column.
        XCTAssertEqual(
            column.greetingHeight,
            GreetingMetrics.for(.panel, width: column.width).totalHeight
        )
        XCTAssertEqual(
            column.suggestionsHeight,
            SuggestionChipMetrics.for(.panel, width: column.width).containerHeight
        )
        XCTAssertEqual(
            column.composerHeight,
            ComposerMetrics.for(.panel, width: column.width).height
        )
        // The band and thread clearances follow the pill that is really drawn.
        XCTAssertEqual(
            column.composerTop(showing: .none),
            column.bottom - column.composerHeight
        )
        XCTAssertEqual(
            column.threadClearing,
            column.composerHeight + column.underhang + DS.Space.gap
        )

        // A column the screen already squeezed below the cap keeps its measured width and
        // its measured centre — the cap is a cap, not a size.
        let squeezed = TutorColumnMetrics(
            layout: ScreenLayout(size: CGSize(width: 700, height: 1024)),
            scale: .panel
        )
        XCTAssertLessThan(squeezed.width, TutorColumnMetrics.panelTreatmentColumnCap)
        XCTAssertEqual(
            squeezed.width,
            ScreenLayout(size: CGSize(width: 700, height: 1024)).columnWidth
        )

        // The slot measures the pill the surface actually draws.
        let slot = ComposerSlotMetrics.fullScreen(
            columnWidth: column.width,
            underhang: column.underhang,
            scale: .panel
        )
        XCTAssertEqual(slot.composerHeight, column.composerHeight)
    }

    /// **A question grows beside the photo it came with.**
    ///
    /// The 224 is the *card's*, by ruling, and it is structural: the card behind is exactly
    /// as wide, and a card narrower than this shape's straight top run would show the notch
    /// it exists to hide. The **height** was never part of that ruling, and pinning it
    /// clipped the second line of the commonest turn this feature has — a photo and a typed
    /// question. `AttachmentStack` gives its content a `minHeight`; the shape in front has to
    /// agree, or it overrides it.
    ///
    /// Measured rather than derived, because the thing that broke was a `height:` where a
    /// `minHeight:` belonged, and no metrics value moved when it did.
    @MainActor
    func testAStackedBubbleKeepsItsWidthAndGrowsItsHeight() {
        let oneLine = size(of: StackedMessageBubble(text: "is this right?"))
        let wrapped = size(of: StackedMessageBubble(
            text: "is question four right, and should I have multiplied before adding the two fractions?"
        ))

        // The ruling, and it does not give in either direction.
        XCTAssertEqual(oneLine.width, AttachmentStackMetrics.sentMessage.width)
        XCTAssertEqual(wrapped.width, AttachmentStackMetrics.sentMessage.width)
        // One line is still exactly the 58 screen 08 draws: the floor is what reproduces it,
        // since the padding puts a single 22pt line at 46.
        XCTAssertEqual(oneLine.height, AttachmentStackMetrics.sentMessage.bodyHeight)
        XCTAssertGreaterThan(
            wrapped.height, oneLine.height,
            "A wrapped question must make the bubble taller. A fixed height clips it."
        )
    }

    /// The same thing one layer up, which is where a learner meets it: the turn itself has to
    /// get taller, not just the shape inside it.
    @MainActor
    func testASentTurnWithAttachmentsGrowsWithItsQuestion() {
        let attachment = MessageAttachment(
            id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 1
        )
        func turn(saying text: String) -> MessageRow {
            MessageRow(
                item: ChatThreadItem(
                    TutorMessage(role: .learner, text: text),
                    attachments: [attachment]
                ),
                scale: .panel,
                width: DS.Container.panelContent
            )
        }

        let oneLine = size(of: turn(saying: "is this right?"))
        let wrapped = size(of: turn(
            saying: "is question four right, and should I have multiplied before adding the two fractions?"
        ))

        XCTAssertGreaterThan(wrapped.height, oneLine.height)
        // The row keeps the thread's column either way — it is the stack inside it that is
        // 224, and the row's trailing alignment is what puts it on the edge.
        XCTAssertEqual(oneLine.width, DS.Container.panelContent)
        XCTAssertEqual(wrapped.width, DS.Container.panelContent)
        // And the turn is its bubble plus the chips card's visible band, so a growing bubble
        // is the only thing that moved.
        XCTAssertEqual(
            wrapped.height - oneLine.height,
            size(of: StackedMessageBubble(
                text: "is question four right, and should I have multiplied before adding the two fractions?"
            )).height - size(of: StackedMessageBubble(text: "is this right?")).height,
            accuracy: 0.5
        )
    }

    /// What a view actually lays out to, at the widest proposal a chat column ever makes.
    ///
    /// `sizeThatFits(in:)` rather than the real-window host `ShellComponentTests` uses: that
    /// one exists because a `GeometryReader` off-window publishes nothing, and nothing
    /// measured here contains one — these are intrinsic content sizes, which is exactly what
    /// this API answers.
    @MainActor
    private func size(of view: some View) -> CGSize {
        UIHostingController(rootView: view).sizeThatFits(
            in: CGSize(width: DS.Container.column, height: .greatestFiniteMagnitude)
        )
    }

    /// **The ruling.** The menu is three short labels, so its width follows its content and
    /// not the surface it is on: 301 at both scales, which is what board 16 draws and what
    /// `menu/sessions` beside it takes.
    ///
    /// The equality across the two scales is the assertion that matters. Making the card
    /// scale with its column looks like consistency — every other chat component does — and
    /// it is what produced a 740 × 156 card for three left-aligned words.
    func testTheAttachMenuIsTheSameWidthAtBothScales() {
        XCTAssertEqual(
            AttachMenu.width(in: DS.Container.panelContent),
            AttachMenu.width(in: DS.Container.column),
            "A menu is a list of three labels, not a reading column"
        )
        XCTAssertEqual(AttachMenu.width(in: DS.Container.column), DS.Container.panelContent)
        // Every column the reading lane can produce, and a panel the student has widened.
        for column in [CGFloat(644), 740, 900, 1200] {
            XCTAssertEqual(AttachMenu.width(in: column), DS.Container.panelContent, "column \(column)")
        }
        // The one direction the cap gives: a panel narrowed past 301 has no room for the
        // card, and rows running off the surface that clips them is worse than a narrow menu.
        XCTAssertEqual(AttachMenu.width(in: 224), 224)
        XCTAssertEqual(AttachMenu.width(in: -10), 0)
    }

    // MARK: - Degenerate widths

    /// Nothing here is a size the app can reach — they are the sizes a bug reaches. The
    /// requirement is only that a component hands `.frame` a number it can draw.
    func testNoComponentProducesANegativeFrameAtAnImpossibleWidth() {
        for width in [CGFloat(0), 1, 36, -400] {
            for scale in ChatScale.allCases {
                let context = "\(scale.rawValue) at \(width)"
                let message = MessageMetrics.for(scale, width: width)
                XCTAssertGreaterThanOrEqual(message.rowWidth, 0, context)
                XCTAssertGreaterThanOrEqual(message.bubbleMaxWidth, 0, context)
                XCTAssertGreaterThanOrEqual(message.selection.width, 0, context)
                XCTAssertGreaterThanOrEqual(message.selection.labelRowWidth, 0, context)

                let thread = ThreadMetrics.for(scale, width: width)
                XCTAssertGreaterThanOrEqual(thread.width, 0, context)
                XCTAssertGreaterThanOrEqual(thread.contentHeight(childHeights: []), 0, context)

                let chip = SuggestionChipMetrics.for(scale, width: width)
                XCTAssertGreaterThanOrEqual(chip.width, 0, context)
                XCTAssertGreaterThanOrEqual(chip.containerWidth, 0, context)
                XCTAssertGreaterThanOrEqual(chip.columns, 1, context)
                XCTAssertGreaterThan(chip.containerHeight, 0, context)

                let greeting = GreetingMetrics.for(scale, width: width)
                XCTAssertGreaterThanOrEqual(greeting.width, 0, context)
                XCTAssertGreaterThanOrEqual(greeting.subtitleWidth, 0, context)
                XCTAssertGreaterThan(greeting.totalHeight, 0, context)

                let card = AttachmentStackMetrics.composer(scale, width: width)
                XCTAssertGreaterThanOrEqual(card.width, 0, context)
                XCTAssertGreaterThanOrEqual(card.labelRowWidth, 0, context)

                let chips = AttachmentStackMetrics.composerChips(scale, width: width)
                XCTAssertGreaterThanOrEqual(chips.width, 0, context)
                XCTAssertGreaterThanOrEqual(chips.labelRowWidth, 0, context)
                // The band is the scale's, not the column's — a narrower iPad must not
                // restyle the chips, only give them less lane to scroll in.
                XCTAssertEqual(chips.visibleBand, AttachmentStackMetrics.composerChips(scale, width: 301).visibleBand, context)
            }
        }
    }

    // MARK: - The attach button, the menu and the chips

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testTheComposerDrawsAnAttachButtonOnlyWhenItCanAttach() {
        // A specimen, preview or gallery entry passes no handler and gets the composer it
        // has always had — the rule `onVoice` already follows.
        XCTAssertFalse(Composer(scale: .panel, text: .constant(""), onSend: {}).drawsAttachButton)
        XCTAssertTrue(
            Composer(scale: .panel, text: .constant(""), onSend: {}, onAttach: {}).drawsAttachButton
        )
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testTheAttachButtonIsNotDrawnWhileDictationHoldsTheLeadingSlot() {
        // The leading slot belongs to the cancel cross while the microphone is open, and a
        // file picker mid-recording is meaningless. Nothing on screen should move when
        // dictation starts.
        let composer = Composer(
            scale: .panel, text: .constant(""), onSend: {}, onAttach: {},
            dictation: ComposerDictation(phase: .capturing, startedAt: .now)
        )
        XCTAssertFalse(composer.drawsAttachButton)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testAFullDraftGreysTheAttachButtonRatherThanRemovingIt() {
        // `ComposerAttachments.add` silently no-ops once the draft holds five files or
        // while a send is in flight, so the button has to say so. It says so by going
        // `--color-ink-tertiary` and refusing the tap — and it stays in the row, because a
        // control that vanishes moves the four beside it.
        let composer = Composer(
            scale: .panel, text: .constant(""), onSend: {}, onAttach: {}, canAttach: false
        )
        XCTAssertTrue(composer.drawsAttachButton)
        XCTAssertFalse(composer.canAttach)
        // The default is the composer every other screen draws.
        XCTAssertTrue(Composer(scale: .panel, text: .constant(""), onSend: {}, onAttach: {}).canAttach)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testTheAttachmentCardIsDrawnForAFileWithNoBoardSelection() {
        // The card used to belong to the board selection alone. A worksheet with nothing
        // lassoed must still get one.
        let composer = Composer(
            scale: .panel, text: .constant(""), selection: .idle, onSend: {},
            attachments: [PendingAttachment(id: UUID(), filename: "a.pdf", state: .uploading)]
        )
        XCTAssertTrue(composer.drawsAttachmentCard)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testTheAttachmentCardIsStillDrawnForABoardSelectionAlone() {
        let composer = Composer(scale: .panel, text: .constant(""), selection: .attached, onSend: {})
        XCTAssertTrue(composer.drawsAttachmentCard)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testNoAttachmentsAndNoSelectionDrawsNoCard() {
        let composer = Composer(scale: .panel, text: .constant(""), selection: .idle, onSend: {})
        XCTAssertFalse(composer.drawsAttachmentCard)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testSendIsDeclinedWithNoTextAndNothingAttached() {
        // Unchanged behaviour, restated because the condition grew a third term.
        let composer = Composer(scale: .panel, text: .constant("  "), selection: .idle, onSend: {})
        XCTAssertFalse(composer.canSend)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testSendIsAllowedWithNoTextButAFileAttached() {
        let composer = Composer(
            scale: .panel, text: .constant(""), selection: .idle, onSend: {},
            attachments: [PendingAttachment(id: UUID(), filename: "a.pdf", state: .uploading)]
        )
        XCTAssertTrue(composer.canSend)
    }

    func testTheChipsCardObeysTheDerivedHeightLaw() {
        // `followsDerivedLaw` holds by construction here — `cardHeight` is *built* as
        // `band + bodyTopRadius` — so on its own it asserts nothing. What makes the law
        // worth stating is that both terms are the drawing's: task 8 §5 measured the band
        // at 52 and 64 and the card at 77 and 98, so these literals are what a wrong band
        // (the brief's 62 / 78, say) actually fails against.
        let measured: [(ChatScale, CGFloat, CGFloat)] = [(.panel, 52, 77), (.fullScreen, 64, 98)]
        for (scale, band, card) in measured {
            let metrics = AttachmentStackMetrics.composerChips(scale, width: scale.contentWidth)
            XCTAssertEqual(metrics.visibleBand, band, "\(scale)")
            XCTAssertEqual(metrics.cardHeight, card, "\(scale)")
            XCTAssertTrue(metrics.followsDerivedLaw, "\(scale)")
            // The one assertion in here that is about a relationship rather than a value:
            // a chip carrying a thumbnail does not fit a card sized to one label row.
            XCTAssertGreaterThan(
                metrics.visibleBand,
                AttachmentStackMetrics.composer(scale, width: scale.contentWidth).visibleBand,
                "\(scale) — a chip with a thumbnail does not fit one label row"
            )
        }
    }

    func testTheChipsCardIsTheDrawingsOwnArithmetic() {
        // Task 8 §5, both stages. The band and the card height are pinned in
        // `testTheChipsCardObeysTheDerivedHeightLaw`; this is the rest of the table.
        let panel = AttachmentStackMetrics.composerChips(.panel, width: DS.Container.panelContent)
        XCTAssertEqual(panel.width, 301)
        XCTAssertEqual(panel.bodyHeight, 50)
        XCTAssertEqual(panel.bodyTopRadius, 25)
        // The composer's whole frame once chips are in it: 52 + 50. Today's selection card
        // gives 88.
        XCTAssertEqual(panel.totalHeight, 102)
        // Left 20, right 0 — the row bleeds to the card's edge so an overflowing chip is
        // cut by the clip. 281 is the lane §6a does the three-chip arithmetic against.
        XCTAssertEqual(panel.cardPaddingLeading, 20)
        XCTAssertEqual(panel.cardPaddingTrailing, 0)
        XCTAssertEqual(panel.labelRowWidth, 281)

        let full = AttachmentStackMetrics.composerChips(.fullScreen, width: DS.Container.column)
        XCTAssertEqual(full.width, 740)
        XCTAssertEqual(full.bodyHeight, 68)
        XCTAssertEqual(full.bodyTopRadius, 34)
        XCTAssertEqual(full.totalHeight, 132)
        // 30, measured — two points wider than the label card's 28, and off the 4pt scale.
        XCTAssertEqual(full.cardPaddingLeading, 30)
        XCTAssertEqual(full.cardPaddingTrailing, 0)
        XCTAssertEqual(full.labelRowWidth, 710)
    }

    /// **The ruling.** A sent attachment sits where the student's other sent work sits: the
    /// 224pt stack on the trailing edge, not a band across the thread's whole column. So the
    /// chips card's geometry is `sentMessage`'s — asserted against it rather than against
    /// 224, because the day that stack is redrawn wide the chips must follow it — and only
    /// the band is the chips'.
    func testTheSentChipsCardTakesTheSentMessagesStackAndNotTheThreadsColumn() {
        // Every column the app produces, including the two the design draws in.
        for row in [DS.Container.panelContent, DS.Container.column, CGFloat(644), 200] {
            let sent = AttachmentStackMetrics.sentMessage(in: row)
            let chips = AttachmentStackMetrics.sentChips(in: row)
            let context = "row \(row)"

            XCTAssertEqual(chips.width, sent.width, context)
            XCTAssertEqual(chips.bodyHeight, sent.bodyHeight, context)
            XCTAssertEqual(chips.bodyTopRadius, sent.bodyTopRadius, context)
            XCTAssertEqual(chips.scale, sent.scale, "panel geometry at both scales — \(context)")
            XCTAssertLessThanOrEqual(chips.width, row, "the row is the only thing that can take the 224 — \(context)")

            // Not the thread's column, which is what this ruling overturned.
            if row > sent.width {
                XCTAssertLessThan(chips.width, row, context)
            }

            // Only the band is the chips': a 32pt thumbnail does not fit a card sized to one
            // label row. And it obeys the derived law, which `sentMessage` itself does not.
            XCTAssertEqual(chips.visibleBand, AttachmentChipMetrics.panel.height + 2 * sent.labelRowPaddingTop, context)
            XCTAssertGreaterThan(chips.visibleBand, sent.visibleBand, context)
            XCTAssertTrue(chips.followsDerivedLaw, context)
            // The row bleeds to the card's edge so an overflowing chip is cut by the clip —
            // the same scroll cue the composer's card gives, in a 204pt lane instead of 281.
            XCTAssertEqual(chips.cardPaddingTrailing, 0, context)
        }
        XCTAssertEqual(AttachmentStackMetrics.sentChips(in: DS.Container.panelContent).labelRowWidth, 204)
    }

    /// A sent turn that is files and no words has nothing in front of the card, so the band
    /// every card in the file hides behind the shape on top would be *drawn* — a
    /// square-cornered tinted rectangle under the chips, over a bubble's height of empty row.
    /// `sentChipsAlone` takes the overlap to zero and reserves no body; the caller rounds all
    /// four corners.
    func testTheSentChipsCardHasNothingHiddenAndNothingReserved() {
        for row in [DS.Container.panelContent, DS.Container.column] {
            let behindABubble = AttachmentStackMetrics.sentChips(in: row)
            let alone = AttachmentStackMetrics.sentChipsAlone(in: row)
            let context = "row \(row)"

            // Everything that describes the chips themselves is unchanged: it is the same
            // card, at the same width, in the same lane.
            XCTAssertEqual(alone.visibleBand, behindABubble.visibleBand, context)
            XCTAssertEqual(alone.width, behindABubble.width, context)
            XCTAssertEqual(alone.cardPaddingLeading, behindABubble.cardPaddingLeading, context)
            XCTAssertEqual(alone.chipHeight, behindABubble.chipHeight, context)
            // The radius the caller rounds all four corners to — the bubble's, which is the
            // curve every other thing the student sent is drawn with.
            XCTAssertEqual(alone.bodyTopRadius, DS.Radius.bubble, context)

            // And the two that make it a message rather than a back layer.
            XCTAssertEqual(alone.cardHeight, alone.visibleBand, context)
            XCTAssertEqual(alone.overlap, 0, "nothing is hidden, because nothing is in front — \(context)")
            XCTAssertEqual(alone.bodyHeight, 0, context)
            XCTAssertEqual(alone.totalHeight, alone.visibleBand, "no dead row under the card — \(context)")
            XCTAssertGreaterThan(
                behindABubble.totalHeight, alone.totalHeight,
                "the stacked instance reserves a bubble and this one must not — \(context)"
            )
        }
    }

    func testTheChipsCardIsEdgeToEdgeWithThePillItIsBehind() {
        // The notch rule from the other side, in the case that actually bites: a portrait
        // iPad hands the wide composer 644, and a card still 740 wide behind a 644 pill
        // hangs off the column — while a card that kept the *design's* width would be
        // narrower than the pill everywhere the column is wider. Both are one substitution
        // away, so the card is asserted against the pill rather than against a constant.
        let column: CGFloat = 644
        let pill = ComposerMetrics.for(.fullScreen, width: column)
        let card = AttachmentStackMetrics.composerChips(.fullScreen, width: column)

        XCTAssertEqual(card.width, pill.width)
        // The straight run of the pill's top edge is what the card must extend past —
        // `644 − 2 × 34`. A card that stopped there would show the notch at both corners.
        XCTAssertEqual(card.straightTopRun, column - 2 * pill.cornerRadius)
        XCTAssertGreaterThan(card.width, card.straightTopRun)
        // And the treatment does not follow the column: the band is still the scale's.
        XCTAssertEqual(card.visibleBand, 64)
    }

    func testAChipsSizeIsItsPartsAddedUp() {
        // Task 8 §4's own check: `4 + 32 + 8 + 84 + 8 + 14 + 8 = 158` and
        // `5 + 38 + 10 + 120 + 10 + 16 + 10 = 209`. The parts are the drawing; the two
        // sizes are what proves the parts were read right.
        XCTAssertEqual(AttachmentChipMetrics.panel.width(), 158)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.width(), 209)
        // The thumbnail box is inset uniformly, so the height falls out of the same padding.
        XCTAssertEqual(AttachmentChipMetrics.panel.height, 40)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.height, 48)

        XCTAssertEqual(AttachmentChipMetrics.panel.thumbnailSize, 32)
        XCTAssertEqual(AttachmentChipMetrics.panel.thumbnailRadius, DS.Radius.xs)
        XCTAssertEqual(AttachmentChipMetrics.panel.labelWidth, 84)
        XCTAssertEqual(AttachmentChipMetrics.panel.dismissSize, 14)
        XCTAssertEqual(AttachmentChipMetrics.panel.radius, DS.Radius.sm)
        XCTAssertEqual(AttachmentChipMetrics.panel.rowGap, 8)

        XCTAssertEqual(AttachmentChipMetrics.fullScreen.thumbnailSize, 38)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.thumbnailRadius, DS.Radius.sm)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.labelWidth, 120)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.dismissSize, 16)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.radius, DS.Radius.md)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.rowGap, 12)

        // The chip's label is 15 / 18 · 600 and 17 / 22 · 600 — *not* the label card's
        // 20 / 24 at the wide scale, which is the band label this replaced.
        XCTAssertEqual(AttachmentChipMetrics.panel.labelStyle.size, 15)
        XCTAssertEqual(AttachmentChipMetrics.panel.labelStyle.leading, 18)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.labelStyle.size, 17)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.labelStyle.leading, 22)
        XCTAssertEqual(AttachmentChipMetrics.fullScreen.labelStyle.weight, .semibold)
    }

    func testThreeChipsDoNotFitThePanelAndDoFitTheReadingColumn() {
        // §6a, settled: the row scrolls, it does not wrap. Chip 1 shows whole and 115 of
        // chip 2 is the cue. Full-screen has no such problem.
        let panel = AttachmentStackMetrics.composerChips(.panel, width: DS.Container.panelContent)
        let panelChip = AttachmentChipMetrics.panel
        let threePanel = 3 * panelChip.width() + 2 * panelChip.rowGap
        XCTAssertEqual(threePanel, 490)
        XCTAssertEqual(panel.labelRowWidth, 281)
        XCTAssertGreaterThan(threePanel, panel.labelRowWidth)
        // What the second chip shows past the first: 281 − 158 − 8.
        XCTAssertEqual(panel.labelRowWidth - panelChip.width() - panelChip.rowGap, 115)

        let full = AttachmentStackMetrics.composerChips(.fullScreen, width: DS.Container.column)
        let fullChip = AttachmentChipMetrics.fullScreen
        let threeFull = 3 * fullChip.width() + 2 * fullChip.rowGap
        XCTAssertEqual(threeFull, 651)
        XCTAssertLessThanOrEqual(threeFull, full.labelRowWidth)
    }

    func testASentChipGivesBackTheWidthOfTheControlItDoesNotHave() {
        // Task 14 draws these on a sent message, where there is nothing to take back. The
        // ✕ and the gap before it come off rather than leaving a hole where a control was.
        let chip = AttachmentChipMetrics.panel
        XCTAssertEqual(chip.width(removable: false), 158 - 14 - 8)
        XCTAssertEqual(chip.width(removable: false), 136)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testARefusalGoesToTheNoteLineAndNotOntoTheChip() async {
        // The chip's label lane is 84pt at 15pt on one line, so a sentence written to say
        // what to do instead reaches the learner as three words and an ellipsis. It goes to
        // the note line above the pill, which board 15 §02 draws full width and which the
        // composer already announces when it appears — and the chip stays, still marked
        // failed, so the learner can see *which* file it is about.
        let sentence = "That file is too large — try a photo of one page at a time."
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network(sentence)
        })

        attachments.add(data: Data(), filename: "whole-book.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        _ = await attachments.readyForSend()

        XCTAssertEqual(attachments.failureNote, sentence)
        // The chip has not been swept up with its words.
        XCTAssertEqual(attachments.pending.count, 1)
        XCTAssertEqual(attachments.pending[0].filename, "whole-book.pdf")
        XCTAssertEqual(attachments.pending[0].state, .failed(sentence))
        // What the chip itself carries now: a mark, and the state in the other modality.
        XCTAssertEqual(AttachmentChip.value(for: .failed), "Failed")
    }

    @MainActor
    func testNothingFailedIsNoNote() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network("nope")
        })
        XCTAssertNil(attachments.failureNote)

        attachments.add(data: Data(), filename: "a.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        // Still in flight — a chip that has not failed yet says nothing.
        XCTAssertNil(attachments.failureNote)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testASelectionAndFilesShareOneCard() {
        // "Here is the worksheet, and here is what I tried" — one card, three chips.
        let row = AttachmentChipRow(
            attachments: [PendingAttachment(id: UUID(), filename: "a.pdf", state: .uploading)],
            showsSelection: true,
            metrics: .composerChips(.panel, width: 301),
            thumbnail: { _ in nil },
            onRemove: { _ in },
            onDismissSelection: {}
        )
        XCTAssertEqual(row.chipCount, 2)
    }

    // Constructs SwiftUI values, and `View` carries `@MainActor`.
    @MainActor
    func testTheAttachMenuKeepsTheSessionMenusConstruction() {
        // Task 8 §3: "construction is inherited from `menu/sessions` exactly". The card is
        // `3 × 44 + 2 × 4 + 2 × 8 = 156`, and it opens 8 clear of the pill — the same gap
        // the session menu leaves under the header it drops from.
        XCTAssertEqual(AttachMenu.height, 156)
        XCTAssertEqual(AttachMenu.gapAbovePill, 8)
        XCTAssertEqual(MenuCardMetrics.rowHeight, 44)
        XCTAssertEqual(MenuCardMetrics.menuRowGap, 4)
        XCTAssertEqual(MenuCardMetrics.menuPadding, 8)
        XCTAssertEqual(MenuCardMetrics.rowPaddingInline, 12)
        // 17 / 22 · 600, the specimen the session menu sets its own action row in.
        XCTAssertEqual(MenuCardMetrics.actionLabel.size, 17)
        XCTAssertEqual(MenuCardMetrics.actionLabel.leading, 22)
        XCTAssertEqual(MenuCardMetrics.actionLabel.weight, .semibold)
    }

    func testTheAttachMenuOffersThreeRowsInTheOrderTheBoardDrawsThem() {
        XCTAssertEqual(
            AttachMenuChoice.allCases.map(\.label),
            ["Photo Library", "Take Photo", "Files"]
        )
    }

    // MARK: - The columns these components are checked at

    /// One column the conversation surface has to work in.
    ///
    /// Taken from `ScreenLayout` rather than re-derived here, for the reason the shell tests
    /// give: a component checked against a second, private copy of the lane arithmetic is
    /// only ever proved to agree with the test.
    private struct Column {
        let name: String
        let layout: ScreenLayout

        /// Screen 07's reading column — `min(740, region − 2 × edge)`, so 740 wherever there
        /// is room for it.
        var fullScreen: CGFloat { layout.columnWidth }

        /// Screens 05 and 08 — derived from the panel the way board 02 insists, rather than
        /// read off the 301 token.
        var panel: CGFloat { TutorPanelMetrics.contentWidth(for: layout.panelWidth) }

        func width(_ scale: ChatScale) -> CGFloat {
            switch scale {
            case .panel: panel
            case .fullScreen: fullScreen
            }
        }

        static func device(
            _ name: String,
            long: CGFloat,
            short: CGFloat,
            safeTop: CGFloat,
            safeBottom: CGFloat
        ) -> (landscape: Column, portrait: Column) {
            func column(_ suffix: String, _ size: CGSize) -> Column {
                Column(
                    name: "\(name) \(suffix)",
                    layout: ScreenLayout(
                        size: size,
                        safeArea: EdgeInsets(top: safeTop, leading: 0, bottom: safeBottom, trailing: 0)
                    )
                )
            }
            return (
                column("landscape", CGSize(width: long, height: short)),
                column("portrait", CGSize(width: short, height: long))
            )
        }

        /// The five iPads the app ships to, widest to narrowest. Both orientations, because
        /// landscape is where the design's column survives untouched and portrait is where it
        /// does not — a suite that only checked landscape would pass on a surface that had
        /// never learned to narrow at all.
        static let devices: [(landscape: Column, portrait: Column)] = [
            Column.device("iPad Pro 13-inch", long: 1376, short: 1032, safeTop: 24, safeBottom: 20),
            Column.device("iPad Pro 11-inch", long: 1194, short: 834, safeTop: 24, safeBottom: 20),
            Column.device("iPad Air 11-inch", long: 1180, short: 820, safeTop: 24, safeBottom: 20),
            Column.device("iPad 10.2-inch", long: 1080, short: 810, safeTop: 20, safeBottom: 0),
            Column.device("iPad 9.7-inch", long: 1024, short: 768, safeTop: 20, safeBottom: 0),
        ]

        static let landscape: [Column] = devices.map(\.landscape)
        static let portrait: [Column] = devices.map(\.portrait)

        /// The board's own screen, with the 40pt status region it was drawn against.
        static let reference = Column(name: "reference (design board)", layout: .reference)

        static let all: [Column] = [reference] + landscape + portrait
    }
}
