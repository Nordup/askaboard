from __future__ import annotations

import secrets
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from app.auth import WEB_COOKIE_NAME, make_web_session, require_same_origin, valid_web_session
from app.config import EFFORTS_FOR_MODEL, MODEL_ALLOWLIST, get_settings

router = APIRouter(prefix="/v1/web")
_attempts: dict[str, tuple[int, float]] = {}
_WINDOW_SECONDS = 300.0
_MAX_ATTEMPTS = 5
_MAX_TRACKED_IPS = 1024


class LoginBody(BaseModel):
    code: str = Field(min_length=1, max_length=128)


def _check_login_rate(ip: str) -> None:
    now = time.monotonic()
    count, started = _attempts.get(ip, (0, now))
    if now - started >= _WINDOW_SECONDS:
        count, started = 0, now
    if count >= _MAX_ATTEMPTS:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many login attempts.")
    if len(_attempts) >= _MAX_TRACKED_IPS and ip not in _attempts:
        oldest = min(_attempts, key=lambda key: _attempts[key][1])
        _attempts.pop(oldest, None)
    _attempts[ip] = (count + 1, started)


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response):
    require_same_origin(request)
    settings = get_settings()
    ip = request.client.host if request.client else "unknown"
    _check_login_rate(ip)
    expected = settings.web_bootstrap_code
    if not expected or not settings.web_session_secret:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Browser login is not configured.")
    if not secrets.compare_digest(body.code, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid access code.")
    expires = int(time.time()) + settings.web_session_ttl_seconds
    response.set_cookie(
        WEB_COOKIE_NAME,
        make_web_session(settings.web_session_secret, expires),
        max_age=settings.web_session_ttl_seconds,
        httponly=True,
        secure=settings.web_session_secure,
        samesite="strict",
        path="/v1",
    )
    return {"authenticated": True, "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat()}


@router.get("/status")
async def web_status(request: Request):
    settings = get_settings()
    return {
        "authenticated": valid_web_session(
            request.cookies.get(WEB_COOKIE_NAME), settings.web_session_secret
        ),
        "models": sorted(MODEL_ALLOWLIST),
        "efforts_for_model": {
            model: sorted(efforts) for model, efforts in EFFORTS_FOR_MODEL.items()
        },
        "live_available": bool(settings.openai_api_key),
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response):
    require_same_origin(request)
    response.delete_cookie(WEB_COOKIE_NAME, path="/v1", httponly=True, secure=get_settings().web_session_secure, samesite="strict")
