import pytest

from app.memory.embed import embed_texts


class _Boom(RuntimeError):
    """Whatever the provider raises. The type is not the point — that it
    reaches the caller unchanged is."""


class _FakeEmbeddings:
    def __init__(self, recorder, fail_on: int | None = None):
        self._recorder = recorder
        #: 1-based index of the call that raises, or None for a client that
        #: always succeeds.
        self._fail_on = fail_on

    async def create(self, **kwargs):
        self._recorder.append(kwargs)
        if self._fail_on is not None and len(self._recorder) == self._fail_on:
            raise _Boom("provider said no")

        class _R:
            data = [type("E", (), {"embedding": [0.1] * 1024})()
                    for _ in kwargs["input"]]
        return _R()


class _FakeClient:
    def __init__(self, recorder, fail_on: int | None = None):
        self.embeddings = _FakeEmbeddings(recorder, fail_on)


async def test_embed_texts_batches_and_preserves_order(monkeypatch):
    calls = []
    monkeypatch.setattr("app.memory.embed._client", lambda: _FakeClient(calls))
    out = await embed_texts(["a", "b", "c"])
    assert len(out) == 3
    assert all(len(v) == 1024 for v in out)
    assert calls[0]["input"] == ["a", "b", "c"]
    assert calls[0]["dimensions"] == 1024


async def test_embed_texts_empty_makes_no_call(monkeypatch):
    calls = []
    monkeypatch.setattr("app.memory.embed._client", lambda: _FakeClient(calls))
    assert await embed_texts([]) == []
    assert calls == []


async def test_embed_texts_splits_into_batches_without_reordering(monkeypatch):
    """More texts than BATCH still comes back one vector per input, in order.

    The caller's whole contract is positional — `zip(texts, vectors)` is how a
    vector reaches the right atom — so a batch boundary silently dropping or
    reordering a chunk would attach facts to the wrong learner statement rather
    than fail. BATCH is shrunk here instead of embedding 129 strings: the
    boundary logic is what is under test, not the constant.
    """
    calls = []
    monkeypatch.setattr("app.memory.embed._client", lambda: _FakeClient(calls))
    monkeypatch.setattr("app.memory.embed.BATCH", 2)

    out = await embed_texts(["a", "b", "c", "d", "e"])

    assert len(out) == 5
    assert [call["input"] for call in calls] == [["a", "b"], ["c", "d"], ["e"]]


async def test_embed_texts_raises_rather_than_returning_partial(monkeypatch):
    """A failure mid-run propagates; it never yields a short or padded list.

    This is the behaviour the callers are built on: the offline extraction pass
    needs the session left unembedded so it can be retried, and the inline tool
    handler needs something to catch. Returning the vectors gathered so far
    would break the positional contract, and returning zeros would write a
    plausible-looking vector that no later query could tell from a real one.
    """
    calls = []
    monkeypatch.setattr(
        "app.memory.embed._client", lambda: _FakeClient(calls, fail_on=2)
    )
    monkeypatch.setattr("app.memory.embed.BATCH", 2)

    with pytest.raises(_Boom):
        await embed_texts(["a", "b", "c", "d"])

    # Stopped at the failure rather than carrying on with the rest.
    assert len(calls) == 2
