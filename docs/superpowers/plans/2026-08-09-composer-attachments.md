# Composer Attachments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a `+` in the tutor composer that attaches photos, PDFs and text files to a turn, with every format conversion happening on the backend.

**Architecture:** The device picks bytes and uploads them to a new `POST /v1/attachments`; the server sniffs the type, converts it to something the Responses API reads (image, PDF, or text), stores both the original and the converted bytes, and returns a thumbnail. The turn body then carries `attachment_ids` instead of bytes. The device never converts anything and never stores an original.

**Tech Stack:** FastAPI + SQLAlchemy + Alembic + Pillow/pillow-heif/PyMuPDF on the server — no external binaries; SwiftUI + PhotosUI + UniformTypeIdentifiers on the device.

**Spec:** [`docs/superpowers/specs/2026-08-09-composer-attachments-design.md`](../specs/2026-08-09-composer-attachments-design.md)

## Global Constraints

- **Work on `main`.** Do not create a branch or a worktree. Commit to the checked-out branch.
- **Never run `xcodebuild test`.** Write the Swift tests; the user runs them. A full simulator test cycle costs more than the task it verifies. Server tests are different — always run `uv run pytest` from `server/`.
- **Server tests that touch the database** need `TEST_DATABASE_URL` set and skip without it (`requires_db` in `server/tests/conftest.py`). That Neon branch is shared and unserialized: FK violations or "connection is closed" mean two pytest runs collided, not a real failure. Re-run before investigating.
- **Python:** `>=3.12`, run everything through `uv run` from `server/`.
- **Swift:** 6.0, iOS deployment target 17.0. New files under `MathTutor/` are picked up by `xcodegen generate` — the target globs the directory, so no `project.yml` edit is needed to add a file.
- **Design values come from Paper**, not from taste. Task 8 draws the new UI there and every later view task reads its numbers back out.
- **Icon render sizes are fixed.** `ui/plus` renders at 20 and only 20. Do not scale it to match the marquee's 24.
- **No new client credential surface.** The upload endpoint uses the same `Depends(require_device_token)` bearer as every other route.
- **No external binaries.** Office and iWork documents are out of scope: `.docx`, `.xlsx`, `.pptx`, `.pages`, `.key`, `.numbers` and `.rtf` are refused with a 415 telling the learner to send a PDF or a photo. Do not add LibreOffice, a subprocess, or a text-extraction library to handle them. See "No external binaries" in the spec.

### Caps (exact values, used verbatim in several tasks)

| Constant | Value |
|---|---|
| `MAX_UPLOAD_BYTES` | `25 * 1024 * 1024` |
| `MAX_ATTACHMENTS_PER_TURN` | `5` |
| `MAX_PDF_PAGES` | `20` |
| `MAX_TEXT_CHARS` | `100_000` |
| `THUMBNAIL_MAX_EDGE` | `256` |
| `IMAGE_MAX_EDGE` | `2000` |

---

## File Structure

**Server — created:**

| File | Responsibility |
|---|---|
| `server/app/attachments/__init__.py` | package marker |
| `server/app/attachments/kinds.py` | bytes + filename → `Kind`. Pure, no I/O, no dependencies. |
| `server/app/attachments/convert.py` | `Kind` + bytes → `Converted` (model-ready bytes or text, page count, thumbnail). Owns Pillow, PyMuPDF and the LibreOffice subprocess. |
| `server/app/attachments/parts.py` | a stored upload → one Responses API content part. Pure. |
| `server/app/api/attachments.py` | `POST /v1/attachments`. |
| `server/migrations/versions/0005_learner_uploads.py` | five nullable columns on `attachments`. |
| `server/tests/test_attachment_kinds.py` | one per sniffing rule |
| `server/tests/test_attachment_convert.py` | one per rung of the ladder |
| `server/tests/test_attachments_endpoint.py` | upload happy paths, caps, refusals |
| `server/tests/fixtures/files.py` | byte-level fixtures (a real 2×2 PNG, a one-page PDF, a minimal docx) |

**Server — modified:** `app/config.py` (caps), `app/store/models.py` (columns), `app/store/recorder.py` (`record_upload`, `load_uploads`), `app/api/turn.py` (`attachment_ids`), `app/tutor/context.py` (extra content parts), `app/tutor/prompt.py` (inventory + guidance), `app/main.py` (router), `pyproject.toml` (three deps), `server/README.md` (LibreOffice prerequisite).

**Device — created:**

| File | Responsibility |
|---|---|
| `MathTutor/Domain/MessageAttachment.swift` | the `Codable` value that rides on a message |
| `MathTutor/Services/AttachmentUploader.swift` | multipart POST, nothing else |
| `MathTutor/Services/AttachmentStore.swift` | the thumbnail sidecar directory |
| `MathTutor/Features/Tutor/ComposerAttachments.swift` | `@MainActor` observable holding what is attached right now |
| `MathTutor/Features/Tutor/AttachmentPickers.swift` | the three iOS pickers, as one view modifier |
| `MathTutor/DesignSystem/Components/Chat/AttachMenu.swift` | the three-row card |
| `MathTutor/DesignSystem/Components/Chat/AttachmentChipRow.swift` | chips inside the existing attachment card |
| `MathTutorTests/AttachmentStoreTests.swift`, `MathTutorTests/ComposerAttachmentsTests.swift` | |

**Device — modified:** `DesignSystem/Components/Chat/Composer.swift`, `Features/Tutor/TutorPanel.swift`, `Features/Tutor/TutorFullScreen.swift`, `Domain/Models.swift`, `Services/BackendTutorService.swift`, `TutorStore.swift`, `Services/SessionPersistence.swift`, `project.yml` (camera usage string), `MathTutorTests/ChatComponentTests.swift`, `MathTutorTests/BackendTutorServiceTests.swift`.

---

## Task 1: Caps and type sniffing

**Files:**
- Create: `server/app/attachments/__init__.py`, `server/app/attachments/kinds.py`
- Create: `server/tests/test_attachment_kinds.py`, `server/tests/fixtures/files.py`
- Modify: `server/app/config.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `Kind` (str enum: `IMAGE`, `PDF`, `TEXT`, `UNSUPPORTED`), `sniff(data: bytes, filename: str) -> Kind`, and the six cap constants in `app.config`.

- [ ] **Step 1: Write the byte fixtures**

Create `server/tests/fixtures/files.py`:

```python
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
```

- [ ] **Step 2: Write the failing test**

Create `server/tests/test_attachment_kinds.py`:

```python
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
```

- [ ] **Step 3: Run test to verify it fails**

Run from `server/`: `uv run pytest tests/test_attachment_kinds.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.attachments'`

- [ ] **Step 4: Add the caps to config**

Append to `server/app/config.py`, after `EMBEDDING_DIMS`:

```python
# What a learner may attach to a turn. Each of these is a refusal with a
# sentence the composer shows, never a silent truncation — a worksheet quietly
# cut off at page 20 is worse than one that was never accepted.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024
MAX_ATTACHMENTS_PER_TURN = 5
MAX_PDF_PAGES = 20
MAX_TEXT_CHARS = 100_000
#: The longest edge of the thumbnail the device stores and draws in the thread.
THUMBNAIL_MAX_EDGE = 256
#: The longest edge an uploaded photo is downscaled to before the model sees
#: it. A 12MP camera image costs tokens proportional to its pixels and carries
#: no more legible handwriting than this does.
IMAGE_MAX_EDGE = 2000
```

- [ ] **Step 5: Write the sniffer**

Create `server/app/attachments/__init__.py` (empty file), then `server/app/attachments/kinds.py`:

```python
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
    if _is_bmp(data):
        return True
    return data[4:8] == b"ftyp" and data[8:12] in _BMFF_IMAGE_BRANDS


def _is_bmp(data: bytes) -> bool:
    """BMP, checked by more than its two-letter magic.

    `BM` alone is the shortest magic in the set and the only one that is
    ordinary text: a learner's note beginning "BMI calculator" or "BMW" would
    be sniffed as an image and sent down the image rung. So the header is
    validated properly — the size field at offset 2 has to agree with the
    bytes actually present — which no English sentence does by accident.
    """
    if not data.startswith(b"BM") or len(data) < 14:
        return False
    return int.from_bytes(data[2:6], "little") == len(data)


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
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_attachment_kinds.py -v`
Expected: 12 PASS

- [ ] **Step 7: Commit**

```bash
git add server/app/attachments server/app/config.py server/tests/test_attachment_kinds.py server/tests/fixtures/files.py
git commit -m "Decide what an uploaded file is from its own bytes"
```

---

## Task 2: The conversion ladder

**Files:**
- Create: `server/app/attachments/convert.py`, `server/tests/test_attachment_convert.py`
- Modify: `server/pyproject.toml`

**Interfaces:**
- Consumes: `Kind`, `sniff` (Task 1); the caps in `app.config`.
- Produces:
  - `Converted` dataclass — `kind: Kind`, `data: bytes | None`, `text: str | None`, `content_type: str`, `page_count: int`, `thumbnail: bytes`
  - `async def convert(data: bytes, filename: str) -> Converted`
  - `class Unconvertible(Exception)` with `.status: int` (415 or 422) and `.sentence: str`

- [ ] **Step 1: Add the dependencies**

In `server/pyproject.toml`, add to `dependencies`:

```toml
    "pillow>=11.0",
    "pillow-heif>=0.21",
    "pymupdf>=1.25",
```

Then run `uv sync` from `server/`.

PyMuPDF is AGPL. This server is not distributed — it runs on one machine for one learner — so the licence is satisfied by not shipping it. If that ever changes, `pypdf` covers the page count and a poppler subprocess covers the render.

- [ ] **Step 2: Write the failing test**

Create `server/tests/test_attachment_convert.py`:

```python
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `uv run pytest tests/test_attachment_convert.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.attachments.convert'`

- [ ] **Step 4: Write the ladder**

Create `server/app/attachments/convert.py`:

```python
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
from PIL import Image, ImageOps

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

    # A phone stores a portrait photo as sensor-native landscape pixels plus an
    # orientation tag, and the JPEG written below carries no EXIF at all — so
    # without this a photo of a worksheet reaches the tutor on its side. First,
    # because every measurement after it assumes the pixels are upright.
    image = ImageOps.exif_transpose(image)

    flattened = _on_white(image)
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
        # An encrypted PDF opens, reports its page count, and only then raises
        # from the first render — so without this the failure surfaces as a bare
        # ValueError from inside the renderer rather than as a sentence. Being
        # handed a password-protected worksheet is an ordinary thing.
        if document.needs_pass:
            raise Unconvertible(
                422,
                f"{filename} is password-protected, so I can’t open it. Try saving "
                "a copy without the password, or take a photo of it.",
            )
        if document.page_count == 0:
            raise Unconvertible(422, f"{filename} has no pages in it.")
        if document.page_count > MAX_PDF_PAGES:
            raise Unconvertible(
                422,
                f"{filename} has {document.page_count} pages. I can take up to "
                f"{MAX_PDF_PAGES} — try sending just the pages you need.",
            )
        page_count = document.page_count
        try:
            # `csRGB` explicitly: `frombytes("RGB", ...)` below wants three bytes
            # per pixel, and a page in a grayscale or CMYK colorspace would
            # otherwise hand back a buffer of the wrong length.
            pixmap = document[0].get_pixmap(dpi=72, colorspace=fitz.csRGB)
        except Exception:
            raise Unconvertible(
                422,
                f"I couldn’t read the first page of {filename}. It may be damaged.",
            )
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


def _on_white(image: Image.Image) -> Image.Image:
    """RGB, with any transparency composited onto white rather than dropped.

    `convert("RGB")` alone throws the alpha channel away and keeps whatever RGB
    was stored underneath it — for a board export, usually solid black. So a
    blank region of a worksheet reached the model as a black rectangle. White
    because the surface behind every one of these images is paper.
    """
    if image.mode not in ("RGBA", "LA", "P", "PA"):
        return image.convert("RGB")
    with_alpha = image.convert("RGBA")
    background = Image.new("RGBA", with_alpha.size, (255, 255, 255, 255))
    return Image.alpha_composite(background, with_alpha).convert("RGB")


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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_attachment_convert.py -v`
Expected: 14 PASS

- [ ] **Step 6: Commit**

```bash
git add server/app/attachments/convert.py server/tests/test_attachment_convert.py server/pyproject.toml server/uv.lock
git commit -m "Convert every uploadable file into something the model reads"
```

---

## Task 3: Storage — schema and recorder

**Files:**
- Create: `server/migrations/versions/0005_learner_uploads.py`
- Modify: `server/app/store/models.py:105-130`, `server/app/store/recorder.py`
- Test: `server/tests/test_recorder.py`

**Interfaces:**
- Consumes: `Converted` (Task 2).
- Produces on `Recorder`:
  - `async def record_upload(*, session_id: uuid.UUID, filename: str, converted: Converted, original: bytes) -> uuid.UUID` — returns the new `attachments.id`
  - `async def load_uploads(*, session_id: uuid.UUID, ids: list[uuid.UUID]) -> list[Attachment]` — returns only rows matching **both** the ids and the session, in the order given

- [ ] **Step 1: Write the failing test**

Append to `server/tests/test_recorder.py`:

