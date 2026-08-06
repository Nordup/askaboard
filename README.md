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

## API setup and security

Without a key, the app shows a clear setup card and does not silently route requests to an offline fallback. To try live tutoring, open Settings, choose Sol/Terra/Luna, choose a reasoning effort, and enter an OpenAI Platform API key. Reasoning effort supports none, low, medium, high, xhigh, and max; new and reset sessions default to high and the selected value is persisted with the session. A ChatGPT subscription, session cookie, or personal “token” is not reusable for API calls; Platform API usage is a separate service with separate billing. The key is saved in the iOS Keychain and is never put in source, the Xcode project, or UserDefaults. **It is not confined to the device**: every tutor request sends it to OpenAI in an `Authorization` header, which is the whole point of holding it. Say that plainly wherever the key is discussed — an earlier draft of the in-app copy read "the key stays in this device's Keychain", which a reader can fairly hear as "it never leaves", and that is not true of any client-side API key. This direct client-side key path is prototype-only; a production app needs a backend/proxy with authentication, rate limiting, and spend controls so the key never reaches the client. A deterministic demo tutor is available only through explicit test/debug injection.

### Local dev loop (skip retyping the key)

DEBUG builds can take the key from the launch environment instead of the Settings field, so a simulator run comes up live without typing anything. Put the key in a gitignored `.env.local` at the repo root:

```sh
echo 'MATHTUTOR_OPENAI_API_KEY=sk-...' > .env.local
scripts/run-sim.sh
```

The script builds, installs, and launches on `iPad Pro 13-inch (M5)` (override with `MATHTUTOR_SIM_DEVICE`, skip the build with `SKIP_BUILD=1`), passing the key through `SIMCTL_CHILD_MATHTUTOR_OPENAI_API_KEY`. `DebugAPIKeyInjection` reads `MATHTUTOR_OPENAI_API_KEY`, or a path in `MATHTUTOR_OPENAI_API_KEY_FILE`, and `TutorStore` seeds it into the Keychain once so later launches stay live without the environment set. The key still never lives in source, the Xcode project, or UserDefaults; only in `.env.local` and the Keychain. The whole path is compiled out of release builds, and it is deliberately skipped for `--ui-test-reset` launches so UI tests never inherit a developer credential. To clear an injected key, relaunch with that argument:

```sh
xcrun simctl terminate booted com.nordup.MathTutor
xcrun simctl launch booted com.nordup.MathTutor --ui-test-reset
```

The live path uses the Responses API with `gpt-5.6-luna` as the default for new/reset sessions and forwards the selected reasoning effort on every request. It sends a white-backed, size-bounded PNG snapshot as base64 `input_image` with `detail: original`, alongside the current context and general tutor policy. Every response uses the same strict schema: `reply` is Markdown text and `plan`/`exercise` are required nullable fields that are either both complete or both `null`, so ordinary chat preserves the current workspace while explicit exercise requests can replace it. The response parser walks output message/content items instead of assuming a top-level text field and drops malformed or mismatched planning pairs defensively. Invalid credentials and network failures remain visible and retryable; the app never presents offline fallback as a successful live response.

**Dictation is the same key and the same provider**, and [`docs/design-system/07-dictation.md`](docs/design-system/07-dictation.md) is its contract, its research and its board. The composer's mic records with `AVAudioEngine` and posts a mono 16-bit WAV — 16 kHz where the audio route accepts that preference, otherwise whatever rate it hands back — to `POST /v1/audio/transcriptions` with `model: gpt-transcribe` and `stream: true`, consuming the `transcript.text.delta` events (which **append**, unlike `SFSpeechRecognizer`'s restating partials) and finishing on `transcript.text.done`, whose `text` is authoritative over the summed deltas.

`gpt-transcribe` rather than the cheaper mini model because only it accepts **`keywords`**, and a maths recogniser without vocabulary steering hears "sign" for "sine" and "x squad" for "x squared" — children's speech and mathematical language are both worst cases in the recognition literature. `DictationVocabulary` holds the split the endpoint documents: `keywords` for the terms, a one-sentence `prompt` for the situation, `languages: ["en"]` stated rather than detected. A `<`, `>`, CR or LF in either **rejects the whole request**, so both are sanitised before the body is built. 429 and 503 get two silent retries honouring `Retry-After`; billing 429s (`credit_balance_exhausted`, the spend-limit codes) are never retried. A stream that ends without `transcript.text.done` is a failure, not a short transcript — half a sentence a student might not notice is worse than none.

