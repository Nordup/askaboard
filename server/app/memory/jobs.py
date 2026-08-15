"""Turning finished stretches of a session into memory, once nobody is waiting.

A quiet stretch of a session becomes an `Episode` — that window's transcript,
frozen — and that episode becomes a rich summary, a set of atoms, and a rebuilt
profile. Several provider round trips end to end, which is the whole reason
none of it happens on the request path.

The recovery story is one nullable column, and the order of writes here is
what makes it work. The episode is committed *before* any model is called,
with `extracted_at` NULL, so the two failures that actually happen — the
provider erroring, and the process going away with the background task still
running — leave a row saying "this window happened and has not been read
yet" instead of leaving nothing at all. `run_extraction_backlog` reads those
rows back, and every close, the startup drain, and the periodic sweep run it —
so a lost window is retried by the next of any of them, rather than by a
queue this service does not have.

An episode is a message *window*, not a whole session, and that is the
load-bearing change in this file's history. The old invariant — one episode
per session id, forever — met a device that reopens the same session across
days, and the combination froze memory: the first close recorded a fossil and
every later turn was dropped silently and permanently. Now an episode covers
`seq_from..seq_to`, `_record_episode` records whatever the last episode did
not cover, and a close taken at the wrong moment costs a window split rather
than the rest of the session. The triggers are a device close (immediate), and
`sweep_abandoned_sessions` for the stretches nobody ever closes on purpose:
thirty minutes of silence with uncovered messages, checked every
`SWEEP_INTERVAL`, needing neither a restart nor another close.
"""

import asyncio
import json
import logging
import re
import uuid
import weakref
from collections.abc import Coroutine, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from openai import AsyncOpenAI
from sqlalchemy import desc, func as sa_func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import EXTRACTION_MODEL, SOLE_LEARNER_ID, get_settings
from app.memory.consolidate import consolidate
from app.memory.embed import embed_texts
from app.memory.extract import extract_atoms
from app.memory.profile import rebuild_profile
from app.store.db import session_factory
from app.store.models import Episode, Message, Session, Turn

log = logging.getLogger(__name__)

Factory = async_sessionmaker[AsyncSession]

#: How quiet a session has to go before `sweep_abandoned_sessions` records its
#: uncovered messages as the next episode.
#:
#: Thirty minutes, down from one hour, because windowed episodes changed what
#: sweeping too early costs. It used to freeze the session permanently — the
#: one-episode-per-session constraint made the first recording the only one —
#: so the threshold had to sit past any plausible pause. Now an early sweep
#: costs a window split: the learner comes back, the next window picks up from
#: `seq_to`, and nothing is lost. Sweeping late still costs what it always
#: did — a memory the next session cannot see — so the balance moves toward
#: promptness.
STALE_AFTER = timedelta(minutes=30)

#: How often the periodic sweep wakes up to look for uncovered quiet sessions
#: and retry the extraction backlog. Five minutes of extra latency is invisible
#: against the thirty-minute threshold, and it is what makes a service restart
#: or another device close unnecessary for a session nobody ever leaves on
#: purpose.
SWEEP_INTERVAL = timedelta(minutes=5)

#: How long a turn may sit at status="running" before this file stops believing
#: it.
#:
#: A running turn is the one thing that must stop a close: it means the reply
#: is still being written into `messages`, and `_record_episode` would freeze
#: the window without it. The tear is no longer permanent — the reply lands in
#: the next window — but it still splits one exchange across two episodes,
#: with the question summarized before its answer exists. But "running" is a
#: claim made by a process that can die, and `turn.py`'s close-out only
#: relabels the turns whose generator got to run its `finally`. A hard kill
#: leaves the row saying "running" forever, and a guard that trusted it
#: forever would hold a session's memory hostage to one lost process.
#:
#: Fifteen minutes is well past a real turn — several tool rounds against a
#: reasoning model, the provider's own ten-minute default behind them — and
#: short enough that a session held up by a dead turn is still swept promptly.
TURN_ASSUMED_DEAD_AFTER = timedelta(minutes=15)

#: Ceiling on the write transaction in `_extract_episode`.
#:
#: The transaction holds a row lock on `episodes` and update locks on every
#: atom it supersedes, across provider calls it does not own the timeouts
#: of — the SDK's own default is ten minutes with two retries behind it. Left
#: unbounded, one wedged provider call parks a pooled Neon connection
#: idle-in-transaction for most of an hour. A timeout here costs nothing that
#: is not already recoverable: the transaction rolls back, `extracted_at` stays
#: NULL, and the next close or sweep tries again.
WRITE_TIMEOUT_SECONDS = 180.0

#: How many characters of transcript the summarization and extraction calls
#: are shown, keeping the tail. A config knob by role, kept as a module
#: constant because `config.py` belongs to a concurrent change.
#:
#: Tail-biased because the end of a window is where the state of play lives:
#: what was just resolved, what is half-done, what the learner said last. The
#: cap exists for the pathological transcript — the frozen-session fossil that
#: grew for days is the one that poisoned the old backlog — and for fossil
#: episodes reaching `run_summary_backfill`. `Episode.transcript` itself is
#: stored whole; only what the models are shown is capped, so nothing is lost,
#: merely unsummarized.
TRANSCRIPT_CHAR_CAP = 60_000

