import json
import logging
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.config import EMBEDDING_DIMS, SOLE_LEARNER_ID
from app.memory.consolidate import _candidates
from app.memory.jobs import (
    _PENDING_CLOSES, QUARANTINE_AFTER, STALE_AFTER, TRANSCRIPT_CHAR_CAP,
    TRUNCATION_MARKER, Summary, _first_sentences, _parse_summary, _tail,
    backlog_status, run_extraction_backlog, run_session_close,
    run_summary_backfill, sweep_abandoned_sessions,
)
from app.store.blobs import LocalBlobStore
from app.store.models import Episode, Learner, MemoryAtom, Message, Session, Turn
from app.store.recorder import REPLY_LOST_TEXT, Recorder
from tests.conftest import requires_db

# Every model call in the pipeline is stubbed, as in test_memory_jobs: what is
# under test is which messages become which episode window, what a failure
# leaves behind, and what a second pass does to rows the first one wrote — the
# calls themselves are the one part that can be a constant.

MARCH = datetime(2026, 3, 4, 9, 30, tzinfo=timezone.utc)
APRIL = datetime(2026, 4, 2, 9, 30, tzinfo=timezone.utc)
JUNE = datetime(2026, 6, 1, 9, 30, tzinfo=timezone.utc)

#: Never all zeros. Cosine distance against a zero vector is NaN, so a row
#: carrying one silently fails every `<=` it is compared through.
VECTOR = [0.1] * EMBEDDING_DIMS

TITLE = "Derived the KE-temperature link; started v_rms for O₂"
#: Three sentences, so the two-sentence digest cut is observable: the digest
#: must keep the first two and drop the third.
NARRATIVE = (
    "Worked from the question of how molecular speed relates to temperature. "
    "Corrected E_k = 1/2 m v² after a sign slip and converted 30 °C to "
    "303.15 K. Was given Ē_k = 3/2 k_B T on request and began computing "
    "v_rms for O₂; the number is unfinished."
)
NARRATIVE_DIGEST = (
    "Worked from the question of how molecular speed relates to temperature. "
    "Corrected E_k = 1/2 m v² after a sign slip and converted 30 °C to "
    "303.15 K."
)
NEXT_STEPS = ["derive the relationship from collisions step by step"]
TOPICS = ["kinetic theory", "temperature"]


class _Summarize:
    """Stands in for `_summarize`, recording the transcripts it was handed.

    `fails_on` poisons one transcript by substring while the rest succeed —
    the shape the quarantine tests need, where one episode must fail
    repeatedly while the drain's ability to move past it is what is under
    test.
    """

    def __init__(self, summary: Summary | None = None, *,
                 fails_on: str | None = None):
        self.calls: list[str] = []
        self._summary = summary or Summary(
            title=TITLE, narrative=NARRATIVE,
            next_steps=list(NEXT_STEPS), topics=list(TOPICS),
        )
        self.fails_on = fails_on

    async def __call__(self, transcript: str) -> Summary:
        self.calls.append(transcript)
        if self.fails_on is not None and self.fails_on in transcript:
            raise RuntimeError("the provider fell over")
        return self._summary


class _Extract:
    """Stands in for `extract_atoms`, recording what it was shown."""

    def __init__(self):
        self.calls: list[str] = []

    async def __call__(self, transcript: str, *, session_date):
        self.calls.append(transcript)
        return []


class _Consolidate:
    """Stands in for `consolidate`, recording each call's atoms."""

    def __init__(self):
        self.calls: list[list] = []

    async def __call__(self, db, learner_id, atoms, *, session_id, turn_ids,
                       valid_from=None):
        self.calls.append(list(atoms))


class _Rebuild:
    """Stands in for `rebuild_profile`."""

    def __init__(self):
        self.calls = 0

    async def __call__(self, db, learner_id) -> str:
        self.calls += 1
        return ""


