"""LangSmith tracing for tutor turns, kept deliberately narrow.

Phases 0-1 wire a small, manual LangSmith trace around the existing turn path:
one root span spanning the whole turn and a handful of child spans covering
the diagnosable steps (context assembly, each model round, board decisions,
tool waits, persistence). Nothing here wraps provider clients, rewrites
request payloads, or changes retry behaviour.

The module is fail-open by construction. With tracing disabled (the default),
the factory returns a client whose spans are all no-ops, so a server with no
``LANGSMITH_API_KEY`` pays nothing and never imports the SDK at runtime. When
enabled, every SDK interaction — importing, constructing the client,
entering or exiting a trace, ending or flushing — is wrapped so a LangSmith
outage can log but never fail, cancel, or delay a turn. In particular,
application flow never awaits the SDK on the SSE path, and the shutdown flush
is best-effort and time-boxed.

Concurrency: each span owns its own LangSmith ``RunTree`` and parenting is
always explicit (a child names its parent). There is no module-level mutable
parent state, so concurrent turns in one process cannot cross-wire.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: The orchestrator build this server implements. Bumped when the turn
#: orchestration changes; carried on every trace so a trace can be matched to
#: the code that produced it.
ORCHESTRATION_VERSION = "2026.08.31"
#: The schema of the attributes this module writes. Bumped only when an
#: attribute name, shape, or semantic changes; independent of the app version.
TRACE_SCHEMA_VERSION = 1

#: Stable LangSmith span names. Tests pin these, so rename with intent.
ROOT_SPAN_NAME = "tutor.turn"
CONTEXT_SPAN_NAME = "tutor.context"
ROUND_SPAN_NAME = "llm.round"
BOARD_GATE_SPAN_NAME = "tutor.board_gate"
FETCH_IMAGE_SPAN_NAME = "tool.fetch_image"
WEB_SEARCH_SPAN_NAME = "tool.web_search"
MEMORY_TOOL_SPAN_NAME = "tool.memory"
VIEW_BOARD_SPAN_NAME = "tool.view_board"
FILE_RELAY_SPAN_NAME = "tool.file_relay"
FAILURE_SPAN_NAME = "tutor.persist_failure"
FINISH_SPAN_NAME = "tutor.persist_finish"


@dataclass
class TraceConfig:
    """What the trace factory needs to know, taken from ``Settings``.

    The flag and key are read once, at factory time. ``tracing`` being False or
    ``api_key`` being empty both mean "do literally nothing".
    """

    enabled: bool
    api_key: str
    project: str
    endpoint: str
    workspace_id: str | None = None


def _bounded_data(
    values: dict[str, Any] | None, *, string_limit: int
) -> dict[str, Any]:
    """Return JSON-safe trace data with bounded strings and collections."""
    if not values:
        return {}

    def bound(value: Any) -> Any:
        if isinstance(value, bytes):
            return None
        if isinstance(value, str):
            return value[:string_limit]
        if isinstance(value, dict):
            return {
                str(key): bound(item)
                for key, item in list(value.items())[:50]
                if not isinstance(item, bytes)
            }
        if isinstance(value, (list, tuple, set)):
            return [bound(item) for item in list(value)[:50]]
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return str(value)[:string_limit]

    return {
        str(key): bound(value)
        for key, value in values.items()
        if not isinstance(value, bytes)
    }


def bounded_outputs(outputs: dict[str, Any] | None) -> dict[str, Any]:
    """Return a bounded, structured version of ``outputs`` for LangSmith.

    Keeps field names and scalar values intact so LangSmith can filter/compare
    on them (``status``, ``token_usage``, ``tool_names``, timing, ...), while
    truncating oversized strings and collections and omitting bytes, so a
    single span cannot bloat the run payload.
    """
    return _bounded_data(outputs, string_limit=2000)


class NullSpan:
    """The no-op span returned while tracing is disabled or failing.

    Mirrors the real handle's surface so callers never branch on
    configuration. ``parent`` markers are ``None``.
    """

    parent = None

    def span(self, **_: Any) -> "NullSpan":
        return NullSpan()

    def tracing_context(self, **_: Any) -> _NullContext:
        return _null_context()

    def __enter__(self) -> "NullSpan":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def end(self, **_: Any) -> None:
        return None

    @property
    def duration_seconds(self) -> float:
        return 0.0

    @property
    def ended(self) -> bool:
        return True


def _is_span(obj: Any) -> bool:
    """Whether ``obj`` implements the span protocol used across the app."""
    return hasattr(obj, "end") and hasattr(obj, "__enter__") and hasattr(
        obj, "__exit__"
    )


class _NullContext:
    def __enter__(self) -> "_NullContext":
        return self

    def __exit__(self, *_: Any) -> None:
        return None


class _TracingContextGuard:
    """Exits a ``langsmith.tracing_context`` exactly once, fail-open."""

    def __init__(self, ctx: Any) -> None:
        self._ctx = ctx
        self._exited = False

    def __enter__(self) -> "_TracingContextGuard":
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._exited:
            return
        self._exited = True
        try:
            if not exc:
                exc = (None, None, None)
            if len(exc) == 1 and exc[0] is None:
                exc = (None, None, None)
            self._ctx.__exit__(*exc)
        except Exception:
            logger.exception("langsmith tracing_context exit failed")


def _null_context() -> _NullContext:
    return _NullContext()


class Span:
    """One in-flight LangSmith span.

    Wraps a ``langsmith.trace`` context. ``__enter__`` runs the SDK's sync
    context setup (never awaited), and ``__exit__`` finalises it through the
    SDK's own teardown, which posts the span to the background batcher.
    ``end`` records curated outputs/error once; a second call is a no-op so
    every exit path can call it safely.
    """

    def __init__(self, trace_obj: Any) -> None:
        self._trace = trace_obj
        self._name = getattr(trace_obj, "name", "unknown")
        self.run: Any = None
        self.started = time.monotonic()
        self._enter_attempted = False
        self._trace_entered = False
        self._exited = False
        self._end_called = False

    def __enter__(self) -> "Span":
        if self._enter_attempted:
            return self
        self._enter_attempted = True
        try:
            self.run = self._trace.__enter__()
            self._trace_entered = True
        except Exception:
            logger.exception("langsmith span %s enter failed", self._name)
        return self

    def __exit__(self, *exc: Any) -> None:
        if self._exited:
            return
        self._exited = True
        try:
            if not exc:
                exc = (None, None, None)
            if len(exc) == 1 and exc[0] is None:
                exc = (None, None, None)
            # Auto-end when the body never called end() explicitly, so a
            # `with span:` block cannot leak an open run even on a raise.
            if not self._end_called:
                self.end(
                    status="failed" if exc[0] is not None else "ok",
                    error=(
                        f"{getattr(exc[0], '__name__', 'Exception')}: {exc[1]}"
                        if exc[0] is not None else None
                    ),
                    outputs={"status": "failed" if exc[0] is not None else "ok"},
                )
            if self._trace_entered:
                self._trace.__exit__(*exc)
        except Exception:
            logger.exception("langsmith span %s exit failed", self._name)

    def end(
        self,
        *,
        status: str = "ok",
        error: str | None = None,
        outputs: dict[str, Any] | None = None,
    ) -> None:
        """Finish the span with curated summary attributes only.

        ``status`` and ``error`` map to LangSmith's conventional fields; the
        remaining summary fields ride ``outputs`` as small JSON values.
        Failing to end is logged, never raised.
        """
        if self._end_called:
            return
        self._end_called = True
        try:
            run = self.run
            if run is None:
                return
            final_outputs = bounded_outputs(outputs)
            final_outputs["status"] = status
            run.end(
                outputs=final_outputs,
                error=error[:2000] if error is not None else None,
            )
        except Exception:
            logger.exception("langsmith span %s end failed", self._name)

    @property
    def duration_seconds(self) -> float:
        return time.monotonic() - self.started

    @property
    def ended(self) -> bool:
        """Whether a caller has assigned this span a terminal outcome."""
        return self._end_called


class _NullClient:
    """Synchronous stand-in used when tracing is disabled or the SDK failed."""

    def trace(self, *_: Any, **__: Any) -> "NullSpan":
        return NullSpan()

    def flush(self, *_: Any, **__: Any) -> None:
        return None

    def close(self, *_: Any, **__: Any) -> None:
        return None


class ClientHandle:
    """Owns one LangSmith client and a span factory.

    Fail-open everywhere: ``span`` returns a NullSpan when the client is
    unavailable, so an SDK import failure while enabled still produces no
    spans and no exceptions. Parenting is explicit — each span names its
    parent's RunTree — so concurrent turns never share mutable state.
    """

    def __init__(self, client: Any, *, project: str | None = None) -> None:
        self._client = client
        self._project = project

    @property
    def active(self) -> bool:
        """Whether this handle has a real SDK client (tracing enabled)."""
        return not isinstance(self._client, _NullClient)

    def span(
        self,
        *,
        name: str,
        run_type: str,
        parent: Span | NullSpan | None = None,
        inputs: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
        root: bool = False,
    ) -> Span | NullSpan:
        if isinstance(parent, NullSpan):
            return NullSpan()
        if not self.active and root:
            return NullSpan()
        if parent is None and not root:
            return NullSpan()
        parent_run = getattr(parent, "run", None)
        if parent is not None and parent_run is None:
            # A failed parent enter must not turn its children into unrelated
            # roots. Keep the whole subtree fail-open and absent instead.
            return NullSpan()
        try:
            from langsmith import trace

            trace_obj = trace(
                name=name,
                run_type=run_type,
                # Inputs need enough room for a useful prompt preview; outputs
                # and metadata stay tighter. All three still omit bytes and
                # cap nested collections.
                inputs=_bounded_data(inputs, string_limit=12000),
                metadata=_bounded_data(metadata, string_limit=2000),
                project_name=self._project,
                parent=parent_run,
                client=self._client,
            )
        except Exception:
            logger.exception("langsmith span %s create failed", name)
            return NullSpan()
        if trace_obj is None:
            return NullSpan()
        return Span(trace_obj)

    def tracing_context(
        self,
        *,
        metadata: dict[str, Any] | None = None,
    ):
        """Begin a global tracing context for one stream task.

        ``langsmith.tracing_context`` is a context manager backed by
        contextvars; entering it inside the stream task and exiting it in the
        same task (via the returned object's ``__exit__``) keeps the SDK
        client/project enabled for every span that task creates, without
        mutating process environment variables. Fails open: any exception
        returns a no-op context.
        """
        if not self.active:
            return _null_context()
        try:
            from langsmith import tracing_context

            ctx = tracing_context(
                enabled=True,
                client=self._client,
                project_name=self._project,
                metadata=_bounded_data(metadata, string_limit=2000),
            )
            ctx.__enter__()
            return _TracingContextGuard(ctx)
        except Exception:
            logger.exception("langsmith tracing_context enter failed")
            return _null_context()

    async def flush(self) -> None:
        """Best-effort flush off the event loop, time-boxed.

        ``langsmith.0.11.2.Client.flush`` is synchronous and can spend time
        draining its background queue; run it in a worker thread so shutdown
        is never blocked on it. ``wait_for`` cannot stop the worker thread by
        itself, which is fine: the SDK's own batching and the short per-flush
        timeout bound the worst case.
        """
        if not self.active:
            return
        try:
            await asyncio.wait_for(
                asyncio.to_thread(self._client.flush, timeout=2.0),
                timeout=3.0,
            )
        except Exception:
            logger.exception("langsmith shutdown flush failed")

    def close(self) -> None:
        if not self.active:
            return
        try:
            # ``Client.close()`` drains indefinitely by default. ``flush`` has
            # already had its bounded chance during shutdown, so close only
            # releases resources here.
            self._client.close(timeout=0)
        except Exception:
            logger.exception("langsmith client close failed")


def _try_import() -> Any:
    """Import LangSmith lazily, failing open.

    Import is deferred so servers with tracing disabled never load the SDK.
    Called only when tracing is enabled.
    """
    try:
        return __import__("langsmith")
    except Exception:
        logger.exception("langsmith SDK import failed")
        return None


def build_client(config: TraceConfig) -> ClientHandle:
    """Create the client handle, swallowing all SDK setup failures.

    Returns a handle with a null client when the SDK or configuration is
    unusable, so a broken LangSmith install degrades to no-op rather than
    failing startup.
    """
    if not config.enabled or not config.api_key.strip():
        return ClientHandle(_NullClient(), project=config.project)
    sdk = _try_import()
    if sdk is None:
        return ClientHandle(_NullClient(), project=config.project)
    kwargs: dict[str, Any] = {
        "api_key": config.api_key,
        "api_url": config.endpoint,
    }
    if config.workspace_id:
        kwargs["workspace_id"] = config.workspace_id
    try:
        from langsmith import Client

        client = Client(**kwargs)
    except Exception:
        logger.exception("langsmith Client creation failed")
        return ClientHandle(_NullClient(), project=config.project)
    return ClientHandle(client, project=config.project)
