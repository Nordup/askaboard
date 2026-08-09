"""Real bytes for every rung of the conversion ladder.

Generated rather than checked in as binaries: a 2x2 PNG and a one-page PDF are
small enough to build in-process, and a fixture you can read is a fixture you
can trust.
"""
from __future__ import annotations

import io
import struct
import zipfile

PNG_2X2 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x02"
    b"\x08\x02\x00\x00\x00\xfd\xd4\x9as\x00\x00\x00\x16IDAT\x08\xd7c\xf8"
    b"\xcf\xc0\xf0\x9f\x81\x81\x01\x0c\x0c\x0c\x00\x8d\x03\x02\xf1\x1a"
    b"\xb2\x9d\x1c\x00\x00\x00\x00IEND\xaeB`\x82"
)

#: The smallest structurally valid single-page PDF. Written by hand so the
#: byte offsets in the xref table stay correct.
PDF_ONE_PAGE = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
trailer<</Root 1 0 R>>
%%EOF
"""

JPEG_MAGIC = b"\xff\xd8\xff\xe0" + b"\x00" * 32
GIF_MAGIC = b"GIF89a" + b"\x00" * 4
WEBP_MAGIC = b"RIFF" + b"\x00\x00\x00\x00" + b"WEBP" + b"\x00" * 4
RTF = b"{\\rtf1\\ansi hello}"
UTF8_TEXT = "x = 2 + 2\nsolve for x\n".encode()
BINARY_JUNK = b"\x00\x01\x02\x03" * 32


def bmp_1x1() -> bytes:
    """A valid 1x1 24-bit BMP: 14-byte file header + 40-byte
    BITMAPINFOHEADER + one 4-byte-padded pixel row.

    The size field is read back out of the assembled bytes rather than
    hard-coded, so it cannot drift from the actual length the way a
    copy-pasted constant could.
    """
    pixel_row = b"\x00\x00\xff\x00"  # one BGR pixel (blue), padded to 4 bytes
    info_header = struct.pack(
        "<IiiHHIIiiII",
        40,              # biSize
        1,               # biWidth
        1,               # biHeight
        1,               # biPlanes
        24,              # biBitCount
        0,               # biCompression (BI_RGB)
        len(pixel_row),  # biSizeImage
        0, 0,            # biXPelsPerMeter, biYPelsPerMeter
        0, 0,            # biClrUsed, biClrImportant
    )
    body = info_header + pixel_row
    pixel_offset = 14 + len(info_header)
    total_size = 14 + len(body)
    file_header = (
        b"BM"
        + total_size.to_bytes(4, "little")
        + b"\x00\x00\x00\x00"  # reserved
        + pixel_offset.to_bytes(4, "little")
    )
    return file_header + body


def heic_header() -> bytes:
    """An ISO-BMFF box whose brand is `heic` — enough for sniffing.

    Not a decodable image: sniffing reads the brand at offset 4, and the
    conversion tests that need real pixels use `heic()` or PNG_2X2 instead.
    """
    return b"\x00\x00\x00\x18ftypheic" + b"\x00" * 32


def heic(size: tuple[int, int] = (64, 48), colour: str = "white") -> bytes:
    """A real, decodable HEIC — pixels and all.

    `heic_header()` is forty bytes of brand and proves only that sniffing reads
    the right offset. This is the format an iPad's camera roll hands over by
    default, which makes it the single most likely attachment this feature will
    ever see, and nothing was pushing actual HEIC bytes through the conversion
    ladder — the rung that has to open the file, not just recognise it.

    Encoded through the same `pillow_heif` opener `convert` registers, so a
    build where that dependency is missing or broken fails here rather than in
    production on the first photo.
    """
    import io

    import pillow_heif
    from PIL import Image

    pillow_heif.register_heif_opener()
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, "HEIF")
    return buffer.getvalue()


def docx(text: str = "hello") -> bytes:
    """A zip with the one part that makes it a Word document."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", f"<document>{text}</document>")
    return buffer.getvalue()


def plain_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("notes.txt", "hello")
    return buffer.getvalue()
