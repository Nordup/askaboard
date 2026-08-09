"""What a newly extracted fact does to what is already on file.

Three outcomes per fact: it is new (ADD), it restates something already stored
(NOOP), or it replaces something that has stopped being true (SUPERSEDE). Only
the third touches an existing row, and even then it closes that row's validity
interval rather than editing it — the old text stays readable forever, which is
what makes "struggled with negative exponents in March, fluent in June" a
trajectory a later pass can read rather than a silent overwrite. Nothing in
this module deletes or rewrites an atom's text; there is no code path that can.

Why a model adjudicates and not a cosine threshold. "Understands fractions" and
"does not understand fractions" differ by one token and share every other one,
and every general-purpose embedding model puts them close together — measured
at 0.81-0.90 on `text-embedding-3-small`, which is what this service uses, and
0.93-0.97 on `text-embedding-ada-002`. A threshold over that number merges a
fact with its own negation, writes the merge into the learner's permanent
record, and leaves nothing behind to notice it by. So similarity is only ever
used here to choose *what the model is shown*: it narrows a growing table down
to `CANDIDATES` neighbours per new fact, and narrowing can only ever produce an
ADD where a SUPERSEDE might have been. That is the recoverable direction — a
duplicate sitting beside its original is visible and fixable next pass, while a
fact merged into its opposite is neither.

Both numbers are quoted because the gap between them is what shipped a silent
bug: `FLOOR` was set from the ada-002 scale and kept through the move to
`text-embedding-3-small`, where the same sentences score fifteen points lower.
Nothing failed. `_candidates` simply returned nothing, `_adjudicate` was never
called, and every supersession this module exists for became an ADD. Any number
in this file that came from a similarity has to be re-measured against the model
in `config.EMBEDDING_MODEL` when that constant changes.
"""

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import EXTRACTION_MODEL, get_settings
from app.memory.embed import embed_texts
from app.memory.schema import ExtractedAtom, MemoryCategory
from app.store.models import MemoryAtom

#: How many existing atoms to put in front of the adjudicator per new atom.
CANDIDATES = 8

#: Below this cosine similarity an existing atom is not worth a token. This is
#: a *cheap reject*, never a merge decision — see the module docstring: negation
#: sits close to its own affirmation, so no number in this file is ever allowed
#: to conclude that two facts are the same one.
#:
#: **Measured against `text-embedding-3-small` at 1024 dims, which is the only
#: model this number means anything for.** It was 0.75 — an ada-002 figure —
#: and on this model that admitted nothing at all: across a realistic 28-atom
#: learner store all 378 pairs scored p50 0.330, p99 0.664, max 0.711, and the
#: probe suite's own supersession pair ("cannot factor quadratics" / "factor
#: pairs now feel intuitive") scores 0.511. `_candidates` returned empty, so
#: `_adjudicate` was never called and every reversal in a learner's state was
#: written as a coexisting fact. `tests/eval/run_probes.py` is what caught it.
#:
#: Ranking was never the problem: in ten test supersessions the true target was
#: the nearest neighbour every time. What the floor has to do is admit it. At
#: 0.35 all ten are reachable with a mean of 7.7 candidates, and `CANDIDATES`
#: is the binding constraint below about 0.4 anyway — the eighth-nearest
#: neighbour sits at 0.30-0.47 — so lowering it further buys nothing.
#:
#: **Do not raise this above 0.45**, which is inside the observed range of true
#: pairs. And do not remove it: `if existing:` already covers an empty store,
#: but against a full one an unfloored top-8 always returns eight rows, and
#: eight unrelated facts in front of the adjudicator is an invitation to a
#: spurious SUPERSEDE — the direction that is not recoverable.
#:
#: Rejecting is otherwise safe in the way accepting would not be. An atom held
#: back here is never offered as a supersession target, so the worst it can cost
#: is an ADD where a SUPERSEDE was warranted — a visible duplicate, not a lost
#: fact. The same reasoning covers the rows the SQL comparison drops for a
#: different reason: an atom with no embedding, or with a zero one, yields NULL
#: or NaN for cosine distance, fails `<=`, and is left out. Both are cases where
#: the similarity number means nothing, and leaving them out is the conservative
#: reading of a number that means nothing.
FLOOR = 0.35

