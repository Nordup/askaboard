import json

from app.tutor.board_scene import MAX_LATEX_CHARS, MAX_PATH_CHARS, MAX_SVG_CHARS
from app.tutor.tools import (
    FETCH_IMAGE_TOOL,
    MEMORY_TOOL_DEFINITIONS,
    SET_WORKSPACE_TOOL,
    TOOL_DEFINITIONS,
    UPDATE_BOARD_TOOL,
    VIEW_BOARD_TOOL,
)


def test_the_registry_exposes_the_function_tools_then_the_hosted_ones():
    """Order is the whole assertion: the hosted tools come last, after every
    function tool, because the list is one cache prefix and a tool inserted in
    the middle of it re-bills every prompt this service sends."""
    assert TOOL_DEFINITIONS == [
        SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL, FETCH_IMAGE_TOOL,
        *MEMORY_TOOL_DEFINITIONS,
        {"type": "web_search"},
    ]


def test_a_hosted_tool_carries_no_function_schema():
    """`web_search` runs on the provider, so it has no name, no description and
    no parameters of ours. Anything walking the registry for those must say
    which entries it means — see `_function_tools` in the memory tests."""
    hosted = [tool for tool in TOOL_DEFINITIONS if tool.get("type") != "function"]
    assert hosted == [{"type": "web_search"}]
    for tool in hosted:
        assert set(tool) == {"type"}


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
        "math_text", "image", "svg",
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


def test_update_board_image_arm_places_a_blob_the_server_already_holds():
    """A model that invents a key places a picture nobody has. The pattern is
    the one `GET /v1/blobs/{key}` gates, so a made-up id cannot even be sent."""
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    image = next(arm for arm in arms if arm["properties"]["kind"]["const"] == "image")

    assert {"id", "kind", "x", "y", "width", "height", "blob_id"}.issubset(
        set(image["required"])
    )
    assert image["properties"]["blob_id"]["pattern"] == r"^sha256:[0-9a-f]{64}$"
    description = image["properties"]["blob_id"]["description"]
    assert "tool result" in description
    assert "never invent" in description.lower()
    # Schema-legal sizes are all sizes the scene model accepts: it refuses a
    # frame of zero, and nothing useful is drawn in under a board point.
    for axis in ("width", "height"):
        assert image["properties"][axis]["minimum"] == 1
        assert image["properties"][axis]["maximum"] == 50000


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
    """Every request carries all eleven tools, in every round of every turn.

    Constant, so it caches — but it is also read by the model on each of those
    requests, and it is the floor under every prompt the service sends. The
    bound is generous; it is here to catch a schema that quietly doubles.

    The bound was 24,000 when the registry held seven tools. The memory rework
    added four more and took the surface past it without moving the number, so
    the guard sat red and guarded nothing; `path` and `math_text` then added
    two arms. 30,000 re-baselined it against the surface that then existed —
    about 28,100 characters — with room to spare and none to waste.
    """
    # The board rework (docs/superpowers/plans/2026-08-15-board-rework.md)
    # grows this further: an `image` arm, `fetch_image`, `web_search`, and the
    # code interpreter each add to the surface, and the prompt flip rewrites
    # the descriptions. Every task that pushes past this number raises it in
    # its own commit, having read what the extra bytes bought — never blindly,
    # because a bound nobody looks at is the state this line just came out of.
    #
    # The `image` arm (task 12) cost 1,249 characters — five fields, of which
    # `blob_id` carries the rule that a key is copied from a tool result and
    # never invented — and took the surface to 29,362. That left 638 under
    # 30,000, less than one description edit, so the bound moved to 30,400:
    # about a thousand characters of room, which is under the ~1,100 that the
    # cheapest of this plan's new arms cost. A rewritten description fits; a
    # fifteenth primitive does not, and trips this line.
    #
    # `fetch_image` (task 13) cost 820 — one string property, and a description
    # carrying the two things the model cannot see for itself: that the answer
    # is a `blob_id` for `update_board`, and that a page URL is not an image
    # URL. That took the surface to 30,184 and left 216 under 30,400, which is
    # less than one sentence and would have made the *next* commit trip this
    # line for no reason of its own. So the bound moves to 31,200 on the same
    # reasoning the last raise used: about a thousand characters of room, which
    # is still under what any new tool in this plan costs.
    #
    # `web_search` (task 15) cost 24 — the whole tool is `{"type":
    # "web_search"}`, because the provider owns its schema and its execution.
    # The surface went to 30,208, absorbed inside the room the last raise left,
    # so the bound does not move. That is what a hosted tool is worth here: the
    # ability to look something up, for a rounding error against the ~1,100 the
    # cheapest function tool in this plan costs.
    assert len(json.dumps(TOOL_DEFINITIONS)) < 31_200


def test_fetch_image_is_strict_closed_and_takes_one_url():
    assert FETCH_IMAGE_TOOL["strict"] is True
    params = FETCH_IMAGE_TOOL["parameters"]
    assert params["additionalProperties"] is False
    assert set(params["properties"]) == {"url"}
    assert params["required"] == ["url"]
    assert params["properties"]["url"]["type"] == "string"


def test_fetch_image_says_what_comes_back_and_what_will_be_refused():
    """The model cannot see the guards, so the description is the only place it
    learns that an `http://` link or a page URL is a wasted round."""
    description = FETCH_IMAGE_TOOL["description"]
    assert "https" in description
    assert "blob_id" in description
    assert "update_board" in description
