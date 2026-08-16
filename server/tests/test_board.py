"""The board the tutor can look at on its own, now that the device renders it.

The behaviour these pin is the one the learner reported missing twice: typing
"check" reached a tutor with no eyes, and then reached a tutor reading the wrong
half of the board. The cropping moved to the device between those two; what is
left here is the asking.
"""

import asyncio
import base64
import json

import pytest

from app.tutor import board
from app.tutor.board_scene import (
    MAX_FONT_SIZE,
    MAX_LATEX_CHARS,
    MAX_PATH_CHARS,
    MAX_SCENE_CHARS,
    MAX_SVG_CHARS,
    lint_svg,
    parse_board_update,
    update_payload,
)
from app.tutor.loop import (
    MIN_REGION_PERCENT,
    NO_BOARD_ACK,
    UNAVAILABLE_ACK,
    _answer,
    _region_from,
)
# The items answering `view_board` are request-item shapes, so they moved behind
# the provider with the rest of them. What they contain did not change.
from app.tutor.providers.openai import _rendered_items
from app.tutor.rendezvous import (
    BoardUnavailable,
    abandon,
    await_render,
    deliver,
    open_request,
)

TURN = __import__("uuid").UUID("11111111-2222-3333-4444-555555555555")

RAW_SVG_DOCUMENT = (
    '<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">'
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#0155FB"/></linearGradient>'
    '<filter id="blur"><feGaussianBlur stdDeviation="2"/></filter>'
    '<mask id="m"><rect x="0" y="0" width="800" height="500" fill="white"/></mask></defs>'
    '<path d="M10 10 C 40 5 60 90 90 10 A 5 5 0 0 1 100 20" '
    'fill="url(#g)" filter="url(#blur)" mask="url(#m)"/>'
    '<foreignObject x="20" y="20" width="100" height="40">'
    '<div xmlns="http://www.w3.org/1999/xhtml">label</div></foreignObject>'
    '<animate attributeName="opacity" from="0" to="1" dur="2s"/>'
    "</svg>"
)

#: The same figure written in the subset the device actually draws: paths,
#: shapes, groups, transforms, gradients, defs/use, text, CSS `<style>` blocks,
#: clip paths, and masks. `SwiftDrawProbeTests` pixel-measured the `<style>`
#: block, the mask and the text; the rest is source-verified. Nothing here is a
#: warning.
CLEAN_SVG_DOCUMENT = (
    '<svg viewBox="0 0 200 100" xmlns="http://www.w3.org/2000/svg">'
    '<style>.axis { stroke: #0A0A0A; stroke-width: 2 }</style>'
    '<defs><linearGradient id="g"><stop offset="0" stop-color="#0155FB"/></linearGradient>'
    '<mask id="m"><rect x="0" y="0" width="200" height="100" fill="white"/></mask>'
    '<clipPath id="c"><rect x="0" y="0" width="200" height="100"/></clipPath></defs>'
    '<g transform="translate(10 10)" mask="url(#m)" clip-path="url(#c)">'
    '<path class="axis" d="M0 0 L80 40"/>'
    '<circle cx="40" cy="20" r="8" fill="url(#g)"/>'
    "</g><text x=\"0\" y=\"90\">area</text></svg>"
)

#: One blob key of the shape `store/blobs.py` writes and `GET /v1/blobs/{key}`
#: serves: `sha256:` and 64 lowercase hex characters.
BLOB_ID = "sha256:" + "ab12" * 16


#: The style block every strict arm demands, so each fixture below states only
#: the fields its own primitive carries.
_STYLE = {
    "role": "content",
    "stroke": "#0A0A0A",
    "fill": "transparent",
    "stroke_width": 4,
    "opacity": 1,
    "dash": [],
    "rotation": 0,
}


def _svg_element(**overrides):
    element = {
        "id": "diagram",
        "kind": "svg",
        "x": -250,
        "y": -300,
        "width": 500,
        "height": 320,
        "svg": RAW_SVG_DOCUMENT,
        **_STYLE,
    }
    element.update(overrides)
    return element


