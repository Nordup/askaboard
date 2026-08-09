"""The portrait a turn reads: the atoms synthesized, not pasted.

N retrieved rows dropped into a prompt read as a dossier. What makes a tutor
sound like it knows the person is a few sentences that have already decided
what matters — so the atoms are the record and this is the reading of them,
regenerated wholesale on every rebuild and never edited in place. That is the
entire deletion story too: drop an atom, rebuild, and it is gone from here as
well, because there is no state in this table that was not derived from the
atoms this run could see.

Superseded atoms are fed in beside the live ones, fenced off and dated. They
are the only reason the store is bi-temporal at all: "was stuck on negative
exponents in March, fluent by June" cannot be written from the live set, since
the March fact is precisely what supersession closed. Everything else in this
service reads live atoms alone — retrieval answers what is the case *now* — so
this is the one reader the closed rows have, and the shape they arrive in is
load-bearing rather than cosmetic. A closed fact that reads as current is worse
than one that is never read at all, which is what the second block, its
heading, and the date on every one of its lines are all guarding against.
"""

import uuid
from collections import OrderedDict
from collections.abc import Callable, Iterable
from functools import lru_cache

from openai import AsyncOpenAI
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.config import EXTRACTION_MODEL, get_settings
from app.store.models import LearnerProfile, MemoryAtom

#: Rendering order, and the whole of what a portrait is made of.
#:
#: Fixed rather than incidental, and the reason is one step removed from this
#: file. Reordering the facts changes the prose the model writes from them, and
#: that prose — `LearnerProfile.body` — is what a later task pastes into the
#: cached prompt prefix every turn reads. So a rebuild over an unchanged store
#: reordering two lines is not free: it rewrites the body, and the body moving
#: invalidates the prefix. `_group` and the ORDER BY in both queries exist to
#: make the input to that model call a function of the atoms and nothing else.
#:
#: `episode_ref` is deliberately absent. Those atoms record what a session
#: covered rather than anything about the person, and `retrieve.recent_episodes`
#: already answers "what have we been doing lately" in date order. That makes
#: this tuple `models.MEMORY_CATEGORIES` minus one member and not a list in its
#: own right — `test_the_portrait_covers_every_category_but_episodes` is what
#: notices when a seventh category is added to the vocabulary and not to here.
ORDER: tuple[str, ...] = (
    "context", "goal", "preference", "skill_state", "misconception",
)

#: How many closed atoms the trajectory may be drawn from, most recently closed
#: first. Live atoms are unbounded — they *are* the portrait — but closed ones
#: accumulate forever, so uncapped, a store with years behind it would send
#: everything it had ever believed on every rebuild.
#:
#: A count and not an age window. A window would change what is rendered as the
#: clock moves with no atom having changed, which is the churn `ORDER` above
#: exists to avoid.
HISTORY = 30

_LIVE_HEADING = "CURRENTLY TRUE"
_HISTORY_HEADING = "NO LONGER TRUE (history, for narrating change only)"

SYNTHESIS_PROMPT = """\
Write a compact portrait of this learner for a maths tutor who is about to \
teach them and has never met them.

Address the learner as "you" throughout — "you are working towards", "you \
prefer", "you get stuck on". Never write about them in the third person and \
never call them "the learner". The tutor is the one who reads this, but a note \
written to someone reads as knowing them; the same facts written about someone \
read as a case file, and a tutor who has been handed a case file teaches like \
it. Nothing below records this learner's name or pronouns, so third person \
cannot say "you like X" without first inventing who X is liked by.

Use these section headings, omitting any with nothing to say: Context, Goals, \
How you learn, What you can do, Where you get stuck.

Write flowing prose inside each section, not bullet lists. Do not invent \
anything that is not below. Keep the whole thing under 350 words.

Write any maths in plain Unicode text — h, v, x² + y², √2, a/b — and never in \
LaTeX delimiters. This body is quoted verbatim into the tutor's own prompt, \
where the same rule holds because the chat renderer does not render LaTeX, so \
a delimiter written here is one the tutor has seen modelled before it writes.

Everything under CURRENTLY TRUE holds now: write it in the present tense, and \
where one of those lines carries a month, keep it — "as of June" tells the \
tutor how much to trust it.

A NO LONGER TRUE block may follow. Those facts stopped holding on the second \
date their line gives. Never write one as though it still holds, and never date \
the learner by one: neither date on those lines says anything about now. Each \
one names the fact that replaced it after "replaced by", so use that pairing \
rather than hunting for one — "was stuck on negative exponents in March, \
handles them now". Drop any whose replacement adds nothing worth a sentence.

{facts}"""