```python
async def test_record_upload_stores_both_the_original_and_what_the_model_saw(db_factory):
    """An investigation needs two things: what the learner sent, and what the
    model actually read. One row holds both blob keys."""
    recorder = Recorder(db_factory, blobs)
    session_id = await _seed_session(db_factory)
    converted = Converted(
        kind=Kind.IMAGE, data=b"converted-jpeg-bytes", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )

    upload_id = await recorder.record_upload(
        session_id=session_id, filename="worksheet.png",
        converted=converted, original=b"original-png-bytes",
    )

    [row] = await recorder.load_uploads(session_id=session_id, ids=[upload_id])
    assert row.kind == "learner_upload"
    assert row.filename == "worksheet.png"
    assert row.turn_id is None
    assert await blobs.get(row.blob_key) == b"original-png-bytes"
    assert await blobs.get(row.converted_blob_key) == b"converted-jpeg-bytes"
    assert row.converted_content_type == "image/jpeg"
    assert row.page_count == 1


async def test_load_uploads_refuses_another_sessions_attachment(db_factory):
    """An attachment id is a capability. One device must not be able to name
    another's, and the session is what scopes it."""
    recorder = Recorder(db_factory, blobs)
    mine = await _seed_session(db_factory)
    theirs = await _seed_session(db_factory)
    converted = Converted(
        kind=Kind.IMAGE, data=b"jpeg", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )
    upload_id = await recorder.record_upload(
        session_id=theirs, filename="private.png", converted=converted, original=b"png",
    )

    assert await recorder.load_uploads(session_id=mine, ids=[upload_id]) == []


async def test_load_uploads_returns_rows_in_the_order_asked_for(db_factory):
    """The order is the learner's chip order, and it decides the order the
    model sees the pages in."""
    recorder = Recorder(db_factory, blobs)
    session_id = await _seed_session(db_factory)
    converted = Converted(
        kind=Kind.IMAGE, data=b"jpeg", text=None,
        content_type="image/jpeg", page_count=1, thumbnail=b"thumb",
    )
    first = await recorder.record_upload(
        session_id=session_id, filename="a.png", converted=converted, original=b"a",
    )
    second = await recorder.record_upload(
        session_id=session_id, filename="b.png", converted=converted, original=b"b",
    )

    rows = await recorder.load_uploads(session_id=session_id, ids=[second, first])
    assert [row.filename for row in rows] == ["b.png", "a.png"]
```

Add the imports this test needs at the top of the file:

```python
from app.attachments.convert import Converted
from app.attachments.kinds import Kind
```

Read the existing top of `server/tests/test_recorder.py` first: it already
builds a `Recorder`, a `blobs` store and seeded sessions. Reuse whatever helper
is there for creating a session rather than adding `_seed_session` if one
exists under another name — and if none exists, add:

```python
async def _seed_session(db_factory) -> uuid.UUID:
    session_id = uuid.uuid4()
    async with db_factory() as db:
        db.add(Session(
            id=session_id, model=DEFAULT_MODEL,
            reasoning_effort=DEFAULT_REASONING_EFFORT,
        ))
        await db.commit()
    return session_id
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_recorder.py -k upload -v`
Expected: FAIL — `AttributeError: 'Recorder' object has no attribute 'record_upload'`

(If it errors with "TEST_DATABASE_URL is not set", set it first — these are `requires_db` tests.)

- [ ] **Step 3: Add the columns to the model**

In `server/app/store/models.py`, inside `class Attachment`, replace the `kind`
comment and add five columns after `content_type`:

```python
    # board_png (a region the learner marqueed and sent) | board_full (the whole
    # board, uploaded every turn so the tutor can crop it with `view_board`) |
    # ink | audio | learner_upload (a file the learner attached in the composer).
    # The first two are kept apart on purpose — see BOARD_KIND.
    kind: Mapped[str] = mapped_column(String(16))
```

and, after `content_type`:

```python
    # The five below are `learner_upload`'s alone, and null for every other
    # kind. An upload is the one attachment that arrives named, that may need
    # converting before a model can read it, and that a later turn refers to by
    # id — so it is the one that has to remember what it was called, what it
    # became, and what it looks like.
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The bytes the model actually saw. Equal in content to `blob_key` when
    #: the file needed no conversion, and the blob store is content-addressed,
    #: so that case costs one blob rather than two.
    converted_blob_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    converted_content_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    thumbnail_blob_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
```

- [ ] **Step 4: Write the migration**

Create `server/migrations/versions/0005_learner_uploads.py`:

```python
"""Learner uploads: what a file was called and what it became.

Revision ID: 0005
Revises: 0004
"""
from alembic import op
import sqlalchemy as sa

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # All nullable: every attachment written before this migration is a board
    # render, a dictation or an ink blob, and none of them has a filename.
    op.add_column("attachments", sa.Column("filename", sa.String(255), nullable=True))
    op.add_column("attachments", sa.Column("page_count", sa.Integer(), nullable=True))
    op.add_column("attachments", sa.Column("converted_blob_key", sa.String(128), nullable=True))
    op.add_column("attachments", sa.Column("converted_content_type", sa.String(64), nullable=True))
    op.add_column("attachments", sa.Column("thumbnail_blob_key", sa.String(128), nullable=True))


def downgrade() -> None:
    op.drop_column("attachments", "thumbnail_blob_key")
    op.drop_column("attachments", "converted_content_type")
    op.drop_column("attachments", "converted_blob_key")
    op.drop_column("attachments", "page_count")
    op.drop_column("attachments", "filename")
```

Check the revision identifiers actually used in `0004_learner_model.py` and
match their style — if that file uses a long hash rather than `"0004"`, use its
real `revision` value as this file's `down_revision`.

- [ ] **Step 5: Write the recorder methods**

In `server/app/store/recorder.py`, add after `record_attachment`:

```python
    async def record_upload(
        self,
        *,
        session_id: uuid.UUID,
        filename: str,
        converted: "Converted",
        original: bytes,
    ) -> uuid.UUID:
        """One row for one file the learner attached, holding both blob keys.

        Session-scoped with a null `turn_id`, exactly as a dictation's audio
        is: the upload happens while the learner is still typing, and the turn
        it ends up on does not exist yet. Which turns referred to it is
        recoverable from those turns' own recorded request bodies, which name
        `attachment_ids` verbatim — so there is no second row per turn, and a
        worksheet re-sent three times stays one upload.
        """
        original_ref = await self._blobs.put(original, "application/octet-stream")
        converted_bytes = converted.data if converted.data is not None else converted.text.encode()
        converted_ref = await self._blobs.put(converted_bytes, converted.content_type)
        thumbnail_ref = await self._blobs.put(converted.thumbnail, "image/jpeg")

        attachment = Attachment(
            session_id=session_id,
            kind="learner_upload",
            blob_key=original_ref.key,
            sha256=original_ref.sha256,
            bytes=original_ref.bytes,
            content_type=converted.content_type,
            filename=filename,
            page_count=converted.page_count,
            converted_blob_key=converted_ref.key,
            converted_content_type=converted.content_type,
            thumbnail_blob_key=thumbnail_ref.key,
        )
        async with self._sessionmaker() as session:
            session.add(attachment)
            await session.commit()
            return attachment.id

    async def load_uploads(
        self, *, session_id: uuid.UUID, ids: list[uuid.UUID]
    ) -> list[Attachment]:
        """The named uploads, in the order named, and only this session's.

        The session filter is the whole security property: an attachment id is
        a capability, and the device holding one token must not be able to
        reach another session's files by guessing a uuid. An id that does not
        match is simply absent from the result, which is what lets the caller
        answer with one 400 for "one of these is not yours" without saying
        which.
        """
        if not ids:
            return []
        async with self._sessionmaker() as session:
            rows = (await session.execute(
                select(Attachment).where(
                    Attachment.id.in_(ids),
                    Attachment.session_id == session_id,
                    Attachment.kind == "learner_upload",
                )
            )).scalars().all()
        by_id = {row.id: row for row in rows}
        return [by_id[wanted] for wanted in ids if wanted in by_id]
```

Add `from app.attachments.convert import Converted` to the file's imports, and
confirm `select` and `Attachment` are already imported (they are used elsewhere
in this file; add whichever is missing).

- [ ] **Step 6: Run the migration and the tests**

```bash
cd server && uv run alembic upgrade head && uv run pytest tests/test_recorder.py -v
```

Expected: migration applies, all `test_recorder.py` tests PASS.

- [ ] **Step 7: Commit**

```bash
git add server/app/store/models.py server/app/store/recorder.py server/migrations/versions/0005_learner_uploads.py server/tests/test_recorder.py
git commit -m "Store an upload with both blob keys and the name it arrived under"
```

---

## Task 4: The upload endpoint

**Files:**
- Create: `server/app/api/attachments.py`, `server/tests/test_attachments_endpoint.py`
- Modify: `server/app/main.py:41-60`

**Interfaces:**
- Consumes: `convert`, `Unconvertible` (Task 2); `Recorder.record_upload` (Task 3).
- Produces: `POST /v1/attachments`, and the response model `UploadResponse` with fields `id: uuid.UUID`, `kind: str`, `page_count: int`, `thumbnail_base64: str`.

- [ ] **Step 1: Write the failing test**

Create `server/tests/test_attachments_endpoint.py`:

```python
import base64
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import MAX_UPLOAD_BYTES
from app.main import create_app
from tests.conftest import requires_db
from tests.fixtures import files

AUTH = {"Authorization": "Bearer test-token"}


async def _client(app):
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@requires_db
async def test_uploading_a_photo_returns_a_thumbnail_and_an_id(db_factory, seeded_session):
    app = create_app()
    async with await _client(app) as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(seeded_session)},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 200
    body = response.json()
    assert uuid.UUID(body["id"])
    assert body["kind"] == "image"
    assert body["page_count"] == 1
    assert base64.b64decode(body["thumbnail_base64"]).startswith(b"\xff\xd8\xff")


@requires_db
async def test_an_unreadable_file_is_refused_with_a_sentence_for_the_learner(
    db_factory, seeded_session
):
    """415 at upload, not at send: the learner finds out while they are still
    looking at the picker."""
    app = create_app()
    async with await _client(app) as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(seeded_session)},
            files={"file": ("mystery.bin", files.BINARY_JUNK, "application/octet-stream")},
        )

    assert response.status_code == 415
    assert "mystery.bin" in response.json()["detail"]


@requires_db
async def test_an_oversize_file_is_refused_with_413(db_factory, seeded_session):
    app = create_app()
    oversize = b"\x89PNG\r\n\x1a\n" + b"\x00" * MAX_UPLOAD_BYTES
    async with await _client(app) as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(seeded_session)},
            files={"file": ("huge.png", oversize, "image/png")},
        )

    assert response.status_code == 413


@requires_db
async def test_an_unknown_session_is_refused(db_factory):
    app = create_app()
    async with await _client(app) as client:
        response = await client.post(
            "/v1/attachments",
            headers=AUTH,
            data={"session_id": str(uuid.uuid4())},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 404


async def test_upload_requires_the_device_token():
    app = create_app()
    async with await _client(app) as client:
        response = await client.post(
            "/v1/attachments",
            data={"session_id": str(uuid.uuid4())},
            files={"file": ("board.png", files.PNG_2X2, "image/png")},
        )

    assert response.status_code == 401
```

Add a `seeded_session` fixture to `server/tests/conftest.py` (a session row, returning its id) if one does not already exist under another name — check first; `test_turn_endpoint.py` may already create sessions in a way worth reusing.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_attachments_endpoint.py -v`
Expected: FAIL — 404 on every route (the router does not exist yet)

- [ ] **Step 3: Write the endpoint**

Create `server/app/api/attachments.py`:

```python
"""`POST /v1/attachments` — a file on its way to a turn that does not exist yet.

Its own request rather than a field on the turn, for three reasons that all
point the same way. Conversion happens while the learner is still typing, so it
costs no turn latency. The turn body stays small, and the turn body is recorded
verbatim. And a retry after a dropped connection does not re-upload twenty
megabytes.

The same shape `POST /v1/turn/{turn_id}/board` already established: bytes
travel outside the turn.
"""
from __future__ import annotations

import base64
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.turn import get_recorder
from app.attachments.convert import Unconvertible, convert
from app.auth import require_device_token
from app.config import MAX_UPLOAD_BYTES
from app.store.db import db_session
from app.store.models import Session
from app.store.recorder import Recorder

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])


class UploadResponse(BaseModel):
    """What the composer needs to draw a chip and, later, name this file.

    No status field and nothing to poll: a 200 means converted and stored. The
    chip's converting state is this request being in flight, not a server state
    the device asks about.
    """

    id: uuid.UUID
    kind: str
    page_count: int
    #: A small JPEG. The device keeps this and never the original, so a 20MB
    #: Keynote costs it a few kilobytes.
    thumbnail_base64: str


@router.post("/attachments", response_model=UploadResponse)
async def upload_attachment(
    session_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(db_session),
    recorder: Recorder = Depends(get_recorder),
) -> UploadResponse:
    data = await file.read()
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"{file.filename} is larger than "
            f"{MAX_UPLOAD_BYTES // (1024 * 1024)}MB. Try a photo of just the part you need.",
        )

    # Checked before converting rather than after: LibreOffice is thirty
    # seconds of work, and doing it for a session that does not exist would be
    # thirty seconds spent on a request that was always going to 404.
    exists = await db.scalar(select(Session.id).where(Session.id == session_id))
    if exists is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such session.")

    try:
        converted = await convert(data, file.filename or "attachment")
    except Unconvertible as refusal:
        # The refusal's own sentence, unchanged. It was written for a chip in
        # the composer, and rewording it here would be writing it twice.
        raise HTTPException(refusal.status, refusal.sentence)

    upload_id = await recorder.record_upload(
        session_id=session_id,
        filename=file.filename or "attachment",
        converted=converted,
        original=data,
    )

    return UploadResponse(
        id=upload_id,
        kind=converted.kind.value,
        page_count=converted.page_count,
        thumbnail_base64=base64.b64encode(converted.thumbnail).decode(),
    )