def _parse_with_svg(**overrides):
    return parse_board_update(json.dumps({
        "mode": "upsert",
        "delete_ids": [],
        "elements": [_svg_element(**overrides)],
    }))


def _update_json(*, kind: str, id: str, **fields) -> str:
    """One styled element in one upsert, as the tool call's raw arguments."""
    element = {"id": id, "kind": kind, **_STYLE}
    element.update(fields)
    return json.dumps({"mode": "upsert", "delete_ids": [], "elements": [element]})


# MARK: - Aiming


def test_a_region_is_taken_as_asked_when_it_is_sane():
    region = _region_from({"x": 10, "y": 20, "width": 30, "height": 40})

    assert (region.x, region.y, region.width, region.height) == (10.0, 20.0, 30.0, 40.0)


def test_a_region_running_off_the_board_is_clamped_back_onto_it():
    """A model asking past the right edge means 'the far end of the work'.
    Answering that with an error spends a whole tool round teaching it
    arithmetic instead of showing it the board."""
    region = _region_from({"x": 90, "y": 90, "width": 50, "height": 50})

    assert region.x + region.width <= 100
    assert region.y + region.height <= 100


def test_a_region_too_small_to_read_is_grown():
    """A sliver of blank paper is what a model reads as 'nothing is written
    here' — the one wrong conclusion this pipeline exists to prevent."""
    region = _region_from({"x": 10, "y": 10, "width": 0.1, "height": 0.1})

    assert region.width >= MIN_REGION_PERCENT
    assert region.height >= MIN_REGION_PERCENT


def test_missing_arguments_fall_back_to_the_whole_board():
    region = _region_from({})

    assert (region.x, region.y, region.width, region.height) == (0.0, 0.0, 100.0, 100.0)


# MARK: - What a tool call plans


def test_view_board_asks_the_device_rather_than_answering_itself():
    """The server holds no board any more. It can only ask."""
    answer = _answer(
        {"call_id": "c1", "name": "view_board", "arguments": json.dumps({"x": 0, "y": 50, "width": 100, "height": 50})},
        has_board=True,
    )

    assert answer.items is None, "nothing can be answered without the device"
    request, region = answer.ask
    assert request.call_id == "c1"
    assert (region.y, region.height) == (50.0, 50.0)
    assert "%" in request.detail


def test_view_board_on_an_empty_board_is_answered_without_asking():
    """A learner can ask 'check this' with an empty canvas, and there is nothing
    to render. Waiting twenty seconds to discover that would be absurd."""
    answer = _answer({"call_id": "c", "name": "view_board", "arguments": "{}"}, has_board=False)

    assert answer.ask is None
    assert json.loads(answer.items[0]["output"])["status"] == "empty"
    assert answer.items[0]["output"] == NO_BOARD_ACK


def test_unparseable_arguments_still_produce_a_request():
    """`_region_from` clamps whatever survives, so a confused model's failure
    mode is a picture it can still use."""
    answer = _answer(
        {"call_id": "c", "name": "view_board", "arguments": "not json at all"},
        has_board=True,
    )

    assert answer.ask is not None


def test_set_workspace_is_still_answered_the_old_way():
    """The new dispatch must not change the tool that already worked."""
    answer = _answer({"call_id": "c", "name": "set_workspace", "arguments": "{}"}, has_board=True)

    assert answer.ask is None
    assert len(answer.items) == 1
    assert json.loads(answer.items[0]["output"])["status"] == "applied"


def test_a_render_reaches_the_model_as_an_output_plus_a_picture():
    """A function output is a string, so the crop cannot ride in it. It arrives
    as the very next thing in context instead."""
    items = _rendered_items("c1", b"\x89PNG-not-really", "Showing x 0-100%.")

    assert [item.get("type") or item.get("role") for item in items] == [
        "function_call_output",
        "user",
    ]
    assert items[0]["call_id"] == "c1", "the API pairs output to call by id"
    image = items[1]["content"][1]
    assert image["type"] == "input_image"
    assert image["image_url"].startswith("data:image/png;base64,")
    assert base64.b64decode(image["image_url"].split(",", 1)[1]) == b"\x89PNG-not-really"


