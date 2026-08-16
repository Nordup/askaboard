from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

#: Whether a failed open is worth retrying, and why.
#:
#: Re-exported from `app.tutor.retry` rather than declared a second time here.
#: `retry.classify` already returns exactly this shape and
#: `OpenAIProvider.classify` delegates to it, so a second identical dataclass
#: would make `isinstance(provider.classify(...), RetryDecision)` false — a trap
#: for every provider written against this vocabulary. One class, two importers,
#: which is the same argument `RETRY_LIMIT` living in `retry` rests on.
from app.tutor.retry import RetryDecision  # noqa: F401


@dataclass(frozen=True)
class ToolCall:
    """One function call a round ended on."""
    name: str
    call_id: str
    #: A JSON string on both providers. OpenAI streams it as
    #: `response.function_call_arguments.delta`; Gemini as an `arguments_delta`
    #: inside `step.delta`. Kept as text so `_workspace_from` and
    #: `_board_update_from` parse exactly what production sent.
    arguments: str


@dataclass(frozen=True)
class ProducedFile:
    """A file a hosted code tool made, and how to get its bytes.

    `key` is what `run_turn` de-duplicates on, so a model that re-cites its
    chart in a later round does not buy a second round to hand over the same
    picture. OpenAI keys on (container_id, file_id); Gemini keys on the step id
    and an index, because its bytes arrive inline and have no ids.
    """
    key: tuple[str, ...]
    filename: str
    read: Callable[[], Awaitable[bytes]]


@dataclass(frozen=True)
class RelayedFile:
    """What one file a script wrote came back as, once it was kept.

    `blob_id` is the whole point: a container file lives on the provider's
    machine and dies with the container, so the only durable name for a chart a
    script drew is the key of the blob this service copied it into. The model
    places it with `update_board` by that key.

    `data` is the bytes, and they come back for two reasons rather than one.
    An image has to be *shown* — the model is about to place it on a learner's
    board and describe it, and describing a picture it has never seen is a
    guess, which is the same argument `FetchedImage.image` exists for. And every
    file's length is what `TURN_DOWNLOAD_BYTE_LIMIT` is counted in, so a CSV
    that is never shown still has to arrive measurable. `relay_item` is what
    decides which of them become an `input_image`, off `content_type`.

    `error` is set instead of `blob_id` when the file could not be kept at all.
    Both being None never happens; a relay either produces a key or says why
    not, because a file silently missing from the list is a file the model
    describes to the learner anyway.

    Here rather than in `loop.py` because both sides of the relay need it and
    neither may import the other: `run_turn` constructs one for a refusal it
    decides itself, and `providers.openai.relay_item` reads one when it builds
    the item that hands the files over.
    """

    blob_id: str | None = None
    data: bytes | None = None
    #: What the bytes are, as the relay determined it. Names the media type in
    #: the data URL below, so a JPEG announced as `image/png` would be a picture
    #: the provider is handed under a false description.
    content_type: str | None = None
    error: str | None = None


@dataclass(frozen=True)
class Created:
    pass


@dataclass(frozen=True)
class TextDelta:
    text: str


@dataclass(frozen=True)
class ThoughtDelta:
    text: str


@dataclass(frozen=True)
class ToolCallStarted:
    output_index: int
    name: str
    call_id: str


@dataclass(frozen=True)
class ToolArgsDelta:
    """A call is mid-flight. Carries no content this service forwards.

    It exists so `EventTranslator._phase_of` can keep saying which tool is
    streaming, which is the stretch the learner used to spend staring at
    nothing.
    """
    output_index: int


@dataclass(frozen=True)
class ToolArgsDone:
    output_index: int
    arguments: str


@dataclass(frozen=True)
class HostedToolActivity:
    #: "searching" or "computing".
    phase: str


@dataclass(frozen=True)
class HostedToolStarted:
    """A hosted call is its own output item and has no call_id.

    `item_id` is what the device keys the step row on. A row filed under the
    empty string is one the next call silently overwrites, so a provider that
    cannot supply an id must not emit this.
    """
    item_id: str
    tool: str


@dataclass(frozen=True)
class Completed:
    usage: dict | None
    response_id: str | None
    #: Gemini ends a tool round with "requires_action" rather than a plain
    #: completion. `run_turn` never branches on this — it branches on whether
    #: `calls` is empty, as it already did — but the recorder stores it and the
    #: error branch reads it. See `TERMINAL_ERROR_STATUSES`.
    status: str
    calls: list[ToolCall] = field(default_factory=list)
    files: list[ProducedFile] = field(default_factory=list)


@dataclass(frozen=True)
class Failed:
    message: str
    status: str


#: Every neutral event a provider may emit.
ProviderEvent = (
    Created | TextDelta | ThoughtDelta | ToolCallStarted | ToolArgsDelta
    | ToolArgsDone | HostedToolActivity | HostedToolStarted | Completed | Failed
)

#: Interaction statuses that end a turn badly. `requires_action` is deliberately
#: absent: it is how a normal tool round ends, and treating it as a failure would
#: break every turn that touches the board.
TERMINAL_ERROR_STATUSES: frozenset[str] = frozenset({
    "failed", "cancelled", "budget_exceeded", "incomplete",
})


@runtime_checkable
class Provider(Protocol):
    """One model family, reduced to what `run_turn` needs of it."""

    name: str

    def build_round(
        self,
        *,
        model: str,
        effort: str,
        outbox: list[dict],
        previous_id: str | None,
        cache_key: str | None,
    ) -> dict:
        """The request body for one round."""

    async def open_round(self, payload: dict) -> Any:
        """An async context manager yielding raw stream events."""

    def normalise(self, raw: Any) -> tuple[dict, ProviderEvent | None]:
        """One raw event as (recordable dict, neutral event or None).

        The dict is what `TurnResult.raw_events` stores, so it must stay
        JSON-serialisable. `None` for an event this service does not read: the
        heartbeat still fires on it, which is why it is returned rather than
        dropped.
        """

    def tool_output(self, *, call_id: str, name: str, output: str) -> dict:
        """One tool's answer, as an input item for the next round."""

    def image_item(
        self, png: bytes, caption: str, media_type: str = "image/png"
    ) -> dict:
        """A picture to show the model, as an input item.

        `media_type` is not decoration and is not in this seam's original
        sketch. What arrives here is whatever `fetch_image` sniffed off a
        stranger's bytes, and a JPEG announced as `data:image/png` is a picture
        the provider is handed under a false description — see
        `FetchedImage.content_type`. Defaulted, so the two callers that only
        ever have a PNG say nothing about it.
        """

    def rendered_items(self, call_id: str, image: bytes, detail: str) -> list[dict]:
        """The device's board render, as the items that answer `view_board`.

        Two items, not one: an output answers the call and a picture has to be
        *shown*, and the pairing the API requires — one output per call — must
        stay intact. Behind the provider rather than in `run_turn` because both
        halves are request-item shapes, which is exactly what differs between
        families.
        """

    def relay_item(self, relayed: list[tuple[str, RelayedFile]]) -> dict:
        """The files a script wrote, as the one item that hands them over.

        Also not in this seam's original sketch, and it has to be here for the
        same reason `image_item` does: it builds an input item carrying
        pictures. One item however many files — the caption saying what these
        bytes are leads once, before any of them are looked at.
        """

    def classify(self, status_code: int, body: dict | None) -> RetryDecision:
        """Whether a failed open is worth retrying."""
