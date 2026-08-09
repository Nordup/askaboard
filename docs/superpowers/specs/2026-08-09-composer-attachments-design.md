# Composer Attachments — Design

**Date:** 2026-08-09
**Status:** Approved, ready for implementation planning

## Problem

The tutor can only be shown one kind of thing: ink the learner drew on this
device's board. `TutorRequest.imageData` is a region lassoed out of the canvas,
`boardOverview` is a thumbnail of that same canvas, and both are rendered by
`CanvasCapture` from a live `PKDrawing`. Nothing that did not originate as a
stroke on the board can reach the model at all.

That excludes most of what a learner actually has in front of them. A printed
worksheet. A photograph of the whiteboard at school. A page of the textbook. A
PDF the teacher emailed. A screenshot of a question. Today the only way to put
any of those in front of the tutor is to copy the problem out by hand onto the
board first — which is the learner doing transcription work as a toll for
asking a question, and which loses the diagram entirely.

So: a `+` in the composer's leading slot, the way every chat application has
one. Attach a photo, take a photo, or pick a file; it goes up with the message;
the tutor sees it. When the attachment is a problem to solve, the tutor
transcribes it onto the board with the drawing tool it already has and coaches
from there, rather than answering it outright.

What this is **not** is a second board. The attachment reaches the model and
the thread; it does not become an object on the canvas. That is a real feature
— an image element kind in `BoardScene`, with persistence, rendering, and
placement — and it is a different one.

## Approach

Two halves, split on a single rule: **the device never converts anything.**

The device picks bytes and uploads them. The server decides what a file is,
turns it into something the model can read, and hands back a thumbnail. Every
format question — HEIC, PDF, Word, a `.csv` — is answered in one place, in
Python, where the libraries are, and is testable without a simulator.

The upload is its own request, not part of the turn. The turn carries
`attachment_ids`.

### What already exists and is reused

- **The attachment card.** `AttachmentStack` and `SelectionAttachment` already
  draw a `--color-brand-tint-soft` card above the pill with the notch rule from
  board 03 §2, in both the composer's dismissible form and the sent message's
  read-only one. Attachments render in that card; they do not get a new one.
- **`ui/plus`.** Already in `design/icons.json`, drawn today inside board 15a's
  `row/new-session`. No new icon.
- **The menu construction.** `SessionMenu` establishes how this product draws a
  menu hanging off a control: a card in the panel's own column, drawn inside
  the panel because the panel clips to its radius, with a transparent dismiss
  layer mounted only while it is open.
- **`Recorder.record_attachment`** and the content-addressed blob store. The
  upload endpoint's storage already exists, including the "at least one of
  turn_id / session_id" invariant.
- **`assemble_context`.** It already builds an `input_image` part from bytes.
  Attachments add parts to the same list, in the same function.
- **Out-of-band bytes.** `POST /v1/turn/{turn_id}/board` already establishes
  that large payloads travel outside the turn body.

### The one external dependency

LibreOffice, headless, as a subprocess, to turn Office and iWork documents into
PDF. It is the only piece of this that is not a Python package.

The alternative considered and rejected was `python-docx`-style text
extraction. For a math worksheet the layout *is* the content: a fraction laid
out over two lines, a geometry figure, an equation with alignment. Text
extraction discards precisely the part the tutor needs to read. LibreOffice
preserves it, and PDF is a format the model reads natively.

## The composer

### The leading slot

`+` then the marquee, in that order — the marquee keeps its position relative
to the text, and the new control reads as the outermost thing in the row.

`ComposerMetrics.placeholderWidth(includingMarquee:)` is the arithmetic that
closes the row; it grows a second flag rather than a special case. The text
lane at both scales:

| | panel (301) | full-screen (740) |
|---|---|---|
| today | 151 | 534 |
| with `+` | 121 | 498 |

The `+` is drawn at **20**, the single render size `design/icons.json` publishes
for `ui/plus` — not stepped up to the marquee's 24 to make the two glyphs
match. It is the same rule the marquee itself is held to at full-screen, where
it stays 24 while every other glyph in the row steps up: inventing a render
size for a documented icon to tidy an alignment is how an icon set drifts.

It carries the same `expandedTapTarget(ComposerMetrics.minimumTapTarget, over:)`
treatment as the marquee, so the tap target is 44 and the row arithmetic does
not move.

**Its colour is the one open question for Paper.** `ui/plus` is the only glyph
in the set whose colour token is `--color-brand` rather than `--color-icon`,
and board 15a explains why: on the session menu *"it is not chrome, it is the
one action on the menu."* In the composer it is chrome — one of four controls
in a row where everything else is grey, and a violet `+` sitting beside a grey
marquee would read as lit, which is what the marquee's violet already means.
This design assumes `--color-icon`, which is a deliberate departure from the
glyph's published token and belongs in the Paper file with a note rather than
in a Swift file as a surprise.

