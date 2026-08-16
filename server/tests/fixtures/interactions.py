"""Recorded Gemini Interactions API streams, as `fixtures/sse.py` is for the
Responses API.

**These are recordings, not inventions.** The event *names* are documented; the
JSON keys inside a `step.delta` are not, so every shape below came off the wire
from a real call made by `scripts/record_interaction.py`. Recorded on
2026-08-16 against `gemini-3.5-flash-lite`, with `google-genai` 2.18.1 — the
date and the model are here for the reason `MODEL_PRICES_PER_1M` carries its
verification date: a shape verified once is a shape verified on a day.

Flash-Lite for every fixture, including the board one. The plan allowed falling
back to `gemini-3.7-flash` if Flash-Lite would not draw; it drew on the first
attempt, so nothing here is recorded on Flash. The wire shape is the same
across Gemini 3.x either way — what varies by model is which tool the model
picks, not how the provider frames it.

**Two arguments were replaced by hand, and that is deliberate.** The
`update_board` and `set_workspace` arguments below are imported from
`fixtures/sse.py` rather than kept as recorded. What needed recording was the
wire shape, not the model's choice of triangle: a cross-provider parity test can
only assert that two providers reach the same tool call if the fixtures carry
the same arguments. The recorded Flash-Lite call drew a labelled right triangle
with an `angle_marker`; the shape of the events around it is untouched.

**Every fixture is reproducible from the committed script.** The exact commands,
so nobody has to guess how a shape was obtained:

    # TEXT_ONLY_INTERACTION
    uv run python -m scripts.record_interaction "what is 7 times 8"
    # TOOL_CALL_INTERACTION — round one only
    uv run python -m scripts.record_interaction "Set up a study plan for adding
        fractions with unlike denominators, with a first exercise. Use
        set_workspace. Do not draw."
    # BOARD_UPDATE_INTERACTION
    uv run python -m scripts.record_interaction "draw a right triangle on the board"
    # CODE_EXECUTION_INTERACTION
    uv run python -m scripts.record_interaction "Use code execution with
        matplotlib to plot y = x squared and show me the resulting image. Do not
        use update_board."
    # GROUNDED_SEARCH_INTERACTION
    uv run python -m scripts.record_interaction "Search the web for who won the
        2026 Fields Medal, then tell me. Do not draw anything."
    # TOOL_CALL_FOLLOW_UP — the second round of the set_workspace turn
    uv run python -m scripts.record_interaction "<the set_workspace prompt>" \
        --answer '{"ok": true}'
    # FAILED_INTERACTION — the same, answered under the wrong tool name
    uv run python -m scripts.record_interaction "<the set_workspace prompt>" \
        --answer '{"ok": true}' --answer-as update_board

The last two need `--answer`, which records round one and then chains a
`function_result` on `previous_interaction_id`. They were first recorded through
an ad hoc script, before `--answer` existed; the flag was added so the claim
"recorded, not guessed" is checkable for all seven, and both were then
re-recorded through it unchanged.

The "Do not draw" clauses are not decoration. With the whole of
`TOOL_DEFINITIONS` in scope, Flash-Lite reaches for `update_board` on the
code-execution and search prompts unprompted, and these fixtures want each
tool's wire shape rather than the model's unsteered tool choice.

Trimmed, never reshaped. Each tuple keeps every event *type* that appeared in
its recording, including the four this service does not read
(`interaction.status_update`, `thought_signature`, `text_annotation_delta`,
`google_search_result`) — the heartbeat fires on those, so a fixture without
them under-tests it. What is cut is repetition: forty argument deltas become
two, and the opaque `thought_signature` and `search_suggestions` blobs are
shortened to a marker length. The 56KB base64 PNG of the real plot becomes a
real 1×1 PNG, so it still decodes.

Six shapes here contradict what a reader of the Responses API would expect, and
Task 5 depends on all six:

1. **`interaction.completed` carries no output.** OpenAI's `response.completed`
   repeats the whole `output` array; Gemini's carries `id`, `status`, `model`
   and `usage` and nothing else. The `steps` field exists on the type and is
   absent from the stream. So a provider cannot read the finished tool calls,
   the finished text or the produced images off the terminal event — it has to
   accumulate all of them from the deltas.
2. **`step.stop` carries only `index`.** No name, no accumulated arguments, no
   step body. `ToolArgsDone` has to come from the provider's own accumulator,
   keyed on the index that `step.start` announced.
3. **Two different fields are called `arguments`, and only one is a string.**
   `ArgumentsDelta.arguments` (a `function_call` step) is incremental JSON
   *text*. `CodeExecutionCallDelta.arguments` and
   `GoogleSearchCallDelta.arguments` are already-parsed *dicts*. And
   `FunctionCallStep.arguments` on `step.start` is an empty dict, not an empty
   string.
4. **`thought_signature` is not a thought summary.** A `thought` step emits
   both: `thought_summary` deltas carry prose under `delta.content.text` (a
   single object, not a list), and a `thought_signature` delta carries an
   opaque base64 blob under `delta.signature`. Surfacing the second as a
   `ThoughtDelta` would put base64 in the learner's activity trail. At
   `thinking_level: "low"` a turn often emits the signature and no summary at
   all — `TEXT_ONLY_INTERACTION` is such a turn.
5. **A produced image is a `model_output` step, not a code-execution result.**
   The `code_execution_result` delta of a plotting script has `result: ""`; the
   PNG arrives as a separate `image` delta (`data` base64, `mime_type`) in a
   later `model_output` step, with no id and no filename anywhere. The model
   then writes a `sandbox:/plot.png` markdown link in its text, which is the
   only name the file ever gets. There is no `container_file_citation`
   equivalent, so a `ProducedFile` can only be keyed on the step index.
6. **`usage.grounding_tool_count` is a list, not a count.** It arrives as
   `[{"count": 2, "type": "google_search"}]`, and it is absent entirely when
   nothing searched.

One more thing the SDK hides: the raw `usage` JSON also carries
`raw_prompt_token`, which `google.genai`'s `Usage` model drops. It is not in
these fixtures because the provider never sees it.
"""

