import SwiftUI

/// The one shell all four screens are drawn in.
///
/// Board 09, verbatim: *"The outer frame is identical to screen 05 down to the pixel — only
/// the tutor panel's contents change — so a developer implements one shell and swaps what
/// fills the panel."* Screens 05 and 08 therefore differ nowhere in this file: every
/// difference between them is inside `TutorPanel`.
///
/// Every position here is a lane of `ScreenLayout`, placed with `.offset` on a top-leading
/// `ZStack`. Board 09 also said *"nothing here is derived at runtime"* and listed absolute
/// numbers — but every one of those numbers is a subtraction from 1376, 1032 and the status
/// band, written out longhand on the board itself. So the positions are still the board's;
/// they are read from the window the app is in rather than from the window the board was
/// drawn in, which on the reference screen is the same arithmetic with the same answers.
/// There is still no `GeometryReader` here: the measurement happens once, at the root.
///
/// **This screen draws no status band, and neither does anything else.** It used to draw a
/// `StatusBar` unconditionally, and an app-drawn band survived for a while after that so the
/// `--ui-fixture` run could reproduce reference PNGs that had one. The boards were then redrawn
/// without a bar at all, so the component went with them: the app hides the system bar at the
/// root and `contentTop` is the plain `--space-edge` from the glass. `SettingsScreen` repeats
/// the `.statusBarHidden(true)` only because a `fullScreenCover` owns the bar while it is up.
struct BoardScreen: View {
    @EnvironmentObject private var store: TutorStore
    @EnvironmentObject private var uiState: UIState

    /// The screen this is being drawn on. Every lane below comes out of it, so all of them
    /// agree with each other by construction.
    @Environment(\.screenLayout) private var measuredLayout

    /// Owned here rather than by the canvas so the board's ink survives every presentation
    /// change: the rail's centre control, the dock's selection and the evaluation snapshot
    /// all reach the same live `PKCanvasView` through it.
    @StateObject private var capture = CanvasCapture()

    /// Owned beside the composer's text for the same reason the capture is owned beside the
    /// board: one microphone, and the composer it writes into survives every presentation
    /// change the tutor makes.
    @StateObject private var dictation = DictationController()

