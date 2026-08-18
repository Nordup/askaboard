"""Where a learner's attachments land in the prompt the endpoint sends.

The order is the claim, and it is the turn message's order: what this turn
carried, then the board the tutor can look at, then the material the learner
handed over, then the learner's own words. `uploads` is the last loop in
`assemble_session_context` before the live turn, and these are what hold it
there.

All three tests read `bundle.input[2]` — the turn message. It is the only one
of the three an attachment ever reaches: the system message is fixed bytes and
the context message is append-only, and a file that changed either would break
the invariant `tests/test_prompt_append_only.py` exists to keep.
"""

from app.attachments.parts import UploadPart
from app.tutor import ledger
from app.tutor.context import assemble_session_context


def _upload(filename="worksheet.pdf", pages=2) -> UploadPart:
    return UploadPart(
        filename=filename, kind="pdf", page_count=pages,
        content_type="application/pdf", data=b"%PDF-1.4",
    )


def _bundle(**kwargs):
    """One turn's bundle, assembled the way `/v1/turn` assembles it.

    A first turn: the head is a stand-in string, because none of these tests is
    about what it says, and the log carries only this turn's own entry.
    """
    log = ledger.advance(
        ledger.LogState.from_json(None), messages=[],
        entry=ledger.turn_entry(1),
    )
    return assemble_session_context(
        preamble="PREAMBLE", log=log, live_turn="here it is", **kwargs
    )


def _turn_kinds(bundle) -> list[str]:
    """The turn message's parts, by type, in order."""
    return [part["type"] for part in bundle.input[2]["content"]]


def test_uploads_are_appended_after_the_turns_own_text():
    """Order matters: the model reads the instruction, then the material."""
    bundle = _bundle(uploads=[_upload()])

    # The turn's own entry first, the file next, and the learner's words last —
    # what they asked is the last thing the model reads, however much came with
    # it.
    assert _turn_kinds(bundle) == ["input_text", "input_file", "input_text"]


def test_no_uploads_changes_nothing():
    """A caller with no attachments gets exactly the context it got before."""
    without = _bundle()
    explicit_empty = _bundle(uploads=[])

    assert without.input == explicit_empty.input


def test_uploads_and_a_board_selection_coexist():
    """The learner sends the worksheet and their own attempt in one turn."""
    bundle = _bundle(image_data=b"board-png", uploads=[_upload(pages=1)])

    assert _turn_kinds(bundle) == [
        "input_text", "input_image", "input_file", "input_text",
    ]


def test_uploads_come_after_both_board_images():
    """Uploads must trail the lassoed region *and* the whole-board overview,
    not just whichever board image happens to be present. With only
    `image_data` set, a loop spliced between the two board-image appends
    would pass `test_uploads_and_a_board_selection_coexist` unchanged — this
    is what actually pins the uploads loop to the end."""
    bundle = _bundle(
        image_data=b"board-png", board_overview=b"overview-png",
        uploads=[_upload(pages=1)],
    )

    assert _turn_kinds(bundle) == [
        "input_text", "input_image", "input_image", "input_file", "input_text",
    ]


def test_every_upload_arrives_in_the_learners_own_chip_order():
    """Two files, and the order they were attached in is the order they are
    read in. A `dict` keyed by filename somewhere upstream would pass every
    test above and quietly reorder these."""
    bundle = _bundle(uploads=[
        _upload(filename="first.pdf"), _upload(filename="second.pdf"),
    ])

    files = [part for part in bundle.input[2]["content"]
             if part["type"] == "input_file"]
    assert [part["filename"] for part in files] == ["first.pdf", "second.pdf"]
