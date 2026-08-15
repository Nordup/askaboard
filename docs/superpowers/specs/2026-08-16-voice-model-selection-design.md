# Voice model selection — design

Date: 2026-08-16. Status: approved, ready for a plan.

## What this adds

A third picker row in the settings window's Tutor pane: **Voice model**, Full or
Mini. It mirrors the existing **Tutor model** row exactly — same row component,
same session-scoped persistence, same "applies to your next message" lifecycle.

It also changes the realtime voice from `marin` to `cedar`, the sleep project's
default. That is a one-line settings change and carries no UI.

## Why

Voice is the product's live cost constraint. A voice minute on the full realtime
model bills audio at $32 in / $64 out per 1M; the mini bills $10 / $20. Today the
model is server-chosen and there is no way to trade quality for cost without an
env change and a redeploy. This puts the lever in the window beside the tutor
model, which is where the learner already goes to make exactly that trade.

**The default moves to Mini**, on both sides — `LearningSession` and
`Settings.openai_realtime_model`. This reverses the voice-mode design's founder
decision (2026-08-15) that the default is always the full model, on the grounds
that the mini is weakest exactly where voice leans hardest: reliably calling
`send_to_tutor` rather than ad-libbing an answer out loud.

Cost decided it. The recorded evidence is one session — 2026-08-15 21:39–21:43,
`244b26d4` — where seven voice responses cost $0.0492 against two text turns at
$0.0121: voice was 80% of the session *already running on the mini*. The same
session on the full model would have been roughly three times the voice line.

The risk is real and unmitigated: if the mini starts answering instead of
delegating, this default is the first thing to reconsider, and Full is one row
away in the settings window.

## Models and prices

| Model | Audio in | Cached audio | Audio out | Text in | Cached text | Text out |
|---|---|---|---|---|---|---|
| `gpt-realtime-2.1` | $32.00 | $0.40 | $64.00 | $4.00 | $0.40 | $24.00 |
| `gpt-realtime-2.1-mini` | $10.00 | $0.30 | $20.00 | $0.60 | $0.06 | $2.40 |

Per 1M tokens. The full model's row already exists in `REALTIME_PRICES_PER_1M`.
The mini's numbers were read from `developers.openai.com/api/docs/models/
gpt-realtime-2.1-mini` on 2026-08-16 and go in with that date in the comment,
matching how `MODEL_PRICES_PER_1M` records its own verification.

## Device

**Domain.** `VoiceModelChoice: String, Codable, CaseIterable, Sendable,
Identifiable` in `Domain/Models.swift`, beside `ModelChoice`:

- `.full = "gpt-realtime-2.1"` — title "Full", caption "Best tool use"
- `.mini = "gpt-realtime-2.1-mini"` — title "Mini", caption "Cheaper, less reliable"

The captions are the honest trade rather than marketing: the reason to pick Full
is that it calls `send_to_tutor` when it should, and the reason to stay on Mini
is that it costs a third as much.

**Session.** `LearningSession.selectedVoiceModel: VoiceModelChoice`, defaulted to
`.mini`, decoded through the same missing-key fallback `reasoningEffort` uses, so
session files written before this change keep loading and opt into the default.
Session-scoped, not app-wide: the tutor model works this way, and two rows in one
pane with different lifecycles would be a trap.

**Store.** `TutorStore.setVoiceModel(_:)` beside `setModel`.

**Settings UI.** `SettingsOption.voiceModels(selected:)` mirroring
`.models(selected:)`, and a third `SettingPickerRow` in `TutorPane`:

- label "Voice model", caption "Which voice answers out loud"
- `identifierPrefix: "voice-model-option"`

The pane needs no new lede. Its existing one — "How the tutor thinks and speaks"
— already covers this row; that phrase is why the row belongs here and not in a
pane of its own.

**Window height.** `SettingsWindowMetrics.designSize` grows from 760 × 520 to
760 × 560. Three 120pt rows need 360; the pinned 116pt header and 32pt of padding
top and bottom take 180; the total is 540, and 520 is 20 short. 560 restores a
small bottom slack rather than fitting exactly, so the pane does not read as
packed to its edge. The clamp in `init(layout:)` is unchanged and the reference
screen's content band (about 980pt) is far above 560.

**Wire.** `RealtimeSignalingClient.requestAnswer` adds a `model` query item next
to `session_id`. `RealtimeUsageReporter.body` gains `"model"`. Both send the
session's `selectedVoiceModel.rawValue`.

## Server

**Allowlist.** `REALTIME_MODEL_ALLOWLIST: frozenset[str]` in `app/config.py` with
both models, plus an import-time check that every allowlisted model has a price
row — the same guard `MODEL_ALLOWLIST` already carries, for the same reason: an
allowlist edit that forgets the price should fail the boot, not the month's bill.

**Call route.** `build_realtime_session(mode, model)` takes the model rather than
reading the setting itself. `create_realtime_call` accepts an optional `model`
query parameter: absent falls back to `settings.openai_realtime_model`, present
and off the allowlist is a 422, present and on it is used. Every existing log line
in the route reports the model actually used rather than the setting.

**Usage route.** `RealtimeUsageBody.model: str | None`, validated against the same
allowlist, falling back to the setting when absent so an in-flight older client
keeps recording. This reverses that field's current "no `model` field on purpose"
comment, and the reversal is narrow: the invariant was never "the device cannot
name a model" but "the device cannot name a price". An allowlist that every entry
must be priced under keeps that invariant intact, and it is exactly how
`TurnRequest.model` has always worked.

Recording the model the call really used is not optional once the picker exists.
Without it a mini call bills at full rates, which over-states spend and hides the
saving the picker was added to produce.

**Voice.** `Settings.openai_realtime_voice` default becomes `"cedar"`. Its comment
keeps the note that voice locks once the model has produced audio.

**Default model.** `Settings.openai_realtime_model` becomes
`"gpt-realtime-2.1-mini"`, matched to the client's default so both sides of a
call agree about what a session opens on. It is now only the fallback for a call
that names no model — every call the app opens names one.

## Tests

Device:

- `SettingsOption.voiceModels(selected:)` returns both cases in `allCases` order
  with exactly one selected, and its titles and captions match `VoiceModelChoice`.
- `TutorStore.setVoiceModel` moves `session.selectedVoiceModel`.
- A `LearningSession` encoded and decoded keeps the choice; a fixture missing the
  key decodes to `.full`.
- The Tutor pane's three rows fit `SettingsWindowMetrics.reference` — an assertion
  on the arithmetic, so a fourth row or a taller row fails a test rather than
  silently clipping.

Server:

- `build_realtime_session` puts the passed model in the session config.
- `POST /v1/realtime/calls?model=` off the allowlist is a 422; absent uses the
  setting; on the allowlist reaches the upstream call with that model.
- A usage report naming the mini is priced from the mini's row; one naming a model
  off the allowlist is a 422 that writes no row; one with no model is priced from
  the setting. The refusal test needs the database fixture even though it writes
  nothing: FastAPI resolves `get_recorder` before it validates the body, so a bare
  `create_app()` fails on the missing engine rather than on the model.
- Every model in `REALTIME_MODEL_ALLOWLIST` has a complete price row, and the mini
  is cheaper than the full model in all six modalities — otherwise the row's
  caption is a lie on screen.

## Design source

Board 10 in the Paper file is updated first — the third `row/setting` and the
760 × 560 window — and the code mirrors it. No number in `SettingsWindowMetrics`
changes without the board changing.