@lru_cache
def _client() -> AsyncOpenAI:
    """The one synthesis client, built on first use and then kept.

    Cached, and keeping the SDK's default retries, for the reasons
    `app/memory/extract.py` sets out. Its own client rather than that module's
    so neither one's caching decision silently becomes the other's.
    """
    return AsyncOpenAI(api_key=get_settings().openai_api_key)


async def _synthesize(facts: str) -> str:
    """One request, prose back. Raises whatever the provider raised.

    No structured output here, unlike every other model call in this package:
    the product is a paragraph a tutor reads, and a schema over it would be a
    wrapper whose only job is to be unwrapped.

    Nothing is caught, and that is what makes a failed rebuild safe: the write
    below happens only after this returns, so the previous portrait stays in
    place. A stale portrait is a worse-informed tutor; a blanked one is a tutor
    that has forgotten the learner.

    `store=False` for the reason `app/memory/extract.py` gives at length — the
    body carries a learner's facts, and this service keeps the only copy of
    those on purpose.
    """
    response = await _client().responses.create(
        model=EXTRACTION_MODEL,
        input=[{"role": "user", "content": SYNTHESIS_PROMPT.format(facts=facts)}],
        store=False,
    )
    return response.output_text.strip()


def _group(atoms: Iterable[MemoryAtom]) -> "OrderedDict[str, list[MemoryAtom]]":
    """Atoms bucketed under `ORDER`, keeping the order they arrived in.

    Every key is present even when it is empty, so a caller walks one fixed
    sequence of categories whatever the learner happens to have on file.
    Anything outside `ORDER` is dropped.
    """
    grouped: OrderedDict[str, list[MemoryAtom]] = OrderedDict(
        (category, []) for category in ORDER
    )
    for atom in atoms:
        if atom.category in grouped:
            grouped[atom.category].append(atom)
    return grouped


def _live_line(atom: MemoryAtom) -> str:
    return f"- [{atom.category}] (since {atom.valid_from:%Y-%m-%d}) {atom.text}"


def _history_line(atom: MemoryAtom, replacement: str) -> str:
    """A closed fact, stamped with the window it was true in and what took over.

    Two things are spelled out here that the heading above already implies, and
    both are deliberate. The status, because the reader is a model working down
    a list and a heading is one line it can lose thirty lines later — what that
    costs is a fact the learner has moved past being taught back to them as
    current. And the replacement, because the pairing is the whole point of
    showing a closed fact at all: `superseded_by` records exactly which fact
    replaced this one, and leaving it out would have the model rediscover by
    resemblance something the database already knows — reliably enough for
    quadratics, a coin flip for a subtler pair.
    """
    return (f"- [{atom.category}] (was true {atom.valid_from:%Y-%m-%d} to "
            f"{atom.valid_to:%Y-%m-%d}, no longer) {atom.text} "
            f"— replaced by: {replacement}")


def _block(
    heading: str, atoms: Iterable[MemoryAtom], line: Callable[[MemoryAtom], str]
) -> str:
    return "\n".join([heading, *(line(atom) for group in _group(atoms).values()
                                 for atom in group)])


def _render(
    live: list[MemoryAtom], historical: list[tuple[MemoryAtom, str]]
) -> str:
    """The facts block, in the shape the prompt describes.

    `historical` is each closed atom paired with the text of the atom that
    replaced it, as `_closed_atoms` returns them.

    An empty history block is omitted rather than rendered under its heading: a
    heading with nothing beneath it is an invitation to fill it, and the one
    thing this block must never do is put words in the learner's past.
    """
    blocks = [_block(_LIVE_HEADING, live, _live_line)]
    if historical:
        replacements = {atom.id: text for atom, text in historical}
        blocks.append(_block(
            _HISTORY_HEADING,
            [atom for atom, _ in historical],
            lambda atom: _history_line(atom, replacements[atom.id]),
        ))
    return "\n\n".join(blocks)