Because the recording is transcribed after it ends rather than as the student speaks, a session has **two phases**, told apart by where the motion comes from: capturing shows `ui/level`, five bars driven by the live input RMS at 20 Hz, plus an elapsed timer; transcribing shows board 14's thinking dots and the word "Transcribing…". The meter is not decoration — App Store guideline 2.5.14 requires *the app* to indicate recording, and a timer-driven animation would move identically for a working mic, a muted one and a closed Smart Folio. A `ui/cross` in the composer's leading slot cancels either phase, start and stop earcons sound, and the mic button carries `.startsMediaSession`, a magic-tap action, and a constant label with a changing value.

**The audio leaves the iPad.** OpenAI does not train on API data, but does retain API inputs for up to 30 days for abuse monitoring before deleting them unless the account has Zero Data Retention, which is an application-gated option for qualifying business accounts and is not assumed here — the microphone purpose string says exactly that, because it is the only explanation a parent gets. Nothing logs or persists the audio or the transcript, and a provider error is never forwarded to the UI: its text can quote what was heard. Whisper-family models fabricate on near-silent audio, so a short boilerplate result ("Thank you.", " you") is treated as silence and never written into the composer as if the student had said it; the transcript always lands in the editable field and is never auto-sent. Without a key there is no dictation at all and the composer draws no mic, because a control that can only raise a notice is the disabled control this design does not have. Recording stops by itself at 60 seconds — about 1.9 MB, well under the endpoint's 25 MB file limit — and transcribes what was said instead of failing the upload.

Assistant replies render through the pinned `MarkdownUI` 2.4.0 Swift package (`Markdown`) with selectable GitHub-Flavored Markdown headings, lists, quotes, tables, code, links, and visible single-newline breaks. Math is requested and displayed as readable Unicode/plain text because the renderer does not render LaTeX math delimiters. Learner messages stay literal text so their punctuation, whitespace, and line breaks are preserved exactly.

## Debug E2E fixture

Debug launches can seed a legible vector PencilKit attempt for the radical-equation evaluation flow. Pass `--ui-test-reset --ui-test-demo-service --e2e-seed-radical-attempt` as launch arguments; the fixture is compiled out of release builds, while the demo-service routing override is DEBUG-only. Both are ignored unless those explicit arguments are present.

## Architecture

Five layers, each depending only on the ones above it. `DesignSystem` knowing nothing about the app is the load-bearing rule — a component that reaches for `TutorStore` is not a component, it is a screen fragment.

| Layer | Contents |
| --- | --- |
| `Domain/` | `Models`, `BoardTool`/`PenColor`/`StrokeThickness`, the tutor prompt policy. No UIKit, no SwiftUI. |
| `Services/` | `TutorService` protocol with `DemoTutorService`, Keychain-backed `TutorServiceRouter`, `OpenAITutorService`, `SessionPersistence`, `KeychainStore`. `DictationService` protocol with `OpenAIDictationService` (`AVAudioEngine` records and meters, OpenAI's `gpt-transcribe` transcribes), the value-only `OpenAITranscription` layer — vocabulary, request, SSE reader, retry policy, silence guard, WAV — and `ScriptedDictationService`, the fake the tests drive. |
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

This pass intentionally has no backend, accounts, cloud sync, automatic continuous change detection, handwriting OCR, or teacher analytics. Evaluation is explicit (the whole board or a dragged rectangle) and sends the rendered PencilKit image only when requested; board evaluation renders the bounding box of every stroke, so scrolling away from a long solution does not truncate what the tutor sees. When ink is scattered over more than 4,000 pt of board — further than one legible image can cover — evaluation crops to the student's work and tells the tutor it is looking at a portion rather than the whole board. *Evaluate board* is disabled while the board is empty. Local session persistence is best effort in Application Support; resetting a session removes the local drawing and messages.

## Manual QA checklist

- Launch without a key: the tutor panel shows the first-run state with a single primary action, and no composer — there is no disabled control anywhere in this design.
- Add a key, relaunch, and confirm the greeting and four suggestion chips appear and the key persists in Keychain. Remove it and confirm the first-run state returns.
- Tap a suggestion chip and send a typed message; both should move the panel from greeting to thread.
- **Dictation cannot be exercised in the simulator** — there is no usable microphone input, so the service reports `.audioUnavailable` and a mic tap ends in the "Dictation isn't available right now" notice. That is the simulator behaving, not a bug; check the feature on a real iPad.
- With no key there is no mic at all in the composer, because dictation runs on the same OpenAI key the tutor does. Confirm it appears once a key is saved and disappears when it is removed.
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
