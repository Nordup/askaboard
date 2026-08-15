# Sleep Offload — voice stack port guide

Research artifact, 2026-08-15. An Explore agent mapped `/Users/nordup/Projects/other/sleep` for the math-tutor voice mode. File paths below are relative to that repo.

---

## 1. Audio + WebRTC pipeline

**Library: Google WebRTC via the `stasel/WebRTC` SPM binary package, `from: 150.0.0`.** Not LiveKit, not a WebSocket. Pinned in `apps/ios/project.yml:12-14` and `apps/ios/SleepOffloadApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.

**Transport object:** `RealtimeConnection` — `apps/ios/SleepOffloadApp/Realtime/RealtimeConnection.swift:135`. `NSObject, @unchecked Sendable`, implements `RTCPeerConnectionDelegate` (`:958`) and `RTCDataChannelDelegate` (`:1094`). Callbacks fire on WebRTC's signaling/stats threads; callers hop to `@MainActor` themselves (`SessionCoordinator.wire(_:)`, `BedtimeState/SessionCoordinator.swift:535`).

Bring-up order (`connect()` → `bringUp(deadline:)`, `RealtimeConnection.swift:291-381`):

1. `RTCConfiguration`: `sdpSemantics = .unifiedPlan`, `bundlePolicy = .maxBundle`, `rtcpMuxPolicy = .require`, `continualGatheringPolicy = .gatherOnce`, one STUN server `stun:stun.l.google.com:19302` (`:310-315`).
2. `attachMicrophone(to:)` (`:578`) — `factory.audioSource` with **empty constraints** (AEC/NS/AGC come from the AVAudioSession voice-processing unit, not from WebRTC constraints), `factory.audioTrack(trackId: "sleep-offload-mic")`, `peer.add(track, streamIds: ["sleep-offload"])`.
3. Data channel `oai-events` (`static let dataChannelLabel = "oai-events"`, `:137`), `isOrdered = true`.
4. `makeOffer` → `setLocalDescription` (`:609`, `:625`).
5. `waitForIceGathering(timeout:)` (`:684`) — no trickle ICE; SDP is exchanged once over HTTP so all candidates must be in the offer. Timeout expiring here is the *normal* path and is logged with a candidate breakdown from `candidateSummary(sdp:)` (`:400`).
6. `signaling.requestAnswer(offerSDP:)` → HTTP POST to backend (see §2). Response also carries `X-Turn-Detection-Mode`.
7. `setRemoteDescription` (`:639`).
8. **`waitForDataChannelOpen(timeout:detail:)` (`:656`)** — the load-bearing step. `.iceConnected` is deliberately *not* `.connected`; only `dataChannelDidChangeState(.open)` (`:1096-1102`) means the session works.

Every stage is bounded and shares one budget (`:233-246`): SDP stages 5 s each, ICE gathering 4 s, ICE/DTLS/SCTP 15 s, whole bring-up 45 s, ICE `disconnected` grace 10 s. Bridging uses `SleepOffloadKit.CallbackDeadline` (`SleepOffloadKit/Sources/SleepOffloadKit/CallbackDeadline.swift`) via `awaitStage` (`:594`). Failure type: `RealtimeConnectionError.stageTimeout(stage:seconds:detail:)` (`:93-128`), stage name first because the DEBUG pill truncates.

**AVAudioSession:** `apps/ios/SleepOffloadApp/Audio/AudioSessionController.swift:26`. Doctrine, stated in its header: *one owner, and it is `RTCAudioSession`*. `activate()` (`:75`) mutates `RTCAudioSessionConfiguration.webRTC()`, calls `setWebRTC`, then `RTCAudioSession.sharedInstance().lockForConfiguration()` / `setConfiguration(_:active:)`. Category `.playAndRecord`; mode `.videoChat` by default (`.voiceChat` behind `AppConfig.usesVideoChatAudioMode`); options `[.defaultToSpeaker, .allowBluetoothA2DP]` and `.allowBluetoothHFP` **only** if `AppConfig.allowsBluetoothMicrophone` (off by default). Sample rate and IO buffer duration are never set (`:80-82`). Also: `reactivate()` (`:107`), `handOffToPlayback()` (`:148`, moves category to `.playback` so music outlives the session and the mic indicator goes out), `deactivate()` (`:170`), interruption/route/media-reset observers (`:214-348`).

**Mic capture measurement (no second audio unit):** the live session has *no* `AVAudioEngine` tap. `RealtimeConnection.sampleUplink()` (`:783`) walks `RTCPeerConnection.statistics` once per second (`uplinkPollInterval = 1`, `:205`) and derives an interval RMS from `media-source.totalAudioEnergy` / `totalSamplesDuration`; `Audio/TransportAcousticAnalyzer.swift:47` is the app-side shell, `SleepOffloadKit`'s `CaptureStatisticsReducer` does the arithmetic. `Audio/MicrophoneAnalyzer.swift` (the real tap) is DEBUG rehearsal-only.

**Remote playback + gain:** remote tracks adopted in `adopt(remote:)` (`:1084`) from both `didAdd rtpReceiver:` and `didAdd stream:`; each sets `track.source.volume`. Fixed per-session gain `setRemoteAudioGain(_:)` (`:491`), clamped 0…10, wired once at connect from `AppConfig.assistantOutputGain` (default **0.6**) in `SessionCoordinator.start()` (`SessionCoordinator.swift:427`).

**Barge-in ducking:** `setRemoteAudioDucked(_:)` (`:515`) multiplies by `duckedGainFraction = 0.1` (`:177`) — a duck, never a mute, because a voice that vanishes mid-word startles. Applied unconditionally on `speech_started`, released on `speech_stopped` and on `input_audio_buffer.committed` (repair path for a dropped `speech_stopped`) — `SessionCoordinator.swift:628`, `:646`, `:662`.

**Teardown:** `RealtimeConnection.close()` (`:419`) — idempotent via `isClosed`, resolves any pending data-channel waiter with `.notConnected`, stops both stats timers, disables local + remote tracks, closes channel and peer, nils delegates, emits `.closed`. Session-level teardown `SessionCoordinator.finishSession(reason:message:)` (`:1408`): guard stands down → mic disabled → `connection.close()` → record unfinished assistant lines → stop ticker/orb/analyzer → **either** `handOffToPlayback()` (music still playing) **or** `deactivate()` → persist end reason → schedule morning recap → flush sync queue → `POST /api/sessions/{id}/end` → backfill.

Optional app-owned audio graph (off by default): `AppConfig.usesAudioEngine` → `Music/AudioEngineHost.swift` + `Music/RTCAudioEngineDevice.swift` (a custom `RTCAudioDevice` handed to a *per-connection* `RTCPeerConnectionFactory(encoderFactory:decoderFactory:audioDevice:)`, `RealtimeConnection.swift:270-281`).

---

## 2. Auth

**No ephemeral tokens.** The backend is an SDP proxy holding the permanent key.

- Client: `Realtime/RealtimeSignalingClient.swift:52` — `POST {serverBaseURL}/api/realtime/calls`, `Content-Type: application/sdp`, `Accept: application/sdp`, header `X-Client-Id` = SHA-256 of an install-local UUID (`App/AppConfig.swift:46-59`). Ephemeral `URLSession`, 30 s timeout. Response body is the raw answer SDP; response header `X-Turn-Detection-Mode` names the negotiated mode.
- Server: `apps/server/src/routes/realtime-session.ts:89-219`. Validates content type and that the body starts with `v=`, then:

```ts
const form = new FormData();
form.set("sdp", offer);
form.set("session", JSON.stringify(buildSessionConfig({ model, voice, turnDetectionMode: mode, musicTracks })));
return fetch(`${config.openaiBaseUrl}/realtime/calls`, {
  method: "POST",
  headers: { Authorization: `Bearer ${config.openaiApiKey}`, "OpenAI-Safety-Identifier": sha256(clientId) },
  body: form,
  signal: AbortSignal.timeout(20_000),
});
```

Upstream URL default `https://api.openai.com/v1` (`apps/server/src/config.ts:54`) → `POST https://api.openai.com/v1/realtime/calls`. Model default `gpt-realtime-2.1-mini` (`apps/server/src/openai/session-config.ts:48`; full sibling `gpt-realtime-2.1`, env `OPENAI_REALTIME_MODEL`). Extras worth copying: one retry with the `server_vad` fallback when the upstream rejection matches `/semantic_vad|turn_detection|eagerness/i` (`:46`, `:166`); `redactApiKey` (`:236`) strips both the exact key and anything `sk-…`-shaped from upstream errors before logging or returning; `safetyIdentifier()` (`:225`) hashes the client id again.
- Second endpoint: `GET /api/realtime/session-policy?turnDetection=…` (`:76`), configuration only, no secrets.
- Route mounting + logging middleware (paths and status codes only, never bodies): `apps/server/src/index.ts:52-71`.