import json

from tests.fixtures.sse import BOARD_UPDATE_ARGUMENTS, WORKSPACE_ARGUMENTS

__all__ = [
    "BOARD_UPDATE_INTERACTION",
    "CODE_EXECUTION_INTERACTION",
    "FAILED_INTERACTION",
    "GROUNDED_SEARCH_INTERACTION",
    "INLINE_IMAGE_BASE64",
    "TEXT_ONLY_INTERACTION",
    "TOOL_CALL_FOLLOW_UP",
    "TOOL_CALL_INTERACTION",
    "interaction_stream",
]


def interaction_stream(*events: dict) -> bytes:
    """Encode events as the wire bytes the Interactions API actually sends.

    Copied from a real response body, not inferred: every record is an
    `event:` line naming the `event_type`, a `data:` line of compact JSON, and
    a blank line, and the stream closes with an `event: done` record whose data
    is the `[DONE]` sentinel the SDK's decoder watches for.

    The `event:` line is decorative for this SDK — `_parse_event` publishes on
    a `data:` line alone and the wrapper type declares only `data` — but the
    server sends it, so a fixture that omitted it would be testing a stream no
    server produces.
    """
    records = []
    for event in events:
        records.append(f"event: {event['event_type']}\n")
        records.append(f"data: {json.dumps(event, separators=(',', ':'))}\n")
        records.append("\n")
    records.append("event: done\n")
    records.append("data: [DONE]\n")
    records.append("\n")
    return "".join(records).encode()


#: Interaction ids are long opaque base64 and every event of a turn repeats
#: one, so each fixture uses a short stand-in. The provider only ever passes it
#: back as `previous_interaction_id`, so its length carries no meaning.
TEXT_ONLY_ID = "v1_text_only"
WORKSPACE_ID = "v1_workspace"
FOLLOW_UP_ID = "v1_workspace_2"
BOARD_ID = "v1_board"
CODE_ID = "v1_code"
SEARCH_ID = "v1_search"
FAILED_ID = "v1_failed"

#: A real `thought_signature`, shortened. The full blob is 128 characters on a
#: short turn and over 2,700 on a turn that reasons about the board. Nothing
#: reads it — it is kept only so a translator that mistakes it for a thought
#: summary is caught putting base64 in the activity trail.
THOUGHT_SIGNATURE = "El4KXAERTTIPSL6XYzev8BdWCLqazJYLHmSgIex5xdsMfdyObe02CzZu"

