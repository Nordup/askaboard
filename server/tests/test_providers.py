"""The seam both model families are reached through.

What this file asserts about each provider is conformance: that it satisfies the
protocol every caller writes against, that it names itself, and that the wiring
the seam owns — the download bound behind `ProducedFile.read`, the input items a
tool answer travels in — really reaches the provider.

The Gemini half is longer than the OpenAI half for one reason, and it is the
reason to read the provider's module docstring first: `interaction.completed`
carries no output and no steps, so every tool call and every produced image is
accumulated from the deltas across a whole stream. `run_turn` decides whether to
buy another round by asking whether `Completed.calls` is empty, so an accumulator
that drops a call ends a turn in silence and one that keeps a stale call bills
the learner for a round that does nothing. Both of those are tested here, against
streams recorded off real turns rather than written from the documentation.

The cross-provider parity test this file exists for is at the bottom:
`test_a_board_update_turn_produces_the_same_shape_on_both_providers` drives one
recorded turn through each family and compares what the device is left holding,
so that a change making one family behave differently from the other fails here
rather than on a board. It is the test to keep if any other in this file is ever
dropped. `test_a_board_update_reaches_the_same_board_as_the_openai_fixture` came
first and stays beside it: its subject is the Gemini accumulator's arguments
string, which the parity test never looks at directly.
"""

import asyncio
import base64
import json

import respx
from httpx import Response
from openai import AsyncOpenAI
from pydantic import TypeAdapter

from app.pricing import turn_cost_usd
from app.tutor.events import (
    CODE_INTERPRETER, BoardUpdateEvent, EventTranslator, ReasoningDeltaEvent,
    StatusEvent, TextDeltaEvent,
)
from app.tutor.fetch_image import ALLOWED_CONTENT_TYPES
from app.tutor.providers import (
    TERMINAL_ERROR_STATUSES, Completed, Created, Failed, HostedToolActivity,
    HostedToolStarted, Provider, RelayedFile, TextDelta, ThoughtDelta,
    ToolArgsDelta, ToolArgsDone, ToolCallStarted, relayed_content_type,
)
from app.tutor.providers.gemini import (
    EFFORT_TO_THINKING_LEVEL, GEMINI_TOOLS, GeminiProvider, map_usage,
)
from app.tutor.providers.openai import OpenAIProvider
from tests.fixtures.interactions import (
    BOARD_UPDATE_INTERACTION, CODE_EXECUTION_INTERACTION, FAILED_INTERACTION,
    GROUNDED_SEARCH_INTERACTION, INLINE_IMAGE_BASE64, TEXT_ONLY_INTERACTION,
    TOOL_CALL_FOLLOW_UP, TOOL_CALL_INTERACTION,
)
from tests.fixtures.sse import (
    BOARD_UPDATE_ARGUMENTS, BOARD_UPDATE_TURN, CODE_INTERPRETER_TURN, CONTAINER_ID,
    SCRIPT_FILE_ID, SCRIPT_FILENAME, WORKSPACE_ARGUMENTS,
)


def test_requires_action_is_not_a_terminal_error():
    """It is how a normal tool round ends. Treating it as a failure would
    break every turn that calls a tool, which is most of them."""
    assert "requires_action" not in TERMINAL_ERROR_STATUSES


def test_the_openai_provider_satisfies_the_protocol():
    assert isinstance(OpenAIProvider(client=None), Provider)


def test_the_openai_provider_names_itself():
    assert OpenAIProvider(client=None).name == "openai"


@respx.mock
async def test_a_produced_files_read_downloads_the_file_it_names():
    """The one piece of production wiring this seam added, and the one nothing
    else covers.

    `run_turn` no longer knows what a container is: it hands the injected relay a
    `ProducedFile`, and `app.api.turn`'s closure calls `read()` on it. Every relay
    stub in `test_loop.py` answers without reading, and the
    `download_container_file` tests call that function directly with ids of their
    own — so the `partial` bound here is the only thing that says which file the
    bytes come from, and a swapped or dropped argument would break every chart
    relay in production with the suite still green.

    Asserted through the URL as well as the bytes, because that is where a
    swapped `container_id`/`file_id` shows up: both are strings and either order
    downloads *something*.
    """
    route = respx.get(
        f"https://api.openai.com/v1/containers/{CONTAINER_ID}"
        f"/files/{SCRIPT_FILE_ID}/content"
    ).mock(return_value=Response(200, content=b"\x89PNG-bytes"))
    provider = OpenAIProvider(client=AsyncOpenAI(api_key="sk-test"))

    completed = provider.neutral(CODE_INTERPRETER_TURN[-1])

    assert isinstance(completed, Completed)
    file, = completed.files
    assert file.key == (CONTAINER_ID, SCRIPT_FILE_ID)
    assert file.filename == SCRIPT_FILENAME

    assert await file.read() == b"\x89PNG-bytes"
    assert route.call_count == 1


def test_a_completion_with_no_script_output_produces_no_files():
    """The other half of the pairing: a turn that ran no script has nothing to
    relay, and a `ProducedFile` invented for it would buy a round to hand over a
    file that does not exist."""
    completed = OpenAIProvider(client=None).neutral({
        "type": "response.completed",
        "response": {"id": "resp_1", "usage": {"input_tokens": 1},
                     "output": [{"type": "message", "content": [
                         {"type": "output_text", "text": "no plot here"}]}]},
    })

    assert isinstance(completed, Completed)
    assert completed.files == []
    assert completed.calls == []
    assert completed.status == "completed"
    assert completed.response_id == "resp_1"


# --------------------------------------------------------------------------
# Gemini
# --------------------------------------------------------------------------


def _normalise_all(fixture, provider: GeminiProvider | None = None):
    """One recorded stream, as the neutral events a provider makes of it.

    Returns the provider too, so a test can drive a second stream through the
    same one — which is how the round-reset test catches an accumulator that
    leaks. Every recordable dict is serialised on the way past, because
    `TurnResult.raw_events` is written to a JSON column and a provider that
    returned something unserialisable would fail at the end of a turn rather
    than here.
    """
    provider = provider or GeminiProvider(client=None)
    events = []
    for raw in fixture:
        recordable, neutral = provider.normalise(raw)
        json.dumps(recordable)
        events.append(neutral)
    return provider, events


def _only(events, kind):
    return [event for event in events if isinstance(event, kind)]


def test_the_gemini_provider_satisfies_the_protocol():
    assert isinstance(GeminiProvider(client=None), Provider)


def test_the_gemini_provider_names_itself():
    assert GeminiProvider(client=None).name == "gemini"


def test_the_tools_are_converted_once_at_import():
    """`to_gemini_tools` raises on a schema it cannot express, and that is only
    a boot-time guarantee if it runs at boot. Converted per round instead, an
    edit to `tools.py` that broke one arm would pass every import and fail on
    the first turn a learner sent."""
    assert GEMINI_TOOLS, "the module-level conversion produced nothing"
    kinds = {tool.get("type") for tool in GEMINI_TOOLS}
    assert {"function", "google_search", "code_execution"} <= kinds
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high", outbox=[], previous_id=None,
        cache_key=None,
    )
    assert payload["tools"] is GEMINI_TOOLS


