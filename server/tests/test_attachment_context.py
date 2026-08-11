from types import SimpleNamespace

from app.attachments.parts import UploadPart
from app.tutor.context import assemble_context


def _session():
    return SimpleNamespace(exercise=None, plan=None)


def test_uploads_are_appended_after_the_prompt_text():
    """Order matters: the model reads the instruction, then the material."""
    bundle = assemble_context(
        session=_session(), messages=[], image_data=None, image_region=None,
        signal=None, goal=None,
        uploads=[UploadPart(
            filename="worksheet.pdf", kind="pdf", page_count=2,
            content_type="application/pdf", data=b"%PDF-1.4",
        )],
    )

    # Two text parts, not one: the prompt is split at the cache breakpoint.
    # What this pins is that every one of them precedes the material.
    kinds = [part["type"] for part in bundle.input[1]["content"]]
    assert kinds == ["input_text", "input_text", "input_file"]


def test_no_uploads_changes_nothing():
    """A caller with no attachments gets exactly the context it got before."""
    without = assemble_context(
        session=_session(), messages=[], image_data=None, image_region=None,
        signal=None, goal=None,
    )
    explicit_empty = assemble_context(
        session=_session(), messages=[], image_data=None, image_region=None,
        signal=None, goal=None, uploads=[],
    )

    assert without.input == explicit_empty.input


def test_uploads_and_a_board_selection_coexist():
    """The learner sends the worksheet and their own attempt in one turn."""
    bundle = assemble_context(
        session=_session(), messages=[], image_data=b"board-png",
        image_region="the top left", signal="evaluate", goal=None,
        uploads=[UploadPart(
            filename="worksheet.pdf", kind="pdf", page_count=1,
            content_type="application/pdf", data=b"%PDF-1.4",
        )],
    )

    kinds = [part["type"] for part in bundle.input[1]["content"]]
    assert kinds == ["input_text", "input_text", "input_image", "input_file"]


def test_uploads_come_after_both_board_images():
    """Uploads must trail the lassoed region *and* the whole-board overview,
    not just whichever board image happens to be present. With only
    `image_data` set, a loop spliced between the two board-image appends
    would pass `test_uploads_and_a_board_selection_coexist` unchanged — this
    is what actually pins the uploads loop to the end."""
    bundle = assemble_context(
        session=_session(), messages=[], image_data=b"board-png",
        image_region="the top left", signal="evaluate", goal=None,
        board_overview=b"overview-png",
        uploads=[UploadPart(
            filename="worksheet.pdf", kind="pdf", page_count=1,
            content_type="application/pdf", data=b"%PDF-1.4",
        )],
    )

    content = bundle.input[1]["content"]
    kinds = [part["type"] for part in content]
    assert kinds == [
        "input_text", "input_text", "input_image", "input_image", "input_file",
    ]

    # The lassoed region is full detail; the overview is the low-detail
    # thumbnail. Pinning both confirms the uploads loop runs after *both*
    # image appends, not just after the first one.
    assert content[2]["detail"] == "original"
    assert content[3]["detail"] == "low"
