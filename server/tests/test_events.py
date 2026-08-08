import json

from app.tutor.events import (
    BoardUpdateEvent, EventTranslator, ReasoningDeltaEvent, StatusEvent,
    TextDeltaEvent, WorkspaceEvent,
)

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
    assert len(events) == 1
    assert isinstance(events[0], WorkspaceEvent)
    assert events[0].plan.title == "Radical equations"
    assert events[0].exercise.prompt.startswith("Solve")


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
    assert events == []


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

    assert len(events) == 1
    assert isinstance(events[0], BoardUpdateEvent)
    assert events[0].payload.deletes == ["old"]
    assert events[0].payload.upserts[0].id == "a"
    assert events[0].payload.upserts[0].kind == "line"


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
        "arguments": json.dumps({
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
        }),
    })

    assert len(events) == 1
    assert isinstance(events[0], BoardUpdateEvent)
    svg = events[0].payload.upserts[0]
    assert svg.kind == "svg"
    assert svg.svg == RAW_SVG_DOCUMENT

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
    assert events == []


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
    assert len(events) == 1
    assert isinstance(events[0], WorkspaceEvent)


def test_file_search_emits_searching_status():
    events = EventTranslator().translate({"type": "response.file_search_call.searching"})
    assert events == [StatusEvent(phase="searching")]


def test_unknown_events_are_ignored():
    assert EventTranslator().translate({"type": "response.content_part.added"}) == []