---

## 3. Realtime session config

Built server-side by `buildSessionConfig` — `apps/server/src/openai/session-config.ts:441-470`:

```ts
return {
  type: "realtime",
  model: options.model ?? resolveRealtimeModel(),
  instructions: composeInstructions(SESSION_INSTRUCTIONS, options.musicTracks),
  output_modalities: ["audio"],
  audio: {
    input:  { format: { type: "audio/pcm", rate: 24000 },
              turn_detection: bedtimeTurnDetection(mode),
              transcription: { ...BEDTIME_TRANSCRIPTION },
              noise_reduction: { ...BEDTIME_NOISE_REDUCTION } },
    output: { format: { type: "audio/pcm", rate: 24000 },
              voice: options.voice ?? resolveRealtimeVoice(),
              speed: normalizeSpeed(options.speed ?? DEFAULT_REALTIME_SPEED) },
  },
  tools: toolsFor(options.musicTracks),
  tool_choice: "auto",
};
```

- **Voice:** `cedar` (`DEFAULT_REALTIME_VOICE`, `:65`); fallbacks `sage`, `marin`; enum of 10 valid voices at `:71`. Voice is locked once the model has produced audio → choose at session creation only.
- **Speed:** `0.9` (`:94`) and **at most two decimal places** — `normalizeSpeed` (`:103`) exists because the API rejects the whole `session.update` with `decimal_max_decimal_places_exceeded` otherwise.
- **Turn detection:** `BEDTIME_TURN_DETECTION` (`:219`) `{ type: "semantic_vad", eagerness: "low", create_response: false, interrupt_response: false }`. Fallback `BEDTIME_TURN_DETECTION_FALLBACK` (`:232`) `{ server_vad, threshold 0.5, prefix_padding_ms 400, silence_duration_ms 2000, create_response false, interrupt_response false }`. Third profile `CODEX_TURN_DETECTION` (`:264`) `{ server_vad, 0.5, 300, 500, create_response true, interrupt_response true }` — env `REALTIME_TURN_DETECTION=codex`, under which the phone's gate stands down (`serverDrivesTurns`, `:283`). No `idle_timeout_ms` anywhere, deliberately.
- **Transcription:** `BEDTIME_TRANSCRIPTION` (`:122`) — model `gpt-live-transcribe`, `language: "en"` (unpinned it hallucinated Korean/Japanese on quiet English, which also broke semantic VAD), plus an acoustic-situation `prompt`.
- **Noise reduction:** `{ type: "far_field" }` (`:139`).
- **Instructions:** `SESSION_INSTRUCTIONS` (`:181-185`) is 3 sentences. Three byte-identical copies exist and a test enforces it (`apps/server/test/prompt-sync.test.ts`): here, `docs/prompt.md` §1, and `apps/ios/SleepOffloadApp/Realtime/SessionInstructions.swift:23`. Music catalogue is *appended* at build time (`composeInstructions`, `:426`) so the constant stays identical.
- Types: `packages/contracts/src/realtime-events.ts` (`RealtimeSessionConfig`, `RealtimeSemanticVad`, `RealtimeServerVad`, `RealtimeTranscriptionConfig`, `RealtimeNoiseReduction`).

