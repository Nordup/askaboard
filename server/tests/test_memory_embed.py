import zlib

import pytest

from app.config import EMBEDDING_MODEL
from app.memory.embed import embed_texts


class _Boom(RuntimeError):
    """Whatever the provider raises. The type is not the point — that it
    reaches the caller unchanged is."""


def _vector(text: str) -> list[float]:
    """A 1024-long vector that names the text it was made from.

    Every fake vector being the same 1024 floats would make every ordering
    assertion in this file vacuous: `out` would be a list of interchangeable
    values, and a prepend-instead-of-extend slip — or a later refactor to
    `asyncio.gather` over the batches, where completion order need not match
    submission order — would return the wrong pairing and still pass. Keyed on
    the text, `out[i] == _vector(texts[i])` is what actually pins the contract
    callers depend on.
    """
    return [float(zlib.crc32(text.encode()))] + [0.1] * 1023


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
            data = [type("E", (), {"embedding": _vector(text)})()
                    for text in kwargs["input"]]
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
    assert out == [_vector("a"), _vector("b"), _vector("c")]
    assert calls[0]["input"] == ["a", "b", "c"]
    # EMBEDDING_MODEL imported rather than spelled out: the bug this catches is
    # a hardcoded model, or EXTRACTION_MODEL reached for by mistake — not the
    # string's value, which is config's to change. 1024 is spelled out for the
    # opposite reason, the one models.py gives for the column: `dimensions`
    # drifting from halfvec(1024) is the failure, so the test should not follow
    # the constant there.
    assert calls[0]["model"] == EMBEDDING_MODEL
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

    texts = ["a", "b", "c", "d", "e"]
    out = await embed_texts(texts)

    assert [call["input"] for call in calls] == [["a", "b"], ["c", "d"], ["e"]]
    # Position by position, across three batches: each vector traces back to
    # the text that sat at that index going in.
    assert out == [_vector(text) for text in texts]


async def test_embed_texts_raises_rather_than_returning_partial(monkeypatch):
    """A failure mid-run propagates; it never yields a short or padded list.

    This is the behaviour the callers are built on: the offline extraction pass
    needs the session left unembedded so it can be retried, and the inline tool
    handler needs something to catch. Returning the vectors gathered so far
    would break the positional contract, and returning zeros would write a
    plausible-looking vector that no later query could tell from a real one.

    Three batches failing on the second, so that "stopped" is something the
    test can actually observe — with the failure in the last batch there is no
    later request whose absence means anything.
    """
    calls = []
    monkeypatch.setattr(
        "app.memory.embed._client", lambda: _FakeClient(calls, fail_on=2)
    )
    monkeypatch.setattr("app.memory.embed.BATCH", 2)

    with pytest.raises(_Boom):
        await embed_texts(["a", "b", "c", "d", "e", "f"])

    # The third batch was never sent: it stopped at the failure rather than
    # carrying on and handing back whatever it managed to collect.
    assert [call["input"] for call in calls] == [["a", "b"], ["c", "d"]]
