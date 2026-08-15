import SwiftUI

// The app-side glue of the live-voice UI. The voice bar itself is not a view
// of its own: board 28's bar is the composer pill with a different trailing
// pair, so it lives inside `Composer` as the `ComposerVoiceCall` mode — one
// pill, one metrics system, and the attachment cards, notes and menu anchor
// all keep working for free. What this file holds is everything around it:
// the engine's owner, the thread-side value, and the mascot's stage.

/// The screen's handle on the voice engine.
///
/// `BoardScreen` owns one of these for the life of the screen, which is what
/// keeps a call alive across every presentation switch. It publishes only the
/// rare facts — live, muted — so the screen re-renders on a tap and never on a
/// level: the 10 Hz display stream stays on the engine's own
/// `VoiceDisplayProvider`, observed by nothing above the mascot itself.
@MainActor
final class VoiceSessionHost: ObservableObject {
    /// True from the voice disc's tap until the call ends — the one fact the
    /// composer, the thread and the screen branch on. Held here rather than
    /// read off the engine because the protocol's `isActive` is not
    /// observable, and observing the display provider from screen level is
    /// exactly what its 10 Hz publisher exists to prevent.
    @Published private(set) var isLive = false
    /// Mirrors the engine's mute so the bar's toggle re-renders on the tap.
    /// The engine's watchdog re-asserts mute rather than clearing it (the
    /// UplinkGuard pattern), so the mirror cannot drift the dangerous way.
    @Published private(set) var isMuted = false
    /// True between the model's `step_back` and the mascot's tap — board 31's work mode.
    ///
    /// Mirrored off the engine's display through `VoiceDisplayProvider.onPhaseChange`
    /// rather than observed: rest is a rare fact, and the three surfaces that branch on it
    /// (the thread's chip, the composer's mic button, the typed-send route) must not
    /// re-render at the display's 10 Hz to learn it.
    @Published private(set) var isResting = false
    /// The session the call was started in, for the whole life of the call.
    ///
    /// A call is bound to its session and survives the learner switching away
    /// to browse — this is what the pill points back at, what the store pins
    /// delegated turns and transcripts to, and what tells the voice disc in
    /// another session that it must end this call before starting its own.
    /// `nil` whenever no call is live.
    @Published private(set) var callSessionID: UUID?
    /// The call session's title as it read when the call began — the pill's
    /// label. A session named by its first turn can be renamed under the pill;
    /// the screen prefers the store's live row and falls back to this.
    @Published private(set) var callSessionTitle = ""

    /// **The one door the rest of the app learns a call is over through**, with
    /// the session it belonged to — the X disc, a start that could not come up,
    /// or a call replaced by one started somewhere else.
    ///
    /// A callback rather than the screen watching `isLive`: it fires
    /// synchronously, exactly once, *before* any next call can be begun, and
    /// the ordering is what the deferred close depends on. A SwiftUI `onChange`
    /// runs on the next view update, by which time a replacement call may
    /// already have bound the host to another session — and the ending would
    /// then be reported against the wrong one.
    var onCallEnded: ((UUID) -> Void)?

    /// `nil` on a build with no backend configuration — the same builds that
    /// have no live tutor. The voice disc never appears then; the composer is
    /// exactly what it was before voice existed.
    private let engine: (any VoiceSessionControlling)?
    /// What `display` hands out when there is no engine: a provider forever at
    /// `.idle`, so no caller has to branch on availability to draw.
    private let idleDisplay = VoiceDisplayProvider()

    /// **The real engine's one construction site.** Previews and UI tests
    /// pass `ScriptedVoiceEngine()` instead — the simulator cannot run
    /// WebRTC, and the scripted engine plays the phases without it.
    init(engine: (any VoiceSessionControlling)? = nil) {
        if let engine {
            self.engine = engine
        } else if let configuration = BackendConfiguration.load() {
            self.engine = VoiceSessionCoordinator(configuration: configuration)
        } else {
            self.engine = nil
        }
        // After every stored property is set, so capturing `self` is legal here.
        self.engine?.display.onPhaseChange = { [weak self] phase in
            guard let self else { return }
            let resting = phase == .resting
            // Guarded: `@Published` fires on every set, and the phase changes many times a
            // call for reasons work mode does not care about.
            if self.isResting != resting { self.isResting = resting }
        }
    }

    /// Whether this build can hold a call at all — what gates the voice disc.
    var isAvailable: Bool { engine != nil }

    var display: VoiceDisplayProvider { engine?.display ?? idleDisplay }

    func begin(
        sessionID: UUID,
        sessionTitle: String = "",
        voiceModel: VoiceModelChoice,
        hooks: VoiceSessionHooks
    ) {
        guard let engine, !isLive else { return }
        isLive = true
        isMuted = false
        // Recorded before the engine starts, so the first hook to arrive
        // already finds the call bound to its session.
        callSessionID = sessionID
        callSessionTitle = sessionTitle
        Task { [weak self] in
            await engine.start(sessionID: sessionID, voiceModel: voiceModel, hooks: hooks)
            // A start that could not bring the call up leaves the engine
            // inactive; fold the bar away rather than stranding a dead call's
            // chrome over a working composer.
            guard let self else { return }
            if !engine.isActive {
                self.isLive = false
                self.foldCallSession()
            }
        }
    }

