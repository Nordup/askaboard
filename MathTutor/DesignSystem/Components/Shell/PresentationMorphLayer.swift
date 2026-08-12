import SwiftUI

/// The one region that hosts the tutor in every presentation — and the container morph
/// between the docked panel and the full-screen column, tracked under the finger.
///
/// **Why one layer instead of a `switch` in `BoardScreen`.** The morph needs both
/// presentations' contents on screen at once, each mounted exactly once, with identities that
/// survive the presentation flip: a branch that swapped `DockRevealLayer` for
/// `TutorFullScreen` at settle would remount a live thread and a focused composer mid-spring,
/// which is both the cost and the glitch this file exists to avoid. So the mounts are decided
/// here, off `PresentationMorphModel.isActive` and the settled presentation, and each surface
/// keeps one home: the panel inside the nested `DockRevealLayer`, the column in its own slot,
/// and the board in a slot of its own — the live `PKCanvasView` has to survive every
/// presentation, and during the morph it is *translated*, never resized. See
/// `PresentationMorph.boardShift(at:)`.
///
/// **The `DrawerRevealLayer` discipline, unchanged.** Every slot arrives as an already-built
/// view value and is stored; a gesture frame re-runs only this body, which hands the same
/// values back wearing new `PresentationMorphRender` parameters. Nothing progress-dependent
/// is passed *into* any slot. The renders are animatable, so a settle — or a button's morph
/// from rest — replays the same curves the finger drives; see `PresentationMorphRender`.
///
/// **Degenerate at both ends by construction.** At progress `0` the render modifiers evaluate
/// to the panel's own clip, full opacity and zero shift — pixel-identical to the docked
/// screen — and the full-screen slots are unmounted. At `1` the clip is the screen, the
/// column and the peek are at full strength, the board's card is fully off the trailing edge
/// at opacity `0`, and the docked slots are unmounted. The endpoints *are* today's two
/// screens, not approximations of them.
struct PresentationMorphLayer<
    Board: View, Rail: View, Panel: View, Dock: View,
    FullScreenChat: View, Sidebar: View, Peek: View