**Mid-session updates from the phone** (`Realtime/RealtimeEvents.swift`, `enum RealtimeEventEncoder`):
- `sessionUpdate(basePrompt:continuation:)` (`:299`) — sends only `{type:"session.update", session:{type:"realtime", instructions}}`. The API replaces instructions wholesale, so the whole prompt rides every time. Sent at data-channel open and at `session.created`, nowhere else.
- `audioPolicyUpdate(policy:)` (`:393`) — **forwards the server's exact bytes**. `RealtimeAudioPolicyPayload.sessionUpdateData` = `Data(sessionUpdateJSON.utf8)` (`SleepOffloadKit/.../RealtimeSessionPolicyPayload.swift:41`). Reason: Foundation re-encodes a parsed `0.9` as `0.90000000000000002` and the API atomically drops the whole event. **Rule: no OpenAI-bound number is ever re-encoded on device.** Exact wire bytes in `packages/contracts/fixtures/session-policy.json`.
- `keepalive()` (`:401`) — `{"type":"session.update","session":{"type":"realtime"}}`, a no-op that cannot be rejected.

---

## 4. Turn-taking

Two layers: **OpenAI's semantic VAD only segments; the phone decides when the model speaks.**

- Server config sets `semantic_vad` with `eagerness: "low"` and **both** `create_response` and `interrupt_response` false.
- `SleepOffloadKit/Sources/SleepOffloadKit/TurnHoldOff.swift:49` — pure struct, injected `Date`, unit-tested. Emits `Action.none | .createResponse | .cancelResponse`.
  - Rule 1 — wait out a pause: `turnCommitted(at:)` (`:136`) arms `replyDueAt = at + holdOffSeconds` (**2.5 s**, `AppConfig.replyHoldOffSeconds`). `userSpeechStarted()` disarms it, so bursts either side of a breath merge into one turn.
  - Rule 2 — only cancel a reply that has made noise: `userSpeechStarted()` (`:112`) returns `.cancelResponse` **only if** `responseInFlight && responseHasSpoken`. `responseHasSpoken` is set by `responseProducedAudio()`, driven from `response.output_audio_transcript.delta` because this transport never sends `output_audio_buffer.started` (SessionCoordinator.swift:709-715).
  - Deferral queue: a hold-off expiring under an open response sets `createDeferred`; `responseEnded()` (`:176`) releases it.
  - Race repair: `createRejectedAsRacing(at:)` (`:167`) restores the turn when the API answers "Conversation already has an active response in progress". Detected by `RealtimeErrorPayload.isActiveResponseConflict` (`Realtime/RealtimeEvents.swift:30`).
  - Failsafe: any committed turn unanswered for `failsafeSeconds` (**12 s**, `:69`) is answered regardless.
