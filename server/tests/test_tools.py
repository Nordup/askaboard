from app.tutor.tools import SET_WORKSPACE_TOOL, TOOL_DEFINITIONS


def test_the_registry_exposes_exactly_one_tool_today():
    assert TOOL_DEFINITIONS == [SET_WORKSPACE_TOOL]


def test_the_tool_is_strict_and_closed():
    assert SET_WORKSPACE_TOOL["strict"] is True
    assert SET_WORKSPACE_TOOL["parameters"]["additionalProperties"] is False


def test_both_halves_are_required_and_neither_is_nullable():
    params = SET_WORKSPACE_TOOL["parameters"]
    assert set(params["required"]) == {"plan", "exercise"}
    assert params["properties"]["plan"]["type"] == "object"
    assert params["properties"]["exercise"]["type"] == "object"


def test_plan_and_exercise_keep_the_swift_field_names():
    props = SET_WORKSPACE_TOOL["parameters"]["properties"]
    assert set(props["plan"]["required"]) == {
        "title", "goal", "outcomes", "steps", "currentStep",
    }
    assert set(props["exercise"]["required"]) == {"title", "prompt", "hint", "context"}
