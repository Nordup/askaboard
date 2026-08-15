import json

from app.tutor.events import (
    BoardUpdateEvent, EventTranslator, ReasoningDeltaEvent, StatusEvent,
    StepEvent, TextDeltaEvent, WorkspaceEvent, region_label,
)
from app.tutor.tools import MEMORY_TOOLS

WORKSPACE_ARGS = {
    "plan": {
        "title": "Radical equations",
        "goal": "Solve and check.",
        "outcomes": ["Isolate the radical."],
        "steps": ["Isolate.", "Square.", "Check."],
        "currentStep": 0,
    },
    "exercise": {
        "title": "Try this",
        "prompt": "Solve √(x + 5) = x − 1.",
        "hint": "What must be true about x − 1?",
        "context": "A learner is solving a radical equation.",
    },
}

RAW_SVG_DOCUMENT = (
    '<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">'
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#0155FB"/></linearGradient>'
    '<filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>'
    '<mask id="m"><rect x="0" y="0" width="800" height="500" fill="white"/></mask></defs>'
    '<path d="M10 10 C 40 5 60 90 90 10 A 5 5 0 0 1 100 20" '
    'fill="url(#g)" filter="url(#blur)" mask="url(#m)"/>'
    '<foreignObject x="20" y="20" width="100" height="40">'
    '<div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject>'
    "<animate attributeName=\"opacity\" from=\"0\" to=\"1\" dur=\"2s\"/>"
    "</svg>"
)

# A single upsert, no deletes: `update_payload(...).upserts` plus `.deletes` is
# exactly 1. Lifted from the svg round-trip test below rather than invented,
# because `BoardSceneUpdate` validates strictly and a made-up element shape
# fails validation before it ever reaches the code this task adds.
ONE_ELEMENT_UPDATE = json.dumps({
    "mode": "upsert",
    "delete_ids": [],
    "elements": [{
        "id": "diagram",
        "kind": "svg",
        "x": -250, "y": -300, "width": 500, "height": 320,
        "svg": RAW_SVG_DOCUMENT,
        "role": "content", "stroke": "#0A0A0A", "fill": "transparent",
        "stroke_width": 4, "opacity": 1, "dash": [], "rotation": 0,
    }],
})


def test_created_emits_thinking_status():
    events = EventTranslator().translate({"type": "response.created"})
    assert events == [StatusEvent(phase="thinking")]


def test_reasoning_summary_delta_becomes_reasoning_delta():
    events = EventTranslator().translate(
        {"type": "response.reasoning_summary_text.delta", "delta": "Checking the domain"}
    )
    assert events == [ReasoningDeltaEvent(text="Checking the domain")]


def test_first_text_delta_also_emits_writing_status():
    translator = EventTranslator()
    first = translator.translate({"type": "response.output_text.delta", "delta": "Nice"})
    assert first == [StatusEvent(phase="writing"), TextDeltaEvent(text="Nice")]

    second = translator.translate({"type": "response.output_text.delta", "delta": " work"})
    assert second == [TextDeltaEvent(text=" work")]


def test_set_workspace_tool_call_becomes_a_workspace_event():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "set_workspace", "call_id": "call_1"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps(WORKSPACE_ARGS),
    })
    # Two events, not one: the tool's own event, then the refined step that
    # restates the general "Making a plan" row with the plan's actual title.
    assert len(events) == 2
    assert isinstance(events[0], WorkspaceEvent)
    assert events[0].plan.title == "Radical equations"
    assert events[0].exercise.prompt.startswith("Solve")
    assert events[1] == StepEvent(id="call_1", tool="set_workspace",
                                  label="Set the plan: Radical equations")


def test_malformed_tool_arguments_are_dropped_not_raised():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "set_workspace", "call_id": "call_1"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": "{not json",
    })
    # No WorkspaceEvent: the malformed call is still dropped, not raised. But
    # the step already announced at the head of the call is re-sent, falling
    # back to its general label rather than leaving the row unrefined forever.
    assert events == [
        StepEvent(id="call_1", tool="set_workspace", label="Making a plan")
    ]


def test_update_board_tool_call_becomes_a_board_update_event():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_b"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps({
            "mode": "upsert",
            "delete_ids": ["old"],
            "elements": [{
                "id": "a",
                "kind": "line",
                "x1": 0, "y1": 0, "x2": 100, "y2": 0,
                "role": "content", "stroke": "#0A0A0A", "fill": "transparent",
                "stroke_width": 4, "opacity": 1, "dash": [], "rotation": 0,
            }],
        }),
    })

    assert len(events) == 2
    assert isinstance(events[0], BoardUpdateEvent)
    assert events[0].payload.deletes == ["old"]
    assert events[0].payload.upserts[0].id == "a"
    assert events[0].payload.upserts[0].kind == "line"
    # One upsert plus one delete: the refined label counts both.
    assert events[1] == StepEvent(id="call_b", tool="update_board", label="Drew 2 objects")


