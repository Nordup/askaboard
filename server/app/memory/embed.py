from functools import lru_cache

from openai import AsyncOpenAI

from app.config import EMBEDDING_DIMS, EMBEDDING_MODEL, get_settings

#: One request per this many texts. The endpoint accepts more, but a session's
#: extraction yields well under this, so batching exists to keep a rebuild of
#: the whole store from becoming one enormous request.
BATCH = 128


@lru_cache
def _client() -> AsyncOpenAI:
    """The one embeddings client, built on first use and then kept.

    Cached, where /v1/turn and /v1/dictation build a client per request: those
    two live inside a handler that already has settings in hand, while this is
    called from a background pass as well, and a fresh AsyncOpenAI for every
    batch would discard the connection pool between each 128 texts for nothing.

    It also keeps the SDK's default retries, where both of those pass
    max_retries=0. They do that because each owns a retry loop that must never
    retry a billing 429 (app/tutor/retry.py), and the transport retrying
    underneath it would defeat that decision at a layer they cannot see into.
    There is no such loop here to pre-empt. So the trade runs the other way: the
    cost of the SDK retrying a billing 429 is a bounded delay before the same
    failure surfaces anyway, whereas max_retries=0 would fail an entire backfill
    on the one error a bulk walk of this endpoint actually provokes — an
    ordinary rate limit.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed in order. Returns one vector per input, at the same positions.

    Vectors are `EMBEDDING_DIMS` long because the request asks for exactly
    that: `text-embedding-3-small` is natively 1536, and without `dimensions`
    every vector would be rejected by `MemoryAtom.embedding`'s halfvec(1024).

    Raises whatever the provider raised — an exhausted account, a rate limit
    the SDK's own retries could not ride out, a connection that never opened.
    Nothing is caught here, and no partial result escapes.

    That is a decision, not an omission. The two plausible alternatives both
    fail silently. Zero vectors are valid halfvec(1024) values: they would be
    written to `memory_atoms.embedding`, indexed, and from then on be
    indistinguishable from real embeddings while quietly answering every
    similarity query wrong. A short list is worse still — callers pair these
    with their inputs positionally, so dropping one vector shifts every fact
    after it onto the wrong learner statement.

    Leaving it to the caller is also the only way to get both behaviours right,
    because they want opposite things. The offline extraction pass wants the
    failure loud: the session stays unembedded and can be run again. The tool
    handler wants to catch it at its own boundary and answer the learner
    without memory rather than take the turn down. Neither is expressible from
    in here.
    """
    if not texts:
        return []
    out: list[list[float]] = []
    for start in range(0, len(texts), BATCH):
        chunk = texts[start:start + BATCH]
        response = await _client().embeddings.create(
            model=EMBEDDING_MODEL, input=chunk, dimensions=EMBEDDING_DIMS,
        )
        out.extend(item.embedding for item in response.data)
    return out
