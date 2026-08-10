# Activity Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace a tutor turn's one-word "Thinking" silence with a live activity trail that streams the reasoning summary and names every tool call, then closes into `Worked for 1m 15s ›` and stays expandable after a relaunch.

**Architecture:** The server gains one new SSE event, `step`, emitted twice per tool call — once immediately with a general label, once when the arguments complete with a specific one, both under the provider's `call_id`. The client stops discarding `reasoning_delta`, builds an ordered `ActivityTrail` on the tutor message, and saves board crops to disk beside the session rather than inside its JSON.

**Tech Stack:** Python 3.12 / FastAPI / Pydantic / pytest (`server/`), Swift 6 / SwiftUI / XCTest (`MathTutor/`).

**Spec:** [docs/superpowers/specs/2026-08-10-activity-trail-design.md](../specs/2026-08-10-activity-trail-design.md)

## Global Constraints

- **Work on `main`. Never create a branch or a worktree.** Commit and push to whatever branch is checked out.
- **Never run `xcodebuild test`.** Swift test steps say "ask the user to run" and give the exact command. The agent writes the test; the user runs it and reports back. A Swift task is not complete until the user confirms the run.
- **The working tree is already dirty** with unrelated server changes. Every `git add` names exact paths. Never `git add -A`, never `git checkout` a file.
- **Never re-render a saved board crop.** A crop is only re-derivable while the board has not changed; a saved trail is exactly the case where it has.
- **Server tests run from `server/`** with `uv run pytest`. They need `TEST_DATABASE_URL` pointing at a dedicated Neon branch. The tasks below touch no database, so their tests run without it.
- **The Neon test branch is shared and unserialized.** A concurrent run can drop another's tables; `FK violation` or `connection is closed` means contention, not a real failure.
- **Re-read a file immediately before editing it.** The user builds and edits during the session.
- **UI is designed in Paper first, then extracted to code.** Task 8 precedes Task 9 and is not optional.
- **Wire field names are snake_case.** Swift enum raw values must match the server's literals exactly.

---

### Task 1: Server — the `step` event and its general label

**Files:**
- Modify: `server/app/tutor/events.py`
- Test: `server/tests/test_events.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `StepEvent(type="step", id: str, tool: str, label: str)`, exported from `app.tutor.events` and a member of the `ClientEvent` union. `TOOL_STEP_LABELS: dict[str, str]`. `EventTranslator` gains `self._call_ids: dict[int, str]`.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_events.py`:

```python
def test_function_call_added_emits_a_step_with_the_general_label():
    translator = EventTranslator()
    events = translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_a"},
    })
    assert events == [
        StatusEvent(phase="drawing"),
        StepEvent(id="call_a", tool="update_board", label="Drawing on the board"),
    ]


def test_a_tool_with_no_label_emits_no_step():
    translator = EventTranslator()
    events = translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "not_a_tool", "call_id": "call_a"},
    })
    assert events == []


def test_a_heartbeat_never_emits_a_step():
    # A clock that has already passed the heartbeat interval.
    translator = EventTranslator(now=lambda: 1_000.0, heartbeat_seconds=0.0)
    events = translator.translate({"type": "response.some.unknown.event"})
    assert events == [StatusEvent(phase="thinking")]


def test_two_rounds_reusing_output_index_zero_produce_distinct_step_ids():
    # Each round numbers its own output from zero. `call_id` is what keeps the
    # second round's first call from overwriting the first round's.
    translator = EventTranslator()
    first = translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "view_board", "call_id": "call_a"},
    })
    second = translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "view_board", "call_id": "call_b"},
    })
    assert first[-1].id == "call_a"
    assert second[-1].id == "call_b"
```

Add `StepEvent` to the import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && uv run pytest tests/test_events.py -k "step" -v
```

Expected: `ImportError: cannot import name 'StepEvent'`.

- [ ] **Step 3: Add the event type**

In `server/app/tutor/events.py`, after `BoardRequestEvent`:

```python
class StepEvent(BaseModel):
    """One thing the tutor did, as a row in the device's activity trail.

    Sent twice for every call. Once at `response.output_item.added`, carrying
    `TOOL_STEP_LABELS`' general wording, because that is the moment the turn
    starts doing this and the device should say so then. Once again at
    `response.function_call_arguments.done`, carrying a label built from the
    arguments — which is the only place a specific one can come from, and which
    for a large diagram is minutes later. The device replaces the row.

    `id` is the provider's `call_id`, deliberately not its `output_index`. A
    turn runs up to `MAX_TOOL_ROUNDS` rounds and every round numbers its own
    output from zero, so two unrelated calls in one turn share an index. A
    device keying rows on that would overwrite a finished step with a stranger.
    """

    type: Literal["step"] = "step"
    id: str
    tool: str
    label: str
```

Add it to the union:

```python
ClientEvent = Annotated[
    StatusEvent | ReasoningDeltaEvent | TextDeltaEvent | WorkspaceEvent
    | BoardUpdateEvent | BoardRequestEvent | StepEvent | DoneEvent | ErrorEvent,
    Field(discriminator="type"),
]
```

Below `TOOL_PHASES`:

```python
#: What a step says the moment it starts, before any argument has arrived.
#:
#: Separate from `TOOL_PHASES` even though the keys match today. A phase is one
#: of five words the status line cycles through; this is a sentence about one
#: call. They will drift — a sixth tool wanting a row but no new phase is the
#: obvious next case — and merging them would make that a schema change.
#:
#: `remember` and `record_evidence` stay coarse on purpose. Their arguments are
#: what the tutor concluded about the learner, and the learner reads this.
TOOL_STEP_LABELS: dict[str, str] = {
    "update_board": "Drawing on the board",
    "view_board": "Looking at the board",
    "set_workspace": "Making a plan",
    "search_memory": "Searching memory",
    "recent_sessions": "Searching memory",
    "remember": "Saving a note",
    "record_evidence": "Recording progress",
}
```

- [ ] **Step 4: Emit it from the `output_item.added` branch**

In `EventTranslator.__init__`, beside `self._tool_names`:

```python
        # `output_index` -> `call_id`, because the refinement event carries only
        # the index and the step id has to be the call id. Overwritten by a
        # later round using the same index, which is correct: the lookup only
        # ever happens inside the round that wrote it.
        self._call_ids: dict[int, str] = {}
