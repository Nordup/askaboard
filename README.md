# Math Tutor iPad MVP

Math Tutor is a SwiftUI/PencilKit iPad app for learning math by writing and talking through the next step. An infinite Apple Pencil board sits between a tool rail and a docked tutor, and the tutor can look at the student's actual handwriting and coach the next smallest useful move.

It is built from a finished design system rather than styled by hand. The design lives in Paper; [`docs/design-system/`](docs/design-system/) is its exact transcription, [`design/`](design/) is the machine-readable export that the token and icon layers are generated from, and [`design/reference/`](design/reference/) holds the four screens at 1×, so the built app can be pixel-diffed against the design instead of eyeballed.

## Generate, build, run

Requirements: Xcode 26.4, Swift 6, XcodeGen 2.45+, and an iPadOS 17+ simulator or device.

```sh
xcodegen generate
xcodebuild -project MathTutor.xcodeproj \
  -scheme MathTutor \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' \
  build

xcodebuild -project MathTutor.xcodeproj \
  -scheme MathTutor \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' \
  test
```

Open `MathTutor.xcodeproj` in Xcode to run on a paired iPad, including devices on iPadOS 17.7.11. If that simulator name is not installed, choose any available iPadOS 17+ destination from `xcrun simctl list devices available`.

## How the app reaches its tutor

**The app holds no OpenAI key and never talks to OpenAI.** It talks to one backend ([`server/`](server/README.md)), which holds the key. There is nothing to set up on the device and no credential surface in the app: the backend's address is a constant in `BackendConfiguration`, not a setting, and the device's own bearer token lives in the Keychain — never in source, the Xcode project, or `UserDefaults`. Settings has two panes, Tutor and Session, and neither of them configures a server. Reasoning effort supports none, low, medium, high, xhigh, and max; new and reset sessions default to high and the selected value is persisted with the session. A deterministic demo tutor is available only through explicit test/debug injection.

### Local dev loop (point a build at a local server)

DEBUG builds can override the address and seed the device token from the launch environment, so a simulator run comes up live against a local backend. Put both in a gitignored `.env.local` at the repo root:

```sh
cat <<'EOF' > .env.local
MATHTUTOR_BACKEND_URL=http://localhost:8080
MATHTUTOR_BACKEND_TOKEN=...
EOF
scripts/run-sim.sh
```

The script builds, installs, and launches on `iPad Pro 13-inch (M5)` (override with `MATHTUTOR_SIM_DEVICE`, skip the build with `SKIP_BUILD=1`), passing both through `SIMCTL_CHILD_MATHTUTOR_BACKEND_URL` and `SIMCTL_CHILD_MATHTUTOR_BACKEND_TOKEN`. The two halves behave differently on purpose. `MATHTUTOR_BACKEND_URL` is a pure override of `BackendConfiguration.permanentBaseURL`, read fresh on every request and never stored — unset it and the build is back on the shipped address. `MATHTUTOR_BACKEND_TOKEN` (or a path in `MATHTUTOR_BACKEND_TOKEN_FILE`) is seeded into the Keychain once by `TutorStore`, so later launches stay live without the environment set. Neither value lives in source or the Xcode project. The whole path is compiled out of release builds, and it is deliberately skipped for `--ui-test-reset` launches so UI tests never inherit a developer credential. To clear a seeded token, relaunch with that argument:

```sh
xcrun simctl terminate booted com.nordup.MathTutor
xcrun simctl launch booted com.nordup.MathTutor --ui-test-reset
```

A turn is one `POST` to the backend, consumed as Server-Sent Events in the backend's own vocabulary rather than the provider's: status, reasoning deltas, text deltas, a workspace pair, and a terminator. `TutorEvent` in `MathTutor/Domain/TutorEvent.swift` is that contract on the client side, and unknown event types decode to `nil` so a backend that adds one does not break an installed app. The plan/exercise pair arrives whole, so a mismatched half-pair is structurally impossible rather than defended against. The board snapshot goes up as a white-backed, size-bounded PNG. Which model answers, what reasoning effort it runs at, retries, and spend controls are the backend's business — see [`server/README.md`](server/README.md). Network failures remain visible and retryable; the app never presents offline fallback as a successful live response.

**Dictation runs over the same backend**, and [`docs/design-system/07-dictation.md`](docs/design-system/07-dictation.md) is its contract, its research and its board. The composer's mic records with `AVAudioEngine` and posts a mono 16-bit WAV — 16 kHz where the audio route accepts that preference, otherwise whatever rate it hands back — to the backend, consuming transcript deltas that **append**, unlike `SFSpeechRecognizer`'s restating partials, and finishing on a terminal event whose text is authoritative over the summed deltas. A stream that ends without that terminator is a failure, not a short transcript — half a sentence a student might not notice is worse than none.

Which transcription model runs, the vocabulary steering a maths recogniser needs so it does not hear "sign" for "sine", and the retry rules all live behind that endpoint now; `server/README.md` documents them.

