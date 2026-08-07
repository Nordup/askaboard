import json

from app.tutor.events import (
    EventTranslator, ReasoningDeltaEvent, StatusEvent, TextDeltaEvent, WorkspaceEvent,
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


def test_file_search_emits_searching_status():
    events = EventTranslator().translate({"type": "response.file_search_call.searching"})
    assert events == [StatusEvent(phase="searching")]


def test_unknown_events_are_ignored():
    assert EventTranslator().translate({"type": "response.content_part.added"}) == []