```

- [ ] **Step 4: Wire the router in**

In `server/app/main.py`, alongside the existing router imports and includes:

```python
from app.api.attachments import router as attachments_router
```

```python
    app.include_router(attachments_router)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_attachments_endpoint.py -v`
Expected: 5 PASS

- [ ] **Step 6: Commit**

```bash
git add server/app/api/attachments.py server/app/main.py server/tests/test_attachments_endpoint.py server/tests/conftest.py
git commit -m "Take an upload, convert it, and hand back a thumbnail"
```

---

## Task 5: Uploads become content parts

**Files:**
- Create: `server/app/attachments/parts.py`
- Modify: `server/app/tutor/context.py:24-110`
- Test: `server/tests/test_attachment_parts.py` (create), `server/tests/test_context.py` (append, if it exists)

**Interfaces:**
- Consumes: the `Attachment` rows `load_uploads` returns (Task 3).
- Produces:
  - `@dataclass(frozen=True) class UploadPart` — `filename: str`, `kind: str`, `page_count: int`, `content_type: str`, `data: bytes`
  - `def content_part(upload: UploadPart) -> dict[str, Any]`
  - `assemble_context(..., uploads: list[UploadPart] = [])` — new keyword-only parameter

- [ ] **Step 1: Write the failing test**

Create `server/tests/test_attachment_parts.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_attachment_parts.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.attachments.parts'`

- [ ] **Step 3: Write the part builder**

Create `server/app/attachments/parts.py`:

```python
"""A stored upload, as one Responses API content part.

Pure and separate from `convert` on purpose: conversion decides what a file
*becomes*, this decides how the provider is told about it, and those two change
for different reasons. A provider that renames `input_file` touches only this
file.
"""
from __future__ import annotations

import base64
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class UploadPart:
    """One upload, already converted, on its way into a prompt."""

    filename: str
    kind: str
    page_count: int
    content_type: str
    #: The converted bytes — a JPEG, a PDF, or UTF-8 text.
    data: bytes


def content_part(upload: UploadPart) -> dict[str, Any]:
    if upload.kind == "image":
        encoded = base64.b64encode(upload.data).decode()
        return {
            # `original`, not the `low` the board overview takes. The overview
            # is a thumbnail to aim with; this is a file the learner chose and
            # pointed at, and the whole reason they attached it is that they
            # want it read.
            "type": "input_image",
            "image_url": f"data:{upload.content_type};base64,{encoded}",
            "detail": "original",
        }

    if upload.kind == "text":
        return {
            "type": "input_text",
            "text": f"ATTACHED FILE — {upload.filename}:\n```\n{upload.data.decode()}\n```",
        }

    # A PDF, which is the only remaining kind. Written as the fall-through
    # rather than as `if upload.kind == "pdf"` so a rung added later lands here
    # loudly — as a wrong content part in a test — rather than silently
    # returning None.
    encoded = base64.b64encode(upload.data).decode()
    return {
        "type": "input_file",
        # The provider requires the extension to match the bytes, and this
        # filename is also how the model refers to the file when it talks to
        # the learner about it.
        "filename": upload.filename,
        "file_data": f"data:{upload.content_type};base64,{encoded}",
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_attachment_parts.py -v`
Expected: 3 PASS

- [ ] **Step 5: Write the failing context test**

Create `server/tests/test_attachment_context.py`:

```python
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

    content = bundle.input[1]["content"]
    assert content[0]["type"] == "input_text"
    assert content[1]["type"] == "input_file"


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
    assert kinds == ["input_text", "input_image", "input_file"]
```

- [ ] **Step 6: Run test to verify it fails**

Run: `uv run pytest tests/test_attachment_context.py -v`
Expected: FAIL — `TypeError: assemble_context() got an unexpected keyword argument 'uploads'`

- [ ] **Step 7: Thread uploads through assemble_context**

In `server/app/tutor/context.py`, add the parameter to `assemble_context`'s
signature after `board_changed`:

```python
    uploads: list[UploadPart] | None = None,
```

Add the import at the top:

```python
from app.attachments.parts import UploadPart, content_part
```

Pass the count into the prompt — change the `compose_user_prompt(...)` call to
include:

```python
        uploads=uploads or [],
```

And append the parts after the board overview block, immediately before the
`return ContextBundle(...)`:

```python
    # After both board images, and in the learner's own chip order. The board
    # is what the tutor can look at; these are what the learner handed over,
    # and the prompt above has already named them.
    for upload in uploads or []:
        content.append(content_part(upload))
```

Extend the docstring's "two separate ways the board reaches this function"
paragraph with a third sentence:

```
    `uploads` is neither: files the learner attached in the composer, already
    converted server-side to something the provider reads. They are not the
    board at all, and a turn can carry both.
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `uv run pytest tests/test_attachment_parts.py tests/test_attachment_context.py -v`
Expected: 6 PASS. (Task 6 adds `compose_user_prompt`'s `uploads` parameter — if
Step 7's call fails with an unexpected keyword, do Task 6 first and come back.)

- [ ] **Step 9: Commit**

```bash
git add server/app/attachments/parts.py server/app/tutor/context.py server/tests/test_attachment_parts.py server/tests/test_attachment_context.py
git commit -m "Turn a stored upload into the content part its kind deserves"
```

---

## Task 6: The prompt tells the tutor what arrived

**Files:**
- Modify: `server/app/tutor/prompt.py:55-125`
- Test: `server/tests/test_prompt.py` (create if absent)

**Interfaces:**
- Consumes: `UploadPart` (Task 5).
- Produces: `compose_user_prompt(..., uploads: list[UploadPart] = [])`.

- [ ] **Step 1: Write the failing test**

Create (or append to) `server/tests/test_prompt.py`:

```python
from app.attachments.parts import UploadPart
from app.tutor.prompt import compose_user_prompt


def _prompt(**overrides):
    arguments = dict(
        conversation="learner: help", goal=None, exercise=None, plan=None,
        image_region=None, has_image=False, signal=None,
    )
    arguments.update(overrides)
    return compose_user_prompt(**arguments)


def test_attachments_are_listed_by_name_and_page_count():
    text = _prompt(uploads=[
        UploadPart(filename="worksheet.pdf", kind="pdf", page_count=3,
                   content_type="application/pdf", data=b""),
    ])

    assert "worksheet.pdf" in text
    assert "3 pages" in text


def test_an_attachment_is_told_to_be_transcribed_onto_the_board():
    """The tutor draws the problem out before coaching. It is also the check
    that it read the thing correctly."""
    text = _prompt(uploads=[
        UploadPart(filename="worksheet.pdf", kind="pdf", page_count=1,
                   content_type="application/pdf", data=b""),
    ])

    assert "update_board" in text


def test_the_visible_attempt_guidance_still_belongs_to_the_board_image():
    """A photo of a textbook is not the learner's work, and must not get
    feedback written for the learner's work."""
    attachment_only = _prompt(uploads=[
        UploadPart(filename="textbook.jpg", kind="image", page_count=1,
                   content_type="image/jpeg", data=b""),
    ])
    assert "VISIBLE ATTEMPT" not in attachment_only

    board_selection = _prompt(has_image=True)
    assert "VISIBLE ATTEMPT" in board_selection


def test_no_attachments_adds_nothing():
    assert _prompt(uploads=[]) == _prompt()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_prompt.py -v`
Expected: FAIL — `TypeError: compose_user_prompt() got an unexpected keyword argument 'uploads'`

- [ ] **Step 3: Add the parameter and the section**

In `server/app/tutor/prompt.py`, add to `compose_user_prompt`'s signature:

```python
    uploads: list["UploadPart"] | None = None,