    @State private var composerText = ""
    @State private var isShowingSettings = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            background
            board
            toolRail
            tutor
            // The dock and the peek are the only regions that overlap anything, and both
            // boards put them in front: screen 06's dock floats on the canvas card, and
            // screen 07's peek is *"painted last, on top of everything"*. The rail and the
            // canvas never overlap, so their order is not load-bearing.
            floatingRegion
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ignoresSafeArea()
        // The panel and the column read the same lanes this file does, and under `--ui-window`
        // that is not the window they were handed — so the screen publishes the layout it drew
        // itself in rather than letting its own children disagree with it.
        .environment(\.screenLayout, layout)
        // Not a `fullScreenCover` any more, and it cannot be one: the redesigned settings is
        // a window *over* the board, and a cover would replace the very thing it blurs. The
        // modifier wraps the whole screen rather than adding a branch to the stack above,
        // because the blur has to reach the rail and the panel too — see `SettingsPresentation`.
        .settingsWindow(isPresented: $isShowingSettings)
        // One microphone, so one notice — attached here rather than in each surface, because
        // the panel and the full-screen column are the same composer at two scales.
        .dictationNotice(dictation)
        // The dock has no composer to dictate into and Settings covers the one that does, so
        // an open microphone would outlive the field it is writing to. Keyed on what is drawn
        // rather than on what `UIState` holds: a window that shrinks past the docking
        // threshold takes the composer off the screen without either axis moving.
        .onChange(of: presentation) { _, _ in dictation.stop() }
        .onChange(of: isShowingSettings) { _, isShowing in if isShowing { dictation.stop() } }
    }

    /// The screen the lanes are cut from.
    ///
    /// Normally the measured one, unmodified. `--ui-window` is the one exception and exists
    /// for a single test: the regression that started all of this was a 1376pt layout drawn on
    /// a 1024pt iPad, and no UI test can resize an iPad's window — there is no API for it, and
    /// the suite is pinned to one simulator. So the argument states the window the screen must
    /// lay itself out in, and the test asserts every lane lands inside it. It is `#if DEBUG`,
    /// like every other `--ui-*` flag, so it cannot reach a shipped build.
    private var layout: ScreenLayout {
        #if DEBUG
        if let window = LaunchOptions.current.window {
            // The insets are kept, not zeroed: a smaller window on an iPad still sits under
            // the same status bar and the same home indicator, and `contentTop` is measured
            // from those rather than from the glass.
            return ScreenLayout(
                size: window,
                safeArea: EdgeInsets(
                    top: measuredLayout.safeAreaTop,
                    leading: measuredLayout.safeAreaLeading,
                    bottom: measuredLayout.safeAreaBottom,
                    trailing: measuredLayout.safeAreaTrailing
                )
            )
        }
        #endif
        return measuredLayout
    }

    // MARK: - Which of the design's states this screen can be in

    /// What is actually drawn, which is the student's choice reconciled with what fits.
    ///
    /// `ScreenLayout` deliberately does not force this — it reports `fit` and leaves the
    /// decision to the screen — and `UIState` deliberately does not know about the window.
    /// Below `dockedMinimumWidth` the docked panel would leave a board narrower than the panel
    /// beside it, which inverts the hierarchy the whole design is built on, so the docked
    /// state is drawn as **screen 06**: rail, full-width board, collapsed dock. That is a state
    /// the design already draws and the student already reaches by hand; nothing new is
    /// invented for the narrow case, and the full-screen tutor is untouched because a reading
    /// column has a right answer at any width.
    ///
    /// It is a substitution rather than a write back into `UIState`, which is what makes the
    /// resize reversible: a student who never asked for the dock gets their panel back the
    /// moment the window is wide enough again, and one who *did* tap `btn/dock` stays
    /// collapsed at every width because that is what their own axis says.
    private var presentation: TutorPresentation {
        guard uiState.presentation == .docked, !layout.canDockTutor else { return uiState.presentation }
        return .collapsed
    }

    // MARK: - Regions

    /// Screen 07 is the one state on pure white; the other three sit on the screen grey.
    private var background: some View {
        (isTutorFullScreen ? DS.Color.surface : DS.Color.surfaceScreen)
            .ignoresSafeArea()
    }

    /// The board card, mounted in every state and hidden in exactly one.
    ///
    /// Screen 07 draws the board as a static 68pt edge rather than a live canvas, but
    /// unmounting the real one would tear down `PKCanvasView` — losing the pan, the zoom and
    /// the "first UIKit layout pass is the board's real start" contract that opens a session
    /// on its own ink. `isActive` is the representable's own answer to this: the canvas stays
    /// mounted and resigns first responder so the tutor's composer can take the keyboard.
    private var board: some View {
        WhiteboardSurface(width: boardWidth, height: layout.contentHeight) {
            PencilCanvasView(
                capture: capture,
                initialDrawingData: store.session.drawingData,
                tool: uiState.tool,
                penColor: uiState.penColor,
                thickness: uiState.thickness,
                isActive: !isTutorFullScreen,
                onDrawingChange: store.updateDrawing,
                onUndo: capture.undo,
                onRedo: capture.redo
            )
        }
        .offset(x: layout.boardX, y: layout.contentTop)
        .opacity(isTutorFullScreen ? 0 : 1)
        .allowsHitTesting(!isTutorFullScreen)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("whiteboard")
        .accessibilityHidden(isTutorFullScreen)
    }

    /// *"only its width changes when the tutor docks or collapses"* — and it keeps the docked
    /// width while the tutor is full-screen, so coming back through the peek does not resize
    /// a board the student never saw change.
    private var boardWidth: CGFloat {
        presentation == .collapsed ? layout.boardWidthCollapsed : layout.boardWidthDocked
    }

    @ViewBuilder
    private var toolRail: some View {
        if !isTutorFullScreen {
            ToolRail(
                // A limit, not a size: the rail is `fit-content` at its own 627.5 wherever the
                // band holds it, which is every full-screen iPad.
                bandHeight: layout.contentHeight,
                selectedTool: uiState.tool,
                selectedColor: uiState.penColor,
                thickness: uiState.thickness,
                onSelectTool: { uiState.tool = $0 },
                onSelectColor: { uiState.penColor = $0 },
                onCentreOnWork: { capture.centerOnContent(animated: true) }
            )
            .offset(x: layout.railX, y: layout.contentTop)
        }
    }

    @ViewBuilder
    private var tutor: some View {
        switch presentation {
        case .docked:
            TutorPanel(text: $composerText, dictation: dictation, actions: actions)
                .offset(x: layout.panelX, y: layout.contentTop)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("tutor-panel")
        case .collapsed:
            // Screen 06 hides the tutor's contents rather than resetting them, which is what
            // lets the dock's orb return the student to screen 05 or 08 correctly.
            EmptyView()
        case .fullScreen:
            TutorFullScreen(text: $composerText, dictation: dictation, actions: actions)
        }
    }

    @ViewBuilder
    private var floatingRegion: some View {
        switch presentation {
        case .collapsed:
            CollapsedDock(onSelect: attachBoardSelection, onOpenTutor: openTutorFromDock)
                .offset(x: layout.collapsedDockX, y: layout.collapsedDockY)
        case .fullScreen:
            BoardPeek(height: layout.contentHeight, onTap: uiState.returnToBoard)
                .offset(x: layout.peekX, y: layout.contentTop)
        case .docked:
            EmptyView()
        }
    }

    private var isTutorFullScreen: Bool { presentation == .fullScreen }

    // MARK: - Behaviour

    private var actions: TutorActions {
        TutorActions(
            send: send,
            selectSuggestion: selectSuggestion,
            dismissSelection: uiState.clearBoardSelection,
            startPlan: startPlan,
            retry: store.retryLastRequest,
            openSettings: { isShowingSettings = true }
        )
    }

    /// `btn/orb` in the collapsed dock. It opens the tutor in whichever of the design's two
    /// tutor states this screen can host: the docked panel where it fits, and the full-screen
    /// column where it does not — which is the state screen 06's own dock already leads to
    /// through the panel, one tap further along. Without this the orb is a dead control at
    /// exactly the sizes where the tutor is hardest to reach.
    private func openTutorFromDock() {
        if layout.canDockTutor {
            uiState.restoreTutorFromDock()
        } else {
            uiState.expandTutorToFullScreen()
        }
    }

    /// One send, two requests, because a selection *is* the board.
    ///
    /// Screen 08 shows an attached selection arriving in the thread as a sent message, and
    /// `TutorStore.evaluate` is the only request that carries an image — so a send that
    /// carries a selection is the board evaluation the old workspace had a button for.
    ///
    /// Typed text is deliberately left in the composer in that case rather than dropped:
    /// the store has no request that carries a question *and* an image, and inventing one
    /// would restructure it.
    private func send() {
        // Sending ends the session outright, in whichever phase it is in: the words already in
        // the field are the ones being sent, and a transcription still in flight would land in
        // an emptied composer a second later.
        dictation.stop()
        let typed = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        if uiState.isSelectionAttached, let snapshot = capture.snapshotAllInkData() {
            store.evaluate(
                imageData: snapshot.data,
                regionDescription: Self.regionDescription(coversAllInk: snapshot.coversAllInk)
            )
            uiState.clearBoardSelection()
        } else if !typed.isEmpty {
            composerText = ""
            store.send(typed)
        } else {
            return
        }
        uiState.beginConversation()
    }

    /// Ink spread over more board than one legible image can hold is cropped to the
    /// student's work. Telling the tutor it is looking at the whole board would invite
    /// confident feedback on a portion of it.
    ///
    /// Both labels are spliced into a first-person learner turn ("Please evaluate my work on
    /// …") and a third-person policy line ("The learner asked you to evaluate …"), so they
    /// have to read correctly in both and cannot carry their own "my".
    private static func regionDescription(coversAllInk: Bool) -> String {
        coversAllInk
            ? "the whole board"
            : "the main working area of the board (some ink further out is not shown)"
    }

    private func selectSuggestion(_ suggestion: Suggestion) {
        // `chip/confused` — "I don't understand this" — is the opener the old board spent a
        // dedicated "I don't know" button on, so it keeps carrying that signal instead of
        // arriving as text the tutor has to infer an admission from.
        if suggestion == .confused {
            store.sayIDontKnow()
        } else {
            store.send(suggestion.label)
        }
        uiState.beginConversation()
    }

    /// `btn/primary` on the plan, labelled "Start on the board".
    private func startPlan() {
        store.startWorking()
        // Screen 06 is the design's own name for the board having the screen to itself, and
        // the only state that gives the board the width the label promises.
        uiState.collapseTutor()
    }

    /// `btn/select` in the collapsed dock — the design's one control for attaching a region
    /// of the board to the composer.
    private func attachBoardSelection() {
        // An empty board has nothing to attach: this is the same precondition the evaluation
        // snapshot has, and the design draws no disabled state to show instead (open
        // question 8) and no marquee on the canvas to draw one with (open question 7).
        guard capture.hasInk else { return }
        uiState.attachBoardSelection()
    }
}
