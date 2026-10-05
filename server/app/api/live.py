"""GPT-Live WebRTC session exchange and duration accounting."""
from __future__ import annotations

import logging
import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.api.realtime import _memory_sections, redact_api_key
from app.api.turn import get_recorder
from app.auth import require_device_token
from app.config import get_settings
from app.store.db import db_session
from app.store.models import LiveSession, LiveUsage, Message, Session
from app.store.recorder import Recorder
from app.tutor.prompt import standing_memory_blocks

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/v1/live", dependencies=[Depends(require_device_token)])
LIVE_MODEL_ALLOWLIST = frozenset({"gpt-live-1"})
LIVE_USD_PER_MINUTE = 0.05
LIVE_MINIMUM_BILLED_SECONDS = 15
MAX_SESSION_SECONDS = 24 * 60 * 60
UPSTREAM_TIMEOUT_SECONDS = 30.0

LIVE_INSTRUCTIONS = """You are the spoken voice of the learner's mathematics tutor.
Be warm, curious, concise, and adapt to the learner's intent. When they are
working something out, help them make progress without jumping ahead; ask one
useful question at a time. Handle greetings, acknowledgements, clarification,
and repeating something already said yourself. For every math question, factual
research, board inspection, explanation, drawing, exercise, plan, or memory
action, delegate the request to the browser application. It runs the same tutor
that sees the board and owns the session; wait for its result, then explain
that result aloud in a short natural summary. You cannot see the board: never
guess what is written there, claim that you inspected it, or promise a board
change before the application confirms it. Keep speech conversational and do
not read formulas or long written explanations aloud. If the learner asks for
quiet, stop speaking and wait for them to resume you."""

# OpenAI documents up to 128 initial messages / 8,192 rendered tokens. Budget
# only 7,000 UTF-8 bytes for text so item framing and tokenization overhead stay
# comfortably below that cap.
LIVE_HISTORY_MESSAGES = 128
LIVE_HISTORY_TEXT_BYTES = 7_000


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS)


class LiveCallBody(BaseModel):
    session_id: uuid.UUID | None = None
    sdp: str = Field(min_length=1, max_length=200_000)


class LiveUsageBody(BaseModel):
    live_session_id: str = Field(min_length=1, max_length=128)
    session_id: uuid.UUID | None = None
    model: str = "gpt-live-1"
    duration_seconds: int = Field(ge=0, le=MAX_SESSION_SECONDS)


async def _instructions(recorder: Recorder, session_id: uuid.UUID | None) -> str:
    if session_id is None:
        return LIVE_INSTRUCTIONS
    try:
        sections = await _memory_sections(recorder.sessions, session_id=session_id)
        blocks = standing_memory_blocks(**sections)
        return f"{LIVE_INSTRUCTIONS}\n\n{blocks}" if blocks else LIVE_INSTRUCTIONS
    except Exception as error:
        logger.warning("live.calls memory unavailable | %s: %s", type(error).__name__, error)
        return LIVE_INSTRUCTIONS


async def _history(recorder: Recorder, session_id: uuid.UUID | None) -> list[dict]:
    """Render recent persisted messages in GPT-Live's initial-input shape."""
    if session_id is None:
        return []
    try:
        async with recorder.sessions() as db:
            rows = (await db.execute(
                select(Message.role, Message.text)
                .where(Message.session_id == session_id, Message.role.in_(["learner", "tutor"]))
                .order_by(Message.seq.desc())
                .limit(LIVE_HISTORY_MESSAGES)
            )).all()
    except Exception as error:
        logger.warning("live.calls transcript unavailable | %s: %s", type(error).__name__, error)
        return []

    remaining = LIVE_HISTORY_TEXT_BYTES
    history = []
    for role, original in reversed(rows):
        text = original or ""
        encoded_size = len(text.encode("utf-8"))
        if encoded_size > remaining:
            suffix = []
            used = 0
            for character in reversed(text):
                size = len(character.encode("utf-8"))
                if used + size > remaining:
                    break
                suffix.append(character)
                used += size
            text = "".join(reversed(suffix))
            encoded_size = used
        if not text:
            break
        api_role = "user" if role == "learner" else "assistant"
        content_type = "input_text" if api_role == "user" else "output_text"
        history.append({
            "type": "message", "role": api_role,
            "content": [{"type": content_type, "text": text}],
        })
        remaining -= encoded_size
        if remaining <= 0:
            break
    return history