def test_a_round_lifts_the_system_prompt_out_of_the_input():
    """OpenAI takes a system item inside `input`; Gemini takes a top-level
    `system_instruction`. Left in `input`, the prompt would arrive as a user
    turn and the tutor's whole character would be advice rather than
    instruction."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash",
        effort="high",
        outbox=[
            {"role": "system",
             "content": [{"type": "input_text", "text": "BE A TUTOR"}]},
            {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        ],
        previous_id=None,
        cache_key="session-1",
    )
    assert payload["system_instruction"] == "BE A TUTOR"
    assert all(item.get("role") != "system" for item in payload["input"])


def test_a_round_never_sends_the_rejected_generation_parameters():
    """Gemini 3.x rejects all three, and thinking_budget is superseded."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high", outbox=[], previous_id=None,
        cache_key=None,
    )
    for rejected in ("temperature", "top_p", "top_k"):
        assert rejected not in payload
        assert rejected not in payload["generation_config"]
    assert "thinking_budget" not in payload["generation_config"]


def test_a_round_carries_no_cache_key():
    """There is no prompt_cache_key equivalent: implicit caching routes on the
    prefix by itself. A key passed through would be an unknown field."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high", outbox=[], previous_id=None,
        cache_key="session-1",
    )
    assert "prompt_cache_key" not in payload


def test_later_rounds_chain_on_the_previous_interaction():
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="medium", outbox=[], previous_id="int_9",
        cache_key=None,
    )
    assert payload["previous_interaction_id"] == "int_9"


def test_a_later_round_repeats_no_system_instruction():
    """The outbox then holds only tool results, and the instruction is already
    part of the stored interaction the chaining id names. Sending it again would
    be the prompt arriving twice, at the input rate, on every round."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="medium",
        outbox=[{"type": "function_result", "call_id": "c1", "name": "view_board",
                 "result": "ok"}],
        previous_id="int_9", cache_key=None,
    )
    assert "system_instruction" not in payload


def test_the_deep_efforts_clamp_to_high():
    """Gemini offers three levels where the picker offers five. The client
    clamps before sending, and this is the second line of that defence."""
    assert EFFORT_TO_THINKING_LEVEL["xhigh"] == "high"
    assert EFFORT_TO_THINKING_LEVEL["max"] == "high"
    assert EFFORT_TO_THINKING_LEVEL["low"] == "low"


def test_an_image_part_splits_the_data_url():
    """OpenAI takes one data: URL string; Gemini takes the mime type and the
    raw base64 in separate fields."""
    item = GeminiProvider(client=None).image_item(b"\x89PNG...", "look")
    part = next(p for p in item["content"] if p["type"] == "image")
    assert part["mime_type"] == "image/png"
    assert "data:" not in part["data"]


def test_the_prompts_own_image_parts_are_split_and_keep_their_detail():
    """The same split, on the parts `assemble_context` built rather than the
    ones this provider built. Forwarded whole, the payload would begin with the
    characters `data:image/png;base64,` and fail as a corrupt picture rather
    than as a bad request.

    `detail` survives as `resolution`, and that is not cosmetic: the board
    overview rides on every single turn at `low` precisely so a thumbnail is
    not billed at reading resolution."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high",
        outbox=[{"role": "user", "content": [
            {"type": "input_image", "image_url": "data:image/jpeg;base64,QUJD",
             "detail": "low"},
        ]}],
        previous_id=None, cache_key=None,
    )
    part, = payload["input"][0]["content"]
    assert part == {"type": "image", "mime_type": "image/jpeg", "data": "QUJD",
                    "resolution": "low"}


def test_an_attached_pdf_becomes_a_document_part():
    """`input_file` carries its bytes in `file_data` rather than `image_url`,
    and Gemini calls the part a document. A part left untranslated is a
    learner's worksheet the tutor never sees."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="high",
        outbox=[{"role": "user", "content": [
            {"type": "input_file", "filename": "worksheet.pdf",
             "file_data": "data:application/pdf;base64,QUJD"},
        ]}],
        previous_id=None, cache_key=None,
    )
    part, = payload["input"][0]["content"]
    assert part == {"type": "document", "mime_type": "application/pdf", "data": "QUJD"}


def test_the_providers_own_items_pass_through_a_round_untouched():
    """A later round's outbox mixes items this provider built — the results
    answering a run of calls, and the pictures those results wanted to show —
    and they are already in this API's vocabulary. Translated a second time
    they would be wrapped again, and the run of results answering the run of
    calls would no longer be one."""
    provider = GeminiProvider(client=None)
    result = provider.tool_output(call_id="c1", name="view_board", output="ok")
    picture = provider.image_item(b"png", "here")
    payload = provider.build_round(
        model="gemini-3.7-flash", effort="high", outbox=[result, picture],
        previous_id="int_9", cache_key=None,
    )
    assert payload["input"] == [result, picture]


def test_a_tool_result_names_its_function():
    """function_result carries the name as well as the call_id. OpenAI's
    function_call_output carries only the id, which is why `name` is in the
    shared signature at all — and here it is load-bearing rather than
    decoration: a result whose name disagrees with the call it answers is a
    400."""
    item = GeminiProvider(client=None).tool_output(
        call_id="call_1", name="update_board", output='{"status":"ok"}',
    )
    assert item["type"] == "function_result"
    assert item["call_id"] == "call_1"
    assert item["name"] == "update_board"
    assert item["result"] == '{"status":"ok"}'


def test_a_board_render_is_named_for_the_tool_that_asked_for_it():
    """`rendered_items` answers exactly one tool, so it writes that tool's name
    itself. An empty name here would be the 400 above, on every turn that looks
    at the board."""
    result, picture = GeminiProvider(client=None).rendered_items(
        "call_9", b"png-bytes", "Showing x 0–100%, y 0–100% of the board."
    )
    assert result["type"] == "function_result"
    assert result["name"] == "view_board"
    assert result["call_id"] == "call_9"
    assert json.loads(result["result"])["status"] == "ok"
    assert picture["type"] == "user_input"
    assert [part["type"] for part in picture["content"]] == ["text", "image"]


def test_a_relayed_file_that_could_not_be_kept_still_gets_a_line():
    """Silence about a failure is the failure the relay exists to prevent: a
    model not told the chart never saved describes it to the learner anyway and
    then places a blob id it invented. The CSV gets a line and no picture,
    because `input`'s image part is not a channel for arbitrary bytes."""
    item = GeminiProvider(client=None).relay_item([
        ("image_1.png", RelayedFile(blob_id="blob-1", data=b"x",
                                    content_type="image/png")),
        ("data.csv", RelayedFile(error="the file was too large to keep")),
    ])
    text = item["content"][0]["text"]
    assert "image_1.png → blob-1" in text
    assert "data.csv → not saved (the file was too large to keep)" in text
    assert [part["type"] for part in item["content"]] == ["text", "image"]


def test_a_text_only_interaction_normalises_to_the_expected_events():
    provider = GeminiProvider(client=None)
    neutral = [provider.normalise(raw)[1] for raw in TEXT_ONLY_INTERACTION]
    assert any(isinstance(event, TextDelta) for event in neutral)
    completed = next(e for e in neutral if isinstance(e, Completed))
    assert completed.response_id
    assert completed.usage is not None


def test_a_text_only_round_reports_no_calls_and_no_files():
    """The other half of the accumulator's job, and the one that decides whether
    a turn ends. `run_turn` buys another round when `Completed.calls` is
    non-empty, so a phantom call here would bill the learner for a round that
    answers nothing."""
    _, events = _normalise_all(TEXT_ONLY_INTERACTION)
    completed, = _only(events, Completed)
    assert completed.calls == []
    assert completed.files == []
    assert completed.status == "completed"
    assert isinstance(events[0], Created)
    assert "".join(e.text for e in _only(events, TextDelta)) == "7 times 8 is 56."


