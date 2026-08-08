import json
from datetime import date
from functools import lru_cache

from openai import AsyncOpenAI

from app.config import EXTRACTION_MODEL, get_settings
from app.memory.schema import EXTRACTION_SCHEMA, ExtractedAtom, MemoryCategory

#: Below this many characters a transcript cannot hold a durable fact, and
#: calling the model to confirm that costs more than skipping it.
MIN_TRANSCRIPT_CHARS = 200

#: Built once. `_parse` checks every entry against it, and rebuilding a set of
#: six strings per atom per session is work with no reader.
_CATEGORY_VALUES: frozenset[str] = frozenset(c.value for c in MemoryCategory)

#: Categories kept even when `stated` is false — see `_parse`, which drops
#: every other unstated atom.
#:
#: The exemption is principled, not a loophole, and this is the reasoning to
#: read before removing it. `stated` exists to stop the system persisting
#: *inferences about the person* — "seems anxious", "is probably weak at
#: algebra" — because that is where a memory system starts being confidently
#: wrong about someone. A record of what a session covered is not a claim about
#: the learner at all; it is a fact about the session, and the tutor is the
#: correct authority for it. The filter therefore still applies at full force to
#: the five categories that do make a claim about the person, which are the ones
#: that failure mode lives in.
#:
#: Without this, `episode_ref` is unreachable by construction: the prompt asks
#: for what the session covered, the learner did not say it, so the model marks
#: it unstated and the filter deletes every one of them. `Episode.digest` gives
#: continuity in date order; these atoms are what make "have we done anything on
#: factoring before?" answerable by semantic search rather than by scanning
#: dated summaries. The two do different jobs.
_STATED_EXEMPT: frozenset[MemoryCategory] = frozenset({MemoryCategory.episode_ref})

EXTRACTION_PROMPT = """\
You are reading a transcript of one maths tutoring session and recording what \
is worth remembering about this learner for future sessions.

The transcript is one line per turn, each opening with the speaker — `learner:` \
for the learner, `tutor:` for you. Only a `learner:` line is the learner \
speaking.

This session took place on {session_date}.

Write each fact so it stands alone. It will be stored on its own and read back \
months from now with no surrounding conversation. Resolve every pronoun and \
every reference. Write "Prefers seeing a diagram of a problem before working \
through the algebra for it", never "they liked that".

Time is a reference too, and the commonest one to leave dangling. Date every \
fact absolutely, resolving anything the transcript says relatively against \
{session_date}: write "Sat a mock paper on 2026-05-12" or "Covered adding \
fractions on {session_date}", never "this session", "today", "yesterday", \
"last week", "next term", or a bare weekday such as "Tuesday". A reader in six \
months cannot resolve any of those, and neither can anything else that stores \
this.

One fact per entry. Ten to thirty words each. Categories:
- preference: how they want to be taught
- goal: what they are working toward, with any stated deadline
- context: durable facts about their situation (year group, exam board, when \
they study)
- skill_state: something they demonstrably can or cannot do
- misconception: a specific wrong belief, named precisely
- episode_ref: what this session covered, written as having happened on \
{session_date}, for continuity

Set `stated` true only when the learner said it themselves. Set it false for \
anything you concluded, inferred, or would be guessing at. Only stated facts \
are kept, with one exception: an `episode_ref` is a record of what the session \
covered rather than a claim about the learner, so it is kept either way — set \
`stated` false on one you observed rather than heard, and record it anyway.

Do not record curriculum content — "the quadratic formula is x = ..." is not a \
fact about this person. Do not record that a question was asked. If there is \
nothing durable here, return an empty array.

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


async def _complete(transcript: str, session_date: date) -> str:
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

    `store=False` for the reason every turn in `app/tutor/loop.py` sets it, only
    more so: a turn posts one exchange, while this posts a whole session's
    transcript in one body. Retention of that is a decision this service makes
    in its own database — `sessions`, `turns`, and the blobs beside them — and
    leaving a second copy on the provider's side is a copy nothing here can
    enumerate, expire, or delete when the learner asks.

    The date is passed in rather than read from a clock. Extraction runs after
    the session, possibly much later on a retry of a backlog, so "now" is the
    time of the *pass*, not of the session — and dating a fact by when it
    happened to be extracted is exactly the silent error this parameter exists
    to make impossible.
    """
    response = await _client().responses.create(
        model=EXTRACTION_MODEL,
        input=[{"role": "user",
                "content": EXTRACTION_PROMPT.format(
                    transcript=transcript, session_date=session_date.isoformat(),
                )}],
        text={"format": {"type": "json_schema", "name": "atoms",
                         "schema": EXTRACTION_SCHEMA, "strict": True}},
        store=False,
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

    Unstated atoms in `_STATED_EXEMPT` survive — today that is `episode_ref`
    alone, for the reason written there. They are kept with `stated=False`, not
    relabelled: the flag records who the fact came from, and an episode summary
    came from the tutor.
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
        # `isinstance` before the membership test, not for tidiness: `in` on a
        # set hashes its left operand, so a category of `["goal"]` — a list, or
        # any other unhashable thing a model can emit — raises TypeError out of
        # the one function whose contract is that it never does.
        if not isinstance(category, str) or category not in _CATEGORY_VALUES:
            continue
        member = MemoryCategory(category)
        stated = entry.get("stated") is True
        # Checked by membership in a named set rather than by comparing the
        # string inline, so the exemption is one thing with one explanation
        # rather than a special case a reader meets without its reasoning.
        if not stated and member not in _STATED_EXEMPT:
            continue
        text = entry.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        out.append(ExtractedAtom(text=text.strip(), category=member, stated=stated))
    return out


async def extract_atoms(
    transcript: str, *, session_date: date
) -> list[ExtractedAtom]:
    """Everything worth remembering about the learner from one session.

    `session_date` is when the session happened — `Session.started_at.date()`,
    not today. It is required and keyword-only because it is the difference
    between "Covered adding fractions on 2026-08-09" and "Covered adding
    fractions this session", and only the first survives being read back in
    November. A default would have made the wrong answer the quiet one.

    Returns only stated facts, so an empty list is the ordinary outcome for a
    session that was all working and no disclosure — it is not an error, and
    the caller should still mark the session extracted.
    """
    if len(transcript) < MIN_TRANSCRIPT_CHARS:
        return []
    return _parse(await _complete(transcript, session_date))