#: The line prepended when the cap bites, so the summarizer knows it is
#: reading a tail rather than a whole window and does not present the first
#: visible exchange as how the session began.
TRUNCATION_MARKER = "[earlier part of this transcript omitted]"

#: How many failed extraction (or backfill) attempts an episode gets before it
#: is quarantined — `quarantined_at` set, the drain continuing past it. Three,
#: because the failures worth halting for (a provider outage, a bad deploy)
#: clear within a tick or two, while the failures that do not (a transcript
#: this pipeline cannot digest) never will, and one such episode used to halt
#: every episode behind it permanently. `/health` carries the quarantined
#: count, because a quarantine whose only record is a log line is a silence.
QUARANTINE_AFTER = 3

#: How many episodes one backfill pass may re-summarize. Bounds the provider
#: spend a single five-minute tick can incur while history converges; the next
#: tick takes the next batch. A config knob by role, kept here for
#: `TRANSCRIPT_CHAR_CAP`'s reason.
BACKFILL_BATCH = 3

#: `23505`, unique_violation. Named because `IntegrityError` covers every
#: constraint on the table, and the one this code expects is a very specific
#: race — see `_record_episode`.
_UNIQUE_VIOLATION = "23505"

#: Undated on purpose. Every renderer of these fields prefixes the episode's
#: `closed_at` when it shows them, so a date in the prose would be a second
#: one for a model to reconcile against the first.
#:
#: The word "narrative" and the token budget are the point of this prompt.
#: Its two-sentence predecessor produced summaries whose gist was right and
#: whose details were gone — the recorded failure is a tutor reteaching a
#: formula the learner had already been given, because "worked on molecular
#: speed" was all the digest kept. The narrative is *required* to carry the
#: exact details, because it is the only part of the window the next session
#: sees without opening the transcript.
SUMMARY_PROMPT = """\
You are summarising one window of a maths tutoring session for the tutor who \
opens the next one. The transcript is one line per turn, each opening with \
the speaker.

Write:
- title: one short, specific line naming what actually happened — \
"Derived the kinetic-energy–temperature link; started v_rms for O₂", never \
"Physics session".
- narrative: 150 to 300 tokens. It MUST carry the exact details: the problem \
statements worked on, the numbers used and reached, the formulas written \
(and whether they were derived, given, or corrected), the mistakes made, and \
what was resolved versus left open. A reader must be able to answer "what \
exactly did we do and where did we stop" from this alone, without the \
transcript.
- next_steps: the open loops, one entry each, exactly as agreed — \
"derive the relationship from collisions step by step next time". Empty if \
none.
- topics: short topic labels for search.

Write any maths in plain Unicode text — h, v, x² + y², √2, a/b — and never \
in LaTeX delimiters; this text is pasted into a prompt where the same rule \
holds. Do not date anything relatively ("today", "last time"): the reader is \
shown the session's date beside this text.

TRANSCRIPT:
{transcript}"""

#: Handed to the provider verbatim. Every object closed with
#: `additionalProperties: false` and every property required, because strict
#: structured output rejects a schema that omits either — the same contract
#: `extract.EXTRACTION_SCHEMA` documents.
SUMMARY_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "title": {"type": "string"},
        "narrative": {"type": "string"},
        "next_steps": {"type": "array", "items": {"type": "string"}},
        "topics": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "narrative", "next_steps", "topics"],
}

#: Splits prose into sentences at terminal punctuation followed by
#: whitespace. Deliberately naive — "e.g. so" splits, "303.15 K" does not —
#: because the output is a compatibility digest, not parsing.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")

#: Strong references to the tasks `schedule_session_close` starts.
#:
#: The event loop keeps only a weak reference to a running task, so one that
#: nothing else names can be collected mid-await and simply stop. Here that
#: would be a session's memory vanishing with no exception raised anywhere —
#: the one failure the `extracted_at` backlog cannot describe, because the row
#: would look exactly like a task that is still working. The done callback is
#: what keeps this set from being a leak.
_TASKS: set[asyncio.Task] = set()

#: Sessions whose close was declined because a turn was still running.
#:
#: A declined close used to be simply dropped, and recovery waited on the
#: staleness sweep — an hour, back then. That is the wrong wait for a close:
#: the device has said, explicitly, that the learner left, and the only thing
#: standing between that statement and the episode is a turn that finishes in
#: seconds. So the decline parks the session here and every sweep tick retries
#: it, staleness rules notwithstanding — recorded within one `SWEEP_INTERVAL`
#: of the turn ending instead of one `STALE_AFTER` of the messages aging.
#:
#: In-process and unpersisted, deliberately: if the process dies with entries
#: in here, the messages those closes covered are still uncovered, and the
#: staleness sweep records them the slow way. The set is an optimization on
#: latency, never the thing correctness leans on.
_PENDING_CLOSES: set[uuid.UUID] = set()

