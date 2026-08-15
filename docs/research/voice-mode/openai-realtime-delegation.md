# ChatGPT-style voice mode with delegation — Realtime API research (2026-08-15)

Research artifact from a web-research agent. Sources cited inline.

## 1. OpenAI's official Chat-Supervisor pattern (openai/openai-realtime-agents)

Source repo: https://github.com/openai/openai-realtime-agents — pattern code in `src/app/agentConfigs/chatSupervisor/index.ts` and `supervisorAgent.ts`.

**The two roles.** A realtime chat agent talks to the user. It handles only greetings, basic chitchat, requests to repeat or clarify, and information collection for later tool calls. A text supervisor model does everything else. Goal: the model responds to the user right away, even if it must lean on the supervisor agent.

**The realtime agent's instructions** contain a strict allow list and a hard rule: "By default, you must always use the getNextResponseFromSupervisor tool to get your next response, except for very specific exceptions." … "For absolutely everything else, you MUST use the getNextResponseFromSupervisor tool."

**Filler phrases.** The agent must always say something before it calls the tool, never call it silently. Phrases must be neutral and not imply any outcome: "Just a second," "Let me check," "One moment," "Let me look into that."

**The tool definition (verbatim):**

```
name: 'getNextResponseFromSupervisor'
description: 'Determines the next response whenever the agent faces a
non-trivial decision, produced by a highly intelligent supervisor agent.
Returns a message describing what to do next.'
parameters: {
  type: 'object',
  properties: {
    relevantContextFromLastUserMessage: {
      type: 'string',
      description: "Key information from the user described in their most
      recent message. ... Okay to omit if the user message didn't add any
      new information."
    }
  },
  required: ['relevantContextFromLastUserMessage']
}
```

The parameter exists because the transcript of the last user turn can lag behind the tool call; the realtime model summarizes fresh context itself.

**Context passed to the supervisor:** full realtime session history filtered to `message` items, JSON-stringified, plus the fresh-context string. No raw audio.

**The supervisor side.** POSTs to a Responses API proxy with `parallel_tool_calls: false`. Supervisor instructions: create "a correct next message that the junior agent can read directly"; for voice, be very concise, prose only, never bulleted lists; never call a tool with missing or placeholder values.

**Tool execution loop.** A while loop: filter output for `function_call` items, execute each locally, append `function_call` + `function_call_output` to `body.input`, re-POST; repeat until no function calls remain; return `{ nextResponse: finalText }`.

**Speaking the answer.** Sample: verbatim. Newer prompting guide: rephrase with a short opener ("Thanks for waiting—"), keep to two sentences.

**Latency.** README reports ~2 s between end of filler phrase and start of supervisor-backed answer.

## 2. ChatGPT production voice mode in 2026

- **2025-11-25 — voice merged into the chat thread.** No separate orb screen. Live transcript appears as you speak; answers stream as text in the thread with visuals in real time. Revert option: Settings → Voice Mode → Separate mode. (macrumors.com 2025-11-26)
- **2026-07-08 — GPT-Live.** GPT-Live-1 (paid) and GPT-Live-1 mini (free) are the ChatGPT voice models. Full-duplex; catches mid-sentence interruptions; backchannels ("mhmm"). **Delegation is official**: "For questions that require web search, deeper reasoning, or more complex work, it delegates to our latest frontier model" (GPT-5.5 behind the voice model). OpenAI's engineering post: audio moves on a dedicated fast path; delegation and tools sit behind an asynchronous RPC boundary; a slow tool call cannot stall media flow. (openai.com/index/introducing-gpt-live/, /continuous-voice-interaction-with-gpt-live/, simonwillison.net 2026-07-08)
- GPT-Live is NOT in the public API as of 2026-08-15 (waitlist; "weeks, not months"). Developer path today: `gpt-realtime-2.1`.

Conclusion: the planned architecture (realtime speech model + smarter text worker with tools) is exactly what ChatGPT ships. Chat-Supervisor is the public blueprint.

## 3. Realtime API state, August 2026

Docs: https://developers.openai.com/api/docs/guides/realtime (moved from platform.openai.com).

**Model timeline:** 2025-08-28 GA `gpt-realtime` (image input, MCP, SIP, async function calls) → 2025-10-01 `gpt-realtime-mini` → 2026-05-07 `gpt-realtime-2` (configurable reasoning minimal…xhigh default low; 128k context; parallel tool calls) → **2026-07-06 `gpt-realtime-2.1` and `-2.1-mini` — current latest**, ≥25% lower p95 latency. Transcription models: `gpt-transcribe`, `gpt-live-transcribe` (2026-07-28).

**Pricing** (per 1M tokens): `gpt-realtime-2.1`: audio in $32 (cached $0.40), audio out $64; text in $4, out $24; image in $5. `-2.1-mini`: audio in $10, out $20. `gpt-live-transcribe` $0.017/min. Worker text: `gpt-5.5` $5/$30; `gpt-5.2` $1.75/$14.

**Transports:** WebRTC recommended for mobile clients; WebSocket for server pipelines; SIP for telephony.

