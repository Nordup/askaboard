# Activity Trail — Design

**Date:** 2026-08-10
**Status:** Approved, ready for implementation planning

## Problem

A tutor turn is quiet for a long time. The learner sees one word, "Thinking",
and nothing else. Then the reply appears. The app looks slow, and it looks
broken.

The stream itself is not the fault. The server asks the provider for a stream
(`loop.py`, `"stream": True`). It translates each `response.output_text.delta`
into a `TextDeltaEvent` (`events.py`). It writes every event to the wire at
once, and `X-Accel-Buffering: no` (`sse.py`) stops a proxy that would hold
them. The client reads the lines as they arrive
(`BackendTutorService.stream`) and appends each chunk to the same message
(`TutorStore`). The prose does arrive one token at a time.

The silence is what comes **before** the prose, and the app throws away the
data that would fill it.

1. **The reasoning summary is discarded.** These are reasoning models. The
   model thinks first and writes second. The server asks the provider for a
   summary of that thought (`"summary": "auto"` in `loop.py`) and sends it as
   `ReasoningDeltaEvent` (`events.py`). `TutorEvent.decode` parses it. Then
   `TutorStore` runs `case .reasoningDelta: break` and drops it.
2. **A tool call says almost nothing.** The model often calls `update_board`
   or `set_workspace` before it writes. The arguments of one diagram are
   thousands of tokens. During all of that the device shows one status word.
3. **The status vocabulary is five words.** `thinking`, `looking`,
   `searching`, `writing`, `drawing`. The server knows the tool name and the
   tool arguments. It sends neither.

## What this builds

An activity trail, in the shape ChatGPT uses.

While the turn runs, the trail is open above the reply. It shows the reasoning
summary as it streams, and a named row for each step the tutor takes. When the
turn ends, the trail closes into one line — `Worked for 1m 15s ›`. A tap opens
it again. The trail is saved with the session, so a thread opened next week
still opens.

## Decisions

Four decisions set the scope. Each one was made, not assumed.

- **The trail is saved and survives a relaunch.** It is not a live-only
  effect.
- **The trail shows the reasoning prose, not only the step names.** The
  provider sends a *summary*, not the raw chain of thought; no client of any
  provider gets the raw chain. Accept that a learner can read the tutor's
  approach before they solve the problem. This is a deliberate trade for a
  live product, and a later parent setting can gate it.
- **A board image moves into the trail.** Today a region the tutor looked at
  appears in the chat thread under the reply. It becomes evidence inside its
  own step, and the thread holds only the learner's message and the reply.
- **A step is its own event, not a reused `status`.** See below.

## Approach

### Why a new event and not `status`

`StatusEvent` already carries an unused `detail` field, so filling it in looks
like the small change. It is the wrong one. The heartbeat re-sends the current
`status` every `HEARTBEAT_SECONDS` to keep the connection open
(`EventTranslator._heartbeat`). The client could not tell a new step from a
keep-alive, and one long diagram would grow a row every five seconds.

So `status` keeps its one job — the current phase, idempotent, safe to repeat
— and a step gets its own type. An unknown event type is ignored by
`TutorEvent.decode`, so the server can ship first and no release has to be
coordinated.

### A step is sent twice

The good label for a step lives in the tool arguments. The arguments are
complete only at `response.function_call_arguments.done`, which for a large
diagram is minutes after the call starts. A step that waits for its label
rebuilds the silence this design removes.

So each step goes out twice, with the same id:

1. At `response.output_item.added`, with a general label — "Drawing on the
   board". This is immediate.
2. At `response.function_call_arguments.done`, with a label made from the
   arguments — "Drew 3 shapes". The client replaces the row.

A tool with short arguments, such as `search_memory`, is refined almost at
once. `update_board` is refined at the end, and its general label covers the
whole gap.

`EventTranslator` already keeps the map from `output_index` to tool name, and
already parses `set_workspace` and `update_board` arguments. Both halves of
this reuse work that exists.

## The wire

A new event in `server/app/tutor/events.py`, added to the `ClientEvent` union:

```python
class StepEvent(BaseModel):
    type: Literal["step"] = "step"
    #: The provider's `call_id`, which is what `board_request` already uses to
    #: name a call. Stable across the two emissions, so the client replaces a
    #: row instead of appending a second one.
    #:
    #: Deliberately **not** `output_index`. A turn runs up to
    #: `MAX_TOOL_ROUNDS` rounds and each round numbers its own output from
    #: zero, so round two's first call and round one's first call would carry
    #: the same id — and the client would overwrite a completed step with an
    #: unrelated one. `call_id` is unique for the whole turn.
    id: str
    tool: str
    label: str
```

`call_id` is on the `function_call` item at `response.output_item.added`, but
`response.function_call_arguments.done` carries only `output_index`. So
`EventTranslator` records `output_index -> call_id` beside the
`output_index -> name` map it already keeps, and the refinement looks the id
back up. Both maps are overwritten by a later round using the same index,
which is correct: the lookup only ever happens inside the round that wrote it.

`EventTranslator._translate` emits it from the two branches it already has:

- `response.output_item.added` — a `function_call` item. It already records
  the tool name and returns a `StatusEvent`. It now returns the `StatusEvent`
  and a `StepEvent` with the general label.
- `response.function_call_arguments.done` — it already switches on the tool
  name for `set_workspace` and `update_board`. It now also returns a refined
  `StepEvent` for every known tool.

Labels, by tool:

| Tool | General label | Refined label |
|---|---|---|
| `update_board` | Drawing on the board | Drew 3 shapes |
| `view_board` | Looking at the board | Looked at the top-left corner |
| `set_workspace` | Making a plan | Set the plan: Fractions |
| `search_memory` | Searching memory | Searched memory for fractions |
| `recent_sessions` | Searching memory | Looked at recent sessions |
| `remember` | Saving a note | Saved a note |
| `record_evidence` | Recording progress | Recorded progress |

`view_board` gets its refined label from the `detail` argument, which
`BoardRequestEvent` already carries. `update_board` gets its count from the
payload `parse_board_update` already returns. `remember` and `record_evidence`
keep a coarse label on purpose: their arguments are what the tutor concluded
about the learner, and that is not a thing to put on the learner's screen.

A tool that is not in this table produces no step. This is the same rule
`TOOL_PHASES` already uses.

## The client

### Model

`MathTutor/Domain/ActivityTrail.swift`, new:

```swift
struct ActivityTrail: Codable, Equatable, Sendable {
    var items: [TrailItem] = []
    /// Set on `.done`. Nil while the turn runs, and nil forever on a turn
    /// that failed — which is what tells the view to say nothing rather than
    /// claim a duration it never measured.
    var duration: TimeInterval?
}

enum TrailItem: Codable, Equatable, Sendable, Identifiable {
    /// Grows in place, one `.reasoningDelta` at a time.
    case reasoning(id: UUID, text: String)
    case step(TrailStep)
}

struct TrailStep: Codable, Equatable, Sendable, Identifiable {
    /// The server's step id. Not a UUID: it is the provider's output index.
    let id: String
    var tool: String
    var label: String
    /// The board render this step produced, by the id it is filed under in
    /// `BoardCropStore`. Only `view_board` sets it.
    var imageID: UUID?
}
```

`TutorMessage` gains one field:

```swift
var activity: ActivityTrail?
```

`TutorMessage` already writes its own `init(from:)` because Swift's generated
decoder throws `keyNotFound` rather than using a default. `activity` is
decoded the same way, so every session file already on disk still loads.

### Where the images live

Board crops are not saved today, and `TutorStore` says why: a `TutorMessage`
is `Codable`, and three PNGs would put several hundred kilobytes into the
session file, which every later save would rewrite.

That objection is correct and it stays. The trail does not put bytes in the
session JSON. It holds a `UUID`, and the bytes go to disk beside the session
— the pattern `AttachmentStore` already uses for sent thumbnails: one flat
directory keyed by id, plus a `bySession.json` index so deleting a session can
find its files.