```

with, at the top of the file:

```python
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.attachments.parts import UploadPart
```

Then, immediately after the existing `if has_image:` block:

```python
    if uploads:
        # Named and counted rather than left for the model to discover from the
        # content parts, because a filename is context a picture does not
        # carry: "worksheet.pdf" and "my-attempt.jpg" ask for different
        # readings of the same pixels.
        inventory = ", ".join(
            f"{upload.filename} ({upload.page_count} pages)"
            if upload.page_count > 1 else upload.filename
            for upload in uploads
        )
        sections.append(
            f"ATTACHED BY THE LEARNER: {inventory}. "
            "These are files they handed you, not their own working — do not "
            "give them feedback as an attempt. If an attachment contains a "
            "problem to solve, transcribe it onto the board with `update_board` "
            "first and teach from the board, rather than answering it in the "
            "thread: the transcription is how the learner checks you read it "
            "correctly, and it puts the problem somewhere they can work under."
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_prompt.py -v`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add server/app/tutor/prompt.py server/tests/test_prompt.py
git commit -m "Tell the tutor what the learner attached, and to draw it out first"
```

---

## Task 7: The turn carries attachment ids

**Files:**
- Modify: `server/app/api/turn.py:164-200` (`TurnRequest`), `:300-500` (the turn body)
- Test: `server/tests/test_turn_endpoint.py` (append)

**Interfaces:**
- Consumes: `Recorder.load_uploads` (Task 3), `UploadPart` (Task 5), `MAX_ATTACHMENTS_PER_TURN` (Task 1).
- Produces: `TurnRequest.attachment_ids: list[uuid.UUID]`.

- [ ] **Step 1: Write the failing test**

Append to `server/tests/test_turn_endpoint.py`:

```python
def test_turn_request_accepts_attachment_ids():
    request = TurnRequest(
        turn_id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        text="here's my homework",
        model="gpt-5.6-luna",
        reasoning_effort="high",
        attachment_ids=[uuid.uuid4()],
    )
    assert len(request.attachment_ids) == 1


def test_turn_request_defaults_attachment_ids_to_empty():
    """Every existing caller and fixture predates this field."""
    request = TurnRequest(
        turn_id=uuid.uuid4(), session_id=uuid.uuid4(), text="hi",
        model="gpt-5.6-luna", reasoning_effort="high",
    )
    assert request.attachment_ids == []


def test_turn_request_rejects_more_attachments_than_the_cap():
    from pydantic import ValidationError

    from app.config import MAX_ATTACHMENTS_PER_TURN

    with pytest.raises(ValidationError):
        TurnRequest(
            turn_id=uuid.uuid4(), session_id=uuid.uuid4(), text="hi",
            model="gpt-5.6-luna", reasoning_effort="high",
            attachment_ids=[uuid.uuid4() for _ in range(MAX_ATTACHMENTS_PER_TURN + 1)],
        )


@requires_db
@respx.mock
async def test_a_turn_naming_an_unknown_attachment_is_refused(db_factory, seeded_session):
    """An attachment id is a capability. One that does not resolve inside this
    session is a 400 — never a turn that quietly proceeds without the file the
    learner thought they sent."""
    app = create_app()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.post(
            "/v1/turn",
            headers=AUTH,
            json=_payload(session_id=str(seeded_session), attachment_ids=[str(uuid.uuid4())]),
        )

    assert response.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_turn_endpoint.py -k attachment -v`
Expected: FAIL — `ValidationError: Extra inputs are not permitted` or the field missing

- [ ] **Step 3: Add the field**

In `server/app/api/turn.py`, inside `class TurnRequest`, after `board_scene`:

```python
    #: Files the learner attached in the composer, uploaded ahead of this turn
    #: through `POST /v1/attachments`. Ids rather than bytes: conversion has
    #: already happened, the body stays small enough to record verbatim, and a
    #: retry does not re-upload. See `app/api/attachments.py`.
    #:
    #: The cap lives on the field rather than in the handler so a device that
    #: sends six is refused before anything is loaded, and so the recorded
    #: request body can never contain more than the tutor was ever going to
    #: read.
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_ATTACHMENTS_PER_TURN)
```

Add to the imports at the top of the file:

```python
from pydantic import Field
from app.config import MAX_ATTACHMENTS_PER_TURN
from app.attachments.parts import UploadPart
```

(`Field` and the config import may need merging into existing import lines.)

- [ ] **Step 4: Load the uploads in the turn**

In `server/app/api/turn.py`, immediately after the `image = base64.b64decode(...)`
and `board = base64.b64decode(...)` lines:

```python
    # Loaded before the stream opens, because a missing attachment is a
    # transport-level refusal — the learner's file never made it — rather than
    # something to report mid-turn once they have already seen the tutor start
    # to answer.
    upload_rows = await recorder.load_uploads(
        session_id=body.session_id, ids=body.attachment_ids
    )
    if len(upload_rows) != len(body.attachment_ids):
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "One of those attachments is not on this session.",
        )
    uploads = [
        UploadPart(
            filename=row.filename or "attachment",
            kind=_upload_kind(row),
            page_count=row.page_count or 1,
            content_type=row.converted_content_type or row.content_type,
            data=await recorder.blob(row.converted_blob_key or row.blob_key),
        )
        for row in upload_rows
    ]
```

and add the helper beside the other module-level helpers in that file:

```python
def _upload_kind(row) -> str:
    """The rung this upload came off, recovered from what it converted to.

    Stored as a content type rather than as a kind because the content type is
    what the provider needs; the rung is derivable from it, and one column is
    better than two that can disagree.
    """
    content_type = row.converted_content_type or row.content_type
    if content_type.startswith("image/"):
        return "image"
    if content_type == "text/plain":
        return "text"
    return "pdf"
```

Then pass them into the context assembly — in the existing
`bundle = assemble_context(...)` call, add:

```python
                uploads=uploads,
```

- [ ] **Step 5: Add the recorder's blob reader**

`Recorder` needs a way to read a blob back. Check `server/app/store/recorder.py`
for an existing method first; if there is none, add:

```python
    async def blob(self, key: str) -> bytes:
        """Read a stored blob back. The store is the same one `put` writes to."""
        return await self._blobs.get(key)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `uv run pytest tests/test_turn_endpoint.py -v`
Expected: all PASS, including the four new ones

- [ ] **Step 7: Run the whole server suite**

Run: `uv run pytest -v`
Expected: all PASS or skip. Nothing that passed before this task may now fail.

- [ ] **Step 8: Commit**

```bash
git add server/app/api/turn.py server/app/store/recorder.py server/tests/test_turn_endpoint.py
git commit -m "Carry attachment ids on a turn and refuse ones that aren't yours"
```

---

## Task 8: Draw it in Paper

**Files:**
- Modify: the project's Paper file (composer artboards on the chat-components board, and screens 05/07/08)

**Interfaces:**
- Consumes: nothing.
- Produces: the measured values Tasks 9–13 read — `+` glyph size and colour token, the gap either side of it, the attach menu's row height / padding / corner radius, and the chip's size, radius, thumbnail inset and label style.

This task is design, not code. The project's rule is that Paper is the source
of truth and code is its transcription; the numbers below are the constraints
the drawing has to satisfy, not a substitute for drawing it.

**If the user would rather draw this themselves, stop here and ask.** That is
a likely answer and a good one.

- [ ] **Step 1: Read the guide and open the file**

Call `get_guide({topic: "paper-mcp-instructions"})`, then `list_files` and
`open_file` on the project's design file, then `get_basic_info`.

- [ ] **Step 2: Re-read the composer artboards before touching anything**

The user edits this file during a session, so values go stale. Read the panel
and full-screen composer nodes fresh with `get_node_info` immediately before
mirroring anything between them.

- [ ] **Step 3: Draw the `+` in both composers**

Constraints:
- `ui/plus` at its one published render size, **20**. Do not scale it to 24 to match the marquee.
- Order in the row: `+`, then the marquee, then the text lane.
- The gap either side is the composer's existing gap — 10 in the panel, 16 full-screen. No new spacing value.
- Resulting text lane: **121** in the panel, **498** full-screen. If the drawing produces different numbers, the drawing is right and this plan is wrong — carry the drawing's numbers into Task 9.
- **Colour is the open question.** `ui/plus` publishes `--color-brand`, which is correct on the session menu where it is the one action, and wrong here where it is one of four grey controls and violet already means "lit". Draw it `--color-icon` and leave a note on the node saying the token was departed from deliberately.

- [ ] **Step 4: Draw the attach menu**

Three rows — Photo Library, Take Photo, Files. Build it as a sibling of the
session menu (board 15a) so it inherits that construction: a card in the
surface's own content column, drawn inside the surface rather than floating
over it. Anchor it above the composer, since the composer is at the bottom of
the surface and a menu hanging down would leave the screen.

- [ ] **Step 5: Draw the chip row inside the attachment card**

The existing `Attached context` card, with its contents replaced by a
horizontal row of chips. Each chip: thumbnail, filename, ✕. Draw three states —
one chip, three chips, and a chip mid-conversion. Keep the card's existing
top radii, its `--color-brand-tint-soft` fill and the notch rule from board 03 §2.

- [ ] **Step 6: Screenshot and check**

`get_screenshot` on each artboard changed. Content that clips means the
artboard needs `height: "fit-content"`, not a guessed fixed height.

- [ ] **Step 7: Finish and record the numbers**

Call `finish_working_on_nodes`. Then write the measured values into this plan
file under Task 9, replacing the assumed ones, and commit:

```bash
git add docs/superpowers/plans/2026-08-09-composer-attachments.md
git commit -m "Draw the composer's plus, its menu and the chip row in Paper"
```

---

## Task 9: The composer's row arithmetic

**Files:**
- Modify: `MathTutor/DesignSystem/Components/Chat/Composer.swift:104-108` and `:111-158`
- Test: `MathTutorTests/ChatComponentTests.swift:330-430`

**Interfaces:**
- Consumes: the values Task 8 measured.
- Produces: `ComposerMetrics.plusSize: CGFloat`, and `placeholderWidth(includingPlus:includingMarquee:) -> CGFloat`.

- [ ] **Step 1: Write the failing test**

Append to the composer section of `MathTutorTests/ChatComponentTests.swift`:

```swift
func testPanelRowClosesExactlyWithThePlus() {
    // 301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0
    let composer = ComposerMetrics.panel
    XCTAssertEqual(composer.plusSize, 20)
    XCTAssertEqual(composer.placeholderWidth(includingPlus: true, includingMarquee: true), 121)
}

func testFullScreenRowClosesExactlyWithThePlus() {
    let composer = ComposerMetrics.fullScreen
    XCTAssertEqual(composer.plusSize, 20)
    XCTAssertEqual(composer.placeholderWidth(includingPlus: true, includingMarquee: true), 498)
}

func testThePlusKeepsItsOnePublishedRenderSizeAtBothScales() {
    // `ui/plus` publishes exactly one render size. Stepping it to 24 to match
    // the marquee would add a size to a documented icon set to tidy an
    // alignment — the thing the composer's own doc comment warns against.
    XCTAssertEqual(ComposerMetrics.panel.plusSize, Icon.uiPlus.renderSize)
    XCTAssertEqual(ComposerMetrics.fullScreen.plusSize, Icon.uiPlus.renderSize)
}

func testPlaceholderWidthWithoutThePlusIsUnchanged() {
    // Every existing caller and specimen passes no plus, and must get exactly
    // what it got before.
    XCTAssertEqual(ComposerMetrics.panel.placeholderWidth(includingMarquee: true), 151)
    XCTAssertEqual(ComposerMetrics.fullScreen.placeholderWidth(includingMarquee: false), 574)
}

func testTheRowClosesAtEveryColumnWidthWithThePlus() {
    for scale in [ChatScale.panel, .fullScreen] {
        for width in [CGFloat(301), 337, 644, 740] {
            let composer = ComposerMetrics.for(scale, width: width)
            let children = composer.plusSize + composer.marqueeSize
                + composer.voiceButtonSize + composer.sendButtonSize
            let gaps = composer.gap * 4
            XCTAssertEqual(
                composer.placeholderWidth(includingPlus: true, includingMarquee: true),
                width - composer.paddingLeading - composer.paddingTrailing - children - gaps,
                "\(scale) at \(width)"
            )
        }
    }
}
```

- [ ] **Step 2: Verify it fails**

The user runs the suite. Expected: compile error — `plusSize` and the
`includingPlus:` label do not exist.

Do **not** run `xcodebuild test` yourself. See Global Constraints.

- [ ] **Step 3: Add the metric and widen the arithmetic**

In `ComposerMetrics`, add the stored property after `marqueeSize`:

```swift
    /// `ui/plus`, the attach button in the leading group.
    ///
    /// 20 at both scales, which is the single render size `design/icons.json`
    /// publishes for it. It is not stepped up to the marquee's 24 to make the
    /// two glyphs match: the marquee itself holds at 24 full-screen while
    /// every other glyph in the row steps up, for exactly this reason.
    let plusSize: CGFloat
```

Replace `placeholderWidth(includingMarquee:)` with:

```swift
    /// What is left for the text once every fixed-width child and every gap
    /// comes off.
    ///
    /// `includingPlus` defaults to `false` so every specimen, preview and
    /// gallery entry — none of which mounts an attach button — keeps the
    /// width it had.
    func placeholderWidth(includingPlus: Bool = false, includingMarquee: Bool) -> CGFloat {
        let children: [CGFloat] = (includingPlus ? [plusSize] : [])
            + (includingMarquee ? [marqueeSize] : [])
            + [voiceButtonSize, sendButtonSize]
        let gaps = gap * CGFloat(children.count)
        return width - paddingLeading - paddingTrailing - children.reduce(0, +) - gaps
    }
```

Add `plusSize: Icon.uiPlus.renderSize,` to both the `.panel` and `.fullScreen`
literals, immediately after `marqueeSize:`.

Update the type's doc comment, which currently states the two closing sums, to
state the four:

```swift
/// The child sizes close the row exactly at both scales, which is the check that the
/// padding and gap are right. Without the attach button:
/// `301 − 18 − 24 − 10 − 151 − 10 − 34 − 10 − 38 − 6 = 0` and
/// `740 − 28 − 574 − 16 − 46 − 16 − 52 − 8 = 0`. With it:
/// `301 − 18 − 20 − 10 − 24 − 10 − 121 − 10 − 34 − 10 − 38 − 6 = 0` and
/// `740 − 28 − 20 − 16 − 24 − 16 − 498 − 16 − 46 − 16 − 52 − 8 = 0`.
/// `placeholderWidth(includingPlus:includingMarquee:)` is that arithmetic, and the
/// tests run it against the widths screens 05 and 07 measure.
```

- [ ] **Step 4: Ask the user to run the tests**

Report: "Task 9's tests are written. Please run `xcodebuild test` — expected: 5 new composer tests pass and the existing `ChatComponentTests` still pass."

- [ ] **Step 5: Commit**

```bash
git add MathTutor/DesignSystem/Components/Chat/Composer.swift MathTutorTests/ChatComponentTests.swift
git commit -m "Make room in the composer row for an attach button"
```

---

## Task 10: The attachment value and its sidecar

**Files:**
- Create: `MathTutor/Domain/MessageAttachment.swift`, `MathTutor/Services/AttachmentStore.swift`, `MathTutorTests/AttachmentStoreTests.swift`
- Modify: `MathTutor/Domain/Models.swift:95-111` (`TutorMessage`), `MathTutor/Services/SessionPersistence.swift:88-95` (`delete`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `struct MessageAttachment: Identifiable, Codable, Sendable, Equatable` — `id: UUID`, `filename: String`, `kind: String`, `pageCount: Int`
  - `struct AttachmentStore` — `init(directoryURL: URL? = nil)`, `func save(_ thumbnail: Data, for id: UUID, in sessionID: UUID)`, `func thumbnail(for id: UUID) -> Data?`, `func deleteAll(for sessionID: UUID)`
  - `TutorMessage.attachments: [MessageAttachment]`

- [ ] **Step 1: Write the failing test**

Create `MathTutorTests/AttachmentStoreTests.swift`:

```swift
import XCTest
@testable import MathTutor

final class AttachmentStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent(UUID().uuidString)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testAThumbnailSurvivesBeingWrittenAndReadBack() {
        let store = AttachmentStore(directoryURL: directory)
        let id = UUID()

        store.save(Data("jpeg-bytes".utf8), for: id, in: UUID())

        XCTAssertEqual(store.thumbnail(for: id), Data("jpeg-bytes".utf8))
    }

    func testAMissingThumbnailIsNilRatherThanACrash() {
        let store = AttachmentStore(directoryURL: directory)
        XCTAssertNil(store.thumbnail(for: UUID()))
    }

    func testDeletingASessionTakesItsThumbnailsWithIt() {
        let store = AttachmentStore(directoryURL: directory)
        let sessionID = UUID()
        let id = UUID()
        store.save(Data("jpeg-bytes".utf8), for: id, in: sessionID)

        store.deleteAll(for: sessionID)

        XCTAssertNil(store.thumbnail(for: id))
    }

    func testDeletingOneSessionLeavesAnothersThumbnailsAlone() {
        let store = AttachmentStore(directoryURL: directory)
        let kept = UUID()
        store.save(Data("keep-me".utf8), for: kept, in: UUID())
        store.save(Data("drop-me".utf8), for: UUID(), in: UUID())

        store.deleteAll(for: UUID())

        XCTAssertEqual(store.thumbnail(for: kept), Data("keep-me".utf8))
    }

    func testAMessageWithAttachmentsRoundTripsThroughCoding() throws {
        let message = TutorMessage(
            role: .learner,
            text: "here's my homework",
            attachments: [MessageAttachment(
                id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 3
            )]
        )

        let decoded = try JSONDecoder().decode(
            TutorMessage.self, from: JSONEncoder().encode(message)
        )

        XCTAssertEqual(decoded.attachments, message.attachments)
    }

    func testAMessageStoredBeforeAttachmentsExistedStillDecodes() throws {
        // Every session already on disk was written without this key.
        let legacy = Data("""
        {"id":"\(UUID().uuidString)","role":"learner","text":"hi",
         "createdAt":0}
        """.utf8)

        let decoded = try JSONDecoder().decode(TutorMessage.self, from: legacy)

        XCTAssertEqual(decoded.attachments, [])
    }
}
```

- [ ] **Step 2: Verify it fails**

The user runs the suite. Expected: compile error — `AttachmentStore` and
`MessageAttachment` do not exist.

- [ ] **Step 3: Write the value type**

Create `MathTutor/Domain/MessageAttachment.swift`:

```swift
import Foundation

/// A file the learner attached to a turn, as much of it as the app keeps.
///
/// **Not the file.** The original lives on the server, which is the only place
/// that ever held it: the device uploads bytes and stores the thumbnail that
/// comes back, so a 20MB Keynote costs this device a few kilobytes and the app
/// never learns what a `.key` is.
///
/// `id` is the server's — the id `POST /v1/attachments` minted and the id a
/// turn names in `attachment_ids`. It is also the thumbnail's filename in
/// `AttachmentStore`, which is why nothing here carries a path.
struct MessageAttachment: Identifiable, Codable, Sendable, Equatable {
    let id: UUID
    /// What the learner called it, as shown on the chip.
    let filename: String
    /// `image` | `pdf` | `text`, as the server decided. Held as a string
    /// rather than an enum because the ladder is the server's to extend — a
    /// document rung is a live possibility — and a device that has not been
    /// updated should draw an unknown kind as a chip rather than fail to
    /// decode the whole session.
    let kind: String
    let pageCount: Int
}
```

- [ ] **Step 4: Add attachments to the message**

In `MathTutor/Domain/Models.swift`, inside `struct TutorMessage`, add after
`signal`:

```swift
    /// Files sent with this turn. Empty for every message that predates the
    /// composer's attach button, which is what the default in `init` and the
    /// decoder's own defaulting are for — a session already on disk was
    /// written without this key.
    var attachments: [MessageAttachment] = []
```

and extend the initialiser:

```swift
    init(
        id: UUID = UUID(),
        role: MessageRole,
        text: String,
        createdAt: Date = .now,
        signal: LearningSignal? = nil,
        attachments: [MessageAttachment] = []
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.createdAt = createdAt
        self.signal = signal
        self.attachments = attachments
    }