def test_a_thought_signature_never_reaches_the_reasoning_ribbon():
    """`thought_signature` is an opaque base64 blob carrying reasoning
    continuity, not prose. Mapped to a `ThoughtDelta` it would print base64 in
    the learner's activity trail — and `TEXT_ONLY_INTERACTION` is a turn whose
    only thought event is that signature, which is what a `low` thinking level
    routinely produces."""
    _, events = _normalise_all(TEXT_ONLY_INTERACTION)
    assert _only(events, ThoughtDelta) == []

    _, events = _normalise_all(TOOL_CALL_INTERACTION)
    thought, = _only(events, ThoughtDelta)
    assert thought.text.startswith("**Initiating Planning")


def test_a_tool_calls_arguments_are_accumulated_across_deltas():
    """`step.stop` carries only `index` — no name, no call id, no arguments — so
    everything `ToolArgsDone` and `ToolCall` carry comes out of the provider's
    own accumulator. The recorded deltas split the JSON mid-key on purpose: a
    provider that read each fragment on its own would pass on a call that
    happened to arrive whole and break on every real one."""
    _, events = _normalise_all(TOOL_CALL_INTERACTION)

    started, = _only(events, ToolCallStarted)
    assert (started.name, started.call_id) == ("set_workspace", "call_1042187")
    assert _only(events, ToolArgsDelta), "no argument deltas were reported at all"

    done, = _only(events, ToolArgsDone)
    assert done.output_index == started.output_index
    assert json.loads(done.arguments) == WORKSPACE_ARGUMENTS

    completed, = _only(events, Completed)
    call, = completed.calls
    assert (call.name, call.call_id) == ("set_workspace", "call_1042187")
    assert json.loads(call.arguments) == WORKSPACE_ARGUMENTS


def test_a_tool_round_ends_requires_action_and_that_is_not_a_failure():
    """It is how a normal tool round ends on this family. Read as terminal, every
    turn that touches the board would end in an error."""
    _, events = _normalise_all(TOOL_CALL_INTERACTION)
    completed, = _only(events, Completed)
    assert completed.status == "requires_action"
    assert completed.status not in TERMINAL_ERROR_STATUSES


def test_the_accumulator_does_not_survive_into_the_next_round():
    """The one defect this provider's statefulness makes possible, and the most
    expensive one available: a turn is up to eight rounds through one provider,
    and a call still in the accumulator at round two makes `Completed.calls`
    non-empty forever. The loop would answer the same tool again and buy another
    round, to `MAX_TOOL_ROUNDS`, every one of them billed."""
    provider, _ = _normalise_all(TOOL_CALL_INTERACTION)
    _, events = _normalise_all(TOOL_CALL_FOLLOW_UP, provider)

    completed, = _only(events, Completed)
    assert completed.calls == []
    assert completed.response_id == "v1_workspace_2"


def test_a_board_update_reaches_the_same_board_as_the_openai_fixture():
    """The first instalment of the cross-provider parity test.

    Both fixtures name the same board — `interactions.py` imports
    `BOARD_UPDATE_ARGUMENTS` from `sse.py` rather than copying it, so they
    cannot drift — and this asserts that two entirely different wire vocabularies
    produce one `board_update` payload. Driven through `EventTranslator` as well
    as through `normalise`, because the payload is what actually changes a
    learner's screen."""
    def board_payloads(fixture, provider):
        # `neutral`, not `normalise`: both providers expose the mapping over an
        # already-dumped dict precisely so it can be driven from a recorded
        # fixture, and the OpenAI one takes an SDK object in `normalise`.
        translator = EventTranslator()
        produced = []
        for raw in fixture:
            produced.extend(translator.translate(provider.neutral(raw)))
        return [e.payload for e in produced if e.type == "board_update"]

    gemini, = board_payloads(BOARD_UPDATE_INTERACTION, GeminiProvider(client=None))
    openai, = board_payloads(BOARD_UPDATE_TURN, OpenAIProvider(client=None))
    assert gemini == openai

    _, events = _normalise_all(BOARD_UPDATE_INTERACTION)
    done, = _only(events, ToolArgsDone)
    assert json.loads(done.arguments) == BOARD_UPDATE_ARGUMENTS
    completed, = _only(events, Completed)
    call, = completed.calls
    assert call.name == "update_board"
    assert json.loads(call.arguments) == BOARD_UPDATE_ARGUMENTS


def test_a_hosted_script_reports_itself_and_hands_back_its_picture():
    """Three recorded shapes at once, none of which exists on the other side.
    The hosted call is a step of its own that the provider runs inline, so the
    interaction ends `completed` with no tool call to answer. Its `id` is what
    the device keys the activity row on. And the PNG the script wrote is not in
    the `code_execution_result` step — whose `result` is the empty string — but
    in a later `model_output` step, with no id and no filename anywhere."""
    _, events = _normalise_all(CODE_EXECUTION_INTERACTION)

    hosted, = _only(events, HostedToolStarted)
    assert hosted.item_id == "call_1006863"
    assert hosted.tool == CODE_INTERPRETER
    assert any(e.phase == "computing" for e in _only(events, HostedToolActivity))

    completed, = _only(events, Completed)
    assert completed.status == "completed"
    assert completed.calls == []
    produced, = completed.files
    assert asyncio.run(produced.read()) == base64.b64decode(INLINE_IMAGE_BASE64)


def test_a_produced_images_name_survives_the_relays_content_type_check():
    """The synthesised filename is load-bearing. `app.api.turn`'s relay derives
    the attachment's content type from it, and that type is what decides whether
    `model_copy` reduces the picture before it goes back into the conversation. A
    name with no real image extension would come back as
    `application/octet-stream`, skip the reduction, and put a full-resolution PNG
    into a context that is re-billed on every one of up to eight rounds."""
    _, events = _normalise_all(CODE_EXECUTION_INTERACTION)
    completed, = _only(events, Completed)
    produced, = completed.files
    assert relayed_content_type(produced.filename) in ALLOWED_CONTENT_TYPES


def test_two_rounds_of_one_turn_produce_different_file_keys():
    """`run_turn` de-duplicates relays on `ProducedFile.key` across a whole turn,
    and every round numbers its steps from zero. Keyed on the step index alone,
    round two's chart would look like round one's already-relayed file and be
    thrown away — a turn that drew two graphs would hand over one, and the model
    would place a blob id for a picture nobody kept.

    The second stream is the same fixture with its interaction id rewritten,
    which is what a second round of one turn actually is: a new interaction,
    chained on the first."""
    def with_id(fixture, interaction_id):
        rewritten = []
        for raw in fixture:
            event = dict(raw)
            if "interaction" in event:
                event["interaction"] = {**event["interaction"], "id": interaction_id}
            rewritten.append(event)
        return rewritten

    provider, first = _normalise_all(CODE_EXECUTION_INTERACTION)
    _, second = _normalise_all(
        with_id(CODE_EXECUTION_INTERACTION, "v1_code_round_two"), provider
    )

    one, = _only(first, Completed)[0].files
    two, = _only(second, Completed)[0].files
    assert one.key[0] == "v1_code"
    assert two.key[0] == "v1_code_round_two"
    assert one.key != two.key


def test_a_grounded_turn_prices_its_searches_as_an_integer():
    """`usage.grounding_tool_count` arrives as `[{"count": 2, "type": …}]` and
    `turn_cost_usd` multiplies it by `per_search`. Passed through as the list, a
    grounded turn would price as a TypeError instead of as money — and grounding
    is the one charge in this service that is not a token."""
    _, events = _normalise_all(GROUNDED_SEARCH_INTERACTION)
    assert any(e.phase == "searching" for e in _only(events, HostedToolActivity))

    completed, = _only(events, Completed)
    assert completed.usage["grounding_tool_count"] == 2
    cost = turn_cost_usd("gemini-3.5-flash-lite", completed.usage)
    assert cost is not None
    assert cost > 2 * 0.014, "the searches were not priced"