- Wiring: `SessionCoordinator.applyTurnGate(_:)` (`SessionCoordinator.swift:1062`) is the only place gate decisions reach the wire; it no-ops when `serverDrivesTurns` (`:1057`). `turnGate.tick(now:)` runs on a 1 Hz wall-clock tick (`:1162`).
- Barge-in is **two independent halves**: `response.cancel` (stops generation) *and* `setRemoteAudioDucked(true)` (stops the sound already on the wire). The duck is unconditional and fires first (`:618-628`).
- The app never sends `conversation.item.truncate` — it only *decodes* server-issued `conversation.item.truncated` (`RealtimeEvents.swift:67`, `SessionCoordinator.swift:760`).

NOTE for math-tutor: the tutoring register wants faster turn-taking than bedtime. The codex profile (`server_vad`, 500 ms silence, `create_response: true`, `interrupt_response: true`) is closer to what a tutor needs; semantic_vad with higher eagerness is the middle ground.

---

## 5. Tool calls

Three tools, all defined in `packages/contracts/src/`:

| Tool | Schema | Executed by |
|---|---|---|
| `capture_item` | `captured-item.ts:79` (`CAPTURE_ITEM_TOOL`) | `Capture/CaptureService.swift:36` → `SleepOffloadKit/CaptureToolParser.swift:21` |
| `remain_silent` | `realtime-events.ts:119` (`REMAIN_SILENT_TOOL`) — empty params | `SessionCoordinator.execute` (`:951`) |
| `music_control` | `music.ts:171` (`MUSIC_CONTROL_TOOL`) | `Music/MusicController.handleToolCall(argumentsJSON:)` |

Receive path (`SessionCoordinator.handle(event:)`): both `response.function_call_arguments.done` (`:728`) and any `function_call` items swept out of `response.done` (`:743`) route into `execute(_:)` (`:933`), de-duplicated by `handledCallIds`.

Return path — three distinct shapes:

```swift
// capture_item: dictionary result + a reply
send(event: { try RealtimeEventEncoder.functionCallOutput(callId: call.callId,
                                                          output: CaptureService.toolOutput(for: outcome)) },
     description: "function_call_output")
send(event: { try RealtimeEventEncoder.responseCreate() }, description: "response.create")
```

- `music_control` uses `functionCallOutput(callId:outputJSON:)` (`:336`) because a pre-built JSON string passed through the dictionary form would be double-encoded; then a `response.create`.
- `remain_silent` uses `emptyFunctionCallOutput(callId:)` (`:354`) — `output: ""`, **not** `{}`, because a status object is a line the model can decide to read aloud — and **deliberately no `response.create`**.
- Ordering invariant: the item is written to SwiftData *before* the tool output is sent (`:994-1011`).

---

