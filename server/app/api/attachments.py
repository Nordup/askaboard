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
from typing import Annotated

from fastapi import (
    APIRouter, Depends, File, Form, Header, HTTPException, UploadFile, status,
)
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.turn import get_recorder
from app.attachments.convert import Unconvertible, convert
from app.auth import require_device_token
from app.config import DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, MAX_UPLOAD_BYTES
from app.store.db import db_session
from app.store.models import Session
from app.store.recorder import Recorder

router = APIRouter(prefix="/v1", dependencies=[Depends(require_device_token)])

#: Multipart framing — boundary lines, part headers, the trailing terminator —
#: on top of the file itself. Generous: the point is to reject a body that is
#: obviously too big, not to police the envelope to the byte.
_MULTIPART_OVERHEAD = 8192


async def _reject_oversize_body(
    content_length: Annotated[int | None, Header()] = None,
) -> None:
    """Refuse a request whose declared size already exceeds the cap.

    This is a dependency rather than a check inside the handler so it runs
    ahead of the session-existence lookup, the `convert()` call, and the
    recorder write below — none of which should happen for a request that
    was always going to be refused.

    It does *not* run ahead of Starlette's own multipart parsing: for a
    route with File()/Form() parameters, FastAPI calls `request.form()` —
    which fully drains the wire body into a spooled temp file — before
    solving any dependency, this one included. Verified directly: sending a
    multipart body in several chunks over raw ASGI, every chunk was pulled
    off the receive channel before this dependency ever raised. So this does
    not save the cost of receiving and spooling an oversized body; it saves
    everything downstream of that. The chunked read in the handler is what
    actually bounds memory for a body with no (or a lying) Content-Length.
    """
    if content_length is not None and content_length > MAX_UPLOAD_BYTES + _MULTIPART_OVERHEAD:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"That file is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)}MB. "
            "Try a photo of just the part you need.",
        )


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


@router.post(
    "/attachments",
    response_model=UploadResponse,
    dependencies=[Depends(_reject_oversize_body)],
)
async def upload_attachment(
    session_id: uuid.UUID = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(db_session),
    recorder: Recorder = Depends(get_recorder),
) -> UploadResponse:
    # Read in chunks and stop at the cap rather than reading it all and then
    # measuring: a body that arrives without a Content-Length gets no early
    # rejection above, and this is what keeps it from becoming one enormous
    # bytes object.
    buffer = bytearray()
    while chunk := await file.read(1024 * 1024):
        buffer.extend(chunk)
        if len(buffer) > MAX_UPLOAD_BYTES:
            raise HTTPException(
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                f"{file.filename} is larger than "
                f"{MAX_UPLOAD_BYTES // (1024 * 1024)}MB. Try a photo of just the part you need.",
            )
    data = bytes(buffer)

    # Created on demand, not 404'd. The device mints a session id locally and
    # the server materialises it on first contact — `/v1/turn` has always
    # worked that way, and the learner's first act in a brand-new session is
    # very often the `+` rather than a typed question: open the app, photograph
    # the worksheet, send. Refusing that would 404 the feature's opening move,
    # and the chip would read "No such session" at the one moment nothing is
    # wrong.
    #
    # The form carries no model or effort, hence the defaults; the next turn
    # overwrites both with what the device actually has selected. Same shape as
    # `/v1/dictation`, which reaches a session before any turn for the same
    # reason.
    if await db.get(Session, session_id) is None:
        db.add(Session(
            id=session_id,
            model=DEFAULT_MODEL,
            reasoning_effort=DEFAULT_REASONING_EFFORT,
        ))
        try:
            await db.commit()
        except IntegrityError:
            # Two uploads racing on the same brand-new session id — the learner
            # picking a second file before the first has landed. Whichever lost
            # simply adopts the row the other wrote.
            await db.rollback()

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
