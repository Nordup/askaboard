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