## 6. Orb UI (reference for mascot animation driving)

Four files under `apps/ios/SleepOffloadApp/UI/Orb/`. **SwiftUI `Canvas` + `TimelineView`, no Metal**, one 256² grain tile per process.

- `Orb/OrbView.swift:7` — `TimelineView(.animation(minimumInterval:))` at 60 fps docked / 30 fps risen; a single `Canvas`; 320×320 invisible tap target.
- `Orb/OrbMotion.swift:35` — the integrator (integrates in `dt`, never samples `f(t)`), so envelopes/clocks survive screen swaps. `frame(at:inputs:) -> OrbFrame` (`:186`), `advance(to:inputs:ambient:)` (`:343`).
- `Orb/OrbPainter.swift:9` — `static func draw(_ frame: OrbFrame, in context: inout GraphicsContext)`.
- `Orb/OrbGeometry.swift` — numbers keyed to a 393×852 design frame; rise 1400 ms `cubic-bezier(0.22,0.61,0.36,1)` (`UnitBezier`, `:249`).

**Driven by audio level, not by a discrete state machine.** Pinned interface — `UI/OrbState.swift:26`:

```swift
struct OrbDisplayState: Equatable { var audioLevel: Double; var isConnecting: Bool }
```

- `audioLevel` — 0…1 normalized speech level from the mic (−48 dBFS → 0, −12 dBFS → 1, `SessionCoordinator.normalizedSpeechLevel`, `:1990`). Returns 0 while the assistant speaks, while stale (> 1.5 × poll interval), or while the window overlapped playback.
- Motion detail: squelch 0.08, envelope attack 80 ms / release 400 ms with a linear drain below `e⁻¹`; depth curve Naka–Rushton k = 3; four coprime rim lobes modes 2/3/5/7.
- Publishing: `OrbStateProvider` (`UI/OrbState.swift:10`) is a **separate `ObservableObject`** so a 10 Hz level does not re-evaluate the root view. Refreshed by a Timer at 0.1 s (`SessionCoordinator.startOrbRefresh()`, `:1908`).
- One shared `OrbMotion` instance injected via `EnvironmentValues.orbMotion` (`UI/OrbEnvironment.swift:55`).
- Offline harness: `UI/ScreenshotHarness.swift` renders motion+painter to PNG under `-uiState orb|orbSheet|orbUplink`.

NOTE for math-tutor: the mascot needs BOTH assistant-driven talking animation and user-driven listening animation — the sleep app deliberately dropped assistant-driven motion; we want it back. Echo-cancellation zeros (see §10.6) mean the user level is unreliable while the assistant speaks; drive talking animation from assistant output level or transcript deltas instead.

---

## 7. UI structure around the voice session

- `UI/RootView.swift:13` — sidebar slides; all disabled during a session.
- Enter/exit: start and session are *one screen*, swapped inside `withTransaction { transaction.disablesAnimations = true }`.
- `UI/SessionView.swift:13` — risen orb, `statusBarHidden`, `isIdleTimerDisabled = true`. No transcript during the session.
- **Transcripts are recorded live but shown only afterwards.** `SessionCoordinator.transcript: [TranscriptLine]` (`:35`) — assistant deltas streamed into a line keyed by item/response id (`appendAssistantDelta`, `:2007`), trimmed to 200 lines, persisted as `Utterance` rows.
- Reader: `UI/SessionReaderView.swift:16`; message views in `UI/ChatMessageViews.swift` (`UserBubble`, `AssistantText`, `SavedChip`, `TimelineDivider`, `ScrollToBottomPill`).

NOTE for math-tutor: we DO show live transcript in the chat panel during voice — different from sleep. The delta-accumulation plumbing (`appendAssistantDelta` keyed by item id) is directly reusable; render target changes.

---

## 8. Settings

- Release: `UI/SettingsSheetView.swift:8` — nothing voice-configurable by design.
- DEBUG: `UI/DevPanelView.swift:8` — server URL, idle-end slider, audio toggles (BT HFP off by default, video-chat mode), assistant volume 0.20–1.20, session diagnostics. Every knob writes through `commit(_:_:_:)` → `coordinator.noteConfigChange`.
- Backing store: `App/AppConfig.swift` (UserDefaults).

---

## 9. Event plumbing

Event loop: `SessionCoordinator.handle(event: RealtimeServerEvent)` — `BedtimeState/SessionCoordinator.swift:586-792`. Decoded by `RealtimeEventDecoder.decode(_:)` — `Realtime/RealtimeEvents.swift:142-282`.