```

Replace the `response.output_item.added` branch of `_translate` with:

```python
        if kind == "response.output_item.added":
            item = event.get("item") or {}
            output_index = event.get("output_index")
            if item.get("type") == "function_call" and output_index is not None:
                name = item.get("name", "")
                self._tool_names[output_index] = name
                produced: list[ClientEvent] = []
                # Announced here, at the head of the call, rather than left to
                # the first heartbeat: this is the moment the turn stops
                # thinking and starts drawing, and the device should say so
                # then, not up to `HEARTBEAT_SECONDS` later.
                phase = TOOL_PHASES.get(name)
                if phase is not None:
                    # Clearing the latch is what lets prose *after* this call
                    # announce `writing` again. Without it `_writing_announced`
                    # stays true from the first text delta of the turn, no
                    # later one emits a status, and the phase sticks on this
                    # tool until the turn ends.
                    self._writing_announced = False
                    produced.append(StatusEvent(phase=phase))
                label = TOOL_STEP_LABELS.get(name)
                call_id = item.get("call_id")
                if label is not None and call_id:
                    self._call_ids[output_index] = call_id
                    produced.append(StepEvent(id=call_id, tool=name, label=label))
                return produced
            return []
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server && uv run pytest tests/test_events.py -v
```

Expected: PASS, including every test that already existed. `test_created_emits_thinking_status`, `test_first_text_delta_also_emits_writing_status` and the `set_workspace` / `update_board` tests must be untouched.

- [ ] **Step 6: Commit**

```bash
git add server/app/tutor/events.py server/tests/test_events.py
git commit -m "Send a step event when a tool call starts"
```

---

### Task 2: Server — the refined label

**Files:**
- Modify: `server/app/tutor/events.py`
- Test: `server/tests/test_events.py`

**Interfaces:**
- Consumes: `StepEvent`, `TOOL_STEP_LABELS`, `EventTranslator._call_ids` from Task 1.
- Produces: `EventTranslator._refined_step(output_index: int, name: str | None, raw_arguments: str) -> StepEvent | None` and `_refined_label(name: str, arguments: dict) -> str | None`, both private. `region_label(x: float, y: float, width: float, height: float) -> str`, module-level and importable for its own test.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_events.py`:

```python
def test_view_board_refines_to_a_named_region():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "view_board", "call_id": "call_a"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps({"x": 0, "y": 0, "width": 40, "height": 40}),
    })
    assert events == [
        StepEvent(id="call_a", tool="view_board",
                  label="Looked at the top left of the board")
    ]


def test_view_board_covering_everything_says_the_whole_board():
    assert region_label(0, 0, 100, 100) == "Looked at the whole board"


def test_search_memory_refines_to_its_query():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "search_memory", "call_id": "call_a"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps({"query": "what does this learner find hard?"}),
    })
    assert events == [
        StepEvent(id="call_a", tool="search_memory",
                  label="Searched memory for what does this learner find hard?")
    ]


def test_update_board_refines_to_a_count_and_still_emits_the_board_update():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_a"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": ONE_ELEMENT_UPDATE,
    })
    assert isinstance(events[0], BoardUpdateEvent)
    assert events[1] == StepEvent(id="call_a", tool="update_board",
                                  label="Drew 1 object")
```

