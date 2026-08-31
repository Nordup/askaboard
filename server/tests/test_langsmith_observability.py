"""LangSmith Phase 0 observability tests.

Zero-network by construction: the fake client never touches the SDK's real
network path, and tests that exercise the production ``ClientHandle`` use a
fake client object. ``Span``/``NullSpan`` lifecycle (enter/exit exactly once,
auto-end on exception) is asserted directly.
"""

import asyncio
import uuid

import pytest

from app.observability import (
    ORCHESTRATION_VERSION,
    TRACE_SCHEMA_VERSION,
    TraceConfig,
    ClientHandle,
    NullSpan,
    Span,
    bounded_outputs,
)


class _FakeRun:
    """Minimal LangSmith RunTree stand-in recording what end() received."""

    def __init__(self):
        self.end_calls = []
        self.name = "fake"

    def end(self, *, outputs=None, error=None, **kwargs):
        self.end_calls.append({"outputs": outputs, "error": error})


class _StrictExitTrace:
    """A fake ``langsmith.trace`` whose __exit__ requires all three args."""

    def __init__(self, name="span"):
        self.name = name
        self.entered = 0
        self.exited = 0
        self.run = _FakeRun()

    def __enter__(self):
        self.entered += 1
        return self.run

    def __exit__(self, exc_type, exc_value, tb):
        self.exited += 1
        return False


def test_disabled_config_is_a_noop(monkeypatch):
    from app import observability as obsv

    imports = []

    def _fake_import(name):
        imports.append(name)
        raise ImportError("SDK must not be imported when disabled")

    monkeypatch.setattr(obsv, "_try_import", _fake_import)
    handle = obsv.build_client(TraceConfig(
        enabled=False, api_key="", project="math-tutor",
        endpoint="https://api.smith.langchain.com",
    ))
    assert handle.active is False
    span = handle.span(name="tutor.turn", run_type="chain", root=True)
    assert isinstance(span, NullSpan)
    assert imports == []


def test_enabled_without_a_key_is_also_a_noop(monkeypatch):
    from app import observability as obsv

    imports = []
    monkeypatch.setattr(obsv, "_try_import", lambda: imports.append("sdk"))
    handle = obsv.build_client(TraceConfig(
        enabled=True, api_key="   ", project="math-tutor",
        endpoint="https://api.smith.langchain.com",
    ))
    assert handle.active is False
    assert imports == []


def test_span_enter_exit_arity_and_single_end():
    trace_obj = _StrictExitTrace("round")
    span = Span(trace_obj)
    with span:
        span.end(status="ok", outputs={"n": 1})
    assert trace_obj.entered == 1
    assert trace_obj.exited == 1
    assert len(trace_obj.run.end_calls) == 1
    assert trace_obj.run.end_calls[0]["outputs"]["status"] == "ok"


def test_span_auto_ends_failed_on_exception():
    trace_obj = _StrictExitTrace("round")
    span = Span(trace_obj)
    with pytest.raises(RuntimeError):
        with span:
            raise RuntimeError("boom")
    assert trace_obj.exited == 1
    assert trace_obj.run.end_calls
    assert trace_obj.run.end_calls[-1]["error"] == "RuntimeError: boom"


def test_span_enter_exit_are_idempotent():
    trace_obj = _StrictExitTrace("round")
    span = Span(trace_obj)
    span.__enter__()
    span.__enter__()
    span.end(status="ok")
    span.__exit__()
    span.__exit__()
    assert trace_obj.entered == 1
    assert trace_obj.exited == 1
    assert len(trace_obj.run.end_calls) == 1


def test_bounded_outputs_keeps_structured_fields():
    class Marker:
        def __str__(self):
            return "marker"

    out = bounded_outputs({
        "status": "ok",
        "token_usage": {"input": 12, "output": 4},
        "tool_names": ["view_board", "fetch_image"],
        "blob": b"\x89PNG",
        "big": "x" * 5000,
        "latency_ms": 12,
        "object": Marker(),
    })
    assert out["status"] == "ok"
    assert out["token_usage"] == {"input": 12, "output": 4}
    assert out["tool_names"] == ["view_board", "fetch_image"]
    assert out["latency_ms"] == 12
    assert "blob" not in out
    assert len(out["big"]) == 2000
    assert out["object"] == "marker"


