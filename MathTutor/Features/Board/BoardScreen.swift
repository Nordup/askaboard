import SwiftUI
import UIKit

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

    /// The live voice engine, owned at screen level so a call survives every
    /// presentation switch — the spec's one placement rule for it. The host
    /// publishes only the rare facts (live, muted); the 10 Hz levels stay on
    /// the engine's own `VoiceDisplayProvider`, which this screen never
    /// observes. See `VoiceSessionHost` for the engine's one construction site.
    @StateObject private var voice = VoiceSessionHost()

    /// The one `MascotMotion` both surfaces' mascots share, injected through
    /// the environment so the breathing envelopes and half-finished crossfades
    /// survive the docked ↔ full-screen swap — `VoiceMascotView`'s own
    /// instruction to whoever mounts it at screen level.
    @State private var mascotMotion = MascotMotion()

    /// The files on the message being written, owned here for the same reason `composerText`
    /// and `dictation` are: the draft is the *learner's*, and it has to survive every
    /// presentation change the tutor makes. A `@StateObject` inside `TutorPanel` would be
    /// destroyed the moment the panel unmounted — docking, collapsing, going full-screen —
    /// and a photo attached a second earlier would go with it.
    @StateObject private var attachments = ComposerAttachments.forThisBuild()

    @State private var composerText = ""
    /// True from the tap on `composer/send` until the turn has actually been handed to the
    /// store.
    ///
    /// `ComposerAttachments.isSending` cannot be this guard on its own: it is a plain `Bool`
    /// set at the top of `readyForSend()` and cleared by that call's own `defer`, so the
    /// first of two overlapping sends reopens the window for the second on its way out — and
    /// the second would then send a draft the first has already cleared. This is the flag the
    /// *button* reads. It is set and read on the main actor with no suspension between the
    /// guard and the write, and it stays true across the whole wait, so a second tap while a
    /// six-page PDF is still converting cannot start a second turn.
    @State private var isSendingTurn = false
    @State private var isShowingSettings = false
    /// A drag updates only this screen-local preview. Publishing `UIState.panelWidth` on
    /// every touch event invalidated every environment-object consumer and made the seam
    /// visibly stutter. A completed resize commits once in `finishPanelResize()`.
    @State private var previewPanelWidth: CGFloat?
    @State private var didChangePanelWidth = false

    /// The live position of the panel between screens 05/08 and screen 06.
    ///
    /// **`@State` and not `@StateObject`, deliberately.** `@StateObject` subscribes, and this
    /// object publishes on every touch event of a collapse pan — this screen's body builds
    /// `TutorPanel`, the board and the rail, so subscribing here would rebuild all of them
    /// sixty times a second and hand `PKCanvasView` a fresh layout pass per frame. `@State`
    /// holds the reference for the life of the screen without observing it, which is exactly
    /// what a screen that only *writes* to it needs. The one view that observes it is
    /// `DockRevealLayer`, whose whole job is to re-render two offsets against stored content.
    ///
    /// It is also the single entry point for the transition itself: the swipe, `btn/dock`, the
    /// dock's orb, the resize-drag collapse and `Start on the board` all call
    /// `settle(to:velocity:travel:_:)`, so there is one curve for arriving at screen 06 and one
    /// for leaving it whichever control was used.
    @State private var dockDrag = DockRevealModel()

    /// True from a presentation switch's start until its settle spring finishes — set
    /// before the animated write, cleared in the spring's completion, both outside every
    /// animation transaction. It exists for one rule: **at most one live `TextField` per
    /// switch.** Both tutor surfaces are briefly on screen while the crossfade runs (the
    /// outgoing one lives out its removal transition), and two live fields trading first
    /// responder mid-animation is the iPadOS 17 keyboard hazard `BoardCanvas.swift` carries
    /// the scar of. While this holds, both composers render chrome only
    /// (`Composer.isInteractive`); the settled surface's field arrives at completion.
    @State private var isPresentationSwitching = false

    var body: some View {
        ZStack(alignment: .topLeading) {
            background
            board
            toolRail
            tutor
            // Painted after the tutor: screen 07's peek is *"painted last, on top of
            // everything"*, and screen 06's dock — inside `tutor` — floats on the canvas
            // card, which the peek and the canvas never overlap.
            floatingRegion
            // Last of all: a call running somewhere else is the one thing on
            // this screen that is not about the session on screen, and it has
            // to be findable over every surface.
            callPill
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .ignoresSafeArea()
        // **The context-menu shield: one mechanism, one place, every surface.** While a
        // session row's menu is up — a fact, not a guess: the row's own
        // `UIContextMenuInteraction` reports both edges through `UIState` — the entire screen
        // goes inert behind the menu. On iPadOS 17 the tap that dismisses a context menu is
        // *also* delivered to the app's window, and it used to act on whatever it landed on:
        // tapping the pushed-aside chat strip closed the drawer and opened the chat. A shield
        // scoped to the drawer could never cover that strip, the composer, the rail or the
        // board; the screen's root covers all of them by construction, so no surface can be
        // missed. The menu itself lives in its own window above this one and stays fully
        // interactive.
        //
        // Mounted only while the flag holds — through the dismissal animation, because the
        // flag drops in the dismissal animator's completion — for the reason every dismiss
        // layer in this app is conditional: a view that swallows every touch is not something
        // to leave lying around. `PKCanvasView` and the other UIKit descendants are covered
        // too: an active SwiftUI hit target above a representable takes the hit test. The
        // drawer pan cannot be hit-tested away, so it is suspended by the same flag below.
        .overlay {
            if uiState.isContextMenuActive {
                Color.clear
                    .contentShape(.rect)
                    .ignoresSafeArea()
                    .onTapGesture {}
                    .accessibilityHidden(true)
            }
        }
        // The panel and the column read the same lanes this file does, and under `--ui-window`
        // that is not the window they were handed — so the screen publishes the layout it drew
        // itself in rather than letting its own children disagree with it.
        .environment(\.screenLayout, layout)
        // The drawer's pan recogniser lives on a UIKit ancestor and can see neither SwiftUI
        // paint order nor the shield above, so both facts are stated to it: a swipe inside
        // settings must reach settings, not toggle a drawer behind the blur, and a touch
        // while a row's context menu is up must dismiss the menu, not drag the drawer under
        // it. See `EnvironmentValues.isDrawerPanSuspended`.
        .environment(\.isDrawerPanSuspended, isShowingSettings || uiState.isContextMenuActive)
        // One motion integrator for every mascot this screen mounts, so the
        // halo's envelopes ride through the docked ↔ full-screen swap instead
        // of restarting — `VoiceMascotView`'s own mounting instruction.
        .environment(\.mascotMotion, mascotMotion)
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
        .onChange(of: presentation) { _, _ in
            dictation.stop()
            // **The docked drawer only.** It covers 78% of the panel, so arriving at the panel
            // behind an open one is arriving with the conversation already hidden — and in the
            // collapsed state it would be open behind nothing at all. Coming back docked always
            // lands on the full chat.
            //
            // The full-screen sidebar is deliberately left alone and survives the round trip.
            // It covers nothing and re-centres the column beside it, so it is a layout the
            // learner chose rather than a detour they forgot to leave; making them re-open it
            // after every glance at the board is the tax that closing it would impose. The two
            // flags exist to tell those cases apart — see `UIState.isSessionsSidebarOpen`.
            uiState.closeSessionsDrawer()
        }
        .onChange(of: isShowingSettings) { _, isShowing in if isShowing { dictation.stop() } }
        // The backstop for the one session change that does not go through
        // `TutorPanel.adoptSessionUI` — Settings' "Reset this session", which calls the
        // store directly with no surface in between. An attachment was uploaded *against a
        // session id*, so a chip carried into the session next door names a file the new
        // session's turn has no claim on. `onChange` rather than `task(id:)`: this screen is
        // never remounted, so it fires on a real switch and never on an appearance — a
        // `task(id:)` on the panel would wipe the draft every time the tutor docked.
        .onChange(of: store.session.id) { _, _ in
            attachments.clear()
            // **A switch no longer ends the call.** It used to: a call streams
            // its transcripts into the session it was started in, and the store
            // wrote them into whatever was on screen. The store pins them to
            // the call session now (`TutorStore.callSessionID`), so the call
            // keeps running while the learner browses — the pill marks where it
            // is — and the deferred close keeps the server from freezing that
            // session's episode mid-conversation.
            //
            // The one ending left here: a call whose session no longer exists.
            // Settings' reset and a delete of the call session destroy the
            // thread the call writes into, and a call with nowhere to speak is
            // not a call.
            if let callID = voice.callSessionID,
               !store.sessions.contains(where: { $0.id == callID }) {
                endVoiceChat()
            }
        }
        // The armed edit's cancel gesture: the draft emptied by hand. The store
        // cannot watch the field — the draft is this screen's state — so the
        // screen reports the emptiness and the store disarms. A send's own
        // clearing lands here too, harmlessly: the edit was consumed first.
        .onChange(of: composerText) { _, newValue in
            if newValue.isEmpty { store.cancelEditing() }
        }
        // The one place the store, the network client and the live canvas meet.
        // Set here rather than passed per-send so no turn can be the one that
        // forgets the board — see `TutorStore.boardProvider`. `capture` is held
        // weakly throughout: these outlive this screen, and a board that has
        // gone away should read as "no board" rather than keep a torn-down
        // canvas alive.
        .task {
            // The one place the store learns a call is over, however it ended —
            // the X disc, a call replaced by one started in another session, or
            // a start that could not bring the call up and folded itself away.
            // A callback rather than `onChange(of: voice.isLive)`: it carries
            // the session the call belonged to and it fires before any next
            // call can begin. See `VoiceSessionHost.onCallEnded`.
            voice.onCallEnded = { [weak store] sessionID in
                store?.voiceCallEnded(sessionID: sessionID)
            }
            store.boardProvider = { [weak capture] in capture?.overviewData() }
            store.boardManifestProvider = { [weak capture] in capture?.manifest() }
            store.boardSceneProvider = { [weak capture] in capture?.sceneContextString() }
            // The service answers `view_board` straight from the canvas: the
            // tutor asks for a rectangle mid-turn and this renders it from the
            // vectors, at a resolution a thumbnail upload could never carry.
            // It answers for the board on screen, so it answers only for a turn
            // whose session *is* the one on screen. A delegated turn running for
            // a call the learner has walked away from must never be handed this
            // canvas: `nil` reaches the model as "I could not see the board",
            // which is true — see `TutorStore.turnSeesTheVisibleBoard`.
            BackendTutorService.boardRenderer = { [weak capture, weak store] percent in
                guard store?.turnSeesTheVisibleBoard ?? false else { return nil }
                return capture?.renderRegion(percent: percent)
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
                    ),
                    keyboardInset: measuredLayout.keyboardInset
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
    ///
    /// **Every input is carried, including the ones this function does not care
    /// about.** It rebuilds the value rather than mutating one field of it, so
    /// anything left out of this initializer is silently reset to a default for
    /// the whole screen below — which is exactly what happened to
    /// `keyboardInset` the first time: measured correctly at the root, dropped
    /// here, and the composer spent the fix still sitting under the keyboard.
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
            panelWidth: base.resolvingPanelWidth(previewPanelWidth ?? uiState.panelWidth),
            keyboardInset: base.keyboardInset
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

    /// Every state sits on the screen grey now, screen 07 included.
    ///
    /// It used to be the one state on pure white, because the full-screen tutor filled the
    /// window and there was nothing else on it. Board 19 puts a sessions sidebar against the
    /// leading edge, and the sidebar's ground is `--color-surface-screen` with the chat a white
    /// surface beside it — so the white belongs to the chat pane rather than to the screen, and
    /// `TutorFullScreen.chatSurface` is where it is painted. With the sidebar shut that pane
    /// still runs the whole window, so nothing about screen 07 changes on screen; what changes
    /// is which view owns the colour.
    private var background: some View {
        DS.Color.surfaceScreen.ignoresSafeArea()
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
                onRedo: capture.redo,
                scene: store.session.boardScene
            )
            // Switching sessions swaps the board under the pen, and
            // `initialDrawingData` is read in `makeUIView` and nowhere else —
            // by design, see `TutorStore.currentDrawingData`. Without a remount
            // the new session would open on the previous session's ink, and the
            // first stroke would save it there. Keyed on the session rather
            // than the ink so ordinary drawing never remounts the canvas.
            .id(store.session.id)
            // Mounted only while the marquee is armed. A transparent view that
            // takes the whole board's touches is not something to leave lying on
            // the canvas the rest of the time.
            if uiState.selection.capturesBoardDrags {
                BoardSelectionMarquee(
                    // Back through the mapping the drag came in on: the region is
                    // kept in the drawing's coordinates, and this is the one place
                    // that needs it in the view's. The mark then follows the ink it
                    // was drawn around through anything that moves the board.
                    attachedRegion: uiState.selection.region.flatMap(capture.viewRect(forDrawingRect:)),
                    // An explicit closure rather than the bound method, for the
                    // reason `resizeHandle`'s `set:` spells out at length: a
                    // `@MainActor`-isolated method reference passed straight into
                    // a one-argument closure parameter is what crashes
                    // swift-frontend during IRGen on this toolchain.
                    onSelect: { attachBoardSelection(viewRegion: $0) }
                )
            }
        }
        .offset(x: boardX, y: layout.contentTop)
        // The one opacity in the switch that is not a transition: the board card never
        // unmounts (tearing down `PKCanvasView` would lose the ink contract), so it simply
        // crossfades — the write happens inside the switch's animation, so the fade runs
        // on the same spring the surfaces trade on. It neither slides nor scales.
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

    /// Where that board starts. The row reads panel · rail · board, so collapsing the tutor
    /// takes the panel and one gap out of the row and moves the two lanes after it — the board
    /// gains width **and** a new left edge, where before it only ever gained width. Both
    /// numbers come from the same presentation, so the canvas cannot be drawn at one state's
    /// width in the other state's lane.
    private var boardX: CGFloat {
        presentation == .collapsed ? layout.boardXCollapsed : layout.boardX
    }

    /// The rail's lane, by the same rule and for the same reason: leading when the tutor is
    /// collapsed, between the tutor and the canvas when it is docked.
    private var railX: CGFloat {
        presentation == .collapsed ? layout.railXCollapsed : layout.railX
    }

    @ViewBuilder
    private var toolRail: some View {
        // Unmounted at full screen; the switch's animation gives the unmount the default
        // opacity transition, so the rail crossfades in place with the board it serves.
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
            .offset(x: railX, y: layout.contentTop)
        }
    }

    @ViewBuilder
    private var tutor: some View {
        switch presentation {
        case .docked, .collapsed:
            // **Screens 05/08 and screen 06 are one region now, because the swipe between them
            // is one gesture.** They used to be two arms of this switch and a third entry in
            // `floatingRegion`, which is fine for two states a button jumps between and wrong
            // for two states a finger drags between: the panel has to be on screen while it is
            // still leaving, and the dock has to be on screen before it has arrived. The layer
            // is what owns that window — see `DockRevealLayer` — and it still mounts each
            // surface only in its own presentation the rest of the time, so screen 06 still
            // gives the board the screen to itself.
            //
            // Screen 06 hides the tutor's contents rather than resetting them, which is what
            // lets the dock's orb return the student to screen 05 or 08 correctly.
            DockRevealLayer(
                travel: layout.dockTravel,
                panelOrigin: CGPoint(x: layout.panelX, y: layout.contentTop),
                dockOrigin: CGPoint(x: layout.collapsedDockX, y: layout.collapsedDockY),
                edgeZone: CGRect(
                    x: layout.safeAreaLeading,
                    y: layout.contentTop,
                    width: HorizontalSwipeRouter.edgeZoneWidth,
                    height: layout.contentHeight
                ),
                isDocked: presentation == .docked,
                // Read for the edge zone's left-swipe, which defers to an open drawer — the
                // right-swipe goes full-screen regardless. See
                // `HorizontalSwipeRouter.transition(...)`.
                isDrawerOpen: uiState.isSessionsDrawerOpen,
                drag: dockDrag,
                // The way back in lands wherever the orb's tap lands, and for the same reason:
                // on a window too narrow to dock, the tutor's only home is the full-screen
                // column. See `openTutorFromDock`.
                onSettle: { docked in if docked { openTutorFromDock() } },
                // Explicit, not the bound method — see `actions.returnToBoard`.
                onEnterFullScreen: { enterFullScreenFromEdge(velocity: $0) }
            ) {
                TutorPanel(
                    text: $composerText,
                    dictation: dictation,
                    attachments: attachments,
                    voiceCall: composerVoiceCall,
                    voiceThread: isCallInVisibleSession
                        ? .panel(
                            display: voice.display,
                            isResting: voice.isResting,
                            onWake: { voice.wake() }
                        )
                        : nil,
                    onStartVoiceChat: startVoiceChatAction,
                    // The same flag the collapsed dock's `btn/select` takes, for the same
                    // control at the other presentation — an empty board has nothing to
                    // select, and `toggleBoardSelection` would swallow the tap.
                    canSelect: capture.hasInk,
                    dock: dockDrag,
                    actions: actions,
                    isPresentationSwitching: isPresentationSwitching
                )
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("tutor-panel")
            } dock: {
                CollapsedDock(
                    // Lit from the moment the marquee is armed, for the same reason the
                    // composer's glyph is: this button is the only thing on a collapsed
                    // screen that can report the tap landed.
                    isSelectionAttached: uiState.selection.capturesBoardDrags,
                    canSelect: capture.hasInk,
                    onSelect: toggleBoardSelection,
                    onOpenTutor: expandTutorFromDock,
                    // A call on a collapsed chat shows in the dock's orb slot: the live
                    // mascot at the dock's own orb size, driven by the same 10 Hz display
                    // the panel and full-screen stages observe, on the screen's shared
                    // `\.mascotMotion` — so the envelopes ride the docked ↔ collapsed
                    // swap like every other presentation switch. The dock's tap is
                    // untouched (it opens the chat); mute and end live in the voice bar
                    // there, deliberately not here.
                    liveFace: isCallInVisibleSession
                        ? VoiceMascotView(display: voice.display, variant: .dock)
                        : nil
                )
            }
            // The switch's directional polish, on the whole docked/collapsed surface: it
            // arrives from `+slideDistance` on the return leg and leaves toward it on the
            // enter leg, fading either way. Fires only when this branch trades with the
            // full-screen one — the docked ↔ collapsed trade happens *inside* the layer.
            .transition(PresentationSwitch.dockedSurface)
            if presentation == .docked { resizeHandle }
        case .fullScreen:
            TutorFullScreen(
                text: $composerText,
                dictation: dictation,
                attachments: attachments,
                voiceCall: composerVoiceCall,
                voiceThread: isCallInVisibleSession
                    ? .fullScreen(
                        display: voice.display,
                        isResting: voice.isResting,
                        onWake: { voice.wake() }
                    )
                    : nil,
                onStartVoiceChat: startVoiceChatAction,
                actions: actions,
                isPresentationSwitching: isPresentationSwitching
            )
            // The mirror: in from `-slideDistance` entering, out toward it returning.
            .transition(PresentationSwitch.fullScreenSurface)
        }
    }

    // MARK: - The presentation switch

    /// The one animated switch every docked ↔ full-screen path runs — edge-swipe releases,
    /// `btn/full-screen`, the peek's tap and the peek lane's swipe alike. The presentation
    /// flips inside the animation, which is what runs the two surfaces' transitions and the
    /// board's crossfade on the one spring; `isPresentationSwitching` brackets it from
    /// outside every transaction, and the composer focus is resigned on a main-queue hop —
    /// never inside a render transaction: `BoardCanvas.swift` carries the scar of the
    /// synchronous version deadlocking UIKit's keyboard machinery on iPadOS 17.
    private func switchPresentation(velocity: CGFloat, _ apply: @escaping () -> Void) {
        isPresentationSwitching = true
        DispatchQueue.main.async {
            UIApplication.shared.sendAction(
                #selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil
            )
        }
        withAnimation(PresentationSwitch.settle(velocity: velocity, travel: layout.dockTravel)) {
            apply()
        } completion: {
            isPresentationSwitching = false
        }
    }

    /// The rung above docked: a right-swipe released in the leading edge zone while the
    /// panel is docked — `DockRevealLayer.onEnterFullScreen`, commit-triggered, with the
    /// release velocity carried into the spring.
    ///
    /// `!isPresentationSwitching` on every entry point keeps switches from overlapping: a
    /// second switch started under a live one would let the first spring's completion clear
    /// the flag mid-flight. The window is one spring (~0.35s); the gesture that lands in it
    /// still committed and cancelled what it crossed, which is the recogniser's job either
    /// way.
    private func enterFullScreenFromEdge(velocity: CGFloat) {
        guard presentation != .fullScreen, !isPresentationSwitching else { return }
        switchPresentation(velocity: velocity) { uiState.expandTutorToFullScreen() }
    }

    /// `btn/full-screen`: the same switch, from rest. On a window that cannot dock the
    /// guard is moot — the tutor is collapsed or already full screen — and the switch is
    /// the same either way, because the transition needs no docked anchor to leave from.
    private func expandTutorToFullScreen() {
        guard presentation != .fullScreen, !isPresentationSwitching else { return }
        switchPresentation(velocity: 0) { uiState.expandTutorToFullScreen() }
    }

    /// The drag strip in the gutter between the panel and the tool rail.
    ///
    /// Mounted only in the `.docked` case of `tutor`, which means it does not exist when the
    /// panel is collapsed or full-screen rather than existing invisibly and staying
    /// hittable — a strip with nothing to resize is a control that eats touches on the
    /// board. Settings needs no case of its own: `settingsWindow` covers the whole screen,
    /// so a handle under it is unreachable by construction.
    ///
    /// It is positioned by its **leading** edge against the panel's own trailing inset, so the
    /// strip runs from `panelX + panelWidth − panelInset` to the rail's left edge and claims
    /// not one point of the rail — or, now that the panel leads, of the canvas.
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
                // The panel is pinned to the leading edge, so its free edge — the one that
                // moves — is the trailing one, and dragging *away* from the origin widens it.
                // `ResizeEdge` is where that sign lives; nothing else in the resize system
                // changes for the mirror.
                edge: .trailing,
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
                onCollapse: collapseTutor,
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

    /// What floats over the board. The peek, and nothing else now.
    ///
    /// The collapsed dock used to be the other case here, and it moved into `tutor` when the
    /// swipe made it one surface with the panel: the two have to be on screen at the same time
    /// while a finger is between them, and a dock drawn from a different branch of this file
    /// could never be. It is still painted over the board — `tutor` comes after `board` in the
    /// screen's stack — so screen 06's *"the dock floats on the canvas card"* is unchanged.
    @ViewBuilder
    private var floatingRegion: some View {
        if presentation == .fullScreen {
            // The tap and the trailing-edge swipe are one path with one curve — see
            // `returnToBoardFromPeek(velocity:)`. The tap used to write `UIState` directly and
            // the column simply vanished, which is the fourth-behaviour-rather-than-fourth-
            // control mistake `DockReveal.settle` was written to end.
            BoardPeek(height: layout.contentHeight) { returnToBoardFromPeek(velocity: 0) }
                .offset(x: layout.peekX, y: layout.contentTop)
        }
    }

    /// Board 32's pill: a live call in a session that is **not** the one on
    /// screen, floating top-centre over the canvas area at y = 36 — the board's
    /// own 28pt content top plus 8.
    ///
    /// Mounted only while that is true, like every other layer this screen puts
    /// over the board: the condition flips the moment the tap lands the learner
    /// back in the call session, so the pill takes itself away. The container is
    /// `Color.clear`, which takes no hit test of its own, so nothing outside the
    /// capsule is intercepted — the board keeps every touch the pill does not.
    @ViewBuilder
    private var callPill: some View {
        if let callID = voice.callSessionID,
           CallPill.isVisible(
               isLive: voice.isLive,
               callSessionID: callID,
               visibleSessionID: store.session.id
           ) {
            Color.clear
                .frame(width: pillLaneWidth, height: layout.contentHeight)
                .overlay(alignment: .top) {
                    CallPill(
                        display: voice.display,
                        // The live row, so a session named by its first turn
                        // stops saying "New session" under the pill too; the
                        // host's own copy is the fallback for a session the
                        // index has not caught up with.
                        sessionTitle: store.sessions.first { $0.id == callID }?.title
                            ?? voice.callSessionTitle,
                        onReturn: { returnToCall(callID) }
                    )
                    .padding(.top, DS.Space.s2)
                }
                .offset(x: pillLaneX, y: layout.contentTop)
        }
    }

    /// The lane the pill centres itself in: the canvas, or the whole window
    /// when the tutor has the screen and there is no canvas to sit over.
    private var pillLaneWidth: CGFloat {
        isTutorFullScreen ? layout.size.width : boardWidth
    }

    private var pillLaneX: CGFloat {
        isTutorFullScreen ? 0 : boardX
    }

    /// The pill's tap: the sessions drawer's own switch, so every piece of the
    /// switch's bookkeeping runs exactly as it does from a row — the store
    /// saves and swaps the session, and this screen's own `onChange` clears the
    /// draft's files behind it.
    private func returnToCall(_ sessionID: UUID) {
        guard sessionID != store.session.id else { return }
        store.openSession(id: sessionID)
        uiState.clearBoardSelection()
        uiState.showConversation(store.hasGoal ? .active : .start)
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
            editMessage: { editMessage($0) },
            openSettings: { isShowingSettings = true },
            // Explicit closures rather than the bound methods, for the reason `resizeHandle`'s
            // `set:` spells out: a `@MainActor`-isolated method reference passed straight into
            // a one-argument closure parameter crashes swift-frontend during IRGen on this
            // toolchain.
            expandToFullScreen: { expandTutorToFullScreen() },
            returnToBoard: { returnToBoardFromPeek(velocity: $0) }
        )
    }

    // MARK: - Voice chat

    /// **Whether this screen draws the call at all**, as opposed to marking it
    /// with the pill: a call is live *and* it belongs to the session on screen.
    ///
    /// Every voice surface on this screen branches on this and never on
    /// `voice.isLive` — the mascot on the thread's tail, the dock orb's live
    /// face, the composer's voice mode, and through `VoiceThreadState` board
    /// 31's resting chip. A call the learner has walked away from keeps running
    /// and keeps speaking into its own session; the session they are reading
    /// gets its ordinary thread and its ordinary composer, whose typed words go
    /// to the tutor of the session on screen. See `CallPill.isVisible` — the two
    /// are complements, so a live call is drawn in exactly one place.
    private var isCallInVisibleSession: Bool { voice.isCallHere(in: store.session.id) }

    /// The live call as the composer draws it — built fresh per render, like
    /// `actions`, so the surfaces hold values and never the engine.
    private var composerVoiceCall: ComposerVoiceCall? {
        guard isCallInVisibleSession else { return nil }
        return ComposerVoiceCall(
            isMuted: voice.isMuted,
            onToggleMute: { voice.toggleMuted() },
            onEnd: { endVoiceChat() },
            onSendTyped: { voice.sendTyped($0) },
            // Work mode changes what the pill does with the return key and how the mic
            // button draws — see `Composer.send()` and `ComposerVoiceMuteButton`. A rare
            // fact, mirrored off the display, so this value moves on the transition only.
            isResting: voice.isResting
        )
    }

    /// Board 27's disc, or nothing at all: a build with no backend has no call
    /// to start, and the composer keeps its permanent send disc — the same
    /// availability-decides rule the dictation mic already follows.
    private var startVoiceChatAction: (() -> Void)? {
        guard voice.isAvailable else { return nil }
        return { startVoiceChat() }
    }

    /// Board 27's disc. Dictation is stopped first — the two must never hold
    /// the microphone together, and stopping before the engine touches the
    /// audio session is this screen's half of that rule (the engine's audio
    /// controller refuses the other direction).
    ///
    /// `beginConversation()` because the mascot and the transcripts live in
    /// the thread: a call started from the greeting needs the conversation
    /// fill on screen to be seen at all.
    private func startVoiceChat() {
        guard voice.isAvailable else { return }
        // **One call at a time, app-wide.** A call live in another session is
        // ended first, on the normal teardown path — usage reported,
        // transcripts settled, and the old call session's deferred close fired
        // by `voiceCallEnded`. No confirmation: the tap is unambiguous, and the
        // pill the learner tapped past says where the old call was.
        let replacing = voice.isCallElsewhere(than: store.session.id)
        guard !voice.isLive || replacing else { return }
        dictation.stop()
        store.clearComposerNote()
        // `stop()` is asynchronous at its tail — the dictation session's own
        // task clears `isListening` as it unwinds — and the engine refuses to
        // start while dictation still claims the microphone
        // (`VoiceSessionHooks.isDictationActive`). Waiting the session out
        // costs nothing on the common path: no session, no wait.
        let unwinding = dictation.session
        let sessionID = store.session.id
        let sessionTitle = store.session.title
        // Read here rather than inside the task: the call opens on what the
        // learner had selected when they tapped, not on whatever the settings
        // window holds by the time dictation finishes unwinding.
        let voiceModel = store.session.selectedVoiceModel
        Task {
            // The old call's whole teardown runs first, and `finish()` reports
            // it through `onCallEnded` before anything binds the host to this
            // session — which is what keeps the old call's deferred close
            // pointed at the old call's session.
            if replacing { await voice.finish() }
            await unwinding?.value
            // Only now, and always before the engine starts, so no hook can
            // arrive at a store that still thinks there is no call.
            store.voiceCallBegan(sessionID: sessionID)
            voice.begin(
                sessionID: sessionID,
                sessionTitle: sessionTitle,
                voiceModel: voiceModel,
                hooks: voiceHooks
            )
        }
        uiState.beginConversation()
    }

    /// The X disc, and every forced ending (a session switch). The engine
    /// plays its own ~1 s ending state inside `end()`; the store learns the
    /// call is over through the `onChange(of: voice.isLive)` above, which is
    /// the same door every other ending walks through.
    private func endVoiceChat() {
        guard voice.isLive else { return }
        Task { await voice.finish() }
    }

    /// How the engine reaches the rest of the app — installed next to the
    /// board providers because they are the same kind of hole: the store
    /// deliberately knows nothing about the engine, and this is where the
    /// two meet.
    private var voiceHooks: VoiceSessionHooks {
        VoiceSessionHooks(
            runTutorTurn: { [weak store] request in
                guard let store else { return .failure(TutorServiceError.notConfigured) }
                return await store.runVoiceTurn(request: request)
            },
            appendUserUtterance: { [weak store] text in
                store?.appendVoiceUtterance(text)
            },
            streamAssistantText: { [weak store] itemID, delta in
                store?.streamVoiceAssistantText(itemID: itemID, delta: delta)
            },
            assistantResponseFinished: { [weak store] itemID, delegated in
                store?.finishVoiceAssistantResponse(itemID: itemID, delegated: delegated)
            },
            // The engine's own half of the one-microphone rule: it refuses to
            // start while this reads true. `startVoiceChat` stops dictation
            // and waits its session out first, so on our paths this is already
            // false by the time the engine asks.
            isDictationActive: { [weak dictation] in dictation?.isListening ?? false },
            streamUserTranscript: { [weak store] itemID, delta in
                store?.streamVoiceUserTranscript(itemID: itemID, delta: delta)
            },
            finalizeUserUtterance: { [weak store] itemID, text in
                store?.finalizeVoiceUserUtterance(itemID: itemID, text: text)
            }
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

    /// `btn/orb` as the learner meets it: the same destination, on the same spring the
    /// edge-swipe settles on.
    ///
    /// The tap and the swipe differ in one value — a tap has no release velocity, so the
    /// spring starts from rest. Everything else about the two is the same call.
    private func expandTutorFromDock() {
        dockDrag.settle(to: true, velocity: 0, travel: layout.dockTravel) { openTutorFromDock() }
    }

    /// The way back from the reading column: the peek's tap, and the left-swipe out of the
    /// peek's own lane. One function, because they are one transition — the same switch,
    /// with the release velocity of the swipe that asked for it or `0` from the tap.
    ///
    /// **The sidebar is untouched.** `returnToBoard` moves one axis, and
    /// `UIState.isSessionsSidebarOpen` is deliberately not the docked drawer's flag: the
    /// learner's full-screen layout is still there when they come back. The docked drawer is
    /// closed by this screen's own `onChange(of: presentation)`, which is the other half of
    /// that rule.
    private func returnToBoardFromPeek(velocity: CGFloat) {
        guard presentation == .fullScreen, !isPresentationSwitching else { return }
        switchPresentation(velocity: velocity) { uiState.returnToBoard() }
    }

    /// Collapse from something that is not the dock gesture: the resize drag dragged past its
    /// floor, or `Start on the board`.
    ///
    /// Routed through the model rather than writing `UIState` directly, so the panel is still
    /// mounted while it leaves and leaves on the one curve. Before this every path to screen 06
    /// had its own behaviour, which is to say none of them had one.
    private func collapseTutor() {
        dockDrag.settle(to: false, velocity: 0, travel: layout.dockTravel) {
            uiState.collapseTutor()
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
    ///
    /// **A send with a selection is never quietly downgraded to one without.** The
    /// two branches used to be one condition — `capturesBoardDrags` *and* an image
    /// — so a capture that came back nil fell through to the text-only branch and
    /// delivered the question with no picture, no error, and the selection still
    /// sitting in the composer as though it had never been consumed. The learner
    /// had pointed at their working and been answered as if they hadn't. Now the
    /// attachment decides the branch and only the capture can fail inside it, out
    /// loud, with the text and the selection both left where they were.
    ///
    /// **A send waits for what is still converting.** A learner who taps send while a
    /// six-page PDF is mid-upload must have it arrive with the turn rather than dropped —
    /// which is what `deliver` is for, and why the attachment branches are asynchronous
    /// while every send that carries no file stays exactly as synchronous as it was.
    ///
    /// **Nothing is consumed until the store says it took the turn.** The store declines a
    /// send while a reply is still streaming, and it used to do so silently: the words were
    /// already gone from the field, the uploads were cancelled and discarded, and no turn
    /// appeared. So the draft, the marquee and the conversation axis all move on the
    /// store's `Bool` and on nothing else — `uiState.beginConversation()` in particular,
    /// because it is one-way and a failed first send would have replaced the greeting with
    /// an empty thread there was no way back from.
    private func send() {
        // One turn at a time. See `isSendingTurn` — `ComposerAttachments.isSending` is not
        // this guard, and cannot be.
        guard !isSendingTurn else { return }
        // Sending ends the session outright, in whichever phase it is in: the words already in
        // the field are the ones being sent, and a transcription still in flight would land in
        // an emptied composer a second later.
        dictation.stop()
        store.clearComposerNote()
        let typed = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        if uiState.selection.capturesBoardDrags {
            guard let evaluation = boardEvaluation() else {
                store.reportBoardCaptureFailure()
                return
            }
            deliver { ready in
                guard store.evaluate(
                    imageData: evaluation.data,
                    regionDescription: evaluation.description,
                    question: typed.isEmpty ? nil : typed,
                    attachments: ready
                ) else { return false }
                uiState.clearBoardSelection()
                accept()
                return true
            }
        } else if !typed.isEmpty || !attachments.isEmpty {
            deliver { ready in
                // Every attachment failed to convert and there were no words with them:
                // nothing is sent, and — the point of the `false` — nothing is cleared
                // either. The failed chips and the sentence above the pill are the only
                // account the learner has of what happened.
                guard !typed.isEmpty || !ready.isEmpty else { return false }
                guard store.send(typed, attachments: ready) else { return false }
                accept()
                return true
            }
        }
    }

    /// What a taken turn costs the composer: the words go, and the panel stops being a
    /// greeting. The files go too, in `deliver`, which is the only thing that knows whether
    /// there were any.
    ///
    /// On the ordinary send — no attachments — this still runs on the same frame as the tap,
    /// because `deliver` calls its closure synchronously when there is nothing to wait for.
    private func accept() {
        composerText = ""
        uiState.beginConversation()
    }

    /// Hands the turn to the store once everything on the draft has finished converting.
    ///
    /// - Parameter turn: Sends it, and reports whether the store **took** it. Only a `true`
    ///   clears the chips — a declined turn leaves the draft, the uploads and the note above
    ///   the pill exactly as they were, which is the whole point. And even a `true` clears
    ///   only the chips that *went*: a refused one keeps its sentence until the learner
    ///   takes it off (see `ComposerAttachments.clearSent`).
    private func deliver(_ turn: @escaping @MainActor ([UploadedAttachment]) -> Bool) {
        // Nothing attached is the overwhelmingly common send, and it stays exactly what it
        // was: no task, no hop, no window at all for a second tap to land in.
        guard !attachments.isEmpty else {
            _ = turn([])
            return
        }
        isSendingTurn = true
        Task {
            defer { isSendingTurn = false }
            let ready = await attachments.readyForSend()
            guard turn(ready) else { return }
            attachments.clearSent()
        }
    }

    /// The image a send carries, and the words that say what it is of.
    ///
    /// Two cases, because `btn/select` can be lit without a region having been drawn yet:
    /// a marqueed region is cropped to exactly that rectangle, and an armed-but-undrawn
    /// marquee falls back to the whole board — which is precisely what this control did
    /// before it could pick a region, so the zero-effort path is unchanged.
    private func boardEvaluation() -> (data: Data, description: String)? {
        if let region = uiState.selection.region {
            guard let data = capture.snapshotData(drawingRegion: region) else { return nil }
            // No "my" and no "they": the label is spliced into a third-person policy
            // line on the server, never into the learner's own message.
            return (data, "the area selected on the board")
        }
        guard let snapshot = capture.snapshotAllInkData() else { return nil }
        return (snapshot.data, Self.regionDescription(coversAllInk: snapshot.coversAllInk))
    }

    /// Ink spread over more board than one legible image can hold is cropped to the
    /// student's work. Telling the tutor it is looking at the whole board would invite
    /// confident feedback on a portion of it.
    ///
    /// The label is spliced into a third-person policy line on the server ("The learner
    /// asked you to evaluate …"), so it cannot carry its own "my" or "they". The learner's
    /// own message is never rewritten with it.
    private static func regionDescription(coversAllInk: Bool) -> String {
        coversAllInk
            ? "the whole board"
            : "the main working area of the board (some ink further out is not shown)"
    }

    /// The thread's long-press Edit: the sent words come back to the composer
    /// and the store arms the rewrite. Nothing is cut here — the cut is the
    /// send's act (`TutorStore.consumePendingEdit`), so a learner who backs
    /// out has lost nothing. The words land in the field as they were sent,
    /// replacing whatever draft was there; the note above the pill says the
    /// state and both ways out of it.
    private func editMessage(_ id: UUID) {
        guard let message = store.session.messages.first(where: { $0.id == id }) else { return }
        composerText = message.text
        store.beginEditingMessage(id: id)
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
        collapseTutor()
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

    /// A finished marquee drag, stored against the learner's ink rather than
    /// against the window.
    ///
    /// The gesture can only report view coordinates — it is a drag on a view —
    /// so this is where they stop being view coordinates, at the one boundary
    /// that has the canvas in reach. A drag with no canvas under it leaves the
    /// marquee armed rather than attaching a rectangle measured against nothing.
    private func attachBoardSelection(viewRegion: CGRect) {
        guard let region = capture.drawingRect(forViewRect: viewRegion) else { return }
        uiState.attachBoardSelection(region: region)
    }
}
