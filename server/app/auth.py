import base64
import hashlib
import hmac
import secrets
import time
import uuid

from fastapi import Header, HTTPException, Request, status

from app.config import get_settings


WEB_COOKIE_NAME = "math_tutor_session"


def _web_signature(value: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), value.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def make_web_session(secret: str, expires_at: int | None = None) -> str:
    expires = expires_at or int(time.time()) + get_settings().web_session_ttl_seconds
    value = f"{expires}.{uuid.uuid4().hex}"
    return f"{value}.{_web_signature(value, secret)}"


def valid_web_session(token: str | None, secret: str | None) -> bool:
    if not token or not secret:
        return False
    try:
        expires_text, nonce, signature = token.split(".", 2)
        expires = int(expires_text)
    except (ValueError, AttributeError):
        return False
    value = f"{expires_text}.{nonce}"
    return (
        expires >= int(time.time())
        and expires <= int(time.time()) + get_settings().web_session_ttl_seconds + 60
        and secrets.compare_digest(signature, _web_signature(value, secret))
    )


def require_same_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    host = request.headers.get("host", "").lower()
    settings = get_settings()
    if not origin or not host:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Same-origin request required.")
    from urllib.parse import urlsplit
    parsed = urlsplit(origin)
    origin_host = (parsed.netloc or "").lower()
    allowed = {item.lower() for item in settings.web_allowed_hosts}
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.scheme != request.url.scheme
        or origin_host != host
        or host not in allowed
    ):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Same-origin request required.")


async def require_device_token(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    settings = get_settings()
    if authorization is not None and authorization.startswith("Bearer "):
        presented = authorization.removeprefix("Bearer ").strip()
        if secrets.compare_digest(presented, settings.device_token):
            request.state.auth_method = "bearer"
            return
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid bearer token.")
    if valid_web_session(request.cookies.get(WEB_COOKIE_NAME), settings.web_session_secret):
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            require_same_origin(request)
        request.state.auth_method = "cookie"
        return
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing or invalid session.")
