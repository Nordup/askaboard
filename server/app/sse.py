from pydantic import BaseModel


def format_sse(event: BaseModel) -> str:
    return f"data: {event.model_dump_json()}\n\n"


SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    # Without this a reverse proxy buffers the whole stream and delivers every
    # token at once, which is exactly the wait this design removes.
    "X-Accel-Buffering": "no",
}
