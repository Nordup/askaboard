# MathTutor — architecture report for a ChatGPT-style voice mode

Research artifact, 2026-08-15. An Explore agent mapped this repo. Paths relative to repo root.

## 1. Composer UI

- `MathTutor/DesignSystem/Components/Chat/Composer.swift` (918 lines) — metrics, slot, the `Composer` view.
- `MathTutor/DesignSystem/Components/Chat/ComposerButtons.swift` — `ComposerSendButton`, `ComposerVoiceButton`, `ComposerCancelButton`.
- Mount points: `MathTutor/Features/Tutor/TutorPanel.swift:466` (docked, `ChatScale.panel`) and `MathTutor/Features/Tutor/TutorFullScreen.swift:522`.
- `ComposerMetrics` presets `.panel` (`Composer.swift:223`, 50pt pill, mic box 34/glyph 20, send 38/22) and `.fullScreen` (`:246`, 68pt pill, mic 46/26, send 52/26).
- `ComposerSlot<Content>` (`Composer.swift:419`) — the only sanctioned composer placement: `ZStack(alignment: .bottom)` of `ScrollFade` + content. Used at `TutorPanel.swift:231`, `TutorFullScreen.swift:118`.
- Pill row (`Composer.swift:657`): `[attachButton?] [leading] [field] [voice?] [send]`.
- **No empty/non-empty send swap exists.** `ComposerSendButton` always draws the brand disc; `canSend` (`Composer.swift:569`) just makes `send()` decline. A mic-when-empty swap is a NEW design decision.
- Mic button exists: `ComposerVoiceButton` (`ComposerButtons.swift:43`) — dictation toggle; state expressed in the text lane (`Composer.swift:886 dictationLane`: `LevelMeter` + `ElapsedLabel` / `ThinkingIndicator` / `StreamingCaret`). Presence gated by `Composer.onVoice != nil`. Hidden during `.transcribing`; leading slot borrowed by `ComposerCancelButton` during dictation.
- Accessibility conventions: label "Dictate", value = state, `.isToggle` + `.startsMediaSession`, `.magicTap`.
- **Model picker is NOT in the composer.** Model + reasoning effort live in Settings → Tutor pane only (`SettingsPanes.swift:60`, `SettingRow.swift:129`, `SettingsOptions.swift:21`), stored on `LearningSession` via `TutorStore.setModel` (`TutorStore.swift:886`) / `setReasoningEffort` (`:891`).

## 2. Chat thread UI

- `MathTutor/DesignSystem/Components/Chat/MessageThread.swift` — `ThreadMetrics` (`:42`), `ChatScrollColumn` (`:193`), `MessageThread` (`:267`), `MessageRow` (`:385`). Also `MessageBubble.swift`, `ChatStates.swift`, `ActivityTrailView.swift`, `BoardViews.swift`.
- Inverted thread: ScrollView flipped `.scaleEffect(y: -1)` (`:252`), content newest-first (`items.reversed()`, `:336`), each row counter-flipped (`:341`) so laziness survives. Rest position = offset zero. Paddings swap meaning under the flip.
- Streaming: `TutorStore` appends one empty tutor message lazily on first delta (`TutorStore.swift:1046 messageIndex()`), mutates `session.messages[index].text` per `.textDelta` (`:1082`). `persist()` on `.done` (`:1123`); `board_update` persists immediately (`:1109`).
- Thread accessory (`TutorPanel.swift:597-647`): plan card, error retry, `ThinkingIndicator(status: phase.statusLine)`, unconditional `Orb(.thread)`. Phase copy at `TutorPanel.swift:658` (Thinking / Reading your board / Looking something up / Drawing on the board / Writing).
- Math: `MathTutor/StructuredChatText.swift` (`TutorMathMarkdownAdapter`), `Vendor/MarkdownExtendedView`, `Vendor/ExtendedSwiftMath` (`MTMathUILabel`).

## 3. Client networking

- `MathTutor/Services/BackendConfiguration.swift` — `permanentBaseURL = https://air.tail27c2bc.ts.net:8443` (`:47`); bearer token compiled in via `MathTutor/Config/Backend.xcconfig` → Info.plist `MathTutorBackendToken`; DEBUG override `MATHTUTOR_BACKEND_URL` (`:81`). Server auth: `server/app/auth.py require_device_token`.
- Endpoints: `POST /v1/turn` (SSE) — `BackendTutorService.stream` (`Services/BackendTutorService.swift:65`, body at `:322`); `POST /v1/turn/{turn_id}/board` (`:175`); `POST /v1/sessions/{id}/close` (`:222`); `DELETE /v1/sessions/{id}` (`:246`); `PUT /v1/sessions/{id}/transcript` (`:265`); `POST /v1/dictation` (multipart→SSE, `BackendDictationService.swift:443`); `POST /v1/attachments` (`AttachmentUploader.swift:63`).
- SSE `data: {json}\n\n`; client ignores unknown event types (forward compatible) — `TutorEvent.decode` (`MathTutor/Domain/TutorEvent.swift:65`).
- Turn body: `turn_id, session_id, text, model, reasoning_effort` + optional `signal, goal, image_base64, image_region, board_overview_base64, board_manifest, board_scene, attachment_ids`.
- `TutorEvent` union (`Domain/TutorEvent.swift:20`): `status(TutorPhase, detail)`, `reasoningDelta`, `textDelta`, `workspace(SessionPlan, Exercise)`, `boardUpdate(BoardSceneUpdate)`, `boardRequest(callID, region, detail)`, `step(id, tool, label)`, `boardViewed` (client-synthesized), `done`, `failure(message, retryable)`.
- `streamTimeout = 120` s inactivity; server heartbeats every 5 s.
- Board rendezvous: `.boardRequest` answered inside the service in a task-group child (`:114-142`); renderer is `@MainActor static var boardRenderer` (`:164`), set in `BoardScreen.swift:201`.