@router.post("/calls")
async def create_live_call(
    body: LiveCallBody,
    recorder: Recorder = Depends(get_recorder),
) -> dict:
    settings = get_settings()
    if settings.openai_live_model not in LIVE_MODEL_ALLOWLIST:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Configured Live model is not allowed.")
    if not settings.openai_api_key:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Live voice is not configured.")
    if not body.sdp.lstrip().startswith("v="):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Body must contain an SDP offer.")
    if body.session_id is not None:
        try:
            async with recorder.sessions() as db:
                if await db.get(Session, body.session_id) is None:
                    raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown application session.")
        except HTTPException:
            raise
        except Exception as error:
            logger.error("live.calls could not verify application session | %s", type(error).__name__)
            raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not verify the application session.") from error
    minimum_cost = LIVE_MINIMUM_BILLED_SECONDS / 60 * LIVE_USD_PER_MINUTE
    if await recorder.spend_today() + minimum_cost > settings.daily_spend_cap_usd:
        raise HTTPException(status.HTTP_402_PAYMENT_REQUIRED, "Daily spend cap reached.")

    payload = {
        "session": {
            "model": settings.openai_live_model,
            "instructions": await _instructions(recorder, body.session_id),
            "input": await _history(recorder, body.session_id),
            "audio": {"output": {"voice": "marin"}},
            "delegation": {"type": "client"},
        },
        "transport": {"type": "webrtc", "sdp": body.sdp},
    }
    try:
        async with _client() as client:
            upstream = await client.post(
                f"{settings.openai_base_url.rstrip('/')}/live/sessions",
                headers={"Authorization": f"Bearer {settings.openai_api_key}"},
                json=payload,
            )
    except httpx.HTTPError as error:
        logger.error("live.calls transport error | %s", type(error).__name__)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "Could not reach the Live API.") from error
    if upstream.is_error:
        detail = redact_api_key(upstream.text[:1000], settings.openai_api_key)
        logger.error("live.calls upstream rejected request | status=%s body=%s", upstream.status_code, detail)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "The Live API rejected the session request.")
    try:
        result = upstream.json()
        session_id = result["session"]["id"]
        answer = result["transport"]["sdp"]
        if not isinstance(session_id, str) or not isinstance(answer, str) or not answer:
            raise ValueError("invalid Live response")
    except (ValueError, KeyError, TypeError) as error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, "The Live API returned an invalid session response.") from error
    try:
        async with recorder.sessions() as db:
            db.add(LiveSession(
                live_session_id=session_id,
                session_id=body.session_id,
                model=settings.openai_live_model,
            ))
            db.add(LiveUsage(
                live_session_id=session_id,
                session_id=body.session_id,
                model=settings.openai_live_model,
                duration_seconds=LIVE_MINIMUM_BILLED_SECONDS,
                cost_usd=minimum_cost,
            ))
            await db.commit()
    except Exception as error:
        logger.error("live.calls could not register session | %s", type(error).__name__)
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Could not register the Live session.") from error
    return {"session": {"id": session_id}, "transport": {"type": "webrtc", "sdp": answer}}


@router.post("/usage", status_code=status.HTTP_204_NO_CONTENT)
async def record_live_usage(body: LiveUsageBody, db=Depends(db_session)):
    if body.model not in LIVE_MODEL_ALLOWLIST:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown Live model.")
    registered = await db.get(LiveSession, body.live_session_id)
    if registered is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown Live session.")
    if body.model != registered.model or body.session_id != registered.session_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "Usage does not match the Live session.")
    statement = pg_insert(LiveUsage).values(
        live_session_id=body.live_session_id,
        session_id=body.session_id,
        model=body.model,
        duration_seconds=body.duration_seconds,
        cost_usd=body.duration_seconds / 60 * LIVE_USD_PER_MINUTE,
    )
    statement = statement.on_conflict_do_update(
        index_elements=[LiveUsage.live_session_id],
        set_={
            "duration_seconds": statement.excluded.duration_seconds,
            "cost_usd": statement.excluded.cost_usd,
            "session_id": statement.excluded.session_id,
            "model": statement.excluded.model,
            "updated_at": func.now(),
        },
        where=statement.excluded.duration_seconds > LiveUsage.duration_seconds,
    )
    await db.execute(statement)
    await db.commit()