def test_usage_maps_into_the_shape_the_recorder_already_writes():
    """Mapped rather than stored raw so `_apply_usage` and `turn_cost_usd` need
    no provider branch. Thought tokens land under `reasoning_tokens` and are not
    priced separately: Gemini bills thinking inside the output tokens, the same
    as the OpenAI family, so a rate of their own would double-charge.

    `cache_write_tokens` has no equivalent and stays absent, so the column stays
    NULL — a visible gap someone can query for, which is the rule
    `recorder.cache_tokens` already follows."""
    mapped = map_usage({
        "total_input_tokens": 100, "total_output_tokens": 20,
        "total_cached_tokens": 30, "total_thought_tokens": 8,
        "total_tool_use_tokens": 5, "total_tokens": 120,
    })
    assert mapped["input_tokens"] == 100
    assert mapped["output_tokens"] == 20
    assert mapped["input_tokens_details"]["cached_tokens"] == 30
    assert mapped["output_tokens_details"]["reasoning_tokens"] == 8
    assert mapped["tool_use_tokens"] == 5
    assert "cache_write_tokens" not in mapped
    assert mapped["input_tokens_details"].get("cache_write_tokens") is None
    # Absent entirely when nothing searched, and an int either way.
    assert mapped["grounding_tool_count"] == 0
    assert map_usage({"grounding_tool_count": [
        {"count": 2, "type": "google_search"}, {"count": 1, "type": "google_search"},
    ]})["grounding_tool_count"] == 3
    # Provider-authored and treated as absent-or-wrong until proven an integer:
    # `True` is an `int` in Python, and two of them add up to a plausible 2.
    assert map_usage({"grounding_tool_count": [
        {"count": True}, "not a dict", {"count": "2"}, {},
    ]})["grounding_tool_count"] == 0


def test_an_in_stream_error_is_a_failure_that_never_had_a_status_code():
    """`error` replaces `interaction.completed` on an HTTP 200: the stream opened,
    said `in_progress`, and then ended. So there is no status code to classify,
    and no `failed` interaction status either — `Failed.status` says `failed`
    because a reader testing it against `TERMINAL_ERROR_STATUSES` must not
    conclude the round is still running, which is what the last status that
    actually arrived would tell them.

    The message is diagnosable text for the log and for nothing else. The device
    is told `TURN_FAILED_MESSAGE` by `run_turn`, which is why an iPad no longer
    displays a provider's rate-limit prose complete with an organization id."""
    _, events = _normalise_all(FAILED_INTERACTION)
    failed, = _only(events, Failed)
    assert failed.status in TERMINAL_ERROR_STATUSES
    assert "invalid_request" in failed.message
    assert "classified:" in failed.message


def test_classify_separates_a_burst_limit_from_a_spent_quota():
    """Gemini answers both with 429 and `RESOURCE_EXHAUSTED`, so neither the
    status code nor the status name separates them. A burst is worth waiting out;
    a day's quota is a learner watching a thinking indicator through backoff for
    a refusal that was already certain — the failure `BILLING_ERROR_CODES`
    prevents on the other family."""
    provider = GeminiProvider(client=None)

    burst = provider.classify(429, {"error": {
        "code": 429, "status": "RESOURCE_EXHAUSTED",
        "message": "Resource has been exhausted (e.g. check quota).",
    }})
    assert burst.retry
    assert burst.reason == "rate limited"

    spent = provider.classify(429, {"error": {
        "code": 429, "status": "RESOURCE_EXHAUSTED",
        "message": "You exceeded your current quota.",
        "details": [{
            "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            "violations": [{"quotaId": "GenerateRequestsPerDayPerProject"}],
        }],
    }})
    assert not spent.retry
    assert "quota" in spent.reason

    assert provider.classify(503, None).retry
    assert not provider.classify(400, {"error": {"code": 400}}).retry


def test_classify_takes_the_no_status_path_for_an_in_stream_error():
    """The shape `retry._without_status` was written for, arriving on the other
    family too: a 200, an open stream, and a refusal minutes later. Delegated
    rather than restated, and never given an invented status code — a made-up
    number is one someone later reads as the provider's."""
    provider = GeminiProvider(client=None)
    decision = provider.classify(
        None, {"error": {"code": "rate_limit_exceeded", "message": "try again"}}
    )
    assert decision.retry
    assert decision.reason == "rate limited"
    assert not provider.classify(
        None, {"error": {"code": "invalid_request", "message": "bad argument"}}
    ).retry


def test_the_closing_rounds_tool_choice_moves_into_the_generation_config():
    """`loop._closing_round` sets `tool_choice` at the top level of the payload,
    where the Responses API takes it. On this API it lives inside
    `generation_config`, so left where it was put it would be a field the request
    type does not declare — and the closing round is bought precisely when a turn
    is about to end in silence, so it is the last round that can afford to fail.

    The payload itself is not mutated: `run_turn` records the first round's
    payload as the turn's request envelope, and a stored call should say what was
    built."""
    from app.tutor.providers.gemini import _sdk_kwargs

    provider = GeminiProvider(client=None)
    payload = provider.build_round(
        model="gemini-3.7-flash", effort="low", outbox=[], previous_id=None,
        cache_key=None,
    )
    payload["tool_choice"] = "none"

    kwargs = _sdk_kwargs(payload)
    assert "tool_choice" not in kwargs
    assert kwargs["generation_config"]["tool_choice"] == "none"
    assert payload["generation_config"]["tool_choice"] == "validated"


def test_every_recorded_event_decodes_to_the_shape_the_provider_reads():
    """The fixtures are dicts and production hands the provider SDK objects, so
    this is the assertion that lets every test above use the dicts: each recorded
    event validates as a *known* `InteractionSSEEvent` variant, and dumping it
    back gives the fixture unchanged. An `Unknown…` here would mean the recorded
    shape and the installed SDK no longer agree, which is the one way these
    fixtures could quietly stop describing what a real turn sends."""
    from google.genai.interactions import (
        InteractionSSEEvent, UnknownInteractionSSEEvent,
    )

    adapter = TypeAdapter(InteractionSSEEvent)
    # Two providers, each shown one well-formed stream. One provider fed both
    # copies of every event would be a stream in which each step starts twice and
    # stops twice, and the accumulator is deliberately not indifferent to that —
    # see `test_a_repeated_step_stop_does_not_complete_the_same_call_twice`.
    from_objects = GeminiProvider(client=None)
    from_dicts = GeminiProvider(client=None)
    for fixture in (
        TEXT_ONLY_INTERACTION, TOOL_CALL_INTERACTION, TOOL_CALL_FOLLOW_UP,
        BOARD_UPDATE_INTERACTION, CODE_EXECUTION_INTERACTION,
        GROUNDED_SEARCH_INTERACTION, FAILED_INTERACTION,
    ):
        for raw in fixture:
            decoded = adapter.validate_python(raw)
            assert not isinstance(decoded, UnknownInteractionSSEEvent), raw
            dumped, from_sdk = from_objects.normalise(decoded)
            assert dumped == raw
            _, from_dict = from_dicts.normalise(raw)
            assert type(from_sdk) is type(from_dict)


class _FakeStream:
    """One recorded interaction, shaped like the stream `open_round` returns.

    An async context manager over an async iterator, which is what `run_turn`
    requires of every provider (`async with stream: async for raw in stream:`) and
    what `google.genai`'s `AsyncStream` is. Yields the fixture's dicts, because
    `normalise` reads an SDK object and a dict identically — held down by
    `test_every_recorded_event_decodes_to_the_shape_the_provider_reads`.
    """

    def __init__(self, events):
        self._events = list(events)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_):
        return False

    def __aiter__(self):
        async def gen():
            for event in self._events:
                yield event
        return gen()