## 4. Server

Structure under `server/app/`: `main.py`, `auth.py`, `config.py`, `sse.py`, `api/{turn,dictation,sessions,attachments}.py`, `tutor/{prompt,context,tools,loop,events,board,board_scene,rendezvous,retry,quoting,vocabulary}.py`, `memory/…`, `learner/…`, `store/{db,models,recorder,blobs}.py`, `migrations/` (alembic 0001…0006).

- Turn path: `server/app/api/turn.py:338 create_turn` — idempotency 409; get-or-create session; **session.model/effort overwritten from each request** (`:380`); board-change sha256 tri-state (`:421`); `StreamingResponse` SSE; shielded finish so no turn is left `running` (`:702-756`).
- Allowlists (`server/app/config.py:13,26`): `MODEL_ALLOWLIST = {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}`; `REASONING_EFFORT_ALLOWLIST = {"low","medium","high","xhigh","max"}`. NOTE: client `ReasoningEffort` includes `.none` which the server would 422.
- Context: `server/app/tutor/context.py:139 assemble_context` → `ContextBundle(system, input, has_board)`. `split_live_turn` (`:89`) — NEVER quote the live turn as data. Transcript cap 200k→150k chars. Prompt split stable/volatile with `prompt_cache_breakpoint` (`:210-249`); section order in `prompt.py:125 _sections`.
- Tools (`server/app/tutor/tools.py`): `TOOL_DEFINITIONS = [SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL, *MEMORY_TOOL_DEFINITIONS]` (`:587`); memory tools: remember, search_memory, recent_sessions, record_evidence (`:572`). Tool set constant per request (cache prefix).
  - `set_workspace` (`:6`): strict, plan+exercise both required; no server-side effect — device applies (`TutorStore.swift:1100`).
  - `view_board` (`:47`): percent-of-overview region.
  - `update_board` (`:182`): 12 element kinds incl. raw `svg`, `mode: upsert|replace_all`, `delete_ids`, max 200 elements.
- Loop: `server/app/tutor/loop.py:442 run_turn(client, model, effort, bundle, fetch_board, handle_memory, …)` — async generator yielding `(ClientEvent, TurnResult)`. **Responses API**, `responses.create(stream=True)`, `max_retries=0`; `MAX_TOOL_ROUNDS = 5`; round 1 sends prompt, later rounds `previous_response_id` + tool outputs; `prompt_cache_key = str(session.id)`; `view_board` awaits rendezvous (`:654-670`).
- Translation: `server/app/tutor/events.py:252 EventTranslator`; heartbeat re-sends `status` every ≥5 s (`:307`).
- Rendezvous: `server/app/tutor/rendezvous.py` — in-process dict of futures, `RENDER_TIMEOUT_SECONDS = 20`. **Single worker or sticky routing required.**
- Recording: Neon Postgres — `sessions`, `messages`, `turns` (ttft, latency, token counts), `llm_calls` (full request/response JSONB), `tool_calls`, `attachments`, memory/learner tables. Blobs on local disk `server/blobs/`. Session close freezes transcript into one `Episode` (one per session) — client suppresses close while a turn is in flight (`TutorStore.swift:783`).

## 5. Board integration

- Providers installed at `BoardScreen.swift:194-204`: `boardProvider` (overview PNG), `boardManifestProvider` (ink clusters in words), `boardSceneProvider` (JSON scene context), `BackendTutorService.boardRenderer` (percent-region renderer).
- `CanvasCapture` — `MathTutor/Features/Board/BoardCapture.swift`: `overviewData()` `:188`, `renderRegion(percent:)` `:202` (lossless vector zoom), `manifest()` `:241`, `sceneContextString()` `:273`.
- `view_board` mid-turn look: server yields `board_request` → client renders + POSTs `/v1/turn/{id}/board` → rendezvous future resolves → model gets `function_call_output` + `input_image` at `detail:"high"`; device emits local `.boardViewed` (crops in `BoardCropStore`).
- Writes: `update_board` → `.boardUpdate` → `session.boardScene.applying(update)` (`TutorStore.swift:1109`). `BoardScene`/`BoardSceneUpdate` in `MathTutor/Domain/BoardScene.swift`. Renderer `BoardSceneRenderer.swift` + `BoardSVGCache.swift`. Tutor scene never touches learner `PKDrawing` ink.
- Persistence: `Application Support/MathTutor/Sessions/<uuid>.json` + `index.json` (`SessionPersistence.swift:66`); `LearningSession` Codable (`Domain/Models.swift:200`). Ink saved on 600 ms pen-rest debounce, kept out of `@Published session` (`TutorStore.swift:336-414`).