`AttachmentStore`'s own comment gives a second reason not to save a crop: a
crop is re-derivable from the board, and a photograph of homework is not. That
reason does not hold here. A crop is only re-derivable while the board has not
changed, and a trail that survives a relaunch is precisely the case where the
board *has* changed. Re-rendering it later would show today's board and call
it what the tutor saw. That is worse than showing nothing.

So: a new `BoardCropStore`, built on `AttachmentStore`'s shape, saving PNG
rather than JPEG because the source is ink on white. `deleteAll(for:)` is
called from the same place that already deletes a session's thumbnails.

### Store flow

`TutorStore.requestTutor` changes in four places.

1. **The message is created earlier.** Today it is appended on the first
   `.textDelta`. The trail starts before any text exists, so the message is
   now created on the first of `.reasoningDelta`, `.step` or `.textDelta` —
   whichever arrives first. Lazily, not at turn start: a turn that fails
   before the provider answers must not leave an empty bubble in the thread.
2. **`.reasoningDelta` is consumed.** It appends to the trailing
   `.reasoning` item, or starts one if the last item is a step.
3. **`.step` is handled.** A step whose id is already in `items` is replaced
   in place. A new id is appended.
4. **`.boardViewed` writes its PNG** through `BoardCropStore` and sets
   `imageID` on its own step.

`.boardViewed` gains the `callID` it was produced from. `BackendTutorService`
already holds it — the case it answers is `.boardRequest(callID:region:detail:)`
— and it is the same id the step carries, so the crop lands on the exact step
that asked for it. Without it the store would have to guess "the most recent
`view_board` step with no image", which is wrong the moment a turn asks for two
regions and the second render comes back first.

`pendingBoardViews` and `flushPendingBoardViews` are deleted. They exist only
because a board view could arrive with no message to attach it to, and the
message now exists by then. `boardViews` and `attach` are deleted with them.
`selectionViews` is untouched: it holds what the *learner* pointed at, which
is a different claim and stays in memory.

`persist()` still runs once on `.done`, not per delta.

### Duration

Measured on the device, from the moment the turn is sent to `.done`. Not sent
by the server, because the number the label claims is the time the learner
waited, and that includes the network.

## The view

The trail is designed in the Paper file first and extracted to code after,
which is this project's rule for anything the learner sees.

Two states:

- **Open**, while the turn runs and after a tap. The reasoning text is set in
  a muted style. Each step is a row: an icon, the label, and — for a
  `view_board` step — the crop below it, using the thumbnail treatment
  `BoardViewsRow` already draws.
- **Closed**, after `.done`. One row: `Worked for 1m 15s ›`. Tapping it opens
  the trail again.

The trail sits above the reply, in the tutor message's own column.

`ThinkingIndicator` stays. It is what the panel shows before the first trail
item arrives, and that gap is now short. `TutorPanel` shows it while
`store.isLoading` and the phase is not `.writing`; the trail replaces nothing
there.

A turn with no trail items draws no trail row.

## Testing

Server, in `server/tests/test_events.py`:

- One `function_call` item produces one `StepEvent` with the general label.
- The matching `arguments.done` produces a second `StepEvent` with the same
  id and the refined label.
- A heartbeat produces a `StatusEvent` and never a `StepEvent`.
- An unknown tool name produces no step.
- Two rounds, each with a call at `output_index` 0, produce two steps with
  different ids. This is the regression test for the collision above.
- `update_board` and `set_workspace` still produce their existing events.

Client:

- `TutorEvent.decode` parses a `step` line, and still ignores an unknown type.
- A session file written before this change decodes with `activity == nil`.
- A trail survives a save and a load, images included.
- A step id that arrives twice replaces its row rather than appending.
- Two `view_board` steps whose renders return out of order each get their own
  crop.
- A turn that fails before any event leaves no empty tutor message.

## Out of scope

- **Saving the trail on the server.** The recorder already stores every raw
  provider event on the turn. Nothing to add.
- **A setting to hide the reasoning.** The decision above accepts the trade.
  A parent control is a separate feature and needs a settings surface that
  does not exist.
- **Changing `MAX_TOOL_ROUNDS`, the heartbeat, or the tool set.** This design
  reports what a turn does. It does not change what a turn does.
