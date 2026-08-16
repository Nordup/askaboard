"""The Interactions API, behind the seam `run_turn` reaches a model through.

The sibling of `providers/openai.py`, and deliberately the same shape: the
request body for one round, the raw event names, the shapes of the input items a
tool answer travels in. `run_turn` keeps the round loop, the tool-round bound,
the budgets and the rendezvous, because none of those are a provider's business.

**This provider is stateful across a round, and the OpenAI one is not.** That is
the single biggest difference between the two files and the reason to read this
docstring before the code. `response.completed` repeats the whole `output` array,
so the OpenAI provider can read a round's function calls and its produced files
off one terminal event. `interaction.completed` carries `id`, `status`, `model`
and `usage` and nothing else — the `steps` field exists on the type and never
arrives — so every tool call and every produced image has to be **accumulated
from the deltas** and handed over on `Completed`. `run_turn` decides whether to
buy another round by asking whether `Completed.calls` is empty, so an accumulator
that loses a call ends the turn in silence, and one that repeats a call bills the
learner for a round that does nothing. `_Round` below is that accumulator and
`tests/test_providers.py` drives every recorded fixture through it.

Four more shapes contradict what a reader of the Responses API expects, and each
is a recorded fact rather than a reading of the documentation — see
`tests/fixtures/interactions.py`, which was recorded off real turns:

- `step.stop` carries only `index`. `ToolArgsDone.arguments` comes from the
  accumulator, never from the event.
- Two different fields are called `arguments`. On a `function_call` delta it is
  incremental JSON *text*; on a hosted-tool delta it is an already-parsed *dict*.
  Only the first is read, and it stays a string, because `_board_update_from` and
  `_workspace_from` parse strings and should keep parsing exactly what production
  sent.
- `thought_signature` is a delta type, and it is not a thought summary: it is an
  opaque base64 blob carrying reasoning continuity. Surfacing it as a
  `ThoughtDelta` would print base64 in a learner's activity trail. At
  `thinking_level: "low"` a turn often emits the signature and no summary at all,
  so the reasoning ribbon can legitimately be empty on this family.
- A produced image is an `image` delta inside a later `model_output` step, with
  no id and no filename anywhere; the `code_execution_result` step's `result` is
  the empty string. So there is no `container_file_citation` equivalent to key a
  `ProducedFile` on — see `_produced_files` for what is keyed on instead.

**`client` is not validated**, for the reason the OpenAI provider gives: every
pure function here — the payload build, the event mapping, the item builders —
works without one, and a test that only wants those passes `client=None`.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import mimetypes
from dataclasses import dataclass, field
from functools import partial
from typing import Any

from app.tutor import retry
from app.tutor.events import CODE_INTERPRETER
from app.tutor.fetch_image import ALLOWED_CONTENT_TYPES
from app.tutor.providers import (
    RELAYED_FILES_CAPTION, TERMINAL_ERROR_STATUSES, Completed, Created, Failed,
    HostedToolActivity, HostedToolStarted, ProducedFile, ProviderEvent,
    RelayedFile, RetryDecision, TextDelta, ThoughtDelta, ToolArgsDelta,
    ToolArgsDone, ToolCall, ToolCallStarted,
)
from app.tutor.providers.gemini_schema import to_gemini_tools
from app.tutor.tools import TOOL_DEFINITIONS

logger = logging.getLogger(__name__)

#: `TOOL_DEFINITIONS` as Gemini declarations, converted once when this module is
#: imported.
#:
#: Not per turn, and the reason is the raise. `to_gemini_tools` refuses a schema
#: it cannot express — an unresolvable `$ref`, a type list with no nullable
#: form — and that refusal is only a boot-time guarantee if it runs at boot.
#: Converted per round instead, an edit to `tools.py` that breaks one arm would
#: pass every import, pass the health check, and fail on the first turn a learner
#: sent. It is also ~10,100 input tokens of output, so building it eight times a
#: turn would be work bought for nothing.
GEMINI_TOOLS: list[dict] = to_gemini_tools(TOOL_DEFINITIONS)

#: The picker's five efforts as Gemini's three thinking levels.
#:
#: `xhigh` and `max` clamp to `high` because Gemini has nothing deeper.
#: `TutorStore.setModel` clamps on the device before a turn is ever sent and
#: `EFFORTS_FOR_MODEL` refuses the pair at the request boundary, so in normal
#: operation nothing reaches this map that needs clamping. It is here for the turn
#: that does anyway — an older client, or a session restored from a file written
#: before the clamp existed.
EFFORT_TO_THINKING_LEVEL: dict[str, str] = {
    "low": "low", "medium": "medium", "high": "high",
    "xhigh": "high", "max": "high",
}

#: What `Failed.status` says for an error that arrives inside a 200 response.
#:
#: A constant, because there is no status to read. The stream opens normally,
#: says `in_progress`, and then an `error` event ends it — there is no
#: `interaction.completed` carrying `failed`, and no HTTP error either, because
#: the 200 was already sent. `in_progress` is the last status that actually
#: arrived and is the one wrong answer to record: a reader testing this against
#: `TERMINAL_ERROR_STATUSES` would conclude the round was still running.
IN_STREAM_FAILURE_STATUS = "failed"

#: What the learner's status line says while each hosted tool runs.
#:
#: One map for two lookups, because the same names appear as step types on
#: `step.start` and as delta types on `step.delta`. The phase is the only thing a
#: hosted call can report: it has no `function_call` item to read a name off, so
#: `EventTranslator` cannot look it up in `TOOL_PHASES` the way it does for the
#: tools this service implements.
HOSTED_PHASES: dict[str, str] = {
    "google_search_call": "searching",
    "google_search_result": "searching",
    "code_execution_call": "computing",
    "code_execution_result": "computing",
}

#: OpenAI's `detail` on an image part, as Gemini's `resolution`.
#:
#: Carried across rather than dropped, and it is not cosmetic. The board overview
#: rides on every turn at `detail: "low"` precisely so a thumbnail is not billed
#: at reading resolution — see `assemble_context`. Dropped here, that saving
#: would silently disappear on this family only.
#:
#: `original` maps to `high` rather than to `ultra_high`. What `original` means on
#: the other side is "do not downsample this", and the pictures that carry it are
#: a learner's photo and a page of their handwriting; `high` is the level this
#: provider asks for whenever something has to be *read*. `ultra_high` is a
#: level nothing here has measured, and guessing upward is guessing with money.
DETAIL_TO_RESOLUTION: dict[str, str] = {
    "low": "low", "medium": "medium", "high": "high", "original": "high",
}

#: What a picture this provider builds itself is labelled with.
#:
#: `high` for every one of them, and it is the same argument
#: `providers.openai._image_part` makes for `detail: "high"`: what comes back is a
#: region of a learner's handwriting, a diagram with labels on it, or a chart with
#: an axis scale, and a downsampled copy of any of those is indistinguishable, to
#: a model, from a blank page.
IMAGE_RESOLUTION = "high"

#: Substrings that mark a 429 as a spent allowance rather than a burst limit.
#:
#: Gemini answers both with 429 and `RESOURCE_EXHAUSTED`, so neither the status
#: code nor the status name separates "five requests in one second" from "the
#: day's quota is gone". The first is worth two backoffs. The second is a learner
#: watching a thinking indicator through them for a refusal that was already
#: certain, which is exactly what `retry.BILLING_ERROR_CODES` exists to prevent on
#: the other family — this is the same rule expressed against the only evidence
#: this API gives, which is prose and a `QuotaFailure` detail.
#:
#: Read against the message *and* the serialised `details`, because the useful
#: half is usually in a violation's `quotaId` (`…PerDay`, `…PerDayPerProject`)
#: rather than in the sentence. A false positive costs one retry the learner did
#: not need; a false negative costs backoff in front of a certain failure.
#:
#: Written without spaces, underscores or hyphens because that is how
#: `_reads_as_spent_quota` normalises what it reads: the same fact is spelled
#: `PerDay` in a quota id, `per day` in an English sentence and `per_day` in a
#: metric name, and three spellings of one phrase is three chances to miss it.
QUOTA_EXHAUSTION_PHRASES: tuple[str, ...] = (
    "perday", "dailylimit", "quotaexceeded", "exceededyourcurrentquota",
    "billing", "freetier",
)


async def _inline_bytes(data: bytes) -> bytes:
    """The bytes a produced image already arrived with.

    `ProducedFile.read` is a coroutine because the OpenAI side has to fetch a
    container file over the network before anything can be done with it. Gemini
    sends the picture inline, so there is nothing to fetch and this is the whole
    of the read — but the shape has to match, or the relay in `app.api.turn`
    would need a branch for which family it is talking to, which is precisely
    what `ProducedFile` exists to prevent.

    Bound rather than closed over so the bytes are held by the `partial` and not
    by a lambda that also captures the provider — a round's images are handed to
    the relay and then the accumulator is thrown away, and nothing should keep
    this provider alive for them.
    """
    return data


def map_usage(usage: dict) -> dict:
    """Interactions usage in the shape the recorder already writes.

    Mapped rather than stored raw so `recorder._apply_usage` and
    `pricing.turn_cost_usd` need no provider branch. `total_thought_tokens`
    lands under `output_tokens_details.reasoning_tokens` because Gemini bills
    thinking inside the output tokens, exactly as the OpenAI family does — a
    separate rate would double-charge, which is the rule `MODEL_PRICES_PER_1M`'s
    own comment states.

    `cache_write_tokens` has no equivalent and stays absent, so the column stays
    NULL. A NULL is a visible gap someone can query for, which is the rule
    `recorder.cache_tokens` already follows.

    `grounding_tool_count` is the one number here that is not a token, and it is
    flattened rather than passed through: it arrives as a list of
    `{count, type}`, and `turn_cost_usd` multiplies it by `per_search` as an int.
    Handed on as the list, a grounded turn would price as a `TypeError` instead of
    as money — see `_searches`.
    """
    return {
        "input_tokens": usage.get("total_input_tokens"),
        "output_tokens": usage.get("total_output_tokens"),
        "input_tokens_details": {"cached_tokens": usage.get("total_cached_tokens")},
        "output_tokens_details": {
            "reasoning_tokens": usage.get("total_thought_tokens"),
        },
        # Recorded, not priced: the code-execution documentation describes these
        # as intermediate tokens already counted in input and output.
        "tool_use_tokens": usage.get("total_tool_use_tokens"),
        "grounding_tool_count": _searches(usage),
    }


def _searches(usage: dict) -> int:
    """How many billable grounding requests one round made, as one integer.

    `usage.grounding_tool_count` is `[{"count": 2, "type": "google_search"}]` on a
    grounded round and absent entirely on every other one. `turn_cost_usd`
    multiplies this by `per_search`, so the list has to become a number here or
    the multiplication raises.

    **Every entry counts, whatever its `type`.** Filtering to the types this
    service knows about was the alternative, and it fails in the direction that
    matters: a grounding tool added later, or renamed upstream, would price at
    zero and its spend would be invisible — the exact gap `MODEL_PRICES_PER_1M`
    exists to close. Counting an unfamiliar grounding call at the search rate
    over-reports, which trips the daily cap early, and that is the way
    `per_search`'s own comment already errs. Today the two cannot even differ:
    `google_search` is the only grounding tool `TOOL_DEFINITIONS` offers.

    Every field is provider-authored, so each is absent-or-wrong until proven an
    integer. `bool` is excluded explicitly because it is a subclass of `int` and
    `True + True` is a plausible-looking 2.
    """
    entries = usage.get("grounding_tool_count")
    if not isinstance(entries, list):
        return 0
    total = 0
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        count = entry.get("count")
        if isinstance(count, bool) or not isinstance(count, int):
            continue
        total += count
    return total


def _split_data_url(url: Any) -> tuple[str, str]:
    """A `data:` URL as the two fields Gemini takes, `(mime_type, base64)`.

    The one part of the request that genuinely needs care. OpenAI takes a single
    `data:image/png;base64,…` string; Gemini takes the media type and the raw
    base64 in separate fields, so the string has to be taken apart rather than
    forwarded. Left whole, the provider would receive a picture whose entire
    payload begins with the characters `data:image/png;base64,` — which decodes to
    nothing, and which fails as a corrupt image rather than as a bad request.

    A URL this cannot split returns `("", "")`, and the caller drops the part.
    Every string here was built by this service, so an unsplittable one is a bug
    in the builder rather than something a learner did; dropping the picture keeps
    the round well-formed enough to say so in prose, where sending an empty image
    part is a 400 that fails the whole turn.
    """
    if not isinstance(url, str) or not url.startswith("data:"):
        return "", ""
    header, _, payload = url.partition(",")
    if not payload:
        return "", ""
    media_type = header[len("data:"):].removesuffix(";base64")
    return media_type, payload


def _image_part(image: bytes, media_type: str = "image/png") -> dict:
    """One picture, as the content part that carries it inline."""
    return {
        "type": "image",
        "mime_type": media_type,
        "data": base64.b64encode(image).decode(),
        "resolution": IMAGE_RESOLUTION,
    }


def _user_input(parts: list[dict]) -> dict:
    """Content the caller is putting in front of the model, as one input step.

    `user_input` rather than a `{"role": "user"}` item, because this API has no
    roles: `InteractionsInput` is a string, a content part, a list of content
    parts, or a list of *steps*, and the step that means "the caller said this" is
    `user_input`. A `role` key would be a field the request type does not
    declare, riding along beside the ones it does.
    """
    return {"type": "user_input", "content": parts}


def _text_part(text: str) -> dict:
    return {"type": "text", "text": text}


class GeminiProvider:
    """The Interactions API, behind the seam `run_turn` reaches a model through.

    See the module docstring for the accumulator this holds and why the OpenAI
    provider needs none.
    """

    name = "gemini"

    def __init__(
        self, *, client: Any | None = None, tools: list[dict] | None = None
    ) -> None:
        self._client = client
        # Injectable, defaulting to the conversion done at import. A test that
        # wants to see one tool on the wire passes its own list rather than
        # asserting against 10,100 tokens of real schema; production never passes
        # anything, so the boot-time conversion is what every turn sends.
        self._tools = GEMINI_TOOLS if tools is None else tools
        self._round = _Round()

    # ---- the request -------------------------------------------------------

    def build_round(
        self,
        *,
        model: str,
        effort: str,
        outbox: list[dict],
        previous_id: str | None,
        cache_key: str | None,
    ) -> dict:
        """The request body for one round.

        Also where the round's accumulator is emptied. `interaction.created`
        empties it too — see `neutral` — and the two cover different failures:
        this one covers a stream that dies before its first event, and that one
        covers `loop._open_round` retrying an open, which reuses the payload this
        built rather than asking for a new one.

        `cache_key` is accepted and ignored. There is no `prompt_cache_key`
        equivalent on this API: implicit caching routes on the prompt prefix by
        itself, so there is no field to put a key in and an unknown one would ride
        along in the request body. Worth knowing that this is unevidenced rather
        than proven — `total_cached_tokens` was 0 on every turn recorded so far,
        so nobody should rely on it for COGS until a hit has actually been seen.
        """
        self._round = _Round()

        system_instruction, input_items = _split_system(outbox)

        payload: dict = {
            "model": model,
            "input": input_items,
            "tools": self._tools,
            "generation_config": {
                # `thinking_level`, never `thinking_budget`: the budget form is
                # superseded on Gemini 3.x. `temperature`, `top_p` and `top_k` are
                # rejected outright by these models and are not sent — the SDK's
                # own `GenerationConfig` has no field for any of the three, which
                # is the second half of that evidence.
                "thinking_level": EFFORT_TO_THINKING_LEVEL[effort],
                "thinking_summaries": "auto",
                # What `strict: True` bought on the other side, which
                # `to_gemini_tools` had to drop because a Gemini declaration has
                # nowhere to put it. Interaction-scoped rather than per-tool, so
                # it applies to the hosted tools as well as to ours.
                "tool_choice": "validated",
            },
            # Retained 55 days on the paid tier, and that is the point: it is what
            # `previous_interaction_id` chains against, so the thinking behind a
            # tool call survives into the round that has to act on it. (The
            # OpenAI comment says thirty days, which is that provider's number,
            # not this one's.)
            "store": True,
            "stream": True,
        }
        if system_instruction:
            # Top level, not an item in `input`. Left where OpenAI puts it, the
            # tutor's whole character would arrive as a user turn — advice rather
            # than instruction — and the one message a model is most willing to
            # argue with is the one another user sent.
            #
            # Absent on a later round rather than repeated: the outbox then holds
            # only tool results, and the instruction is already part of the stored
            # interaction that `previous_interaction_id` names.
            payload["system_instruction"] = system_instruction
        if previous_id is not None:
            # Names the round this one continues, in exactly the position
            # `previous_response_id` sits in on the other family. With it,
            # `outbox` holds only the tool results; without it, every round would
            # resend the whole prompt and the model would lose its own reasoning
            # each time.
            payload["previous_interaction_id"] = previous_id
        return payload

    async def open_round(self, payload: dict):
        """Open one round's stream.

        One call, and no retry: `loop._open_round` owns that, because
        `RETRY_LIMIT` and `retry_delay` are shared with `/v1/dictation` and a
        second copy of either is a second thing to keep in step.

        Unlike the OpenAI client, the one this holds keeps the SDK's *own* retry
        (4 attempts over 408/409/429/5xx). That looks like a contradiction of
        `turn._client`'s `max_retries=0` and is the opposite trade: `_open_round`
        catches `openai.APIStatusError` only, so nothing in this service retries a
        Gemini open at all, and switching the transport's retry off would leave a
        single refused connection ending a learner's turn. What it costs is the
        thing `max_retries=0` was chosen to avoid — an exhausted quota is waited
        through before anything classifies it — and `classify` below is where
        that gets fixed once the loop can see this family's exceptions.
        """
        return await self._client.aio.interactions.create(**_sdk_kwargs(payload))

    # ---- the stream --------------------------------------------------------

    def normalise(self, raw: Any) -> tuple[dict, ProviderEvent | None]:
        """One raw event as (recordable dict, neutral event or None).

        Accepts an SDK model or a plain dict. The SDK path is what production
        sends; the dict path is what `tests/fixtures/interactions.py` holds, and
        those fixtures are recorded output of exactly this `model_dump`, so
        neither path is a different shape from the other. A test that had to
        construct `InteractionSSEEvent` objects to exercise the mapping would be
        testing the SDK's validators as much as this file.
        """
        event = (
            raw.model_dump(mode="json", exclude_none=True)
            if hasattr(raw, "model_dump")
            else dict(raw)
        )
        return event, self.neutral(event)

    def neutral(self, event: dict) -> ProviderEvent | None:
        """What one already-dumped Interactions event means, in neutral terms.

        Split out of `normalise` for the reason the OpenAI provider splits it: the
        mapping can then be exercised against the wire shapes this family really
        sends, without an SDK object to dump.

        `None` for every event this service does not read — `status_update`,
        `thought_signature`, `text_annotation_delta`, `google_search_result`'s
        payload. The heartbeat still fires on it, which is why it is returned
        rather than dropped.
        """
        kind = event.get("event_type", "")

        if kind == "interaction.created":
            # A new interaction is a new round, so the accumulator starts here as
            # well as in `build_round`. Its id is kept because a produced image
            # has no id of its own and this is what makes its key unique across
            # the rounds of one turn — see `_produced_files`.
            interaction = event.get("interaction") or {}
            self._round = _Round(interaction_id=interaction.get("id") or "")
            return Created()

        if kind == "step.start":
            return self._step_started(event)

        if kind == "step.delta":
            return self._step_delta(event)

        if kind == "step.stop":
            return self._step_stopped(event)

        if kind == "interaction.completed":
            return self._completed(event)

        if kind == "error":
            return self._failed(event)

        # `interaction.status_update` lands here, and it is the event a heartbeat
        # sees most often: it arrives immediately after `interaction.created` on
        # every turn recorded, saying `in_progress`, which `created` already said.
        return None

    def _step_started(self, event: dict) -> ProviderEvent | None:
        """A step opening: the only event that names a function call.

        `step.start` is where a `function_call` step's `id` and `name` arrive, and
        it is the *only* place either appears. `step.stop` carries nothing but the
        index, so a name not recorded here is a call this provider can never
        report — which is a tool the loop never answers and a turn that ends
        mid-conversation.
        """
        index = event.get("index")
        step = event.get("step") or {}
        kind = step.get("type") or ""
        if not isinstance(index, int):
            # Nothing to file the step under, so nothing can be correlated with
            # it later. Reported as unreadable rather than filed at a guessed
            # index, which would attach the next arguments delta to a stranger.
            logger.warning("step.start with no index | step_type=%s", kind)
            return None

        self._round.steps[index] = _Step(
            kind=kind,
            # Empty rather than absent when the provider sends none: the
            # translator keys a step row on the call id and will not open a row
            # without one.
            call_id=step.get("id") or "",
            name=step.get("name") or "",
        )

        if kind == "function_call":
            return ToolCallStarted(
                output_index=index,
                name=step.get("name") or "",
                call_id=step.get("id") or "",
            )

        if kind == "code_execution_call":
            # A hosted call is a step of its own and has no `call_id`, so it never
            # reaches the branch above. Its `id` is what the device keys the row
            # on, and a row filed under the empty string is one the next call
            # silently overwrites — worse than no row — so with no id this is not
            # reported at all. No status comes of it either: the
            # `code_execution_call` delta follows immediately and is where
            # `computing` comes from.
            item_id = step.get("id")
            if item_id:
                # The neutral name, not Gemini's `code_execution`. It is what
                # `TOOL_STEP_LABELS` is keyed by, so the learner reads the same
                # row on both families.
                return HostedToolStarted(item_id=item_id, tool=CODE_INTERPRETER)
            return None

        # Every other hosted step — a search call, either result step — reports
        # only its phase. `google_search` has no `TOOL_STEP_LABELS` row, so a
        # `HostedToolStarted` for it would translate to nothing at all and the
        # `searching` status would be lost with it.
        phase = HOSTED_PHASES.get(kind)
        return HostedToolActivity(phase=phase) if phase else None

    def _step_delta(self, event: dict) -> ProviderEvent | None:
        """A step's content arriving, one fragment at a time."""
        index = event.get("index")
        delta = event.get("delta") or {}
        kind = delta.get("type") or ""

        if kind == "text":
            return TextDelta(text=delta.get("text") or "")

        if kind == "thought_summary":
            text = _thought_text(delta)
            # Only when there is prose. An empty `ThoughtDelta` would put an empty
            # `reasoning_delta` on the learner's wire, and returning None instead
            # lets the heartbeat cover the gap with something true.
            return ThoughtDelta(text=text) if text else None

        if kind == "thought_signature":
            # Deliberately nothing. This is an opaque base64 blob — 128 characters
            # on a short turn, over 2,700 on a turn that reasons about the board —
            # and it is what carries reasoning continuity across rounds, not
            # anything a person reads. Mapped to `ThoughtDelta` it would print
            # base64 into the activity trail.
            return None

        if kind == "arguments_delta":
            fragment = delta.get("arguments")
            if isinstance(index, int) and isinstance(fragment, str):
                # Appended, never parsed here. The recorded fixtures split the
                # JSON mid-key on purpose, because a provider that tried to read
                # each fragment on its own would pass on a call that happened to
                # arrive whole and break on every real one.
                step = self._round.steps.setdefault(index, _Step(kind="function_call"))
                step.arguments += fragment
            return ToolArgsDelta(
                output_index=index if isinstance(index, int) else -1
            )

        if kind == "image":
            self._keep_image(index, delta)
            # No neutral event. A picture is not something the device is told
            # about mid-round; it becomes a `ProducedFile` on `Completed`, and the
            # heartbeat covers the stretch it arrives in.
            return None

        # `code_execution_call` (the script), `code_execution_result` (its
        # output), `google_search_call` (the queries) and `google_search_result`
        # (2.5KB of branded HTML) all land here and all report only a phase.
        # Their `arguments` is an already-parsed dict rather than the JSON text a
        # `function_call` sends, and none of it is content this service forwards.
        phase = HOSTED_PHASES.get(kind)
        if phase:
            return HostedToolActivity(phase=phase)

        # `text_annotation_delta` is the remaining recorded type: `url_citation`
        # annotations against character ranges of text already streamed. Nothing
        # displays them, and the heartbeat fires on it.
        return None

    def _step_stopped(self, event: dict) -> ProviderEvent | None:
        """A step closing, carrying nothing but its index.

        This is where a function call is completed, and every field of it comes
        out of the accumulator: `step.stop` has no name, no call id and no
        arguments. It is also the only place `Completed.calls` is filled, which is
        what `run_turn` reads to decide whether the turn buys another round.
        """
        index = event.get("index")
        step = self._round.steps.get(index) if isinstance(index, int) else None
        if step is None or step.kind != "function_call":
            return None

        self._round.calls.append(ToolCall(
            name=step.name, call_id=step.call_id, arguments=step.arguments,
        ))
        # The empty string when no delta arrived, which is what the OpenAI family
        # sends for a call with no arguments. Every reader downstream —
        # `loop._arguments`, `parse_board_update`, `EventTranslator._refined_label`
        # — already treats it as `{}`, so this needs no invention of its own.
        return ToolArgsDone(output_index=index, arguments=step.arguments)

    def _keep_image(self, index: Any, delta: dict) -> None:
        """One picture a hosted script produced, decoded and held for `Completed`.

        Decoded here rather than in `_produced_files` so a payload that will not
        decode is dropped where it can be logged against the step it came from,
        and so `ProducedFile.read` cannot fail: by the time the relay awaits it,
        the bytes already exist.

        `validate=False` is the default and is deliberate. A base64 payload
        wrapped at some line length is still the picture; refusing it over a
        newline would lose a chart this service had already been given.
        """
        encoded = delta.get("data")
        if not isinstance(encoded, str) or not encoded:
            return
        try:
            data = base64.b64decode(encoded)
        except (binascii.Error, ValueError) as error:
            logger.warning(
                "could not decode a produced image | step=%s error=%s", index, error,
            )
            return
        if not data:
            return
        mime_type = delta.get("mime_type")
        if not isinstance(mime_type, str) or not mime_type:
            # A picture with no declared type is a PNG, because that is what a
            # plotting script writes and what every recording carried. The type
            # is what the synthesised filename's extension comes from, and see
            # `_produced_files` for what an extension decides.
            mime_type = "image/png"
        self._round.images.append(_Image(
            step=index if isinstance(index, int) else -1,
            data=data,
            mime_type=mime_type,
        ))

    def _completed(self, event: dict) -> Completed:
        """The round's terminal event, plus everything it does not carry.

        `usage`, `id` and `status` are read off the event. The calls and the files
        are the accumulator's, because this event has no `output` and no `steps` —
        see the module docstring. That is the whole reason this provider is
        stateful.
        """
        interaction = event.get("interaction") or {}
        usage = interaction.get("usage")
        status = interaction.get("status") or ""
        response_id = interaction.get("id") or self._round.interaction_id or None

        if status in TERMINAL_ERROR_STATUSES:
            # Reported and still returned as a completion, rather than converted
            # into a `Failed`. A round that ended `incomplete` or
            # `budget_exceeded` spent tokens getting there, and `Failed` carries
            # no usage — so converting it would leave that spend out of
            # `turns.cost_usd`, which is money nobody can see. `run_turn` ends the
            # turn on its own from here, because a status like this arrives with no
            # calls, and the learner keeps whatever prose did arrive.
            logger.warning(
                "interaction ended %s | interaction_id=%s", status, response_id,
            )

        return Completed(
            usage=map_usage(usage) if isinstance(usage, dict) else None,
            response_id=response_id,
            # The interaction's own status, so `requires_action` arrives as
            # itself. `run_turn` never branches on this — it branches on whether
            # `calls` is empty, exactly as it always did.
            status=status,
            calls=list(self._round.calls),
            files=self._produced_files(response_id),
        )

    def _produced_files(self, response_id: str | None) -> list[ProducedFile]:
        """Every picture this round's scripts drew, as files the relay can keep.

        **There is nothing to key these on.** An inline image has no id, no
        filename, and no citation naming it; the `code_execution_result` step it
        logically belongs to has `result: ""`, and the picture arrives in a later
        `model_output` step. The only name it is ever given is the
        `sandbox:/plot.png` link the model writes into its own prose.

        So the key is built: the interaction id, the step index, and the picture's
        place in the round. The interaction id is the part that matters and is not
        in the plan's sketch — `run_turn` de-duplicates on this key across a whole
        turn, and every round numbers its steps from zero, so a key of step-plus-
        index alone would make round two's chart look like round one's already-
        relayed file and throw it away.

        **The filename is load-bearing, not decoration.** `app.api.turn`'s relay
        derives the attachment's content type from it (`relayed_content_type`),
        and that type is what decides whether `model_copy` reduces the picture
        before it goes back into the conversation. A synthesised name without a
        real image extension would come back as `application/octet-stream`, skip
        the reduction, and put a full-resolution PNG into a context that is
        re-billed on every one of up to eight rounds.
        """
        files: list[ProducedFile] = []
        for ordinal, image in enumerate(self._round.images, start=1):
            extension = mimetypes.guess_extension(image.mime_type) or ".png"
            files.append(ProducedFile(
                key=(response_id or "", str(image.step), str(ordinal)),
                filename=f"image_{ordinal}{extension}",
                # Bound with the bytes, so the relay path never learns that this
                # family sends pictures inline and the other keeps them in a
                # container.
                read=partial(_inline_bytes, image.data),
            ))
        return files

    def _failed(self, event: dict) -> Failed:
        """An `error` event, which replaces `interaction.completed` on a 200.

        There is no status code here to classify: the round's POST answered 200,
        the stream opened, and the refusal arrived as an SSE record. That is the
        same shape `retry._without_status` was written for on the other family, so
        it is classified through exactly that path rather than through a status
        code invented to stand in for one that never arrived.

        The classification goes into the message, not into the event, because
        `run_turn`'s `Failed` branch reports `retryable=False` for everything: the
        stream had already started, so whatever text arrived the learner has
        already read, and re-running the round would write it twice. The verdict
        is still worth recording — a rate limit that says "try again in 662ms" and
        a malformed request are the same blank wall in a log that does not say
        which it was.

        **The provider's own words stop here.** `message` is diagnosable text for
        the log; the device is told `TURN_FAILED_MESSAGE` by `run_turn`, and that
        is a property of the path rather than of this method. An iPad once
        displayed a provider's rate-limit text complete with the organization id,
        which is the failure that rule exists for.
        """
        error = event.get("error") or {}
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else None
        decision = self.classify(
            None, event, message if isinstance(message, str) else None
        )
        return Failed(
            message=(
                f"{code or 'error'}: {message or 'no message'} "
                f"(classified: {decision.reason})"
            ),
            status=IN_STREAM_FAILURE_STATUS,
        )

    # ---- the input items ---------------------------------------------------

    def tool_output(self, *, call_id: str, name: str, output: str) -> dict:
        """One tool's answer, as an input item for the next round.

        `name` is required here, unlike on the other family where it is dropped: a
        `function_result` whose `name` disagrees with the call it answers is a 400
        with `error.code == "invalid_request"`, recorded rather than inferred. It
        is why `name` is in the shared signature at all.

        `result` carries the string every tool in this service answers with.
        `is_error` is left off: the field exists, and nothing here knows which
        answers are errors — a rejected board update is answered with a
        `{"status": "rejected"}` ack the model is meant to read and revise from,
        not with a transport-level failure.
        """
        return {
            "type": "function_result",
            "call_id": call_id,
            "name": name,
            "result": output,
        }

    def image_item(
        self, png: bytes, caption: str, media_type: str = "image/png"
    ) -> dict:
        """A picture to show the model, as an input item.

        One `user_input` step carrying the caption and then the picture, which is
        the same arrangement `providers.openai._image_item` makes for the same
        reason: a tool's answer is a string, and both tools that produce a picture
        have to hand back a **picture**. The answer answers the call, and the
        image follows as its own step, so the next thing in the model's context
        after it asked to see something is that something.

        Deliberately *not* the other shape this API offers. A `function_result`'s
        `result` may be a list of text and image parts, which would fold the
        picture into the answer — and that shape is unrecorded: no fixture in this
        repository has ever carried it. Using the arrangement the other family
        already proves keeps one mechanism for all three picture paths (a board
        render, a fetched image, a script's files) instead of two, and keeps the
        unverified surface to `user_input` carrying an image part, which is read
        off the SDK's own `UserInputStep` and `ImageContent` types.
        """
        return _user_input([_text_part(caption), _image_part(png, media_type)])

    def rendered_items(self, call_id: str, image: bytes, detail: str) -> list[dict]:
        """The device's board render, as the items that answer `view_board`.

        Two items, not one, for the reason `image_item` gives. The pairing the API
        requires — one result per call — is left exactly intact.

        The name is `view_board` literally, and it is safe to write it here rather
        than pass it in: `loop._answer` produces the `ask` branch that reaches this
        method for that one tool and no other. Writing anything else would be the
        400 `tool_output` describes, which is why it is spelled out rather than
        left as an empty string.
        """
        return [
            self.tool_output(
                call_id=call_id,
                name="view_board",
                output=json.dumps({"status": "ok", "detail": detail}),
            ),
            self.image_item(
                image, f"Here is the region of the board you asked for. {detail}"
            ),
        ]

    def relay_item(self, relayed: list[tuple[str, RelayedFile]]) -> dict:
        """The files a script wrote, as the one item that hands them over.

        One item however many files, for the reason
        `providers.openai._relay_item` gives: the whole set is a single thing that
        happened, and the caption saying what these bytes are has to lead, once,
        before any of them are looked at. Every file gets a line including the
        ones that could not be kept — a model not told the chart never saved
        describes it to the learner anyway, and then places a blob id it invented.

        The allowlist rather than `startswith("image/")`, and it is the half that
        protects the *turn*: an image part announcing a format the provider does
        not accept is a 400 on the next round, which fails everything rather than
        losing one picture. See `relayed_content_type` for the half that protects
        the device.
        """
        lines = []
        pictures = []
        for filename, file in relayed:
            if file.blob_id:
                lines.append(f"{filename} → {file.blob_id}")
            else:
                lines.append(f"{filename} → not saved ({file.error or 'unknown'})")
            if file.data and file.content_type in ALLOWED_CONTENT_TYPES:
                pictures.append(_image_part(file.data, file.content_type))
        return _user_input([
            _text_part(RELAYED_FILES_CAPTION + "\n\n" + "\n".join(lines)),
            *pictures,
        ])

    # ---- failures ----------------------------------------------------------

    def classify(
        self, status_code: int | None, body: dict | None, message: str | None = None
    ) -> RetryDecision:
        """Whether a failed open is worth retrying.

        `status_code=None` is the in-stream `error` event, which has no status
        line at all — delegated to `retry.classify`, which already owns exactly
        that case and reads the body's `code`, its `type` and the message to
        answer it. Widened past the protocol's `int` rather than given a sentinel:
        a made-up status code is a number someone will later read as one the
        provider sent.

        The 429 branch is this family's own, and it is the one place the shared
        rules are not enough. `retry.classify` separates a rate limit from a spent
        account by the provider's error *code*, and Gemini gives the same code —
        `RESOURCE_EXHAUSTED` — to a one-second burst and to a day's quota. So the
        evidence has to come out of the message and the `QuotaFailure` details
        instead; see `QUOTA_EXHAUSTION_PHRASES`.

        Reason strings stay specific because they are logged, and a log line that
        says only "not retryable" is a line nobody can act on.

        Unreached in production today, and worth saying so plainly:
        `loop._open_round` catches `openai.APIStatusError`, which the Gemini SDK
        never raises, so a refused Gemini open currently raises past the loop
        and is recorded final by `app.api.turn`. Widening that `except` is what
        makes this method live.
        """
        if status_code is None:
            return retry.classify(None, body, message)
        if status_code == 429:
            if _reads_as_spent_quota(body):
                return RetryDecision(
                    False, "429 names a spent quota rather than a burst limit"
                )
            return RetryDecision(True, "rate limited")
        if 500 <= status_code < 600:
            return RetryDecision(True, f"server error {status_code}")
        return RetryDecision(False, f"status {status_code} is not retryable")