While the dictation lane is open the leading slot belongs to the cancel cross,
exactly as it does today, and the `+` is not drawn. A lasso attachment is
meaningless while the microphone is open and so is a file picker.

### The menu

Tapping `+` opens a three-row card: **Photo Library**, **Take Photo**, **Files**.
Built the way `SessionMenu` is built — inside the surface, in its content
column, with a transparent dismiss layer mounted only while open — not as a
system `Menu`, so it carries the product's own type and spacing.

Each row leads to a standard iOS picker: `PhotosPicker` for the library, a
camera presentation for the photo, `.fileImporter` for Files. The pickers are
presented by the surface that owns the composer, so both `TutorPanel` and
`TutorFullScreen` mount them.

### Attached state

The card above the pill holds a horizontal row of chips. Each chip is a
thumbnail, a name, and its own ✕.

**The board selection becomes one of those chips.** It is already an
attachment: it already draws this card, and it already survives into the sent
message as `SelectionAttachment.sent`. Unifying them means a learner can send a
worksheet *and* a lassoed region of their own attempt in one turn, which is the
obvious case — *"here is the problem, here is what I tried."*

`ComposerSelection` therefore stops being the sole driver of whether the card
appears. The card is drawn when there is anything at all attached; the
`.attached` case becomes one contributor to that.

A chip whose file is still converting is drawn in a converting state. A send
that lands while a conversion is in flight waits for it rather than dropping
the attachment. A chip whose upload was refused carries the server's sentence,
and the learner removes it.

### The sent message

`SelectionAttachment.sent` with the same chip row — the path screen 08's
`msg/student · with selection` already draws, with more than one occupant.

### Paper first

The `+`, the attach menu, and the multi-chip card are drawn in Paper and
extracted to code from there, per the project's rule that the design file is
the source of truth and code is its transcription. The numbers in this document
are the constraints that drawing has to satisfy, not a substitute for it.

## The wire

### Upload

```
POST /v1/attachments
Authorization: Bearer <device token>
Content-Type: multipart/form-data

session_id=<uuid>
file=<bytes, with filename and content type>
```

```json
{
  "id": "<uuid>",
  "kind": "image | pdf | document | text",
  "page_count": 3,
  "thumbnail_base64": "..."
}
```

A `200` means converted and stored. There is no status field and nothing to
poll: the chip's converting state is this request being in flight, not a server
state the device asks about.

Failures are answered at upload time, not at send time, so the learner learns
that a file cannot be read while they are still looking at the picker:

- `413` — over the size cap.
- `415` — a type no rung of the ladder handles, with a sentence written for the
  learner rather than for a log.
- `422` — a file that matched a rung and failed to convert (a corrupt PDF, a
  LibreOffice timeout), also with a learner-facing sentence.

The response is returned when conversion has finished. There is no job queue: a
LibreOffice run inside the request is a few seconds, it happens while the
learner is still typing, and a queue would add a polling protocol to save
nothing.

`multipart` rather than base64 JSON because `python-multipart` is already a
dependency and base64 inflates every upload by a third.

### Turn

`TurnRequest` gains one field:

```python
attachment_ids: list[uuid.UUID] = []
```

`image_base64` and `board_overview_base64` are untouched. The lassoed region
keeps its existing path — it is rendered on the device from the live canvas,
it is not a file, and routing it through an upload endpoint would add a round
trip to the product's most common interaction.

An id that does not exist, or that belongs to a different session, is a `400`.
The scoping check is the point: an attachment id is a capability, and one
device must not be able to name another's.

`TutorRequest` on the device gains the matching `attachmentIDs: [UUID]`, and
`BackendTutorService.body(for:)` emits it when non-empty.

## The server's conversion ladder

Each rung lands on a content part `assemble_context` already knows how to
build, or on the one new one.

| Incoming | Becomes | How |
|---|---|---|
| `image/*`, including HEIC | `input_image`, `detail: "original"` | Pillow + pillow-heif; normalise to JPEG, longest edge capped |
| `application/pdf` | `input_file` with `filename` | passthrough |
| docx, xlsx, pptx, pages, key, numbers, rtf, odt | `input_file` with `filename` | LibreOffice headless → PDF |
| txt, md, csv, json, source | `input_text`, fenced and named | UTF-8 decode, capped |
| anything else | `415` at upload | — |

`input_file` is a first-class content part of the Responses API alongside
`input_text` and `input_image`, taking `file_data` and `filename`. This is why
PDFs need no rasterizing, and why every document rung can aim at PDF rather
than at a pile of page images.