```

A `var` with a default value gets synthesised decoding that tolerates a missing
key, so no custom `init(from:)` is needed.

- [ ] **Step 5: Write the store**

Create `MathTutor/Services/AttachmentStore.swift`:

```swift
import Foundation

/// Thumbnails for sent attachments, beside the sessions they belong to.
///
/// One flat directory keyed by the server's attachment id, plus a per-session
/// index so deleting a session can find its files. Flat rather than nested by
/// session because the thread draws a chip from an id and nothing else: a
/// nested layout would mean every read needed to know which session it was in,
/// which is a lookup to avoid a `removeItem`.
///
/// A photo of homework is not re-derivable the way a board crop is — which is
/// why this exists at all, and why `selectionViews` stays in memory.
struct AttachmentStore {
    /// Injectable only so a test can point at a temporary directory. Nothing
    /// in the app passes it.
    let directoryURL: URL

    init(directoryURL: URL? = nil) {
        self.directoryURL = directoryURL
            ?? SessionPersistence.defaultDirectoryURL.appendingPathComponent("Attachments")
    }

    private var thumbnailsURL: URL { directoryURL.appendingPathComponent("Thumbnails") }
    private var indexURL: URL { directoryURL.appendingPathComponent("bySession.json") }

    private func fileURL(for id: UUID) -> URL {
        thumbnailsURL.appendingPathComponent(id.uuidString + ".jpg")
    }

    func save(_ thumbnail: Data, for id: UUID, in sessionID: UUID) {
        try? FileManager.default.createDirectory(
            at: thumbnailsURL, withIntermediateDirectories: true
        )
        try? thumbnail.write(to: fileURL(for: id), options: .atomic)

        var index = loadIndex()
        index[sessionID, default: []].append(id)
        writeIndex(index)
    }

    func thumbnail(for id: UUID) -> Data? {
        try? Data(contentsOf: fileURL(for: id))
    }

    /// Forgets every thumbnail a session owns. Called when the session is
    /// deleted — the one place these files would otherwise accumulate forever.
    func deleteAll(for sessionID: UUID) {
        var index = loadIndex()
        for id in index[sessionID] ?? [] {
            try? FileManager.default.removeItem(at: fileURL(for: id))
        }
        index[sessionID] = nil
        writeIndex(index)
    }

    private func loadIndex() -> [UUID: [UUID]] {
        guard let data = try? Data(contentsOf: indexURL),
              let index = try? JSONDecoder().decode([UUID: [UUID]].self, from: data) else {
            return [:]
        }
        return index
    }

    private func writeIndex(_ index: [UUID: [UUID]]) {
        try? FileManager.default.createDirectory(
            at: directoryURL, withIntermediateDirectories: true
        )
        guard let data = try? JSONEncoder().encode(index) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }
}
```

- [ ] **Step 6: Delete thumbnails with the session**

In `MathTutor/Services/SessionPersistence.swift`, change `delete(id:)`:

```swift
    /// Forgets a session entirely — its file, its index entry, and the
    /// thumbnails of anything the learner attached to it.
    func delete(id: UUID) {
        try? FileManager.default.removeItem(at: fileURL(for: id))
        AttachmentStore().deleteAll(for: id)
        writeIndex(loadIndex().removing(id: id))
    }
```

- [ ] **Step 7: Ask the user to run the tests**

Report: "Task 10's tests are written. Please run `xcodebuild test` — expected: 6 new `AttachmentStoreTests` pass, and every existing test still passes (`TutorMessage` gained a defaulted field, so nothing should have to change)."

- [ ] **Step 8: Commit**

```bash
git add MathTutor/Domain/MessageAttachment.swift MathTutor/Services/AttachmentStore.swift MathTutor/Domain/Models.swift MathTutor/Services/SessionPersistence.swift MathTutorTests/AttachmentStoreTests.swift
git commit -m "Keep a sent attachment's thumbnail beside its session"
```

---

## Task 11: The upload client

**Files:**
- Create: `MathTutor/Services/AttachmentUploader.swift`
- Test: `MathTutorTests/BackendTutorServiceTests.swift` (append)

**Interfaces:**
- Consumes: `MessageAttachment` (Task 10), `BackendConfiguration`.
- Produces:
  - `struct UploadedAttachment: Sendable` — `attachment: MessageAttachment`, `thumbnail: Data`
  - `struct AttachmentUploader: Sendable` — `init(configuration:session:)`, `func upload(_ data: Data, filename: String, contentType: String, sessionID: UUID) async throws -> UploadedAttachment`
  - `static func multipartBody(boundary:sessionID:filename:contentType:data:) -> Data`

- [ ] **Step 1: Write the failing test**

Append to `MathTutorTests/BackendTutorServiceTests.swift`:

```swift
func testMultipartBodyCarriesTheSessionAndTheFile() throws {
    let sessionID = UUID()
    let body = AttachmentUploader.multipartBody(
        boundary: "BOUNDARY",
        sessionID: sessionID,
        filename: "worksheet.pdf",
        contentType: "application/pdf",
        data: Data("%PDF-1.4".utf8)
    )
    let text = String(decoding: body, as: UTF8.self)

    XCTAssertTrue(text.contains("name=\"session_id\""))
    XCTAssertTrue(text.contains(sessionID.uuidString))
    XCTAssertTrue(text.contains("name=\"file\"; filename=\"worksheet.pdf\""))
    XCTAssertTrue(text.contains("Content-Type: application/pdf"))
    XCTAssertTrue(text.contains("%PDF-1.4"))
    XCTAssertTrue(text.hasSuffix("--BOUNDARY--\r\n"))
}

func testUploadRequestTargetsTheAttachmentsRouteWithTheBearer() throws {
    let configuration = BackendConfiguration(
        baseURL: URL(string: "https://example.test")!, token: "abc"
    )
    let request = AttachmentUploader.urlRequest(
        boundary: "BOUNDARY", configuration: configuration, body: Data()
    )

    XCTAssertEqual(request.url?.path, "/v1/attachments")
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer abc")
    XCTAssertEqual(
        request.value(forHTTPHeaderField: "Content-Type"),
        "multipart/form-data; boundary=BOUNDARY"
    )
}

func testAnUploadRefusalSurfacesTheServersSentence() async {
    // The server writes that sentence for a chip in the composer. Replacing it
    // with a generic message here would be writing it twice, worse.
    let refusal = AttachmentUploader.refusal(
        statusCode: 415, body: #"{"detail":"I can’t read mystery.bin."}"#
    )
    XCTAssertEqual(refusal, "I can’t read mystery.bin.")
}
```

Check `BackendConfiguration`'s real initialiser before writing the second test
— if it is not `init(baseURL:token:)`, use whatever it is.

- [ ] **Step 2: Verify it fails**

The user runs the suite. Expected: compile error — `AttachmentUploader` does not exist.

- [ ] **Step 3: Write the uploader**

Create `MathTutor/Services/AttachmentUploader.swift`:

```swift
import Foundation

/// One uploaded file, as the composer needs it.
struct UploadedAttachment: Sendable {
    let attachment: MessageAttachment
    /// Written to `AttachmentStore` the moment the turn is sent, and not
    /// before: an attachment the learner removes before sending should leave
    /// nothing on disk.
    let thumbnail: Data
}

/// `POST /v1/attachments` — the composer's file, ahead of the turn it belongs to.
///
/// A separate type from `BackendTutorService` because it is a different
/// conversation: one request, one response, no stream, no board rendezvous. It
/// shares only the configuration.
///
/// It sends the bytes and nothing else. Every question about what a file *is*
/// — whether it can be read at all, what it converts to, how many pages it has
/// — is answered on the server, which is why this file mentions no format by
/// name.
struct AttachmentUploader: Sendable {
    let configuration: BackendConfiguration
    let session: URLSession

    /// A file may be large and the conversion behind it may run LibreOffice,
    /// so this is deliberately longer than a plain request timeout and
    /// deliberately still finite.
    static let timeout: TimeInterval = 90

    init(configuration: BackendConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    func upload(
        _ data: Data, filename: String, contentType: String, sessionID: UUID
    ) async throws -> UploadedAttachment {
        let boundary = "Boundary-\(UUID().uuidString)"
        let body = Self.multipartBody(
            boundary: boundary, sessionID: sessionID,
            filename: filename, contentType: contentType, data: data
        )
        let request = Self.urlRequest(boundary: boundary, configuration: configuration, body: body)

        let (responseData, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw TutorServiceError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            throw TutorServiceError.network(Self.refusal(
                statusCode: http.statusCode,
                body: String(decoding: responseData, as: UTF8.self)
            ))
        }

        let decoded = try JSONDecoder().decode(UploadResponse.self, from: responseData)
        return UploadedAttachment(
            attachment: MessageAttachment(
                id: decoded.id,
                filename: filename,
                kind: decoded.kind,
                pageCount: decoded.page_count
            ),
            thumbnail: Data(base64Encoded: decoded.thumbnail_base64) ?? Data()
        )
    }

    /// The exact response `server/app/api/attachments.py` returns. Field names
    /// are snake_case on the wire; do not rename them without re-reading that
    /// file.
    private struct UploadResponse: Decodable {
        let id: UUID
        let kind: String
        let page_count: Int
        let thumbnail_base64: String
    }

    static func urlRequest(
        boundary: String, configuration: BackendConfiguration, body: Data
    ) -> URLRequest {
        var request = URLRequest(url: configuration.baseURL.appendingPathComponent("v1/attachments"))
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(configuration.token)", forHTTPHeaderField: "Authorization")
        request.setValue(
            "multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type"
        )
        request.httpBody = body
        return request
    }

    /// `multipart/form-data`, assembled by hand.
    ///
    /// Written out rather than reached for, because Foundation has no
    /// multipart encoder and a 20MB attachment is not worth a dependency.
    /// CRLF everywhere: the format requires it, and an LF-only body is
    /// rejected by strict parsers for reasons that are miserable to debug.
    static func multipartBody(
        boundary: String, sessionID: UUID, filename: String, contentType: String, data: Data
    ) -> Data {
        var body = Data()
        func append(_ text: String) { body.append(Data(text.utf8)) }

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"session_id\"\r\n\r\n")
        append("\(sessionID.uuidString)\r\n")

        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(contentType)\r\n\r\n")
        body.append(data)
        append("\r\n--\(boundary)--\r\n")

        return body
    }

    /// The server's own sentence, or a fallback when it did not send one.
    ///
    /// The refusals this endpoint returns are written for a chip in the
    /// composer — they name the file and suggest the way out. Rewriting them
    /// here would be writing the same copy twice and getting it wrong once.
    static func refusal(statusCode: Int, body: String) -> String {
        if let data = body.data(using: .utf8),
           let payload = try? JSONDecoder().decode([String: String].self, from: data),
           let detail = payload["detail"] {
            return detail
        }
        return "That file couldn’t be attached (HTTP \(statusCode))."
    }
}
```

- [ ] **Step 4: Ask the user to run the tests**

Report: "Task 11's tests are written. Please run `xcodebuild test` — expected: 3 new upload tests pass."

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Services/AttachmentUploader.swift MathTutorTests/BackendTutorServiceTests.swift
git commit -m "Send the composer's file to the backend and keep its thumbnail"
```

---

## Task 12: What is attached right now

**Files:**
- Create: `MathTutor/Features/Tutor/ComposerAttachments.swift`, `MathTutorTests/ComposerAttachmentsTests.swift`

**Interfaces:**
- Consumes: `AttachmentUploader`, `UploadedAttachment` (Task 11).
- Produces:
  - `enum PendingAttachmentState: Equatable` — `.uploading`, `.ready(MessageAttachment, thumbnail: Data)`, `.failed(String)`
  - `struct PendingAttachment: Identifiable, Equatable` — `id: UUID` (local), `filename: String`, `state: PendingAttachmentState`
  - `@MainActor final class ComposerAttachments: ObservableObject` — `@Published private(set) var pending: [PendingAttachment]`, `var isFull: Bool`, `func add(data:filename:contentType:sessionID:)`, `func remove(_ id: UUID)`, `func readyForSend() async -> [UploadedAttachment]`, `func clear()`
  - `static let limit = 5`

- [ ] **Step 1: Write the failing test**

Create `MathTutorTests/ComposerAttachmentsTests.swift`:

```swift
import XCTest
@testable import MathTutor

@MainActor
final class ComposerAttachmentsTests: XCTestCase {
    func testAChipAppearsImmediatelyAndUploadingIsItsFirstState() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            try await Task.sleep(nanoseconds: 50_000_000)
            return .stub()
        })

        attachments.add(data: Data(), filename: "worksheet.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        XCTAssertEqual(attachments.pending.count, 1)
        XCTAssertEqual(attachments.pending[0].filename, "worksheet.pdf")
        XCTAssertEqual(attachments.pending[0].state, .uploading)
    }

    func testAFinishedUploadBecomesReady() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })

        attachments.add(data: Data(), filename: "worksheet.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        _ = await attachments.readyForSend()

        guard case .ready = attachments.pending[0].state else {
            return XCTFail("expected .ready, got \(attachments.pending[0].state)")
        }
    }

    func testAReadyForSendWaitsForAnUploadStillInFlight() async {
        // The learner hits send while a six-page PDF is still converting. The
        // attachment must not be dropped.
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            try await Task.sleep(nanoseconds: 100_000_000)
            return .stub()
        })

        attachments.add(data: Data(), filename: "slow.pdf",
                        contentType: "application/pdf", sessionID: UUID())
        let ready = await attachments.readyForSend()

        XCTAssertEqual(ready.count, 1)
    }

    func testAFailedUploadKeepsTheServersSentenceOnTheChip() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network("I can’t read mystery.bin.")
        })

        attachments.add(data: Data(), filename: "mystery.bin",
                        contentType: "application/octet-stream", sessionID: UUID())
        _ = await attachments.readyForSend()

        XCTAssertEqual(attachments.pending[0].state, .failed("I can’t read mystery.bin."))
    }

    func testAFailedAttachmentIsNotSent() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in
            throw TutorServiceError.network("nope")
        })

        attachments.add(data: Data(), filename: "mystery.bin",
                        contentType: "application/octet-stream", sessionID: UUID())

        let ready = await attachments.readyForSend()
        XCTAssertTrue(ready.isEmpty)
    }

    func testRemovingAChipTakesItOutOfTheRow() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })
        attachments.add(data: Data(), filename: "a.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        attachments.remove(attachments.pending[0].id)

        XCTAssertTrue(attachments.pending.isEmpty)
    }

    func testTheRowFillsAtTheCap() async {
        let attachments = ComposerAttachments(upload: { _, _, _, _ in .stub() })
        for index in 0..<ComposerAttachments.limit {
            attachments.add(data: Data(), filename: "\(index).pdf",
                            contentType: "application/pdf", sessionID: UUID())
        }

        XCTAssertTrue(attachments.isFull)

        attachments.add(data: Data(), filename: "one-too-many.pdf",
                        contentType: "application/pdf", sessionID: UUID())

        XCTAssertEqual(attachments.pending.count, ComposerAttachments.limit)
    }
}

private extension UploadedAttachment {
    static func stub() -> UploadedAttachment {
        UploadedAttachment(
            attachment: MessageAttachment(
                id: UUID(), filename: "worksheet.pdf", kind: "pdf", pageCount: 1
            ),
            thumbnail: Data("thumb".utf8)
        )
    }
}
```

- [ ] **Step 2: Verify it fails**

The user runs the suite. Expected: compile error — `ComposerAttachments` does not exist.

- [ ] **Step 3: Write the model**

Create `MathTutor/Features/Tutor/ComposerAttachments.swift`:

```swift
import Foundation

/// Where one attachment is on its way to the server.
enum PendingAttachmentState: Equatable {
    /// The upload request is in flight. This is the whole of "converting" —
    /// there is no server-side status to poll, and a 200 means done.
    case uploading
    case ready(MessageAttachment, thumbnail: Data)
    /// The server's own sentence, shown on the chip. Never a generic message:
    /// the refusal names the file and suggests a way out, and it was written
    /// for exactly this spot.
    case failed(String)
}

/// One chip in the composer's attachment card.
///
/// `id` is local and minted the moment the learner picks the file, not the
/// server's — the chip has to exist before there is anything to call it.
struct PendingAttachment: Identifiable, Equatable {
    let id: UUID
    let filename: String
    var state: PendingAttachmentState
}

/// What is attached to the message the learner is currently writing.
///
/// Separate from `TutorStore` because its lifetime is the *draft*, not the
/// session: everything here is discarded the moment the turn is sent or the
/// learner removes it, and none of it is persisted. The store learns about an
/// attachment exactly once, when the send happens.
///
/// The upload closure is injected so the tests above never touch a network.
@MainActor
final class ComposerAttachments: ObservableObject {
    /// `MAX_ATTACHMENTS_PER_TURN` in `server/app/config.py`. Stated here too so
    /// the composer can decline a sixth chip rather than letting the learner
    /// pick a file and find out at send time.
    static let limit = 5

    typealias Upload = @Sendable (Data, String, String, UUID) async throws -> UploadedAttachment

    @Published private(set) var pending: [PendingAttachment] = []

    private let upload: Upload
    private var tasks: [UUID: Task<Void, Never>] = [:]

    init(upload: @escaping Upload) {
        self.upload = upload
    }

    convenience init(configuration: BackendConfiguration) {
        let uploader = AttachmentUploader(configuration: configuration)
        self.init { data, filename, contentType, sessionID in
            try await uploader.upload(
                data, filename: filename, contentType: contentType, sessionID: sessionID
            )
        }
    }

    var isEmpty: Bool { pending.isEmpty }
    var isFull: Bool { pending.count >= Self.limit }

    /// Shows the chip, then starts the upload behind it.
    ///
    /// In that order on purpose: the learner picked a file and the feedback for
    /// that tap is the chip, not a spinner somewhere else. The upload runs in a
    /// task keyed by the chip's id so `remove` can cancel it.
    func add(data: Data, filename: String, contentType: String, sessionID: UUID) {
        guard !isFull else { return }
        let id = UUID()
        pending.append(PendingAttachment(id: id, filename: filename, state: .uploading))

        tasks[id] = Task { [weak self] in
            guard let self else { return }
            do {
                let uploaded = try await self.upload(data, filename, contentType, sessionID)
                self.update(id, to: .ready(uploaded.attachment, thumbnail: uploaded.thumbnail))
            } catch is CancellationError {
                return
            } catch {
                self.update(id, to: .failed(Self.sentence(for: error)))
            }
        }
    }

    func remove(_ id: UUID) {
        tasks[id]?.cancel()
        tasks[id] = nil
        pending.removeAll { $0.id == id }
    }

    /// Everything that is going to be sent, once everything in flight has
    /// landed.
    ///
    /// Awaiting the tasks rather than filtering for `.ready` is the whole
    /// point: a learner who hits send while a six-page PDF is still converting
    /// must not have it silently dropped. A failed attachment is excluded —
    /// its chip is still on screen saying why.
    func readyForSend() async -> [UploadedAttachment] {
        for task in tasks.values { await task.value }
        return pending.compactMap { attachment in
            guard case let .ready(message, thumbnail) = attachment.state else { return nil }
            return UploadedAttachment(attachment: message, thumbnail: thumbnail)
        }
    }

    /// After a send, or a session switch. Cancels anything still in flight —
    /// an upload for a draft that no longer exists has nowhere to land.
    func clear() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
        pending = []
    }

    private func update(_ id: UUID, to state: PendingAttachmentState) {
        guard let index = pending.firstIndex(where: { $0.id == id }) else { return }
        pending[index].state = state
    }

    private static func sentence(for error: Error) -> String {
        if case let TutorServiceError.network(message) = error { return message }
        return "That file couldn’t be attached."
    }
}
```

Check `TutorServiceError`'s real cases before writing `sentence(for:)` — the
`.network(String)` case is used in `BackendTutorService`, so it exists, but
confirm the spelling.

- [ ] **Step 4: Ask the user to run the tests**

Report: "Task 12's tests are written. Please run `xcodebuild test` — expected: 7 new `ComposerAttachmentsTests` pass."

- [ ] **Step 5: Commit**

```bash
git add MathTutor/Features/Tutor/ComposerAttachments.swift MathTutorTests/ComposerAttachmentsTests.swift
git commit -m "Hold what the learner has attached to the message they're writing"
```

---

## Task 13: The button, the menu and the chips

**Files:**
- Create: `MathTutor/DesignSystem/Components/Chat/AttachMenu.swift`, `MathTutor/DesignSystem/Components/Chat/AttachmentChipRow.swift`
- Modify: `MathTutor/DesignSystem/Components/Chat/SelectionAttachment.swift` (one new metrics factory), `MathTutor/DesignSystem/Components/Chat/Composer.swift:297-522`
- Test: `MathTutorTests/ChatComponentTests.swift` (append)

**Interfaces:**
- Consumes: `ComposerMetrics.plusSize` (Task 9), `PendingAttachment` (Task 12), the Paper values (Task 8).
- Produces:
  - `AttachmentStackMetrics.composerChips(_ scale: ChatScale, width: CGFloat) -> AttachmentStackMetrics`
  - `struct AttachmentChipRow: View` — `init(attachments:showsSelection:metrics:thumbnail:onRemove:onDismissSelection:isRemovable:)`, with `isRemovable` defaulting to `true` (Task 14 passes `false` for a sent message)
  - `struct AttachMenu: View` — `init(width:onSelect:)`, and `enum AttachMenuChoice { case photoLibrary, camera, files }`
  - `Composer` gains `attachments`, `onAttach`, `onRemoveAttachment`, `attachmentThumbnail`, and the derived `drawsAttachButton` / `drawsAttachmentCard` / `canSend`

**Two structural facts to know before starting.**

`AttachmentStackMetrics.visibleBand` is *"exactly the height of its label row"* —
one line of text. A chip carrying a thumbnail does not fit in it, so the chips
card is a **second metrics instance with a taller band**, not the existing one
with different contents. `derivedCardHeight` (`visibleBand + bodyTopRadius`) is
the law it must still satisfy.

`AttachmentStack` already takes a `card:` builder. Nothing in
`SelectionAttachment` needs changing — `Composer` composes `AttachmentStack`
directly when there are chips, and keeps calling `SelectionAttachment.composer`
for a selection with no files, which is the case the design drew.

**Before starting:** read the values Task 8 recorded. Every number below marked
`// Paper` is a default derived from the constraints, and the drawing wins.

- [ ] **Step 1: Write the failing test**

Append to `MathTutorTests/ChatComponentTests.swift`:

```swift
func testTheComposerDrawsAnAttachButtonOnlyWhenItCanAttach() {
    // A specimen, preview or gallery entry passes no handler and gets the
    // composer it has always had — the rule `onVoice` already follows.
    XCTAssertFalse(Composer(scale: .panel, text: .constant(""), onSend: {}).drawsAttachButton)
    XCTAssertTrue(
        Composer(scale: .panel, text: .constant(""), onSend: {}, onAttach: {}).drawsAttachButton
    )
}

func testTheAttachButtonIsNotDrawnWhileDictationHoldsTheLeadingSlot() {
    // The leading slot belongs to the cancel cross while the microphone is
    // open, and a file picker mid-recording is meaningless. Nothing on screen
    // should move when dictation starts.
    let composer = Composer(
        scale: .panel, text: .constant(""), onSend: {}, onAttach: {},
        dictation: ComposerDictation(phase: .capturing, startedAt: .now)
    )
    XCTAssertFalse(composer.drawsAttachButton)
}

func testTheAttachmentCardIsDrawnForAFileWithNoBoardSelection() {
    // The card used to belong to the board selection alone. A worksheet with
    // nothing lassoed must still get one.
    let composer = Composer(
        scale: .panel, text: .constant(""), selection: .idle, onSend: {},
        attachments: [PendingAttachment(id: UUID(), filename: "a.pdf", state: .uploading)]
    )
    XCTAssertTrue(composer.drawsAttachmentCard)
}

func testTheAttachmentCardIsStillDrawnForABoardSelectionAlone() {
    let composer = Composer(scale: .panel, text: .constant(""), selection: .attached, onSend: {})
    XCTAssertTrue(composer.drawsAttachmentCard)
}

func testNoAttachmentsAndNoSelectionDrawsNoCard() {
    let composer = Composer(scale: .panel, text: .constant(""), selection: .idle, onSend: {})
    XCTAssertFalse(composer.drawsAttachmentCard)
}

func testSendIsDeclinedWithNoTextAndNothingAttached() {
    // Unchanged behaviour, restated because the condition grew a third term.
    let composer = Composer(scale: .panel, text: .constant("  "), selection: .idle, onSend: {})
    XCTAssertFalse(composer.canSend)
}

func testSendIsAllowedWithNoTextButAFileAttached() {
    let composer = Composer(
        scale: .panel, text: .constant(""), selection: .idle, onSend: {},
        attachments: [PendingAttachment(id: UUID(), filename: "a.pdf", state: .uploading)]
    )
    XCTAssertTrue(composer.canSend)
}

func testTheChipsCardObeysTheDerivedHeightLaw() {
    // `visibleBand + bodyTopRadius`. The chips card is taller than the label
    // card, and taller is the only thing about it that differs — a card that
    // stopped obeying the law would show the notch board 03 §2 is about.
    for scale in [ChatScale.panel, .fullScreen] {
        let metrics = AttachmentStackMetrics.composerChips(scale, width: scale.contentWidth)
        XCTAssertTrue(metrics.followsDerivedLaw, "\(scale)")
        XCTAssertGreaterThan(
            metrics.visibleBand,
            AttachmentStackMetrics.composer(scale, width: scale.contentWidth).visibleBand,
            "\(scale) — a chip with a thumbnail does not fit one label row"
        )
    }
}

func testTheChipsCardIsEdgeToEdgeWithThePill() {
    // The notch rule from the other side: a card narrower than the pill shows
    // the corner it is meant to hide.
    let metrics = AttachmentStackMetrics.composerChips(.panel, width: 301)
    XCTAssertEqual(metrics.width, 301)
}

func testASelectionAndFilesShareOneCard() {
    // "Here is the worksheet, and here is what I tried" — one card, three chips.
    let row = AttachmentChipRow(
        attachments: [PendingAttachment(id: UUID(), filename: "a.pdf", state: .uploading)],
        showsSelection: true,
        metrics: .composerChips(.panel, width: 301),
        thumbnail: { _ in nil },
        onRemove: { _ in },
        onDismissSelection: {}
    )
    XCTAssertEqual(row.chipCount, 2)
}
```

- [ ] **Step 2: Verify it fails**

The user runs the suite. Expected: compile errors — `drawsAttachButton`,
`drawsAttachmentCard`, `canSend`, the `attachments:` parameter,
`AttachmentStackMetrics.composerChips` and `AttachmentChipRow` do not exist.

Do **not** run `xcodebuild test` yourself. See Global Constraints.

- [ ] **Step 3: Add the chips card's metrics**

In `MathTutor/DesignSystem/Components/Chat/SelectionAttachment.swift`, beside
the existing `composer(_:width:)` factory on `AttachmentStackMetrics`:

