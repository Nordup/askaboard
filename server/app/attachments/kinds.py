"""What an uploaded file *is*, decided from its bytes.

Three rungs reach the model — an image, a PDF, or text — and everything else
is refused here rather than further down, so a learner finds out while they are
still looking at the picker.

**Office and iWork documents are deliberately not a rung.** Reading a `.docx`
means converting it, and converting it with the layout intact — which for a
maths worksheet *is* the content — means a headless LibreOffice subprocess: a
~1GB binary and a process with its own profile directory and timeout, for a
format the learner can export a PDF from with one tap. They are refused with
the same 415 as anything else unreadable. Adding the rung later is one branch
here and one in `convert`.

The bytes always win. A JPEG named `.txt` is an image, because a learner who
renamed a file is not asking for it to be read as prose. Nothing here consults
the extension at all: every rung is decided by magic, and the two zip-container
formats that would have needed a name are the ones that are out of scope.
"""
from __future__ import annotations

from enum import Enum


class Kind(str, Enum):
    IMAGE = "image"
    PDF = "pdf"
    TEXT = "text"
    UNSUPPORTED = "unsupported"


_ZIP_MAGIC = b"PK\x03\x04"
_PDF_MAGIC = b"%PDF-"
_RTF_MAGIC = b"{\\rtf"
_IMAGE_MAGIC = (
    b"\xff\xd8\xff",       # JPEG
    b"\x89PNG\r\n\x1a\n",  # PNG
    b"GIF87a", b"GIF89a",  # GIF
    b"BM",                 # BMP
)
#: ISO-BMFF brands that mean "this is a picture", read at offset 4. iOS hands
#: these out by default, and they are not an image format the model accepts —
#: which is exactly why the server converts rather than the device.
_BMFF_IMAGE_BRANDS = (b"heic", b"heix", b"hevc", b"heim", b"mif1", b"avif")


def sniff(data: bytes, filename: str) -> Kind:
    if not data:
        return Kind.UNSUPPORTED

    if data.startswith(_PDF_MAGIC):
        return Kind.PDF
    if _is_image(data):
        return Kind.IMAGE

    # A zip is a `.docx`, a `.pages`, or a download folder, and all three are
    # out of scope. Excluded before the text check rather than after, because a
    # zip's stored filenames are ASCII and a small one can decode as UTF-8.
    if data.startswith(_ZIP_MAGIC) or data.startswith(_RTF_MAGIC):
        return Kind.UNSUPPORTED

    return Kind.TEXT if _is_text(data) else Kind.UNSUPPORTED


def _is_image(data: bytes) -> bool:
    if data.startswith(_IMAGE_MAGIC):
        return True
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True
    return data[4:8] == b"ftyp" and data[8:12] in _BMFF_IMAGE_BRANDS


def _is_text(data: bytes) -> bool:
    """Decodable as UTF-8 and free of NULs.

    The NUL check is what stops a UTF-16 document or a stray binary from
    passing: both decode as *something* often enough to be worth excluding by a
    property no real text file has.
    """
    if b"\x00" in data[:8192]:
        return False
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    return True