async def _live_atoms(db: AsyncSession, learner_id: uuid.UUID) -> list[MemoryAtom]:
    """What is true of the learner now, in render order.

    `valid_from` then `id`, and the tiebreak is not decoration: every atom one
    consolidation pass writes shares a single `now()` — Postgres reads the clock
    once per transaction — so ties are the normal case rather than the corner
    one, and without `id` the order of a whole session's facts would be whatever
    the planner felt like on the day.
    """
    return list((await db.execute(
        select(MemoryAtom)
        .where(MemoryAtom.learner_id == learner_id,
               MemoryAtom.valid_to.is_(None),
               MemoryAtom.category.in_(ORDER))
        .order_by(MemoryAtom.valid_from, MemoryAtom.id)
    )).scalars().all())


async def _closed_atoms(
    db: AsyncSession, learner_id: uuid.UUID
) -> list[tuple[MemoryAtom, str]]:
    """The most recently closed atoms, each with the fact that replaced it.

    The join to the successor is inner, which is also the filter: superseded
    specifically, not merely closed. A row closed with nothing pointing at it is
    a retraction — something decided to have never been true — and offering that
    as the learner's past would revive a fact on the grounds that we withdrew
    it. It drops out here for free rather than needing a clause of its own.
    `valid_to` still gets one, because the rendered line prints that date.

    The category filter belongs in the query and not only in `_group`: `HISTORY`
    caps rows, so a row that rendering would drop must not be allowed to spend
    one of them.

    Ordered by closing date to decide which survive the cap, then sorted back
    onto the key `_live_atoms` uses so both blocks read the same way round.
    """
    successor = aliased(MemoryAtom)
    rows = (await db.execute(
        select(MemoryAtom, successor.text)
        .join(successor, MemoryAtom.superseded_by == successor.id)
        .where(MemoryAtom.learner_id == learner_id,
               MemoryAtom.valid_to.is_not(None),
               MemoryAtom.category.in_(ORDER))
        .order_by(desc(MemoryAtom.valid_to), desc(MemoryAtom.id))
        .limit(HISTORY)
    )).all()
    return sorted(((atom, text) for atom, text in rows),
                  key=lambda pair: (pair[0].valid_from, pair[0].id))


async def rebuild_profile(db: AsyncSession, learner_id: uuid.UUID) -> str:
    """Rewrite this learner's portrait from their atoms. Returns the new body.

    Neither flushes nor commits: the caller owns the transaction, the way
    `consolidate` does, so a pass that consolidates and then rebuilds writes
    both or neither.
    """
    live = await _live_atoms(db, learner_id)
    if not live:
        # Nothing to be the present tense of, so there is no portrait — and the
        # stored one goes with it. A body outliving every fact it was built
        # from is a copy of deleted facts sitting in a second table, which is
        # the failure "regenerated, never edited" exists to make impossible.
        if (stale := await db.get(LearnerProfile, learner_id)) is not None:
            await db.delete(stale)
        return ""

    historical = await _closed_atoms(db, learner_id)
    body = await _synthesize(_render(live, historical))

    # Live and historical together: `atom_count` records what the body was made
    # from. Provenance for whoever reads the row, and deliberately not a change
    # detector. Once history is at `HISTORY` a supersession adds a live row and
    # pushes a closed one off the end for a net zero, and any pass that deletes
    # as many atoms as it writes does the same at any size — a portrait rewritten
    # end to end, under an unmoved number.
    count = len(live) + len(historical)
    row = await db.get(LearnerProfile, learner_id)
    if row is None:
        db.add(LearnerProfile(learner_id=learner_id, body=body, atom_count=count))
    else:
        row.body = body
        row.atom_count = count
    return body


async def current_profile(db: AsyncSession, learner_id: uuid.UUID) -> str | None:
    """The stored portrait, or None if this learner has none.

    None is the honest answer for both learners without one: the one nothing has
    been built for yet, and the one whose atoms have all been deleted — a
    rebuild with nothing live removes the row rather than leaving an empty body
    behind.
    """
    row = await db.get(LearnerProfile, learner_id)
    return row.body if row else None