>: View {
    /// The morph's endpoints — both container frames, radii, curves. Rebuilt by the screen
    /// whenever the layout or the sidebar flag changes; constant across a gesture's frames.
    let geometry: PresentationMorph
    /// The settled presentation, reconciled with what fits — never the live position.
    let presentation: TutorPresentation
    /// Whether board 19's sidebar is open — the mount for the sidebar slot; its *position*
    /// during the morph is `PresentationMorph.sidebarShift(at:)`.
    let isSidebarOpen: Bool
    /// The board card's resting origin: the docked lane, or the collapsed one — the same two
    /// answers `BoardScreen` always had. The morph only ever runs from the docked value.
    let boardOrigin: CGPoint
    /// The sidebar's resting origin — `sessionsSidebarX`, the screen's own top.
    let sidebarOrigin: CGPoint

    // The docked ↔ collapsed axis, passed straight through to the nested `DockRevealLayer`.
    let dockTravel: CGFloat
    let panelOrigin: CGPoint
    let dockOrigin: CGPoint
    let edgeZone: CGRect
    let isDrawerOpen: Bool
    let dockDrag: DockRevealModel
    let onDockSettle: (Bool) -> Void

    /// The morph in progress — the one thing this layer observes, and the only per-frame
    /// publisher in it.
    @ObservedObject var morph: PresentationMorphModel
    /// Called inside the settle animation with where the morph landed. `true` is full screen.
    let onMorphSettle: (Bool) -> Void

    @ViewBuilder let board: Board
    @ViewBuilder let rail: Rail
    @ViewBuilder let panel: Panel
    @ViewBuilder let dock: Dock
    @ViewBuilder let fullScreenChat: FullScreenChat
    @ViewBuilder let sidebar: Sidebar
    @ViewBuilder let peek: Peek

    /// The screen-wide suspensions (settings, a context menu) still apply under this layer's
    /// own; overriding the environment without carrying the outer value would drop them.
    @Environment(\.isDrawerPanSuspended) private var isPanSuspendedAbove

    private var isFullScreen: Bool { presentation == .fullScreen }

    /// Where the morph is right now: the live drag if one has committed, the settled
    /// presentation otherwise.
    private var progress: CGFloat { morph.progress ?? (isFullScreen ? 1 : 0) }

    var body: some View {
        ZStack(alignment: .topLeading) {
            boardSlot
            railSlot
            containerBackground
            sidebarSlot
            dockedRegion
            fullScreenRegion
            // Painted last — screen 07's peek is *"painted last, on top of everything"*, and
            // mid-morph it is the incoming half of the board's own crossfade.
            peekSlot
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// The live board card. Mounted in every presentation — tearing down `PKCanvasView`
    /// loses the pan, the zoom and the ink contract — and *translated* through the morph
    /// rather than resized: the card slides off the trailing edge at the same speed the
    /// container's edge chases it, so the two read as one push.
    private var boardSlot: some View {
        board
            .modifier(PresentationMorphRender(
                progress: progress, geometry: geometry, role: .board, origin: boardOrigin
            ))
            // The rest-state rule (`!isFullScreen`, exactly what `BoardScreen` always
            // applied) plus the gesture's own: nothing under a morph takes new touches.
            .allowsHitTesting(!isFullScreen && !morph.isActive)
    }

    /// The tool rail: its settled mounts are unchanged, and it stays mounted through a morph
    /// so the shrinking container has something real to reveal — the container covers its
    /// lane within the first tenth of the travel going up, and uncovers it in the last tenth
    /// coming back.
    @ViewBuilder
    private var railSlot: some View {
        if !isFullScreen || morph.isActive {
            rail
        }
    }

    /// The morphing container itself: the pane's white, with the panel's own fill dissolving
    /// out of it across the travel. Mounted only while a morph is in flight — at either rest
    /// the surface underneath it (the panel's own fill, the chat pane's own white) is already
    /// exactly what this would draw, so it can leave without a seam.
    ///
    /// It casts no shadow, deliberately: a shadow rasterises its input per frame, and this
    /// shape changes per frame. The panel's elevation is a static-shaped underlay in
    /// `dockedRegion`, fading on its own early curve — see `PresentationMorph.shadowGoneBy`.
    @ViewBuilder
    private var containerBackground: some View {
        if morph.isActive {
            let shape = PresentationMorphContainerShape(progress: progress, geometry: geometry)
            ZStack(alignment: .topLeading) {
                shape.fill(DS.Color.surface)
                shape.fill(DS.Color.surfacePanel)
                    .opacity(geometry.panelFillOpacity(at: progress))
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            // For the button paths, which insert this mid-transaction: a swipe mounts it at
            // commitment, un-animated, and never runs the transition.
            .transition(.opacity)
        }
    }

    /// Board 19's sidebar, mounted beneath the chat surface and folded in and out by the
    /// morph. Its flag — and so its next full-screen visit — is untouched; see
    /// `PresentationMorph.sidebarShift(at:)`.
    @ViewBuilder
    private var sidebarSlot: some View {
        if isSidebarOpen, isFullScreen || morph.isActive {
            sidebar
                .modifier(PresentationMorphRender(
                    progress: progress, geometry: geometry, role: .sidebar, origin: sidebarOrigin
                ))
                .allowsHitTesting(isFullScreen && !morph.isActive)
                // The toggle's own open/close, exactly as it animated inside
                // `TutorFullScreen` before the slot moved here.
                .transition(.move(edge: .leading))
        }
    }

    /// Screens 05, 06 and 08: the nested `DockRevealLayer`, with the panel wearing the
    /// morph's clip and fade, and the panel's elevation extracted to a static-shaped underlay
    /// so no shadow ever rasterises animating content.
    ///
    /// The underlay rides *inside* the dock layer's panel slot, so a collapse drag carries
    /// the shadow with the panel exactly as the surface's own used to. At rest the pair is
    /// pixel-identical to `TutorPanelSurface`'s original arrangement: the same shape, the
    /// same fill, the same two elevation layers, behind the same clipped content.
    @ViewBuilder
    private var dockedRegion: some View {
        if !isFullScreen || morph.isActive {
            DockRevealLayer(
                travel: dockTravel,
                panelOrigin: panelOrigin,
                dockOrigin: dockOrigin,
                edgeZone: edgeZone,
                isDocked: presentation != .collapsed,
                isDrawerOpen: isDrawerOpen,
                drag: dockDrag,
                onSettle: onDockSettle,
                morph: morph,
                morphTravel: geometry.travel,
                onMorphSettle: onMorphSettle
            ) {
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: TutorPanelMetrics.cornerRadius)
                        .fill(DS.Color.surfacePanel)
                        .frame(
                            width: geometry.dockedFrame.width,
                            height: geometry.dockedFrame.height
                        )
                        .compositingGroup()
                        .elevation(.panel)
                        .modifier(PresentationMorphRender(
                            progress: progress, geometry: geometry, role: .panelShadow
                        ))
                        .accessibilityHidden(true)
                    panel
                        .modifier(PresentationMorphRender(
                            progress: progress, geometry: geometry,
                            role: .dockedChat, origin: panelOrigin
                        ))
                }
            } dock: {
                dock
            }
            // A morph in flight owns every touch. New button presses are refused here, and
            // the pan regions inside — the drawer's, the panel's — are suspended at
            // touch-down; the committing touch itself was received before the flag went up,
            // so the gesture that is driving the morph keeps its stream.
            .environment(\.isDrawerPanSuspended, isPanSuspendedAbove || morph.isActive)
            .allowsHitTesting(!morph.isActive)
            .transition(.opacity)
        }
    }

    /// Screen 07's chat: the column, its composer, its toggle — everything the full-screen
    /// surface draws except the sidebar and the peek, which morph on their own curves.
    @ViewBuilder
    private var fullScreenRegion: some View {
        if isFullScreen || morph.isActive {
            fullScreenChat
                .modifier(PresentationMorphRender(
                    progress: progress, geometry: geometry, role: .fullScreenChat
                ))
                .environment(\.isDrawerPanSuspended, isPanSuspendedAbove || morph.isActive)
                .allowsHitTesting(!morph.isActive)
                // For the buttons, not the swipes: `btn/full-screen` and the peek's tap
                // insert this slot in the same transaction that starts the spring, and a
                // freshly inserted view has no previous frame for the animatable render to
                // interpolate from. The transition supplies the missing "from"; a swipe
                // mounts the slot at commitment, un-animated, and the curves do the rest.
                .transition(.opacity)
        }
    }

    /// The board peek — the artwork screen 07 draws where the board card used to be, and the
    /// incoming half of the board's crossfade during the morph.
    @ViewBuilder
    private var peekSlot: some View {
        if isFullScreen || morph.isActive {
            peek
                .modifier(PresentationMorphRender(
                    progress: progress, geometry: geometry, role: .peek
                ))
                .allowsHitTesting(isFullScreen && !morph.isActive)
                .transition(.opacity)
        }
    }
}
