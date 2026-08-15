# Voice mode — implementation plan

Spec: `docs/superpowers/specs/2026-08-15-voice-mode-design.md`. Contract: `MathTutor/Features/Voice/VoiceContracts.swift` (only Package K may amend it).

Four parallel packages with strict file ownership, then an integration pass, then device polish.

## Ownership map (no overlaps)

| Package | Owns (writes) | Reads |
|---|---|---|
| S — server realtime | `server/app/api/realtime.py` (new), `server/app/tutor/voice_prompt.py` (new), `server/app/config.py` (additive), `server/app/main.py` (router mount), `server/tests/test_realtime_route.py` (new) | everything in `server/` |
| K — realtime kit | `MathTutor/Services/Realtime/*` (new), `MathTutor/Services/Audio/VoiceAudioSessionController.swift` (new), `MathTutor/Features/Voice/VoiceContracts.swift` (amend if needed), `project.yml` (SPM dep + UIBackgroundModes), `MathTutorTests/VoiceEngineTests.swift` (new) | sleep repo, BackendTutorService, BackendConfiguration |
| M — mascot | `MathTutor/Features/Voice/Mascot/*` (new: `VoiceMascotView`, `MascotMotion`, `MascotPainter`, `MascotGeometry`, `ScriptedVoiceEngine`), `MathTutorTests/MascotMotionTests.swift` (new) | Paper boards, `Orb.swift`/`OrbHalo.swift`, VoiceContracts |
| D — UI integration | `Composer.swift`, `ComposerButtons.swift`, `TutorPanel.swift`, `TutorFullScreen.swift`, `BoardScreen.swift`, `TutorStore.swift`, `MessageBubble.swift` (voice marks), `Models.swift` (voice-marked message flag), new `MathTutor/Features/Voice/VoiceBar.swift` if needed | Paper boards, VoiceContracts |

Rules for every package: no `xcodebuild`, no `xcodegen`, no test-suite runs (the orchestrator integrates and the user runs on device). Server package may run pytest ONLY on its own new test file (the shared Neon test branch is contended; the new tests must not need a DB). Nobody commits; the orchestrator commits.

## Package S — server realtime route + voice prompt

