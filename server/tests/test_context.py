import base64

from app.tutor.context import assemble_context


class FakeSession:
    plan = None
    exercise = None


class FakeMessage:
    def __init__(self, role, text):
        self.role = role
        self.text = text


def test_input_is_a_system_then_user_pair():
    bundle = assemble_context(
        session=FakeSession(), messages=[FakeMessage("learner", "hi")],
        image_data=None, image_region=None, signal=None, goal=None,
    )
    assert [item["role"] for item in bundle.input] == ["system", "user"]


def test_transcript_renders_role_prefixed_lines():
    bundle = assemble_context(
        session=FakeSession(),
        messages=[FakeMessage("learner", "hi"), FakeMessage("tutor", "hello")],
        image_data=None, image_region=None, signal=None, goal=None,
    )
    text = bundle.input[1]["content"][0]["text"]
    assert "learner: hi\ntutor: hello" in text


def test_no_image_means_a_single_text_part():
    bundle = assemble_context(
        session=FakeSession(), messages=[FakeMessage("learner", "hi")],
        image_data=None, image_region=None, signal=None, goal=None,
    )
    assert len(bundle.input[1]["content"]) == 1


def test_an_image_is_appended_as_a_data_url_with_original_detail():
    bundle = assemble_context(
        session=FakeSession(), messages=[FakeMessage("learner", "check this")],
        image_data=b"pixels", image_region="the board", signal=None, goal=None,
    )
    parts = bundle.input[1]["content"]
    assert len(parts) == 2
    assert parts[1]["type"] == "input_image"
    assert parts[1]["detail"] == "original"
    assert parts[1]["image_url"] == (
        "data:image/png;base64," + base64.b64encode(b"pixels").decode()
    )


def test_a_board_scene_is_included_verbatim_in_the_user_prompt():
    scene = '{"elements":[{"id":"tri","kind":"polygon"}]}'
    bundle = assemble_context(
        session=FakeSession(), messages=[FakeMessage("learner", "hi")],
        image_data=None, image_region=None, signal=None, goal=None,
        board_scene=scene,
    )

    text = bundle.input[1]["content"][0]["text"]
    assert scene in text
    assert "SEMANTIC BOARD SCENE" in text


def test_scene_context_without_an_overview_is_not_viewable():
    bundle = assemble_context(
        session=FakeSession(), messages=[FakeMessage("learner", "hi")],
        image_data=None, image_region=None, signal=None, goal=None,
        board_scene='{"kind":"board_scene_context"}',
    )

    assert bundle.has_board is False
    text = bundle.input[1]["content"][0]["text"]
    assert "no renderable content" in text
    assert "do not call `view_board`" in text


def test_a_semantic_only_overview_is_viewable():
    bundle = assemble_context(
        session=FakeSession(), messages=[FakeMessage("learner", "hi")],
        image_data=None, image_region=None, signal=None, goal=None,
        board_overview=b"semantic pixels",
        board_scene='{"tutor_elements":[{"id":"circle"}]}',
    )

    assert bundle.has_board is True
    assert bundle.input[1]["content"][1]["type"] == "input_image"