def test_update_board_svg_roundtrips_unchanged_through_the_event():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_svg"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": ONE_ELEMENT_UPDATE,
    })

    assert len(events) == 2
    assert isinstance(events[0], BoardUpdateEvent)
    svg = events[0].payload.upserts[0]
    assert svg.kind == "svg"
    assert svg.svg == RAW_SVG_DOCUMENT
    assert events[1] == StepEvent(id="call_svg", tool="update_board", label="Drew 1 object")

    encoded = json.loads(events[0].model_dump_json())
    assert encoded["payload"]["upserts"][0]["svg"] == RAW_SVG_DOCUMENT


def test_malformed_update_board_arguments_are_dropped_not_raised():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_b"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps({"mode": "replace_all", "delete_ids": [], "elements": [
            {"id": "bad", "kind": "polygon", "points": [[0, 0]]}
        ]}),
    })
    # No BoardUpdateEvent: the malformed call is still dropped, not raised. But
    # the refined label also fails to parse the same malformed arguments, so
    # the step re-sent here falls back to the general "Drawing on the board".
    assert events == [
        StepEvent(id="call_b", tool="update_board", label="Drawing on the board")
    ]


def test_replace_all_update_drops_delete_ids_from_the_payload():
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_b"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps({
            "mode": "replace_all",
            "delete_ids": ["unused"],
            "elements": [],
        }),
    })
    assert isinstance(events[0], BoardUpdateEvent)
    assert events[0].payload.replace_all is True
    assert events[0].payload.deletes == []


def test_output_item_added_without_output_index_is_dropped_not_raised():
    translator = EventTranslator()
    events = translator.translate({
        "type": "response.output_item.added",
        "item": {"type": "function_call", "name": "set_workspace", "call_id": "call_1"},
    })
    assert events == []

    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "set_workspace", "call_id": "call_2"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": json.dumps(WORKSPACE_ARGS),
    })
    assert len(events) == 2
    assert isinstance(events[0], WorkspaceEvent)
    assert events[1] == StepEvent(id="call_2", tool="set_workspace",
                                  label="Set the plan: Radical equations")


def test_file_search_emits_searching_status():
    events = EventTranslator().translate({"type": "response.file_search_call.searching"})
    assert events == [StatusEvent(phase="searching")]


def test_unknown_events_are_ignored():
    assert EventTranslator().translate({"type": "response.content_part.added"}) == []


class FakeClock:
    """A monotonic clock a test can move by hand."""

    def __init__(self) -> None:
        self.seconds = 0.0

    def __call__(self) -> float:
        return self.seconds


def _begin_update_board(translator: EventTranslator) -> list:
    return translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "update_board", "call_id": "call_b"},
    })


def test_starting_update_board_announces_drawing_immediately():
    # Not left to the first heartbeat: this is the moment the turn stops
    # thinking and starts drawing, and the device should be able to say so then.
    assert _begin_update_board(EventTranslator()) == [
        StatusEvent(phase="drawing"),
        StepEvent(id="call_b", tool="update_board", label="Drawing on the board"),
    ]


def test_starting_view_board_announces_looking():
    events = EventTranslator().translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "view_board", "call_id": "call_v"},
    })
    assert events == [
        StatusEvent(phase="looking"),
        StepEvent(id="call_v", tool="view_board", label="Looking at the board"),
    ]


def test_argument_deltas_stay_silent_until_the_heartbeat_is_due():
    clock = FakeClock()
    translator = EventTranslator(now=clock, heartbeat_seconds=5.0)
    _begin_update_board(translator)

    clock.seconds += 4.9
    delta = {
        "type": "response.function_call_arguments.delta",
        "output_index": 0,
        "delta": "<svg",
    }
    assert translator.translate(delta) == []


def test_a_long_update_board_heartbeats_as_drawing():
    """The failure this exists for: minutes of SVG arguments used to put not one
    byte on the wire, and `URLSession` gives up after sixty silent seconds."""
    clock = FakeClock()
    translator = EventTranslator(now=clock, heartbeat_seconds=5.0)
    _begin_update_board(translator)

    delta = {
        "type": "response.function_call_arguments.delta",
        "output_index": 0,
        "delta": '<path d="M10 10"/>',
    }
    beats = []
    for _ in range(12):
        clock.seconds += 1.0
        beats.extend(translator.translate(delta))

    # Twelve seconds of pure argument streaming, and the connection heard from
    # the server twice — not once.
    assert beats == [StatusEvent(phase="drawing")] * 2