`ONE_ELEMENT_UPDATE` is **not** a new fixture. `test_events.py` already has passing
`update_board` tests, and `BoardSceneUpdate` validates strictly — an invented
element shape will fail validation and send you debugging the wrong thing. Read
the file, take the argument string one of those tests already uses, and bind it
to this name (or use that test's own constant and delete this one).

The rest of Task 2's tests:

```python
def test_set_workspace_refines_to_its_plan_title():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "set_workspace", "call_id": "call_a"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps(WORKSPACE_ARGS),
    })
    assert isinstance(events[0], WorkspaceEvent)
    assert events[1] == StepEvent(id="call_a", tool="set_workspace",
                                  label="Set the plan: Radical equations")


def test_unparseable_arguments_keep_the_general_label():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "search_memory", "call_id": "call_a"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": "{not json",
    })
    assert events == [
        StepEvent(id="call_a", tool="search_memory", label="Searching memory")
    ]


def test_arguments_done_for_a_call_never_added_emits_nothing():
    translator = EventTranslator()
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 7,
        "arguments": "{}",
    })
    assert events == []
```

Add `region_label` to the import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd server && uv run pytest tests/test_events.py -k "refine or region or unparseable or never_added" -v
```

Expected: `ImportError: cannot import name 'region_label'`.

- [ ] **Step 3: Write the region label**

In `server/app/tutor/events.py`, above `EventTranslator`:

```python
#: At or above this, in both directions, a region is the whole board rather
#: than a part of it. Not 100: a model asking to see everything routinely sends
#: 0/0/100/100, but it also sends 2/0/98/99, and both mean the same thing to
#: the learner reading the row.
WHOLE_BOARD_PERCENT = 90.0


def region_label(x: float, y: float, width: float, height: float) -> str:
    """A board region, in words a learner can read.

    The model works in percentages of the overview and that is the right unit
    for the model. It is the wrong one for a row in the trail: "Showing x
    40–70%, y 20–55%" is a coordinate dump, and the learner only wants to know
    which part of their own board the tutor looked at.

    Bands are chosen off the region's centre rather than its edges, so a region
    that straddles a boundary is named for where most of it is.
    """
    if width >= WHOLE_BOARD_PERCENT and height >= WHOLE_BOARD_PERCENT:
        return "Looked at the whole board"

    def band(centre: float, low: str, middle: str, high: str) -> str:
        if centre < 100 / 3:
            return low
        if centre < 200 / 3:
            return middle
        return high

    vertical = band(y + height / 2, "top", "middle", "bottom")
    horizontal = band(x + width / 2, "left", "centre", "right")
    if vertical == "middle" and horizontal == "centre":
        return "Looked at the centre of the board"
    if vertical == "middle":
        return f"Looked at the {horizontal} of the board"
    if horizontal == "centre":
        return f"Looked at the {vertical} of the board"
    return f"Looked at the {vertical} {horizontal} of the board"
```

- [ ] **Step 4: Refine the step when the arguments land**

Replace the `response.function_call_arguments.done` branch of `_translate` with:

```python
        if kind == "response.function_call_arguments.done":
            output_index = event.get("output_index", -1)
            name = self._tool_names.get(output_index)
            raw_arguments = event.get("arguments", "")
            produced: list[ClientEvent] = []
            if name == "set_workspace":
                produced.extend(self._workspace_from(raw_arguments))
            elif name == "update_board":
                produced.extend(self._board_update_from(raw_arguments))
            # After the tool's own event, not before: the board must change on
            # the device before a row claims it did.
            step = self._refined_step(output_index, name, raw_arguments)
            if step is not None:
                produced.append(step)
            return produced
```

Add the two methods to `EventTranslator`:

```python
    def _refined_step(
        self, output_index: int, name: str | None, raw_arguments: str
    ) -> StepEvent | None:
        """This call's row, restated now that its arguments are complete.

        Falls back to the general label rather than to nothing. A step that was
        already sent must be re-sent with *some* label or the device is left
        showing "Drawing on the board" under a finished turn — the argument
        parse failing is exactly when that is most likely.
        """
        call_id = self._call_ids.get(output_index)
        if call_id is None or name is None:
            return None
        label = self._refined_label(name, raw_arguments) or TOOL_STEP_LABELS.get(name)
        if label is None:
            return None
        return StepEvent(id=call_id, tool=name, label=label)

    def _refined_label(self, name: str, raw_arguments: str) -> str | None:
        """A label built from what the model actually asked for.

        `None` for every tool with nothing worth saying, for arguments that do
        not parse, and for `remember` and `record_evidence` — whose arguments
        are the tutor's judgement of the learner, which the learner should not
        read off a status row.
        """
        try:
            arguments = json.loads(raw_arguments)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(arguments, dict):
            return None

        if name == "view_board":
            try:
                return region_label(
                    float(arguments["x"]), float(arguments["y"]),
                    float(arguments["width"]), float(arguments["height"]),
                )
            except (KeyError, TypeError, ValueError):
                return None

        if name == "search_memory":
            query = arguments.get("query")
            return f"Searched memory for {query}" if query else None

        if name == "set_workspace":
            title = (arguments.get("plan") or {}).get("title")
            return f"Set the plan: {title}" if title else None

        if name == "update_board":
            update, _ = parse_board_update(raw_arguments)
            if update is None:
                return None
            payload = update_payload(update)
            if payload.replace_all:
                return "Redrew the board"
            count = len(payload.upserts) + len(payload.deletes)
            if count == 0:
                return None
            return f"Drew {count} object" + ("" if count == 1 else "s")

        return None
```

`parse_board_update` and `update_payload` are already imported at the top of this file.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd server && uv run pytest tests/test_events.py -v
```

Expected: PASS, every test in the file.

- [ ] **Step 6: Commit**

```bash
git add server/app/tutor/events.py server/tests/test_events.py
git commit -m "Restate a step once its arguments say what it did"
```

---

### Task 3: Client — decode the `step` event

**Files:**
- Modify: `MathTutor/Domain/TutorEvent.swift`
- Test: `MathTutorTests/TutorEventTests.swift`

**Interfaces:**
- Consumes: the `step` wire shape from Task 1.
- Produces: `TutorEvent.step(id: String, tool: String, label: String)`.

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/TutorEventTests.swift`:

```swift
func testDecodesAStepEvent() {
    let line = #"data: {"type":"step","id":"call_a","tool":"update_board","label":"Drawing on the board"}"#
    XCTAssertEqual(
        TutorEvent.decode(from: line),
        .step(id: "call_a", tool: "update_board", label: "Drawing on the board")
    )
}

func testAStepMissingItsIDIsIgnored() {
    let line = #"data: {"type":"step","tool":"update_board","label":"Drawing"}"#
    XCTAssertNil(TutorEvent.decode(from: line))
}

func testAnUnknownEventTypeIsStillIgnored() {
    let line = #"data: {"type":"something_new","text":"hi"}"#
    XCTAssertNil(TutorEvent.decode(from: line))
}
```

- [ ] **Step 2: Add the case and its decoding**

In `MathTutor/Domain/TutorEvent.swift`, add to the enum after `case boardRequest`:

```swift
    /// One row of the activity trail — a tool call, named.
    ///
    /// Arrives twice per call under the same `id`, which is the server's
    /// `call_id`: once when the call starts, once when its arguments are
    /// complete and a specific label exists. The store replaces the row rather
    /// than appending, so `id` is the whole contract — see
    /// `StepEvent` in `server/app/tutor/events.py` for why it is not the
    /// provider's output index.
    case step(id: String, tool: String, label: String)
```

Add to the `decode` switch, before `case "done"`:

```swift
        case "step":
            guard let id = envelope.id, let tool = envelope.tool,
                  let label = envelope.label
            else { return nil }
            return .step(id: id, tool: tool, label: label)
```

Add to `Envelope`:

```swift
        // `step`.
        let id: String?
        let tool: String?
        let label: String?
```

- [ ] **Step 3: Ask the user to run the tests**

Tell the user:

> Task 3's tests are written. Please run:

```bash
xcodebuild test -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:MathTutorTests/TutorEventTests
```

Expected: PASS. Do not proceed until the user confirms.

- [ ] **Step 4: Commit**

```bash
git add MathTutor/Domain/TutorEvent.swift MathTutorTests/TutorEventTests.swift
git commit -m "Decode the step event"
```

---

### Task 4: Client — the `ActivityTrail` model

**Files:**
- Create: `MathTutor/Domain/ActivityTrail.swift`
- Modify: `MathTutor/Domain/Models.swift` (`TutorMessage`, around lines 95–140)
- Test: `MathTutorTests/MathTutorTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `ActivityTrail` with `var items: [TrailItem]` and `var duration: TimeInterval?`; `enum TrailItem { case reasoning(id: UUID, text: String); case step(TrailStep) }`; `struct TrailStep { let id: String; var tool: String; var label: String; var imageID: UUID? }`. `TutorMessage.activity: ActivityTrail?`. Mutating helpers `ActivityTrail.appendReasoning(_ text: String)` and `ActivityTrail.upsert(_ step: TrailStep)`.

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/MathTutorTests.swift`:

```swift
func testReasoningDeltasGrowASingleItem() {
    var trail = ActivityTrail()
    trail.appendReasoning("Checking ")
    trail.appendReasoning("the domain")
    XCTAssertEqual(trail.items.count, 1)
    guard case let .reasoning(_, text) = trail.items[0] else {
        return XCTFail("expected a reasoning item")
    }
    XCTAssertEqual(text, "Checking the domain")
}

func testReasoningAfterAStepStartsANewItem() {
    var trail = ActivityTrail()
    trail.appendReasoning("First")
    trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looking"))
    trail.appendReasoning("Second")
    XCTAssertEqual(trail.items.count, 3)
}

func testAStepWithAKnownIDIsReplacedInPlace() {
    var trail = ActivityTrail()
    trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looking at the board"))
    trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"))
    XCTAssertEqual(trail.items.count, 1)
    guard case let .step(step) = trail.items[0] else {
        return XCTFail("expected a step item")
    }
    XCTAssertEqual(step.label, "Looked at the top left of the board")
}

func testReplacingAStepKeepsItsImage() {
    var trail = ActivityTrail()
    var first = TrailStep(id: "call_a", tool: "view_board", label: "Looking at the board")
    first.imageID = UUID()
    trail.upsert(first)
    trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"))
    guard case let .step(step) = trail.items[0] else {
        return XCTFail("expected a step item")
    }
    XCTAssertEqual(step.imageID, first.imageID)
}

func testATutorMessageWrittenBeforeTrailsExistedStillDecodes() throws {
    let json = Data("""
    {"id":"\(UUID().uuidString)","role":"tutor","text":"Hello","createdAt":0}
    """.utf8)
    let message = try JSONDecoder().decode(TutorMessage.self, from: json)
    XCTAssertNil(message.activity)
    XCTAssertEqual(message.text, "Hello")
}

func testATrailSurvivesEncodingAndDecoding() throws {
    var trail = ActivityTrail()
    trail.appendReasoning("Checking the domain")
    trail.upsert(TrailStep(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"))
    trail.duration = 75
    var message = TutorMessage(role: .tutor, text: "Try squaring both sides.")
    message.activity = trail

    let data = try JSONEncoder().encode(message)
    let decoded = try JSONDecoder().decode(TutorMessage.self, from: data)
    XCTAssertEqual(decoded.activity, trail)
}
```

- [ ] **Step 2: Write the model**

Create `MathTutor/Domain/ActivityTrail.swift`:

```swift
import Foundation

/// What one tutor turn did, in the order it did it.
///
/// The thread shows this above the reply — open while the turn runs, closed to
/// `Worked for 1m 15s` after it ends. It exists because a reasoning turn is
/// otherwise several minutes of one word: the server has always sent the
/// reasoning summary and a phase, and the device has always thrown the first
/// away and reduced the second to a spinner.
///
/// `Codable` and saved with the session, unlike `BoardView` — but note what is
/// *not* here. A step holds a `UUID` for its board crop, never the bytes. A
/// `TutorMessage` is written into the session's file on every save, so PNGs in
/// this type would be rewritten for the rest of the session. `BoardCropStore`
/// holds the bytes beside the session instead.
struct ActivityTrail: Codable, Equatable, Sendable {
    var items: [TrailItem] = []

    /// How long the learner waited, set on `.done`.
    ///
    /// Measured on the device rather than sent by the server, because the
    /// number the label claims is the wait as the learner experienced it, and
    /// that includes the network. Stays `nil` on a turn that failed: a trail
    /// with no duration is what tells the view to say nothing rather than
    /// report a time it never measured.
    var duration: TimeInterval?

    var isEmpty: Bool { items.isEmpty }

    /// Adds reasoning text to the trailing reasoning item, or starts one.
    ///
    /// Deltas arrive one fragment at a time and belong to whichever run of
    /// thought is current. A step between two fragments genuinely separates
    /// them — the tutor thought, acted, then thought again — so a step ends the
    /// run and the next delta starts a new item.
    mutating func appendReasoning(_ text: String) {
        if case let .reasoning(id, existing) = items.last {
            items[items.count - 1] = .reasoning(id: id, text: existing + text)
            return
        }
        items.append(.reasoning(id: UUID(), text: text))
    }

    /// Files a step, replacing the row with the same id if there is one.
    ///
    /// Every step arrives twice — general label, then specific — so this is the
    /// normal path, not an edge case. The existing row's `imageID` is carried
    /// across: the refinement is built by the translator from tool arguments
    /// and cannot know about a crop the device rendered in the meantime.
    mutating func upsert(_ step: TrailStep) {
        let index = items.firstIndex { item in
            if case let .step(existing) = item { return existing.id == step.id }
            return false
        }
        guard let index else {
            items.append(.step(step))
            return
        }
        var merged = step
        if merged.imageID == nil, case let .step(existing) = items[index] {
            merged.imageID = existing.imageID
        }
        items[index] = .step(merged)
    }

    /// Attaches a rendered crop to the step that asked for it.
    mutating func setImage(_ imageID: UUID, forStep id: String) {
        let index = items.firstIndex { item in
            if case let .step(existing) = item { return existing.id == id }
            return false
        }
        guard let index, case let .step(existing) = items[index] else { return }
        var updated = existing
        updated.imageID = imageID
        items[index] = .step(updated)
    }
}

/// One row of the trail.
enum TrailItem: Codable, Equatable, Sendable, Identifiable {
    /// A run of reasoning summary. Grows in place as deltas arrive.
    case reasoning(id: UUID, text: String)
    case step(TrailStep)

    var id: String {
        switch self {
        case let .reasoning(id, _): return id.uuidString
        case let .step(step): return step.id
        }
    }
}

/// One tool call, named for the learner.
struct TrailStep: Codable, Equatable, Sendable, Identifiable {
    /// The server's `call_id`. A `String`, not a `UUID`: it is the provider's
    /// identifier and this device does not get to choose its shape.
    let id: String
    var tool: String
    var label: String
    /// The board crop this step produced, by the id `BoardCropStore` files it
    /// under. Only a `view_board` step ever has one.
    var imageID: UUID?

    init(id: String, tool: String, label: String, imageID: UUID? = nil) {
        self.id = id
        self.tool = tool
        self.label = label
        self.imageID = imageID
    }
}
```

- [ ] **Step 3: Add the field to `TutorMessage`**

In `MathTutor/Domain/Models.swift`, add the stored property after `attachments`:

```swift
    /// What the tutor did to produce this message. `nil` on every learner
    /// message, and on every tutor message written before the trail existed —
    /// which is what the decoder below defaults.
    var activity: ActivityTrail?
```

Add it to the `init`, keeping the existing parameter order and adding this last:

```swift
        activity: ActivityTrail? = nil
```
```swift
        self.activity = activity
```

Add the key:

```swift
    private enum CodingKeys: String, CodingKey {
        case id, role, text, createdAt, signal, attachments, activity
    }
```

And decode it in the hand-written `init(from:)`, beside the line that already does this for `attachments`:

```swift
        activity = try container.decodeIfPresent(ActivityTrail.self, forKey: .activity)
```

Re-read `Models.swift` before editing. The doc comment above `init(from:)` explains that this decoder exists precisely because Swift's generated one throws `keyNotFound` rather than using a stored property's default — extend that comment to name `activity` as the second reason it exists.

- [ ] **Step 4: Ask the user to run the tests**

Tell the user:

> Task 4's tests are written. Please run:

```bash
xcodebuild test -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:MathTutorTests/MathTutorTests
```

Expected: PASS. Do not proceed until the user confirms.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Domain/ActivityTrail.swift MathTutor/Domain/Models.swift MathTutorTests/MathTutorTests.swift
git commit -m "Give a tutor message the trail of what produced it"
```

---

### Task 5: Client — `BoardCropStore`

**Files:**
- Create: `MathTutor/Services/BoardCropStore.swift`
- Test: `MathTutorTests/AttachmentStoreTests.swift`

**Interfaces:**
- Consumes: nothing.
- Produces: `BoardCropStore` with `init(directoryURL: URL? = nil)`, `func save(_ png: Data, for id: UUID, in sessionID: UUID)`, `func crop(for id: UUID) -> Data?`, `func deleteAll(for sessionID: UUID)`.

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/AttachmentStoreTests.swift`:

```swift
func testACropIsReadBackByID() {
    let store = BoardCropStore(directoryURL: temporaryDirectory())
    let id = UUID()
    store.save(Data("png".utf8), for: id, in: UUID())
    XCTAssertEqual(store.crop(for: id), Data("png".utf8))
}

func testAnUnknownCropIsNil() {
    let store = BoardCropStore(directoryURL: temporaryDirectory())
    XCTAssertNil(store.crop(for: UUID()))
}

func testDeletingASessionForgetsOnlyItsCrops() {
    let store = BoardCropStore(directoryURL: temporaryDirectory())
    let mine = UUID(), theirs = UUID()
    let mySession = UUID(), theirSession = UUID()
    store.save(Data("a".utf8), for: mine, in: mySession)
    store.save(Data("b".utf8), for: theirs, in: theirSession)

    store.deleteAll(for: mySession)

    XCTAssertNil(store.crop(for: mine))
    XCTAssertEqual(store.crop(for: theirs), Data("b".utf8))
}
```

Use whatever temporary-directory helper `AttachmentStoreTests` already defines; re-read the file and match it rather than adding a second one.

- [ ] **Step 2: Write the store**

Create `MathTutor/Services/BoardCropStore.swift`, modelled on `AttachmentStore` — one flat directory keyed by id, plus a per-session index so a deleted session can find its files, and the same write-then-index order so a failed write never leaves an index entry pointing at nothing.

```swift
import Foundation

/// The board regions the tutor asked to see, kept beside the sessions they
/// belong to.
///
/// `AttachmentStore` says a board crop is re-derivable and a photograph of
/// homework is not, and that is why crops were never saved. That reasoning
/// holds only while the board has not changed since — and a trail that
/// survives a relaunch is exactly the case where it has. Re-rendering the
/// region later would show today's board and label it as what the tutor
/// looked at last week, which is worse than showing nothing at all.
///
/// PNG rather than `AttachmentStore`'s JPEG: the source is ink on white, where
/// JPEG's ringing is at its most visible and its saving at its smallest.
struct BoardCropStore {
    /// Injectable only so a test can point at a temporary directory. Nothing
    /// in the app passes it.
    let directoryURL: URL

    init(directoryURL: URL? = nil) {
        self.directoryURL = directoryURL
            ?? SessionPersistence.defaultDirectoryURL.appendingPathComponent("BoardCrops")
    }

    private var cropsURL: URL { directoryURL.appendingPathComponent("Crops") }
    private var indexURL: URL { directoryURL.appendingPathComponent("bySession.json") }

    private func fileURL(for id: UUID) -> URL {
        cropsURL.appendingPathComponent(id.uuidString + ".png")
    }

    /// Writes the crop and only then folds it into the index, in that order. A
    /// failed write must not leave an index entry pointing at a file that was
    /// never created — a crop `deleteAll` believes it owns and `crop(for:)` can
    /// never return.
    func save(_ png: Data, for id: UUID, in sessionID: UUID) {
        guard write(png, for: id) else { return }

        var index = loadIndex()
        index[sessionID.uuidString, default: []].append(id)
        writeIndex(index)
    }

    func crop(for id: UUID) -> Data? {
        try? Data(contentsOf: fileURL(for: id))
    }

    /// Forgets every crop a session owns. Called when the session is deleted —
    /// the one place these files would otherwise accumulate forever.
    func deleteAll(for sessionID: UUID) {
        var index = loadIndex()
        for id in index[sessionID.uuidString] ?? [] {
            try? FileManager.default.removeItem(at: fileURL(for: id))
        }
        index[sessionID.uuidString] = nil
        writeIndex(index)
    }

    @discardableResult
    private func write(_ png: Data, for id: UUID) -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: cropsURL, withIntermediateDirectories: true
            )
            try png.write(to: fileURL(for: id), options: .atomic)
            return true
        } catch {
            return false
        }
    }

    /// Keyed by `sessionID.uuidString` rather than `UUID` itself: `Dictionary`
    /// only encodes as a JSON object when `Key` is `String` or `Int`.
    private func loadIndex() -> [String: [UUID]] {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode([String: [UUID]].self, from: data) else {
            return [:]
        }
        return index
    }

    private func writeIndex(_ index: [String: [UUID]]) {
        try? FileManager.default.createDirectory(
            at: directoryURL, withIntermediateDirectories: true
        )
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
```

- [ ] **Step 3: Delete a session's crops with the session**

Find the call to `attachmentStore.deleteAll(for:)` in `MathTutor/TutorStore.swift` and add `boardCropStore.deleteAll(for:)` beside it. Add `let boardCropStore: BoardCropStore` to `TutorStore`'s stored properties and `boardCropStore: BoardCropStore = BoardCropStore()` to its `init`, in the same position `attachmentStore` occupies.

- [ ] **Step 4: Ask the user to run the tests**

Tell the user:

> Task 5's tests are written. Please run:

```bash
xcodebuild test -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:MathTutorTests/AttachmentStoreTests
```

Expected: PASS. Do not proceed until the user confirms.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Services/BoardCropStore.swift MathTutor/TutorStore.swift MathTutorTests/AttachmentStoreTests.swift
git commit -m "Keep the board regions the tutor looked at"
```

---

### Task 6: Client — a board view knows which step asked for it

**Files:**
- Modify: `MathTutor/Domain/TutorEvent.swift` (`case boardViewed`)
- Modify: `MathTutor/Services/BackendTutorService.swift:101-113`
- Test: `MathTutorTests/BackendTutorServiceTests.swift`

**Interfaces:**
- Consumes: `.boardRequest(callID:region:detail:)`, already present.
- Produces: `TutorEvent.boardViewed(callID: String, imageData: Data, detail: String)` — a **changed** signature. Every existing construction site and pattern match must be updated.

- [ ] **Step 1: Write the failing test**

Add to `MathTutorTests/BackendTutorServiceTests.swift`:

```swift
func testABoardViewCarriesTheCallItAnswered() async throws {
    // The service turns one `board_request` into a `boardViewed` naming the
    // same call, so the store can file the crop on the step that asked rather
    // than guessing at the most recent one.
    await MainActor.run { BackendTutorService.boardRenderer = { _ in Data("png".utf8) } }
    defer { Task { @MainActor in BackendTutorService.boardRenderer = nil } }

    let events = try await collect(fromSSE: """
    data: {"type":"board_request","call_id":"call_a","x":0,"y":0,"width":40,"height":40,"detail":"Showing x 0–40%, y 0–40% of the board."}

    data: {"type":"done","turn_id":"\(UUID().uuidString)"}

    """)

    let viewed = events.compactMap { event -> String? in
        if case let .boardViewed(callID, _, _) = event { return callID }
        return nil
    }
    XCTAssertEqual(viewed, ["call_a"])
}
```

Re-read `BackendTutorServiceTests.swift` first and reuse its existing SSE-driving helper rather than inventing `collect(fromSSE:)`; if none exists, follow whatever pattern the file already uses to feed the service a canned stream.

- [ ] **Step 2: Change the case**

In `MathTutor/Domain/TutorEvent.swift`:

```swift
    /// A region this device rendered for the tutor, on its way into the thread.
    ///
    /// Produced locally rather than received: the device drew it, so it already
    /// holds the bytes and they never make a second round trip.
    ///
    /// `callID` is the `board_request` this answers, and it is the same id the
    /// matching `step` carries. Without it the store would have to file the
    /// crop on "the most recent `view_board` step with no image", which is the
    /// wrong step as soon as one turn asks for two regions and the second
    /// render returns first.
    case boardViewed(callID: String, imageData: Data, detail: String)
```

In `MathTutor/Services/BackendTutorService.swift`, inside the `.boardRequest` branch:

```swift
                                    continuation.yield(.boardViewed(
                                        callID: callID, imageData: image, detail: detail
                                    ))
```

- [ ] **Step 3: Fix every other site**

Compile and fix each error. The known sites are `TutorStore.requestTutor`'s `case .boardViewed` and any `DemoTutorService` fixture. Search first:

```bash
grep -rn "boardViewed" MathTutor MathTutorTests MathTutorUITests
```

- [ ] **Step 4: Ask the user to run the tests**

Tell the user:

> Task 6's tests are written. Please run:

```bash
xcodebuild test -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:MathTutorTests/BackendTutorServiceTests
```

Expected: PASS. Do not proceed until the user confirms.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Domain/TutorEvent.swift MathTutor/Services/BackendTutorService.swift MathTutor/TutorStore.swift MathTutorTests/BackendTutorServiceTests.swift
git commit -m "Name the call a board view answered"
```

---

### Task 7: Client — the store builds the trail

**Files:**
- Modify: `MathTutor/TutorStore.swift` — `requestTutor` (around lines 798–915), the `boardViews` / `pendingBoardViews` properties (around lines 70–90), `attach` and `flushPendingBoardViews` (around lines 953–967)
- Test: `MathTutorTests/TutorStoreStreamingTests.swift`

**Interfaces:**
- Consumes: `ActivityTrail`, `TrailStep` (Task 4); `BoardCropStore` (Task 5); `.step` and `.boardViewed(callID:…)` (Tasks 3, 6).
- Produces: `TutorMessage.activity` populated during a turn. `boardViews`, `attach(_:to:)`, `pendingBoardViews` and `flushPendingBoardViews(to:)` are **deleted**.

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/TutorStoreStreamingTests.swift`:

```swift
@MainActor
func testAReasoningDeltaCreatesTheMessageBeforeAnyText() async {
    let store = TutorStore(
        service: ScriptedTutorService(events: [
            .reasoningDelta("Checking the domain"),
            .done,
        ]),
        persistence: .inMemory,
        configuration: .stub
    )
    await store.send("Solve it")

    let tutor = store.session.messages.last { $0.role == .tutor }
    XCTAssertEqual(tutor?.text, "")
    XCTAssertEqual(tutor?.activity?.items.count, 1)
}

@MainActor
func testAStepArrivingTwiceLeavesOneRow() async {
    let store = TutorStore(
        service: ScriptedTutorService(events: [
            .step(id: "call_a", tool: "view_board", label: "Looking at the board"),
            .step(id: "call_a", tool: "view_board", label: "Looked at the top left of the board"),
            .textDelta("Try squaring."),
            .done,
        ]),
        persistence: .inMemory,
        configuration: .stub
    )
    await store.send("Check this")

    let trail = store.session.messages.last { $0.role == .tutor }?.activity
    XCTAssertEqual(trail?.items.count, 1)
}

@MainActor
func testACropIsFiledOnTheStepThatAskedForIt() async {
    let store = TutorStore(
        service: ScriptedTutorService(events: [
            .step(id: "call_a", tool: "view_board", label: "Looking at the board"),
            .step(id: "call_b", tool: "view_board", label: "Looking at the board"),
            // Out of order on purpose: the second render returns first.
            .boardViewed(callID: "call_b", imageData: Data("b".utf8), detail: "b"),
            .boardViewed(callID: "call_a", imageData: Data("a".utf8), detail: "a"),
            .done,
        ]),
        persistence: .inMemory,
        configuration: .stub
    )
    await store.send("Check both")

    let trail = store.session.messages.last { $0.role == .tutor }?.activity
    let steps = trail?.items.compactMap { item -> TrailStep? in
        if case let .step(step) = item { return step }
        return nil
    }
    XCTAssertEqual(steps?.count, 2)
    XCTAssertNotNil(steps?.first { $0.id == "call_a" }?.imageID)
    XCTAssertNotNil(steps?.first { $0.id == "call_b" }?.imageID)
    XCTAssertNotEqual(steps?[0].imageID, steps?[1].imageID)
}

@MainActor
func testDoneRecordsHowLongTheLearnerWaited() async {
    let store = TutorStore(
        service: ScriptedTutorService(events: [.textDelta("Hi"), .done]),
        persistence: .inMemory,
        configuration: .stub
    )
    await store.send("Hello")

    let duration = store.session.messages.last { $0.role == .tutor }?.activity?.duration
    XCTAssertNotNil(duration)
    XCTAssertGreaterThanOrEqual(duration ?? -1, 0)
}

@MainActor
func testATurnThatFailsImmediatelyLeavesNoEmptyBubble() async {
    let store = TutorStore(
        service: ScriptedTutorService(events: [
            .failure(message: "The tutor is unavailable.", retryable: true),
        ]),
        persistence: .inMemory,
        configuration: .stub
    )
    await store.send("Hello")

    XCTAssertNil(store.session.messages.last { $0.role == .tutor })
    XCTAssertEqual(store.errorMessage, "The tutor is unavailable.")
}
```

Re-read the file first and match how its existing tests drive a turn — `store.send(_:)` above stands for whatever entry point they already use.

- [ ] **Step 2: Rewrite the event loop**

In `MathTutor/TutorStore.swift`, replace the `for try await event in service.stream(request)` switch with:

```swift
            var accumulatedText = ""
            var tutorMessageIndex: Int?
            let startedAt = Date.now

            /// The tutor's message for this turn, created on first use.
            ///
            /// Lazily rather than at the head of the turn: the trail starts
            /// before any prose exists, so the message can no longer wait for
            /// the first `.textDelta` — but a turn that dies before the
            /// provider answers must not leave an empty bubble in the thread
            /// either. The first thing worth showing is what creates it.
            func messageIndex() -> Int {
                if let tutorMessageIndex { return tutorMessageIndex }
                self.session.messages.append(TutorMessage(role: .tutor, text: ""))
                let index = self.session.messages.count - 1
                self.session.messages[index].activity = ActivityTrail()
                tutorMessageIndex = index
                return index
            }

            func withTrail(_ change: (inout ActivityTrail) -> Void) {
                let index = messageIndex()
                var trail = self.session.messages[index].activity ?? ActivityTrail()
                change(&trail)
                self.session.messages[index].activity = trail
            }

            do {
                for try await event in service.stream(request) {
                    switch event {
                    case .status(let newPhase, _):
                        self.phase = newPhase
                    case .reasoningDelta(let chunk):
                        withTrail { $0.appendReasoning(chunk) }
                    case .step(let id, let tool, let label):
                        withTrail { $0.upsert(TrailStep(id: id, tool: tool, label: label)) }
                    case .textDelta(let chunk):
                        accumulatedText += chunk
                        let index = messageIndex()
                        self.session.messages[index].text = accumulatedText
                    case .boardViewed(let callID, let imageData, _):
                        // Written to disk, not into the message: a session file
                        // that carried PNGs would rewrite them on every later
                        // save. The trail holds only the id.
                        let imageID = UUID()
                        self.boardCropStore.save(
                            imageData, for: imageID, in: self.session.id
                        )
                        withTrail { $0.setImage(imageID, forStep: callID) }
                    case .boardRequest:
                        // Answered inside the service, which owns the network and
                        // the renderer. It reaches here only as `.boardViewed`.
                        break
                    case .workspace(let plan, let exercise):
                        self.session.plan = plan
                        self.session.exercise = exercise
                        self.isWorkspace = true
                    case .boardUpdate(let update):
                        // A board update is a coarse, user-visible mutation,
                        // not a token delta. Apply and persist it immediately:
                        // if the prose stream fails afterward, the diagram the
                        // learner can already see must still survive a relaunch.
                        self.session.boardScene = self.session.boardScene.applying(update)
                        self.persist()
                    case .done:
                        if let index = tutorMessageIndex {
                            self.session.messages[index].activity?.duration =
                                Date.now.timeIntervalSince(startedAt)
                        }
                        self.phase = nil
                        self.isLoading = false
                        self.isEvaluating = false
                        if signal == .evaluate, let tutorMessageIndex {
                            self.evaluationMessageID = self.session.messages[tutorMessageIndex].id
                        }
                        self.session.lastSavedAt = .now
                        self.persist()
                        onDone?(accumulatedText)
                    case .failure(let message, _):
                        // The duration is deliberately left `nil`. A trail that
                        // never finished must not claim a time.
                        self.phase = nil
                        self.isLoading = false
                        self.isEvaluating = false
                        self.errorMessage = message
                    }
                }
            } catch {
```

- [ ] **Step 3: Delete what the trail replaces**

Remove `pendingBoardViews`, `flushPendingBoardViews(to:)`, `boardViews` and `attach(_:to:)` from `TutorStore`, along with the `boardViews = [:]` reset. Leave `selectionViews` alone — it holds what the *learner* pointed at, which is a different claim and stays in memory.

Compile and fix every reader. `TutorPanel` reads `store.boardViews`; that call site is replaced in Task 9, so for now pass an empty array to keep the build green and leave a `// Task 9` comment.

- [ ] **Step 4: Ask the user to run the tests**

Tell the user:

> Task 7's tests are written. Please run:

```bash
xcodebuild test -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:MathTutorTests/TutorStoreStreamingTests
```

Expected: PASS. Do not proceed until the user confirms.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/TutorStore.swift MathTutorTests/TutorStoreStreamingTests.swift MathTutor/Features/Tutor/TutorPanel.swift
git commit -m "Build the trail as the turn streams"
```

---

### Task 8: Paper — design the trail

**Files:**
- Modify: the project's Paper file, board `06 — States & settings`, section `01 — Thinking & streaming`
- Modify: `docs/design-system/06-states-and-settings.md`

**Interfaces:**
- Consumes: nothing.
- Produces: exact geometry, type, colour and icon decisions for `ActivityTrailView`, recorded in the design-system document so Task 9 extracts rather than invents.

- [ ] **Step 1: Load the Paper guide and open the file**

Call `get_guide({topic: "paper-mcp-instructions"})`, then `get_basic_info`, then `get_font_family_info`. Do not skip these; the guide is required before any other Paper tool.

- [ ] **Step 2: Read what section 01 already specifies**

Read `docs/design-system/06-states-and-settings.md` section `01 — Thinking & streaming` (from around line 831) and find the matching artboard. `ThinkingIndicator` and its `6 × 6` dot are specified there and are **not** being replaced — the trail sits beside them.

Scope any `find_nodes` search to the artboard, not the page: a page-wide index under-reports.

- [ ] **Step 3: Draw the two states**

Add to the section:

- **Open** — reasoning text in the muted body style, and a step row per call: leading icon slot with `flexShrink: 0`, label, and for a `view_board` step the crop below at `BoardViewsMetrics.thumbnail` size with `BoardViewsMetrics.cornerRadius`.
- **Closed** — one row: `Worked for 1m 15s` plus a trailing chevron.

Use `design/tokens.json` values only. Take icons from `design/icons.json` — reuse existing glyphs; if a step needs one that does not exist, say so and stop rather than drawing a new icon here.

- [ ] **Step 4: Review and finish**

Call `get_screenshot` and check the result. Re-read any node right before mirroring its values into a sibling — the user edits the file during a session and values go stale. If an artboard clips, switch it to `height: "fit-content"` via `update_styles` rather than guessing a fixed height. Then call `finish_working_on_nodes`.

- [ ] **Step 5: Write the specification down**

Add the trail's rows to `docs/design-system/06-states-and-settings.md` section 01, in the same table format the file already uses: token per property, exact px, and the reason for anything off-scale.

- [ ] **Step 6: Commit**

```bash
git add docs/design-system/06-states-and-settings.md
git commit -m "Specify the activity trail in board 06"
```

---

### Task 9: Client — `ActivityTrailView`

**Files:**
- Create: `MathTutor/DesignSystem/Components/Chat/ActivityTrail.swift`
- Modify: `MathTutor/Features/Tutor/TutorPanel.swift` (around line 532)
- Test: `MathTutorTests/ChatComponentTests.swift`

**Interfaces:**
- Consumes: `ActivityTrail`, `TrailItem`, `TrailStep` (Task 4); `BoardCropStore` (Task 5); the geometry recorded in Task 8.
- Produces: `ActivityTrailView(trail: ActivityTrail, width: CGFloat, crop: (UUID) -> Data?)`.

- [ ] **Step 1: Write the failing tests**

Add to `MathTutorTests/ChatComponentTests.swift`, following the file's existing pattern for asserting on a view's model rather than its pixels:

```swift
func testAFinishedTrailReportsItsDuration() {
    var trail = ActivityTrail()
    trail.appendReasoning("Checking the domain")
    trail.duration = 75
    XCTAssertEqual(ActivityTrailView.summaryLabel(for: trail), "Worked for 1m 15s")
}

func testASubMinuteTrailOmitsTheMinutes() {
    var trail = ActivityTrail()
    trail.duration = 8
    XCTAssertEqual(ActivityTrailView.summaryLabel(for: trail), "Worked for 8s")
}

func testAnUnfinishedTrailHasNoSummary() {
    var trail = ActivityTrail()
    trail.appendReasoning("Checking")
    XCTAssertNil(ActivityTrailView.summaryLabel(for: trail))
}

func testAnEmptyTrailDrawsNothing() {
    XCTAssertTrue(ActivityTrail().isEmpty)
}
```

- [ ] **Step 2: Build the view**

Create `MathTutor/DesignSystem/Components/Chat/ActivityTrail.swift` with `ActivityTrailView`.

The view's `body` is deliberately **not** written out here. Its geometry, type styles, colours and icons come from Task 8 — that is the whole reason Task 8 exists, and pre-writing a body would be inventing the design in the plan and then overriding the file it was supposed to be extracted from. Read the rows Task 8 added to `docs/design-system/06-states-and-settings.md` and build from those.

The one part that owes nothing to the design, and that the tests above assert on:

```swift
    /// The closed row's text, or `nil` for a turn that never finished.
    ///
    /// Minutes are dropped below sixty seconds rather than shown as `0m 8s`,
    /// which is how every reader states a short duration and how the reference
    /// this is modelled on states it.
    static func summaryLabel(for trail: ActivityTrail) -> String? {
        guard let duration = trail.duration else { return nil }
        let total = Int(duration.rounded())
        let minutes = total / 60
        let seconds = total % 60
        if minutes == 0 { return "Worked for \(seconds)s" }
        return "Worked for \(minutes)m \(seconds)s"
    }
```

The rest:

- Open while `trail.duration == nil`, closed after. `@State private var isExpanded` drives it once the turn ends; tapping the summary row toggles.
- A `view_board` step draws its crop through the injected `crop` closure. A missing crop draws the label alone — a crop can legitimately be absent, and a broken-image box is worse than none.
- `.accessibilityElement(children: .contain)` with a label naming the step count, following `BoardViewsRow`'s treatment.

- [ ] **Step 3: Wire it into the panel**

In `MathTutor/Features/Tutor/TutorPanel.swift`, draw `ActivityTrailView` above each tutor message that has a non-empty `activity`, in the message's own column. Pass `crop:` backed by `store.boardCropStore.crop(for:)`.

Remove the `store.boardViews` call site and the `// Task 9` placeholder from Task 7. `ThinkingIndicator` stays exactly as it is: it covers the gap before the first trail item, and that gap is now short.

- [ ] **Step 4: Ask the user to run the tests and look at the app**

Tell the user:

> Task 9's tests are written. Please run:

```bash
xcodebuild test -project MathTutor.xcodeproj -scheme MathTutor -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M4)' -only-testing:MathTutorTests/ChatComponentTests
```

Then launch the app and send a turn that draws, so the trail can be seen streaming and then closing. Do not proceed until the user confirms both.

- [ ] **Step 5: Commit**

```bash
git add MathTutor/DesignSystem/Components/Chat/ActivityTrail.swift MathTutor/Features/Tutor/TutorPanel.swift MathTutorTests/ChatComponentTests.swift
git commit -m "Draw the activity trail above the reply"
```

---

## Done when

- A turn shows reasoning text and a named row per tool call while it runs.
- The trail closes to `Worked for 1m 15s ›` and reopens on a tap.
- A session reopened after a relaunch still opens its trails, crops included.
- A session file written before this change still loads.
- `server/tests/test_events.py` passes, and the Swift suites named above pass.
