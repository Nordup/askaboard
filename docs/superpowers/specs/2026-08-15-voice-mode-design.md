# Voice mode — design

Date: 2026-08-15. Status: approved by the founder (architecture in chat, UI on Paper boards 27/28/29/note-27).
Research inputs: `docs/research/voice-mode/{sleep-app-voice-stack,openai-realtime-delegation,math-tutor-chat-stack}.md`.

## Product decisions (founder)

- ChatGPT-style live voice chat inside the existing chat surfaces. No separate voice screen.
- The voice model is the **full `gpt-realtime-2.1`**, always the latest available. Never the mini.
- The live-voice visual is the **app mascot** (black rounded face, two white eyes, violet halo). It comes alive: the halo breathes while listening, ripples while talking. No ChatGPT orb.
- The voice model **delegates** all real tutoring work to the **worker model chosen in Settings** (Sol/Terra/Luna). The worker holds the tools (see board, draw, plan, memory). To the learner it must feel like one entity.
- Entry point: with an empty composer text field, the send disc becomes a **voice-chat disc** (white waveform glyph on brand violet). Tap starts the call.
- Same tutor system prompt family for both models; the voice model gets a delegation section on top.

## UX (as designed on Paper)

Boards on Page 1, row at worldY 5400: `27 — Voice · composer ready` (7R4-0), `28 — Voice · live · docked` (7U1-0), `29 — Voice · live · full screen` (7XH-0), `note/27 — Voice · mascot states` (80H-0). Implementation extracts exact values from these nodes with get_jsx/get_computed_styles — never from screenshots.

- **Composer ready**: identical to board 08 except the voice disc replaces the send disc when `text` is empty (and no attachments/selection). Typing anything morphs it back to the send disc.
- **Live · docked**: board stays visible and usable. In the panel: normal thread on top; live transcript bubbles (user bubble in `--color-brand-tint-soft` with a small waveform mark while words stream); step chip ("Drawing on the board") while the worker acts; the mascot (~72pt face, two-layer violet glow) floating above the composer; voice bar = `+` attach, text field "Ask anything…" (typing allowed), mic-mute, dark-ink X end disc. No send disc during a call; typed text sends on return key.
- **Live · full screen**: same content in the reading column; mascot ~120pt with a large soft glow in the lower third.
- **Mascot states** (animation spec): Idle (faint halo) · Listening (halo breathes and brightens with user voice level; eyes widen slightly) · Thinking (eyes glance up-left; halo pulses slowly; one small orbiting dot; shown while a delegated turn runs) · Talking (face bobs with speech energy; halo ripples outward; strongest state) · Ending (halo exhales and fades; face settles to idle).

### Interaction rules

- **Barge-in**: user speech while the tutor talks → duck remote audio to 10% immediately (never mute), `response.cancel`. Semantic VAD with `interrupt_response: true` handles the server side.
- **Mute**: disables the mic track with an owner + watchdog (UplinkGuard pattern). The call stays up.
- **End (X)**: play the Ending mascot state (~1 s), close the connection, deactivate audio, return the composer to normal. Session stays open — voice is a mode within the session, not a session.
- **Typing during a call**: allowed. Typed text goes into the realtime conversation as a user text item + `response.create`; the voice model treats it like speech (and usually delegates).
- **Dictation** and voice are mutually exclusive; the dictation mic is hidden during a call.
- Entering/leaving presentations (docked ↔ full screen) must not drop the call: the voice engine is owned by `BoardScreen` level, not by a panel view.

## Architecture

### Voice path

Device ⇄ OpenAI over WebRTC (`stasel/WebRTC` SPM, the sleep-app port). Server = SDP proxy holding the one OpenAI key:

- `POST /v1/realtime/calls` (FastAPI, `require_device_token`): body = offer SDP (`application/sdp`), query `session_id`. Server builds the session config and forwards `{sdp, session}` as FormData to `https://api.openai.com/v1/realtime/calls`, returns the answer SDP. Retry once with `server_vad` fallback if the upstream rejects semantic_vad. Redact `sk-…` from any error.
- Session config (server-owned): model `gpt-realtime-2.1` (env `OPENAI_REALTIME_MODEL`), `output_modalities: ["audio"]`, voice `marin` (env `OPENAI_REALTIME_VOICE`), audio pcm 24 kHz, `turn_detection: {type: semantic_vad, create_response: true, interrupt_response: true}`, input transcription `{model: gpt-live-transcribe, language: en, prompt: <math vocabulary from vocabulary.py>}`, tools = `[send_to_tutor]`, instructions = voice prompt.
- The client never re-encodes OpenAI-bound numbers; any client `session.update` carries instructions/keepalive only (sleep lesson 7).
- Client audio: `RTCAudioSession` is the sole owner; `.playAndRecord`, voice/video-chat mode, `.defaultToSpeaker`; never set sample rate or IO buffer; no second audio unit ever; mic level derived from WebRTC stats (sleep lessons 1–6).
- `UIBackgroundModes: [audio]` so a brief app switch does not kill the call.

