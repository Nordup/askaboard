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
/// **Nothing in the app draws a status band.** This screen used to draw a `StatusBar`
/// unconditionally, and an app-drawn band survived for a while after that so the `--ui-fixture`
/// run could reproduce reference PNGs that had one. The boards were then redrawn without a bar,
/// so the component went with them — and the PNGs were re-exported to match, which is why the
/// fixture now *hides* the system bar instead of covering it.
///
/// On device iPadOS still draws its own, and the app does not hide it: `contentTop` is
/// `safeAreaTop + --space-edge`, so 52 where the boards say 28. See `RootView`.
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
    /// A drag updates only this screen-local preview. Publishing `UIState.panelWidth` on
    /// every touch event invalidated every environment-object consumer and made the seam
    /// visibly stutter. A completed resize commits once in `finishPanelResize()`.
    @State private var previewPanelWidth: CGFloat?
    @State private var didChangePanelWidth = false

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
        // The one place the store, the network client and the live canvas meet.
        // Set here rather than passed per-send so no turn can be the one that
        // forgets the board — see `TutorStore.boardProvider`. `capture` is held
        // weakly throughout: these outlive this screen, and a board that has
        // gone away should read as "no board" rather than keep a torn-down
        // canvas alive.
        .task {
            store.boardProvider = { [weak capture] in capture?.overviewData() }
            store.boardManifestProvider = { [weak capture] in capture?.manifest() }
            // The service answers `view_board` straight from the canvas: the
            // tutor asks for a rectangle mid-turn and this renders it from the
            // vectors, at a resolution a thumbnail upload could never carry.
            BackendTutorService.boardRenderer = { [weak capture] percent in
                capture?.renderRegion(percent: percent)
            }
        }
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
            return resized(
                ScreenLayout(
                    size: window,
                    safeArea: EdgeInsets(
                        top: measuredLayout.safeAreaTop,
                        leading: measuredLayout.safeAreaLeading,
                        bottom: measuredLayout.safeAreaBottom,
                        trailing: measuredLayout.safeAreaTrailing
                    )
                )
            )
        }
        #endif
        return resized(measuredLayout)
    }

    /// The student's requested panel width, reconciled with the window it has to fit in.
    ///
    /// A clamp on read rather than a write back into `UIState`, which is the same move
    /// `presentation` makes one property down and for the same reason: it is what keeps a
    /// resize reversible. A window that shrinks squeezes the panel; a window that grows
    /// again restores exactly what was asked for, because what was asked for was never
    /// overwritten. Clamping here rather than at the gesture is also what handles the window
    /// changing while nobody is dragging at all — Split View, Stage Manager, an external
    /// display — since this evaluates on every layout pass.
    ///
    /// The parameter is named `base` rather than `layout` on purpose: this type already has a
    /// `layout` computed property one scope up, and a parameter of the same name shadows it
    /// silently — correct today, since nothing in this function's body reaches for the
    /// property, but a later edit that added such a reference would recurse `layout` into
    /// itself with no compiler complaint, because both spellings type-check.
    private func resized(_ base: ScreenLayout) -> ScreenLayout {
        guard base.maximumPanelWidth >= ScreenLayout.minimumPanelWidth else { return base }
        return ScreenLayout(
            size: base.size,
            safeArea: EdgeInsets(
                top: base.safeAreaTop,
                leading: base.safeAreaLeading,
                bottom: base.safeAreaBottom,
                trailing: base.safeAreaTrailing
            ),
            panelWidth: base.resolvingPanelWidth(previewPanelWidth ?? uiState.panelWidth)
        )
    }

    // MARK: - Which of the design's states this screen can be in

    /// What is actually drawn, which is the student's choice reconciled with what fits.
    ///
    /// `ScreenLayout` deliberately does not force this — it reports `fit` and leaves the
    /// decision to the screen — and `UIState` deliberately does not know about the window.
    /// Below `dockedMinimumWidth` the docked panel would squeeze the board below its usable
    /// floor, so the docked state is drawn as **screen 06**: rail, full-width board, collapsed
    /// dock. That is a state
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
        // `liveCanvasOver` is what keeps PencilKit's fast stroke path: the canvas
        // paints the paper and stays unmasked, and the card's corners are painted
        // over it in the screen's own colour. See `WhiteboardSurface.body`.
        WhiteboardSurface(
            width: boardWidth,
            height: layout.contentHeight,
            liveCanvasOver: DS.Color.surfaceScreen
        ) {
            PencilCanvasView(
                capture: capture,
                initialDrawingData: store.currentDrawingData,
                tool: uiState.tool,
                penColor: uiState.penColor,
                thickness: uiState.thickness,
                isActive: !isTutorFullScreen,
                isSelecting: uiState.selection.capturesBoardDrags,
                onDrawingChange: store.updateDrawing,
                onUndo: capture.undo,
                onRedo: capture.redo
            )
            // Mounted only while the marquee is armed. A transparent view that
            // takes the whole board's touches is not something to leave lying on
            // the canvas the rest of the time.
            if uiState.selection.capturesBoardDrags {
                BoardSelectionMarquee(
                    attachedRegion: uiState.selection.region,
                    // An explicit closure rather than the bound method, for the
                    // reason `resizeHandle`'s `set:` spells out at length: a
                    // `@MainActor`-isolated method reference passed straight into
                    // a one-argument closure parameter is what crashes
                    // swift-frontend during IRGen on this toolchain.
                    onSelect: { uiState.attachBoardSelection(region: $0) }
                )
            }
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
            resizeHandle
        case .collapsed:
            // Screen 06 hides the tutor's contents rather than resetting them, which is what
            // lets the dock's orb return the student to screen 05 or 08 correctly.
            EmptyView()
        case .fullScreen:
            TutorFullScreen(text: $composerText, dictation: dictation, actions: actions)
        }
    }

    /// The drag strip in the gutter between the board and the panel.
    ///
    /// Mounted only in the `.docked` case of `tutor`, which means it does not exist when the
    /// panel is collapsed or full-screen rather than existing invisibly and staying
    /// hittable — a strip with nothing to resize is a control that eats touches on the
    /// board. Settings needs no case of its own: `settingsWindow` covers the whole screen,
    /// so a handle under it is unreachable by construction.
    ///
    /// It is positioned by its **trailing** edge against the panel, so the strip runs from
    /// `panelX − gutter` to `panelX + panelInset` and claims not one point of the canvas.
    @ViewBuilder
    private var resizeHandle: some View {
        let constraints = ResizeConstraints(
            minimum: ScreenLayout.minimumPanelWidth,
            maximum: layout.maximumPanelWidth,
            collapseBelow: ScreenLayout.minimumPanelWidth * Self.panelCollapseFraction
        )
        // Belt-and-braces, not a reachable case here: `presentation == .docked` (the only way
        // this property is built at all — see `tutor`) requires `layout.canDockTutor`, which
        // requires `layout.fit == .threeLane`, which requires the docked lane to hold the
        // board's floor beside the panel's — `lane >= panelWidth + 200` — so
        // `layout.maximumPanelWidth == dockedLaneWidth - 200 >= constraints.minimum`
        // always holds by the time this line runs. The guard stays because `ResizeConstraints`
        // is a public shape that does not know about `ScreenLayout`'s own invariants, and a
        // future caller of it should not have to re-derive this proof to stay safe; a reader
        // chasing an `else` branch that can actually run here will not find one.
        if constraints.isSatisfiable {
            ResizeHandle(
                edge: .leading,
                span: layout.contentHeight,
                gutter: DS.Space.gap,
                contentMargin: DS.Space.panelInset,
                constraints: constraints,
                label: "Resize the tutor panel",
                size: Binding(
                    get: { layout.panelWidth },
                    // Preview locally so the environment object is published once on release,
                    // not on every touch event delivered by the drag.
                    set: {
                        previewPanelWidth = $0
                        didChangePanelWidth = true
                    }
                ),
                onBegin: beginPanelResize,
                onEnd: finishPanelResize,
                onCollapse: uiState.collapseTutor,
                onReset: uiState.resetPanelWidth
            )
            .offset(x: layout.resizeStripX, y: layout.contentTop)
        }
    }

    /// How far below its floor the *virtual* panel width has to be dragged before the
    /// gesture collapses the tutor to the dock.
    ///
    /// The one proportion in the resize system that no token names, and it earns the
    /// exception by never landing on screen: it is a gesture threshold, not a layout value.
    /// `0.6 × 260 = 156`, which is 104 points of finger travel past the floor — far enough
    /// that no ordinary narrowing drag trips it, close enough that reaching for it is one
    /// motion rather than two.
    private static let panelCollapseFraction: CGFloat = 0.6

    /// Freeze the visible, window-clamped width for this gesture. Keeping the raw requested
    /// width untouched also means a release-to-collapse can discard the preview and reopen at
    /// exactly the width the student had before dragging toward the dock.
    private func beginPanelResize() {
        previewPanelWidth = layout.panelWidth
        didChangePanelWidth = false
    }

    /// Commit at most once, after a normal release. `ResizeHandle` calls `onCollapse` before
    /// this end hook on a qualifying release, so a collapsed presentation discards the
    /// preview and preserves the previously requested width. Cancellation also lands here
    /// safely with the last valid preview.
    private func finishPanelResize() {
        if uiState.presentation == .docked,
           didChangePanelWidth,
           let previewPanelWidth {
            uiState.setPanelWidth(previewPanelWidth)
        }
        previewPanelWidth = nil
        didChangePanelWidth = false
    }

    @ViewBuilder
    private var floatingRegion: some View {
        switch presentation {
        case .collapsed:
            CollapsedDock(
                // Lit from the moment the marquee is armed, for the same reason the
                // composer's glyph is: this button is the only thing on a collapsed
                // screen that can report the tap landed.
                isSelectionAttached: uiState.selection.capturesBoardDrags,
                canSelect: capture.hasInk,
                onSelect: toggleBoardSelection,
                onOpenTutor: openTutorFromDock
            )
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
            toggleSelection: toggleBoardSelection,
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
    /// **The typed text goes with it.** It used to be left sitting in the composer, on the
    /// grounds that the store had no request carrying a question *and* an image. That is the
    /// reason a student who wrote "check my work" and sent it got a canned "Please evaluate
    /// my work on the whole board." delivered in its place and their own question silently
    /// dropped — so `evaluate` now takes the question, which is a parameter rather than the
    /// restructuring it was assumed to need.
    private func send() {
        // Sending ends the session outright, in whichever phase it is in: the words already in
        // the field are the ones being sent, and a transcription still in flight would land in
        // an emptied composer a second later.
        dictation.stop()
        let typed = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        if uiState.selection.capturesBoardDrags, let evaluation = boardEvaluation() {
            composerText = ""
            store.evaluate(
                imageData: evaluation.data,
                regionDescription: evaluation.description,
                question: typed.isEmpty ? nil : typed
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

    /// The image a send carries, and the words that say what it is of.
    ///
    /// Two cases, because `btn/select` can be lit without a region having been drawn yet:
    /// a marqueed region is cropped to exactly that rectangle, and an armed-but-undrawn
    /// marquee falls back to the whole board — which is precisely what this control did
    /// before it could pick a region, so the zero-effort path is unchanged.
    private func boardEvaluation() -> (data: Data, description: String)? {
        if let region = uiState.selection.region {
            guard let data = capture.snapshotData(region: region) else { return nil }
            // No "my" and no "they": the same label is spliced into a first-person
            // learner turn and a third-person policy line — see `regionDescription`.
            return (data, "the area selected on the board")
        }
        guard let snapshot = capture.snapshotAllInkData() else { return nil }
        return (snapshot.data, Self.regionDescription(coversAllInk: snapshot.coversAllInk))
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

    /// `btn/select` — the design's one control for attaching a region of the board to the
    /// composer, reachable now from the collapsed dock *and* from the docked composer.
    ///
    /// It arms the marquee rather than attaching anything, because *which* region is a
    /// question only a drag can answer; `BoardSelectionMarquee` takes it from here. The
    /// attachment used to be the whole board — the design draws no marquee on the canvas
    /// (open question 7) — which is why this control had no visible result and read as
    /// broken.
    ///
    /// An empty board still has nothing to select, the same precondition
    /// `snapshotAllInkData()` has, and both controls reflect that rather than swallowing
    /// the tap. Disarming is allowed unconditionally so a marquee can never be left armed
    /// over a board that has since been cleared.
    private func toggleBoardSelection() {
        guard uiState.selection.capturesBoardDrags || capture.hasInk else { return }
        uiState.toggleBoardSelection()
    }
}
