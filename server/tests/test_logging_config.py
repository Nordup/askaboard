import logging

from app.logging_config import UVICORN_LOGGERS, configure_logging
import app.logging_config as logging_config


def _reset() -> None:
    """Undo a previous configure_logging so each test starts from nothing.

    The module guards against configuring twice on purpose — `uvicorn --reload`
    restarts the lifespan inside one process — so a test that wants a fresh
    configuration has to say so.
    """
    logging_config._configured = False
    root = logging.getLogger()
    for handler in list(root.handlers):
        if isinstance(handler, logging.handlers.RotatingFileHandler):
            root.removeHandler(handler)
            handler.close()
    for name in UVICORN_LOGGERS:
        logging.getLogger(name).propagate = False


def test_a_log_line_reaches_a_file_that_outlives_the_terminal(tmp_path):
    """The whole point: `uvicorn --reload` writes to a terminal, and a terminal
    is not somewhere a failure from last night can be read from."""
    _reset()
    try:
        path = configure_logging(tmp_path / "logs")
        logging.getLogger("app.api.turn").warning(
            "turn failed | turn_id=abc max_silence_ms=61000"
        )
        for handler in logging.getLogger().handlers:
            handler.flush()

        assert path.exists()
        written = path.read_text()
        assert "turn failed" in written
        assert "max_silence_ms=61000" in written
        # The join key to the `turns` table has to survive formatting.
        assert "turn_id=abc" in written
    finally:
        _reset()


def test_configuring_twice_does_not_double_every_line(tmp_path):
    """`uvicorn --reload` runs the lifespan again in the same process. Without
    the guard that means two handlers on the root logger and every subsequent
    line written twice, which is how a log stops being trustworthy."""
    _reset()
    try:
        configure_logging(tmp_path / "logs")
        path = configure_logging(tmp_path / "logs")
        logging.getLogger("app.api.turn").warning("only once")
        for handler in logging.getLogger().handlers:
            handler.flush()

        assert path.read_text().count("only once") == 1
    finally:
        _reset()


def test_uvicorns_own_loggers_are_captured_too(tmp_path):
    """uvicorn sets propagate=False, so without this the two things only it
    knows — that the server restarted mid-turn, and that a request was never
    answered — never reach the file."""
    _reset()
    try:
        path = configure_logging(tmp_path / "logs")
        logging.getLogger("uvicorn.error").warning("shutting down")
        for handler in logging.getLogger().handlers:
            handler.flush()

        assert "shutting down" in path.read_text()
    finally:
        _reset()


def test_a_uvicorn_line_is_written_once_not_once_per_ancestor(tmp_path):
    """Observed in the real log before it was fixed: every uvicorn line appeared
    twice. `uvicorn.error` does not set `propagate=False` of its own, so it
    already reaches `uvicorn` — putting the file handler on both logged each
    record at both, and a log that repeats itself is a log nobody trusts."""
    _reset()
    try:
        path = configure_logging(tmp_path / "logs")
        logging.getLogger("uvicorn.error").warning("Application startup complete.")
        for handler in logging.getLogger().handlers:
            handler.flush()

        assert path.read_text().count("Application startup complete.") == 1
    finally:
        _reset()
