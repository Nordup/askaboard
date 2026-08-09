"""Real bytes for every rung of the conversion ladder.

Generated rather than checked in as binaries: a 2x2 PNG and a one-page PDF are
small enough to build in-process, and a fixture you can read is a fixture you
can trust.
"""
from __future__ import annotations

import io
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
RTF = b"{\\rtf1\\ansi hello}"
UTF8_TEXT = "x = 2 + 2\nsolve for x\n".encode()
BINARY_JUNK = b"\x00\x01\x02\x03" * 32


def heic_header() -> bytes:
    """An ISO-BMFF box whose brand is `heic` — enough for sniffing.

    Not a decodable image: sniffing reads the brand at offset 4, and the
    conversion tests that need real pixels use PNG_2X2 instead.
    """
    return b"\x00\x00\x00\x18ftypheic" + b"\x00" * 32


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