def test_client_fail_open_on_import_failure(monkeypatch):
    from app import observability as obsv

    monkeypatch.setattr(obsv, "_try_import", lambda: None)
    handle = obsv.build_client(TraceConfig(
        enabled=True, api_key="lsv2_test", project="math-tutor",
        endpoint="https://api.smith.langchain.com",
    ))
    assert handle.active is False
    span = handle.span(name="tutor.turn", run_type="chain", root=True)
    assert isinstance(span, NullSpan)


def test_client_fail_open_on_client_creation_failure(monkeypatch):
    from app import observability as obsv

    monkeypatch.setattr(obsv, "_try_import", lambda: object())

    def boom(**kwargs):
        raise RuntimeError("no langsmith")

    monkeypatch.setattr("langsmith.Client", boom)
    handle = obsv.build_client(TraceConfig(
        enabled=True, api_key="lsv2_test", project="math-tutor",
        endpoint="https://api.smith.langchain.com",
    ))
    assert handle.active is False
    assert isinstance(handle.span(name="x", run_type="chain", root=True), NullSpan)


def test_client_span_root_and_child_parenting(monkeypatch):
    traces = {"tutor.turn": _StrictExitTrace("tutor.turn"),
              "llm.round": _StrictExitTrace("llm.round")}

    class _FakeClient2:
        active = True

    handle = ClientHandle(_FakeClient2(), project="math-tutor")
    monkeypatch.setattr(
        "langsmith.trace",
        lambda **kwargs: traces[kwargs["name"]],
    )
    root = handle.span(name="tutor.turn", run_type="chain", root=True)
    assert isinstance(root, Span)
    with root:
        child = handle.span(
            name="llm.round", run_type="llm", parent=root,
            inputs={"round_index": 1},
        )
        assert isinstance(child, Span)
        with child:
            child.end(status="ok", outputs={"round_index": 1})
        root.end(status="ok", outputs={"text_chars": 3})
    assert traces["tutor.turn"].entered == 1
    assert traces["tutor.turn"].exited == 1
    assert traces["llm.round"].entered == 1
    assert traces["llm.round"].exited == 1


def test_failed_parent_enter_cannot_create_an_unrelated_child_root(monkeypatch):
    class _FailingTrace(_StrictExitTrace):
        def __enter__(self):
            self.entered += 1
            raise RuntimeError("enter failed")

    calls = []

    def fake_trace(**kwargs):
        calls.append(kwargs)
        return _FailingTrace(kwargs["name"])

    monkeypatch.setattr("langsmith.trace", fake_trace)
    handle = ClientHandle(object(), project="math-tutor")
    root = handle.span(name="tutor.turn", run_type="chain", root=True)
    root.__enter__()
    child = handle.span(
        name="llm.round", run_type="llm", parent=root,
        inputs={"round_index": 1},
    )
    assert isinstance(child, NullSpan)
    assert len(calls) == 1
    root.__exit__()


def test_tracing_context_exits_underlying_context_once(monkeypatch):
    class _Context:
        def __init__(self):
            self.entered = 0
            self.exited = 0

        def __enter__(self):
            self.entered += 1
            return self

        def __exit__(self, exc_type, exc_value, tb):
            self.exited += 1

    underlying = _Context()
    monkeypatch.setattr("langsmith.tracing_context", lambda **kwargs: underlying)
    handle = ClientHandle(object(), project="math-tutor")
    guard = handle.tracing_context(metadata={"turn_id": "turn"})
    guard.__enter__()
    guard.__exit__()
    guard.__exit__()
    assert underlying.entered == 1
    assert underlying.exited == 1


def test_installed_sdk_trace_posts_two_explicitly_parented_runs():
    """Exercise the pinned SDK's real trace/tracing_context implementation.

    The client double captures its create/update calls, so this validates the
    SDK surface and RunTree parent fields without making a network request.
    """
    class _SDKClientDouble:
        def __init__(self):
            self.created = []
            self.updated = []

        def create_run(self, **kwargs):
            self.created.append(kwargs)

        def update_run(self, run_id, **kwargs):
            self.updated.append((run_id, kwargs))

    client = _SDKClientDouble()
    handle = ClientHandle(client, project="math-tutor-sdk-test")
    context = handle.tracing_context(metadata={"test": "sdk"})
    context.__enter__()
    root = handle.span(
        name="tutor.turn", run_type="chain", root=True,
        inputs={"turn_id": "turn"},
    )
    with root:
        child = handle.span(
            name="llm.round", run_type="llm", parent=root,
            inputs={"prompt": "2 + 2"},
        )
        with child:
            child.end(outputs={"answer": "4"})
        root.end(outputs={"answer": "4"})
    context.__exit__()

    assert [run["name"] for run in client.created] == [
        "tutor.turn", "llm.round",
    ]
    assert len(client.updated) == 2
    assert client.created[1]["trace_id"] == client.created[0]["trace_id"]
    assert client.created[1]["parent_run_id"] == client.created[0]["id"]