#: One drain at a time, per event loop.
#:
#: Two closes seconds apart — a session switch followed by an explicit end —
#: otherwise run two drains over the same backlog concurrently. The row lock in
#: `_extract_episode` stops them double-writing, but only after the loser has
#: already paid for a summary and an extraction it throws away, and nothing
#: stops the two of them taking episodes in interleaved order.
#:
#: **In-process only.** Correctness does not depend on it: the blocking row
#: lock is what actually carries the ordering guarantee, across processes as
#: well as within one. This removes the wasted provider calls, and it does that
#: only for drains sharing this interpreter — a second uvicorn worker would
#: still pay for a summary and an extraction it discards on every overlap. That
#: costs nothing under the single worker this service runs today, and is the
#: thing to remember on the day a second one is added.
#:
#: Keyed by loop rather than a module-level `asyncio.Lock`, because a Lock
#: binds to the loop it first blocks on and raises ever after on any other —
#: which under pytest, where every test gets its own loop, is a failure in
#: whichever test happens to run second. The weak key does not make this
#: self-cleaning in the case that matters: `Lock._get_loop()` runs precisely on
#: the blocking path, so a lock that has ever been contended holds a strong
#: reference to its own key and that entry never expires. One entry, for the
#: process's one loop, which is why it is left alone.
_DRAIN_LOCKS: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = (
    weakref.WeakKeyDictionary()
)


def _drain_lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    lock = _DRAIN_LOCKS.get(loop)
    if lock is None:
        lock = asyncio.Lock()
        _DRAIN_LOCKS[loop] = lock
    return lock