class _Embed:
    """Stands in for `embed_texts`, recording the texts it was handed."""

    def __init__(self):
        self.calls: list[list[str]] = []

    async def __call__(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [VECTOR for _ in texts]


def _install(monkeypatch, *, summarize=None):
    """Point the pipeline at stubs. Returns all five, summarize first."""
    summarize = summarize or _Summarize()
    extract = _Extract()
    consolidate = _Consolidate()
    rebuild = _Rebuild()
    embed = _Embed()
    monkeypatch.setattr("app.memory.jobs._summarize", summarize)
    monkeypatch.setattr("app.memory.jobs.extract_atoms", extract)
    monkeypatch.setattr("app.memory.jobs.consolidate", consolidate)
    monkeypatch.setattr("app.memory.jobs.rebuild_profile", rebuild)
    monkeypatch.setattr("app.memory.jobs.embed_texts", embed)
    return summarize, extract, consolidate, rebuild, embed


@pytest.fixture(autouse=True)
def _no_pending_closes():
    """`_PENDING_CLOSES` is module state; a test must neither inherit nor
    leak one. Session ids do not survive the schema truncation between tests,
    so a leaked entry could only cost a warning line — but a test asserting
    sweep counts should not have to reason about another test's leftovers."""
    _PENDING_CLOSES.clear()
    yield
    _PENDING_CLOSES.clear()


async def _session_with(db_factory, turns: list[tuple[str, str]], *,
                        last_message_at: datetime | None = None) -> uuid.UUID:
    """A learner, a session and its messages, committed. Returns the session id.

    Migration 0003 seeds the sole learner; the test schema is built from the
    metadata and so has no seed (see `conftest.db_factory`).
    """
    async with db_factory() as db:
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
        session = Session(model="gpt-5.6-luna", reasoning_effort="high")
        db.add(session)
        await db.flush()
        for seq, (role, text) in enumerate(turns):
            message = Message(session_id=session.id, seq=seq, role=role, text=text)
            if last_message_at is not None:
                message.created_at = last_message_at
            db.add(message)
        await db.commit()
        return session.id


async def _say(db_factory, session_id: uuid.UUID, turns: list[tuple[str, str]],
               *, start_seq: int, created_at: datetime | None = None) -> None:
    """More messages into an existing session, from `start_seq` up."""
    async with db_factory() as db:
        for offset, (role, text) in enumerate(turns):
            message = Message(session_id=session_id, seq=start_seq + offset,
                              role=role, text=text)
            if created_at is not None:
                message.created_at = created_at
            db.add(message)
        await db.commit()


async def _add_turn(db_factory, session_id: uuid.UUID, *, status: str) -> uuid.UUID:
    """One turn row against `session_id`, committed. Returns its id."""
    turn_id = uuid.uuid4()
    async with db_factory() as db:
        db.add(Turn(id=turn_id, session_id=session_id, status=status,
                    model="gpt-5.6-luna", reasoning_effort="high"))
        await db.commit()
    return turn_id


async def _backlog(db_factory, episodes: list[tuple[datetime, str]],
                   **columns) -> None:
    """Unextracted episodes, straight into the table.

    No sessions or messages behind them: extraction reads the episode alone,
    so building the rows the close path would have written is the whole setup.
    """
    async with db_factory() as db:
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
        # Flushed before the episodes, not with them: `Episode.learner_id` is
        # a foreign key with no ORM relationship for the unit of work to order
        # by, so one flush would batch the inserts in add-order-by-table and
        # the episodes could reach Postgres before the learner does.
        await db.flush()
        for closed_at, transcript in episodes:
            db.add(Episode(
                learner_id=SOLE_LEARNER_ID, session_id=uuid.uuid4(),
                transcript=transcript, message_count=1,
                started_at=closed_at, closed_at=closed_at, **columns,
            ))
        await db.commit()


async def _episodes(db_factory, session_id: uuid.UUID) -> list[Episode]:
    """This session's episodes, in window order."""
    async with db_factory() as db:
        return list((await db.execute(
            select(Episode).where(Episode.session_id == session_id)
            .order_by(Episode.seq_from)
        )).scalars().all())


# --- window selection -------------------------------------------------------


@requires_db
async def test_each_close_records_the_window_the_last_one_did_not_cover(
    db_factory, monkeypatch,
):
    """The load-bearing change: a session is remembered window by window.

    The same session, closed twice with new messages between the closes, must
    produce two episodes whose windows tile the message range — not one
    frozen fossil and thirty-one unrememberable messages, which is the
    recorded production failure this rework exists to end.
    """
    _install(monkeypatch)
    session_id = await _session_with(db_factory, [
        ("learner", "help with fractions"),
        ("tutor", "what do you have so far"),
    ])
    await run_session_close(session_id, db_factory=db_factory)
    await _say(db_factory, session_id, [
        ("learner", "now decimals please"),
        ("tutor", "start with tenths"),
    ], start_seq=2)
    await run_session_close(session_id, db_factory=db_factory)

    episodes = await _episodes(db_factory, session_id)
    assert [(e.seq_from, e.seq_to) for e in episodes] == [(1, 2), (3, 4)]
    assert episodes[0].transcript == (
        "learner: help with fractions\ntutor: what do you have so far"
    )
    assert episodes[1].transcript == (
        "learner: now decimals please\ntutor: start with tenths"
    )
    assert [e.message_count for e in episodes] == [2, 2]
    assert all(e.extracted_at is not None for e in episodes)


@requires_db
async def test_a_mid_session_close_freezes_only_its_window(db_factory, monkeypatch):
    """The forensics case, replayed: a close at message one is not fatal.

    The device closed session A with one message recorded, then held sixteen
    more turns in it; the old constraint made everything after the close
    unrememberable forever. Now the sweep records the rest as the next window.
    """
    _install(monkeypatch)
    silent_since = datetime.now(timezone.utc) - STALE_AFTER - timedelta(minutes=1)
    session_id = await _session_with(
        db_factory, [("learner", "what is molecular speed?")],
        last_message_at=silent_since,
    )
    await run_session_close(session_id, db_factory=db_factory)

    await _say(db_factory, session_id, [
        ("tutor", "let us pin the definition down"),
        ("learner", "got it: v_rms, not the average"),
    ], start_seq=1, created_at=silent_since)

    assert await sweep_abandoned_sessions(db_factory=db_factory) == 1

    episodes = await _episodes(db_factory, session_id)
    assert [(e.seq_from, e.seq_to) for e in episodes] == [(1, 1), (2, 3)]
    assert episodes[1].transcript == (
        "tutor: let us pin the definition down\n"
        "learner: got it: v_rms, not the average"
    )
    # Fully covered now: the next sweep finds nothing to record.
    assert await sweep_abandoned_sessions(db_factory=db_factory) == 0


@requires_db
async def test_a_close_with_nothing_new_is_a_no_op(db_factory, monkeypatch):
    """The old episode-exists early-return, restated for windows: a retried
    close of a fully covered session writes nothing and extracts nothing —
    an empty window must never become an episode row in the backlog."""
    _, _, consolidate, _, _ = _install(monkeypatch)
    session_id = await _session_with(db_factory, [("learner", "hi")])

    await run_session_close(session_id, db_factory=db_factory)
    await run_session_close(session_id, db_factory=db_factory)

    episodes = await _episodes(db_factory, session_id)
    assert len(episodes) == 1
    assert len(consolidate.calls) == 1


@requires_db
async def test_the_sweep_leaves_a_fresh_uncovered_session_alone(
    db_factory, monkeypatch,
):
    """Staleness still gates the sweep: uncovered messages alone are a session
    in progress, not an abandoned one."""
    _install(monkeypatch)
    session_id = await _session_with(db_factory, [("learner", "hi")])

    assert await sweep_abandoned_sessions(db_factory=db_factory) == 0
    assert await _episodes(db_factory, session_id) == []


def test_stale_after_is_thirty_minutes():
    """Down from one hour on purpose: an early sweep now costs a window
    split, not the rest of the session, so promptness wins the trade."""
    assert STALE_AFTER == timedelta(minutes=30)


# --- reschedule on a running turn -------------------------------------------


@requires_db
async def test_a_close_declined_mid_turn_is_recorded_by_the_next_sweep_tick(
    db_factory, monkeypatch,
):
    """A decline is a reschedule, not a drop.

    The messages are deliberately fresh: staleness cannot be what records
    this session, so the pass has to come from the pending-close retry — the
    device said the learner left, and only the turn's lifetime may delay the
    recording, never `STALE_AFTER`.
    """
    _install(monkeypatch)
    session_id = await _session_with(db_factory, [("learner", "help")])
    turn_id = await _add_turn(db_factory, session_id, status="running")

    await run_session_close(session_id, db_factory=db_factory)
    assert await _episodes(db_factory, session_id) == []
    assert session_id in _PENDING_CLOSES

    async with db_factory() as db:
        (await db.get(Turn, turn_id)).status = "ok"
        await db.commit()

    assert await sweep_abandoned_sessions(db_factory=db_factory) == 1
    assert len(await _episodes(db_factory, session_id)) == 1
    assert session_id not in _PENDING_CLOSES


@requires_db
async def test_a_still_running_turn_keeps_the_close_pending(
    db_factory, monkeypatch,
):
    """The retry itself declines while the turn lives on, and the session
    stays parked for the tick after — deferred again, never forgotten."""
    _install(monkeypatch)
    session_id = await _session_with(db_factory, [("learner", "help")])
    await _add_turn(db_factory, session_id, status="running")

    await run_session_close(session_id, db_factory=db_factory)
    assert await sweep_abandoned_sessions(db_factory=db_factory) == 0

    assert await _episodes(db_factory, session_id) == []
    assert session_id in _PENDING_CLOSES


# --- rich summaries ---------------------------------------------------------


@requires_db
async def test_extraction_writes_the_rich_summary(db_factory, monkeypatch):
    """Title, narrative, next steps, topics, embedding — and the digest as the
    narrative's first two sentences, for every reader still on the old column."""
    _, _, _, _, embed = _install(monkeypatch)
    session_id = await _session_with(db_factory, [
        ("learner", "how does molecular speed relate to temperature?"),
        ("tutor", "let us start from kinetic energy"),
    ])

    await run_session_close(session_id, db_factory=db_factory)

    [episode] = await _episodes(db_factory, session_id)
    assert episode.title == TITLE
    assert episode.narrative == NARRATIVE
    assert episode.next_steps == NEXT_STEPS
    assert episode.topics == TOPICS
    assert episode.narrative_embedding is not None
    assert episode.digest == NARRATIVE_DIGEST
    # The third sentence is narrative-only — the compatibility digest is a
    # prefix, not a paraphrase.
    assert "unfinished" not in episode.digest
    # The embedding covers title and narrative together: the title carries the
    # specific nouns a search query is likeliest to share.
    assert embed.calls == [[f"{TITLE}\n{NARRATIVE}"]]


def test_first_sentences_takes_two_and_survives_decimals():
    assert _first_sentences(
        "Converted 30 °C to 303.15 K. Then derived E_k. A third sentence."
    ) == "Converted 30 °C to 303.15 K. Then derived E_k."


def test_first_sentences_of_a_single_sentence_is_that_sentence():
    assert _first_sentences("Just the one.") == "Just the one."


def test_an_unreadable_summary_raises_rather_than_blanking_the_episode():
    """A malformed summary written as done would mark the episode extracted
    with nothing to show — invisible forever. Raising keeps it in the backlog,
    where three failures make it a visible quarantine instead."""
    with pytest.raises(ValueError):
        _parse_summary("not json at all")
    with pytest.raises(ValueError):
        _parse_summary(json.dumps({
            "title": "", "narrative": "Fine.", "next_steps": [], "topics": [],
        }))
    with pytest.raises(ValueError):
        _parse_summary(json.dumps({
            "title": "Fine", "narrative": "  ", "next_steps": [], "topics": [],
        }))


def test_parse_summary_drops_mangled_list_entries_but_keeps_the_summary():
    summary = _parse_summary(json.dumps({
        "title": "T", "narrative": "N.",
        "next_steps": ["derive it", 3, "  "], "topics": "not-a-list",
    }))
    assert summary.next_steps == ["derive it"]
    assert summary.topics == []


# --- transcript cap ---------------------------------------------------------


def test_the_model_transcript_is_tail_capped_at_a_line_boundary():
    lines = [f"learner: line {i}" for i in range(6000)]
    transcript = "\n".join(lines)
    assert len(transcript) > TRANSCRIPT_CHAR_CAP

    capped = _tail(transcript)

    assert len(capped) <= TRANSCRIPT_CHAR_CAP + len(TRUNCATION_MARKER) + 1
    marker, body = capped.split("\n", 1)
    assert marker == TRUNCATION_MARKER
    # Cut on a line boundary — the first visible line still opens with its
    # speaker — and the tail is the transcript's own, verbatim.
    assert body.startswith("learner: ")
    assert transcript.endswith(body)
    assert capped.endswith("learner: line 5999")


def test_a_short_transcript_is_not_touched():
    assert _tail("learner: hi\ntutor: hello") == "learner: hi\ntutor: hello"


@requires_db
async def test_model_calls_see_the_cap_while_the_row_keeps_the_whole_transcript(
    db_factory, monkeypatch,
):
    """The cap protects the calls, never the record: `Episode.transcript`
    stays whole — nothing is lost, merely unsummarized."""
    summarize, extract, _, _, _ = _install(monkeypatch)
    long_transcript = "\n".join(f"learner: line {i}" for i in range(6000))
    await _backlog(db_factory, [(MARCH, long_transcript)])

    assert await run_extraction_backlog(db_factory=db_factory) == 1

    [shown] = summarize.calls
    assert shown.startswith(TRUNCATION_MARKER)
    assert len(shown) <= TRANSCRIPT_CHAR_CAP + len(TRUNCATION_MARKER) + 1
    # Extraction is shown the same capped text, not its own cut.
    assert extract.calls == [shown]
    async with db_factory() as db:
        stored = (await db.execute(select(Episode.transcript))).scalar_one()
    assert stored == long_transcript


# --- quarantine -------------------------------------------------------------


@requires_db
async def test_a_poison_episode_is_quarantined_and_the_drain_moves_on(
    db_factory, monkeypatch, caplog,
):
    """Three failures, counted; then the drain stops halting for it.

    The first two failures still halt the drain — ordering is worth two
    ticks of patience — so the newer episode must stay unread through them.
    The third quarantines the poison episode and extracts the newer one in
    the same pass, and `/health`'s numbers say what happened.
    """
    summarize = _Summarize(fails_on="march")
    _install(monkeypatch, summarize=summarize)
    await _backlog(db_factory, [(MARCH, "march"), (JUNE, "june")])

    for attempt in (1, 2):
        with pytest.raises(RuntimeError):
            await run_extraction_backlog(db_factory=db_factory)
        assert summarize.calls == ["march"] * attempt

    with caplog.at_level(logging.ERROR, logger="app.memory.jobs"):
        assert await run_extraction_backlog(db_factory=db_factory) == 1
    assert "the drain continues past it" in caplog.text
    assert summarize.calls == ["march"] * QUARANTINE_AFTER + ["june"]

    async with db_factory() as db:
        rows = {e.transcript: e
                for e in (await db.execute(select(Episode))).scalars()}
    assert rows["march"].extraction_attempts == QUARANTINE_AFTER
    assert rows["march"].quarantined_at is not None
    assert rows["march"].extracted_at is None
    assert rows["june"].extracted_at is not None

    # Quarantined means excluded, not retried: the next drain does not touch
    # it, and the backlog reads empty while the quarantine count says why.
    assert await run_extraction_backlog(db_factory=db_factory) == 0
    assert summarize.calls == ["march"] * QUARANTINE_AFTER + ["june"]
    assert await backlog_status(db_factory=db_factory) == {
        "unextracted_episodes": 0,
        "oldest_unextracted_age_seconds": None,
        "quarantined_episodes": 1,
    }


# --- explicit atoms ---------------------------------------------------------


@requires_db
async def test_an_explicit_note_is_never_offered_for_supersession(db):
    """The saved-note guarantee, at the one gate that can break it.

    Both atoms sit at distance zero from the query vector — the explicit one
    is excluded by what it is, not by how it scores. Held out of
    `_candidates`, no adjudicator ruling can ever name it as a target, so the
    note the learner dictated cannot be silently closed by a later
    extraction; only `forget` closes it.
    """
    db.add(Learner(id=SOLE_LEARNER_ID, display_name="me"))
    note = MemoryAtom(
        learner_id=SOLE_LEARNER_ID,
        text="Next session, derive the ideal-gas temperature-kinetic-energy "
             "relationship from molecular collisions step by step.",
        category="goal", embedding=VECTOR, explicit=True,
    )
    fact = MemoryAtom(
        learner_id=SOLE_LEARNER_ID,
        text="Wants to derive the gas law from collisions.",
        category="goal", embedding=VECTOR, explicit=False,
    )
    db.add_all([note, fact])
    await db.commit()

    candidates = await _candidates(db, SOLE_LEARNER_ID, [VECTOR])

    ids = {row.id for row in candidates}
    assert fact.id in ids
    assert note.id not in ids


# --- the reply-lost placeholder ---------------------------------------------


@requires_db
async def test_a_failed_turn_leaves_a_reply_lost_tutor_message(
    db, db_factory, tmp_path,
):
    """A failed turn used to leave a one-sided transcript — the learner's
    question and silence — which every window recorded over it then handed to
    the summarizer as fact. The placeholder makes the window read as what
    happened."""
    session = Session(model="gpt-5.6-luna", reasoning_effort="high")
    db.add(session)
    await db.flush()
    db.add(Message(session_id=session.id, seq=0, role="learner", text="help me"))
    turn_id = uuid.uuid4()
    db.add(Turn(id=turn_id, session_id=session.id, status="running",
                model="gpt-5.6-luna", reasoning_effort="high"))
    await db.commit()

    recorder = Recorder(db_factory, LocalBlobStore(tmp_path))
    await recorder.fail_turn(
        turn_id=turn_id, message="client disconnected", retryable=True,
    )

    async with db_factory() as fresh:
        messages = (await fresh.execute(
            select(Message).where(Message.session_id == session.id)
            .order_by(Message.seq)
        )).scalars().all()
    assert [(m.seq, m.role, m.text) for m in messages] == [
        (0, "learner", "help me"),
        (1, "tutor", REPLY_LOST_TEXT),
    ]


# --- the summary backfill ---------------------------------------------------


@requires_db
async def test_the_backfill_re_summarizes_newest_first_and_bounded(
    db_factory, monkeypatch,
):
    """History converges without re-extraction and without a spend spike.

    Newest first, because the recent past is what the next session asks
    about; bounded per pass, so one tick pays for one batch; and summaries
    only — the atoms these episodes yielded were consolidated when they were
    first extracted, and running extraction again would double every one.
    """
    summarize, _, consolidate, _, _ = _install(monkeypatch)
    await _backlog(
        db_factory,
        [(MARCH, "march"), (APRIL, "april"), (JUNE, "june")],
        digest="the old two-sentence digest", extracted_at=JUNE,
    )

    assert await run_summary_backfill(db_factory=db_factory, limit=2) == 2
    assert summarize.calls == ["june", "april"]

    async with db_factory() as db:
        rows = {e.transcript: e
                for e in (await db.execute(select(Episode))).scalars()}
    assert rows["june"].narrative == NARRATIVE
    assert rows["june"].title == TITLE
    assert rows["june"].narrative_embedding is not None
    assert rows["june"].digest == NARRATIVE_DIGEST
    assert rows["march"].narrative is None
    assert rows["march"].digest == "the old two-sentence digest"

    assert await run_summary_backfill(db_factory=db_factory, limit=2) == 1
    assert summarize.calls == ["june", "april", "march"]
    # Converged: nothing left to re-summarize, and no atoms were ever touched.
    assert await run_summary_backfill(db_factory=db_factory) == 0
    assert consolidate.calls == []
