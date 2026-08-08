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
    MAX_SCENE_CHARS,
    MAX_SVG_CHARS,
    parse_board_update,
    update_payload,
)
from app.tutor.loop import (
    MIN_REGION_PERCENT,
    NO_BOARD_ACK,
    UNAVAILABLE_ACK,
    _answer,
    _region_from,
    _rendered_items,
)
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


def _svg_element(**overrides):
    element = {
        "id": "diagram",
        "kind": "svg",
        "x": -250,
        "y": -300,
        "width": 500,
        "height": 320,
        "svg": RAW_SVG_DOCUMENT,
        "role": "content",
        "stroke": "#0A0A0A",
        "fill": "transparent",
        "stroke_width": 4,
        "opacity": 1,
        "dash": [],
        "rotation": 0,
    }
    element.update(overrides)
    return element


def _parse_with_svg(**overrides):
    return parse_board_update(json.dumps({
        "mode": "upsert",
        "delete_ids": [],
        "elements": [_svg_element(**overrides)],
    }))


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


def test_svg_frame_geometry_is_clamped_to_the_logical_board():
    update, error = _parse_with_svg(
        x=-100_000, y=100_000, width=100_000, height=-50_000,
    )

    assert update is not None, error
    svg = update_payload(update).upserts[0]
    assert (svg.x, svg.y, svg.width, svg.height) == (
        -25_000.0, 25_000.0, 50_000.0, 0.0,
    )


def test_non_finite_svg_frame_geometry_is_rejected():
    update, error = _parse_with_svg(x=float("nan"))

    assert update is None
    assert error is not None