ADJUDICATION_SCHEMA: dict = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "ops": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "index": {"type": "integer"},
                    "op": {"type": "string", "enum": ["ADD", "SUPERSEDE", "NOOP"]},
                    "target": {"type": ["integer", "null"]},
                },
                "required": ["index", "op", "target"],
            },
        }
    },
    "required": ["ops"],
}

#: The header deliberately says only "from one session" and does not claim the
#: batch is newer than what is on file. It very nearly always is, but
#: `jobs.sweep_abandoned_sessions` documents the case where it is not: an
#: abandoned session swept months late is recorded behind the extraction
#: watermark, which that function allows on purpose and logs. Asserting recency
#: here would state a falsehood in exactly the case the dated SUPERSEDE rule
#: below exists to contain, and put two instructions in tension with the false
#: one first. The dates on `existing_facts` and that rule carry it alone.
ADJUDICATION_PROMPT = """\
You are deciding what to do with newly extracted facts about a learner, given \
facts already on file.

NEW FACTS, from one session:
{new_facts}

EXISTING FACTS, each dated with when it started being true:
{existing_facts}

For each new fact, by its index, choose exactly one:
- ADD: genuinely new information. target must be null.
- SUPERSEDE: it contradicts or replaces an existing fact. target is that \
existing fact's index. Use this when the learner's state has changed — "cannot \
factor quadratics" followed by "can factor quadratics" is a SUPERSEDE, not two \
coexisting facts. It always replaces an older fact with a newer one, so check \
the date: if the existing fact is dated after the events the new fact \
describes, the new one is not an update to it. Choose ADD and leave it standing.
- NOOP: it restates an existing fact with no new information. target must be null.

Read carefully for negation. Two sentences differing only by "not" are opposites, \
not duplicates."""


@dataclass(frozen=True)
class ConsolidationResult:
    """What one pass did, counted in rows rather than in atoms offered.

    `added` is INSERTs, `superseded` is existing rows whose interval this pass
    closed, `skipped` is atoms that produced no row at all. A SUPERSEDE counts
    in both of the first two, because it is an insert *and* a closure — the
    numbers do not partition the input, and reading them as if they did is the
    one way to misread this.
    """

    added: int
    superseded: int
    skipped: int