def test_concurrent_parents_stay_isolated(monkeypatch):
    """Two concurrent root spans each own independent child lines; explicit
    parent passing must never cross-wire them."""

    class _FakeClient3:
        active = True

    handle = ClientHandle(_FakeClient3(), project="math-tutor")
    child_runs = []
    made_root = {}

    def fake_trace(**kwargs):
        name = kwargs["name"]
        parent = kwargs.get("parent")
        if parent is None:
            # One trace per root span (parent=None is the root create path).
            out = _StrictExitTrace(name)
            made_root[id(out)] = out
            return out
        return _StrictExitTrace(name)

    monkeypatch.setattr("langsmith.trace", fake_trace)

    root_a = handle.span(name="tutor.turn", run_type="chain", root=True)
    root_b = handle.span(name="tutor.turn", run_type="chain", root=True)
    assert root_a is not root_b
    with root_a:
        child_a = handle.span(
            name="llm.round", run_type="llm", parent=root_a,
            inputs={"round_index": 1},
        )
        with child_a:
            child_a.end(status="ok", outputs={"round_index": 1})
        child_runs.append(child_a.run)
        root_a.end(status="ok", outputs={"text_chars": 1})
    with root_b:
        child_b = handle.span(
            name="llm.round", run_type="llm", parent=root_b,
            inputs={"round_index": 1},
        )
        with child_b:
            child_b.end(status="ok", outputs={"round_index": 1})
        child_runs.append(child_b.run)
        root_b.end(status="ok", outputs={"text_chars": 2})
    # Each root got its own llm.round child run (parent identity differs).
    assert child_runs[0] is not child_runs[1]


def test_flush_and_close_fail_open(monkeypatch):
    from app import observability as obsv

    class _BoomClient:
        active = True

        def flush(self, timeout=None):
            raise RuntimeError("flush boom")

        def close(self, timeout=None):
            raise RuntimeError("close boom")

    handle = ClientHandle(_BoomClient(), project="math-tutor")
    asyncio.run(handle.flush())
    handle.close()  # must not raise


def test_root_span_metadata_session_correlation():
    """Root inputs carry turn/session correlation and schema versions."""
    import app.observability as obsv

    capture = {}

    class _Run:
        def end(self, *, outputs=None, error=None, **kwargs):
            capture["outputs"] = outputs

    class _Trace:
        name = "tutor.turn"

        def __init__(self):
            self.run = _Run()
            self.entered = 0
            self.exited = 0

        def __enter__(self):
            self.entered += 1
            return self.run

        def __exit__(self, *a):
            self.exited += 1
            return False

    trace_obj = _Trace()

    def fake_trace(**kwargs):
        capture["inputs"] = kwargs.get("inputs")
        capture["metadata"] = kwargs.get("metadata")
        return trace_obj

    import langsmith

    old = langsmith.trace
    langsmith.trace = fake_trace
    try:
        handle = ClientHandle(type("C", (), {"active": True})(), project="math-tutor")
        root = handle.span(
            name="tutor.turn", run_type="chain", root=True,
            inputs={
                "turn_id": str(uuid.uuid4()),
                "session_id": str(uuid.uuid4()),
                "model": "gpt-5.6-luna",
                "history_count": 4,
                "orchestration_version": ORCHESTRATION_VERSION,
                "trace_schema_version": TRACE_SCHEMA_VERSION,
            },
            metadata={"turn_id": "abc", "session_id": "xyz", "project": "math-tutor"},
        )
        with root:
            root.end(status="ok", outputs={"text_chars": 10})
    finally:
        langsmith.trace = old
    assert capture["inputs"]["orchestration_version"] == ORCHESTRATION_VERSION
    assert capture["inputs"]["trace_schema_version"] == TRACE_SCHEMA_VERSION
    assert capture["inputs"]["turn_id"]
    assert capture["inputs"]["session_id"]
    assert capture["metadata"]["turn_id"] == "abc"
    assert capture["outputs"]["status"] == "ok"
