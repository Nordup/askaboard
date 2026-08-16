import json

from app.tutor.board_scene import (
    MAX_INK_TEXT_CHARS,
    MAX_LATEX_CHARS,
    MAX_PATH_CHARS,
    MAX_SVG_CHARS,
)
from app.tutor.tools import (
    FETCH_IMAGE_TOOL,
    MEMORY_TOOL_DEFINITIONS,
    SET_WORKSPACE_TOOL,
    TOOL_DEFINITIONS,
    UPDATE_BOARD_TOOL,
    VIEW_BOARD_TOOL,
)


def _kinds_of(arm: dict) -> set[str]:
    """Every element kind one arm of the union accepts.

    Two kinds share an arm when their field sets are identical, so the
    discriminator is a `const` on a lone kind and an `enum` on a shared one.
    A test that reaches straight for `["const"]` raises `KeyError` the moment
    it iterates past a shared arm, and whether it does is a matter of which
    arm happens to come first — so it passes or fails on arm order rather
    than on the thing it is asserting.
    """
    discriminator = arm["properties"]["kind"]
    return ({discriminator["const"]} if "const" in discriminator
            else set(discriminator["enum"]))


def test_the_registry_exposes_the_function_tools_then_the_hosted_ones():
    """Order is the whole assertion: the hosted tools come last, after every
    function tool, because the list is one cache prefix and a tool inserted in
    the middle of it re-bills every prompt this service sends."""
    assert TOOL_DEFINITIONS == [
        SET_WORKSPACE_TOOL, VIEW_BOARD_TOOL, UPDATE_BOARD_TOOL, FETCH_IMAGE_TOOL,
        *MEMORY_TOOL_DEFINITIONS,
        {"type": "web_search"},
        {"type": "code_interpreter", "container": {"type": "auto"}},
    ]


def test_a_hosted_tool_carries_no_function_schema():
    """A hosted tool runs on the provider, so it has no name, no description
    and no parameters of ours. Anything walking the registry for those must say
    which entries it means — see `_function_tools` in the memory tests.

    `code_interpreter` carries a `container` and is still hosted: that key is
    configuration for the provider's sandbox, not a schema this service serves.
    The assertion is therefore about the *function* keys being absent, not
    about the entry being a lone `type`."""
    hosted = [tool for tool in TOOL_DEFINITIONS if tool.get("type") != "function"]
    assert hosted == [
        {"type": "web_search"},
        {"type": "code_interpreter", "container": {"type": "auto"}},
    ]
    for tool in hosted:
        assert not {"name", "description", "parameters", "strict"} & set(tool)


def test_the_code_interpreter_container_is_provider_managed():
    """`{"type": "auto"}` is what makes the provider create and own the sandbox
    per response. Naming a container id here instead would pin every learner in
    the deployment to one machine and one filesystem."""
    interpreter = next(
        tool for tool in TOOL_DEFINITIONS if tool.get("type") == "code_interpreter"
    )
    assert interpreter["container"] == {"type": "auto"}


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
    """Sixteen kinds, and fewer than sixteen arms.

    An arm names one kind with `const` and several with `enum`, and it may only
    name several when their field sets are identical: `rectangle` and `ellipse`
    are placed by the same box, and `polyline` and `freehand` by the same open
    chain. What the model may send for each kind is unchanged — the shared arm
    is the schema each of them already had — and `parse_board_update`
    discriminates on the value, which is the same either way. What is saved is
    the copy: one twelve-name `required` list and one style block per arm
    rather than per kind.
    """
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    kinds = {}
    for arm in arms:
        discriminator = arm["properties"]["kind"]
        assert discriminator["type"] == "string"
        named = ([discriminator["const"]] if "const" in discriminator
                 else discriminator["enum"])
        assert named, "an arm must name at least one kind"
        for kind in named:
            assert kind not in kinds, f"duplicate primitive {kind}"
            kinds[kind] = arm
        assert arm["additionalProperties"] is False
        assert "id" in arm["required"]
        assert "kind" in arm["required"]
        assert set(arm["properties"]) == set(arm["required"]), (
            "strict schemas require every property they list"
        )

    assert set(kinds) == {
        "text", "line", "arrow", "rectangle", "ellipse", "circle",
        "polygon", "polyline", "freehand", "arc", "angle_marker", "path",
        "math_text", "ink_text", "image", "svg",
    }