**Ephemeral client secrets:** server POSTs `/v1/realtime/client_secrets` with the session config; response has `value` (`ek_…`) + `expires_at`; client POSTs SDP offer to `/v1/realtime/calls` with the ephemeral bearer. (Alternative used by the sleep app: server-side SDP proxy — the client never holds any OpenAI credential.)

**session.update schema (GA):**

```json
{ "type": "session.update", "session": {
    "type": "realtime", "model": "gpt-realtime-2.1",
    "output_modalities": ["audio"],
    "audio": {
      "input":  { "format": { "type": "audio/pcm", "rate": 24000 },
                  "turn_detection": { "type": "semantic_vad" } },
      "output": { "format": { "type": "audio/pcm" }, "voice": "marin" } },
    "instructions": "...", "tools": [] } }
```

No `OpenAI-Beta: realtime=v1` header on the GA interface.

**Turn detection:** `server_vad` (`threshold`, `prefix_padding_ms`, `silence_duration_ms`, `create_response`, `interrupt_response`) or `semantic_vad` (`eagerness`: low|medium|high|auto). `turn_detection: null` disables.

**Interruption:** with server VAD, `interrupt_response` handles barge-in automatically. Manual: `response.cancel`; `conversation.item.truncate` (item_id, content_index, audio_end_ms); on WebRTC also `output_audio_buffer.clear`.

**Function calling:** args stream via `response.function_call_arguments.delta`; complete call in `response.done` as `{type:"function_call", name, call_id, arguments}`. Reply: `conversation.item.create` + `{type:"function_call_output", call_id, output}`, then `response.create`. **Function calls are natively asynchronous since GA** — the model keeps conversing while a long tool runs.

**Out-of-band responses:** `response.create` with `"response": {"conversation":"none", "output_modalities":["text"], "metadata":{...}}` — side generation that does not write to the conversation.

**MCP:** attach a remote MCP server as a session tool `{type:"mcp", server_label, server_url, authorization, require_approval}`. The Realtime API executes MCP calls itself.

**Image input: yes.** `conversation.item.create` with content `{type:"input_image", "image_url": "data:image/png;base64,..."}`. Still images only. The realtime model can see a board snapshot directly.

**Input transcription:** `session.audio.input.transcription` with `model`: `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, or (recommended, July 2026) `gpt-live-transcribe` (adds `prompt`, `keywords`, `languages`, `delay`). Events: `conversation.item.input_audio_transcription.delta` / `.completed`.

## 4. Latency and delegation best practices

Source: https://developers.openai.com/api/docs/guides/realtime-models-prompting ("Responder-Thinker" section).

- **Speak before every delegation.** One short line that describes the action ("I'll check that order now"), not filler ("Hmm"). Then call the tool immediately.
- **Async tool results are native.** The realtime model keeps talking and can answer small questions while a tool result is pending.
- **Budget:** ~2 s supervisor turnaround after the filler line is acceptable. Keep the supervisor prompt short; cap its output.
- **Rephrase, do not dump.** Template: opener + one-sentence gist + up to 3 key details + quick confirmation. For content that must be exact, have the tool return `{"response_text":..., "require_repeat_verbatim": true}`; read digits character by character.
- **Streaming back:** the sample waits for final supervisor text. If the worker is slow, split: return a first short chunk fast, push follow-ups with `conversation.item.create` + `response.create`.
- **ChatGPT's rule:** media on a fast path; all delegation behind an async boundary.

## 5. iOS specifics

- No official OpenAI Swift SDK. Paths: (1) direct WebRTC with `github.com/stasel/WebRTC` SPM (reference app: github.com/PallavAg/VoiceModeWebRTCSwift); (2) LiveKit Swift SDK (extra server component). For a single-model direct connection, plain WebRTC is enough. Data channel `oai-events` must be created BEFORE the offer.
- AVAudioSession: `.playAndRecord` + `.voiceChat` (hardware AEC). Use `RTCAudioSession` manual audio mode so WebRTC does not fight the configuration. `.defaultToSpeaker`; Bluetooth HFP drops capture to narrowband.
- Pitfalls: configure audio session before the peer connection; request mic permission ahead of first session; `audio` background mode if voice must survive backgrounding; on interruption clear local playback (`output_audio_buffer.clear`) as well as `response.cancel`.

## Recommended shape (agent synthesis)

`gpt-realtime-2.1` over WebRTC from Swift with one delegation tool + strict allow list; the worker is the settings-chosen model behind our server running the existing tool loop (read board, write workspace) and returning `nextResponse`; the realtime model speaks one action-describing line before every delegation and rephrases the worker's answer; transcripts from `conversation.item.input_audio_transcription.*` (input) and `response.output_audio_transcript.delta` (output) render the thread live like ChatGPT's Nov-2025 UI; board snapshots can also go straight to the realtime model as `input_image` for cheap "what am I looking at" turns. Watch the GPT-Live API waitlist — full-duplex + built-in delegation may replace the hand-rolled supervisor.