@lru_cache
def _client() -> AsyncOpenAI:
    """The one adjudication client, built on first use and then kept.

    Cached, and keeping the SDK's default retries, for the reasons
    `app/memory/extract.py` sets out: this is reached from a background pass
    rather than from inside a request handler, and there is no retry loop above
    it that a transport-level retry could defeat. Its own client rather than
    the extractor's so neither module's caching decision silently becomes the
    other's.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def _adjudicate(new_facts: str, existing_facts: str) -> str:
    """One request, one JSON document back. Raises whatever the provider raised.

    Nothing is caught here for the reason `extract._complete` gives: the caller
    is an offline pass, and a consolidation that fails should leave the episode
    unmarked so it can be run again. Swallowing the error would return no
    operations, `_decide` would default every atom to ADD, and the pass would
    write a batch of unadjudicated facts while reporting success.

    `store=False` for the same reason every other call in this service sets it:
    the body carries a learner's facts, and retention of those is a decision
    this service makes in its own database rather than one it leaves a second,
    unenumerable copy of on the provider's side.
    """
    response = await _client().responses.create(
        model=EXTRACTION_MODEL,
        input=[{"role": "user", "content": ADJUDICATION_PROMPT.format(
            new_facts=new_facts, existing_facts=existing_facts)}],
        text={"format": {"type": "json_schema", "name": "ops",
                         "schema": ADJUDICATION_SCHEMA, "strict": True}},
        store=False,
    )
    return response.output_text


def _decide(payload: str, *, n: int) -> list[tuple[str, int | None]]:
    """Always returns exactly `n` operations, one per atom, in order.

    A model that returns fewer ops than there were atoms must not silently drop
    the remainder — an omitted atom defaults to ADD, which is the
    non-destructive choice: the fact is kept and nothing on file is closed. A
    SUPERSEDE without an integer target is meaningless and degrades to ADD for
    the same reason, as does a payload that is not the JSON object this asked
    for. Malformed entries cost their own entry, never the batch.

    Targets are *not* range-checked here. `_decide` is given the atoms' count
    and not the candidates', so an index it cannot check is passed through
    verbatim for `consolidate` to judge against the list it actually built.
    """
    ops: list[tuple[str, int | None]] = [("ADD", None)] * n
    try:
        raw = json.loads(payload)
    except json.JSONDecodeError:
        return ops
    # A bare array — the shape a model reaches for when the wrapper object feels
    # redundant — has no `.get`, and this function's whole contract is that it
    # returns `n` operations rather than raising.
    if not isinstance(raw, dict):
        return ops
    entries = raw.get("ops")
    if not isinstance(entries, list):
        return ops
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        index = entry.get("index")
        # `isinstance` before the range test: a model can emit `"0"` or `null`
        # for an index, and comparing either against an int raises out of the
        # one function that must not. `bool` is an `int` in Python, so `True`
        # would otherwise index position 1 — a real op silently reassigned.
        if not isinstance(index, int) or isinstance(index, bool):
            continue
        if not 0 <= index < n:
            continue
        op = entry.get("op")
        target = entry.get("target")
        # Same hazard as `index` above, one line further on: `in` on a set
        # hashes its left operand, so an `op` of `["ADD"]` would raise TypeError
        # out of the function whose contract is that it never does.
        if not isinstance(op, str):
            continue
        if op in {"ADD", "NOOP"}:
            ops[index] = (op, None)
        elif op == "SUPERSEDE" and isinstance(target, int) and not isinstance(target, bool):
            ops[index] = ("SUPERSEDE", target)
    return ops


def normalised(text: str) -> str:
    """A fact's text reduced to what makes two of them the same *string*.

    Whitespace-collapsed and case-folded, and nothing more. This is string
    identity and never similarity — the distinction this whole module is
    about: turning "understands fractions" into "does not understand
    fractions" takes a similarity score, and no amount of case folding can do
    it. Shared with `dispatch._remember`, which needs the same key to keep the
    tutor's own writes from duplicating each other, and one definition so the
    two paths cannot disagree about what a duplicate is.
    """
    return " ".join(text.split()).casefold()


def _distinct(atoms: list[ExtractedAtom]) -> tuple[list[ExtractedAtom], int]:
    """Drop atoms this batch already contains, keeping the first of each.

    The adjudicator is shown the new facts against the *existing* ones and is
    never asked to compare the batch with itself, so one session yielding the
    same fact twice would have both told ADD and both written. They would then
    be two live rows saying the same thing forever: neither can supersede the
    other, because a later pass only ever compares new facts against them.

    The key is the text itself, through `normalised` above. Anything short of
    character-identical is left standing for the model to rule on next time it
    sees the two side by side.

    Category is part of the key, so one sentence filed two ways stays two atoms.
    The extractor can legitimately read "still guesses at negative exponents" as
    both a `skill_state` and a `misconception`, and keying on text alone would
    drop whichever came second along with its category.
    """
    seen: set[tuple[str, str]] = set()
    kept: list[ExtractedAtom] = []
    dropped = 0
    for atom in atoms:
        key = (normalised(atom.text), atom.category.value)
        if key in seen:
            dropped += 1
            continue
        seen.add(key)
        kept.append(atom)
    return kept, dropped


async def _candidates(
    db: AsyncSession, learner_id: uuid.UUID, vectors: list[list[float]]
) -> list[MemoryAtom]:
    """The live atoms worth putting in front of the adjudicator.

    One nearest-neighbour query per new fact rather than one query for the
    batch: each fact gets its own `CANDIDATES` neighbours, so a fact with many
    close relatives cannot crowd every other fact's evidence out of a shared
    limit. The results are pooled in first-seen order and de-duplicated by id,
    and a row's position in that pooled list is the index the model names when
    it returns a SUPERSEDE.

    Only live atoms are offered. A superseded row is already closed, and closing
    it again would overwrite the `superseded_by` pointer that records what
    replaced it the first time.

    `episode_ref` atoms are never offered, and that is a correctness rule
    rather than a saving. An episode record is a fact about a *session* and not
    a claim about the learner — `schema.STATED_EXEMPT` sets out the same
    reasoning for why it escapes the `stated` filter — so it cannot stop being
    true and there is nothing for a later fact to supersede. Superseding one
    anyway makes it unreachable everywhere at once: `profile._closed_atoms`
    only reads categories in `profile.ORDER`, which excludes `episode_ref`,
    while retrieval and the live-profile query both filter `valid_to IS NULL`.
    A closed episode atom is therefore read by nothing, forever. Their text is
    also the most formulaic in the store ("Covered adding fractions on
    2026-08-09"), so at `FLOOR = 0.35` two of them are exactly the pairs that
    now clear the floor and reach the adjudicator — dormant at 0.75, live now.
    """
    pooled: list[MemoryAtom] = []
    seen: set[uuid.UUID] = set()
    for vector in vectors:
        distance = MemoryAtom.embedding.cosine_distance(vector)
        rows = (await db.execute(
            select(MemoryAtom)
            .where(
                MemoryAtom.learner_id == learner_id,
                MemoryAtom.valid_to.is_(None),
                MemoryAtom.category != MemoryCategory.episode_ref.value,
                distance <= 1 - FLOOR,
            )
            .order_by(distance)
            .limit(CANDIDATES)
        )).scalars().all()
        for row in rows:
            if row.id not in seen:
                seen.add(row.id)
                pooled.append(row)
    return pooled


async def consolidate(
    db: AsyncSession,
    learner_id: uuid.UUID,
    atoms: list[ExtractedAtom],
    *,
    session_id: uuid.UUID | None,
    turn_ids: list[uuid.UUID],
    valid_from: datetime | None = None,
) -> ConsolidationResult:
    """Write a session's facts into the store, superseding what they replace.

    Flushes but does not commit: the caller owns the transaction, so a pass that
    consolidates and then marks the episode extracted does both or neither.

    `session_id` is nullable because `MemoryAtom.source_session_id` is — the
    citation is deliberately not a foreign key, and an atom whose session has
    been purged keeps the fact and loses the pointer.

    `valid_from` is when these facts *started being true*, which is when the
    session happened and not when this ran. It matters to any caller that can
    lag: an offline pass draining a backlog in June would otherwise stamp a
    March session's atoms with June, on the one axis whose entire job is to say
    when something was true. That also quietly weakens this module's own last
    line of defence — the `existing_facts` block below is dated from this
    column, and a backlog dated by the pass makes every fact look
    simultaneous. Left unset the column's `now()` stands, which is right for a
    caller writing a fact as the learner states it.
    """
    if not atoms:
        return ConsolidationResult(0, 0, 0)

    atoms, skipped = _distinct(atoms)

    vectors = await embed_texts([atom.text for atom in atoms])
    # `embed_texts` documents that it raises rather than returning a short list,
    # but it never checks the length it got back, and the `zip` below pairs
    # positionally — one vector short would silently drop the trailing atoms and
    # report success. Checked here because this is the caller that depends on it.
    #
    # `raise AssertionError` and not `assert`: both invariants below guard
    # against writing a permanently invisible row, and `assert` is compiled out
    # under `PYTHONOPTIMIZE`/`python -O`. Nothing in this repo runs with it
    # today, but a base image that sets it would silently remove the two checks
    # that stop a lost fact, and the removal would look like nothing at all.
    if len(vectors) != len(atoms):
        raise AssertionError(
            f"embed_texts returned {len(vectors)} vectors for {len(atoms)} atoms"
        )
    # Every row this writes must carry a real embedding, and this is where that
    # invariant is enforced. `_candidates` selects on cosine distance, which a
    # NULL or empty embedding fails, so such a row is not merely skipped this
    # pass — it can never be offered as a supersession target again, and
    # `retrieve`'s dense arm cannot rank it either. That is permanent, not
    # conservative. Its keyword arm can still find the row by its words, which
    # is a way back to the fact and not a way back into consolidation.
    if not all(vectors):
        raise AssertionError("embed_texts returned an empty vector")

    existing = await _candidates(db, learner_id, vectors)

    if existing:
        new_facts = "\n".join(
            f"{i}. [{atom.category}] {atom.text}" for i, atom in enumerate(atoms)
        )
        # Dated, because the SUPERSEDE rule turns on which way time runs and the
        # model cannot see that from the sentences. Live, this is redundant with
        # the batch being newer; walking a backlog out of order it is the only
        # thing standing between "the learner's state changed" and a fact from
        # March closing one from June.
        existing_facts = "\n".join(
            f"{i}. ({row.valid_from:%Y-%m-%d}) [{row.category}] {row.text}"
            for i, row in enumerate(existing)
        )
        ops = _decide(await _adjudicate(new_facts, existing_facts), n=len(atoms))
    else:
        # Nothing on file within reach to restate or contradict, so every fact
        # is new by construction. Skipping the call is not only cheaper: with no
        # candidates to name, any SUPERSEDE that came back could only point at
        # an index that does not exist, and asking a question whose every
        # non-ADD answer is unusable is how a made-up target gets a chance to
        # matter.
        ops = [("ADD", None)] * len(atoms)

    now = datetime.now(timezone.utc)
    added = superseded = 0
    for atom, vector, (op, target) in zip(atoms, vectors, ops):
        if op == "NOOP":
            skipped += 1
            continue
        row = MemoryAtom(
            learner_id=learner_id,
            text=atom.text,
            category=atom.category.value,
            # Any other code path that inserts a `MemoryAtom` must embed it too.
            # A row written with a NULL embedding is invisible to consolidation
            # from the moment it lands — permanently, and with nothing anywhere
            # to notice it by — and reachable in retrieval only by its exact
            # words, never by meaning. See the empty-vector check above.
            embedding=vector,
            source_session_id=session_id,
            source_turn_ids=turn_ids,
            # Carried verbatim, never coerced. `stated` records who the fact
            # came from, and an `episode_ref` legitimately arrives False (see
            # `schema.STATED_EXEMPT`) — defaulting it to True here would give
            # the tutor's own observation a learner statement's authority.
            stated=atom.stated,
        )
        # Assigned rather than passed to the constructor, so a caller with no
        # opinion leaves the column's server-side `now()` in place instead of
        # being handed a Python clock that is nearly but not quite it.
        if valid_from is not None:
            row.valid_from = valid_from
        db.add(row)
        # Flushed inside the loop so `row.id` exists for the `superseded_by`
        # pointer written immediately below it.
        await db.flush()
        added += 1

        if op != "SUPERSEDE":
            continue
        # A target the adjudicator invented — out of range, or negative — closes
        # nothing, and the atom stands as a plain ADD. Guessing which candidate
        # was meant, or clamping the index into range, would close a row chosen
        # by arithmetic on a number the model made up; a wrongly closed atom
        # drops out of every live query from then on and nothing downstream can
        # tell it apart from one that genuinely stopped being true. Raising
        # would be worse still: it would abandon the atoms in the same batch
        # that were fine, and this runs unattended over a backlog.
        if target is None or not 0 <= target < len(existing):
            continue
        old = existing[target]
        # Two atoms in one batch can name the same target — the adjudicator is
        # not asked to keep its answers consistent with each other. The first
        # closure stands and later ones are ignored, because re-closing would
        # overwrite `superseded_by` and lose the record of what actually
        # replaced this row. The second atom is still written; it just does not
        # get to claim a succession that is already spoken for.
        if old.valid_to is not None:
            continue
        old.valid_to = now
        old.invalidated_at = now
        old.superseded_by = row.id
        superseded += 1

    return ConsolidationResult(added, superseded, skipped)