def test_update_board_svg_arm_is_an_opaque_raw_document():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    svg = next(arm for arm in arms if "svg" in _kinds_of(arm))

    assert {"id", "kind", "x", "y", "width", "height", "svg"}.issubset(
        set(svg["required"])
    )
    assert svg["properties"]["svg"]["minLength"] == 1
    assert svg["properties"]["svg"]["maxLength"] == MAX_SVG_CHARS
    description = svg["properties"]["svg"]["description"]
    assert "complete raw SVG document" in description
    assert "interpreted locally" in description


def test_update_board_svg_arm_asks_for_a_viewbox_and_no_frame():
    """The frameless contract, which the model can only learn here.

    The device draws the document's `viewBox` one user unit to one board point
    with its top-left corner at `(x, y)`. A frame is the legacy path — it
    scales the whole figure — so the description has to say what 0 means, or
    the model keeps sizing figures twice and the two sizes fight.
    """
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    svg = next(arm for arm in arms if "svg" in _kinds_of(arm))

    document = svg["properties"]["svg"]["description"]
    assert "viewBox" in document
    assert "board point" in document

    for axis in ("width", "height"):
        frame = svg["properties"][axis]["description"]
        assert "0" in frame, f"{axis} must say what 0 means"
        assert svg["properties"][axis]["minimum"] == 0

    for axis in ("x", "y"):
        assert "viewBox" in svg["properties"][axis]["description"]


def test_update_board_svg_arm_states_the_subset_the_renderer_was_measured_on():
    """This sentence is the only place the model learns what survives the
    renderer. It advertised animation and filters before `SwiftDrawProbeTests`
    ran — the probe pixel-measured masks, filters, clip paths, `<style>` blocks
    and text, and the rest of the list is source-verified — which is how a
    figure comes back missing the half the model was counting on."""
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    svg = next(arm for arm in arms if "svg" in _kinds_of(arm))
    document = svg["properties"]["svg"]["description"]

    for supported in (
        "paths", "gradients", "defs/use", "masks", "clip paths", "`<style>`", "text",
    ):
        assert supported in document, supported
    assert "`<filter>` effects are dropped" in document
    for ignored in ("animation", "scripts", "`<foreignObject>`", "external references"):
        assert ignored in document, ignored
    assert "draw nothing" in document


def test_update_board_path_arm_speaks_in_board_points():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    path = next(arm for arm in arms if "path" in _kinds_of(arm))

    assert {"id", "kind", "d", "fill_rule"}.issubset(set(path["required"]))
    assert path["properties"]["d"]["minLength"] == 1
    assert path["properties"]["d"]["maxLength"] == MAX_PATH_CHARS
    assert "absolute board points" in path["properties"]["d"]["description"]
    assert path["properties"]["fill_rule"]["enum"] == ["nonzero", "evenodd"]


