"""Every uploaded file, turned into something the model can read.

Three rungs, each landing on a content part the Responses API already takes:

  image/*  -> a normalised JPEG   -> input_image
  PDF      -> itself, untouched   -> input_file
  text     -> a decoded string    -> input_text

The PDF rung is the one worth explaining: `input_file` is a first-class content
part, so a PDF needs no rasterizing at all. Rasterizing would be work that makes
the result worse — more bytes, and a photograph of the text instead of the text.

Refusals are exceptions carrying a sentence written for a twelve-year-old,
because that sentence is displayed on a chip in the composer. Nothing here logs
a stack trace and returns None: an attachment that cannot be read has to say so
while the learner is still looking at the picker.
"""
from __future__ import annotations

import io
from dataclasses import dataclass

import fitz  # PyMuPDF
import pillow_heif
from PIL import Image

from app.attachments.kinds import Kind, sniff
from app.config import (
    IMAGE_MAX_EDGE, MAX_PDF_PAGES, MAX_TEXT_CHARS, THUMBNAIL_MAX_EDGE,
)

pillow_heif.register_heif_opener()


class Unconvertible(Exception):
    """A file that will not reach the model, and why — in the learner's words.

    `sentence` is displayed on the attachment chip. It names the file, says
    what happened, and suggests the way out. It never quotes an exception.
    """

    def __init__(self, status: int, sentence: str) -> None:
        super().__init__(sentence)
        self.status = status
        self.sentence = sentence


@dataclass(frozen=True)
class Converted:
    kind: Kind
    #: The bytes the model sees. `None` for text, which travels as a string.
    data: bytes | None
    text: str | None
    content_type: str
    page_count: int
    #: A small JPEG for the device to keep and draw in the thread. Produced
    #: here because this is where the file is already open.
    thumbnail: bytes


async def convert(data: bytes, filename: str) -> Converted:
    """`async` although nothing here awaits.

    Kept async because the caller is a FastAPI handler and this is the seam a
    rung that *does* need to await — a document converter, an OCR pass — would
    arrive at. Making it sync now would mean changing every call site to add
    one back.
    """
    kind = sniff(data, filename)
    if kind is Kind.UNSUPPORTED:
        raise Unconvertible(
            415,
            f"I can’t read {filename}. Try sending it as a PDF, or take a photo of it.",
        )
    if kind is Kind.IMAGE:
        return _convert_image(data, filename)
    if kind is Kind.PDF:
        return _convert_pdf(data, filename)
    return _convert_text(data, filename)


def _convert_image(data: bytes, filename: str) -> Converted:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception:
        raise Unconvertible(422, f"{filename} looks like an image but I couldn’t open it.")

    # `RGB` unconditionally: JPEG has no alpha channel, and a transparent PNG
    # saved straight to JPEG raises rather than flattening.
    flattened = image.convert("RGB")
    return Converted(
        kind=Kind.IMAGE,
        data=_jpeg(flattened, IMAGE_MAX_EDGE),
        text=None,
        content_type="image/jpeg",
        page_count=1,
        thumbnail=_jpeg(flattened, THUMBNAIL_MAX_EDGE),
    )


def _convert_pdf(data: bytes, filename: str) -> Converted:
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception:
        raise Unconvertible(422, f"{filename} is a PDF I couldn’t open. It may be damaged.")

    with document:
        if document.page_count == 0:
            raise Unconvertible(422, f"{filename} has no pages in it.")
        if document.page_count > MAX_PDF_PAGES:
            raise Unconvertible(
                422,
                f"{filename} has {document.page_count} pages. I can take up to "
                f"{MAX_PDF_PAGES} — try sending just the pages you need.",
            )
        page_count = document.page_count
        pixmap = document[0].get_pixmap(dpi=72)
        first_page = Image.frombytes("RGB", (pixmap.width, pixmap.height), pixmap.samples)

    return Converted(
        kind=Kind.PDF,
        data=data,
        text=None,
        content_type="application/pdf",
        page_count=page_count,
        thumbnail=_jpeg(first_page, THUMBNAIL_MAX_EDGE),
    )


def _convert_text(data: bytes, filename: str) -> Converted:
    text = data.decode("utf-8")
    if len(text) > MAX_TEXT_CHARS:
        raise Unconvertible(
            422,
            f"{filename} is longer than {MAX_TEXT_CHARS} characters. "
            "Try sending just the part you’re working on.",
        )
    return Converted(
        kind=Kind.TEXT,
        data=None,
        text=text,
        content_type="text/plain",
        page_count=1,
        thumbnail=_jpeg(_render_text_preview(text), THUMBNAIL_MAX_EDGE),
    )


def _jpeg(image: Image.Image, max_edge: int) -> bytes:
    """A copy of `image` fitted inside `max_edge`, as JPEG.

    `thumbnail` is in-place and only ever shrinks, so a small image keeps its
    own size rather than being blown up — which is what an upscaled 2x2 board
    crop would be: four fat squares and no information.
    """
    fitted = image.copy()
    fitted.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buffer = io.BytesIO()
    fitted.save(buffer, "JPEG", quality=85, optimize=True)
    return buffer.getvalue()


def _render_text_preview(text: str) -> Image.Image:
    """The first few lines, drawn, so a text file has a chip like everything else."""
    from PIL import ImageDraw

    canvas = Image.new("RGB", (THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE), "white")
    draw = ImageDraw.Draw(canvas)
    draw.multiline_text((8, 8), "\n".join(text.splitlines()[:12]), fill="black")
    return canvas
