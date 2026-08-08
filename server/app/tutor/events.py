from __future__ import annotations

import json
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


class StatusEvent(BaseModel):
    type: Literal["status"] = "status"
    phase: Literal["thinking", "looking", "searching", "writing"]
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


class DoneEvent(BaseModel):
    type: Literal["done"] = "done"
    turn_id: UUID
    input_tokens: int | None = None
    output_tokens: int | None = None
    reasoning_tokens: int | None = None


class ErrorEvent(BaseModel):
    type: Literal["error"] = "error"
    message: str
    retryable: bool


ClientEvent = Annotated[
    StatusEvent | ReasoningDeltaEvent | TextDeltaEvent | WorkspaceEvent
    | BoardUpdateEvent | BoardRequestEvent | DoneEvent | ErrorEvent,
    Field(discriminator="type"),
]


class EventTranslator:
    """Turns Responses API events into our own vocabulary.

    Stateful on purpose: a function call's name arrives on
    `response.output_item.added` and its arguments arrive later carrying only
    `output_index`, so the two have to be correlated.
    """

    def __init__(self) -> None:
        self._tool_names: dict[int, str] = {}
        self._writing_announced = False

    def translate(self, event: dict) -> list[ClientEvent]:
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
                self._tool_names[output_index] = item.get("name", "")
            return []

        if kind == "response.function_call_arguments.done":
            name = self._tool_names.get(event.get("output_index", -1))
            raw_arguments = event.get("arguments", "")
            if name == "set_workspace":
                return self._workspace_from(raw_arguments)
            if name == "update_board":
                return self._board_update_from(raw_arguments)
            return []

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