#: A real 1×1 PNG, standing in for the 56KB plot the recorded turn produced.
#: Real base64 rather than a placeholder string because `Completed.files` hands
#: back decoded bytes, and a fixture that does not decode would let a decoder
#: that never runs pass.
INLINE_IMAGE_BASE64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "/58BAwAI/AL+26JNFgAAAABJRU5ErkJggg=="
)


def _created(interaction_id: str) -> dict:
    return {
        "interaction": {
            "id": interaction_id,
            "status": "in_progress",
            "object": "interaction",
            "model": "gemini-3.5-flash-lite",
        },
        "event_type": "interaction.created",
    }


def _status_update(interaction_id: str) -> dict:
    """The event the plan's mapping table has no row for.

    It arrives immediately after `interaction.created` on every single turn
    recorded, saying `in_progress` — which `interaction.created` already said.
    Nothing reads it and nothing should, but it is in every fixture because it
    is in every stream: this is the event a heartbeat sees most often.
    """
    return {
        "interaction_id": interaction_id,
        "status": "in_progress",
        "event_type": "interaction.status_update",
    }


def _completed(interaction_id: str, status: str, usage: dict) -> dict:
    """No `steps`, no `output`. See the module docstring, point 1."""
    return {
        "interaction": {
            "id": interaction_id,
            "status": status,
            "object": "interaction",
            "model": "gemini-3.5-flash-lite",
            "created": "2026-08-16T02:03:54Z",
            "updated": "2026-08-16T02:03:54Z",
            "service_tier": "standard",
            "usage": usage,
        },
        "event_type": "interaction.completed",
    }


# A turn that only writes. Note what a `thought` step looks like when the model
# does not narrate: one `thought_signature` delta and no `thought_summary` at
# all, so a translator that expects prose from every thought step finds none.
TEXT_ONLY_INTERACTION = (
    _created(TEXT_ONLY_ID),
    _status_update(TEXT_ONLY_ID),
    {"index": 0, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 0,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 0, "event_type": "step.stop"},
    {"index": 1, "step": {"type": "model_output"}, "event_type": "step.start"},
    {"index": 1, "delta": {"text": "7", "type": "text"}, "event_type": "step.delta"},
    {
        "index": 1,
        "delta": {"text": " times 8 is 56.", "type": "text"},
        "event_type": "step.delta",
    },
    # No "text done" event exists. `step.stop` closes the step and carries
    # nothing, so the accumulated text is the provider's to hold.
    {"index": 1, "event_type": "step.stop"},
    _completed(TEXT_ONLY_ID, "completed", {
        "input_tokens_by_modality": [{"modality": "text", "tokens": 10101}],
        "total_cached_tokens": 0,
        "total_input_tokens": 10101,
        "total_output_tokens": 9,
        "total_thought_tokens": 0,
        "total_tokens": 10110,
        "total_tool_use_tokens": 0,
    }),
)


#: The recorded `set_workspace` arguments, split at a point that is not a JSON
#: boundary. Two deltas rather than the one the recording actually sent: the
#: real call arrived whole, and a fixture that also arrives whole would let a
#: provider that never accumulates pass. Splitting mid-key is the case that
#: matters — a provider that parses each delta on its own breaks here.
_WORKSPACE_JSON = json.dumps(WORKSPACE_ARGUMENTS)
WORKSPACE_ARGUMENT_DELTAS = (
    _WORKSPACE_JSON[:40],
    _WORKSPACE_JSON[40:],
)


# A turn that calls one function and stops. Two things to read off it: the
# interaction ends `requires_action` rather than `completed`, and `step.start`
# announces the call's `id` and `name` while its `arguments` is an empty *dict*.
TOOL_CALL_INTERACTION = (
    _created(WORKSPACE_ID),
    _status_update(WORKSPACE_ID),
    {"index": 0, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 0,
        "delta": {
            # `content` is one object, not a list of them.
            "content": {
                "text": "**Initiating Planning: Fractions**\n\nI'm starting to "
                        "build a plan for unlike denominators.\n\n\n",
                "type": "text",
            },
            "type": "thought_summary",
        },
        "event_type": "step.delta",
    },
    {
        "index": 0,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 0, "event_type": "step.stop"},
    {
        "index": 1,
        "step": {
            "arguments": {},
            "id": "call_1042187",
            "name": "set_workspace",
            "type": "function_call",
        },
        "event_type": "step.start",
    },
    {
        "index": 1,
        "delta": {
            "arguments": WORKSPACE_ARGUMENT_DELTAS[0],
            "type": "arguments_delta",
        },
        "event_type": "step.delta",
    },
    {
        "index": 1,
        "delta": {
            "arguments": WORKSPACE_ARGUMENT_DELTAS[1],
            "type": "arguments_delta",
        },
        "event_type": "step.delta",
    },
    # Nothing but the index. Whatever `ToolArgsDone` carries, it came from the
    # provider, not from here.
    {"index": 1, "event_type": "step.stop"},
    _completed(WORKSPACE_ID, "requires_action", {
        "input_tokens_by_modality": [{"modality": "text", "tokens": 10706}],
        "total_cached_tokens": 0,
        "total_input_tokens": 10706,
        "total_output_tokens": 242,
        "total_thought_tokens": 385,
        "total_tokens": 11333,
        "total_tool_use_tokens": 0,
    }),
)