    /// End the call. The engine plays its own ending state (~1 s) and closes
    /// the connection inside `end()`; the bar folds when it returns, which is
    /// the spec's order — the mascot exhales, then the composer comes back.
    func finish() async {
        guard let engine, isLive else { return }
        await engine.end()
        isLive = false
        isMuted = false
        foldCallSession()
    }

    /// Forgets the call's session and reports the ending, once, in that order.
    private func foldCallSession() {
        let ended = callSessionID
        callSessionID = nil
        callSessionTitle = ""
        if let ended { onCallEnded?(ended) }
    }

    /// Whether a call is live in a session other than `sessionID` — the voice
    /// disc's question before it starts one here. One call at a time, app-wide.
    func isCallElsewhere(than sessionID: UUID) -> Bool {
        isLive && callSessionID != nil && callSessionID != sessionID
    }

    /// **Whether the call's chrome belongs on a screen showing `sessionID`** —
    /// the mascot on the thread's tail, the voice bar's mic and X disc, the dock
    /// orb's live face, board 31's resting chip.
    ///
    /// `isLive` alone answered this before the call could outlive a session
    /// switch, and it is wrong the moment it can: a learner browsing another
    /// session was handed the call session's whole voice surface — a composer
    /// with no send disc, whose typed words went to the call rather than to the
    /// thread on screen. The call in another session is marked by the pill and
    /// by nothing else.
    ///
    /// The exact complement of `CallPill.isVisible(isLive:callSessionID:visibleSessionID:)`,
    /// including the case that cannot happen: a live call with no session id
    /// draws its chrome here rather than nowhere, because a call with no pill
    /// and no chrome is a call with no way to end it.
    func isCallHere(in sessionID: UUID) -> Bool {
        Self.callChromeBelongs(
            isLive: isLive, callSessionID: callSessionID, visibleSessionID: sessionID
        )
    }

    /// The rule of `isCallHere(in:)` as a value, so it can be read and tested
    /// beside the pill's own.
    static func callChromeBelongs(
        isLive: Bool, callSessionID: UUID?, visibleSessionID: UUID
    ) -> Bool {
        guard isLive else { return false }
        guard let callSessionID else { return true }
        return callSessionID == visibleSessionID
    }

    func toggleMuted() {
        guard let engine else { return }
        isMuted.toggle()
        engine.setMuted(isMuted)
    }

    func sendTyped(_ text: String) {
        engine?.sendTyped(text)
    }

    /// The mascot's tap. Only work mode answers it; every other phase ignores it, so the
    /// caller never has to ask which phase it is in.
    func wake() {
        engine?.wake()
    }
}

/// The live call as the thread draws it: which display to animate from, which
/// mascot variant the surface takes, and the stage band the boards give it.
struct VoiceThreadState {
    let display: VoiceDisplayProvider
    let variant: MascotVariant
    /// The band the mascot occupies in the thread's flow — it is a thread
    /// child, so the flow reserves its height and the halo overflows freely.
    let stageHeight: CGFloat
    /// Board 31's work mode. A plain value, not an observation: the screen
    /// mirrors the phase off `VoiceSessionHost.isResting`, so the thread
    /// re-renders when the tutor steps back and never per frame.
    var isResting: Bool = false
    /// The mascot's tap. A no-op outside `.resting` by the engine's own rule.
    var onWake: () -> Void = {}

    /// Board 28: the 72pt face on a 120pt stage in the panel's thread.
    static func panel(
        display: VoiceDisplayProvider,
        isResting: Bool = false,
        onWake: @escaping () -> Void = {}
    ) -> Self {
        Self(display: display, variant: .panel, stageHeight: 120, isResting: isResting, onWake: onWake)
    }

    /// Board 29: the 120pt face on a 200pt stage in the reading column.
    static func fullScreen(
        display: VoiceDisplayProvider,
        isResting: Bool = false,
        onWake: @escaping () -> Void = {}
    ) -> Self {
        Self(display: display, variant: .fullScreen, stageHeight: 200, isResting: isResting, onWake: onWake)
    }
}

/// The mascot on its stage, centred in the thread's column — board 28's tail
/// child, in the thread orb's place. `VoiceMascotView` (the mascot package)
/// observes the 10 Hz display itself, so the thread never re-renders per
/// frame; this stage only reserves the flow band the boards draw. The halo
/// deliberately overflows it — the thread's bleed clip is what keeps overflow
/// legal there, exactly as it does for the orb's own glow.
struct VoiceMascotStage: View {
    let state: VoiceThreadState
    let width: CGFloat