# MARK: - The rendezvous


async def test_a_render_reaches_the_turn_waiting_for_it():
    future = open_request(TURN, "c1")
    assert deliver(TURN, "c1", b"png-bytes") is True

    assert await await_render(future, turn_id=TURN, call_id="c1") == b"png-bytes"


async def test_a_render_nobody_is_waiting_for_is_refused():
    """A late POST after a timeout must not be silently swallowed — the device
    would think it succeeded while the model was told the board was unreadable."""
    assert deliver(TURN, "nobody", b"png") is False


async def test_a_device_that_never_answers_gives_up_rather_than_hanging():
    future = open_request(TURN, "c2")
    with pytest.raises(BoardUnavailable):
        await asyncio.wait_for(
            await_render_with_short_timeout(future, "c2"), timeout=2
        )
    # And the entry is gone, so a reconnecting device cannot leave it behind.
    assert deliver(TURN, "c2", b"late") is False


async def await_render_with_short_timeout(future, call_id):
    import app.tutor.rendezvous as rv

    original = rv.RENDER_TIMEOUT_SECONDS
    rv.RENDER_TIMEOUT_SECONDS = 0.05
    try:
        return await rv.await_render(future, turn_id=TURN, call_id=call_id)
    finally:
        rv.RENDER_TIMEOUT_SECONDS = original


async def test_abandoning_a_request_leaves_nothing_behind():
    open_request(TURN, "c3")
    abandon(TURN, "c3")

    assert deliver(TURN, "c3", b"png") is False


def test_an_unreachable_device_is_told_to_the_model_rather_than_hidden():
    """Silence is what makes it fill the gap from the transcript."""
    payload = json.loads(UNAVAILABLE_ACK)

    assert payload["status"] == "unavailable"
    assert "not seen it" in payload["detail"]


# MARK: - What the model is told before it looks


@pytest.mark.parametrize("has_ink", [True, False])
def test_the_board_note_tells_the_model_whether_there_is_anything_to_look_at(has_ink):
    note = board.describe(has_ink=has_ink)

    if has_ink:
        assert "view_board" in note
    else:
        assert "empty" in note
        assert "do not call `view_board`" in note


def test_a_changed_board_says_the_earlier_description_is_out_of_date():
    """The reported bug. A learner erased four solved problems and finished the
    fifth; the tutor said problems one to four were correct and the fifth was
    unfinished — every word of it lifted from its own earlier reply."""
    note = board.describe(has_ink=True, changed=True)

    assert "HAS CHANGED" in note
    assert "must not be repeated" in note


def test_an_unchanged_board_says_so_rather_than_staying_silent():
    note = board.describe(has_ink=True, changed=False)

    assert "same as the last turn" in note
    assert "HAS CHANGED" not in note


def test_a_first_look_claims_neither():
    note = board.describe(has_ink=True, changed=None)

    assert "HAS CHANGED" not in note
    assert "identical" not in note


def test_the_manifest_is_passed_through_so_a_sparse_board_can_be_aimed_at():
    """An overview of a board whose writing occupies two percent of a large
    empty field is a picture of specks. The device says where they are."""
    manifest = "WHERE THE WRITING IS: the board has 2 separate areas of writing"
    note = board.describe(has_ink=True, manifest=manifest)

    assert manifest in note


def test_a_semantic_scene_is_reflected_back_exactly():
    scene = '{"elements":[{"id":"tri","kind":"polygon","points":[[0,0],[1,0],[0,1]]}]}'
    note = board.describe(has_ink=False, scene=scene)

    assert scene in note
    assert "SEMANTIC BOARD SCENE" in note
    assert "update_board" in note
    assert "never convert your own text into simulated handwriting" in note


