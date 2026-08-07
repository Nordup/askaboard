import secrets

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_device_token(authorization: str | None = Header(default=None)) -> None:
    if authorization is None or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
        )
    presented = authorization.removeprefix("Bearer ").strip()
    # Constant-time compare: a timing oracle on a long-lived token is worth avoiding
    # even for one device.
    if not secrets.compare_digest(presented, get_settings().device_token):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token.",
        )