Because the recording is transcribed after it ends rather than as the student speaks, a session has **two phases**, told apart by where the motion comes from: capturing shows `ui/level`, five bars driven by the live input RMS at 20 Hz, plus an elapsed timer; transcribing shows board 14's thinking dots and the word "Transcribing…". The meter is not decoration — App Store guideline 2.5.14 requires *the app* to indicate recording, and a timer-driven animation would move identically for a working mic, a muted one and a closed Smart Folio. A `ui/cross` in the composer's leading slot cancels either phase, start and stop earcons sound, and the mic button carries `.startsMediaSession`, a magic-tap action, and a constant label with a changing value.

**The audio leaves the iPad**, to the backend and then to a transcription provider. What the backend keeps of it is [`server/README.md`](server/README.md)'s to state; the microphone purpose string in `project.yml` has not been rewritten for the backend and is flagged below. A provider error is never forwarded to the UI: its text can quote what was heard. Whisper-family models fabricate on near-silent audio, so a short boilerplate result ("Thank you.", " you") is treated as silence and never written into the composer as if the student had said it; the transcript always lands in the editable field and is never auto-sent. Without a usable device token there is no dictation at all and the composer draws no mic, because a control that can only raise a notice is the disabled control this design does not have. Recording stops by itself at 60 seconds — about 1.9 MB, well under the endpoint's 25 MB file limit — and transcribes what was said instead of failing the upload.

Assistant replies render through the pinned `MarkdownUI` 2.4.0 Swift package (`Markdown`) with selectable GitHub-Flavored Markdown headings, lists, quotes, tables, code, links, and visible single-newline breaks. Math is requested and displayed as readable Unicode/plain text because the renderer does not render LaTeX math delimiters. Learner messages stay literal text so their punctuation, whitespace, and line breaks are preserved exactly.

## Debug E2E fixture

Debug launches can seed a legible vector PencilKit attempt for the radical-equation evaluation flow. Pass `--ui-test-reset --ui-test-demo-service --e2e-seed-radical-attempt` as launch arguments; the fixture is compiled out of release builds, while the demo-service routing override is DEBUG-only. Both are ignored unless those explicit arguments are present.

## Architecture

Five layers, each depending only on the ones above it. `DesignSystem` knowing nothing about the app is the load-bearing rule — a component that reaches for `TutorStore` is not a component, it is a screen fragment.

