"""Does the tutor actually remember? Rebuild memory from transcripts, then ask.

    cd server && uv run python tests/eval/run_probes.py

**This costs money and is never part of `pytest`.** It is a plain script, not a
test module, so `testpaths = ["tests"]` cannot collect it: pytest only collects
`test_*.py`. Every probe makes real provider calls against a real Postgres, so
it is run deliberately, and the run prints what it spent.

**Why it rebuilds every time.** The failure a memory system cannot see is an
extraction that never produced the fact: retrieval then scores perfectly over a
store that is missing it, every unit test stays green, and the only symptom is a
tutor that feels vaguely forgetful. A probe suite run against a pre-built store
cannot see that either. So each probe starts from an empty schema and replays
raw transcripts through `app.memory.jobs.run_session_close` — digest, extract,
consolidate, rebuild the portrait — exactly as a device leaving a session would.

**Why it then asks a live question.** "The fact is in the store" and "the tutor
uses it" are different failures, and only the second one is what the learner
experiences. So the question goes through `app.tutor.loop.run_turn` with the
context `app.api.turn` would have assembled and the four memory tools bound, and
the assertion is on what the tutor said. `store_any` in the probe file is what
tells the two failures apart in the report.

What is *not* covered: the HTTP layer above `run_turn` (auth, SSE framing, the
recorder) and the device's board. Those have unit tests; memory does not have an
end-to-end one, which is what this is.

Requires `TEST_DATABASE_URL` (a Neon test branch — this creates and drops a
throwaway schema on it) and `OPENAI_API_KEY`. Both are read from `server/.env`.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import pathlib
import re
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import yaml

# `server/`, so `app` and this file's own package resolve however the script was
# invoked. Before the app imports, and before dotenv, because both depend on it.
ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402

# By absolute path, not by cwd. `Settings` has `env_file=".env"`, which resolves
# against whatever directory the script was started from — so a run from the
# repo root would silently find no key and no database. Loading it here puts the
# same values in `os.environ`, where pydantic-settings reads them from wherever
# this was run. `override=False` so a value already exported wins, which is how
# a one-off run against a different branch is done.
load_dotenv(ROOT / ".env", override=False)

from openai import AsyncOpenAI  # noqa: E402
from openai.resources.embeddings import AsyncEmbeddings  # noqa: E402
from openai.resources.responses import AsyncResponses  # noqa: E402
from sqlalchemy import select, text as sa_text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

from app.api.turn import RECENT_SESSION_COUNT, _memory_sections  # noqa: E402
from app.config import (  # noqa: E402
    DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, EXTRACTION_MODEL, SOLE_LEARNER_ID,
    get_settings,
)
from app.memory.dispatch import memory_handler  # noqa: E402
from app.memory.extract import MIN_TRANSCRIPT_CHARS  # noqa: E402
from app.memory.jobs import run_session_close  # noqa: E402
from app.memory.profile import current_profile  # noqa: E402
from app.memory.retrieve import recent_episodes, render_digests  # noqa: E402
from app.store.models import (  # noqa: E402
    Base, Episode, Learner, MemoryAtom, Message, Session,
)
from app.tutor.context import assemble_context  # noqa: E402
from app.tutor.loop import run_turn  # noqa: E402

PROBES = pathlib.Path(__file__).parent / "probes.yaml"

#: The model the probe *turn* runs on. `EXTRACTION_MODEL` rather than whatever
#: the device happens to default to, because this suite is paid for out of the
#: owner's pocket and is run repeatedly: the cheapest model in the allowlist is
#: the one that can be afforded often enough to catch a regression. What is
#: being measured is whether the facts reached the prompt and were used, and
#: that does not need the expensive tier. `--model` overrides it for the day
#: someone wants to check the parity.
PROBE_MODEL = EXTRACTION_MODEL

#: Reasoning effort for the probe turn. Low for the same reason as the model:
#: reasoning tokens are most of a turn's bill and recall is not a reasoning
#: problem. `--effort high` is there for when a probe fails and the question is
#: whether it fails at full strength too.
PROBE_EFFORT = "low"

#: How far ahead the templated exam deadline sits. Far enough that it is still
#: in the future for a learner talking about revision, whenever the suite runs.
DEADLINE_DAYS = 95

#: USD per million tokens, for the run's cost line.
#:
#: **A guess unless you set it.** Nothing in this service records a price — see
#: the "daily spend cap never trips" note in the README, which is the same gap —
#: so these are the harness's own assumption for the cheap tier and are the one
#: number in the report that is not measured. Token counts beside them are.
#: Override with PROBE_PRICE_IN / PROBE_PRICE_OUT / PROBE_PRICE_EMBED.
PRICE_IN = float(os.environ.get("PROBE_PRICE_IN", "0.25"))
PRICE_OUT = float(os.environ.get("PROBE_PRICE_OUT", "2.00"))
PRICE_EMBED = float(os.environ.get("PROBE_PRICE_EMBED", "0.02"))


# --------------------------------------------------------------------------
# Metering
# --------------------------------------------------------------------------


@dataclass
class Meter:
    """What one run spent, counted at the SDK boundary.

    Every provider call in the pipeline is made by a module that owns its own
    cached client and reports nothing back to its caller — a digest, an
    extraction, an adjudication and a synthesis per session, plus embeddings.
    Adding a return value to each of them so a test harness could add them up
    would be the harness leaking into the service, so this counts them from
    outside instead, by wrapping the two SDK methods they all go through.

    The streaming turn is the exception and is added separately: `create`
    returns a stream whose usage only exists once it has been consumed, and
    `run_turn` already accumulates exactly that into `TurnResult.usage`.
    """

    calls: int = 0
    embedding_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    embedding_tokens: int = 0

    def add_usage(self, usage: object) -> None:
        if usage is None:
            return
        self.input_tokens += int(getattr(usage, "input_tokens", 0) or 0)
        self.output_tokens += int(getattr(usage, "output_tokens", 0) or 0)
        details = getattr(usage, "output_tokens_details", None)
        self.reasoning_tokens += int(getattr(details, "reasoning_tokens", 0) or 0)

    def add_turn_usage(self, usage: dict | None) -> None:
        """`TurnResult.usage`, which is a dict rather than an SDK object."""
        if not usage:
            return
        self.calls += 1
        self.input_tokens += int(usage.get("input_tokens") or 0)
        self.output_tokens += int(usage.get("output_tokens") or 0)
        details = usage.get("output_tokens_details") or {}
        self.reasoning_tokens += int(details.get("reasoning_tokens") or 0)

    @property
    def usd(self) -> float:
        return (
            self.input_tokens * PRICE_IN
            + self.output_tokens * PRICE_OUT
            + self.embedding_tokens * PRICE_EMBED
        ) / 1_000_000

    def line(self) -> str:
        return (
            f"{self.calls} model calls + {self.embedding_calls} embedding calls | "
            f"{self.input_tokens:,} in / {self.output_tokens:,} out "
            f"({self.reasoning_tokens:,} reasoning) / "
            f"{self.embedding_tokens:,} embedded | "
            f"~${self.usd:.3f} at ${PRICE_IN}/${PRICE_OUT} per Mtok"
        )


@contextlib.contextmanager
def metered(meter: Meter):
    """Count every provider call made inside this block.

    Patched on the resource classes rather than on any one client, because the
    pipeline builds five separate `AsyncOpenAI` instances behind five
    `@lru_cache`d `_client()` functions and there is no seam that sees them all.
    Process-local and undone on exit; this script is the whole process.
    """
    responses_create = AsyncResponses.create
    embeddings_create = AsyncEmbeddings.create

    async def create(self, *args, **kwargs):
        result = await responses_create(self, *args, **kwargs)
        usage = getattr(result, "usage", None)
        # A streaming call returns an `AsyncStream`, which has no usage yet;
        # `run_turn` reports that one and `add_turn_usage` takes it.
        if usage is not None:
            meter.calls += 1
            meter.add_usage(usage)
        return result

    async def embed(self, *args, **kwargs):
        result = await embeddings_create(self, *args, **kwargs)
        meter.embedding_calls += 1
        usage = getattr(result, "usage", None)
        meter.embedding_tokens += int(getattr(usage, "total_tokens", 0) or 0)
        return result

    AsyncResponses.create = create
    AsyncEmbeddings.create = embed
    try:
        yield
    finally:
        AsyncResponses.create = responses_create
        AsyncEmbeddings.create = embeddings_create


# --------------------------------------------------------------------------
# The throwaway schema
# --------------------------------------------------------------------------


@dataclass
class Store:
    engine: object
    schema: str
    factory: async_sessionmaker


async def open_store() -> Store:
    """A fresh schema on the test branch, with every table in it.

    The same `schema_translate_map` trick `tests/conftest.py` uses, and for the
    same reason: no model carries an explicit `schema=`, so the map rewrites
    both the DDL and every ORM query onto a schema of this run's own without
    touching a line of application code. Deliberately not the conftest fixture —
    that is a pytest fixture, and reaching into pytest internals from a script
    is how a harness breaks on a pytest upgrade for no reason.

    Raw `text()` is used for the three statements that are not about a table
    (extension, schema, truncate), and the truncate is schema-qualified by hand
    because `schema_translate_map` does not rewrite raw SQL — an unqualified
    TRUNCATE would resolve through the connection's search_path and silently
    empty nothing.
    """
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        raise SystemExit(
            "TEST_DATABASE_URL is not set. Point it at a Neon test branch — this "
            "creates and drops a throwaway schema on it."
        )
    schema = f"probe_{uuid.uuid4().hex}"
    engine = create_async_engine(url, pool_pre_ping=True)
    engine = engine.execution_options(schema_translate_map={None: schema})
    async with engine.begin() as conn:
        await conn.execute(sa_text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.execute(sa_text(f'CREATE SCHEMA "{schema}"'))
        await conn.run_sync(Base.metadata.create_all)
    return Store(engine=engine, schema=schema,
                 factory=async_sessionmaker(engine, expire_on_commit=False))


async def reset(store: Store) -> None:
    """Empty every table and seed the one learner. Run before each probe.

    Probes must not see each other's facts — `does_not_invent_memories` asks
    about an exam date that another probe states — and truncating is an order of
    magnitude cheaper than a schema per probe.
    """
    names = ", ".join(
        f'"{store.schema}"."{table.name}"' for table in Base.metadata.sorted_tables
    )
    async with store.engine.begin() as conn:
        await conn.execute(sa_text(f"TRUNCATE TABLE {names} RESTART IDENTITY CASCADE"))
    async with store.factory() as db:
        # Migration 0003 seeds this row; `create_all` does not run migrations,
        # and every memory table has a foreign key to it.
        db.add(Learner(id=SOLE_LEARNER_ID, display_name="probe learner"))
        await db.commit()


async def close_store(store: Store) -> None:
    with contextlib.suppress(Exception):
        async with store.engine.begin() as conn:
            await conn.execute(
                sa_text(f'DROP SCHEMA IF EXISTS "{store.schema}" CASCADE')
            )
    await store.engine.dispose()


# --------------------------------------------------------------------------
# The probe file
# --------------------------------------------------------------------------


def placeholders(now: datetime) -> dict[str, str]:
    deadline = (now + timedelta(days=DEADLINE_DAYS)).date()
    return {
        "deadline": deadline.strftime("%-d %B %Y"),
        "deadline_month": deadline.strftime("%B"),
        "deadline_iso": deadline.isoformat(),
    }


def _fill(value, values: dict[str, str]):
    if isinstance(value, str):
        return value.format(**values)
    if isinstance(value, list):
        return [_fill(item, values) for item in value]
    if isinstance(value, dict):
        return {key: _fill(item, values) for key, item in value.items()}
    return value


def load_probes(now: datetime) -> list[dict]:
    """Every probe, placeholders resolved and every foot-gun refused up front.

    Validation runs before the first provider call on purpose. A transcript
    below `MIN_TRANSCRIPT_CHARS` is skipped by `extract_atoms` outright, so the
    probe would run, cost money, and be measuring nothing — a green one would be
    the most misleading result this suite could produce.
    """
    raw = yaml.safe_load(PROBES.read_text())
    if not isinstance(raw, list) or not raw:
        raise SystemExit(f"{PROBES} does not hold a non-empty list of probes.")
    probes = [_fill(probe, placeholders(now)) for probe in raw]

    seen: set[str] = set()
    for probe in probes:
        name = probe.get("name")
        if not name or name in seen:
            raise SystemExit(f"probe names must be present and unique: {name!r}")
        seen.add(name)
        if not probe.get("question"):
            raise SystemExit(f"{name}: no question")
        if not probe.get("answer_any") and not probe.get("answer_none"):
            raise SystemExit(f"{name}: asserts nothing about the answer")
        for index, spec in enumerate(probe.get("sessions") or []):
            transcript = spec.get("transcript") or ""
            if len(transcript) < MIN_TRANSCRIPT_CHARS:
                raise SystemExit(
                    f"{name}: session {index} is {len(transcript)} characters, "
                    f"under extract.MIN_TRANSCRIPT_CHARS ({MIN_TRANSCRIPT_CHARS}). "
                    "Extraction would be skipped and the probe would prove "
                    "nothing. Write a longer transcript."
                )
            for line in _turns(transcript):
                if line[0] not in ("learner", "tutor"):
                    raise SystemExit(
                        f"{name}: session {index} has a line that does not start "
                        f"'learner:' or 'tutor:': {line[0]!r}"
                    )
    return probes


def _turns(transcript: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    for line in transcript.splitlines():
        line = line.strip()
        if not line:
            continue
        role, _, text = line.partition(":")
        out.append((role.strip(), text.strip()))
    return out


# --------------------------------------------------------------------------
# Matching
# --------------------------------------------------------------------------


#: Typography the model writes and nobody types into an expectation list.
#:
#: The system prompt asks for polished Markdown and the model obliges: it wrote
#: "haven’t" with U+2019 and the first run of `does_not_invent_memories` failed
#: on a probe the tutor had actually answered correctly. Folding both sides is
#: the fix; the alternative is every apostrophe in `probes.yaml` being a trap.
_TYPOGRAPHY = str.maketrans({
    "‘": "'", "’": "'", "ʼ": "'",
    "“": '"', "”": '"',
    "–": "-", "—": "-", "−": "-",
    " ": " ", " ": " ",
})


def _fold(text: str) -> str:
    return text.translate(_TYPOGRAPHY)


def _pattern(needle: str) -> str:
    """`needle` with word boundaries only where a word boundary makes sense.

    A plain substring test is what makes an expectation list lie: "not" matches
    "nothing" and "note", so `does_not_invent_memories` would pass on a reply
    that invented an exam date and then said "note that". `\\b` alone is no good
    either — it would refuse to match "10^" before a digit, because `^` is not a
    word character and the boundary lands in the wrong place. So the guard goes
    on each end only when that end is alphanumeric.
    """
    folded = _fold(needle)
    escaped = re.escape(folded)
    left = r"(?<!\w)" if folded[:1].isalnum() else ""
    right = r"(?!\w)" if folded[-1:].isalnum() else ""
    return left + escaped + right


def hits(needles: list[str] | None, haystack: str) -> list[str]:
    folded = _fold(haystack)
    return [n for n in (needles or [])
            if re.search(_pattern(n), folded, re.IGNORECASE)]


# --------------------------------------------------------------------------
# Running one probe
# --------------------------------------------------------------------------


@dataclass
class Snapshot:
    """What the store holds after the transcripts have been replayed."""

    profile: str
    live: list[tuple[str, str]] = field(default_factory=list)
    superseded: list[tuple[str, str]] = field(default_factory=list)
    digests: str = ""

    @property
    def text(self) -> str:
        return "\n".join([self.profile, *(f"[{c}] {t}" for c, t in self.live)])


@dataclass
class Result:
    name: str
    ok: bool
    seconds: float
    answer: str
    snapshot: Snapshot
    tools: list[str]
    sections: dict[str, bool]
    failures: list[str] = field(default_factory=list)
    store_ok: bool | None = None


async def replay(store: Store, spec: dict, *, now: datetime) -> None:
    """One prior session, lived and then left, through the real close path.

    `run_session_close` is what the device's close endpoint calls: it freezes
    the session as an episode, sweeps anything abandoned, and drains the
    extraction backlog — digest, extract, consolidate, rebuild. Nothing here
    reaches past it into the individual steps, because a harness that called
    `extract_atoms` and `consolidate` itself would keep passing after the close
    path stopped calling them.

    The episode's `closed_at` is corrected afterwards, and only that. The
    session's own clock is set before the close and carries everything that
    matters to the facts — `session_date` for the extractor, `valid_from` for
    the atoms — but `closed_at` is stamped `now()` by the insert, and it is what
    `render_digests` prints and orders by. Left alone, six sessions spanning two
    months would all be dated today and "what did we do last time" would be a
    coin flip between them.
    """
    when = now - timedelta(days=int(spec["days_ago"]))
    session_id = uuid.uuid4()
    turns = _turns(spec["transcript"])
    async with store.factory() as db:
        db.add(Session(id=session_id, model=DEFAULT_MODEL,
                       reasoning_effort=DEFAULT_REASONING_EFFORT,
                       started_at=when))
        for seq, (role, text) in enumerate(turns):
            db.add(Message(session_id=session_id, seq=seq, role=role, text=text,
                           created_at=when + timedelta(minutes=seq)))
        await db.commit()

    await run_session_close(session_id, db_factory=store.factory)

    async with store.factory() as db:
        episode = (await db.execute(
            select(Episode).where(Episode.session_id == session_id)
        )).scalar_one_or_none()
        if episode is not None:
            episode.closed_at = when + timedelta(hours=1)
            await db.commit()


async def snapshot(store: Store) -> Snapshot:
    async with store.factory() as db:
        profile = await current_profile(db, SOLE_LEARNER_ID) or ""
        live = [
            (atom.category, atom.text)
            for atom in (await db.execute(
                select(MemoryAtom)
                .where(MemoryAtom.learner_id == SOLE_LEARNER_ID,
                       MemoryAtom.valid_to.is_(None))
                .order_by(MemoryAtom.valid_from, MemoryAtom.id)
            )).scalars().all()
        ]
        superseded = [
            (atom.category, atom.text)
            for atom in (await db.execute(
                select(MemoryAtom)
                .where(MemoryAtom.learner_id == SOLE_LEARNER_ID,
                       MemoryAtom.superseded_by.is_not(None))
                .order_by(MemoryAtom.valid_from, MemoryAtom.id)
            )).scalars().all()
        ]
        digests = render_digests(
            await recent_episodes(db, SOLE_LEARNER_ID, limit=RECENT_SESSION_COUNT)
        )
    return Snapshot(profile=profile, live=live, superseded=superseded,
                    digests=digests)


async def ask(
    store: Store, question: str, *, model: str, effort: str, meter: Meter,
) -> tuple[str, list[str], dict[str, bool]]:
    """Put the question to the tutor the way `/v1/turn` would.

    Everything below the HTTP layer is the real thing: `_memory_sections` reads
    the store the endpoint reads, `assemble_context` builds the prompt the
    endpoint builds, and `run_turn` streams with the four memory tools bound
    through `memory_handler`. What is skipped is auth, SSE framing, the board
    and the recorder — none of which memory passes through.

    The tool names are traced because they are the difference between a tutor
    that answered from the injected portrait and one that went and looked, and
    a failing probe reads completely differently depending on which happened.
    """
    session_id = uuid.uuid4()
    async with store.factory() as db:
        db.add(Session(id=session_id, model=model, reasoning_effort=effort))
        db.add(Message(session_id=session_id, seq=0, role="learner", text=question))
        await db.commit()

    async with store.factory() as db:
        session = await db.get(Session, session_id)
        messages = list((await db.execute(
            select(Message).where(Message.session_id == session_id)
            .order_by(Message.seq)
        )).scalars().all())
        sections = await _memory_sections(db)
        bundle = assemble_context(
            session=session, messages=messages, image_data=None,
            image_region=None, signal=None, goal=None, **sections,
        )

    called: list[str] = []
    handler = memory_handler(store.factory, learner_id=SOLE_LEARNER_ID,
                             turn_id=None, session_id=session_id)

    async def traced(name: str, arguments: dict) -> str:
        called.append(name)
        return await handler(name, arguments)

    # SDK defaults for retries, unlike `/v1/turn`, which passes max_retries=0
    # because `app/tutor/retry.py` owns a retry loop above it that must never
    # re-bill a 429. There is no such loop here, and a rate limit reported as a
    # forgetful tutor would be the worst kind of false positive.
    client = AsyncOpenAI(api_key=get_settings().openai_api_key)
    # The accumulating `TurnResult` is kept and read *after* the stream, the way
    # `/v1/turn` keeps it, rather than snapshotting fields inside the loop.
    # `run_turn` records usage when it sees `response.completed`, and
    # `EventTranslator.translate` emits nothing for that event — so the last
    # iteration of this loop happens strictly before usage exists, and reading
    # it there silently reported every tool-free turn as costing nothing. Which
    # is the single most expensive call in the run.
    result = None
    async for _event, running in run_turn(
        client=client, model=model, effort=effort, bundle=bundle,
        handle_memory=traced,
    ):
        result = running
    meter.add_turn_usage(result.usage if result else None)
    present = {key: bool(value) for key, value in sections.items()}
    return (result.text if result else ""), called, present


async def run_probe(
    store: Store, probe: dict, *, model: str, effort: str, meter: Meter,
    now: datetime,
) -> Result:
    started = time.monotonic()
    await reset(store)
    for spec in probe.get("sessions") or []:
        await replay(store, spec, now=now)

    shot = await snapshot(store)
    answer, tools, sections = await ask(
        store, probe["question"], model=model, effort=effort, meter=meter,
    )

    failures: list[str] = []
    wanted = probe.get("answer_any")
    if wanted and not hits(wanted, answer):
        failures.append(f"the answer contains none of {wanted}")
    leaked = hits(probe.get("answer_none"), answer)
    if leaked:
        failures.append(f"the answer contains {leaked}, which it must not")
    if probe.get("expect_supersession") and not shot.superseded:
        failures.append("no atom was superseded, so the stale fact is still live")

    store_ok = None
    if probe.get("store_any"):
        store_ok = bool(hits(probe["store_any"], shot.text))
        if not store_ok:
            failures.append(
                f"the store contains none of {probe['store_any']} — extraction "
                "never produced the fact, so the tutor never had it"
            )

    return Result(
        name=probe["name"], ok=not failures,
        seconds=time.monotonic() - started, answer=answer, snapshot=shot,
        tools=tools, sections=sections, failures=failures, store_ok=store_ok,
    )


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------


def report(result: Result) -> None:
    verdict = "PASS" if result.ok else "FAIL"
    print(f"{verdict}  {result.name}"
          f"  ({result.seconds:.0f}s, {len(result.snapshot.live)} live atoms, "
          f"{len(result.snapshot.superseded)} superseded"
          f"{', tools: ' + ','.join(result.tools) if result.tools else ''})")
    if result.ok:
        return
    for failure in result.failures:
        print(f"        {failure}")
    if result.store_ok:
        print("        the store HAD it — this is the tutor not using what it "
              "was given, not an extraction miss")
    blocks = [name for name, present in result.sections.items() if present]
    print(f"        prompt blocks present: {', '.join(blocks) or 'NONE'}")
    print("        --- profile ---")
    print(_indent(result.snapshot.profile or "(none)"))
    print("        --- live atoms ---")
    print(_indent("\n".join(f"[{c}] {t}" for c, t in result.snapshot.live)
                  or "(none)"))
    if result.snapshot.superseded:
        print("        --- superseded atoms ---")
        print(_indent("\n".join(f"[{c}] {t}"
                                for c, t in result.snapshot.superseded)))
    print("        --- digests ---")
    print(_indent(result.snapshot.digests or "(none)"))
    print("        --- answer ---")
    print(_indent(result.answer or "(empty)"))
    print()


def _indent(body: str) -> str:
    return "\n".join(f"          {line}" for line in body.splitlines())


# --------------------------------------------------------------------------


async def main() -> int:
    # A run is minutes long and every probe prints as it lands. Redirected to a
    # file, Python block-buffers stdout and the whole report appears at the end,
    # which for a suite this slow reads as a hang.
    sys.stdout.reconfigure(line_buffering=True)

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", action="append", default=None,
                        help="run only probes whose name contains this "
                             "(repeatable)")
    parser.add_argument("--model", default=PROBE_MODEL,
                        help=f"model for the probe turn (default {PROBE_MODEL})")
    parser.add_argument("--effort", default=PROBE_EFFORT,
                        choices=("low", "medium", "high"),
                        help=f"reasoning effort (default {PROBE_EFFORT})")
    parser.add_argument("--list", action="store_true",
                        help="print the probes and what a run would cost in "
                             "calls, without making any")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    probes = load_probes(now)
    if args.only:
        probes = [p for p in probes
                  if any(needle in p["name"] for needle in args.only)]
        if not probes:
            raise SystemExit(f"no probe matches {args.only}")

    if args.list:
        sessions = sum(len(p.get("sessions") or []) for p in probes)
        for probe in probes:
            print(f"{probe['name']}  ({len(probe.get('sessions') or [])} sessions)")
        # Per session: digest, extraction, adjudication (once anything is on
        # file), synthesis — plus one embedding call. Plus one turn per probe.
        print(f"\n{len(probes)} probes, {sessions} sessions "
              f"≈ {sessions * 4 + len(probes)} model calls "
              f"+ {sessions} embedding calls")
        return 0

    meter = Meter()
    store = await open_store()
    results: list[Result] = []
    started = time.monotonic()
    try:
        with metered(meter):
            for probe in probes:
                try:
                    result = await run_probe(
                        store, probe, model=args.model, effort=args.effort,
                        meter=meter, now=now,
                    )
                except Exception as error:  # noqa: BLE001
                    # One probe that blows up must not take the rest of a paid
                    # run with it — and the traceback is the finding.
                    import traceback
                    print(f"ERROR {probe['name']}: "
                          f"{type(error).__name__}: {error}")
                    print(_indent(traceback.format_exc()))
                    results.append(Result(
                        name=probe["name"], ok=False, seconds=0.0, answer="",
                        snapshot=Snapshot(profile=""), tools=[], sections={},
                        failures=[f"raised {type(error).__name__}: {error}"],
                    ))
                    continue
                results.append(result)
                report(result)
    finally:
        await close_store(store)

    passed = sum(1 for r in results if r.ok)
    print(f"\n{passed}/{len(results)} probes passed "
          f"in {time.monotonic() - started:.0f}s")
    print(meter.line())
    if not results or passed != len(results):
        print("\nA failing probe is a finding about the memory system, not "
              "about the harness. Read the store dump above: an empty or "
              "wrong profile is extraction or consolidation; a right profile "
              "with a wrong answer is the prompt or the tutor.")
    return 0 if results and passed == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