# What the model writes once the tool call has been answered — the second leg of
# the turn, and the only leg the learner reads. A *new* interaction, chained by
# `previous_interaction_id`, so it opens with its own `interaction.created` and
# its own id. The `function_result` input step that provokes it is never echoed
# back as an event.
#
# Recorded through `record_interaction.py --answer`, and worth recording for one
# reason the events do not show: the round fails with
# `error.code == "invalid_request"` if the `function_result`'s `name` names a
# different tool than the call it answers. That is a 400, not a mismatch the
# provider forgives, and `--answer-as` exists to provoke it — see
# `FAILED_INTERACTION`.
TOOL_CALL_FOLLOW_UP = (
    _created(FOLLOW_UP_ID),
    _status_update(FOLLOW_UP_ID),
    {"index": 0, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 0,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 0, "event_type": "step.stop"},
    {"index": 1, "step": {"type": "model_output"}, "event_type": "step.start"},
    {
        "index": 1,
        "delta": {"text": "Here is your plan.", "type": "text"},
        "event_type": "step.delta",
    },
    {"index": 1, "event_type": "step.stop"},
    _completed(FOLLOW_UP_ID, "completed", {
        "input_tokens_by_modality": [{"modality": "text", "tokens": 12093}],
        "total_cached_tokens": 0,
        "total_input_tokens": 12093,
        "total_output_tokens": 51,
        "total_thought_tokens": 0,
        "total_tokens": 12144,
        "total_tool_use_tokens": 0,
    }),
)


#: The same split, over the same arguments `BOARD_UPDATE_TURN` uses. Imported
#: rather than copied so the two can never drift: a cross-provider parity test
#: asserting both families reach the same board is only meaningful while both
#: fixtures name the same board.
_BOARD_JSON = json.dumps(BOARD_UPDATE_ARGUMENTS)
BOARD_ARGUMENT_DELTAS = (
    _BOARD_JSON[:22],
    _BOARD_JSON[22:],
)


# The same turn as `BOARD_UPDATE_TURN` in `fixtures/sse.py`: one `update_board`
# call, the arrow and its label, ending in `requires_action`. Recorded on
# Flash-Lite, which drew a labelled right triangle instead; the arguments are
# `sse.py`'s and the events around them are the recording's.
BOARD_UPDATE_INTERACTION = (
    _created(BOARD_ID),
    _status_update(BOARD_ID),
    {"index": 0, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 0,
        "delta": {
            "content": {
                "text": "**Initiating the Diagram**\n\nI'll upsert the vector and "
                        "its label.\n\n\n",
                "type": "text",
            },
            "type": "thought_summary",
        },
        "event_type": "step.delta",
    },
    {
        "index": 0,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 0, "event_type": "step.stop"},
    {
        "index": 1,
        "step": {
            "arguments": {},
            "id": "call_937729",
            "name": "update_board",
            "type": "function_call",
        },
        "event_type": "step.start",
    },
    {
        "index": 1,
        "delta": {"arguments": BOARD_ARGUMENT_DELTAS[0], "type": "arguments_delta"},
        "event_type": "step.delta",
    },
    {
        "index": 1,
        "delta": {"arguments": BOARD_ARGUMENT_DELTAS[1], "type": "arguments_delta"},
        "event_type": "step.delta",
    },
    {"index": 1, "event_type": "step.stop"},
    _completed(BOARD_ID, "requires_action", {
        "input_tokens_by_modality": [{"modality": "text", "tokens": 10687}],
        "total_cached_tokens": 0,
        "total_input_tokens": 10687,
        "total_output_tokens": 534,
        "total_thought_tokens": 578,
        "total_tokens": 11799,
        "total_tool_use_tokens": 0,
    }),
)