def test_scene_data_without_a_renderable_overview_is_still_not_viewable():
    note = board.describe(has_ink=False, scene="[tutor scene]")

    assert "no renderable content" in note
    assert "do not call `view_board`" in note
    assert "[tutor scene]" in note


def test_a_scene_context_without_an_overview_is_not_viewable_even_when_changed():
    note = board.describe(has_ink=False, scene="x", changed=True)

    assert "HAS CHANGED" in note
    assert "do not call `view_board`" in note
    assert "current board is empty" in note


def test_changed_board_wording_does_not_attribute_the_change_to_the_learner():
    note = board.describe(has_ink=True, changed=True)

    assert "may have been written or erased" in note
    assert "tutor overlay may have been updated" in note
    assert "They have written" not in note


def test_out_of_range_logical_coordinates_are_clamped():
    update, error = parse_board_update(json.dumps({
        "mode": "upsert",
        "delete_ids": [],
        "elements": [{
            "id": "edge",
            "kind": "line",
            "x1": -100_000, "y1": 0, "x2": 100_000, "y2": 0,
            "role": "content", "stroke": "#0A0A0A", "fill": "transparent",
            "stroke_width": 4, "opacity": 1, "dash": [], "rotation": 0,
        }],
    }))
    assert update is not None, error
    point = update_payload(update).upserts[0]
    assert point.x1 == -25_000
    assert point.x2 == 25_000


def test_non_finite_coordinates_are_rejected():
    update, error = parse_board_update(json.dumps({
        "mode": "upsert",
        "delete_ids": [],
        "elements": [{
            "id": "nan",
            "kind": "line",
            "x1": float("nan"), "y1": 0, "x2": 1, "y2": 1,
            "role": "content", "stroke": "#0A0A0A", "fill": "transparent",
            "stroke_width": 4, "opacity": 1, "dash": [], "rotation": 0,
        }],
    }))
    assert update is None
    assert error is not None


def test_extra_keys_are_rejected_by_the_scene_models():
    update, error = parse_board_update(json.dumps({
        "mode": "upsert",
        "delete_ids": [],
        "elements": [{
            "id": "x",
            "kind": "line",
            "x1": 0, "y1": 0, "x2": 1, "y2": 1,
            "role": "content", "stroke": "#0A0A0A", "fill": "transparent",
            "stroke_width": 4, "opacity": 1, "dash": [], "rotation": 0,
            "unexpected": True,
        }],
    }))
    assert update is None
    assert "unexpected" in (error or "")


# MARK: - Raw SVG transport


def test_raw_svg_roundtrips_exactly_through_the_scene_payload():
    update, error = _parse_with_svg()

    assert update is not None, error
    payload = update_payload(update)
    svg = payload.upserts[0]
    assert svg.kind == "svg"
    assert svg.id == "diagram"
    assert (svg.x, svg.y, svg.width, svg.height) == (-250.0, -300.0, 500.0, 320.0)
    assert svg.svg == RAW_SVG_DOCUMENT


def test_raw_svg_is_unchanged_including_full_markup_features():
    update, error = _parse_with_svg()

    assert update is not None, error
    svg = update_payload(update).upserts[0]
    assert "<linearGradient" in svg.svg
    assert "<filter" in svg.svg
    assert "<mask" in svg.svg
    assert "<foreignObject" in svg.svg
    assert "<animate" in svg.svg
    assert 'url(#blur)' in svg.svg


def test_raw_svg_must_be_nonempty():
    update, error = _parse_with_svg(svg="")

    assert update is None
    assert "empty" in (error or "")


def test_raw_svg_over_the_document_limit_is_rejected():
    update, error = _parse_with_svg(svg="x" * (MAX_SVG_CHARS + 1))

    assert update is None
    assert str(MAX_SVG_CHARS) in (error or "")