Type is decided from the bytes' own magic first and the filename's extension
second, so a `.txt` that is really a JPEG is handled as what it is.

### Thumbnails

The server returns the thumbnail because it has already opened the file:
downscale for an image, first page for a PDF, first page of the converted PDF
for a document, and a rendering of the first lines for text.

The device therefore stores a small JPEG and a name per attachment — never the
original. A 20MB Keynote costs the device a few kilobytes.

### Caps

| | |
|---|---|
| bytes per file | 25 MB |
| attachments per turn | 5 |
| pages per document | 20 |
| characters per text file | 100,000 |

Each is a named constant in `app/config.py`, alongside the ones already there.
Over a cap is a refusal with a learner-facing sentence, never a silent
truncation.

Three of the four are enforced at upload, where the bytes are. The count is
enforced when the turn is submitted, because that is where a set of attachments
first exists; the composer also declines to add a sixth chip, so reaching the
server's check means something went wrong rather than a learner tapping `+`
once too often.

### Recording

One `attachments` row per upload, `kind: "learner_upload"`, session-scoped with
a null `turn_id` — exactly how a dictation's audio is stored, and the case that
column was made nullable for. The row carries both blob keys: the original the
learner sent, and the converted bytes the model actually saw. Those are the two
things a later investigation needs.

The link from a turn back to its attachments is the turn's own recorded request
body, which already names `attachment_ids` verbatim. There is no second row per
turn: the same worksheet re-sent across three turns is one upload and three
references, and the transcript already says so.

The blob store is content-addressed, so the same worksheet uploaded twice costs
one blob — the behaviour `Recorder` already has.

## The prompt

`compose_user_prompt`'s `has_image` block generalises. It currently says one
thing — *"VISIBLE ATTEMPT: ground feedback in legible lines from the image"* —
which is right for a lassoed region of the learner's own work and wrong for a
photograph of a textbook page.

The block gains an inventory of what is attached, by name and page count, and
splits its guidance:

- **The learner's own work** (a lassoed region, or a photo of their attempt) —
  the existing instruction, unchanged.
- **A problem to solve** — transcribe it onto the board with `update_board`
  before coaching, then teach from the board. Not answer it. The transcription
  is also the check that the tutor read it correctly, and it puts the problem
  somewhere the learner can write underneath.

The distinction is the model's to draw from the material; the prompt names both
cases rather than trying to classify on the server.

## Persistence

The thread has to still show a sent attachment after the app is relaunched,
which nothing on this path does today: `boardViews` and `selectionViews` are
`@Published` dictionaries keyed by message id, and `TutorMessage` carries no
image. A reopened session loses its thumbnails.

A photo of homework is not re-derivable the way a board crop is, so
attachments persist:

- A sidecar directory beside the session JSON holds one JPEG per attachment.
- `TutorMessage` gains `attachments: [MessageAttachment]` — id, filename, kind,
  page count, thumbnail filename. It is `Codable`, so it rides the existing
  session save.
- Deleting a session deletes its sidecar directory.

The in-memory `selectionViews` behaviour for lassoed regions is left alone.
Changing it is a separate improvement and this design does not need it.

## Testing

**Server** — the ladder is pure input/output and gets the bulk of the coverage:

- One test per rung: image normalisation including HEIC, PDF passthrough, a
  document through LibreOffice, text inlining.
- Type decided from magic bytes over a lying extension.
- Each cap: oversize file, sixth attachment, page overflow, text truncation.
- `415` for an unhandled type; `422` for a file that fails conversion.
- `attachment_ids` → the exact content-part list `assemble_context` produces.
- An attachment id from another session is refused.
- The two `record_attachment` rows, and the blob dedup on a repeat upload.

**Device**:

- `placeholderWidth(includingMarquee:)` with the `+` present, at both scales,
  closing the row exactly — the existing `ComposerMetrics` tests extended.
- The attach menu opens, dismisses on outside tap, and does not draw while
  dictation holds the leading slot.
- Chips add and remove; the card appears for a file with no board selection.
- A send during conversion waits rather than dropping the attachment.
- `TutorMessage` with attachments round-trips through `SessionPersistence`, and
  a deleted session takes its sidecar with it.
- `BackendTutorService.body(for:)` emits `attachment_ids` only when non-empty.

## Out of scope

- The attachment as an object on the board. Needs an image element kind in
  `BoardScene` with persistence, rendering, and placement.
- Attachments on a dictated turn.
- Reading an attachment back out of the thread — tapping a chip to view it full
  size.
- Migrating the lassoed region onto the upload endpoint.