### Delegation path — the phone is the hub

The voice model has ONE tool:

```json
{"type": "function", "name": "send_to_tutor",
 "description": "Send the learner's request to the tutor engine. It sees the whiteboard, draws on it, updates the plan, and remembers the learner. It returns the tutor's answer for you to relay. You MUST use it for all tutoring: math questions, checking the board, drawing, exercises, plans, anything factual. Only greetings, repeats, and clarifying questions are yours.",
 "parameters": {"type": "object", "properties": {
    "request": {"type": "string", "description": "The learner's need in one or two sentences, including key details from their last utterance."}},
  "required": ["request"]}}
```

Execution (client, `VoiceSessionCoordinator`): on `send_to_tutor` → run a **normal turn** through the existing pipeline (`BackendTutorService.stream` with `text = request`, `signal = "voice"`, the usual board snapshot/manifest/scene, session model + effort). The thread, step chips, `update_board`, `set_workspace`, memory tools, recording — all existing behavior applies unchanged. On `done` → `conversation.item.create` `function_call_output` `{"tutor_reply": <final text>}` + `response.create`. On failure → `{"error": <message>}` so the voice model can apologize and retry. Realtime function calls are async — the voice model keeps talking while the worker runs; the voice prompt requires one short action line before every call ("Let me work through that on the board").

### Transcripts and the thread

- User utterance: `conversation.item.input_audio_transcription.delta` → stream into a live learner bubble (voice-marked, board 28's live treatment) *while the learner speaks*; `…transcription.completed` settles it — the completed transcript is authoritative and replaces the streamed deltas — into a plain learner message + transcript sync (existing `PUT /v1/sessions/{id}/transcript`). An empty or absent completed transcript (silence — a cough, the room) removes the live bubble instead. The transcript sync only ever carries finalized utterances, never in-progress text.
- Assistant speech: `response.output_audio_transcript.delta` → stream into a tutor message in the thread.
- **De-duplication rule**: when a voice response called `send_to_tutor`, the worker's streamed message is the canonical thread content — suppress that voice response's own spoken transcript from the thread (it is a rephrase). Voice-only small talk (no delegation) appears in the thread.
- The worker therefore always sees the full conversation, voice included, through the existing `assemble_context`.

### Voice prompt (server-owned)

`server/app/tutor/voice_prompt.py`: the tutor `SYSTEM_PROMPT` + a VOICE section — strict allow list (greetings, repeats, clarifications), "delegate everything else via send_to_tutor", one action line before every call, rephrase `tutor_reply` concisely (opener + gist + up to 3 details), never read LaTeX or code aloud (say it in words), match the learner's language, keep answers short — the full text is on screen.

## Mascot implementation

Build on the existing `Orb`/`OrbHalo` components. New `VoiceMascotView`: SwiftUI `Canvas` + `TimelineView`, one shared motion integrator (advance by dt, never sample f(t)), published through a dedicated 10 Hz `ObservableObject` so the thread does not re-render per frame (sleep-app orb architecture). Inputs: `VoicePhase` + `userLevel` + `assistantLevel`. `userLevel` comes from WebRTC capture stats and reads 0 while the assistant speaks (echo-cancellation zeros — lesson 6); `assistantLevel` is a proxy driven by output transcript deltas and `output_audio_buffer` events. Exact geometry/gradients from Paper (hero on board 05, states on note/27).

## What does not change

- No new Settings. The voice model is fixed server-side; the worker picker is the existing model picker.
- No server-side realtime event handling: OpenAI events flow over the device data channel.
- Sessions, recording, memory, board pipelines — untouched; voice rides on them.
- Rendezvous stays in-process; the realtime SDP route lives in the same worker (it is stateless anyway).

## Risks and constraints

- **Simulator cannot run WebRTC voice** (audio unit hang). All voice testing happens on the physical iPad. UI states get simulator coverage via a scripted/fake voice engine.
- Mic purpose string: already rewritten honestly (2026-08-15) — covers dictation + live voice, no deletion promise.
- Cost: full-model audio ≈ $0.30–0.50 per 10-min call + worker turns.
- GPT-Live API (full-duplex, built-in delegation) is on a waitlist; our `send_to_tutor` layer is the swappable seam when it lands.

## Testing

- Kit logic (turn gating, transcript accumulation, dedup rule, tool-call parsing, uplink guard) — unit tests with injected clocks, no network.
- Server route — pytest with a faked upstream (no DB needed; do not touch the shared Neon test branch).
- UI states — a `ScriptedVoiceEngine` drives composer/mascot/thread states in previews and UI tests without WebRTC.
- Device verification is the user's step; agents never run `xcodebuild test`.