def test_svg_without_a_frame_is_drawn_at_its_natural_size():
    """0 means "the document's own size", which is the shape the model writes.

    The device draws the `viewBox` one user unit to one board point with its
    top-left corner at `(x, y)`, so a figure needs no frame at all. `None` is
    how that reaches the device: the frame keys stay in the strict schema, and
    the model puts a 0 in them.
    """
    update, error = _parse_with_svg(width=0, height=0)

    assert update is not None, error
    svg = update_payload(update).upserts[0]
    assert svg.width is None
    assert svg.height is None


def test_svg_keeps_a_frame_the_model_asked_for():
    """The other half of the same rule, and the migration for old scenes: a
    positive frame is carried through, and the device fits the figure into it.
    """
    update, error = _parse_with_svg(width=500, height=320)

    assert update is not None, error
    svg = update_payload(update).upserts[0]
    assert (svg.width, svg.height) == (500.0, 320.0)


def test_svg_frame_geometry_is_clamped_to_the_logical_board():
    update, error = _parse_with_svg(
        x=-100_000, y=100_000, width=100_000, height=-50_000,
    )

    assert update is not None, error
    svg = update_payload(update).upserts[0]
    # The height clamps to 0, and 0 is "natural size" rather than a frame with
    # no area: an element the device would have drawn as nothing now draws the
    # document.
    assert (svg.x, svg.y, svg.width, svg.height) == (
        -25_000.0, 25_000.0, 50_000.0, None,
    )


def test_non_finite_svg_frame_geometry_is_rejected():
    update, error = _parse_with_svg(x=float("nan"))

    assert update is None
    assert error is not None


# MARK: - Paths and mathematical notation


def test_path_element_parses_with_default_fill_rule():
    """A path needs no frame: `d` already speaks in board points."""
    update, error = parse_board_update(_update_json(
        kind="path", id="p1", d="M0 0 C10 0 20 10 30 10",
    ))

    assert error is None
    assert update.elements[0].fill_rule == "nonzero"


def test_path_keeps_an_evenodd_fill_rule():
    update, error = parse_board_update(_update_json(
        kind="path", id="p1", d="M0 0 L30 0 L30 30 Z", fill_rule="evenodd",
    ))

    assert error is None
    assert update.elements[0].fill_rule == "evenodd"


def test_path_rejects_oversized_d():
    _, error = parse_board_update(_update_json(
        kind="path", id="p1", d="M0 0 " + "L1 1 " * 4000,
    ))

    assert error is not None
    assert str(MAX_PATH_CHARS) in error


def test_math_text_parses():
    update, error = parse_board_update(_update_json(
        kind="math_text", id="m1", x=10, y=20, latex=r"\frac{a}{b}", font_size=24,
    ))

    assert error is None
    notation = update.elements[0]
    assert (notation.x, notation.y, notation.font_size) == (10.0, 20.0, 24.0)
    assert notation.latex == r"\frac{a}{b}", "LaTeX reaches the device untouched"


def test_math_text_rejects_oversized_latex():
    """Truncating LaTeX would hand the device an unclosed expression, which
    renders as nothing at all. Refusing it lets the model write a shorter one."""
    _, error = parse_board_update(_update_json(
        kind="math_text", id="m1", x=0, y=0,
        latex="x" * (MAX_LATEX_CHARS + 1), font_size=24,
    ))

    assert error is not None
    assert str(MAX_LATEX_CHARS) in error


def test_math_text_font_size_is_clamped_to_the_readable_range():
    update, error = parse_board_update(_update_json(
        kind="math_text", id="m1", x=0, y=0, latex="x", font_size=9_000,
    ))

    assert update is not None, error
    assert update.elements[0].font_size == MAX_FONT_SIZE


@pytest.mark.parametrize("kind, fields", [
    ("path", {"d": ""}),
    ("math_text", {"x": 0, "y": 0, "latex": "", "font_size": 24}),
])
def test_an_empty_document_string_is_rejected(kind, fields):
    """An element the device cannot draw still costs an id and a slot."""
    update, error = parse_board_update(_update_json(kind=kind, id="e1", **fields))

    assert update is None
    assert "empty" in (error or "")