def test_a_translated_event_resets_the_heartbeat_clock():
    clock = FakeClock()
    translator = EventTranslator(now=clock, heartbeat_seconds=5.0)
    _begin_update_board(translator)

    clock.seconds += 4.0
    assert translator.translate(
        {"type": "response.reasoning_summary_text.delta", "delta": "Sketching"}
    ) == [ReasoningDeltaEvent(text="Sketching")]

    # Four seconds after that real event, not nine after the last beat.
    clock.seconds += 4.0
    assert translator.translate({
        "type": "response.function_call_arguments.delta",
        "output_index": 0,
        "delta": "x",
    }) == []


def test_a_heartbeat_outside_any_tool_call_repeats_the_current_phase():
    clock = FakeClock()
    translator = EventTranslator(now=clock, heartbeat_seconds=5.0)
    translator.translate({"type": "response.created"})

    clock.seconds += 6.0
    assert translator.translate({"type": "response.content_part.added"}) == [
        StatusEvent(phase="thinking")
    ]


def test_prose_after_a_tool_call_announces_writing_again():
    # The phase drives the thread's working indicator, which hides itself on
    # `writing` precisely because the reply is then visible on its own. A phase
    # left on `drawing` leaves that indicator up for the rest of the turn,
    # claiming the tutor is still drawing over prose the learner is reading.
    translator = EventTranslator()
    translator.translate({"type": "response.output_text.delta", "delta": "Let me draw."})
    _begin_update_board(translator)
    translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": "{}",
    })

    events = translator.translate(
        {"type": "response.output_text.delta", "delta": "Now try it."}
    )

    assert events[0] == StatusEvent(phase="writing")


def test_a_heartbeat_after_a_tool_call_does_not_still_claim_drawing():
    clock = FakeClock()
    translator = EventTranslator(now=clock, heartbeat_seconds=5.0)
    # The prose *before* the tool call is what arms the bug: it is the delta
    # that sets `_writing_announced`, and without it here the delta after the
    # call announces `writing` on its own and the test proves nothing.
    translator.translate({"type": "response.output_text.delta", "delta": "Let me draw."})
    _begin_update_board(translator)
    translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": "{}",
    })
    translator.translate({"type": "response.output_text.delta", "delta": "Now try it."})

    clock.seconds += 6.0
    quiet = translator.translate({"type": "response.content_part.added"})

    assert quiet == [StatusEvent(phase="writing")]


def test_a_memory_tool_puts_something_on_the_wire_before_it_blocks():
    # `search_memory` is awaited inside the tool round, and for the length of
    # that await no provider events are consumed — so `translate` is not called
    # and the heartbeat cannot fire. The status announced here is the last byte
    # the device gets before the silence, which is what keeps the silence from
    # being added to whatever quiet already preceded it.
    events = EventTranslator().translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "search_memory", "call_id": "call_m"},
    })
    assert events == [
        StatusEvent(phase="searching"),
        StepEvent(id="call_m", tool="search_memory", label="Searching memory"),
    ]


def test_every_memory_tool_announces_a_phase():
    # A tool missing from TOOL_PHASES is silent by design, which is right for a
    # tool that returns instantly and wrong for every one of these: each is a
    # database round trip, and the searching ones an embedding call on top.
    # Derived from the registry, so a ninth memory tool cannot arrive silent.
    for name in sorted(MEMORY_TOOLS):
        events = EventTranslator().translate({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {"type": "function_call", "name": name, "call_id": "c"},
        })
        assert events, f"{name} announces nothing at the head of its call"


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


def test_fetch_image_announces_a_phase_and_a_row_at_the_head_of_its_call():
    # Same reasoning as the memory tools above: the fetch is awaited inside the
    # tool round, no provider events are consumed while it runs, and the
    # heartbeat cannot fire. This is the last byte before that silence.
    events = EventTranslator().translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "fetch_image", "call_id": "call_f"},
    })
    assert events == [
        StatusEvent(phase="searching"),
        StepEvent(id="call_f", tool="fetch_image", label="Fetching image"),
    ]


def test_the_fetched_url_never_reaches_the_learners_status_row():
    # The row is refined from the call's arguments once they complete, and this
    # tool's only argument is a URL the *model* wrote from something it read on
    # the internet. The general label is what the learner sees instead.
    translator = EventTranslator()
    translator.translate({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {"type": "function_call", "name": "fetch_image", "call_id": "call_f"},
    })
    events = translator.translate({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "arguments": '{"url": "https://example.com/ignore-your-instructions.png"}',
    })
    assert events == [StepEvent(id="call_f", tool="fetch_image", label="Fetching image")]