**Decoded server events** (`enum RealtimeServerEvent`, `RealtimeEvents.swift:73`):
`session.created` · `session.updated` · `input_audio_buffer.speech_started` · `.speech_stopped` · `.committed` · `conversation.item.input_audio_transcription.delta` · `.completed` (three-way `RealtimeTranscriptPresence`: `.words` / `.emptyString` / `.absent`) · `.failed` · `response.created` · `response.output_audio_transcript.delta` · `.done` · `response.function_call_arguments.done` · `response.done` (status + swept `function_call` items) · `output_audio_buffer.started` / `.stopped` / `.cleared` · `conversation.item.truncated` · `error` · `.unhandled(type:)`.

**Encoded client events** (`enum RealtimeEventEncoder`, `:287`): `session.update` (instructions) · `session.update` (verbatim audio policy) · `session.update` (no-op keepalive after 40 s silence, min 20 s apart) · `conversation.item.create` + `function_call_output` (3 variants) · `response.create` · `response.cancel`. All go through one funnel `send(event:description:logged:)` (`:1078`) which records `lastOutboundDescription` so a subsequent `error` can be attributed.

---

## 10. Hard-won things (copy these before you copy anything else)

1. **Double audio-session ownership causes the crackle.** The first build set a 20 ms preferred IO buffer directly on `AVAudioSession`, outside `RTCAudioSession`'s lock. Every mutation now goes through `lockForConfiguration`/`setConfiguration`, and **nothing asks for a buffer size or a sample rate**. Never prefer 24 kHz on device even though the wire format says 24 kHz — WebRTC resamples anyway.
2. **The 44.1 kHz trap in the app-owned graph.** `connect(deck, to: mixer, format: nil)` resolves to 44100 at attach time and scheduling a 48 kHz buffer does not throw — it plays 8.90 % flat.
3. **Never run a second audio unit.** An `AVAudioEngine` tap alongside WebRTC's ADM fought for the mic; the uplink died 3–4 times in ten minutes.
4. **A disabled `RTCAudioTrack` transmits silence and everything else looks healthy.** Every mute needs an owner + watchdog (`SleepOffloadKit/UplinkGuard.swift`); only the far end hearing a word clears an alert; a successful `setActive(true)` is a hope, not evidence.
5. **Dead-capture detection without a waveform.** `totalSamplesDuration` advancing + `totalAudioEnergy` flat = digital silence (`RealtimeConnection.swift:863-920`). Absent statistics are `nil`, never 0.
6. **Echo cancellation produces a true zero while the loudspeaker plays** — every uplink rule gated on `assistantIsSpeaking`.
7. **Number re-encoding kills whole `session.update`s.** Foundation re-encodes `0.9` as `0.90000000000000002`; forward server bytes verbatim.
8. **ICE up ≠ session usable.** Wait for the data channel open, not `.connected`.
9. **Backgrounding:** `UIBackgroundModes: [audio]`, 1 Hz ticker on `.common` mode, wall-clock `Date()`, `isIdleTimerDisabled`, `scenePhase == .active` reconciliation.
10. **`output_audio_buffer.started` never arrives on this transport** — "response has made a sound" is inferred from the first `response.output_audio_transcript.delta`, which runs 5–15 s ahead of the loudspeaker.
11. **Media services reset** rebuilds the whole stack (`AudioSessionController.handleMediaServicesReset`, `:340`).
12. **Ending with music playing must not call `deactivate()`** — `handOffToPlayback()` moves to `.playback` instead.
13. **Bluetooth HFP off by default** — HFP + `.playAndRecord` collapses audio to mono 8–16 kHz.
14. **Simulator cannot host this.** WebRTC's voice-processing IO unit hangs in `AURemoteIO::Initialize`; process killed ~10 s later. Voice must be tested on device.

**Known doc/code divergence in the sleep repo:** `docs/ios.md:286` is stale about `create_response` and the keepalive; the code is the source of truth.

**Suggested port order:** Kit logic (`TurnHoldOff`, `CallbackDeadline`, `RealtimeSessionPolicyPayload`, `UplinkGuard`, `SessionIdleTimer`) → `AudioSessionController` → `RealtimeConnection` + `RealtimeSignalingClient` + `RealtimeEvents` → server realtime routes + session config → `SessionCoordinator` → visual.