def test_the_new_kinds_reach_the_device_as_one_flat_element():
    """The Swift-side contract, pinned here because only this side can break it.

    `WireElement` in `MathTutor/Domain/BoardScene.swift` decodes one flat
    object: `role`, `stroke`, `fill`, `stroke_width`, `opacity`, `dash`, and
    `rotation` are its own coding keys, beside the geometry, and the field
    names are snake_case. Nesting the style under a `style` object, or
    camel-casing `fill_rule` or `font_size`, would decode to silent defaults on
    the device — a path drawn in the wrong colour, or notation at the wrong
    size, with nothing failing anywhere to say so.
    """
    update, error = parse_board_update(json.dumps({
        "mode": "upsert",
        "delete_ids": [],
        "elements": [
            {"id": "p1", "kind": "path", "d": "M0 0 L30 30",
             "fill_rule": "evenodd", **_STYLE},
            {"id": "m1", "kind": "math_text", "x": 10, "y": 20,
             "latex": r"\frac{a}{b}", "font_size": 24, **_STYLE},
        ],
    }))
    assert update is not None, error

    wire = json.loads(update_payload(update).model_dump_json())
    path, math_text = wire["upserts"]

    style_keys = {"role", "stroke", "fill", "stroke_width", "opacity", "dash", "rotation"}
    assert set(path) == {"id", "kind", "d", "fill_rule"} | style_keys
    assert set(math_text) == {"id", "kind", "x", "y", "latex", "font_size"} | style_keys
    assert "style" not in path and "style" not in math_text
    assert path["fill_rule"] == "evenodd"
    assert math_text["font_size"] == 24
    assert path["stroke"] == "#0A0A0A", "style rides beside the geometry, not under it"


# MARK: - Images


def test_image_element_parses():
    update, error = parse_board_update(_update_json(
        kind="image", id="photo", x=-100, y=-80, width=400, height=300,
        blob_id=BLOB_ID,
    ))

    assert error is None
    image = update.elements[0]
    assert (image.x, image.y, image.width, image.height) == (-100.0, -80.0, 400.0, 300.0)
    assert image.blob_id == BLOB_ID


@pytest.mark.parametrize("blob_id", [
    "sha256:" + "AB12" * 16,        # upper-case hex is a different key
    "sha256:" + "ab12" * 15,        # too short
    "sha256:" + "ab12" * 16 + "0",  # too long
    "sha1:" + "ab12" * 16,          # a digest the store does not write
    "ab12" * 16,                    # no algorithm
    "sha256:../../../etc/passwd",
    "",
])
def test_image_rejects_anything_that_is_not_a_blob_key(blob_id):
    """The device downloads this string from `GET /v1/blobs/{key}`, which
    builds a filesystem path out of it and gates the same shape. A key of any
    other shape can only ever 400, so the model is told here instead."""
    update, error = parse_board_update(_update_json(
        kind="image", id="photo", x=0, y=0, width=10, height=10, blob_id=blob_id,
    ))

    assert update is None
    assert error is not None


@pytest.mark.parametrize("width, height", [(0, 300), (400, 0), (-5, 300)])
def test_image_needs_a_frame_it_can_draw(width, height):
    """An image is placed by its frame, not by its own pixel size, and a
    missing blob renders a placeholder inside that frame. A zero-size one draws
    neither, while the model reads an applied ack and believes it placed a
    picture — so it is refused rather than clamped."""
    update, error = parse_board_update(_update_json(
        kind="image", id="photo", x=0, y=0,
        width=width, height=height, blob_id=BLOB_ID,
    ))

    assert update is None
    assert error is not None


def test_image_geometry_is_clamped_to_the_logical_board():
    update, error = parse_board_update(_update_json(
        kind="image", id="photo", x=-100_000, y=100_000,
        width=100_000, height=300, blob_id=BLOB_ID,
    ))

    assert update is not None, error
    image = update.elements[0]
    assert (image.x, image.y, image.width) == (-25_000.0, 25_000.0, 50_000.0)