CODE_EXECUTION_CODE = (
    "import matplotlib.pyplot as plt\n"
    "import numpy as np\n"
    "\n"
    "x = np.linspace(-10, 10, 400)\n"
    "y = x**2\n"
    "plt.plot(x, y)\n"
    "plt.savefig('plot.png', bbox_inches='tight')\n"
)


# A hosted `code_execution` round, as the provider actually streams one.
#
# The three shapes that matter are all here and none of them exists on the
# OpenAI side. First, the hosted call is a step of its own and the provider runs
# it inline, so the interaction ends `completed` with no tool call to answer —
# five steps in one response. Second, the call's `arguments` delta is a parsed
# dict, not the JSON text a `function_call` sends. Third, the PNG the script
# wrote is *not* in the `code_execution_result` step, whose `result` is the
# empty string: it is an `image` delta in a later `model_output` step, with no
# id and no filename, and the only name it ever gets is the `sandbox:/plot.png`
# link the model writes into its prose. A fixture that put the image in the
# result step would let a `Completed.files` that never fires pass.
CODE_EXECUTION_INTERACTION = (
    _created(CODE_ID),
    _status_update(CODE_ID),
    {"index": 0, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 0,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 0, "event_type": "step.stop"},
    {
        "index": 1,
        "step": {
            "arguments": {},
            "id": "call_1006863",
            # Present and empty on every hosted step recorded. A `function_call`
            # step has no `signature` field at all.
            "signature": "",
            "type": "code_execution_call",
        },
        "event_type": "step.start",
    },
    {
        "index": 1,
        "delta": {
            "arguments": {"code": CODE_EXECUTION_CODE, "language": "python"},
            "type": "code_execution_call",
        },
        "event_type": "step.delta",
    },
    {"index": 1, "event_type": "step.stop"},
    {
        "index": 2,
        "step": {
            "call_id": "call_1006863",
            "result": None,
            "signature": "",
            "type": "code_execution_result",
        },
        "event_type": "step.start",
    },
    {
        "index": 2,
        # Empty, because the script's only output was the file.
        "delta": {"result": "", "is_error": False, "type": "code_execution_result"},
        "event_type": "step.delta",
    },
    {"index": 2, "event_type": "step.stop"},
    {"index": 3, "step": {"type": "model_output"}, "event_type": "step.start"},
    {
        "index": 3,
        "delta": {
            "data": INLINE_IMAGE_BASE64,
            "mime_type": "image/png",
            "type": "image",
        },
        "event_type": "step.delta",
    },
    {"index": 3, "event_type": "step.stop"},
    # A second thought step, after the tool ran. Steps are not one-per-kind.
    {"index": 4, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 4,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 4, "event_type": "step.stop"},
    {"index": 5, "step": {"type": "model_output"}, "event_type": "step.start"},
    {
        "index": 5,
        "delta": {"text": "Here is the plot of $y = x^2$:\n\n!", "type": "text"},
        "event_type": "step.delta",
    },
    {
        "index": 5,
        "delta": {"text": "[Plot of y = x^2](sandbox:/plot.png)", "type": "text"},
        "event_type": "step.delta",
    },
    {"index": 5, "event_type": "step.stop"},
    _completed(CODE_ID, "completed", {
        "input_tokens_by_modality": [{"modality": "text", "tokens": 10705}],
        # Two modalities, because the image the script produced was fed back to
        # the model. `total_tool_use_tokens` is their sum and the documentation
        # calls these intermediate tokens already counted elsewhere, which is
        # why the price table records them and does not charge them.
        "tool_use_tokens_by_modality": [
            {"modality": "text", "tokens": 7245},
            {"modality": "image", "tokens": 1089},
        ],
        "total_cached_tokens": 0,
        "total_input_tokens": 10705,
        "total_output_tokens": 243,
        "total_thought_tokens": 0,
        "total_tokens": 19282,
        "total_tool_use_tokens": 8334,
    }),
)


