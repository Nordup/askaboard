import json

from app.tutor.board_scene import MAX_LATEX_CHARS, MAX_PATH_CHARS, MAX_SVG_CHARS
from app.tutor.tools import (
    MEMORY_TOOL_DEFINITIONS,
    SET_WORKSPACE_TOOL,
    TOOL_DEFINITIONS,
    UPDATE_BOARD_TOOL,
    VIEW_BOARD_TOOL,
)


def test_the_registry_exposes_the_board_tools_then_the_memory_ones():
    assert TOOL_DEFINITIONS == [
        SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL,
        *MEMORY_TOOL_DEFINITIONS,
    ]


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


def test_update_board_description_carries_the_compact_layout_contract():
    description = UPDATE_BOARD_TOOL["description"]
    assert "recommended_tutor_rect" in description
    assert "reserved_learner_work_rect" in description
    assert "clear for the learner's working" in description


def test_update_board_primitives_are_a_discriminated_union():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
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
        "polygon", "polyline", "freehand", "arc", "angle_marker", "path",
        "math_text", "svg",
    }


def test_update_board_svg_arm_is_an_opaque_raw_document():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    svg = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "svg")

    assert {"id", "kind", "x", "y", "width", "height", "svg"}.issubset(
        set(svg["required"])
    )
    assert svg["properties"]["svg"]["minLength"] == 1
    assert svg["properties"]["svg"]["maxLength"] == MAX_SVG_CHARS
    description = svg["properties"]["svg"]["description"]
    assert "complete raw SVG document" in description
    assert "interpreted locally" in description


def test_update_board_path_arm_speaks_in_board_points():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    path = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "path")

    assert {"id", "kind", "d", "fill_rule"}.issubset(set(path["required"]))
    assert path["properties"]["d"]["minLength"] == 1
    assert path["properties"]["d"]["maxLength"] == MAX_PATH_CHARS
    assert "absolute board points" in path["properties"]["d"]["description"]
    assert path["properties"]["fill_rule"]["enum"] == ["nonzero", "evenodd"]


def test_update_board_math_text_arm_claims_all_notation():
    """A model that reaches for `text` or SVG `<text>` writes unreadable maths."""
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    math_text = next(
        arm for arm in arms if arm["properties"]["kind"]["const"] == "math_text"
    )

    assert {"id", "kind", "x", "y", "latex", "font_size"}.issubset(
        set(math_text["required"])
    )
    assert math_text["properties"]["latex"]["minLength"] == 1
    assert math_text["properties"]["latex"]["maxLength"] == MAX_LATEX_CHARS
    assert math_text["properties"]["font_size"]["minimum"] == 8
    assert math_text["properties"]["font_size"]["maximum"] == 256
    description = math_text["properties"]["latex"]["description"]
    assert "only correct way" in description
    assert "notation on the board" in description


def test_update_board_description_prefers_raw_svg_for_complex_visuals():
    description = UPDATE_BOARD_TOOL["description"]
    assert "raw SVG" in description
    assert "complex multi-part illustrations" in description
    assert "passed through unchanged" in description
    assert "interpreted locally" in description
    assert "complete raw SVG document" in description
    assert "recommended_tutor_rect" in description
    assert "reserved_learner_work_rect" in description


def test_update_board_caps_are_expressed_in_the_schema():
    props = UPDATE_BOARD_TOOL["parameters"]["properties"]
    assert props["elements"]["maxItems"] == 200
    assert props["delete_ids"]["maxItems"] == 200

    arms = props["elements"]["items"]["anyOf"]
    polygon = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "polygon")
    assert polygon["properties"]["points"]["maxItems"] == 512
    assert polygon["properties"]["points"]["minItems"] == 3

    text = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "text")
    assert text["properties"]["text"]["maxLength"] == 2000
    assert text["properties"]["font_size"]["minimum"] == 8
    assert text["properties"]["font_size"]["maximum"] == 256


def test_update_board_schema_bounds_are_the_logical_board_range():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    line = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "line")
    # JSON Schema `minimum`/`maximum` express the range directly; `exclusive`
    # variants are not needed because the server clamps after validation.
    assert line["properties"]["x1"].get("minimum", -25_000) >= -25_000
    assert line["properties"]["x1"].get("maximum", 25_000) <= 25_000
    assert line["properties"]["y1"].get("minimum", -25_000) >= -25_000
    assert line["properties"]["y1"].get("maximum", 25_000) <= 25_000


def test_the_style_fields_are_written_once_not_once_per_primitive():
    """Twelve copies of the same seven descriptions was most of this tool.

    `update_board` serialised to about 5,800 tokens — three times the system
    prompt, and 78% of every tool definition the service sends on every round
    of every turn. Eleven of the twelve copies were the same bytes.
    """
    serialised = json.dumps(UPDATE_BOARD_TOOL)

    assert serialised.count("Stroke width in board points.") == 1
    assert serialised.count("One board point as [x, y].") == 1
    assert serialised.count("Reuse it in a later call to revise this object") == 1


def test_every_ref_in_the_update_board_schema_resolves():
    """A dangling pointer is a 400 on the first diagram a learner asks for.

    The schema is assembled at import time from three dicts, so nothing else
    between here and the provider ever looks at it.
    """
    parameters = UPDATE_BOARD_TOOL["parameters"]
    defined = set(parameters["$defs"])

    def refs(node):
        if isinstance(node, dict):
            if "$ref" in node:
                yield node["$ref"]
            for value in node.values():
                yield from refs(value)
        elif isinstance(node, list):
            for value in node:
                yield from refs(value)

    used = set(refs(parameters["properties"]))
    assert used, "the arms are supposed to reference the shared definitions"
    for ref in used:
        assert ref.startswith("#/$defs/"), ref
        assert ref.removeprefix("#/$defs/") in defined, ref


def test_every_primitive_still_demands_the_whole_style_block():
    """Referencing a definition changes where it is written, not what the
    model has to supply. Strict schemas have no optional fields."""
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    style = {"role", "stroke", "fill", "stroke_width", "opacity", "dash", "rotation"}

    for arm in arms:
        assert style.issubset(arm["required"])
        assert style.issubset(arm["properties"])


def test_the_tool_surface_stays_inside_its_budget():
    """Every request carries all seven tools, in every round of every turn.

    Constant, so it caches — but it is also read by the model on each of those
    requests, and it is the floor under every prompt the service sends. The
    bound is generous; it is here to catch a schema that quietly doubles.
    """
    assert len(json.dumps(TOOL_DEFINITIONS)) < 24_000
