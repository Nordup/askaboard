"""Where this service's logs go, and why it has any.

The turn that prompted this file failed twice, cost real money, and left
nothing behind to read. Everything that could have explained it was either
never written or written somewhere that does not survive: the turn row said
`running` and nothing else, and the only narration the process produced went
to a terminal running `uvicorn --reload`, which is to say it went nowhere the
moment that terminal scrolled or closed.

So: a rotating file, always, next to the blob store. Stdout stays exactly as
it was for anyone watching the terminal live — this adds a copy that is still
there tomorrow.
"""

from __future__ import annotations

import logging
import logging.handlers
from pathlib import Path

#: Enough history to cover several days of ordinary use and still be greppable
#: in one pass. Five files of 5 MB, oldest discarded.
MAX_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 5

#: `key=value` after a readable prefix: skimmable by a person scrolling and
#: greppable by anything else. `turn_id=...` is the join key to the `turns`
#: table, which is the whole point — a line here and a row there describe the
#: same event and can be put side by side.
FORMAT = "%(asctime)s %(levelname)-7s %(name)s | %(message)s"

#: uvicorn sets `propagate=False` on its own loggers, so its request log and its
#: tracebacks never reach the root logger. They are named here because "the
#: server restarted mid-turn" and "the request was never answered" are both
#: things only uvicorn sees, and both are exactly what someone reading this file
#: after a failed turn needs.
#:
#: They are *re-propagated* rather than given a handler of their own. Attaching
#: the file handler to each of them writes some lines twice — `uvicorn.error`
#: has no `propagate=False` of its own, so it already reaches `uvicorn`, and a
#: handler on both logs the same record at both. Letting them propagate to the
#: root instead means exactly one handler sees each record, and uvicorn's own
#: stdout handlers keep working untouched on the way up.
UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

_configured = False


def configure_logging(log_dir: Path, *, level: int = logging.INFO) -> Path:
    """Send this process's logs to a rotating file as well as stdout.

    Idempotent: called from the app's lifespan, and `uvicorn --reload` starts
    that more than once per process lifetime in development. Returns the path
    of the file being written, so the caller can say where it is.
    """
    global _configured

    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / "server.log"
    if _configured:
        return path

    handler = logging.handlers.RotatingFileHandler(
        path, maxBytes=MAX_BYTES, backupCount=BACKUP_COUNT, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter(FORMAT))

    root = logging.getLogger()
    root.setLevel(level)
    root.addHandler(handler)

    for name in UVICORN_LOGGERS:
        logging.getLogger(name).propagate = True

    _configured = True
    return path
