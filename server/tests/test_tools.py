from app.tutor.tools import (
    SET_WORKSPACE_TOOL,
    TOOL_DEFINITIONS,
    UPDATE_BOARD_TOOL,
    VIEW_BOARD_TOOL,
)


def test_the_registry_exposes_the_three_tools_today():
    assert TOOL_DEFINITIONS == [SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL]


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


def test_update_board_is_strict_and_closed():
    assert UPDATE_BOARD_TOOL["strict"] is True
    params = UPDATE_BOARD_TOOL["parameters"]
    assert params["additionalProperties"] is False
    assert set(params["required"]) == {"mode", "delete_ids", "elements"}


def test_update_board_primitives_are_a_discriminated_union():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["oneOf"]
    kinds = {}
    for arm in arms:
        kind = arm["properties"]["kind"]["const"]
        assert kind not in kinds, f"duplicate primitive {kind}"
        kinds[kind] = arm
        assert arm["additionalProperties"] is False
        assert "id" in arm["required"]
        assert "kind" in arm["required"]
        assert "role" in arm["required"], "strict schemas require every property"

    assert set(kinds) == {
        "text", "line", "arrow", "rectangle", "ellipse", "circle",
        "polygon", "polyline", "freehand", "arc", "angle_marker",
    }


def test_update_board_caps_are_expressed_in_the_schema():
    props = UPDATE_BOARD_TOOL["parameters"]["properties"]
    assert props["elements"]["maxItems"] == 200
    assert props["delete_ids"]["maxItems"] == 200

    arms = props["elements"]["items"]["oneOf"]
    polygon = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "polygon")
    assert polygon["properties"]["points"]["maxItems"] == 512
    assert polygon["properties"]["points"]["minItems"] == 3

    text = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "text")
    assert text["properties"]["text"]["maxLength"] == 2000
    assert text["properties"]["font_size"]["minimum"] == 8
    assert text["properties"]["font_size"]["maximum"] == 256