@dataclass
class _Step:
    """What one step of the current round announced about itself.

    `arguments` is the accumulation `step.stop` cannot supply. `kind` is what
    decides whether a stop completes a tool call or closes a thought.
    """

    kind: str
    call_id: str = ""
    name: str = ""
    arguments: str = ""


@dataclass
class _Image:
    """One picture a hosted script produced, already decoded."""

    step: int
    data: bytes
    mime_type: str


@dataclass
class _Round:
    """Everything one round's terminal event does not carry.

    Emptied by `build_round` and again by `interaction.created`, and held for no
    longer than the round: the calls and the files are copied out on `Completed`,
    so nothing here outlives the answer it was collected for.
    """

    interaction_id: str = ""
    steps: dict[int, _Step] = field(default_factory=dict)
    calls: list[ToolCall] = field(default_factory=list)
    images: list[_Image] = field(default_factory=list)


def _sdk_kwargs(payload: dict) -> dict:
    """One round's payload as the SDK's keyword arguments.

    Exists for one field. `loop._closing_round` sets `tool_choice` at the *top*
    level of the payload, which is where the Responses API takes it — and on this
    API it lives inside `generation_config`, so passed through untouched it would
    be a keyword the request type does not declare and the round it is meant to
    fix would fail on its own request. The closing round is bought precisely when
    a turn is about to end in silence, so it is the last round that can afford to
    be the broken one.

    The payload is copied rather than edited. `run_turn` records the first round's
    payload verbatim as the turn's request envelope, and a recorded call should
    say what was built rather than what the transport did with it afterwards.
    """
    kwargs = dict(payload)
    tool_choice = kwargs.pop("tool_choice", None)
    if tool_choice is not None:
        config = dict(kwargs.get("generation_config") or {})
        config["tool_choice"] = tool_choice
        kwargs["generation_config"] = config
    return kwargs


