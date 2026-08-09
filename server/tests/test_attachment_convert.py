import pytest

from app.attachments.convert import Unconvertible, convert
from app.attachments.kinds import Kind
from app.config import IMAGE_MAX_EDGE, MAX_PDF_PAGES, MAX_TEXT_CHARS, THUMBNAIL_MAX_EDGE
from tests.fixtures import files


async def test_an_image_is_normalised_to_jpeg():
    result = await convert(files.PNG_2X2, "board.png")
    assert result.kind is Kind.IMAGE
    assert result.content_type == "image/jpeg"
    assert result.data.startswith(b"\xff\xd8\xff")
    assert result.page_count == 1


async def test_a_large_image_is_downscaled():
    from PIL import Image
    import io

    buffer = io.BytesIO()
    Image.new("RGB", (4000, 3000), "white").save(buffer, "PNG")
    result = await convert(buffer.getvalue(), "huge.png")

    decoded = Image.open(io.BytesIO(result.data))
    assert max(decoded.size) == IMAGE_MAX_EDGE


async def test_every_conversion_returns_a_thumbnail_within_the_cap():
    from PIL import Image
    import io

    result = await convert(files.PNG_2X2, "board.png")
    thumbnail = Image.open(io.BytesIO(result.thumbnail))
    assert max(thumbnail.size) <= THUMBNAIL_MAX_EDGE


async def test_a_pdf_passes_through_unchanged():
    """The Responses API reads PDFs natively. Rasterizing one would be work
    that makes the result worse."""
    result = await convert(files.PDF_ONE_PAGE, "homework.pdf")
    assert result.kind is Kind.PDF
    assert result.data == files.PDF_ONE_PAGE
    assert result.content_type == "application/pdf"
    assert result.page_count == 1


async def test_text_is_decoded_rather_than_pictured():
    result = await convert(files.UTF8_TEXT, "problem.txt")
    assert result.kind is Kind.TEXT
    assert result.data is None
    assert result.text == files.UTF8_TEXT.decode()


async def test_text_over_the_cap_is_refused_not_truncated():
    oversize = ("x" * (MAX_TEXT_CHARS + 1)).encode()
    with pytest.raises(Unconvertible) as raised:
        await convert(oversize, "long.txt")
    assert raised.value.status == 422
    assert str(MAX_TEXT_CHARS) in raised.value.sentence


async def test_an_unsupported_type_raises_415_with_a_learner_sentence():
    with pytest.raises(Unconvertible) as raised:
        await convert(files.BINARY_JUNK, "mystery.bin")
    assert raised.value.status == 415
    assert "mystery.bin" in raised.value.sentence


async def test_a_corrupt_pdf_raises_422():
    with pytest.raises(Unconvertible) as raised:
        await convert(b"%PDF-1.4\nthis is not a pdf", "broken.pdf")
    assert raised.value.status == 422


async def test_a_word_document_is_refused_with_a_way_out():
    """Out of scope by choice — see the module docstring in `kinds.py`. The
    sentence has to tell the learner what to do instead, because the file they
    picked is a perfectly reasonable thing to have picked."""
    with pytest.raises(Unconvertible) as raised:
        await convert(files.docx(), "worksheet.docx")
    assert raised.value.status == 415
    assert "worksheet.docx" in raised.value.sentence
    assert "PDF" in raised.value.sentence


async def test_a_pdf_over_the_page_cap_is_refused():
    """A cap is a refusal, never a silent truncation: a worksheet quietly cut
    off at page 20 is worse than one that was never accepted."""
    import fitz

    document = fitz.open()
    for _ in range(MAX_PDF_PAGES + 1):
        document.new_page()
    oversize = document.tobytes()

    with pytest.raises(Unconvertible) as raised:
        await convert(oversize, "long.pdf")
    assert raised.value.status == 422
    assert str(MAX_PDF_PAGES) in raised.value.sentence


async def test_an_encrypted_pdf_is_refused_with_a_way_out():
    """`fitz.open()` succeeds and `page_count` reports correctly on a
    password-protected PDF — nothing raises until the first render, which
    would otherwise surface as a bare `ValueError`, not a sentence."""
    import fitz

    document = fitz.open()
    document.new_page()
    locked = document.tobytes(encryption=fitz.PDF_ENCRYPT_AES_256, user_pw="secret")
    document.close()

    with pytest.raises(Unconvertible) as raised:
        await convert(locked, "homework.pdf")
    assert raised.value.status == 422
    assert "homework.pdf" in raised.value.sentence


async def test_a_transparent_region_is_composited_onto_white_not_black():
    """`convert("RGB")` alone keeps whatever RGB sat under the alpha channel —
    usually black for a board export — so a blank region of a worksheet
    reached the model as a black rectangle instead of blank paper."""
    from PIL import Image
    import io

    buffer = io.BytesIO()
    Image.new("RGBA", (10, 10), (0, 0, 0, 0)).save(buffer, "PNG")
    result = await convert(buffer.getvalue(), "transparent.png")

    decoded = Image.open(io.BytesIO(result.data)).convert("RGB")
    pixel = decoded.getpixel((5, 5))
    # JPEG is lossy, so a composited-white pixel won't survive as exactly
    # (255, 255, 255) — but it should be nowhere near the black it would be
    # if the alpha channel had simply been dropped.
    assert all(channel > 240 for channel in pixel)


async def test_exif_orientation_is_applied():
    """A phone stores a portrait photo as sensor-native landscape pixels plus
    an orientation tag. The dimension swap is the observable consequence of
    rotating before anything downstream measures the image."""
    from PIL import Image
    import io

    source = Image.new("RGB", (100, 60), "white")
    exif = source.getexif()
    exif[0x0112] = 6  # Orientation: rotate 90° CW to display upright
    buffer = io.BytesIO()
    source.save(buffer, "JPEG", exif=exif)

    result = await convert(buffer.getvalue(), "sideways.jpg")

    decoded = Image.open(io.BytesIO(result.data))
    assert decoded.size == (60, 100)


async def test_a_corrupt_image_raises_422():
    """The PDF rung has a corrupt-file sibling; the image rung had none."""
    junk = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
    with pytest.raises(Unconvertible) as raised:
        await convert(junk, "broken.png")
    assert raised.value.status == 422
