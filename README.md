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

Open `MathTutor.xcodeproj` in Xcode to run on a paired iPad, including devices on iPadOS 17.7.11. If that simulator name is not installed, choose any available iPadOS 17+ destination from `xcrun simctl list devices available`. To install on an iPad from the command line, see [Install on a paired iPad](#install-on-a-paired-ipad).

### Install on a paired iPad

`scripts/run-sim.sh` builds for a simulator only. An iPad needs a different destination and `devicectl` instead of `simctl`. First read the device identifier:

```sh
xcrun devicectl list devices
```

Then sync the token, build, install, and launch. The sync step is not optional: the token is compiled in, so a build without it installs and runs but cannot reach the backend — see [The device token](#the-device-token).

```sh
scripts/sync-backend-config.sh
xcodebuild -project MathTutor.xcodeproj \
  -scheme MathTutor \
  -configuration Debug \
  -destination 'platform=iOS,id=<UDID>' \
  -derivedDataPath build/DerivedData \
  -allowProvisioningUpdates \
  build

xcrun devicectl device install app --device <UDID> \
  build/DerivedData/Build/Products/Debug-iphoneos/MathTutor.app
xcrun devicectl device process launch --device <UDID> com.nordup.MathTutor
```

**Unlock the iPad first.** A locked device fails the install with `Could not get service com.apple.remote.installcoordination_proxy`, error 83. That message does not name the lock, and the build is not at fault. Developer Mode must also be on, at Settings > Privacy & Security > Developer Mode.

**Attach a cable if you can.** With no cable the transport is `localNetwork`, and that link drops the device services. `devicectl device info processes` then fails with "Couldn't get the message from the device", and an install can fail once and succeed on the next attempt. Retry before you look for a cause in the build. A launch that reports success is not proof the app stayed alive, because the process listing is the part that fails — look at the iPad.

**A device build has no base URL override.** `MATHTUTOR_BACKEND_URL` reaches the app only when a process launches it, so it does nothing for an icon tap. The iPad uses `BackendConfiguration.permanentBaseURL`, which is a tailnet address, and the iPad must be on that tailnet to reach it. Confirm the backend answers before you debug the app:

```sh
curl -sk -o /dev/null -w '%{http_code}\n' https://air.tail27c2bc.ts.net:8443/v1/turn   # 405 means the route is live
```

## How the app reaches its tutor

**The app holds no OpenAI key and never talks to OpenAI.** It talks to one backend ([`server/`](server/README.md)), which holds the key. There is nothing to set up on the device and no credential surface in the app: the backend's address is a constant in `BackendConfiguration`, not a setting, and the device's own bearer token is compiled in from a gitignored xcconfig — never in source, in git, or in `UserDefaults`. Settings has two panes, Tutor and Session, and neither of them configures a server. Reasoning effort supports none, low, medium, high, xhigh, and max; new and reset sessions default to high and the selected value is persisted with the session. A deterministic demo tutor is available only through explicit test/debug injection.

### The device token

**It is compiled in, not injected at launch.** Launch injection only works when something starts the app *with* those variables — Xcode, `devicectl`, `scripts/run-sim.sh`. Tap the icon on the Home screen and there is no launching process to read them from, in Debug or in Release, so a build installed on an iPad could never reach the backend at all. A build the user taps has to already contain its credential.

Put it in a gitignored `.env.local` at the repo root and run the sync script, which writes `MathTutor/Config/Backend.local.xcconfig` — also gitignored, and the only place in the repo tree the token lands:

```sh
cat <<'EOF' > .env.local
MATHTUTOR_BACKEND_TOKEN=...
MATHTUTOR_BACKEND_URL=http://localhost:8080   # optional, DEBUG only
EOF
scripts/sync-backend-config.sh
```

Then build normally. `MathTutor/Config/Backend.xcconfig` is committed, holds no secret, and `#include?`s the local file — the optional form, so a clean checkout with no credentials still builds. It just carries an empty token, `BackendConfiguration.load()` returns `nil`, and the app runs without being able to reach a tutor. `TutorStore` clears both credentials older builds kept in the Keychain (the OpenAI key, and the seeded device token) on every launch, release included.

The **base URL is deliberately not** in the xcconfig: an xcconfig value runs to the end of the line and `//` starts a comment anywhere on it, so `https://host` would be stored as `https:`. It is a constant in `BackendConfiguration` instead. A DEBUG launch can still override it — `MATHTUTOR_BACKEND_URL` in the environment, read fresh per request and never stored — which is what points a simulator run at a local server.

### Local dev loop

```sh
scripts/run-sim.sh
```

It runs `sync-backend-config.sh` for you, then builds, installs, and launches on `iPad Pro 13-inch (M5)` (override with `MATHTUTOR_SIM_DEVICE`, skip the build with `SKIP_BUILD=1`), passing `MATHTUTOR_BACKEND_URL` through as `SIMCTL_CHILD_MATHTUTOR_BACKEND_URL` so the run points at your local server. `--ui-test-reset` makes `BackendConfiguration.load()` return `nil` regardless of what is compiled in, so a UI test can never reach the real backend on your credential:

```sh
xcrun simctl terminate booted com.nordup.MathTutor
xcrun simctl launch booted com.nordup.MathTutor --ui-test-reset
```

A turn is one `POST` to the backend, consumed as Server-Sent Events in the backend's own vocabulary rather than the provider's: status, reasoning deltas, text deltas, a workspace pair, and a terminator. `TutorEvent` in `MathTutor/Domain/TutorEvent.swift` is that contract on the client side, and unknown event types decode to `nil` so a backend that adds one does not break an installed app. The plan/exercise pair arrives whole, so a mismatched half-pair is structurally impossible rather than defended against. The board snapshot goes up as a white-backed, size-bounded PNG. Which model answers, what reasoning effort it runs at, retries, and spend controls are the backend's business — see [`server/README.md`](server/README.md). Network failures remain visible and retryable; the app never presents offline fallback as a successful live response.

**Dictation runs over the same backend**, and [`docs/design-system/07-dictation.md`](docs/design-system/07-dictation.md) is its contract, its research and its board. The composer's mic records with `AVAudioEngine` and posts a mono 16-bit WAV — 16 kHz where the audio route accepts that preference, otherwise whatever rate it hands back — to the backend, consuming transcript deltas that **append**, unlike `SFSpeechRecognizer`'s restating partials, and finishing on a terminal event whose text is authoritative over the summed deltas. A stream that ends without that terminator is a failure, not a short transcript — half a sentence a student might not notice is worse than none.

Which transcription model runs, the vocabulary steering a maths recogniser needs so it does not hear "sign" for "sine", and the retry rules all live behind that endpoint now; `server/README.md` documents them.

Because the recording is transcribed after it ends rather than as the student speaks, a session has **two phases**, told apart by where the motion comes from: capturing shows `ui/level`, five bars driven by the live input RMS at 20 Hz, plus an elapsed timer; transcribing shows board 14's thinking dots and the word "Transcribing…". The meter is not decoration — App Store guideline 2.5.14 requires *the app* to indicate recording, and a timer-driven animation would move identically for a working mic, a muted one and a closed Smart Folio. A `ui/cross` in the composer's leading slot cancels either phase, start and stop earcons sound, and the mic button carries `.startsMediaSession`, a magic-tap action, and a constant label with a changing value.

**The audio leaves the iPad**, to the backend and then to OpenAI's transcription endpoint. What the backend keeps of it is [`server/README.md`](server/README.md)'s to state. A provider error is never forwarded to the UI: its text can quote what was heard. Whisper-family models fabricate on near-silent audio, so a short boilerplate result ("Thank you.", " you") is treated as silence and never written into the composer as if the student had said it; the transcript always lands in the editable field and is never auto-sent. Without a usable device token there is no dictation at all and the composer draws no mic, because a control that can only raise a notice is the disabled control this design does not have. Recording stops by itself at 60 seconds — about 1.9 MB, well under the endpoint's 25 MB file limit — and transcribes what was said instead of failing the upload.

Assistant replies render through the pinned `MarkdownUI` 2.4.0 Swift package (`Markdown`) with selectable GitHub-Flavored Markdown headings, lists, quotes, tables, code, links, and visible single-newline breaks. Math is requested and displayed as readable Unicode/plain text because the renderer does not render LaTeX math delimiters. Learner messages stay literal text so their punctuation, whitespace, and line breaks are preserved exactly.

### Attachments

The composer's `+` attaches a photo — library or camera — or a file, and **the device converts nothing**: it uploads the raw bytes to `POST /v1/attachments`, and the server decides what the file actually is from its own bytes rather than its extension. Three rungs reach the model: an image becomes a normalised JPEG (`input_image`), a PDF passes through untouched (`input_file`), and text is decoded and quoted line by line (`input_text`). The server stores both the original and the converted bytes and hands back a thumbnail; the turn then carries `attachment_ids`, not bytes.

So the app holds no format knowledge, no PDF library, and no original files. It keeps one small JPEG thumbnail per sent attachment in `Application Support/MathTutor/Attachments/Thumbnails/`, deleted with the session it belongs to, and never keeps an original.

Word, Pages, and the rest are refused with a sentence telling the learner to send a PDF instead or take a photo. Reading them means converting them with the layout intact — which for a maths worksheet *is* the content — through a headless LibreOffice subprocess: a ~1GB binary and a process of its own, for a format one tap already exports a PDF from. See `server/app/attachments/kinds.py` for the reasoning in full, and [`server/README.md`](server/README.md) for the wire contract, the refusal statuses, and the caps.

## Debug E2E fixture

Debug launches can seed a legible vector PencilKit attempt for the radical-equation evaluation flow. Pass `--ui-test-reset --ui-test-demo-service --e2e-seed-radical-attempt` as launch arguments; the fixture is compiled out of release builds, while the demo-service routing override is DEBUG-only. Both are ignored unless those explicit arguments are present.

For visual QA of the semantic scene, add `--e2e-seed-tutor-scene` (DEBUG-only):
it seeds every tutor primitive in one iPad viewport: a labelled triangle and
angle marker, circle and radius, force/vector components, a >180° arc, text,
line/polyline/freehand marks, and hint/correction/emphasis callouts without a
live API.

## Architecture

Five layers, each depending only on the ones above it. `DesignSystem` knowing nothing about the app is the load-bearing rule — a component that reaches for `TutorStore` is not a component, it is a screen fragment.

| Layer | Contents |
| --- | --- |
| `Domain/` | `Models`, `BoardTool`/`PenColor`/`StrokeThickness`, the tutor prompt policy. No UIKit, no SwiftUI. |
| `Services/` | `TutorService` protocol with `DemoTutorService`, `TutorServiceRouter` (reads `BackendConfiguration` — a constant address and a compiled-in token — and routes to `BackendTutorService`), `SessionPersistence`, `KeychainStore` (deletes what older builds stored; nothing writes credentials now), `BackendConfiguration`. `DictationService` protocol with `DictationServiceRouter`, `BackendDictationService` (`AVAudioEngine` records and meters; the configured backend transcribes), and `ScriptedDictationService`, the fake the tests drive. |
| `DesignSystem/` | Generated tokens, the elevation scale, typography, `ScreenLayout`, the icon set, and every component. Depends on nothing. |
| `Features/` | `Board` (the PencilKit engine), `Tutor` (panel, full screen, and `DictationController` behind the composer's mic), `Settings`, `Plan`. |
| `App/` | `MathTutorApp`, `RootView`, `UIState`, DEBUG launch options. |

### Sessions

A session is one board and one chat: its ink, the tutor's semantic scene, the whole thread, its plan and exercise, and the model and reasoning effort it runs at. There can be several, and the panel's header names the open one — tapping that name drops board 15a's switcher, six recents above a *New session* row.

They live in `Application Support/MathTutor/Sessions/<id>.json`, one file each, with an `index.json` beside them holding a `SessionSummary` per session and the id of the one open last. **The index is a cache, not the record**: every summary in it is derivable from the session file it names, `rebuildIndex()` does exactly that, and a session file with no index entry is recovered rather than orphaned. It exists so drawing the switcher costs one small read instead of loading every board.

A session's name is derived, never stored — the tutor's `SessionPlan.title` cut at its first comma, else the learner's own opening line, else "New session" — so there is no naming step in front of a learner and nothing to keep in sync. A build that predates this layout is migrated once on first launch: `session.json` is copied in, then removed.

Switching cancels any turn in flight and saves the board before swapping it. What the switcher still cannot do — delete, rename, reach session seven — is written down in [`docs/TODO.md`](docs/TODO.md).

Two things are generated, not typed by hand, so the code cannot silently drift from the design:

```sh
swift scripts/generate-tokens.swift   # design/tokens.json -> DesignTokens.swift
swift scripts/generate-icons.swift    # design/icons.json  -> IconPaths.swift
```

Both have drift tests that re-run the generator in-process and fail if the checked-in Swift no longer matches the export. The one value carried by hand is the elevation scale — Paper has no shadow token type — and `DesignSystem/Elevation.swift` says so, with the board's own wording beside the numbers.

**UI state is separate from session state, deliberately.** `TutorStore` owns the session; `UIState` owns presentation as two independent axes, `presentation ∈ {docked, collapsed, fullScreen}` × `conversation ∈ {start, active}`. Presentation must not persist or round-trip through the session JSON, and mixing the two is what previously grew the workspace view to 984 lines.

**The board.** A 50,000pt canvas centred at (25,000, 25,000) so panning works in every direction from where a session starts. Evaluation renders every stroke, not the viewport, and when ink is spread over more board than one legible image can hold it crops to the centroid of the strokes' own centres — the bounding box's centre can sit in empty space between two clusters. The app owns tool selection through the design's rail; `PKToolPicker` is gone.

**Tutor-authored content is a separate semantic scene.** Learner handwriting stays
PencilKit ink. What the tutor draws is a structured scene of text, geometry, and
math primitives (`text`, `line`, `arrow`, `rectangle`, `ellipse`, `circle`,
`polygon`, `polyline`, `freehand`, `arc`, `angle_marker`) with stable ids,
logical board coordinates, colours, widths, dashes, opacity, roles, and
rotation. The model revises it through the `update_board` tool; the app applies
each validated `board_update` event immediately, keeps the scene in the session,
persists it even if the rest of the turn fails, and composites it above learner
ink in live views and board captures. Every request also reports the visible
logical rectangle, a compact upper tutor-content rectangle, a lower rectangle
reserved for the learner's working, learner-ink clusters, exact semantic
objects, and the logical bounds represented by the overview. This keeps a new
exercise and its scratch space visible together without panning, while still
letting the tutor map an inspected crop back to precise coordinates. See
[`server/README.md`](server/README.md) for the wire contract.

For rich multi-part material, the same scene accepts a complete raw SVG
document as one stable object. The SVG string is transported and persisted
unchanged; the iPad interprets it locally with WebKit, caches a PDF/image for
the live overlay and board captures, and re-renders it after relaunch. This
supports WebKit's full declarative SVG feature set—paths, text, gradients,
masks, filters, clipping, markers, symbols, transforms, and animation—without
a server-side SVG parser or tag allowlist. JavaScript and external resource
loads remain disabled in the local renderer.

**Typography.** Source Sans 3 is the design's only typeface and iOS does not ship it, so the 400/500/600 weights are bundled. Two conversions in `Typography.swift` are easy to get wrong and are unit-tested: CSS `line-height` is a total line box while SwiftUI's `lineSpacing` is the gap *between* lines, and the design's tracking is in `em` while `.tracking()` takes points.

## Prototype limitations

This pass intentionally has no accounts, cloud sync, automatic continuous change detection, handwriting OCR, or teacher analytics. Evaluation is explicit (the whole board or a dragged rectangle) and sends a fresh composite of PencilKit ink plus tutor semantic objects only when requested; board evaluation renders the full content bounds, so scrolling away from a long solution does not truncate what the tutor sees. When content is scattered over more than 4,000 pt of board — further than one legible image can cover — evaluation crops to the work and tells the tutor it is looking at a portion rather than the whole board. *Evaluate board* is disabled while the board is empty. Local session persistence is best effort in Application Support; resetting a session removes that session's local drawing, tutor scene, and messages, and leaves every other session alone. The session switcher shows the six most recent sessions and has no delete, rename, or scroller — see [`docs/TODO.md`](docs/TODO.md).

Semantic board objects are structured and editable, but this is **not OCR**:
the learner's handwriting is still understood by the model through images, and
the tutor never claims to transcribe it. Tutor geometry is not editable with
the PencilKit lasso; it is revised by the model through stable ids.

## Backend service

A FastAPI service at [`server/`](server/README.md) is the only path the app has. It holds the one OpenAI key instead of the device, authenticates the device with its own bearer token, streams turns as Server-Sent Events in its own event vocabulary rather than forwarding OpenAI's, and records every message, request, raw provider event stream, board snapshot, and dictation recording — kept indefinitely, not sampled or expiring. See [`server/README.md`](server/README.md) for setup, running it, the event vocabulary, and the retention position in full.

## Manual QA checklist

- Launch: the tutor panel shows the greeting and four suggestion chips with a composer under them. There is no setup screen — the app has no credential to ask for.
- Open Settings and confirm the sidebar lists Tutor and Session only: no key field, no server address, nowhere to point the app at a different backend.
- Tap a suggestion chip and send a typed message; both should move the panel from greeting to thread.
- **Dictation cannot be exercised in the simulator** — there is no usable microphone input, so the service reports `.audioUnavailable` and a mic tap ends in the "Dictation isn't available right now" notice. That is the simulator behaving, not a bug; check the feature on a real iPad.
- With no device token there is no mic at all in the composer, because dictation runs over the same backend configuration the tutor does. Relaunch with `--ui-test-reset` — which makes the compiled-in token read as absent — and confirm the mic is gone; relaunch without it and confirm the mic returns.
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