async def test_an_in_stream_error_reaches_the_turn_as_an_error_event():
    """The signal `app.api.turn` now keys its failure path on.

    A Gemini round can fail *inside* an open stream, and that failure does not
    raise: `run_turn` logs the provider's words, yields one `ErrorEvent` and
    returns. So the handler's `async for` completes normally and every `except`
    clause is skipped — which is why the handler has to notice the event itself,
    and why this test asserts the event is really what arrives.

    Driven through `run_turn` rather than through `normalise` alone, because the
    thing under test is the seam between the two: a provider that returned
    `Failed` and a loop that yielded nothing would look correct in isolation."""
    from app.tutor.context import ContextBundle
    from app.tutor.events import TURN_FAILED_MESSAGE
    from app.tutor.loop import run_turn

    provider = GeminiProvider(client=None)

    async def open_round(payload):
        return _FakeStream(FAILED_INTERACTION)

    provider.open_round = open_round

    events = []
    async for event, result in run_turn(
        provider=provider, model="gemini-3.5-flash-lite", effort="low",
        bundle=ContextBundle(system="be a tutor", input=[
            {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        ]),
    ):
        events.append(event)

    failure, = [event for event in events if event.type == "error"]
    # The provider's own words must not be on this wire; see TURN_FAILED_MESSAGE.
    assert failure.message == TURN_FAILED_MESSAGE
    assert failure.retryable is False
    # No completion arrived, so there is no usage — which is exactly why the
    # handler must not take the success path: `finish_turn` would write status
    # "ok" for a turn whose spend it could not even record.
    assert result.usage is None


def test_a_repeated_step_stop_does_not_complete_the_same_call_twice():
    """`step.stop` carries only an index, so nothing in the event distinguishes a
    duplicate from a new step. Left in the accumulator, a second stop would
    append a second `ToolCall` with the same `call_id` — and `run_turn` answers
    every call it is given, so the next round would carry two `function_result`
    items under one id, on top of a board drawn twice."""
    provider, _ = _normalise_all(TOOL_CALL_INTERACTION)
    repeated = provider.neutral({"index": 1, "event_type": "step.stop"})
    assert repeated is None

    completed = provider.neutral({"interaction": {
        "id": "v1_workspace", "status": "requires_action", "usage": {},
    }, "event_type": "interaction.completed"})
    assert len(completed.calls) == 1


def test_arguments_for_a_step_that_never_started_produce_no_call():
    """`step.start` is the only event that carries a call's name and id, so a
    step invented from an `arguments_delta` would be completed into a
    `ToolCall(name="", call_id="")`. `tool_output` would then build a
    `function_result` with an empty `name`, which is the 400 its own docstring
    warns about — produced by this service rather than by the model."""
    provider = GeminiProvider(client=None)
    provider.neutral({"interaction": {"id": "v1"}, "event_type": "interaction.created"})
    delta = provider.neutral({
        "index": 4,
        "delta": {"arguments": '{"mode":', "type": "arguments_delta"},
        "event_type": "step.delta",
    })
    assert isinstance(delta, ToolArgsDelta)
    assert provider.neutral({"index": 4, "event_type": "step.stop"}) is None

    completed = provider.neutral({"interaction": {
        "id": "v1", "status": "completed", "usage": {},
    }, "event_type": "interaction.completed"})
    assert completed.calls == []


def test_an_unclamped_effort_reaches_the_deepest_level_rather_than_raising():
    """The map exists for the effort that arrives unclamped — an older client, a
    restored session — so a KeyError here would fail the turn it was written to
    rescue. `EFFORTS_FOR_MODEL` has already refused anything outside the five at
    the request boundary."""
    payload = GeminiProvider(client=None).build_round(
        model="gemini-3.7-flash", effort="ludicrous", outbox=[], previous_id=None,
        cache_key=None,
    )
    assert payload["generation_config"]["thinking_level"] == "high"


def test_the_canonical_free_tier_429_is_retried():
    """The regression this file exists for after review. Google's per-*minute*
    free-tier 429 carries `RESOURCE_EXHAUSTED`, the words "You exceeded your
    current quota, please check your plan and billing details", a
    `PerMinute…-FreeTier` quota id, and a `RetryInfo` saying when to try again.

    Reading the prose as exhaustion classified that common, recoverable refusal
    as final and suppressed the retry — a hiccup the provider was willing to
    serve, shown to a child as a dead end. The window and the stated delay are
    the evidence; the sentence is boilerplate on every free-tier 429."""
    decision = GeminiProvider(client=None).classify(429, {"error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "message": (
            "You exceeded your current quota, please check your plan and "
            "billing details."
        ),
        "details": [
            {"@type": "type.googleapis.com/google.rpc.QuotaFailure",
             "violations": [{
                 "quotaMetric": "generativelanguage.googleapis.com/generate_requests",
                 "quotaId": "GenerateRequestsPerMinutePerProjectPerModel-FreeTier",
             }]},
            {"@type": "type.googleapis.com/google.rpc.RetryInfo",
             "retryDelay": "38s"},
        ],
    }})
    assert decision.retry
    assert decision.reason == "rate limited"


def test_a_stated_retry_delay_beats_a_long_window():
    """A provider saying when to try again is a provider saying to try again —
    the same fact `retry.retry_delay` reads off a `Retry-After` header on the
    other family, delivered in a body instead. And a refusal naming both windows
    will serve the next minute's requests, so the short one wins: everything
    ambiguous is a burst, because suppressing a good retry costs far more than
    two seconds of backoff in front of a certain refusal."""
    provider = GeminiProvider(client=None)

    both_windows = provider.classify(429, {"error": {"details": [{
        "violations": [
            {"quotaId": "GenerateRequestsPerMinutePerProjectPerModel"},
            {"quotaId": "GenerateRequestsPerDayPerProjectPerModel"},
        ],
    }]}})
    assert both_windows.retry

    delay_wins = provider.classify(429, {"error": {
        "message": "Quota exceeded",
        "details": [
            {"violations": [{"quotaId": "GenerateRequestsPerDayPerProject"}]},
            {"@type": "type.googleapis.com/google.rpc.RetryInfo",
             "retry_delay": "12s"},
        ],
    }})
    assert delay_wins.retry


def test_a_spent_day_with_no_delay_offered_is_final():
    """The other half of the pair, and the only shape read as spent: a long
    window named, and nothing anywhere saying to come back."""
    decision = GeminiProvider(client=None).classify(429, {"error": {
        "code": 429,
        "status": "RESOURCE_EXHAUSTED",
        "message": "Quota exceeded for quota metric 'Generate requests'.",
        "details": [{"@type": "type.googleapis.com/google.rpc.QuotaFailure",
                     "violations": [{"quotaId": "GenerateRequestsPerDayPerProject"}]}],
    }})
    assert not decision.retry
    assert "quota" in decision.reason


# --------------------------------------------------------------------------
# Both providers, one client-event sequence
# --------------------------------------------------------------------------


def _client_events(provider, raw_events):
    """Every `ClientEvent` one recorded stream produces, in order.

    `neutral`, not `normalise`. `normalise` on the OpenAI side dumps an SDK
    object, and these fixtures already *are* the dicts such a dump produces;
    both providers expose the mapping over an already-dumped dict for exactly
    this reason. That the dict path and the SDK path agree is not assumed here,
    it is asserted by
    `test_every_recorded_event_decodes_to_the_shape_the_provider_reads`.

    The clock is frozen so that no heartbeat can fire. `HEARTBEAT_SECONDS` of
    silence inserts an extra `status` wherever the interval happens to elapse,
    and the two fixtures are different lengths — so a real clock would make a
    cross-provider comparison depend on how fast the machine ran this loop.
    """
    translator = EventTranslator(now=lambda: 0.0)
    produced = []
    for raw in raw_events:
        produced.extend(translator.translate(provider.neutral(raw)))
    return produced