def _split_system(outbox: list[dict]) -> tuple[str, list[dict]]:
    """The outbox as `(system_instruction, input steps)`.

    Two jobs, one pass. The system item comes out of `input` and becomes the
    top-level instruction — see `build_round` for what leaving it in would cost —
    and every remaining item is translated into this API's own vocabulary.

    Joined with a blank line if there were somehow two system items.
    `assemble_context` builds exactly one, but silently keeping the last of them
    would be a prompt half of which vanished.
    """
    instructions: list[str] = []
    items: list[dict] = []
    for item in outbox:
        if not isinstance(item, dict):
            continue
        if item.get("role") == "system":
            text = _item_text(item)
            if text:
                instructions.append(text)
            continue
        items.append(_input_item(item))
    return "\n\n".join(instructions), items


def _item_text(item: dict) -> str:
    """Every text part of one item, concatenated."""
    content = item.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        part.get("text") or ""
        for part in content
        if isinstance(part, dict) and part.get("type") in ("input_text", "text")
    )


def _input_item(item: dict) -> dict:
    """One outbox item as an input step.

    Two kinds of item arrive here and only one needs work. The items this provider
    built itself — a `function_result`, a `user_input` — already carry a `type`
    from this API's vocabulary and pass through untouched, which is what lets a
    later round's outbox mix the answers to a run of calls with the pictures those
    answers wanted to show. The items `assemble_context` built are in the
    Responses API's vocabulary, roles and `input_text` and all, because that is
    the one prompt builder both families share; those are translated.

    A role other than `system` becomes `user_input`. The only one
    `assemble_context` ever writes is `user`, and a model turn is never resent —
    `previous_interaction_id` carries the model's own side, which is the whole
    reason later rounds send tool results and nothing else.
    """
    if item.get("type") is not None:
        return item
    content = item.get("content")
    if isinstance(content, str):
        return _user_input([_text_part(content)])
    parts = [
        translated
        for part in (content or [])
        if isinstance(part, dict)
        for translated in (_content_part(part),)
        if translated is not None
    ]
    return _user_input(parts)