    var body: some View {
        VoiceMascotView(display: state.display, variant: state.variant)
            .frame(width: width, height: state.stageHeight)
            // The whole stage is the wake target, not the 72pt face: board 31's
            // affordance is "tap the tutor", and a resting mascot is a small,
            // dim mark to aim at. A tap never travels the 12 points
            // `DrawerPanRecognizer` commits on, so the drawer's pan leaves it
            // alone — no hit-testing guard is involved, or wanted.
            .contentShape(Rectangle())
            .onTapGesture { state.onWake() }
    }
}

// MARK: - The resting chip

/// Board 31's `chip/resting`: what the thread says while the tutor is quiet.
///
/// It takes the step chip's slot — the one line above the mascot that otherwise carries
/// `ThinkingIndicator`'s "Drawing on the board" — because nothing else is running: work
/// mode is the absence of activity, and two marks about what the tutor is doing would
/// contradict each other.
///
/// It is a `Button` as well as a label so VoiceOver has the wake affordance: the mascot
/// itself is `accessibilityHidden` (it is a face, not a control), and the tap on it is a
/// gesture no assistive technology can find.
struct VoiceRestingChip: View {
    let onWake: () -> Void

    /// Board 31's copy, verbatim.
    static let label = "Resting — tap to wake"

    /// The moon, 14 × 14, drawn from board 31's own `d` — one path, stroked at 1.4,
    /// unfilled. Not an `Icon` case: the design set is the twenty-two product glyphs
    /// exported from `design/icons.json`, and a mark that exists on one board is not one
    /// of them. It still renders through the icon machinery (`IconElementShape` scales a
    /// viewBox exactly as every glyph does), so it cannot drift from how icons are drawn.
    private static let viewBox = CGSize(width: 14, height: 14)
    private static let glyphSize: CGFloat = 14
    private static let strokeWidth: CGFloat = 1.4
    private static let moon = IconElement(
        geometry: .path("M11.5 8.8a5 5 0 0 1-6.3-6.3 5 5 0 1 0 6.3 6.3z"),
        isFilled: false,
        isStroked: true,
        lineCap: .round,
        lineJoin: .round,
        dash: nil,
        designStrokeWidth: strokeWidth
    )

    var body: some View {
        Button(action: onWake) {
            HStack(spacing: DS.Space.s2) {
                IconElementShape(element: Self.moon, viewBox: Self.viewBox)
                    .stroke(
                        DS.Color.brand,
                        style: StrokeStyle(lineWidth: Self.strokeWidth, lineCap: .round, lineJoin: .round)
                    )
                    .frame(width: Self.glyphSize, height: Self.glyphSize)
                    .accessibilityHidden(true)

                // The scale has no 14: `--text-label` 15 / 18 · 600 is the smallest size in
                // the product and the nearest step to board 31's 14, so the chip takes the
                // token rather than opening a size below the floor for one label.
                Text(verbatim: Self.label)
                    .textStyle(.label)
                    .foregroundStyle(DS.Color.brand)
                    .lineLimit(1)
            }
            .padding(.horizontal, DS.Space.s3)
            .frame(height: DS.Leading.control + DS.Space.s2)
            .background(DS.Color.surface, in: Capsule())
            .elevation(.control)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Resting")
        .accessibilityHint("Wakes the tutor")
    }
}

// MARK: - Previews (scripted engine only — WebRTC cannot run here)

#if DEBUG
#Preview("Voice call · panel") {
    let engine = ScriptedVoiceEngine()
    return VStack(spacing: DS.Space.s6) {
        VoiceMascotStage(state: .panel(display: engine.display), width: 301)
        // The bar live, then muted, then the resting composer with the voice
        // disc in the send slot (board 27).
        Composer(
            scale: .panel,
            text: .constant(""),
            onSend: {},
            voice: ComposerVoiceCall(
                isMuted: false, onToggleMute: {}, onEnd: {}, onSendTyped: { _ in }
            )
        )
        Composer(
            scale: .panel,
            text: .constant(""),
            onSend: {},
            voice: ComposerVoiceCall(
                isMuted: true, onToggleMute: {}, onEnd: {}, onSendTyped: { _ in }
            )
        )
        Composer(scale: .panel, text: .constant(""), onSend: {}, onVoiceChat: {})
    }
    .padding(DS.Space.s6)
    .background(DS.Color.surfacePanel)
}

/// Board 31, static: the chip in the step chip's slot, the resting mascot under it, and
/// the bar with `btn/mic-mute` at 0.45. The scripted engine's own `.rests` beat plays the
/// same thing live — see `ScriptedVoiceEngine.demoScript`.
#Preview("Voice work mode · panel") {
    let display = VoiceDisplayProvider()
    display.state = VoiceDisplayState(phase: .resting)
    return VStack(spacing: DS.Space.s6) {
        VoiceRestingChip(onWake: {})
        VoiceMascotStage(state: .panel(display: display, isResting: true), width: 301)
        Composer(
            scale: .panel,
            text: .constant(""),
            onSend: {},
            voice: ComposerVoiceCall(
                isMuted: false, onToggleMute: {}, onEnd: {}, onSendTyped: { _ in }, isResting: true
            )
        )
    }
    .padding(DS.Space.s6)
    .background(DS.Color.surfacePanel)
}
#endif