def _shape(events):
    """The sequence reduced to what the device actually reacts to.

    Three reductions, each for a reason, because the unreduced sequences differ
    and every one of the differences is a property of a recording rather than of
    the seam.

    **`reasoning_delta` is filtered out.** Whether a turn narrates its thinking
    is the model's choice on the day: the recorded Gemini turn emitted a
    `thought_summary` and the recorded OpenAI turn did not, and at
    `thinking_level: "low"` roughly half of Gemini turns emit no summary at all
    — so two recordings of the same Gemini prompt would not agree with each
    other either. A test pinning the raw sequence pins one recording, goes red
    the next time anyone re-records a fixture, and leaves "weaken the assertion"
    as the only correct response to the failure. That is the least useful
    failing test there is.

    **Text is joined** rather than compared delta by delta. The two families
    chunk prose into different numbers of events and a learner cannot see that.

    **Only the event kinds are kept, not a step's `id`.** That id is the
    provider's own `call_id` — `call_board` here against `call_937729` there —
    and two recordings can no more agree on it than on a response id. The kind
    is what the device switches on; the payload it must agree about is returned
    separately and compared whole.
    """
    kinds = [
        event.type for event in events
        if not isinstance(event, ReasoningDeltaEvent)
    ]
    text = "".join(e.text for e in events if isinstance(e, TextDeltaEvent))
    boards = [e for e in events if isinstance(e, BoardUpdateEvent)]
    return kinds, text, boards


def test_a_board_update_turn_produces_the_same_shape_on_both_providers():
    """The parity test the whole provider seam exists for.

    Two recorded streams of the same turn — `BOARD_UPDATE_TURN` off the
    Responses API, `BOARD_UPDATE_INTERACTION` off the Interactions API — each
    through its own provider and then through the one `EventTranslator`, reduced
    to what the device reacts to. `interactions.py` imports
    `BOARD_UPDATE_ARGUMENTS` from `sse.py` rather than copying it, so the two
    fixtures cannot drift into naming different boards and leave this comparing
    two turns instead of two providers.

    This is the test to keep if any other in this file is dropped. A change that
    makes one family behave differently from the other — a status the provider
    forgets to announce, a step row opened under a different name, an
    accumulator that hands the translator a different arguments string — fails
    here, in a suite, rather than on a nine-year-old's board.
    """
    openai_kinds, openai_text, openai_boards = _shape(
        _client_events(OpenAIProvider(client=None), BOARD_UPDATE_TURN)
    )
    gemini_kinds, gemini_text, gemini_boards = _shape(
        _client_events(GeminiProvider(client=None), BOARD_UPDATE_INTERACTION)
    )

    assert gemini_kinds == openai_kinds
    # Both recordings are tool-call rounds that write no prose, so today this
    # compares "" against "": on both families the round that writes is a
    # separate interaction, and there is no recorded second leg of the *board*
    # turn on the Gemini side to pair with `BOARD_UPDATE_FOLLOW_UP`. Stated
    # plainly rather than left looking like evidence — the limb is here because
    # joining is the right reduction, and it starts holding something down the
    # moment either fixture gains a text delta.
    assert gemini_text == openai_text
    # Compared whole, not field by field. This payload *is* what changes the
    # learner's screen, and an assertion that named its fields would silently
    # stop covering whichever field `BoardUpdatePayload` gains next.
    assert len(gemini_boards) == len(openai_boards) == 1
    assert gemini_boards[0].model_dump() == openai_boards[0].model_dump()


def test_both_families_announce_drawing_at_the_head_of_the_board_call():
    """The status that stops the learner staring at nothing while a diagram's
    arguments stream — asserted as a named phase in a named position, which is
    the one thing the parity test above cannot do.

    Not a restatement of that test, and the difference is the whole reason this
    one is worth its lines. The parity test compares the two sequences to *each
    other*, so it stays green whenever both families regress together: delete
    the `update_board` row from `TOOL_PHASES` and neither stream carries a
    `drawing` status, the two reduced sequences still match exactly, and every
    learner on both families watches a minutes-long silence with the status line
    still reading `thinking`. That is the defect `TOOL_PHASES` exists to
    prevent, and naming the phase here is what makes it fail.

    The position is measured against the `step` row, not against the board
    update. Both the status and the row come out of one `ToolCallStarted`, so a
    `drawing` that arrived from the heartbeat instead — up to
    `HEARTBEAT_SECONDS` into a call whose arguments take minutes — would land
    *after* the row and fail here. Measured against the board update it would
    prove nothing at all: `Created` puts a `thinking` status at the front of
    every stream, so "some status precedes the board update" passes even with no
    `drawing` status anywhere in the turn.
    """
    for provider, fixture in (
        (OpenAIProvider(client=None), BOARD_UPDATE_TURN),
        (GeminiProvider(client=None), BOARD_UPDATE_INTERACTION),
    ):
        events = _client_events(provider, fixture)
        kinds = [event.type for event in events]
        drawing = [
            index for index, event in enumerate(events)
            if isinstance(event, StatusEvent) and event.phase == "drawing"
        ]

        assert drawing, f"{provider.name} never announced the drawing phase"
        assert drawing[0] < kinds.index("step"), (
            f"{provider.name} announced drawing after the step row opened"
        )


# MARK: - What a built request really validates as


def _unknown_members(model) -> list[str]:
    """Every `Unknown…` object anywhere inside a validated request.

    The SDK's unions are *lenient*: a member it does not recognise is not a
    validation error, it is an `UnknownStep`, an `UnknownTool` or an
    `UnknownContent` carrying the raw dict. So `model_validate` succeeding proves
    nothing on its own, and the assertion that means something is this walk. The
    class name is tested rather than a tuple of imported classes, because the set
    of `Unknown…` types grows with the SDK and a tuple written today would stop
    covering the one added tomorrow.

    Reported as paths rather than as a bool, so a failure says which item.
    """
    from pydantic import BaseModel

    found: list[str] = []

    def walk(value, path: str) -> None:
        if isinstance(value, BaseModel):
            name = type(value).__name__
            if name.startswith("Unknown"):
                found.append(f"{path}: {name}")
                return
            for field in type(value).model_fields:
                walk(getattr(value, field, None), f"{path}.{field}")
            return
        if isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")
            return
        if isinstance(value, dict):
            for key, item in value.items():
                walk(item, f"{path}[{key!r}]")

    walk(model, "input")
    return found


def _validated(payload: dict) -> list[str]:
    """One built payload through the request type the SDK really posts."""
    from google.genai.interactions import CreateModelInteraction

    return _unknown_members(CreateModelInteraction.model_validate(payload))