def test_an_image_reaches_the_device_as_one_flat_element():
    """`blob_id` is the only thing that names the picture. Camel-cased to
    `blobId` it would decode to nothing on the device, which draws a
    placeholder frame forever and reports no error to anyone."""
    update, error = parse_board_update(_update_json(
        kind="image", id="photo", x=10, y=20, width=400, height=300,
        blob_id=BLOB_ID,
    ))
    assert update is not None, error

    wire = json.loads(update_payload(update).model_dump_json())
    image = wire["upserts"][0]

    assert set(image) == {
        "id", "kind", "x", "y", "width", "height", "blob_id",
    } | set(_STYLE)
    assert image["blob_id"] == BLOB_ID
    assert image["kind"] == "image"


# MARK: - SVG lint


def test_lint_names_every_feature_the_device_cannot_draw():
    warnings = lint_svg(RAW_SVG_DOCUMENT)

    assert any("<filter>" in warning for warning in warnings)
    assert any("<foreignObject>" in warning for warning in warnings)
    assert any("<animate>" in warning for warning in warnings)


def test_lint_says_a_filter_drops_its_effect_and_not_its_element():
    """`SwiftDrawProbeTests.testFilterElementIsDrawnUnfilteredRatherThanDropped`
    draws a filtered shape and reads the bytes back: the shape is there, byte
    for byte identical to the unfiltered control, and the blur is not. The
    warning used to say the element was unsupported, which would send the model
    back with the whole figure redrawn to avoid a filter it never needed to
    remove."""
    warning = next(w for w in lint_svg(RAW_SVG_DOCUMENT) if "<filter>" in w)

    assert "still draws" in warning
    assert "unsupported" not in warning


def test_lint_stays_silent_about_masks_the_renderer_actually_draws():
    """Measured, not assumed: `SwiftDrawProbeTests.testMaskIsAppliedRatherThanDropped`
    renders a masked shape and finds the masked-in half drawn and the masked-out
    half clear. A warning here would teach the model out of markup that works."""
    assert not any("mask" in warning for warning in lint_svg(RAW_SVG_DOCUMENT))


def test_lint_passes_a_document_written_in_the_supported_subset():
    """Paths, shapes, groups, transforms, gradients, text, CSS `<style>`
    blocks, and masks all draw natively. Warning about those would train the
    model out of the markup it should be writing — and `xmlns="http...` is not
    an external reference."""
    assert lint_svg(CLEAN_SVG_DOCUMENT) == []


def test_lint_flags_a_script_that_would_never_run():
    warnings = lint_svg('<svg><script>alert(1)</script><path d="M0 0 L1 1"/></svg>')

    assert len(warnings) == 1
    assert "<script>" in warnings[0]


@pytest.mark.parametrize("markup", [
    '<svg><image href="https://example.com/a.png" width="10" height="10"/></svg>',
    '<svg><image xlink:href="http://example.com/a.png" width="10" height="10"/></svg>',
])
def test_lint_flags_an_external_reference_however_it_is_spelled(markup):
    """The device fetches nothing while rendering, so an external reference is
    a blank hole in the figure. Both spellings are the same problem and are
    reported once, not twice."""
    warnings = lint_svg(markup)

    assert len(warnings) == 1
    assert "external" in warnings[0]
    assert "unsupported" in warnings[0]


def test_lint_still_reads_markup_that_is_not_well_formed():
    """Well-formedness is not this function's job: the device parses the
    markup and the server does not. The scan is textual, so an unclosed
    document still has its unsupported features named instead of swallowing
    the lint behind a parse error nobody asked for."""
    warnings = lint_svg('<svg><filter id="b"><feGaussianBlur stdDeviation="2"')

    assert len(warnings) == 1
    assert "<filter>" in warnings[0]
