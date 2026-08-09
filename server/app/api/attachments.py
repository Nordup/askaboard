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