def _every_answer_shape(provider) -> list[dict]:
    """Every item `loop._answer` can put in a later round's outbox.

    Produced by calling `_answer` itself rather than by writing the seven items
    out here, because the defect this guards was `_answer` writing an item shape
    of its own. A copy of the shapes in this file would have agreed with the bug.
    """
    from app.tutor.loop import _answer

    calls = [
        # The two the tutor uses most, and the two that were malformed.
        ({"call_id": "c1", "name": "set_workspace", "arguments": "{}"}, {}),
        (
            {"call_id": "c2", "name": "update_board",
             "arguments": json.dumps(BOARD_UPDATE_ARGUMENTS)},
            {"has_board": True},
        ),
        # `fetch_image` with no fetcher wired, and with no usable url.
        ({"call_id": "c3", "name": "fetch_image",
          "arguments": '{"url": "https://example.com/a.png"}'}, {}),
        ({"call_id": "c4", "name": "fetch_image", "arguments": "{}"},
         {"has_image": True}),
        # The memory refusals: no handler wired, and arguments that are not an
        # object. One site, two strings.
        ({"call_id": "c5", "name": "search_memory", "arguments": "{}"}, {}),
        ({"call_id": "c6", "name": "search_memory", "arguments": "[1, 2]"},
         {"has_memory": True}),
        # A tool this service does not implement.
        ({"call_id": "c7", "name": "future_web_search", "arguments": "{}"}, {}),
        # `view_board` with nothing on the board.
        ({"call_id": "c8", "name": "view_board", "arguments": "{}"}, {}),
    ]
    items = []
    for call, flags in calls:
        answer = _answer(
            call, provider=provider, has_board=flags.get("has_board", False),
            has_memory=flags.get("has_memory", False),
            has_image=flags.get("has_image", False),
        )
        assert answer.items is not None, call["name"]
        items.extend(answer.items)
    return items


def test_a_first_round_validates_with_no_unknown_step_tool_or_content():
    """The guard that was missing, at the round where the tools are sent.

    `test_every_recorded_event_decodes_to_the_shape_the_provider_reads` validates
    recorded *events* against the SDK. Nothing validated a *built request*, and
    that asymmetry is exactly the hole `loop._answer` fell through for nine
    reviews: an item in the wrong family's vocabulary is not a 422 anywhere in
    this repository, it is an `UnknownStep` the provider silently posts.

    `tools` rides in the same payload, so this covers the whole converted
    declaration set against `UnknownTool` too — which no other test does.
    """
    provider = GeminiProvider(client=None)
    payload = provider.build_round(
        model="gemini-3.7-pro", effort="high", previous_id=None, cache_key=None,
        outbox=[
            {"role": "system", "content": "be a tutor"},
            {"role": "user", "content": [
                {"type": "input_text", "text": "what is 7 times 8?"},
                {"type": "input_image",
                 "image_url": "data:image/png;base64," + INLINE_IMAGE_BASE64,
                 "detail": "low"},
            ]},
        ],
    )

    assert _validated(payload) == []
    assert payload["tools"] is GEMINI_TOOLS, "the real declarations, not a stub"


def test_every_answer_a_tool_round_can_send_validates_as_a_function_result():
    """**Fix 1's proof.** All seven `_answer` replies, in a real later round.

    Each one used to be a literal `{"type": "function_call_output", …}` — the
    Responses API's shape — which `gemini._input_item` passes through untouched
    because it already carries a `type`. `CreateModelInteraction` then resolves
    every one of them to an `UnknownStep`, and `update_board` and
    `set_workspace` are the two tools the tutor uses most: every Gemini turn
    that drew anything was malformed from round two onwards.

    Asserted as `FunctionResultStep` by name and not merely as "no unknowns",
    because a step that validated as some *other* known type would be just as
    wrong and would pass the walk.
    """
    from google.genai.interactions import (
        CreateModelInteraction, FunctionResultStep,
    )

    provider = GeminiProvider(client=None)
    outbox = _every_answer_shape(provider)
    payload = provider.build_round(
        model="gemini-3.7-pro", effort="high", outbox=outbox,
        previous_id="v1_earlier_round", cache_key=None,
    )

    assert _validated(payload) == []
    steps = CreateModelInteraction.model_validate(payload).input
    assert len(steps) == 8, "one reply per call, and none folded together"
    for step, item in zip(steps, outbox):
        assert isinstance(step, FunctionResultStep), item
        assert step.call_id == item["call_id"]
        # The name travels, because a `function_result` whose name disagrees
        # with its call is a 400 on this API.
        assert step.name == item["name"]


def test_a_round_carrying_pictures_validates_as_user_input_with_images():
    """The other half of a later round, and the only mechanical cover the image
    shapes have: no recorded fixture carries a request that returns a picture.

    Three producers, because all three build an item this provider invented
    rather than translated — the board render answering `view_board`, a fetched
    picture, and the files a hosted script wrote.
    """
    provider = GeminiProvider(client=None)
    png = base64.b64decode(INLINE_IMAGE_BASE64)
    rendered = provider.rendered_items("c9", png, "Showing x 0-100%.")
    outbox = [
        *rendered,
        provider.image_item(png, "Here is the image you fetched."),
        provider.relay_item([("chart.png", RelayedFile(
            blob_id="sha256:" + "a" * 64, data=png, content_type="image/png",
        ))]),
    ]
    payload = provider.build_round(
        model="gemini-3.7-pro", effort="high", outbox=outbox,
        previous_id="v1_earlier_round", cache_key=None,
    )

    assert _validated(payload) == []


def test_a_closing_round_validates_after_the_tool_choice_is_moved():
    """`loop._closing_round` puts `tool_choice` at the payload's top level, and
    `_sdk_kwargs` moves it into `generation_config` on the way out. The moved
    shape is what is really posted, so it is the shape that has to validate."""
    from app.tutor.providers.gemini import _sdk_kwargs

    provider = GeminiProvider(client=None)
    payload = provider.build_round(
        model="gemini-3.7-pro", effort="high",
        outbox=_every_answer_shape(provider),
        previous_id="v1_earlier_round", cache_key=None,
    )
    payload["tool_choice"] = "none"

    assert _validated(_sdk_kwargs(payload)) == []


# MARK: - A terminal status may not end a turn quietly


async def _gemini_turn(events):
    """One whole turn against a stream of already-shaped provider events."""
    from app.tutor.context import ContextBundle
    from app.tutor.loop import run_turn

    provider = GeminiProvider(client=None)

    async def open_round(payload):
        return _FakeStream(events)

    provider.open_round = open_round

    collected = []
    result = None
    async for event, running in run_turn(
        provider=provider, model="gemini-3.5-flash-lite", effort="low",
        bundle=ContextBundle(system="be a tutor", input=[
            {"role": "user", "content": [{"type": "input_text", "text": "hi"}]},
        ]),
    ):
        collected.append(event)
        result = running
    return collected, result


def _ended(status: str, usage: dict | None = None) -> tuple[dict, ...]:
    """`TEXT_ONLY_INTERACTION` with its completion restated under one status."""
    completion = dict(TEXT_ONLY_INTERACTION[-1])
    interaction = dict(completion["interaction"])
    interaction["status"] = status
    if usage is not None:
        interaction["usage"] = usage
    completion["interaction"] = interaction
    return TEXT_ONLY_INTERACTION[:-1] + (completion,)


async def test_no_terminal_interaction_status_ends_a_turn_quietly():
    """All four, not just `failed`.

    `run_turn` read `Failed` and never `Completed.status`, and three of the four
    statuses had no code path at all — so an interaction that ended `cancelled`,
    `incomplete` or `budget_exceeded` sent the device `done` and the learner read
    a truncated answer as a finished one. The prose is kept, because whatever
    arrived they have already read; what changes is that the turn says it ended
    badly.
    """
    from app.tutor.events import TURN_FAILED_MESSAGE

    for status in sorted(TERMINAL_ERROR_STATUSES):
        events, result = await _gemini_turn(_ended(status))
        errors = [event for event in events if event.type == "error"]

        assert len(errors) == 1, f"{status} ended the turn quietly"
        assert errors[0].message == TURN_FAILED_MESSAGE, status
        assert errors[0].retryable is True, status
        assert events[-1] is errors[0], f"{status} kept streaming after failing"
        assert result.text == "7 times 8 is 56.", (
            f"{status} threw away the prose the learner had already read"
        )


