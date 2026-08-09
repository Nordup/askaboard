import base64

from app.attachments.parts import UploadPart, content_part


def test_an_image_becomes_an_input_image_at_original_detail():
    """A file the learner chose is a file they want read, so it is not the
    thumbnail treatment the board overview gets."""
    part = content_part(UploadPart(
        filename="worksheet.jpg", kind="image", page_count=1,
        content_type="image/jpeg", data=b"jpeg-bytes",
    ))

    assert part["type"] == "input_image"
    assert part["detail"] == "original"
    assert part["image_url"] == "data:image/jpeg;base64," + base64.b64encode(b"jpeg-bytes").decode()


def test_a_pdf_becomes_an_input_file_carrying_its_name():
    """`input_file` is a first-class content part, so a PDF needs no
    rasterizing — and the filename is what lets the model refer to it."""
    part = content_part(UploadPart(
        filename="homework.pdf", kind="pdf", page_count=3,
        content_type="application/pdf", data=b"%PDF-1.4",
    ))

    assert part["type"] == "input_file"
    assert part["filename"] == "homework.pdf"
    assert part["file_data"] == "data:application/pdf;base64," + base64.b64encode(b"%PDF-1.4").decode()


def test_text_becomes_named_fenced_input_text():
    part = content_part(UploadPart(
        filename="problem.txt", kind="text", page_count=1,
        content_type="text/plain", data=b"x = 2 + 2",
    ))

    assert part["type"] == "input_text"
    assert "problem.txt" in part["text"]
    assert "x = 2 + 2" in part["text"]
