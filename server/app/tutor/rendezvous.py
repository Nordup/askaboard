"""Asking the device for a region of the board, in the middle of a turn.

`view_board` is a tool the model calls while a turn is streaming, and the thing
that can answer it is the iPad — the board is a `PKDrawing` and only the device
can render it. So a turn has to reach *back down* the connection it is already
streaming out of, ask for a rectangle, and wait.

The shape is a rendezvous. The turn parks a future here and emits a
`board_request` down its own SSE stream; the device renders and POSTs the PNG to
`/v1/turn/{turn_id}/board`; that handler resolves the future and the turn carries
on. The SSE response is mid-flight the whole time, which is exactly why this
works: the event reaches the device before the turn blocks on the answer.

**In-process, deliberately.** The future belongs to the coroutine serving that
turn's SSE stream, and the POST that resolves it must land in the same worker or
there is nothing to resolve. That is true today because the device holds one
streaming connection to one process. If this service is ever run behind more
than one worker, the POST has to be routed to the worker holding the stream —
sticky routing, or a shared broker in place of this dict. There is no third
option, and a plain multi-worker deploy would fail intermittently and look like
a device timeout, so it is written down here rather than discovered.
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class BoardRegion:
    """A rectangle of the board, in percent of the overview, origin top left."""

    x: float
    y: float
    width: float
    height: float


class BoardUnavailable(Exception):
    """The device did not answer in time, or answered with nothing.

    Not a turn-ending error. A tutor that cannot see the board this round should
    say so and carry on, which is strictly better for the learner than a turn
    that dies holding a half-written sentence.
    """


#: How long a turn waits for the device to render one region.
#:
#: Generous, because the cost of being wrong is asymmetric. Too short and a
#: perfectly good render arrives just after the turn gave up on it, so the tutor
#: tells a learner it cannot see a board that is right there. Too long and a
#: backgrounded app makes one turn feel slow. A `PKDrawing` render of one region
#: is tens of milliseconds; the rest of this budget is network and an app that
#: may be coming back to the foreground.
RENDER_TIMEOUT_SECONDS = 20.0

_pending: dict[tuple[uuid.UUID, str], asyncio.Future[bytes]] = {}


def open_request(turn_id: uuid.UUID, call_id: str) -> asyncio.Future[bytes]:
    """Park a future for one `view_board` call and return it to be awaited."""
    future: asyncio.Future[bytes] = asyncio.get_running_loop().create_future()
    _pending[(turn_id, call_id)] = future
    return future


def deliver(turn_id: uuid.UUID, call_id: str, image: bytes) -> bool:
    """Hand the device's render to whichever turn is waiting for it.

    Returns False when nothing is waiting — a late POST after a timeout, or a
    duplicate. The caller answers that with a 404 rather than silently accepting
    bytes no one will ever read.
    """
    future = _pending.pop((turn_id, call_id), None)
    if future is None or future.done():
        return False
    future.set_result(image)
    return True


def abandon(turn_id: uuid.UUID, call_id: str) -> None:
    """Forget a request whose turn has stopped waiting.

    Called on the timeout path and whenever a turn ends, so a device that
    reconnects and replays, or simply answers late, cannot leave an entry behind
    for the lifetime of the process.
    """
    _pending.pop((turn_id, call_id), None)


async def await_render(future: asyncio.Future[bytes], *, turn_id: uuid.UUID, call_id: str) -> bytes:
    """Wait for the device's render, or give up cleanly."""
    try:
        return await asyncio.wait_for(asyncio.shield(future), RENDER_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, asyncio.CancelledError) as error:
        abandon(turn_id, call_id)
        raise BoardUnavailable() from error