1. `POST /v1/realtime/calls` under `require_device_token`, `Content-Type: application/sdp`, query `session_id` (UUID, optional but expected). Validate body starts with `v=`. Build FormData `{sdp, session: json}` and POST to `{OPENAI_BASE_URL}/realtime/calls` with the server's key; 20 s timeout; return the answer SDP as `application/sdp`. One retry with the `server_vad` fallback when the rejection matches `/semantic_vad|turn_detection|eagerness/i`. Strip the API key and anything `sk-…`-shaped from logged/returned errors. Response header `X-Turn-Detection-Mode` with the negotiated mode. Mirror of the sleep app's `apps/server/src/routes/realtime-session.ts` — port it to FastAPI/httpx.
2. Session config builder (`build_realtime_session()` in `realtime.py` or a sibling module): per the spec — `gpt-realtime-2.1` (env `OPENAI_REALTIME_MODEL`), voice `marin` (env `OPENAI_REALTIME_VOICE`), pcm 24 kHz both ways, semantic_vad with create/interrupt true, transcription `gpt-live-transcribe` + `language: "en"` + prompt from `vocabulary.py` keywords, tools `[SEND_TO_TUTOR_TOOL]`, instructions from `voice_prompt.py`.
3. `voice_prompt.py`: `VOICE_SYSTEM_PROMPT = SYSTEM_PROMPT + VOICE_SECTION` per the spec (allow list, mandatory delegation, action line before each call, concise rephrase, never read LaTeX/code aloud, match the learner's language). `SEND_TO_TUTOR_TOOL` JSON exactly as in the spec.
4. Config: new Settings fields with env defaults; add to `MODEL` docs/comments. Do NOT touch the turn allowlists.
5. Tests: FastAPI TestClient + `respx` (or a monkeypatched httpx.AsyncClient) faking the upstream — happy path, semantic→server_vad retry, key redaction, 401 without the device token, non-SDP body 400. No DB.

## Package K — realtime kit (Swift)

Port from `/Users/nordup/Projects/other/sleep` (read `docs/research/voice-mode/sleep-app-voice-stack.md` first — the 14 lessons in §10 are binding):

1. `project.yml`: add SPM package `webRTC: url https://github.com/stasel/WebRTC, from: 150.0.0`, product `WebRTC`, to the app target; add `UIBackgroundModes: [audio]`.
2. `RealtimeConnection.swift` — the sleep bring-up verbatim (unified plan, data channel `oai-events` created before the offer, gatherOnce + wait, POST SDP via signaling client, wait for data-channel OPEN not ICE), stats-derived mic level (`sampleUplink`), remote gain + duck (0.1×), stage-budgeted timeouts, idempotent close.
3. `RealtimeSignalingClient.swift` — `POST {BackendConfiguration.permanentBaseURL}/v1/realtime/calls` with the device bearer token, `application/sdp` both ways, `session_id` query.
4. `VoiceAudioSessionController.swift` — RTCAudioSession sole owner; `.playAndRecord`, videoChat mode, `.defaultToSpeaker`; never set sample rate/buffer; interruption + route-change + media-services-reset observers; must coexist with `BackendDictationService` (voice refuses to start while dictation runs and vice versa — expose `isVoiceSessionActive` for D to gate dictation).
5. `RealtimeEvents.swift` — decoder for the event set in the research doc §9 plus `response.function_call_arguments.done`/swept calls; encoder for `session.update` (keepalive), `conversation.item.create` (function_call_output, user text), `response.create`, `response.cancel`. Never re-encode server-provided numbers.
6. `VoiceSessionCoordinator.swift` — implements `VoiceSessionControlling`. State machine per `VoicePhase`. Barge-in: duck on `speech_started`, release on `speech_stopped`/`committed`; `response.cancel` only if the response has made noise (first output transcript delta = proxy). Executes `send_to_tutor` via `hooks.runTutorTurn` (single-flight; if a second call arrives while one runs, answer it with `{"error":"busy"}`), returns `function_call_output` + `response.create`, de-duplicated by call id. Feeds `hooks.appendUserUtterance` / `streamAssistantText` / `assistantResponseFinished(delegated:)`. Drives `VoiceDisplayProvider` at 10 Hz (userLevel from stats, 0 while assistant speaks; assistantLevel proxy from transcript-delta cadence + output_audio_buffer events). Mute via track-enabled with an owner + watchdog (UplinkGuard port). Keepalive no-op session.update after 40 s silence.
7. Unit tests (no network): turn/duck decisions, call-id dedup, transcript accumulation keyed by item id, delegated-response marking, mute watchdog, level normalization −48…−12 dBFS.

## Package M — mascot

1. Extract exact geometry and gradients from Paper via MCP (get_jsx/get_computed_styles; never screenshots): hero mascot on board 05 (OR-0), sizes/glows on boards 28 (7U1-0) and 29 (7XH-0), the five states on note/27 (80H-0). Load the Paper guide first (get_guide). Scope find_nodes per artboard.
2. `VoiceMascotView` — SwiftUI Canvas + TimelineView (30–60 fps), single shared `MascotMotion` integrator (advance by dt; envelopes survive view swaps), `MascotPainter` (face + layered violet halo + state accents: breathing scale, pulse ring + orbiting dot, ripple rings, exhale), `MascotGeometry` (numbers from Paper, parameterized by face size 72pt panel / 120pt full screen). Listening breathes with `userLevel`; Talking bobs with `assistantLevel`; attack ~80 ms, release ~400 ms envelope like the sleep orb.
3. `ScriptedVoiceEngine: VoiceSessionControlling` — a fake engine that plays a scripted timeline of phases/levels/transcripts for previews and UI tests (the simulator cannot run WebRTC).
4. Previews for all five states; motion unit tests with injected time.
5. Match the app's existing `Orb`/`OrbHalo` idiom where it fits; do not modify those files.

## Package D — UI integration

Extract exact values from Paper boards 27/28/29 first (same MCP rules as M).

1. `ComposerButtons.swift`: `ComposerVoiceChatButton` — the brand disc with the white 4-bar waveform glyph (board 27), same metrics as the send disc; accessibility: label "Voice chat", `.startsMediaSession`.
2. `Composer.swift`: when `text` is trimmed-empty AND no attachments AND selection not attached → show the voice disc instead of send; any content morphs it back (short crossfade/scale, 150–200 ms). During a live call the composer renders the voice bar: `+`, field ("Ask anything…", return key sends via `voice.sendTyped`), mic-mute toggle, dark-ink X end disc (board 28 values); dictation mic hidden.
3. `BoardScreen.swift`: own the voice engine at screen level (`@StateObject` wrapper holding a `VoiceSessionControlling`), install `VoiceSessionHooks` next to the existing board providers; gate dictation while voice is active; keep the call alive across presentation switches.
4. `TutorStore.swift` hooks: `appendUserUtterance` → learner message marked voice; `streamAssistantText` → stream into a voice-marked tutor message keyed by item id; `assistantResponseFinished(delegated: true)` → remove/suppress that spoken message per the dedup rule; `runTutorTurn` → drive the existing send pipeline with `signal: "voice"` and return the final tutor text.
5. Thread: live-transcript bubble treatment (brand-tint-soft + small waveform mark while streaming, board 28); mascot placement above the composer during a call in both `TutorPanel` (72pt) and `TutorFullScreen` (120pt) via `VoiceMascotView`; suppress the plain typing-indicator orb while voice is live.
6. `Models.swift`: a voice marker on `TutorMessage` (Codable-compatible, defaulting off — follow the existing forward/backward-compatible init pattern).
7. Use `ScriptedVoiceEngine` in previews; add UI-state coverage where the existing UI tests pattern makes it cheap (assert on outcomes, not first-tap timing).

## Integration pass (orchestrator, after all four land)

1. Reconcile `VoiceContracts.swift` drift (K may have amended; D/M adapt).
2. `xcodegen generate`; resolve SPM; one build (`xcodebuild build`, only if no user build is running); fix compile errors.
3. Server: run the new route tests; start server locally if cheap to smoke the config builder.
4. Commit + push to main.

## Device polish pass (with the user)

Voice cannot run in the simulator. The user runs on the iPad; we verify: call start latency, barge-in feel, transcript timing vs audio, dedup correctness, mascot states, board drawing during a call, dock resize during a call, mute, end, dictation coexistence, backgrounding. Iterate on eagerness/voice/prompt wording from real sessions.