| Layer | Contents |
| --- | --- |
| `Domain/` | `Models`, `BoardTool`/`PenColor`/`StrokeThickness`, the tutor prompt policy. No UIKit, no SwiftUI. |
| `Services/` | `TutorService` protocol with `DemoTutorService`, `TutorServiceRouter` (reads `BackendConfiguration` from `UserDefaults` and the Keychain, routes to `BackendTutorService`), `SessionPersistence`, `KeychainStore`, `BackendConfiguration`. `DictationService` protocol with `DictationServiceRouter`, `BackendDictationService` (`AVAudioEngine` records and meters; the configured backend transcribes), and `ScriptedDictationService`, the fake the tests drive. |
| `DesignSystem/` | Generated tokens, the elevation scale, typography, `ScreenLayout`, the icon set, and every component. Depends on nothing. |
| `Features/` | `Board` (the PencilKit engine), `Tutor` (panel, full screen, and `DictationController` behind the composer's mic), `Settings`, `Plan`. |
| `App/` | `MathTutorApp`, `RootView`, `UIState`, DEBUG launch options. |

Two things are generated, not typed by hand, so the code cannot silently drift from the design:

```sh
swift scripts/generate-tokens.swift   # design/tokens.json -> DesignTokens.swift
swift scripts/generate-icons.swift    # design/icons.json  -> IconPaths.swift
```

Both have drift tests that re-run the generator in-process and fail if the checked-in Swift no longer matches the export. The one value carried by hand is the elevation scale — Paper has no shadow token type — and `DesignSystem/Elevation.swift` says so, with the board's own wording beside the numbers.

**UI state is separate from session state, deliberately.** `TutorStore` owns the session; `UIState` owns presentation as two independent axes, `presentation ∈ {docked, collapsed, fullScreen}` × `conversation ∈ {start, active}`. Presentation must not persist or round-trip through the session JSON, and mixing the two is what previously grew the workspace view to 984 lines.

**The board.** A 50,000pt canvas centred at (25,000, 25,000) so panning works in every direction from where a session starts. Evaluation renders every stroke, not the viewport, and when ink is spread over more board than one legible image can hold it crops to the centroid of the strokes' own centres — the bounding box's centre can sit in empty space between two clusters. The app owns tool selection through the design's rail; `PKToolPicker` is gone.

**Typography.** Source Sans 3 is the design's only typeface and iOS does not ship it, so the 400/500/600 weights are bundled. Two conversions in `Typography.swift` are easy to get wrong and are unit-tested: CSS `line-height` is a total line box while SwiftUI's `lineSpacing` is the gap *between* lines, and the design's tracking is in `em` while `.tracking()` takes points.

## Prototype limitations

This pass intentionally has no accounts, cloud sync, automatic continuous change detection, handwriting OCR, or teacher analytics. Evaluation is explicit (the whole board or a dragged rectangle) and sends the rendered PencilKit image only when requested; board evaluation renders the bounding box of every stroke, so scrolling away from a long solution does not truncate what the tutor sees. When ink is scattered over more than 4,000 pt of board — further than one legible image can cover — evaluation crops to the student's work and tells the tutor it is looking at a portion rather than the whole board. *Evaluate board* is disabled while the board is empty. Local session persistence is best effort in Application Support; resetting a session removes the local drawing and messages.

## Backend service

A FastAPI service at [`server/`](server/README.md) is the only path the app has. It holds the one OpenAI key instead of the device, authenticates the device with its own bearer token, streams turns as Server-Sent Events in its own event vocabulary rather than forwarding OpenAI's, and records every message, request, raw provider event stream, board snapshot, and dictation recording — kept indefinitely, not sampled or expiring. See [`server/README.md`](server/README.md) for setup, running it, the event vocabulary, and the retention position in full.

**Open:** the microphone permission string in `project.yml` still describes the pre-backend path — it names OpenAI as the direct recipient and states that no copy of the recording is kept, which the backend's retention position contradicts. It is user-facing permission copy and has deliberately not been rewritten here.

## Manual QA checklist

- Launch: the tutor panel shows the greeting and four suggestion chips with a composer under them. There is no setup screen — the app has no credential to ask for.
- Open Settings and confirm the sidebar lists Tutor and Session only: no key field, no server address, nowhere to point the app at a different backend.
- Tap a suggestion chip and send a typed message; both should move the panel from greeting to thread.
- **Dictation cannot be exercised in the simulator** — there is no usable microphone input, so the service reports `.audioUnavailable` and a mic tap ends in the "Dictation isn't available right now" notice. That is the simulator behaving, not a bug; check the feature on a real iPad.
- With no device token there is no mic at all in the composer, because dictation runs over the same backend configuration the tutor does. Relaunch with `--ui-test-reset` to clear the token and confirm the mic is gone; relaunch through `scripts/run-sim.sh` to seed it again and confirm the mic returns.
- On device: tap the mic and confirm the level meter in the text lane moves with your voice — cover the mic and confirm it collapses to five dots, which is the check that it is real and not an animation. Tap again and confirm the lane becomes the thinking dots and "Transcribing…", then the words arrive about a second later, trailed by the streaming caret. Anything you had already typed stays ahead of them. Refuse the permission and confirm the next tap raises an alert with an Open Settings route rather than a dead button.
- Tap the leading cross during each phase and confirm the recording is discarded, typed text survives, and nothing lands afterwards.
- Tap the mic and say nothing, and confirm the line "I didn't catch anything that time." appears above the composer rather than a fabricated "Thank you." in the field.
- Hold the mic open for a minute and confirm the elapsed label reaches 1:00, the recording ends itself, and it transcribes what was said rather than failing.
- With VoiceOver on: the mic reads as "Dictate" with value "Recording"/"Transcribing" rather than renaming itself, a two-finger double tap starts and stops it, and VoiceOver's own speech does not go into the recording.
- Write with Apple Pencil. Note `drawingPolicy` is `.pencilOnly` by design — **finger drawing does not work, including in the simulator**, because finger gestures pan and zoom the board. Seed ink with `--e2e-seed-radical-attempt` to check the board without a Pencil.
- Exercise the rail: all four tools, all five inks, and the highlighter over existing ink (it should stay translucent). Undo and redo with two- and three-finger taps.
- Pan far from the origin, write there, then tap centre-on-work and confirm it returns to your ink. Reopen the session and confirm it opens on that ink, not blank board.
- Collapse the tutor, attach the board with the dock's select control, and send it. Confirm the tutor's reply refers to what you actually drew.
- Evaluate work containing a highlighter stroke and confirm the tutor is not sent a black bar over the working.
- Full screen and back via the board peek; Settings and back via the dock control.
- Confirm the app is landscape-only and that Settings, the plan and every transient state use the same design language as the four main screens.

### Checking the build against the design

`design/reference/screen-0*.png` are the four screens exported at 1×. A simulator screenshot is 2× and, because the framebuffer stays portrait-shaped, comes out a quarter-turn rotated — rotate and halve it before comparing. Launch a specific state with the DEBUG arguments `--ui-state docked-start|collapsed|fullscreen-start|docked-active`, plus `--ui-fixture` for the boards' own copy and `--ui-freeze` to stop animation, or the diff will be dominated by text reflow and motion rather than by layout.

Two differences are expected and deliberate: the boards' handwritten board ink is an SVG asset with no ported equivalent, and the status bar's Wi-Fi and battery glyphs are OS chrome the icon board marks "DO NOT SHIP".
