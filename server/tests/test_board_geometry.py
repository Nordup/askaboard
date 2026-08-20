"""The spatial overlap gate's geometry: practical logical bounds per element.

The runtime gate compares a model's new framed placement against the existing
tutor scene and the learner's ink. It is only as good as these boxes, so this
suite pins the shapes the known scene elements produce, and the exact reported
bug's coordinates.
"""

import json

from app.tutor.board_geometry import (
    FRAMED_KINDS,
    element_logical_bounds,
    learner_ink_bounds,
    overlap_fraction,
    scene_is_truncated,
    scene_tutor_blocks,
)


def test_image_bounds_are_its_frame():
    box = element_logical_bounds({
        "id": "img", "kind": "image",
        "x": -180, "y": -24930, "width": 150, "height": 120,
    })
    assert box is not None
    assert (box.x, box.y, box.width, box.height) == (
        -180.0, -24930.0, 150.0, 120.0,
    )


def test_svg_frame_bounds_are_its_frame():
    box = element_logical_bounds({
        "id": "fig", "kind": "svg",
        "x": -190, "y": -24955, "width": 200, "height": 100,
        "svg": "<svg viewBox='0 0 200 100'/>",
    })
    assert (box.x, box.y, box.width, box.height) == (
        -190.0, -24955.0, 200.0, 100.0,
    )


def test_frameless_svg_bounds_come_from_the_viewbox():
    box = element_logical_bounds({
        "id": "fig2", "kind": "svg",
        "x": -190, "y": -24955, "width": 0, "height": 0,
        "svg": "<svg viewBox='0 0 200 100'/>",
    })
    assert (box.x, box.y, box.width, box.height) == (
        -190.0, -24955.0, 200.0, 100.0,
    )


def test_frameless_svg_falls_back_to_width_height_attributes():
    box = element_logical_bounds({
        "id": "fig3", "kind": "svg",
        "x": -100, "y": -200, "width": 0, "height": 0,
        "svg": "<svg width='80' height='40'/>",
    })
    assert (box.x, box.y, box.width, box.height) == (
        -100.0, -200.0, 80.0, 40.0,
    )


def test_unparseable_svg_yields_no_box():
    assert element_logical_bounds({
        "id": "bad", "kind": "svg", "x": 0, "y": 0,
        "width": 0, "height": 0, "svg": "not an svg",
    }) is None


def test_rectangle_ellipse_circle_and_polygon_bounds():
    rect = element_logical_bounds({
        "id": "r", "kind": "rectangle", "x": 10, "y": 20,
        "width": 100, "height": 50,
    })
    assert (rect.x, rect.y, rect.width, rect.height) == (
        10.0, 20.0, 100.0, 50.0,
    )

    circle = element_logical_bounds({
        "id": "c", "kind": "circle", "cx": 5, "cy": -5, "radius": 30,
    })
    assert (circle.x, circle.y, circle.width, circle.height) == (
        -25.0, -35.0, 60.0, 60.0,
    )

    polygon = element_logical_bounds({
        "id": "p", "kind": "polygon",
        "points": [[0, 0], [10, 0], [10, 8], [2, 8]],
    })
    assert (polygon.x, polygon.y, polygon.width, polygon.height) == (
        0.0, 0.0, 10.0, 8.0,
    )


def test_annotation_kinds_are_not_framed():
    for kind, payload in {
        "line": {"x1": 0, "y1": 0, "x2": 40, "y2": 0},
        "text": {"x": 0, "y": 0, "text": "hi", "font_size": 24, "width": 0},
    }.items():
        element = {"id": kind, "kind": kind, **payload}
        assert kind not in FRAMED_KINDS


def test_scene_tutor_blocks_reads_the_envelope_and_legacy():
    scene = json.dumps({
        "kind": "board_scene_context",
        "tutor_elements": [
            {"id": "fig", "kind": "svg", "x": -190, "y": -24955,
             "width": 200, "height": 100, "svg": "<svg viewBox='0 0 200 100'/>"},
        ],
    })
    blocks = scene_tutor_blocks(scene)
    assert [ident for ident, _ in blocks] == ["fig"]

    legacy = scene_tutor_blocks(json.dumps({
        "elements": [{"id": "old", "kind": "rectangle",
                      "x": 0, "y": 0, "width": 10, "height": 10}],
    }))
    assert [ident for ident, _ in legacy] == ["old"]


def test_scene_truncation_is_explicit_and_parse_safe():
    assert scene_is_truncated('{"truncated":true}') is True
    assert scene_is_truncated('{"truncated":false}') is False
    assert scene_is_truncated("not json") is False


def test_learner_ink_bounds_reads_the_env_axis_form():
    box = learner_ink_bounds(json.dumps({
        "learner_ink_logical_bounds": [-200, -24960, 0, -24920],
    }))
    assert (box.x, box.y, box.width, box.height) == (
        -200.0, -24960.0, 200.0, 40.0,
    )
    assert learner_ink_bounds('{"learner_ink_logical_bounds":[1,2]}') is None


def test_overlap_fraction_is_of_the_smaller_box():
    # The reported bug: an existing large figure around (-190,-24955) is mostly
    # covered by a new image at (-180,-24930).
    figure = element_logical_bounds({
        "kind": "svg", "x": -190, "y": -24955, "width": 200, "height": 100,
        "svg": "<svg viewBox='0 0 200 100'/>",
    })
    image = element_logical_bounds({
        "kind": "image", "x": -180, "y": -24930, "width": 150, "height": 120,
    })
    assert overlap_fraction(image, figure) >= 0.5

    # A placement wholly elsewhere overlaps nothing.
    elsewhere = element_logical_bounds({
        "kind": "image", "x": 1000, "y": 1000, "width": 100, "height": 100,
    })
    assert overlap_fraction(elsewhere, figure) == 0.0
