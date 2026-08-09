import pytest

from app.attachments.kinds import Kind, sniff
from tests.fixtures import files


@pytest.mark.parametrize("data,filename,expected", [
    (files.PNG_2X2, "board.png", Kind.IMAGE),
    (files.JPEG_MAGIC, "photo.jpg", Kind.IMAGE),
    (files.heic_header(), "IMG_0001.HEIC", Kind.IMAGE),
    (files.PDF_ONE_PAGE, "homework.pdf", Kind.PDF),
    (files.UTF8_TEXT, "problem.txt", Kind.TEXT),
    (files.UTF8_TEXT, "data.csv", Kind.TEXT),
    (files.BINARY_JUNK, "mystery.bin", Kind.UNSUPPORTED),
])
def test_sniff_identifies_each_rung(data, filename, expected):
    assert sniff(data, filename) == expected


def test_magic_bytes_beat_a_lying_extension():
    """A JPEG named .txt is an image, not text. The bytes are the fact."""
    assert sniff(files.PNG_2X2, "definitely-a-note.txt") == Kind.IMAGE


@pytest.mark.parametrize("data,filename", [
    (files.docx(), "worksheet.docx"),
    (files.plain_zip(), "archive.zip"),
    (files.RTF, "notes.rtf"),
])
def test_office_and_iwork_documents_are_unsupported(data, filename):
    """Deliberately out of scope. Handling `.docx` means LibreOffice — a ~1GB
    binary and a subprocess — for a format the learner can export from with one
    tap. `.rtf` and a plain zip come with it: they are the same rung."""
    assert sniff(data, filename) == Kind.UNSUPPORTED


def test_an_empty_file_is_unsupported():
    assert sniff(b"", "empty.txt") == Kind.UNSUPPORTED