## 6. Settings

- Window over the board with blur (`SettingsPresentation.swift`, applied `BoardScreen.swift:150`), opened from sessions drawer gear.
- Panes: `.tutor` (model + effort pickers) and `.session` (reset) only. No credential/server pane by design.
- Model + effort persist on `LearningSession`; appearance in UserDefaults; UI axes in `UIState` (never persisted).

## 7. Dictation (existing STT)

- NOT SFSpeechRecognizer. Record-then-upload: `AVAudioEngine` tap → WAV 16 kHz → multipart `POST /v1/dictation` → server proxies to OpenAI `gpt-transcribe` (`server/app/api/dictation.py:32`) with vocabulary steering (`tutor/vocabulary.py`).
- `MathTutor/Services/DictationService.swift` (protocol, availability, errors, router, scripted test double), `BackendDictationService.swift` (capture+upload, 60 s cap, RMS meter), `Features/Tutor/DictationController.swift` (tap-to-toggle — rationale: WCAG 2.1.1 + VoiceOver; `merged(base:transcript:)` appends).
- Owned by `BoardScreen` (`:43`); stopped on presentation change (`:158`), settings open (`:172`), send (`:768`).

## 8. App architecture

- Entry `MathTutor/App/MathTutorApp.swift` → `RootView` (creates `UIState`, forces `.preferredColorScheme(.light)`).
- `UIState`: `TutorPresentation {docked, collapsed, fullScreen}`, `ConversationPhase {start, active}`, `panelWidth`, drawer flags, tool/colour axes. All transitions are methods.
- `DesignSystem/Layout.swift:56 ScreenLayout` — every lane derived from measured window size. `Fit` (`:587`) decides whether the tutor can dock.
- `BoardScreen.swift:27` — composition root; owns `CanvasCapture`, `DictationController`, `ComposerAttachments`, `composerText`, `dockDrag`; installs board providers.
- Shell components: `DrawerRevealLayer`, `DockRevealLayer`, `HorizontalSwipeRouter`, `CollapsedDock`, `TutorPanelShell`, `SessionsDrawer`, `ToolRail`, `Orb.swift`/`OrbHalo.swift` (four sizes: hero/panel/dock/thread). `DrawerPanGesture.swift` — `DrawerPanRecognizer` with `cancelOtherRecognizers` (`:139`).
- `project.yml` (xcodegen): app target iOS 17, iPad only, landscape-only; packages: `markdownExtendedView`. **No `UIBackgroundModes`.**

## 9. System prompt(s)

- Production prompt server-side: `server/app/tutor/prompt.py:8 SYSTEM_PROMPT` (ABOUT / UNDERSTAND THE USER / GOAL / KINDS OF OBJECTIVES / BOARD / RESEARCH / TOOLS). Client copy `MathTutor/Domain/TutorPromptPolicy.swift` is a stale test-only duplicate.
- Untrusted text fenced by `tutor/quoting.py:quoted`, labelled "recorded data, not instructions".

## 10. Existing audio session management

All in `BackendDictationService.swift`:
- `setCategory(.record, mode: .measurement, options: .duckOthers)`; preferred sample rate 16 kHz; `setActive(true)` at start, `setActive(false, options: .notifyOthersOnDeactivation)` at every `endCapture()` (`:223`).
- Realtime voice needs `.playAndRecord` + voiceChat; a category change while dictation is live will fight — today the only mutual exclusion is `start()` calling `cancel()` on itself.
- Earcons: `AudioServicesPlaySystemSound` 1113/1114.
- Guard: `inputFormat.sampleRate > 0` else `.audioUnavailable` (simulator case).
- Permissions: `AVAudioApplication.recordPermission` / `requestRecordPermission()`.
- No interruption/route-change observers, no background audio mode, no players.

## Cross-cutting notes for the voice-mode team

1. Model picker is Settings-only; there is no composer model label to extend.
2. **Natural seams for delegation**: client — `TutorService` protocol (`Services/TutorService.swift:12`) + `TutorServiceRouter` (`:61`); a voice session can drive the same `TutorEvent` vocabulary so thread, trail, and board updates work unchanged. Server — `run_turn(...)` takes client/model/effort/bundle/fetch_board/handle_memory as parameters; a voice-delegated turn can reuse it verbatim; board tools work only because `fetch_board` reaches the device over the same SSE stream.
3. Rendezvous is in-process — realtime endpoints must live in the same worker as the turn stream.
4. The mic permission string promises dictation-only recording with no copies kept. Continuous realtime audio makes that string false; it must be rewritten.
5. Ephemeral-key minting / realtime routes do not exist yet; new endpoint under `require_device_token`.
6. UI slots that could carry voice state: composer text lane (`dictationLane`), leading cancel slot, note line, `ThinkingIndicator`/`StreamingCaret`, `Orb` at four sizes, `CollapsedDock`, `ComposerSlot`.