def test_update_board_math_text_arm_claims_all_notation():
    """A model that reaches for `text` or SVG `<text>` writes unreadable maths."""
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    math_text = next(
        arm for arm in arms if "math_text" in _kinds_of(arm)
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


def test_update_board_ink_text_arm_writes_prose_in_the_tutors_own_hand():
    """The kind that draws words rather than typesetting them.

    Two things the model can only learn here, and both are corrections it
    cannot make afterwards. Notation drawn as glyphs is the unreadable output
    `math_text` exists to prevent, and it is now one field name away. And once
    the tutor's own writing looks handwritten, "the handwriting is the
    learner's" stops being true — so the arm says where the boundary moved to:
    the scene lists the tutor's ids, and everything else on the board is theirs.
    """
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    ink = next(arm for arm in arms if "ink_text" in _kinds_of(arm))

    assert {"id", "kind", "x", "y", "text", "size"}.issubset(set(ink["required"]))
    assert ink["properties"]["text"]["minLength"] == 1
    assert ink["properties"]["text"]["maxLength"] == MAX_INK_TEXT_CHARS
    # The same range every other size on the board is written in.
    assert ink["properties"]["size"]["minimum"] == 8
    assert ink["properties"]["size"]["maximum"] == 256

    description = ink["properties"]["text"]["description"]
    assert "handwriting-look ink" in description
    assert "notation still goes in `math_text`" in description
    assert "the learner's work is the writing you did not put there" in description
    # The scene is assembled once, before the first tool call; `view_board`
    # renders the device as it stands now. Without this clause the rule reads
    # as "anything not in the list is theirs", and a tutor that wrote a note
    # this turn then grades its own handwriting as the learner's work.
    assert "plus whatever you have written this turn" in description
    # The device draws from an ASCII glyph table. A model writing in the
    # register the rest of this schema is written in gets "nice _ now try".
    assert "normalised to their ASCII equivalents" in description
    assert "comes out as a placeholder" in description
    for typographic in ("—", "–", "“", "”", "’", "…"):
        assert typographic not in description, (
            f"the description asks for plain text and must model it: {typographic}"
        )


def test_update_board_image_arm_places_a_blob_the_server_already_holds():
    """A model that invents a key places a picture nobody has. The pattern is
    the one `GET /v1/blobs/{key}` gates, so a made-up id cannot even be sent."""
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    image = next(arm for arm in arms if "image" in _kinds_of(arm))

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


def test_update_board_description_names_an_element_kind_for_every_job():
    """The model picks a kind before it reads a single arm, so the choice is
    made here or it is made by guessing. Each clause routes one job: geometry,
    curves, notation, a multi-part figure, a picture it did not draw itself."""
    description = UPDATE_BOARD_TOOL["description"]

    assert "ordinary primitives" in description
    assert "`path` for curves and freeform shapes" in description
    # Words and notation are one field name apart, so the routing between them
    # is stated in the same breath — and `ink_text` carries the frequency the
    # rest of this description only gives to drawing.
    assert "`ink_text` for anything you say in words" in description
    assert "reach for it often" in description
    assert "`math_text` for every piece of mathematical notation" in description
    assert "never plain `text`, never SVG `<text>`" in description
    assert "never symbols built out of primitives" in description
    assert "`svg` for any figure made of several parts" in description
    assert "`width` and `height` sent as 0" in description
    assert "one user unit to one board point" in description
    assert "`image` for a photograph fetched with fetch_image" in description
    assert "a chart a script produced" in description
    assert "blob_id" in description


def test_update_board_description_makes_no_claim_the_renderer_disproved():
    """`SwiftDrawProbeTests` pixel-measured the two features this description
    used to recommend raw SVG *for* — "masks, filters" — and the filter half was
    wrong. It also read as though SVG were only for complex work. A wrong claim
    here is read on every request of every turn.

    Each guard names the stale phrase it is guarding against, not a substring
    that happens to appear inside it: a bare `"filters" not in` would also fire
    on a future sentence that correctly said filter effects are dropped."""
    description = UPDATE_BOARD_TOOL["description"]

    assert "masks, filters" not in description
    assert "complex multi-part illustrations" not in description
    # The style rule the ink renderer retired: tutor objects were "structured
    # text and geometry, never simulated handwriting" until the device learned
    # to draw glyphs. It is a claim about what this tool can do, and `ink_text`
    # makes it false. The storage rule it used to sit beside is a different
    # sentence and stays — see the test below.
    assert "never simulated handwriting" not in description
    # The document contract belongs to the arm that carries the markup, and is
    # asserted there. Saying it twice spends the bytes on every request.
    assert "passed through unchanged" not in description
    # The deleted render-time budget, in every spelling it was ever written in.
    for stale in ("2 seconds", "two seconds", "2-second", "two-second"):
        assert stale not in description, f"no time budget was ever true here: {stale}"


def test_update_board_description_keeps_the_rules_that_protect_learner_work():
    """The drawing guidance was rewritten around these; they were not.

    The PencilKit sentence is the one that had to survive `ink_text`. It reads
    like a style rule and is not one: it is storage. The tutor's writing lives
    in the tutor's scene, so the learner's drawing — and their undo history —
    stays theirs, which is exactly as true now that both hands look the same.
    """
    description = UPDATE_BOARD_TOOL["description"]

    assert "never touches the learner's own PencilKit ink" in description
    assert "theirs stays theirs" in description
    assert "Do not cover or erase learner ink" in description
    assert "Inspect the board with view_board before grading" in description
    assert "do not draw gratuitously" in description
    assert "reuse ids to revise existing content" in description
    assert "recommended_tutor_rect" in description
    assert "reserved_learner_work_rect" in description


def test_update_board_caps_are_expressed_in_the_schema():
    props = UPDATE_BOARD_TOOL["parameters"]["properties"]
    assert props["elements"]["maxItems"] == 200
    assert props["delete_ids"]["maxItems"] == 200

    arms = props["elements"]["items"]["anyOf"]
    polygon = next(arm for arm in arms if "polygon" in _kinds_of(arm))
    assert polygon["properties"]["points"]["maxItems"] == 512
    assert polygon["properties"]["points"]["minItems"] == 3

    text = next(arm for arm in arms if "text" in _kinds_of(arm))
    assert text["properties"]["text"]["maxLength"] == 2000
    assert text["properties"]["font_size"]["minimum"] == 8
    assert text["properties"]["font_size"]["maximum"] == 256


def test_update_board_schema_bounds_are_the_logical_board_range():
    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    line = next(arm for arm in arms if "line" in _kinds_of(arm))
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


def test_each_primitive_demands_exactly_the_style_its_renderer_reads():
    """A listed style field is required; an unlisted one is a field no arm of
    `BoardSceneRenderer` reads.

    Strict schemas have no optional fields, so every name an arm lists is one
    the model spells out on every element it draws — about twenty characters of
    serial, uncached output each. Three of them reached no drawing call:

      * `role` on all sixteen kinds. Decoded, stored, re-encoded, and read by
        nothing (`BoardScene.swift:957, 1002`).
      * `fill` wherever the arm only strokes, or fills in `stroke`'s colour:
        `line`, `arrow`, `polyline`, `freehand`, `arc`, `angle_marker`, and the
        four kinds that composite a bitmap.
      * `stroke_width` on the five kinds that never stroke, whose bounds arms
        take no stroke inset either.

    `stroke` survives everywhere except `image` and `svg`, which paint from a
    bitmap the board's context never colours — `BoardSVGStore` keys its cache
    on the markup's digest alone, so two figures differing only in `stroke`
    share one raster.

    The map below is the verdict, not a restatement of the code: it is written
    out by hand so that a `_board_element(... ignores=...)` edit that quietly
    drops a field the renderer *does* read fails here.
    """
    style = {"stroke", "fill", "stroke_width", "opacity", "dash", "rotation"}
    always = {"opacity", "dash", "rotation"}
    expected = {
        "text": {"stroke"} | always,
        "line": {"stroke", "stroke_width"} | always,
        "arrow": {"stroke", "stroke_width"} | always,
        "rectangle": style,
        "ellipse": style,
        "circle": style,
        "polygon": style,
        "polyline": {"stroke", "stroke_width"} | always,
        "freehand": {"stroke", "stroke_width"} | always,
        "arc": {"stroke", "stroke_width"} | always,
        "angle_marker": {"stroke", "stroke_width"} | always,
        "path": style,
        "math_text": {"stroke"} | always,
        "ink_text": {"stroke"} | always,
        "image": always,
        "svg": always,
    }

    arms = UPDATE_BOARD_TOOL["parameters"]["properties"]["elements"]["items"]["anyOf"]
    for arm in arms:
        discriminator = arm["properties"]["kind"]
        named = ([discriminator["const"]] if "const" in discriminator
                 else discriminator["enum"])
        listed = style & set(arm["properties"])
        for kind in named:
            assert listed == expected[kind], kind
        assert listed <= set(arm["required"]), "a listed field is a required one"

    assert "role" not in json.dumps(UPDATE_BOARD_TOOL), (
        "role is no longer asked for; `BoardStyle` still accepts it"
    )


def test_the_tool_surface_stays_inside_its_budget():
    """Every request carries the whole registry, in every round of every turn.

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
    #
    # `code_interpreter` (task 16) cost 61 — its type plus `{"container":
    # {"type": "auto"}}`, which is the whole of what this service gets to say
    # about a sandbox the provider creates and runs. The surface is now 30,269,
    # leaving 931 under the bound: the same band `web_search` left it in, and
    # still under what the cheapest function tool in this plan costs, so the
    # bound does not move.
    #
    # The frameless `svg` contract (task 8) cost 309 — the `viewBox` sentence
    # in the document description, and what 0 means in `width` and `height`.
    # Those bytes stop the model sizing every figure twice, once in the viewBox
    # and once in a frame that then fought it. The surface is 30,578, leaving
    # 622 under the bound: still room for a sentence, so the bound does not
    # move. The next task to trip this line raises it having read what the
    # bytes bought, which is the whole point of the number.
    #
    # The prompt flip (task 17) cost 503. About 330 of those are the sentence
    # naming which element kind does which job — the one thing no arm can say,
    # because an arm only ever describes itself, and the model picks the kind
    # before it reads one. The rest is the corrected account of what the
    # renderer draws. Both replace claims that were false: the description
    # recommended raw SVG for "masks, filters", and the arm advertised
    # animation. That left the surface on 31,081 and 119 under the old 31,200
    # bound — less than one clause — so the bound moves to 32,000 on the
    # reasoning every raise here has used: about a thousand characters of room,
    # still under the ~1,100 the cheapest function tool in this plan cost. A
    # rewritten sentence fits; a sixteenth primitive does not, and trips this
    # line.
    #
    # Review round 1 then spent 15 net: "clip paths" in the arm's supported
    # list (the probe renders them, and the deleted mask warning was their only
    # other mention), against an opening clause that got shorter as it got
    # broader — the tool is for whenever a visual helps, not only when one is
    # asked for. The surface is 31,096, leaving 904.
    #
    # `ink_text` (docs/superpowers/plans/2026-08-16-ink-text.md) cost 1,625 and
    # trips the 32,000 bound, which is the line working. The arm is 1,403 of
    # that — the most expensive one here, and the price is its `text`
    # description, which has to carry three things no other arm needs to say:
    # that this kind is prose and notation still belongs to `math_text`, that
    # the device draws it rather than typesets it, and how to tell the two
    # hands apart on a board where the tutor's own writing now looks
    # handwritten. The other 210 are the routing sentence gaining a clause and
    # the PencilKit rule gaining the reason it is still true; the retired
    # "never simulated handwriting" claim paid 76 of it back.
    #
    # So the bound moves to 33,800, on the reasoning every raise here has used:
    # about a thousand characters of room — 1,079 over the 32,721 the surface
    # now stands at — which is still under what a new arm costs. A rewritten
    # description fits; a seventeenth primitive does not, and trips this line.
    #
    # Review round 1 then spent 244 net on two corrections to that arm, both of
    # things it stated as true and were not. The scene list is not the whole of
    # what the tutor wrote — this turn's own writing is not in it — and the
    # glyph table is ASCII, so an em dash the model copies from its own prompt
    # comes out of the renderer as a placeholder. The clauses cost 254; the
    # rest came back by writing that description without the typographic
    # punctuation it now asks the model to avoid, which is worth 5 characters
    # per em dash here because `json.dumps` escapes non-ASCII to `\\uXXXX`.
    # The surface is 32,965, leaving 835 — a sentence of room, still far under
    # the 1,647 this arm cost — so the bound does not move.
    #
    # The schema shrink then took 3,226 back, and this is the first time this
    # number has gone down. None of it came out of what the tool can do: 1,448
    # is the two arms that merged (`rectangle`/`ellipse` and
    # `polyline`/`freehand` are each placed by an identical field set, so one
    # arm carried two kinds), and the rest is field descriptions that restated
    # the field name, the unit the description above them already gives, or a
    # sentence stated a second time somewhere the model reads first. The
    # surface is 29,739.
    #
    # So the bound comes down to 30,800, on the reasoning every move here has
    # used: about a thousand characters of room, which is still under what a
    # new arm costs. Left at 33,800 the guard would have gone slack by four
    # thousand characters, which is four descriptions' worth of drift nobody
    # would be asked to justify.
    #
    # Dropping the style fields no renderer reads then took 1,559 more, and
    # none of it out of what the tool can do either: `role` off all sixteen
    # kinds, `fill` off the ten that never fill in a colour the model chose,
    # `stroke_width` off the five that never stroke, and `stroke` off the two
    # that paint from a bitmap the board's context does not colour. What that
    # buys is not really the schema — it is the ~50 characters per element the
    # model no longer writes out, which is serial, uncached output the learner
    # waits through. The surface is 28,180.
    #
    # So the bound comes down again, to 29,200: the same thousand characters of
    # room. `test_each_primitive_demands_exactly_the_style_its_renderer_reads`
    # is what guards the cut itself.
    assert len(json.dumps(TOOL_DEFINITIONS)) < 29_200


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