async def test_a_terminally_ended_round_still_records_what_it_spent():
    """The reason the provider does not convert this into a `Failed`.

    `Failed` carries no usage, and a round that reached `incomplete` or
    `budget_exceeded` spent tokens getting there — so converting would leave that
    spend out of `turns.cost_usd`, which is money nobody can see. The two goals
    were never exclusive: the usage is merged before the failure is yielded.
    """
    for status in sorted(TERMINAL_ERROR_STATUSES):
        _events, result = await _gemini_turn(_ended(status))

        assert result.usage is not None, status
        assert result.usage["input_tokens"] == 10101, status
        assert result.usage["output_tokens"] == 9, status
        assert turn_cost_usd("gemini-3.5-flash-lite", result.usage), status


async def test_a_terminal_status_update_ends_the_turn_too():
    """The only door `budget_exceeded` has.

    The SDK's two status enums are not the same set: `InteractionStatusUpdate`
    admits `budget_exceeded`, and the `interaction` object on
    `interaction.completed` does not. So one of the four statuses can only ever
    arrive on the event this provider used to drop to `None` — and a turn that
    ends there ends with no completion behind it, which is `done` and half an
    answer.
    """
    stream = TEXT_ONLY_INTERACTION[:-1] + ({
        "interaction_id": "v1_text_only",
        "status": "budget_exceeded",
        "event_type": "interaction.status_update",
    },)
    events, result = await _gemini_turn(stream)

    errors = [event for event in events if event.type == "error"]
    assert len(errors) == 1
    assert result.text == "7 times 8 is 56."


def test_an_in_progress_status_update_is_still_nothing():
    """It arrives on every turn recorded, immediately after
    `interaction.created`, saying what `created` already said. Reading it as
    anything would end every turn before it began."""
    provider = GeminiProvider(client=None)

    assert provider.neutral({
        "interaction_id": "v1_text_only", "status": "in_progress",
        "event_type": "interaction.status_update",
    }) is None
    assert provider.neutral({
        "interaction_id": "v1_text_only", "status": "queued",
        "event_type": "interaction.status_update",
    }) is None


# MARK: - What an absent usage key must not do to the running total


async def test_a_second_rounds_empty_usage_leaves_the_first_rounds_tokens():
    """`map_usage` used to materialise every key with `.get`, so a round whose
    usage arrived without the totals read as `input_tokens: None` — and
    `_merge_usage` assigns rather than sums when one side is not a number, so
    that `None` erased the earlier round's count. The recorded turn then cost
    less than it did, in the unsafe direction for `DAILY_SPEND_CAP_USD`."""
    from app.tutor.context import ContextBundle
    from app.tutor.loop import run_turn

    provider = GeminiProvider(client=None)
    streams = [
        _FakeStream(TOOL_CALL_INTERACTION),
        _FakeStream(_ended("completed", usage={})),
    ]

    async def open_round(payload):
        return streams.pop(0)

    provider.open_round = open_round

    result = None
    async for _event, running in run_turn(
        provider=provider, model="gemini-3.5-flash-lite", effort="low",
        bundle=ContextBundle(system="be a tutor", input=[
            {"role": "user", "content": [{"type": "input_text", "text": "plan it"}]},
        ]),
    ):
        result = running

    first = TOOL_CALL_INTERACTION[-1]["interaction"]["usage"]
    assert first["total_input_tokens"] > 0, "the fixture has to count something"
    # Round two reported an empty usage, so the turn's totals are round one's,
    # unchanged. They used to be `None`.
    assert result.usage["input_tokens"] == first["total_input_tokens"]
    assert result.usage["output_tokens"] == first["total_output_tokens"]


def test_map_usage_omits_a_key_the_provider_did_not_send():
    """Absence, not `None`. The OpenAI family passes the provider's dict
    through, so an unreported key is simply missing there — and that is what
    `_merge_usage` is safe against."""
    mapped = map_usage({})

    assert "input_tokens" not in mapped
    assert "output_tokens" not in mapped
    assert "tool_use_tokens" not in mapped
    assert mapped["input_tokens_details"] == {}
    assert mapped["output_tokens_details"] == {}
    # Never absent and never None: `_searches` answers 0 for a round that
    # grounded nothing, and 0 added to a running total changes nothing.
    assert mapped["grounding_tool_count"] == 0


def test_merging_an_empty_usage_over_a_counted_one_keeps_the_counts():
    """The mechanism, in isolation from any stream."""
    from app.tutor.loop import _merge_usage

    first = map_usage({
        "total_input_tokens": 1000, "total_output_tokens": 200,
        "grounding_tool_count": [{"count": 2, "type": "google_search"}],
    })
    merged = _merge_usage(first, map_usage({}))

    assert merged["input_tokens"] == 1000
    assert merged["output_tokens"] == 200
    assert merged["grounding_tool_count"] == 2


# MARK: - A picture kept and not shown


def test_a_kept_but_unshown_picture_is_marked_on_both_families():
    """`fetch_image.model_copy` refuses to decode past its own ceiling, so a
    chart can be downloaded, blob-stored and named to the model with no picture
    beside it — and `chart.png → blob_abc` is indistinguishable from a line whose
    picture follows. The OpenAI provider marks the line and appends
    `PICTURE_NOT_SHOWN_NOTE`; the Gemini one did not, so the same chart was
    handed over silently and described from its filename."""
    from app.tutor.providers import PICTURE_NOT_SHOWN_NOTE

    withheld = [("chart.png", RelayedFile(
        blob_id="sha256:" + "a" * 64, data=None, content_type="image/png",
    ))]

    for provider in (OpenAIProvider(client=None), GeminiProvider(client=None)):
        item = provider.relay_item(withheld)
        text = json.dumps(item)

        assert PICTURE_NOT_SHOWN_NOTE in text, provider.name
        assert "not shown" in text, provider.name
        assert "sha256:" in text, f"{provider.name} dropped the blob id"

    # And a CSV — a file that never had a picture — says nothing about one.
    kept = [("data.csv", RelayedFile(
        blob_id="sha256:" + "b" * 64, data=b"a,b\n1,2\n", content_type="text/csv",
    ))]
    for provider in (OpenAIProvider(client=None), GeminiProvider(client=None)):
        assert PICTURE_NOT_SHOWN_NOTE not in json.dumps(
            provider.relay_item(kept)
        ), provider.name


# MARK: - The seam's declared signatures


def test_both_providers_classify_with_the_signature_the_protocol_declares():
    """`isinstance(…, Provider)` cannot check this, and that is the point.

    A `runtime_checkable` Protocol tests for member *presence* and never for a
    signature, so both providers satisfied `Provider` while the protocol declared
    `classify(status_code: int, body)` and `GeminiProvider` took a third
    parameter. `retry.classify` had been widened underneath all three. This is
    the check that isinstance is not.
    """
    import inspect

    from app.tutor import retry

    expected = inspect.signature(retry.classify).parameters
    for owner in (Provider, OpenAIProvider, GeminiProvider):
        actual = inspect.signature(owner.classify).parameters
        assert list(actual)[1:] == list(expected), owner.__name__
        for name in expected:
            # Compared as text, because `from __future__ import annotations` is
            # set in some of these modules and not in others, so one side is a
            # string where the other is an evaluated type.
            assert _annotation(actual[name]) == _annotation(expected[name]), (
                f"{owner.__name__}.{name}"
            )
        assert actual["message"].default is None, (
            f"{owner.__name__}.message has to stay optional"
        )


def _annotation(parameter) -> str:
    """One parameter's annotation as text, however the module spells it."""
    annotation = parameter.annotation
    return annotation if isinstance(annotation, str) else str(annotation)
