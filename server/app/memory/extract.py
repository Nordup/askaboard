import json
from functools import lru_cache

from openai import AsyncOpenAI

from app.config import EXTRACTION_MODEL, get_settings
from app.memory.schema import EXTRACTION_SCHEMA, ExtractedAtom, MemoryCategory

#: Below this many characters a transcript cannot hold a durable fact, and
#: calling the model to confirm that costs more than skipping it.
MIN_TRANSCRIPT_CHARS = 200

EXTRACTION_PROMPT = """\
You are reading a transcript of one maths tutoring session and recording what \
is worth remembering about this learner for future sessions.

Write each fact so it stands alone. It will be stored on its own and read back \
months from now with no surrounding conversation. Resolve every pronoun and \
every reference. Write "Prefers seeing a diagram before the algebra", never \
"they liked that". Never write "the learner" as a bare subject of a sentence \
that depends on context you are not including.

One fact per entry. Ten to thirty words each. Categories:
- preference: how they want to be taught
- goal: what they are working toward, with any stated deadline
- context: durable facts about their situation (year group, exam board, when \
they study)
- skill_state: something they demonstrably can or cannot do
- misconception: a specific wrong belief, named precisely
- episode_ref: what was covered this session, for continuity

Set `stated` true only when the learner said it themselves. Set it false for \
anything you concluded, inferred, or would be guessing at. Do not record \
curriculum content — "the quadratic formula is x = ..." is not a fact about \
this person. Do not record that a question was asked. If there is nothing \
durable here, return an empty array.

TRANSCRIPT:
{transcript}"""


@lru_cache
def _client() -> AsyncOpenAI:
    """The one extraction client, built on first use and then kept.

    Cached for the reason `app/memory/embed.py` gives at length: this is
    reached from a background pass rather than from inside a request handler
    that already has settings in hand, and a fresh AsyncOpenAI per session
    would throw away the connection pool between each one.

    It keeps the SDK's default retries for that module's reason too — the
    per-turn loops disable them because they own a retry loop that must never
    re-bill a 429, and there is no such loop above this. Its own file rather
    than a shared one so neither module's caching decision silently becomes the
    other's.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def _complete(transcript: str) -> str:
    """One request, one JSON document back. Raises whatever the provider raised.

    Nothing is caught here: the caller is an offline pass over closed sessions,
    and a session that fails to extract should be left with `extracted_at` NULL
    so the next run picks it up again. Swallowing the error would return an
    empty list, which is indistinguishable from a session that genuinely held
    nothing durable — and would mark the session done.

    `strict` is what makes the schema's category enum binding rather than
    advisory. It is also why every field is required: strict structured output
    has no optional fields, so `stated` always arrives and `_parse` never has
    to guess what an absent flag meant.
    """
    response = await _client().responses.create(
        model=EXTRACTION_MODEL,
        input=[{"role": "user",
                "content": EXTRACTION_PROMPT.format(transcript=transcript)}],
        text={"format": {"type": "json_schema", "name": "atoms",
                         "schema": EXTRACTION_SCHEMA, "strict": True}},
    )
    return response.output_text


def _parse(payload: str) -> list[ExtractedAtom]:
    """Tolerant of the model, strict about the result.

    Unknown categories and inferred atoms are dropped rather than raising:
    one malformed entry should cost that entry, not the whole session's
    extraction. The same goes for the payload itself — a refusal, a truncated
    response, or a model that answers with the bare array yields no atoms
    instead of taking down a pass that is walking a backlog of sessions.

    `stated` is checked for `is True` rather than truthiness, which is the one
    place this is stricter than it looks. The string `"false"` is truthy, and
    the asymmetry matters: a dropped fact costs one atom from one session,
    while a false positive writes something the tutor merely suspected into the
    learner's permanent record with a learner statement's authority, where
    nothing downstream can tell it from the real thing.
    """
    try:
        raw = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if not isinstance(raw, dict):
        return []
    entries = raw.get("atoms")
    if not isinstance(entries, list):
        return []
    out: list[ExtractedAtom] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        category = entry.get("category")
        if category not in {c.value for c in MemoryCategory}:
            continue
        if entry.get("stated") is not True:
            continue
        text = entry.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        out.append(ExtractedAtom(text=text.strip(),
                                 category=MemoryCategory(category), stated=True))
    return out


async def extract_atoms(transcript: str) -> list[ExtractedAtom]:
    """Everything worth remembering about the learner from one session.

    Returns only stated facts, so an empty list is the ordinary outcome for a
    session that was all working and no disclosure — it is not an error, and
    the caller should still mark the session extracted.
    """
    if len(transcript) < MIN_TRANSCRIPT_CHARS:
        return []
    return _parse(await _complete(transcript))