```swift
    /// The composer's card when it holds chips rather than a label.
    ///
    /// **A second instance, not the first one with different contents.** The
    /// label card's `visibleBand` is *exactly the height of its label row*, and
    /// a chip carrying a thumbnail does not fit one line of text. Everything
    /// else is the label card's: the same width edge-to-edge with the pill, the
    /// same paddings, the same front shape, and `derivedCardHeight` still holds
    /// — `followsDerivedLaw` is asserted in the tests.
    ///
    /// `chipHeight` is the band less the row's own padding, which is what makes
    /// the chip's height a consequence of the band rather than a third number
    /// that can drift out of agreement with it.
    static func composerChips(_ scale: ChatScale, width: CGFloat) -> Self {
        let label = composer(scale, width: width)
        let band: CGFloat = scale == .panel ? 62 : 78  // Paper
        return Self(
            width: label.width,
            visibleBand: band,
            bodyHeight: label.bodyHeight,
            bodyTopRadius: label.bodyTopRadius,
            cardHeight: band + label.bodyTopRadius,
            cardPaddingLeading: label.cardPaddingLeading,
            cardPaddingTrailing: label.cardPaddingTrailing,
            labelRowPaddingTop: label.labelRowPaddingTop,
            labelRowPaddingInline: label.labelRowPaddingInline,
            labelStyle: label.labelStyle,
            dismissGlyphSize: label.dismissGlyphSize
        )
    }

    /// One chip's height: the visible band less the row's padding above and
    /// below it.
    var chipHeight: CGFloat { max(0, visibleBand - 2 * labelRowPaddingTop) }
```

Check `composer(_:width:)`'s real name and signature first — the file calls it
from `ComposerMetrics.attachment` as `.composer(scale, width: width)`, so that
is the shape; match its parameter labels exactly.

- [ ] **Step 4: Write the chip row**

Create `MathTutor/DesignSystem/Components/Chat/AttachmentChipRow.swift`:

```swift
import SwiftUI

/// The attachment card's contents: one chip per thing attached to this message.
///
/// A row *inside* the card the board selection already had, not a new surface —
/// the card's top-only radii, its `--color-brand-tint-soft` fill and board 03
/// §2's notch rule all still belong to `AttachmentStack`. This is only what
/// sits in the band.
///
/// **The board selection is one of these chips.** It was always an attachment:
/// it already drew this card, and it already survives into the sent message.
/// Unifying them is what lets a learner send the worksheet and their own
/// attempt in one turn — *"here is the problem, here is what I tried."*
struct AttachmentChipRow: View {
    let attachments: [PendingAttachment]
    /// Whether a board region is attached too. Drawn first, because it is the
    /// learner's own work and the files are the material.
    let showsSelection: Bool
    let metrics: AttachmentStackMetrics
    /// Thumbnails are looked up rather than carried: a chip exists from the
    /// moment the file is picked, and its bytes arrive later.
    let thumbnail: (UUID) -> Data?
    let onRemove: (UUID) -> Void
    let onDismissSelection: () -> Void

    /// What the row will draw. Exposed for the tests, which have no way to
    /// count subviews.
    var chipCount: Int { attachments.count + (showsSelection ? 1 : 0) }

    var body: some View {
        // Horizontal scroll because five chips do not fit a 301pt card and the
        // card's width is fixed by the notch rule. `.basedOnSize` so a single
        // chip does not rubber-band.
        ScrollView(.horizontal) {
            HStack(spacing: DS.Space.s2) {
                if showsSelection {
                    AttachmentChip(
                        title: SelectionCard.composerLabel,
                        subtitle: nil,
                        state: .selection,
                        metrics: metrics,
                        onRemove: onDismissSelection
                    )
                }
                ForEach(attachments) { attachment in
                    AttachmentChip(
                        title: attachment.filename,
                        subtitle: subtitle(for: attachment),
                        state: state(for: attachment),
                        metrics: metrics,
                        onRemove: { onRemove(attachment.id) }
                    )
                }
            }
            .padding(.leading, metrics.cardPaddingLeading)
            .padding(.trailing, metrics.cardPaddingTrailing)
            .padding(.top, metrics.labelRowPaddingTop)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: metrics.width, height: metrics.visibleBand, alignment: .topLeading)
    }

    private func state(for attachment: PendingAttachment) -> AttachmentChip.State {
        switch attachment.state {
        case .uploading: .uploading
        case .failed: .failed
        case let .ready(message, _):
            .thumbnail(thumbnail(message.id))
        }
    }

    /// The second line: what went wrong, or how many pages arrived. Nothing at
    /// all for a one-page file, because "1 page" is noise on a chip that
    /// already shows the file's name.
    private func subtitle(for attachment: PendingAttachment) -> String? {
        switch attachment.state {
        case .uploading: nil
        case let .failed(sentence): sentence
        case let .ready(message, _):
            message.pageCount > 1 ? "\(message.pageCount) pages" : nil
        }
    }
}

/// One chip: a thumbnail box, a name, and the ✕ that takes it back.
///
/// The three states are three *appearances of one shape*, not three layouts.
/// A chip must not resize when its upload lands, or the row reflows under the
/// finger that is still reaching for the ✕ beside it.
struct AttachmentChip: View {
    enum State {
        case uploading
        case thumbnail(Data?)
        case failed
        /// The board region, which has no file and no thumbnail — the marquee
        /// glyph stands in for one.
        case selection
    }

    let title: String
    let subtitle: String?
    let state: State
    let metrics: AttachmentStackMetrics
    let onRemove: () -> Void

    /// The thumbnail box is square and as tall as the chip: the chip's height
    /// is the band's, so this is derived twice over and holds no number.
    private var boxSize: CGFloat { metrics.chipHeight }
    /// Paper. Wide enough for roughly a dozen characters before truncation,
    /// which is what a filename needs to stay recognisable.
    private var labelWidth: CGFloat { metrics.scaleIsPanel ? 96 : 140 }

    var body: some View {
        HStack(spacing: DS.Space.s2) {
            preview
                .frame(width: boxSize, height: boxSize)
                .clipShape(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))

            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: title)
                    .textStyle(metrics.labelStyle)
                    .foregroundStyle(DS.Color.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let subtitle {
                    Text(verbatim: subtitle)
                        .textStyle(ComposerMetrics.noteStyle)
                        .foregroundStyle(DS.Color.inkSecondary)
                        .lineLimit(1)
                }
            }
            .frame(width: labelWidth, alignment: .leading)

            Button(action: onRemove) {
                IconView(.composerDismiss, size: metrics.dismissGlyphSize, tint: DS.Color.icon)
                    .expandedTapTarget(
                        ComposerMetrics.minimumTapTarget, over: metrics.dismissGlyphSize
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(title)")
        }
        .frame(height: metrics.chipHeight)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var preview: some View {
        switch state {
        case .uploading:
            // The dots the thread already uses for "something is happening" —
            // this is the whole of the converting state, and it ends when the
            // upload response lands.
            ThinkingIndicator(scale: .panel).accessibilityHidden(true)
        case let .thumbnail(data):
            if let data, let image = UIImage(data: data) {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                DS.Color.surface
            }
        case .failed:
            IconView(.uiCross, size: metrics.dismissGlyphSize, tint: DS.Color.icon)
        case .selection:
            IconView(.uiSelectionMarker, size: metrics.dismissGlyphSize, tint: DS.Color.brand)
        }
    }
}
```

`metrics.scaleIsPanel` does not exist — add it beside `chipHeight` in Step 3:

```swift
    /// Which of the two treatments this instance is, recovered from the label
    /// style the scale already picks. Used only for the chip's label lane.
    var scaleIsPanel: Bool { labelStyle == AttachmentStackMetrics.composer(.panel, width: width).labelStyle }
```

If that reads awkwardly against the real file, store a `scale: ChatScale` on
`AttachmentStackMetrics` instead — it is a value type with a memberwise
initialiser used in exactly two factories, so adding a field is cheap.

Check `DS.Radius.control` and `Icon.composerDismiss` / `Icon.uiCross` exist
under those names before relying on them; `SelectionCard` already draws a
dismiss glyph, so copy whichever icon case it uses.

- [ ] **Step 5: Write the attach menu**

Read `SessionMenu` first — this is the same construction pointed at a different
anchor, and it should differ from it only in its rows.

Create `MathTutor/DesignSystem/Components/Chat/AttachMenu.swift`:

```swift
import SwiftUI

/// What the attach menu was asked for.
enum AttachMenuChoice: CaseIterable {
    case photoLibrary
    case camera
    case files

    var label: String {
        switch self {
        case .photoLibrary: "Photo Library"
        case .camera: "Take Photo"
        case .files: "Files"
        }
    }
}

/// The three-row card behind the composer's `+`.
///
/// Built as a sibling of `SessionMenu` rather than as a system `Menu`: this
/// product draws its own menus, in the surface's own content column, inside the
/// surface because the surface clips to its radius. A system menu would arrive
/// with system type, system spacing and a system material, none of which exist
/// anywhere else in the app.
///
/// Anchored **above** the composer by its caller, because the composer sits at
/// the bottom of its surface and a menu hanging down would leave the screen.
struct AttachMenu: View {
    let width: CGFloat
    let onSelect: (AttachMenuChoice) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(AttachMenuChoice.allCases, id: \.self) { choice in
                Button { onSelect(choice) } label: {
                    Text(verbatim: choice.label)
                        .textStyle(SessionSwitcherMetrics.rowStyle)
                        .foregroundStyle(DS.Color.ink)
                        .frame(
                            width: width,
                            height: SessionSwitcherMetrics.rowHeight,
                            alignment: .leading
                        )
                        .padding(.horizontal, SessionSwitcherMetrics.rowPaddingInline)
                        .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(width: width)
        .background(DS.Color.surface, in: RoundedRectangle(
            cornerRadius: SessionSwitcherMetrics.menuRadius, style: .continuous
        ))
        .elevation(.control)
    }
}
```

Every `SessionSwitcherMetrics` member named above must be checked against that
type — if the row height, style, inline padding or radius are named differently
there, use its names. If a value genuinely has no equivalent, that is a
question for Paper (Task 8), not a number to invent here.

- [ ] **Step 6: Wire it into the composer**

In `Composer`, add after `onToggleSelection`:

```swift
    /// The attach button's action — opening the menu. Optional so a specimen
    /// with nowhere to put a picker draws the composer without it, the rule
    /// `onVoice` and `onToggleSelection` already follow.
    var onAttach: (() -> Void)?
    var attachments: [PendingAttachment] = []
    var onRemoveAttachment: ((UUID) -> Void)?
    var attachmentThumbnail: ((UUID) -> Data?)?
```

Add the three derived properties (non-private — the tests read them):

```swift
    /// Drawn when there is somewhere for it to lead, and never while dictation
    /// holds the leading slot.
    var drawsAttachButton: Bool { onAttach != nil && dictation == nil }

    /// The card above the pill, which used to belong to the board selection
    /// alone. It now appears for anything attached at all.
    var drawsAttachmentCard: Bool { selection == .attached || !attachments.isEmpty }

    /// Nothing to send is not a designed state — there is no disabled send
    /// button on the board — so the button keeps its one appearance and the
    /// action declines instead.
    var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || selection == .attached
            || !attachments.isEmpty
    }
```

Replace `body`:

```swift
    var body: some View {
        if !attachments.isEmpty {
            // Chips: `AttachmentStack` directly, with the taller card. Not
            // `SelectionAttachment.composer`, which is the *label* card — the
            // one the design drew, and still exactly right for a lassoed
            // region on its own.
            AttachmentStack(metrics: chipsMetrics) {
                AttachmentChipRow(
                    attachments: attachments,
                    showsSelection: selection == .attached,
                    metrics: chipsMetrics,
                    thumbnail: { attachmentThumbnail?($0) },
                    onRemove: { onRemoveAttachment?($0) },
                    onDismissSelection: { onDismissSelection?() }
                )
                .background(DS.Color.brandTintSoft)
            } content: {
                annotatedPill
            }
        } else if selection == .attached {
            SelectionAttachment.composer(
                metrics: metrics.attachment,
                onDismiss: onDismissSelection
            ) {
                annotatedPill
            }
        } else {
            annotatedPill
        }
    }

    private var chipsMetrics: AttachmentStackMetrics {
        .composerChips(scale, width: width ?? scale.contentWidth)
    }
```

Check `DS.Color.brandTintSoft`'s real name against `SelectionCard`, which
already paints this fill.

Put the button in the row, in `pill`, before `leading`:

```swift
            if drawsAttachButton { attachButton }
```

and add it:

```swift
    /// `ui/plus` at its one published render size, in `--color-icon` rather
    /// than the `--color-brand` the icon set publishes for it.
    ///
    /// Board 15a's violet is right where the plus is *the* action on a menu.
    /// Here it is one of four controls in a grey row, and violet already means
    /// "lit" — the marquee immediately beside it uses exactly that to say a
    /// selection is armed. Two violet glyphs side by side meaning different
    /// things is worse than departing from the token. See the note on the
    /// Paper node.
    private var attachButton: some View {
        Button(action: { onAttach?() }) {
            IconView(.uiPlus, size: metrics.plusSize, tint: DS.Color.icon)
                .expandedTapTarget(ComposerMetrics.minimumTapTarget, over: metrics.plusSize)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Attach a photo or file")
    }
```

And change `send()` to use the derived property, deleting the duplicated
condition:

```swift
    private func send() {
        guard canSend else { return }
        onSend()
    }
```

- [ ] **Step 7: Ask the user to run the tests**

Report: "Task 13's tests are written. Please run `xcodebuild test` — expected: 10 new composer tests pass and every existing `ChatComponentTests` still passes, including the `AttachmentStackMetrics` law tests, which the new factory has to satisfy too."

- [ ] **Step 8: Commit**

```bash
git add MathTutor/DesignSystem/Components/Chat/ MathTutorTests/ChatComponentTests.swift
git commit -m "Draw the attach button, its menu and the chips it fills the card with"
```

---

## Task 14: Pickers, send, and the thread