def _content_part(part: dict) -> dict | None:
    """One content part, in this API's vocabulary.

    `input_text` → `text`, `input_image` → `image` with the data URL taken apart,
    `input_file` → `document` with the same split. Parts already in this
    vocabulary pass through, so an item this provider built and an item the shared
    prompt builder built can sit in one list.

    `prompt_cache_breakpoint` is dropped rather than translated. It is how the
    other family is told where the reusable prefix ends; implicit caching here
    routes on the prefix by itself and has no field to be told anything, so
    carrying the key across would be an unknown field on every request.

    `None` for a part that cannot be expressed — an image whose data URL will not
    split. Dropped rather than sent empty, for the reason `_split_data_url` gives.
    """
    kind = part.get("type")

    if kind in ("text", "image", "document", "audio", "video"):
        return part

    if kind == "input_text":
        return _text_part(part.get("text") or "")

    if kind == "input_image":
        media_type, data = _split_data_url(part.get("image_url"))
        if not data:
            logger.warning("dropping an image part with no usable data URL")
            return None
        translated = {"type": "image", "mime_type": media_type, "data": data}
        resolution = DETAIL_TO_RESOLUTION.get(part.get("detail") or "")
        if resolution:
            translated["resolution"] = resolution
        return translated

    if kind == "input_file":
        media_type, data = _split_data_url(part.get("file_data"))
        if not data:
            logger.warning("dropping a file part with no usable data URL")
            return None
        return {"type": "document", "mime_type": media_type, "data": data}

    logger.warning("dropping an unrecognised content part | type=%s", kind)
    return None


