from __future__ import annotations

import json
import time
from collections.abc import Callable
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError

from app.tutor.board_scene import (
    BoardUpdatePayload,
    parse_board_update,
    update_payload,
)


class Plan(BaseModel):
    title: str
    goal: str
    outcomes: list[str]
    steps: list[str]
    currentStep: int


class ExerciseModel(BaseModel):
    title: str
    prompt: str
    hint: str
    context: str


#: What a turn can be doing, as the device is told it.
#:
#: `drawing` is the newest and the reason the others were not enough: a
#: diagram's SVG is thousands of tokens of tool-call arguments, and until it
#: existed that whole stretch looked identical to `thinking` — which is to say,
#: it looked like nothing at all.
PhaseName = Literal["thinking", "looking", "searching", "writing", "drawing"]


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    phase: PhaseName
    detail: str | None = None


class ReasoningDeltaEvent(BaseModel):
    type: Literal["reasoning_delta"] = "reasoning_delta"
    text: str


class TextDeltaEvent(BaseModel):
    type: Literal["text_delta"] = "text_delta"
    text: str


class WorkspaceEvent(BaseModel):
    type: Literal["workspace"] = "workspace"
    plan: Plan
    exercise: ExerciseModel


class BoardUpdateEvent(BaseModel):
    """A validated batch of tutor-authored scene changes for the device.

    The model calls `update_board`; this event is the only thing that changes
    the learner's screen for that call. It carries the exact validated upserts
    and deletes (or a `replace_all` request), never PencilKit ink, and it is
    sent even though the loop also answers the call with a plain text ack —
    the ack is what lets the provider continue; this event is what draws.
    """

    type: Literal["board_update"] = "board_update"
    payload: BoardUpdatePayload


class BoardRequestEvent(BaseModel):
    """The tutor asking the device to render a region of the board.

    This travels *down* the same SSE stream the turn is writing out of, and the
    turn then blocks until the device POSTs the render back — see
    `app.tutor.rendezvous` for the mechanism and its one deployment constraint.

    It carries no image, which is the whole point of the redesign. The device
    holds the `PKDrawing`, so it can render any rectangle at any scale exactly;
    a server cutting a fixed uploaded raster returned a smear the moment the
    model zoomed past the resolution it happened to be given. The device also
    ends up holding the picture it just drew, which is what lets the thread show
    the learner what the tutor looked at without the image making a second
    round trip.

    `x`, `y`, `width` and `height` are percentages of the overview, origin top
    left — the same coordinates the model was given and the only ones legible in
    the image it is looking at.
    """

    type: Literal["board_request"] = "board_request"
    call_id: str
    x: float
    y: float
    width: float
    height: float
    #: What region this is, in words. The device has no other way to label the
    #: image for VoiceOver, and it is what the model is told it is seeing.
    detail: str


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


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    turn_id: UUID
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None
    #: How much of `input_tokens` the provider had already cached. Optional and
    #: additive, so a client that does not know the field ignores it.
    cached_tokens: int | None = None


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str
    retryable: bool


ClientEvent = Annotated[
    StatusEvent | ReasoningDeltaEvent | TextDeltaEvent | WorkspaceEvent
    | BoardUpdateEvent | BoardRequestEvent | StepEvent | DoneEvent | ErrorEvent,
    Field(discriminator="type"),
]


#: The longest this translator will let a turn go without putting a single byte
#: on the wire.
#:
#: Not a cosmetic number. `URLSession` gives up on a request that receives no
#: data for 60 seconds, and the client streams a turn on exactly that timer, so
#: any silence longer than a minute ends the turn — with the model's work
#: already generated and already billed. Before this, one `update_board` call
#: was a single unbroken silence for as long as its arguments took to stream,
#: which for a detailed diagram is minutes. Five seconds is a wide margin
#: against the shortest timeout in the path and still nowhere near often enough
#: to be noise.
HEARTBEAT_SECONDS = 5.0

#: What the device is told the tutor is doing while each tool call's arguments
#: stream in — and, because a heartbeat has to say *something*, what the
#: keep-alive says too.
#:
#: Only these three exist; a tool absent from this map is announced as nothing
#: and falls back to whatever phase was already current.
#: The memory tools earn their place here for a second reason on top of the
#: status line. Every one of them is awaited inside the tool round
#: (`turn.py`'s `handle_memory`), and while that await runs this translator is
#: not called at all — no provider events are being consumed, so the heartbeat
#: below cannot fire and the wire is genuinely silent for as long as the
#: embedding and the query take. Announcing the phase at the head of the call
#: is what puts a byte on the wire immediately before that gap, so the gap
#: starts from zero rather than on top of whatever quiet came before it.
TOOL_PHASES: dict[str, PhaseName] = {
    "update_board": "drawing",
    "view_board": "looking",
    "set_workspace": "thinking",
    "search_memory": "searching",
    "recent_sessions": "searching",
    "remember": "thinking",
    "record_evidence": "thinking",
}


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