@lru_cache
def _client() -> AsyncOpenAI:
    """The one summarization client, built on first use and then kept.

    Cached, and keeping the SDK's default retries, for the reasons
    `app/memory/extract.py` sets out. Its own client rather than that module's
    so neither one's caching decision silently becomes the other's.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


@dataclass(frozen=True)
class Summary:
    """One window's structured summary, as `_summarize` returns it.

    Not the `Episode` columns themselves: this has no digest and no embedding,
    because both are derived from it — the digest by `_first_sentences`, the
    embedding by a separate call — and keeping the model's answer apart from
    what is written lets a parse be judged before anything is committed.
    """

    title: str
    narrative: str
    next_steps: list[str]
    topics: list[str]


def _parse_summary(payload: str) -> Summary:
    """Strict where the extraction parser is tolerant, and on purpose.

    A malformed atom costs one fact from one session; a malformed summary
    written as done costs the whole window's only summary, forever — the
    episode is marked extracted and nothing revisits it. So an unreadable
    payload, or an empty title or narrative, *raises*: the failure counts as
    an extraction attempt, the episode stays in the backlog, and three of them
    quarantine it visibly rather than blanking it silently.

    The two list fields stay tolerant — a non-string entry is dropped, not
    fatal — because an episode with a good narrative and one mangled topic is
    a good episode.
    """
    try:
        raw = json.loads(payload)
    except json.JSONDecodeError as error:
        raise ValueError("summarization returned unparseable JSON") from error
    if not isinstance(raw, dict):
        raise ValueError("summarization returned a non-object payload")
    title = raw.get("title")
    narrative = raw.get("narrative")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("summarization returned no title")
    if not isinstance(narrative, str) or not narrative.strip():
        raise ValueError("summarization returned no narrative")

    def _strings(key: str) -> list[str]:
        value = raw.get(key)
        if not isinstance(value, list):
            return []
        return [entry.strip() for entry in value
                if isinstance(entry, str) and entry.strip()]

    return Summary(
        title=title.strip(),
        narrative=narrative.strip(),
        next_steps=_strings("next_steps"),
        topics=_strings("topics"),
    )


async def _summarize(transcript: str) -> Summary:
    """One structured call, one `Summary` back. Raises whatever failed.

    Nothing is caught, for the reason the module docstring gives: a failure
    has to leave `extracted_at` NULL so the next close or sweep picks the
    episode up again. A caught error would write empty fields, and both the
    RECENT SESSIONS block and `search_sessions` filter on them — the episode
    would be marked done and be invisible forever.

    `store=True` for the reason `app/memory/extract.py` gives at length: the
    provider keeps the response for thirty days, which is a trace of this call
    that does not depend on anything here having recorded it.
    """
    response = await _client().responses.create(
        model=EXTRACTION_MODEL,
        input=[{"role": "user",
                "content": SUMMARY_PROMPT.format(transcript=transcript)}],
        text={"format": {"type": "json_schema", "name": "summary",
                         "schema": SUMMARY_SCHEMA, "strict": True}},
        store=True,
    )
    return _parse_summary(response.output_text)


def _first_sentences(text: str, n: int = 2) -> str:
    """The first `n` sentences, for the compatibility `digest` column."""
    return " ".join(_SENTENCE_END.split(text.strip())[:n]).strip()


def _tail(transcript: str) -> str:
    """The transcript the models are shown: whole if it fits, else the tail.

    Cut at a line boundary so the first visible line still opens with a
    speaker, and marked, so the summarizer knows the window did not begin
    where its excerpt does. `TRANSCRIPT_CHAR_CAP` says why the tail is the
    half worth keeping.
    """
    if len(transcript) <= TRANSCRIPT_CHAR_CAP:
        return transcript
    tail = transcript[-TRANSCRIPT_CHAR_CAP:]
    cut = tail.find("\n")
    if cut != -1:
        tail = tail[cut + 1:]
    return f"{TRUNCATION_MARKER}\n{tail}"


def _render(messages: Sequence[Message]) -> str:
    """The transcript in the shape `extract_atoms` documents: one line a turn,
    each opening with the speaker."""
    return "\n".join(f"{m.role}: {m.text}" for m in messages)


async def _running_turn(db: AsyncSession, session_id: uuid.UUID) -> uuid.UUID | None:
    """The id of a turn still plausibly writing into this session, if any.

    "Plausibly" is `TURN_ASSUMED_DEAD_AFTER`, and it is the whole reason this
    is a function rather than one clause. Filtering on `status == "running"`
    alone would let a single crashed process hold a session's memory up
    indefinitely; filtering on age alone would ignore the state the column
    actually records. Both together say what is meant: a turn that claims to be
    running and started recently enough for the claim to be worth anything.
    """
    return (await db.execute(
        select(Turn.id)
        .where(Turn.session_id == session_id,
               Turn.status == "running",
               Turn.started_at
               > datetime.now(timezone.utc) - TURN_ASSUMED_DEAD_AFTER)
        .limit(1)
    )).scalar_one_or_none()


async def _record_episode(
    factory: Factory, session_id: uuid.UUID, *, closed_at: datetime | None = None,
) -> bool:
    """Freeze this session's uncovered messages as the next episode.

    Returns True if an episode was written. Committed on its own, before
    anything is extracted from it, because this is the write that makes every
    later failure recoverable. It is also the only part of the pipeline that
    reads `sessions` and `messages` at all — everything downstream works from
    the episode, so a session purged after close costs the back-reference and
    not the memory.

    The window starts where the last episode stopped: messages whose 1-based
    ordinal (`seq + 1` — `Message.seq` is 0-based and dense) exceeds the
    session's highest `seq_to`. An empty window is a no-op, not an error —
    it is the ordinary result of a device retrying a close that already
    landed, and of the sweep visiting a fully recorded session.

    A turn still writing into this session makes the window a moving target,
    so the close is *rescheduled* rather than served: the session goes into
    `_PENDING_CLOSES` and the next sweep tick retries it, seconds after the
    turn ends rather than `STALE_AFTER` after the messages age. The device
    guards this too (`TutorStore.endSessionOnServer`), but it can only speak
    for itself — this is the side that knows.

    `closed_at` defaults to the column's `now()`, which is the truth when a
    device says it has left. The sweep passes the last message's timestamp
    instead: an abandoned March window noticed in June ended in March, and
    that column is both what the drain orders by and what the tutor is shown
    as the session's date. `started_at` is the window's own first message —
    a window recorded on day three of a reopened session is a day-three
    memory, and dating it by the session row would misdate every atom
    extracted from it.

    Two closes racing over the same window both compute the same `seq_from`,
    and `uq_episodes_session_window` makes the loser's insert fail; it stands
    down rather than re-reading and extracting, so the winner owns the window
    outright. Only that violation is treated as the race — every other
    constraint on this table means something has gone wrong that a shrug and
    an INFO line would bury.
    """
    async with factory() as db:
        session = await db.get(Session, session_id)
        if session is None:
            log.warning("close asked for unknown session %s", session_id)
            _PENDING_CLOSES.discard(session_id)
            return False

        if (live := await _running_turn(db, session_id)) is not None:
            _PENDING_CLOSES.add(session_id)
            log.info(
                "close declined for session %s: turn %s is still running; "
                "rescheduled for the next sweep tick", session_id, live,
            )
            return False

        covered = (await db.execute(
            select(sa_func.coalesce(sa_func.max(Episode.seq_to), 0))
            .where(Episode.session_id == session_id)
        )).scalar_one()
        # `seq >= covered` is the ordinal comparison in seq terms: a message
        # with `seq + 1 > covered` is exactly one with `seq >= covered`.
        messages = (await db.execute(
            select(Message)
            .where(Message.session_id == session_id, Message.seq >= covered)
            .order_by(Message.seq)
        )).scalars().all()
        if not messages:
            # Nothing new was said, so there is nothing to be the ground truth
            # of. Deliberately no episode row: an empty one would be a
            # permanent member of the backlog that every close pays a provider
            # call for.
            _PENDING_CLOSES.discard(session_id)
            return False

        episode = Episode(
            learner_id=SOLE_LEARNER_ID,
            session_id=session_id,
            seq_from=messages[0].seq + 1,
            seq_to=messages[-1].seq + 1,
            transcript=_render(messages),
            message_count=len(messages),
            started_at=messages[0].created_at,
        )
        if closed_at is not None:
            episode.closed_at = closed_at
        db.add(episode)
        try:
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            code = getattr(error.orig, "sqlstate", None) or getattr(
                error.orig, "pgcode", None
            )
            if code != _UNIQUE_VIOLATION:
                raise
            log.info("session %s's window was already recorded by a "
                     "concurrent close", session_id)
            _PENDING_CLOSES.discard(session_id)
            return False
    _PENDING_CLOSES.discard(session_id)
    return True


async def _extract_episode(factory: Factory, episode_id: uuid.UUID) -> bool:
    """Summarize one episode, mine it for facts, and mark it read.

    Three transactions and not one, and the split is the point. The naive
    shape holds a session open across the summary, the extraction, the
    embedding, the adjudication and the synthesis — provider calls, seconds
    each, with a pooled Neon connection pinned for all of them and doing
    nothing. So the calls that need no database at all are made with no
    session open, and what remains is a short read, a gap, and one write
    transaction.

    That write transaction is single because it has to be: `consolidate` and
    `rebuild_profile` both document that the caller owns the transaction, and
    the atoms, the profile, the summary columns and `extracted_at` are only
    safe to retry if they land together. A crash between them would leave
    atoms written under an unmarked episode, and the retry would write them a
    second time. Those two do make provider calls of their own while the
    connection is held; that is their contract, and `WRITE_TIMEOUT_SECONDS`
    is what bounds it.

    The models are shown `_tail(transcript)`, never the stored column raw —
    the cap is the one defence between a pathological transcript and a
    permanently failing call. The `digest` written here is the narrative's
    first two sentences: the compatibility surface for every reader that
    still pastes short dated lines, kept until the backfill has re-summarized
    history and reads move to `narrative`.

    The re-select takes a row lock, and it *waits* for one already held rather
    than skipping past it. Skipping looks like the cheaper answer and is the
    wrong one: a runner that steps over a locked episode goes on to extract a
    newer one, which is precisely the out-of-order supersession
    `run_extraction_backlog` halts a whole drain to prevent. Waiting costs a
    few seconds and then, under READ COMMITTED, re-evaluates `extracted_at IS
    NULL` against the row the holder committed — so the waiter still cannot
    double-extract, it just cannot jump the queue.
    """
    async with factory() as db:
        episode = await db.get(Episode, episode_id)
        if episode is None or episode.extracted_at is not None:
            return False
        transcript = _tail(episode.transcript)
        source_session_id = episode.session_id
        # The window's own clock, never the pass's. A backlog retry can run
        # days later, and both of these end up in the permanent record: the
        # date is written into the fact text, and `valid_from` is the "when
        # was this true" axis the store is bi-temporal for. Dating either by
        # when extraction happened to run is a wrong answer that reads exactly
        # like a right one.
        started_at = episode.started_at

    summary = await _summarize(transcript)
    atoms = await extract_atoms(transcript, session_date=started_at.date())
    # Title and narrative together, because the title carries the specific
    # nouns ("v_rms", "O₂") a search query is likeliest to share. The unpack
    # is deliberate: `embed_texts` documents that it raises rather than
    # returning a short list, and this is the caller-side check of that.
    [narrative_vector] = await embed_texts([f"{summary.title}\n{summary.narrative}"])

    async with asyncio.timeout(WRITE_TIMEOUT_SECONDS):
        async with factory() as db:
            episode = (await db.execute(
                select(Episode)
                .where(Episode.id == episode_id, Episode.extracted_at.is_(None))
                .with_for_update()
            )).scalar_one_or_none()
            if episode is None:
                log.info("episode %s was extracted by another pass", episode_id)
                return False
            episode.title = summary.title
            episode.narrative = summary.narrative
            episode.next_steps = summary.next_steps
            episode.topics = summary.topics
            episode.narrative_embedding = narrative_vector
            episode.digest = _first_sentences(summary.narrative)
            await consolidate(db, SOLE_LEARNER_ID, atoms,
                              session_id=source_session_id, turn_ids=[],
                              valid_from=started_at)
            await rebuild_profile(db, SOLE_LEARNER_ID)
            episode.extracted_at = datetime.now(timezone.utc)
            await db.commit()
    return True


async def _note_extraction_failure(
    factory: Factory, episode_id: uuid.UUID
) -> int:
    """Count one failed attempt against this episode. Returns the new count.

    Quarantines at `QUARANTINE_AFTER` in the same write, so the count and the
    verdict cannot land apart. Runs inside an except handler, which is why it
    swallows its own failures: a database error here must not replace the
    exception that is actually being reported, and returning 0 keeps the
    caller on its conservative path — halt and retry — rather than letting a
    bookkeeping failure quarantine anything.
    """
    try:
        async with factory() as db:
            episode = await db.get(Episode, episode_id)
            if episode is None:
                return 0
            episode.extraction_attempts += 1
            attempts = episode.extraction_attempts
            if attempts >= QUARANTINE_AFTER and episode.quarantined_at is None:
                episode.quarantined_at = datetime.now(timezone.utc)
            await db.commit()
        return attempts
    except Exception:
        log.exception("could not record the extraction failure for episode %s",
                      episode_id)
        return 0


async def sweep_abandoned_sessions(*, db_factory: Factory | None = None) -> int:
    """Record every uncovered quiet stretch, and retry every declined close.

    Returns how many episodes it wrote. Two passes, deliberately ordered.

    Declined closes first: a session in `_PENDING_CLOSES` was explicitly left
    by the device, and the only thing that stopped its recording was a turn
    still running at the time. Retrying it here — with no staleness gate — is
    what "a decline reschedules instead of dropping" means: the window is
    recorded within one sweep tick of the turn ending. A session recorded
    this way is fully covered by the time the staleness scan below takes its
    snapshot, so it cannot be swept twice in one pass.

    Then the staleness scan, which is what handles the sessions nobody closes
    at all — an app killed from the switcher, a crash, an iPad put down and
    not picked up again — and, since episodes became windows, the *reopened*
    session too: it looks for messages beyond the highest recorded `seq_to`,
    not for the absence of an episode, so a session frozen once keeps being
    remembered window by window. Fair game is `STALE_AFTER` of silence,
    measured from the last message rather than `sessions.updated_at`, because
    that column is touched by anything that writes the row and is not a
    statement about the learner.

    The sweep is the one thing in this file that can add an episode *behind*
    the extraction watermark, and an ordinary sequence gets there: a session
    that dies on Monday afternoon is still too fresh to sweep when Monday
    evening's session is closed and extracted, and by the time Tuesday's close
    sweeps it, a newer episode has already been read. `run_extraction_backlog`
    orders a batch and cannot order across batches, so that one is extracted
    late whatever this does — recording it with a fabricated `closed_at` would
    hide the inversion rather than prevent it, and skipping it would trade a
    mis-ordered window for a lost one. So it is recorded, honestly dated, and
    logged loudly. What actually protects the store is downstream: the atoms
    carry the window's own `valid_from`, and consolidation is shown those
    dates and told not to let an older fact supersede a newer one.
    """
    factory = db_factory or session_factory()
    recorded = 0
    for session_id in list(_PENDING_CLOSES):
        if await _record_episode(factory, session_id):
            recorded += 1

    cutoff = datetime.now(timezone.utc) - STALE_AFTER
    async with factory() as db:
        watermark = (await db.execute(
            select(sa_func.max(Episode.closed_at))
            .where(Episode.extracted_at.is_not(None))
        )).scalar_one()
        last_message = (
            select(
                Message.session_id.label("session_id"),
                sa_func.max(Message.created_at).label("last_at"),
                sa_func.max(Message.seq).label("last_seq"),
            )
            .group_by(Message.session_id)
            .subquery()
        )
        covered = (
            select(
                Episode.session_id.label("session_id"),
                sa_func.max(Episode.seq_to).label("seq_to"),
            )
            .group_by(Episode.session_id)
            .subquery()
        )
        stale = (await db.execute(
            select(last_message.c.session_id, last_message.c.last_at)
            .outerjoin(covered, covered.c.session_id == last_message.c.session_id)
            # `<= last_seq` is "an uncovered message exists" in ordinal terms:
            # the newest message's ordinal is `last_seq + 1`, so coverage up
            # to `last_seq` still leaves it out.
            .where(sa_func.coalesce(covered.c.seq_to, 0) <= last_message.c.last_seq,
                   last_message.c.last_at < cutoff)
            .order_by(last_message.c.last_at)
        )).all()

    for session_id, last_at in stale:
        if watermark is not None and last_at < watermark:
            log.warning(
                "sweeping session %s behind the extraction watermark: it went "
                "quiet at %s, but an episode closed %s has already been "
                "extracted. Its facts will be consolidated after newer ones",
                session_id, last_at, watermark,
            )
        else:
            log.info("sweeping session %s, silent since %s with uncovered "
                     "messages", session_id, last_at)
        if await _record_episode(factory, session_id, closed_at=last_at):
            recorded += 1
    return recorded


async def run_extraction_backlog(*, db_factory: Factory | None = None) -> int:
    """Extract every episode written but never read. Returns how many were.

    Oldest first, and that is a correctness requirement rather than tidiness.
    Consolidation's SUPERSEDE rule is "the learner's state has changed", which
    assumes the facts it is shown are older than the ones it is judging;
    running a March window after a June one hands it that assumption
    backwards and lets March close June's facts.

    Which is also why an early failure stops the drain instead of stepping
    past it. Carrying on would extract a newer episode while an older one is
    still unread, and the eventual retry of the older one is then the
    inversion above. But "stops the drain" cannot be forever — that policy,
    alone, once let a single poison episode silently halt every episode
    behind it for good — so each failure is counted, and at
    `QUARANTINE_AFTER` the episode is quarantined and the drain continues
    past it: the inversion its eventual manual retry may cause is the dated
    SUPERSEDE rule's problem, and a bounded one, where the total halt was
    not. Quarantined episodes are excluded here and surfaced by
    `backlog_status`, because a halt whose only symptom is a log line is a
    silence, not a signal.
    """
    factory = db_factory or session_factory()
    async with _drain_lock():
        async with factory() as db:
            pending = list((await db.execute(
                select(Episode.id)
                .where(Episode.extracted_at.is_(None),
                       Episode.quarantined_at.is_(None))
                # `id` last for the same reason every ordered query in this
                # package carries it: episodes closed in one statement share a
                # `closed_at`, and without a tiebreak their order is the
                # planner's.
                .order_by(Episode.closed_at, Episode.id)
            )).scalars().all())

        extracted = 0
        for done, episode_id in enumerate(pending):
            try:
                if await _extract_episode(factory, episode_id):
                    extracted += 1
            except Exception:
                attempts = await _note_extraction_failure(factory, episode_id)
                if attempts >= QUARANTINE_AFTER:
                    log.exception(
                        "extraction failed for episode %s for the %dth time; "
                        "quarantined, the drain continues past it",
                        episode_id, attempts,
                    )
                    continue
                log.exception(
                    "extraction failed for episode %s (attempt %d of %d); it "
                    "and the %d behind it stay in the backlog",
                    episode_id, attempts, QUARANTINE_AFTER,
                    len(pending) - done - 1,
                )
                raise
        return extracted


async def run_summary_backfill(
    *, db_factory: Factory | None = None, limit: int = BACKFILL_BATCH
) -> int:
    """Re-summarize episodes that predate the rich summary. Returns how many.

    The compatibility story's other half: episodes extracted under the old
    two-sentence digest have `narrative` NULL, and until it is filled their
    window is invisible to `search_sessions` and thin in RECENT SESSIONS.
    This walks them newest first — the recent past is what the next session
    will actually ask about, so the fossils with the least left to offer are
    done last — a bounded batch per pass, behind the normal drain, so
    converging history never competes with recording the present.

    Summaries only: the atoms these episodes yielded were consolidated when
    they were first extracted, and running extraction again would double
    every one of them. That is also why failures here do not halt anything —
    there is no consolidation ordering to protect — they count against the
    same `extraction_attempts` and quarantine the same way, and the pass
    simply moves to the next episode.
    """
    factory = db_factory or session_factory()
    async with _drain_lock():
        async with factory() as db:
            pending = list((await db.execute(
                select(Episode.id)
                .where(Episode.extracted_at.is_not(None),
                       Episode.narrative.is_(None),
                       Episode.quarantined_at.is_(None))
                .order_by(desc(Episode.closed_at), Episode.id)
                .limit(limit)
            )).scalars().all())

        refreshed = 0
        for episode_id in pending:
            try:
                if await _refresh_summary(factory, episode_id):
                    refreshed += 1
            except Exception:
                attempts = await _note_extraction_failure(factory, episode_id)
                log.exception(
                    "backfill re-summarization failed for episode %s "
                    "(attempt %d of %d)",
                    episode_id, attempts, QUARANTINE_AFTER,
                )
        return refreshed


async def _refresh_summary(factory: Factory, episode_id: uuid.UUID) -> bool:
    """One backfill step: summarize a stored transcript, write the columns.

    The same shape as `_extract_episode` minus consolidation: read with no
    lock, provider calls with no session open, then one bounded write that
    re-checks `narrative IS NULL` under a row lock so two passes cannot pay
    for the same summary twice. The old digest is overwritten with the
    narrative's first sentences — one voice across history rather than two
    prompts' worth.
    """
    async with factory() as db:
        episode = await db.get(Episode, episode_id)
        if episode is None or episode.narrative is not None:
            return False
        transcript = _tail(episode.transcript)

    summary = await _summarize(transcript)
    [narrative_vector] = await embed_texts([f"{summary.title}\n{summary.narrative}"])

    async with asyncio.timeout(WRITE_TIMEOUT_SECONDS):
        async with factory() as db:
            episode = (await db.execute(
                select(Episode)
                .where(Episode.id == episode_id, Episode.narrative.is_(None))
                .with_for_update()
            )).scalar_one_or_none()
            if episode is None:
                return False
            episode.title = summary.title
            episode.narrative = summary.narrative
            episode.next_steps = summary.next_steps
            episode.topics = summary.topics
            episode.narrative_embedding = narrative_vector
            episode.digest = _first_sentences(summary.narrative)
            await db.commit()
    return True


async def backlog_status(*, db_factory: Factory | None = None) -> dict:
    """How much unread memory is waiting, how long, and how much is quarantined.

    On the health endpoint because neither a halted drain nor a quarantined
    episode has any other symptom. The episodes are safe, nothing raises again
    until the next close, boot, or periodic sweep, and the only account of it
    is a log line — so without these numbers on a page someone already
    watches, "memory quietly stopped updating in March" is discovered by
    noticing the tutor has gone vague. Quarantined episodes are counted apart
    from the backlog rather than inside it, because they are the opposite of
    waiting: nothing will retry them until someone clears `quarantined_at` by
    hand, and folding them into the backlog count would make it read as
    permanently stuck.

    Never raises. Health is asked whether the process is alive, and answering
    "no" because a count could not be read would turn a memory problem into a
    failed liveness probe.
    """
    try:
        factory = db_factory or session_factory()
        async with factory() as db:
            count, oldest = (await db.execute(
                select(sa_func.count(Episode.id), sa_func.min(Episode.closed_at))
                .where(Episode.extracted_at.is_(None),
                       Episode.quarantined_at.is_(None))
            )).one()
            quarantined = (await db.execute(
                select(sa_func.count(Episode.id))
                .where(Episode.quarantined_at.is_not(None))
            )).scalar_one()
    except Exception:
        log.exception("could not read the extraction backlog")
        return {"unextracted_episodes": None,
                "oldest_unextracted_age_seconds": None,
                "quarantined_episodes": None}
    age = None if oldest is None else int(
        (datetime.now(timezone.utc) - oldest).total_seconds()
    )
    return {"unextracted_episodes": count,
            "oldest_unextracted_age_seconds": age,
            "quarantined_episodes": quarantined}


async def run_session_close(
    session_id: uuid.UUID, *, db_factory: Factory | None = None
) -> None:
    """Record this session's next window, then work off the backlog.

    Idempotent in the way that matters: a fully recorded session yields an
    empty window and no new episode, and an already-extracted episode is not
    extracted twice. Every atom is derived from an episode, so a
    double-extraction would double a session's contribution to the learner's
    permanent record — which is what `uq_episodes_session_window` and the
    `extracted_at` check are both for.

    It sweeps and drains rather than handling only the session it was given
    because that is where the retry lives: there is no queue here, so an
    episode that failed to extract, or a window nobody ever closed, is picked
    up by whichever close, startup drain, or periodic sweep happens next.
    Draining also keeps the ordering `run_extraction_backlog` describes —
    extracting this window alone, while an older one sat unread, is exactly
    the inversion that function exists to avoid. The summary backfill is
    deliberately *not* here: a close should cost the work its own session
    generated, and history converges on the periodic ticks.
    """
    factory = db_factory or session_factory()
    await _record_episode(factory, session_id)
    await sweep_abandoned_sessions(db_factory=factory)
    await run_extraction_backlog(db_factory=factory)


async def run_sweep_and_drain(
    *, db_factory: Factory | None = None
) -> tuple[int, int, int]:
    """Sweep, drain the backlog, then backfill summaries. Returns all counts.

    The shared work of every trigger that is not a specific session close: the
    startup drain and each periodic sweep iteration both run this, so the two
    of them cannot drift apart in ordering or in what they log.

    Sweep before drain, in that order and not the other way: the sweep is what
    turns quiet stretches into episodes, and an episode written after the
    drain has finished waits for the next pass. Backfill last, because it is
    the lowest-priority provider spend in the file and must never delay a
    fresh window's extraction.
    """
    swept = await sweep_abandoned_sessions(db_factory=db_factory)
    extracted = await run_extraction_backlog(db_factory=db_factory)
    backfilled = await run_summary_backfill(db_factory=db_factory)
    return swept, extracted, backfilled


async def run_startup_drain(*, db_factory: Factory | None = None) -> None:
    """Sweep, drain and backfill once at boot. Returns nothing; logs what it did.

    The periodic sweep makes abandonment independent of a restart, and this
    boot pass is the same work done immediately: it catches anything that
    crossed the staleness threshold while the service was down, instead of
    making it wait for the first five-minute tick.

    It also keeps the retry path honest. `run_extraction_backlog` halts the
    drain on an early failure, deliberately, and the periodic sweep would
    retry on its next tick — but a service that just failed an extraction and
    was restarted would otherwise wait up to `SWEEP_INTERVAL` to recover.
    Running the same pass at boot makes "restart the service" the recovery
    step operators already reach for.
    """
    swept, extracted, backfilled = await run_sweep_and_drain(db_factory=db_factory)
    log.info("startup memory drain | swept=%d extracted=%d backfilled=%d",
             swept, extracted, backfilled)


async def run_periodic_sweep(
    *, db_factory: Factory | None = None, interval: timedelta = SWEEP_INTERVAL
) -> None:
    """Sweep, drain and backfill every `interval`, forever. Returns nothing.

    The reliable no-restart answer for abandonment and for declined closes: a
    stretch that crosses `STALE_AFTER`, or a close a running turn deferred, is
    recorded on the next tick without any device close and without a service
    restart. The same pass also retries the extraction backlog, so a provider
    blip that halted a drain heals by itself instead of waiting for the next
    boot, and works the summary backfill off a bounded batch at a time.

    One failed iteration must not stop the loop: the next tick retries the
    same work, which is exactly how a transient provider or database failure
    is supposed to behave. Cancellation is the one thing that ends it.
    """
    while True:
        try:
            swept, extracted, backfilled = await run_sweep_and_drain(
                db_factory=db_factory
            )
            if swept or extracted or backfilled:
                log.info(
                    "periodic memory sweep | swept=%d extracted=%d backfilled=%d",
                    swept, extracted, backfilled,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("periodic memory sweep iteration failed")
        await asyncio.sleep(interval.total_seconds())


def _spawn(coro: Coroutine[object, object, None], *, description: str) -> asyncio.Task:
    """Run `coro` detached, keeping a strong reference to it, logging failures.

    Both callers need the same three things and get them wrong in the same two
    ways otherwise — see `_TASKS` for why the reference has to be held, and the
    three `schedule_*` docstrings for why swallowing the exception is honest in
    each case rather than in general.
    """
    async def _guarded() -> None:
        try:
            await coro
        except Exception:
            log.exception("%s failed", description)

    task = asyncio.create_task(_guarded())
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return task


def schedule_startup_drain() -> None:
    """Fire and forget, from the app's lifespan. Boot never waits on a provider.

    Detached rather than awaited because a backlog is provider calls, several
    per episode, and uvicorn does not accept a connection until the lifespan's
    startup phase returns. Awaiting a drain of twenty episodes would mean a
    service that answers nothing — not `/health`, not a turn — for as long as
    the provider takes. Every failure inside is already recoverable by
    construction: the episodes keep `extracted_at` NULL and the next boot,
    close, or periodic sweep tries again.
    """
    _spawn(run_startup_drain(), description="startup memory drain")


def schedule_periodic_sweep() -> asyncio.Task:
    """Fire and forget, from the app's lifespan. Boot never waits on a provider.

    The periodic sweep is the same promise as `schedule_startup_drain`, made
    continuous: it must not stop the service coming up, and its failures are
    already recoverable by construction because the next tick simply runs the
    same pass again. The task is returned so the lifespan can cancel it when
    the service stops.
    """
    return _spawn(run_periodic_sweep(), description="periodic memory sweep")


async def schedule_session_close(session_id: uuid.UUID) -> None:
    """Fire and forget. A device closing a session never waits on extraction.

    The swallowed exception is not a shrug: by the time anything in here can
    fail, the episode is already committed with `extracted_at` NULL, so the
    failure is a row in the backlog and the log line is the account of why it
    is there. That ordering is the whole reason logging and carrying on is
    honest here — it would not be if the failure left nothing behind.
    """
    _spawn(run_session_close(session_id),
           description=f"session close for {session_id}")
