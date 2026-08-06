# Math Tutor iPad MVP

Math Tutor is a compact SwiftUI/PencilKit prototype for learning math by writing and talking through the next step. It opens in a conversational tutor, can turn a loose goal into a short session plan when useful, and then gives the learner a full-screen Apple Pencil board with a draggable tutor panel.

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

Without a key, the app shows a clear setup card and does not silently route requests to an offline fallback. To try live tutoring, open Settings, choose Sol/Terra/Luna, choose a reasoning effort, and enter an OpenAI Platform API key. Reasoning effort supports none, low, medium, high, xhigh, and max; new and reset sessions default to high and the selected value is persisted with the session. A ChatGPT subscription, session cookie, or personal “token” is not reusable for API calls; Platform API usage is a separate service with separate billing. The key is saved in the iOS Keychain and is never put in source, the Xcode project, or UserDefaults. This direct client-side key path is prototype-only; a production app needs a backend/proxy with authentication, rate limiting, and spend controls so the key never reaches the client. A deterministic demo tutor is available only through explicit test/debug injection.

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

Assistant replies render through the pinned `MarkdownUI` 2.4.0 Swift package (`Markdown`) with selectable GitHub-Flavored Markdown headings, lists, quotes, tables, code, links, and visible single-newline breaks. Math is requested and displayed as readable Unicode/plain text because the renderer does not render LaTeX math delimiters. Learner messages stay literal text so their punctuation, whitespace, and line breaks are preserved exactly.

## Debug E2E fixture

Debug launches can seed a legible vector PencilKit attempt for the radical-equation evaluation flow. Pass `--ui-test-reset --ui-test-demo-service --e2e-seed-radical-attempt` as launch arguments; the fixture is compiled out of release builds, while the demo-service routing override is DEBUG-only. Both are ignored unless those explicit arguments are present.

## Architecture

- `TutorStore`: `@MainActor` MVVM state, persistence, onboarding/workspace transitions, evaluation state, and retry/error handling.
- `TutorService`: injectable protocol with deterministic `DemoTutorService`, Keychain-backed `TutorServiceRouter`, and `OpenAITutorService`.
- `Models`: Codable session, plan, exercise, message, model choice, and tutor prompt policy.
- `PencilCanvasView`: PencilKit canvas, native `PKToolPicker`, pen/marker/eraser helpers, undo/redo, two-finger undo, and three-finger redo.
- SwiftUI views: onboarding chat, plan card, workspace, selection/evaluation UI, floating chat, and settings.

## Prototype limitations

This pass intentionally has no backend, accounts, cloud sync, automatic continuous change detection, handwriting OCR, or teacher analytics. Evaluation is explicit (full canvas or a dragged rectangle) and sends the rendered PencilKit image only when requested. Local session persistence is best effort in Application Support; resetting a session removes the local drawing and messages.

## Manual QA checklist

- Launch without a key: setup-required badge/card appears and live request controls stay hidden until a key is saved.
- Send a goal and continue the chat; when the tutor returns a coherent plan and exercise, tap **Start working on the board**.
- Write with Apple Pencil or simulator touch. Try native tool picker, pen/marker/eraser, undo/redo, two-finger tap undo, and three-finger tap redo.
- Toggle **Select region**, drag a rectangle, and evaluate it; also evaluate the full board. Confirm loading state and tutor feedback in the floating panel.
- Collapse, drag, and expand the panel in different corners. Try **I don’t know** and confirm the tutor treats it as a teaching signal.
- Add a key in Settings, relaunch, and confirm the live badge, session, and selected model persist while the key remains in Keychain. Remove it and confirm setup guidance returns.
- In Settings → Quality route, change reasoning effort and confirm the chat and workspace status captions update; reset the session and verify effort returns to High.
- Use Settings → Reset current session and verify the app returns to onboarding with an empty board.
- Test light/dark appearance, keyboard input, and both portrait/landscape iPad layouts.