**Files:**
- Create: `MathTutor/Features/Tutor/AttachmentPickers.swift`
- Modify: `MathTutor/Features/Tutor/TutorPanel.swift:241-254`, `MathTutor/Features/Tutor/TutorFullScreen.swift:150-164`, `MathTutor/TutorStore.swift:169-176`, `MathTutor/Domain/Models.swift:286-360`, `MathTutor/Services/BackendTutorService.swift:207-229`, `project.yml`
- Test: `MathTutorTests/BackendTutorServiceTests.swift` (append)

**Interfaces:**
- Consumes: everything from Tasks 10–13.
- Produces:
  - `TutorRequest.attachmentIDs: [UUID]`
  - `TutorStore.send(_ text: String, attachments: [UploadedAttachment])`
  - `View.attachmentPickers(isPresented:onPicked:)`

- [ ] **Step 1: Write the failing test**

Append to `MathTutorTests/BackendTutorServiceTests.swift`:

```swift
func testBodyOmitsAttachmentIDsWhenThereAreNone() {
    // Every existing turn must be byte-identical to what it was.
    let body = BackendTutorService.body(for: .fixture())
    XCTAssertNil(body["attachment_ids"])
}

func testBodyCarriesAttachmentIDsAsStrings() {
    let first = UUID()
    let second = UUID()
    var request = TutorRequest.fixture()
    request.attachmentIDs = [first, second]

    let body = BackendTutorService.body(for: request)

    XCTAssertEqual(
        body["attachment_ids"] as? [String],
        [first.uuidString, second.uuidString]
    )
}
```

Check whether `TutorRequest.fixture()` exists in the test target; if it does
not, build the request inline with the initialiser's real parameters instead.

- [ ] **Step 2: Verify it fails**

The user runs the suite. Expected: compile error — `attachmentIDs` does not exist.

- [ ] **Step 3: Add the field to the request and the wire**

In `MathTutor/Domain/Models.swift`, inside `struct TutorRequest`, after
`boardScene`:

```swift
    /// Files the learner attached in the composer, already uploaded through
    /// `POST /v1/attachments`. Ids rather than bytes: conversion has already
    /// happened server-side, so this turn carries a reference to something the
    /// tutor can already read.
    ///
    /// Not the same thing as `imageData`, which stays exactly what it was — a
    /// region rendered from the live canvas. A lassoed region is not a file and
    /// routing it through an upload would add a round trip to the product's
    /// most common interaction.
    var attachmentIDs: [UUID] = []
```

with `attachmentIDs: [UUID] = [],` added to the initialiser after
`boardScene:`, and `self.attachmentIDs = attachmentIDs` in its body.

In `MathTutor/Services/BackendTutorService.swift`, in `body(for:)`, before the
`return`:

```swift
        if !request.attachmentIDs.isEmpty {
            body["attachment_ids"] = request.attachmentIDs.map(\.uuidString)
        }
```

- [ ] **Step 4: Write the pickers**

Create `MathTutor/Features/Tutor/AttachmentPickers.swift`:

```swift
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Which of the three pickers the attach menu asked for.
enum AttachmentSource: Identifiable {
    case photoLibrary
    case camera
    case files

    var id: Self { self }
}

/// The three iOS pickers, mounted once by whichever surface owns the composer.
///
/// One modifier rather than three, because the panel and the full-screen column
/// both need all three and neither should be assembling sheets. Everything it
/// hands back is bytes, a filename and a content type — the app makes no
/// judgement about what a file is, which is the server's job.
extension View {
    func attachmentPickers(
        source: Binding<AttachmentSource?>,
        onPicked: @escaping (Data, String, String) -> Void
    ) -> some View {
        modifier(AttachmentPickers(source: source, onPicked: onPicked))
    }
}

private struct AttachmentPickers: ViewModifier {
    @Binding var source: AttachmentSource?
    let onPicked: (Data, String, String) -> Void

    @State private var photoItem: PhotosPickerItem?

    func body(content: Content) -> some View {
        content
            .photosPicker(
                isPresented: Binding(
                    get: { source == .photoLibrary },
                    set: { if !$0 { source = nil } }
                ),
                selection: $photoItem,
                matching: .any(of: [.images, .livePhotos])
            )
            .onChange(of: photoItem) { _, picked in
                guard let picked else { return }
                Task {
                    // `Data` self-representation, not a UIImage round trip: the
                    // original bytes are what the server wants, HEIC included.
                    // Re-encoding here would be the device converting, which is
                    // the one thing this design says it never does.
                    guard let data = try? await picked.loadTransferable(type: Data.self) else { return }
                    let name = picked.itemIdentifier ?? "photo"
                    onPicked(data, "\(name).heic", "application/octet-stream")
                    photoItem = nil
                }
            }
            .fullScreenCover(isPresented: Binding(
                get: { source == .camera },
                set: { if !$0 { source = nil } }
            )) {
                CameraPicker { data in
                    onPicked(data, "photo.jpg", "image/jpeg")
                    source = nil
                }
                .ignoresSafeArea()
            }
            .fileImporter(
                isPresented: Binding(
                    get: { source == .files },
                    set: { if !$0 { source = nil } }
                ),
                allowedContentTypes: [.item],
                allowsMultipleSelection: false
            ) { result in
                guard case let .success(urls) = result, let url = urls.first else { return }
                // Security-scoped: a file picked out of another app's container
                // is unreadable without this, and the failure is silent.
                guard url.startAccessingSecurityScopedResource() else { return }
                defer { url.stopAccessingSecurityScopedResource() }
                guard let data = try? Data(contentsOf: url) else { return }
                let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                onPicked(data, url.lastPathComponent, type ?? "application/octet-stream")
            }
    }
}

/// `UIImagePickerController`, because SwiftUI has no camera.
private struct CameraPicker: UIViewControllerRepresentable {
    let onCaptured: (Data) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let controller = UIImagePickerController()
        controller.sourceType = .camera
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCaptured: onCaptured) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onCaptured: (Data) -> Void

        init(onCaptured: @escaping (Data) -> Void) { self.onCaptured = onCaptured }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            guard let image = info[.originalImage] as? UIImage,
                  let data = image.jpegData(compressionQuality: 0.9) else { return }
            onCaptured(data)
        }
    }
}
```

- [ ] **Step 5: Add the camera usage string**

In `project.yml`, under `info.properties`, beside `NSMicrophoneUsageDescription`:

```yaml
        # The composer's camera, for photographing a worksheet or a page of a
        # textbook. Written the way the microphone string is: what is captured,
        # what happens to it, and where it goes — because the person reading
        # this alert may be a parent, and "to take photos" tells them nothing.
        NSCameraUsageDescription: >-
          Take a photo of a worksheet or a page of a book so the tutor can read
          it. The photo is sent to the tutor's server and to OpenAI, which does
          not train on it, and may be held for up to 30 days for abuse
          monitoring. Nothing is posted anywhere or shared with anyone else.
```

Then run `xcodegen generate`.

- [ ] **Step 6: Teach the store to send attachments**

In `MathTutor/TutorStore.swift`, replace `send(_:)`:

```swift
    func send(_ text: String, attachments: [UploadedAttachment] = []) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty, !isLoading, ensureTutorAvailable() else { return }

        let message = TutorMessage(
            role: .learner,
            text: trimmed,
            attachments: attachments.map(\.attachment)
        )
        session.messages.append(message)
        // Written now rather than at upload time: an attachment the learner
        // removed before sending should leave nothing behind on disk.
        let store = AttachmentStore()
        for uploaded in attachments {
            store.save(uploaded.thumbnail, for: uploaded.attachment.id, in: session.id)
        }
        session.lastSavedAt = .now
        persist()
        requestTutor(signal: nil, attachmentIDs: attachments.map(\.attachment.id))
    }
```

and thread the ids through `requestTutor` — add
`attachmentIDs: [UUID] = []` to its signature and
`attachmentIDs: attachmentIDs` to the `TutorRequest` it builds.

- [ ] **Step 7: Mount it all in both surfaces**

In `TutorPanel`, add the state and hand it to the composer:

```swift
    @StateObject private var attachments: ComposerAttachments
    @State private var pickerSource: AttachmentSource?
    @State private var isAttachMenuOpen = false
```

`composer` gains:

```swift
            onAttach: { uiState.closeSessionMenu(); isAttachMenuOpen = true },
            attachments: attachments.pending,
            onRemoveAttachment: attachments.remove,
            attachmentThumbnail: { id in
                guard case let .ready(_, thumbnail) = attachments.pending
                    .first(where: { $0.id == id })?.state else { return nil }
                return thumbnail
            }
```

The panel's `body` gains, beside the session menu:

```swift
                if isAttachMenuOpen {
                    attachMenu(in: size)
                }
```

and the view is modified with:

```swift
        .attachmentPickers(source: $pickerSource) { data, filename, contentType in
            attachments.add(
                data: data, filename: filename,
                contentType: contentType, sessionID: store.session.id
            )
        }
```

`TutorActions.send` becomes an async-dispatching closure at its construction
site, so a send waits for conversion:

```swift
        send: {
            Task {
                let ready = await attachments.readyForSend()
                store.send(text, attachments: ready)
                text = ""
                attachments.clear()
            }
        }
```

Make the same three changes in `TutorFullScreen`. Its composer already omits
the marquee (`selection: .unavailable` when nothing is attachable); the attach
button is independent of that and is drawn either way.

Also clear attachments on a session switch, in `adoptSessionUI()`:

```swift
        attachments.clear()
```

- [ ] **Step 8: Show them in the thread**

In `TutorThreadView.items`, pass the message's attachments into the row:

```swift
            ChatThreadItem(
                message,
                hasSelection: message.signal == .evaluate,
                attachments: message.attachments,
                boardViews: store.boardViews[message.id] ?? [],
                selectionView: store.selectionViews[message.id]
            )
```

`ChatThreadItem` gains the stored property, defaulted so every existing call
site and specimen keeps compiling:

```swift
    /// Files sent with this turn. Read back from `AttachmentStore`, which is
    /// why a reopened session still shows them — unlike `selectionViews`,
    /// which a board crop can be re-derived from and this cannot.
    var attachments: [MessageAttachment] = []
```

Add it to `ChatThreadItem`'s initialiser in the same position, with the same
`= []` default.

Then, wherever the student message draws its selection today — find it by
searching for `SelectionAttachment.sent` — draw the chips the same way, above
the bubble and with no ✕, because a sent message cannot be detached:

```swift
    /// The chips this turn was sent with. Read-only: `onRemove` and
    /// `onDismissSelection` do nothing, and no ✕ is drawn, because the turn has
    /// already gone.
    @ViewBuilder
    private var sentAttachments: some View {
        if !item.attachments.isEmpty {
            let metrics = AttachmentStackMetrics.composerChips(scale, width: width)
            AttachmentStack(metrics: metrics) {
                AttachmentChipRow(
                    attachments: item.attachments.map { attachment in
                        PendingAttachment(
                            id: attachment.id,
                            filename: attachment.filename,
                            state: .ready(attachment, thumbnail: Data())
                        )
                    },
                    showsSelection: false,
                    metrics: metrics,
                    thumbnail: { AttachmentStore().thumbnail(for: $0) },
                    onRemove: { _ in },
                    onDismissSelection: {}
                )
                .background(DS.Color.brandTintSoft)
            } content: {
                bubble
            }
        } else {
            bubble
        }
    }
```

`AttachmentChip` must not draw its ✕ here. Add `var isRemovable: Bool = true`
to `AttachmentChip` and `AttachmentChipRow` in Task 13's files, wrap the ✕
button in `if isRemovable`, and pass `isRemovable: false` from this call site —
the same distinction `SelectionAttachment.sent` already makes by taking no
`onDismiss`.

Read the sent-message view before writing this: `bubble` above is a placeholder
for whatever that view already calls its message body, and the `scale` and
`width` in scope there are the ones to use.

- [ ] **Step 9: Ask the user to run the tests, then the app**

Report: "Task 14 is written. Please run `xcodebuild test` — expected: 2 new
`BackendTutorServiceTests` pass and everything else still does. Then
`scripts/run-sim.sh` and try attaching a photo, a PDF and a `.docx` against a
local server."

- [ ] **Step 10: Commit**

```bash
git add MathTutor project.yml MathTutorTests
git commit -m "Attach a file in the composer and send it with the turn"
```

---

## Task 15: Document it

**Files:**
- Modify: `README.md`, `server/README.md`

- [ ] **Step 1: Write the app README section**

Under "How the app reaches its tutor" in the root `README.md`:

```markdown
### Attachments

The composer's `+` attaches a photo, a PDF, or a text file.
**The device never converts anything**: it uploads the bytes to
`POST /v1/attachments`, and the server decides what the file is, turns it into
something the model reads — a normalised JPEG, a PDF, or plain text — and hands
back a thumbnail. The turn then carries `attachment_ids`, not bytes.

So the app holds no format knowledge, no PDF library and no original files. It
keeps one small JPEG per sent attachment in `Application Support/MathTutor/
Attachments/`, deleted with the session it belongs to.

Word, Pages and the rest are refused with a sentence telling the learner to send
a PDF instead. Reading them means a headless LibreOffice on the server — a ~1GB
binary and a subprocess — for a format one tap exports a PDF from. See
`server/app/attachments/kinds.py` for the note, and how small the addition
would be if that changes.
```

- [ ] **Step 2: Write the server README section**

Under the endpoints section of `server/README.md`, document `POST /v1/attachments`:
the multipart form (`session_id`, `file`), the response fields, the four
refusal statuses (413, 415, 422, 404) and the caps, plus a line pointing at
`app/attachments/convert.py` as the ladder's source of truth.

- [ ] **Step 3: Commit**

```bash
git add README.md server/README.md
git commit -m "Document the attachment path from picker to prompt"
```