class EventTranslator:
    """Turns Responses API events into our own vocabulary.

    Stateful on purpose: a function call's name arrives on
    `response.output_item.added` and its arguments arrive later carrying only
    `output_index`, so the two have to be correlated. That correlation now
    earns its keep twice — it is also what lets a heartbeat during a long tool
    call say *which* tool, so the keep-alive and the thing that drives the
    device's status line are one mechanism rather than two.
    """

    def __init__(
        self,
        *,
        now: Callable[[], float] = time.monotonic,
        heartbeat_seconds: float = HEARTBEAT_SECONDS,
    ) -> None:
        self._tool_names: dict[int, str] = {}
        # `output_index` -> `call_id`, because the refinement event carries only
        # the index and the step id has to be the call id. Overwritten by a
        # later round using the same index, which is correct: the lookup only
        # ever happens inside the round that wrote it.
        self._call_ids: dict[int, str] = {}
        self._writing_announced = False
        # Injected so a test can drive the heartbeat without sleeping. Monotonic
        # rather than wall clock: this measures an interval, and a clock that
        # steps backwards mid-turn would stop the keep-alive dead.
        self._now = now
        self._heartbeat_seconds = heartbeat_seconds
        self._phase: PhaseName = "thinking"
        self._last_emit = now()

    def translate(self, event: dict) -> list[ClientEvent]:
        """Translate one provider event, or keep the connection alive.

        Every raw event is a chance to notice that nothing has reached the
        device for a while. Provider events arrive continuously — argument
        deltas most of all — so hanging the check here needs no timer and no
        second task, and the only genuinely eventless wait in a turn (the
        device rendering a board region) is already bounded by
        `rendezvous.RENDER_TIMEOUT_SECONDS`.
        """
        produced = self._translate(event)
        if produced:
            self._remember(produced)
            return produced
        return self._heartbeat(event)

    def _remember(self, produced: list[ClientEvent]) -> None:
        """Record that the device just heard from us, and what we said."""
        self._last_emit = self._now()
        for event in produced:
            if isinstance(event, StatusEvent):
                self._phase = event.phase

    def _heartbeat(self, event: dict) -> list[ClientEvent]:
        """A status event sent for no reason except that the line is quiet.

        Repeating the current phase rather than inventing a new event type: the
        client already handles `status` idempotently (it assigns the phase and
        redraws nothing else), and a device too old to know a phase name drops
        the event and keeps its connection, which is the half that matters.
        """
        self._phase = self._phase_of(event) or self._phase
        now = self._now()
        if now - self._last_emit < self._heartbeat_seconds:
            return []
        self._last_emit = now
        return [StatusEvent(phase=self._phase)]

    def _phase_of(self, event: dict) -> PhaseName | None:
        """The phase an *untranslatable* event still tells us we are in.

        Argument deltas are the whole point: they carry no content this service
        forwards, but they do say which tool is mid-flight, and that is exactly
        the stretch the learner used to spend staring at nothing.
        """
        if event.get("type") != "response.function_call_arguments.delta":
            return None
        name = self._tool_names.get(event.get("output_index", -1), "")
        return TOOL_PHASES.get(name)

    def _translate(self, event: dict) -> list[ClientEvent]:
        kind = event.get("type", "")

        if kind == "response.created":
            return [StatusEvent(phase="thinking")]

        if kind == "response.reasoning_summary_text.delta":
            return [ReasoningDeltaEvent(text=event.get("delta", ""))]

        if kind == "response.output_text.delta":
            delta = TextDeltaEvent(text=event.get("delta", ""))
            if self._writing_announced:
                return [delta]
            self._writing_announced = True
            return [StatusEvent(phase="writing"), delta]

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

        if kind.startswith("response.file_search_call.") or kind.startswith(
            "response.web_search_call."
        ):
            return [StatusEvent(phase="searching")]

        return []

    def _workspace_from(self, raw_arguments: str) -> list[ClientEvent]:
        # A half-parsed workspace must never reach the board. Dropping it leaves
        # the learner's current plan and exercise exactly as they were.
        try:
            payload = json.loads(raw_arguments)
            return [WorkspaceEvent(plan=payload["plan"], exercise=payload["exercise"])]
        except (json.JSONDecodeError, KeyError, TypeError, ValidationError):
            return []

    def _board_update_from(self, raw_arguments: str) -> list[ClientEvent]:
        # A malformed scene update is dropped, not guessed at: the device keeps
        # its current scene and the loop answers the call with a rejection the
        # model can read.
        update, _ = parse_board_update(raw_arguments)
        if update is None:
            return []
        return [BoardUpdateEvent(payload=update_payload(update))]

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