def _thought_text(delta: dict) -> str:
    """The prose out of a `thought_summary` delta.

    `content` is a single object rather than the list a reader of this API's other
    content fields would expect — recorded, not assumed. The list branch is here
    because that asymmetry is the kind of thing a provider quietly fixes, and a
    reasoning ribbon that goes blank on the day they do would be a mystery.
    """
    content = delta.get("content")
    if isinstance(content, dict):
        return content.get("text") or ""
    if isinstance(content, list):
        return "".join(
            part.get("text") or "" for part in content if isinstance(part, dict)
        )
    return ""


def _reads_as_spent_quota(body: dict | None) -> bool:
    """Whether a 429's body says the allowance is gone rather than momentarily hot.

    Reads the message and the `details` array, because the useful half is usually
    a `QuotaFailure` violation's `quotaId` rather than the sentence. Serialised
    with `json.dumps` rather than walked field by field: the details are a list of
    open-ended `google.rpc` types whose shape varies by failure, and a walk that
    guessed the nesting wrong would find nothing while looking like it had
    checked.

    Spaces, underscores and hyphens come out before the match, so `PerDay`,
    `per day` and `per_day` are one phrase rather than three — see
    `QUOTA_EXHAUSTION_PHRASES`.
    """
    if not isinstance(body, dict):
        return False
    error = body.get("error", body)
    if not isinstance(error, dict):
        return False
    text = str(error.get("message") or "")
    details = error.get("details")
    if details is not None:
        try:
            text += " " + json.dumps(details, default=str)
        except (TypeError, ValueError):
            text += " " + str(details)
    squashed = text.lower().replace(" ", "").replace("_", "").replace("-", "")
    return any(phrase in squashed for phrase in QUOTA_EXHAUSTION_PHRASES)