#: The real `search_suggestions` payload is 2.5KB of Google-branded HTML and
#: CSS that has to be displayed verbatim to comply with the grounding terms.
#: Nothing in this service displays it, so the fixture keeps a marker: what the
#: tests need is that `result` is a *list of dicts* whose only key is this one.
SEARCH_SUGGESTIONS_HTML = '<style>.container { }</style><div class="container">…</div>'


# A grounded round: `google_search` is a hosted tool, so the provider runs it and
# the interaction ends `completed`. Four things here exist nowhere else.
#
# `usage.grounding_tool_count` is a list of `{count, type}` objects, not an
# integer — this is the number `turn_cost_usd` multiplies by `per_search`, and a
# provider that read it as an int would price a grounded turn at zero. The
# `google_search_call` delta carries its own `signature` beside its `arguments`
# dict. The result step's `result` is a list, not a string. And the model's text
# is followed by a `text_annotation_delta` carrying `url_citation` annotations
# against character ranges of text already streamed — an event type this service
# does not read, and the reason the citation URLs below are Google's redirector
# rather than the sites themselves.
GROUNDED_SEARCH_INTERACTION = (
    _created(SEARCH_ID),
    _status_update(SEARCH_ID),
    {
        "index": 0,
        "step": {
            "arguments": {},
            "id": "call_819402",
            "signature": "",
            "type": "google_search_call",
        },
        "event_type": "step.start",
    },
    {
        "index": 0,
        "delta": {
            "arguments": {"queries": ["Fields Medal 2026", "2026 Fields Medal winners"]},
            "signature": THOUGHT_SIGNATURE,
            "type": "google_search_call",
        },
        "event_type": "step.delta",
    },
    {"index": 0, "event_type": "step.stop"},
    {
        "index": 1,
        "step": {
            "call_id": "call_819402",
            "result": None,
            "signature": "",
            "type": "google_search_result",
        },
        "event_type": "step.start",
    },
    {
        "index": 1,
        "delta": {
            "result": [{"search_suggestions": SEARCH_SUGGESTIONS_HTML}],
            "type": "google_search_result",
        },
        "event_type": "step.delta",
    },
    {"index": 1, "event_type": "step.stop"},
    {"index": 2, "step": {"type": "thought"}, "event_type": "step.start"},
    {
        "index": 2,
        "delta": {"signature": THOUGHT_SIGNATURE, "type": "thought_signature"},
        "event_type": "step.delta",
    },
    {"index": 2, "event_type": "step.stop"},
    {"index": 3, "step": {"type": "model_output"}, "event_type": "step.start"},
    {
        "index": 3,
        "delta": {"text": "The ", "type": "text"},
        "event_type": "step.delta",
    },
    {
        "index": 3,
        "delta": {
            "text": "2026 Fields Medalists were announced on July 23, 2026.",
            "type": "text",
        },
        "event_type": "step.delta",
    },
    {
        "index": 3,
        "delta": {
            "annotations": [{
                "end_index": 58,
                "start_index": 0,
                "title": "mathunion.org",
                "type": "url_citation",
                "url": "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQE",
            }],
            "type": "text_annotation_delta",
        },
        "event_type": "step.delta",
    },
    {"index": 3, "event_type": "step.stop"},
    _completed(SEARCH_ID, "completed", {
        "grounding_tool_count": [{"count": 2, "type": "google_search"}],
        "input_tokens_by_modality": [{"modality": "text", "tokens": 10704}],
        "total_cached_tokens": 0,
        "total_input_tokens": 10704,
        "total_output_tokens": 116,
        "total_thought_tokens": 0,
        "total_tokens": 10820,
        "total_tool_use_tokens": 0,
    }),
)


# A failure, recorded rather than invented: this is what a rejected round
# actually streams. The interaction opens normally, says `in_progress`, and then
# an `error` event ends the stream — there is no `interaction.completed` with a
# `failed` status, and no HTTP error either, because the 200 was already sent.
# So `classify` cannot see a status code here: the whole signal is
# `error.code`, and `Failed` has to come off this event.
#
# Provoked by `record_interaction.py --answer-as <a tool that was not called>`,
# which is a rejection this service can cause on purpose. The alternative was
# waiting for a real quota exhaustion or a real outage to record one.
FAILED_INTERACTION = (
    _created(FAILED_ID),
    _status_update(FAILED_ID),
    {
        "error": {
            "code": "invalid_request",
            "message": "Request contains an invalid argument.",
        },
        "event_type": "error",
    },
)
