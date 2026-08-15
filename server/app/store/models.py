from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import (
    Boolean, CheckConstraint, Computed, DateTime, Float, ForeignKey, Index, Integer,
    String, Text, UniqueConstraint, false, func, text as sa_text, true,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, TSVECTOR, UUID as PGUUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    type_annotation_map = {dict: JSONB, datetime: DateTime(timezone=True)}


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = _uuid_pk()
    model: Mapped[str] = mapped_column(String(64))
    reasoning_effort: Mapped[str] = mapped_column(String(16))
    plan: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    exercise: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )

    messages: Mapped[list[Message]] = relationship(back_populates="session")
    turns: Mapped[list[Turn]] = relationship(back_populates="session")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = _uuid_pk()
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sessions.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))
    text: Mapped[str] = mapped_column(Text)
    signal: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    #: Generated rather than maintained by the application, for the reason
    #: `MemoryAtom.fts` gives: `search_history` needs a tsvector on every row,
    #: and a GENERATED column cannot drift out of sync with `text` the way a
    #: trigger or an application write can. This is what makes the founder
    #: principle — nothing in the history is unreachable — a query rather than
    #: an aspiration: every stored utterance is full-text searchable forever.
    fts: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', text)", persisted=True)
    )

    session: Mapped[Session] = relationship(back_populates="messages")

    __table_args__ = (
        Index("ix_messages_fts", "fts", postgresql_using="gin"),
    )


class Turn(Base):
    __tablename__ = "turns"

    # Client-generated, which is what makes the turn idempotent.
    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("sessions.id"), index=True)
    status: Mapped[str] = mapped_column(String(16))  # running | ok | error
    model: Mapped[str] = mapped_column(String(64))
    reasoning_effort: Mapped[str] = mapped_column(String(16))
    ttft_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: How much of `input_tokens` the provider served from its prompt cache,
    #: and how much this turn wrote into it.
    #:
    #: Their own columns rather than a read of `llm_calls.usage`, because they
    #: are the only measurement of whether the prompt's whole static-first
    #: layout is working. A prefix that quietly stopped matching — a block that
    #: moved, a tool set that varied, a session that idled past the cache's
    #: lifetime — costs ten times what it should and looks, in `input_tokens`
    #: alone, exactly like a prefix that never stopped matching.
    cached_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    error: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)

    session: Mapped[Session] = relationship(back_populates="turns")


class LLMCall(Base):
    __tablename__ = "llm_calls"

    id: Mapped[uuid.UUID] = _uuid_pk()
    turn_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("turns.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    model: Mapped[str] = mapped_column(String(64))
    request: Mapped[dict] = mapped_column(JSONB)
    response: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    raw_events_blob: Mapped[str | None] = mapped_column(String(128), nullable=True)
    usage: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


class ToolCall(Base):
    __tablename__ = "tool_calls"

    id: Mapped[uuid.UUID] = _uuid_pk()
    turn_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("turns.id"), index=True)
    llm_call_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("llm_calls.id"))
    name: Mapped[str] = mapped_column(String(64))
    arguments: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    result: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(nullable=True)


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # Nullable because a dictation has no turn yet — the audio is captured
    # before the transcript becomes a message, let alone a turn_id, which is
    # only minted client-side when the student hits Send. Exactly one of
    # turn_id/session_id is expected to be set; Recorder.record_attachment is
    # what enforces that at write time (see store/recorder.py).
    turn_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("turns.id"), nullable=True, index=True
    )
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sessions.id"), nullable=True, index=True
    )
    # board_png (a region the learner marqueed and sent) | board_full (the whole
    # board, uploaded every turn so the tutor can crop it with `view_board`) |
    # ink | audio | learner_upload (a file the learner attached in the composer).
    # The first two are kept apart on purpose — see BOARD_KIND.
    kind: Mapped[str] = mapped_column(String(16))
    blob_key: Mapped[str] = mapped_column(String(128))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    bytes: Mapped[int] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Describes the blob at `blob_key` — the bytes as they arrived — and never
    #: what they were converted into. For a `learner_upload` that distinction is
    #: the whole point of the column: what the model actually read is
    #: `converted_content_type`, two lines down.
    content_type: Mapped[str] = mapped_column(String(64))
    # The five below are `learner_upload`'s alone, and null for every other
    # kind. An upload is the one attachment that arrives named, that may need
    # converting before a model can read it, and that a later turn refers to by
    # id — so it is the one that has to remember what it was called, what it
    # became, and what it looks like.
    filename: Mapped[str | None] = mapped_column(String(255), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: The bytes the model actually saw. Equal in content to `blob_key` when
    #: the file needed no conversion, and the blob store is content-addressed,
    #: so that case costs one blob rather than two.
    converted_blob_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    converted_content_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    thumbnail_blob_key: Mapped[str | None] = mapped_column(String(128), nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class RealtimeUsage(Base):
    """One voice response's token bill, as reported by the device.

    The realtime call runs WebRTC device↔OpenAI; the server is only the SDP
    proxy and never sees the data channel, so the only party holding the
    `response.done` usage events is the iPad. It reports each response's
    counts to `POST /v1/realtime/usage`, and this row is what makes voice
    spend visible to `spend_today()` — before it, a day that was ~$4.70 of
    voice counted as $0.00 against the daily cap.

    Input counts are per modality (audio and text bill an order of magnitude
    apart), and each cached count is a subset of its input total, the same
    relationship `Turn.cached_tokens` has to `Turn.input_tokens`.
    """

    __tablename__ = "realtime_usage"

    #: Client-generated, which is what makes a retried report idempotent —
    #: the same pattern, for the same reason, as `Turn.id`.
    id: Mapped[uuid.UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True)
    #: The learning session the call belonged to. Deliberately *not* a foreign
    #: key: sessions are created lazily by the first turn, and a voice call
    #: can start — and bill — before any turn exists. A report must never be
    #: refused because the session row is not there yet.
    session_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True, index=True)
    #: The provider's response id, for tracing a row back to the transcript.
    #: Diagnostic only — idempotency rides on `id`.
    response_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    #: Which price sheet the row was billed against — the model the call
    #: actually ran on, as the device reported it, checked against
    #: REALTIME_MODEL_ALLOWLIST. It falls back to `Settings.openai_realtime_model`
    #: when a report names none. Was server-chosen outright until the `Voice
    #: model` setting shipped (2026-08-16); the invariant that survives is the
    #: one that mattered — the device names a model from a priced menu, never a
    #: price, and every allowlisted model must carry a row in
    #: REALTIME_PRICES_PER_1M or the server refuses to boot.
    model: Mapped[str] = mapped_column(String(64))
    audio_input_tokens: Mapped[int] = mapped_column(Integer)
    cached_audio_input_tokens: Mapped[int] = mapped_column(Integer)
    audio_output_tokens: Mapped[int] = mapped_column(Integer)
    text_input_tokens: Mapped[int] = mapped_column(Integer)
    cached_text_input_tokens: Mapped[int] = mapped_column(Integer)
    text_output_tokens: Mapped[int] = mapped_column(Integer)
    #: Priced at write time from `config.REALTIME_PRICES_PER_1M`; NULL when
    #: the model has no price row, which is a visible gap, not a zero.
    cost_usd: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Learner(Base):
    """The person the memory is about.

    There is exactly one row — `config.SOLE_LEARNER_ID`, seeded by migration
    0003. The table earns its place anyway: with it, every memory row carries
    a real foreign key from the first commit, so a second learner later is an
    INSERT rather than a schema change and a backfill of every derived table.
    """

    __tablename__ = "learners"

    id: Mapped[uuid.UUID] = _uuid_pk()
    display_name: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Episode(Base):
    """One recorded window of a session. Ground truth for every derived row.

    A window, not a whole session, because the device reopens the same session
    across days: one-episode-per-session froze the transcript at the first
    close and silently dropped everything after it, forever. An episode now
    covers the message range `seq_from..seq_to`, and the next close or sweep
    records the *next* range as its own episode. A mid-session close therefore
    costs nothing — it freezes only its window, and later activity forms the
    next one.

    `seq_from`/`seq_to` are 1-based message ordinals, not `messages.seq`
    values. `messages.seq` is 0-based and dense (both write paths count from
    zero), so an episode covers the messages whose `seq` lies in
    `[seq_from - 1, seq_to - 1]`, and a full-session episode reads
    `seq_from=1, seq_to=message_count` — which is exactly how migration 0007
    backfilled the episodes recorded under the old one-per-session rule.

    Atoms, the profile and the learner model are all rebuildable from this
    plus `observations` alone. Nothing here is ever rewritten except the
    summary columns, which are derived from `transcript` and safe to
    regenerate: a bad summarization prompt is a recoverable mistake — clear
    `narrative`, let the backfill pass re-summarize the same transcripts.

    `transcript` is denormalised out of `messages` on purpose. It is the exact
    text the extractor was shown, frozen at close time, so a later change to
    how messages are rendered cannot retroactively alter what an atom claims
    to have been derived from.
    """

    __tablename__ = "episodes"

    id: Mapped[uuid.UUID] = _uuid_pk()
    learner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learners.id", name="fk_episodes_learner"), index=True
    )
    #: Which session this was, but deliberately *not* a foreign key. This table
    #: is what everything else is rebuilt from, so its durability must not be
    #: bounded by the lifetime of `sessions`: purging a session should cost the
    #: back-reference, not the episode and every atom derived from it. Same
    #: reasoning as MemoryAtom.source_session_id, with more at stake.
    session_id: Mapped[uuid.UUID] = mapped_column(index=True)
    #: The window this episode covers, in 1-based message ordinals — see the
    #: class docstring for the mapping onto `messages.seq`. The defaults
    #: (`1, 0`) describe an empty window and are never what a recorded row
    #: carries; `jobs._record_episode` always sets both explicitly.
    seq_from: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    seq_to: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    transcript: Mapped[str] = mapped_column(Text)
    #: The first two sentences of `narrative`, kept for compatibility until the
    #: backfill pass has re-summarized every pre-window episode — readers that
    #: paste short dated lines still have something short to paste.
    digest: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: The rich summary, written together by one structured summarization call.
    #: `narrative` is the load-bearing one: 150-300 tokens, required to carry
    #: exact details — problem statements, numbers, formulas reached, mistakes
    #: made, what was resolved — because "gist right, details wrong" is the
    #: failure a two-sentence digest was measured producing.
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    narrative: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Open loops, as a JSONB list of strings ("agreed: derive from collisions
    #: step by step next time") — what the next session should pick up.
    next_steps: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    topics: Mapped[list[str] | None] = mapped_column(ARRAY(Text), nullable=True)
    #: Embedding of title + narrative, the dense arm of `search_sessions` and
    #: nothing else — atoms keep their own. 1024 for the reason
    #: `MemoryAtom.embedding` spells out.
    narrative_embedding: Mapped[list[float] | None] = mapped_column(
        HALFVEC(1024), nullable=True
    )
    message_count: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime]
    closed_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    #: NULL means "not yet extracted". The backlog is a column rather than a
    #: queue because the queue would be a second thing to keep consistent with
    #: this table, and a crashed extraction has to be safe to simply re-run.
    extracted_at: Mapped[datetime | None] = mapped_column(nullable=True)
    #: How many times extraction (or backfill re-summarization) has failed on
    #: this row. At `jobs.QUARANTINE_AFTER` the row is quarantined —
    #: `quarantined_at` set, the drain continues past it — because one poison
    #: episode used to halt the whole backlog permanently, and the only symptom
    #: was the tutor going vague. `/health` reports the quarantined count.
    extraction_attempts: Mapped[int] = mapped_column(
        Integer, default=0, server_default="0"
    )
    quarantined_at: Mapped[datetime | None] = mapped_column(nullable=True)

    __table_args__ = (
        # One episode per message window. `extracted_at` is per-episode, so a
        # duplicate row would be extracted a second time and double every atom
        # derived from it; two closes racing over the same window compute the
        # same `seq_from` and the loser hits this, which is what lets the close
        # path be a plain retry. Distinct windows of one session share the
        # session_id and differ on seq_from, so they all fit.
        UniqueConstraint("session_id", "seq_from", name="uq_episodes_session_window"),
    )


#: The vocabulary an extracted atom may be filed under. Lives here rather than
#: only in the extractor's prompt because the database enforces it (see
#: `ck_memory_atoms_category`) and the prompt should be generated from the same
#: tuple the constraint is built from — a prompt that can offer a value the
#: column rejects is a silently dropped atom.
MEMORY_CATEGORIES: tuple[str, ...] = (
    "preference", "goal", "context", "skill_state", "misconception", "episode_ref",
)
_CATEGORY_CHECK = "category IN ({})".format(
    ", ".join(f"'{category}'" for category in MEMORY_CATEGORIES)
)


class MemoryAtom(Base):
    """One self-contained fact. Superseded, never overwritten.

    Four timestamps on two independent axes. `valid_from`/`valid_to` are when
    the fact was true of the learner; `ingested_at`/`invalidated_at` are when
    we believed it. Keeping both is what lets "struggled with negative
    exponents in March, fluent in June" be a trajectory rather than a
    destructive update — and lets us tell a fact that stopped being true from
    one that was never true and had to be retracted.
    """

    __tablename__ = "memory_atoms"

    id: Mapped[uuid.UUID] = _uuid_pk()
    learner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learners.id", name="fk_atoms_learner"), index=True
    )
    text: Mapped[str] = mapped_column(Text)
    #: One of MEMORY_CATEGORIES, enforced by `ck_memory_atoms_category`. A
    #: constrained string rather than a Postgres ENUM: widening the set is then
    #: one ALTER of a constraint rather than a type change, but the column is
    #: still written by an LLM extractor, and without the CHECK a single typo
    #: in a model's output would quietly become a seventh category that every
    #: later query silently fails to match.
    category: Mapped[str] = mapped_column(String(16), index=True)
    #: halfvec rather than vector: half precision costs ~nothing in recall at
    #: this scale and halves both the row and the index. 1024 must stay in
    #: step with config.EMBEDDING_DIMS — it is spelled out rather than imported
    #: because changing the constant cannot retype an existing column, so the
    #: two only ever move together through a migration.
    embedding: Mapped[list[float] | None] = mapped_column(HALFVEC(1024), nullable=True)

    valid_from: Mapped[datetime] = mapped_column(server_default=func.now())
    valid_to: Mapped[datetime | None] = mapped_column(nullable=True)
    ingested_at: Mapped[datetime] = mapped_column(server_default=func.now())
    invalidated_at: Mapped[datetime | None] = mapped_column(nullable=True)
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("memory_atoms.id", name="fk_atoms_superseded_by"), nullable=True
    )

    #: Provenance. Deliberately not a foreign key to `sessions`/`turns`: an
    #: atom outlives the rows it came from, and a session purge should cost
    #: the citation, not the fact.
    source_session_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    source_turn_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(PGUUID(as_uuid=True)), server_default="{}"
    )
    #: True when the learner said it, False when the tutor inferred it. The
    #: default is True in both Python and the database so that an atom which
    #: arrives without an opinion is never quietly demoted to a guess.
    stated: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    #: True for a note the learner explicitly asked to have remembered — the
    #: `remember` tool's writes. Explicit notes are injected wholesale into the
    #: SAVED NOTES block rather than similarity-gated, and consolidation never
    #: offers them as supersession targets (`consolidate._candidates`): a later
    #: extraction quietly closing a note the learner dictated is the one
    #: failure that saved note must be structurally incapable of. Only the
    #: `forget` tool closes one. Default False in both Python and the database
    #: so every extraction-path atom stays an ordinary, supersedable fact.
    explicit: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    #: Generated rather than maintained by the application: hybrid retrieval
    #: needs a tsvector on every row, and a GENERATED column cannot drift out
    #: of sync with `text` the way a trigger or an application write can.
    #: SQLAlchemy knows a Computed column is read-only and leaves it out of
    #: INSERTs, so nothing here ever writes it.
    fts: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', text)", persisted=True)
    )

    __table_args__ = (
        CheckConstraint(
            _CATEGORY_CHECK, name="ck_memory_atoms_category",
        ),
        Index("ix_memory_atoms_fts", "fts", postgresql_using="gin"),
        # Retrieval only ever wants live atoms, so the index only holds them:
        # superseded rows accumulate forever and would otherwise bloat every
        # lookup that will never look at them.
        Index(
            "ix_memory_atoms_live",
            "learner_id",
            "category",
            postgresql_where=sa_text("valid_to IS NULL"),
        ),
    )


class LearnerProfile(Base):
    """The rendered profile a turn actually reads, cached per learner.

    Purely derived — recomputable from the learner's atoms — which is why the
    learner id is also the primary key: a rebuild replaces the single row
    instead of appending a version nobody would read. `atom_count` records how
    many atoms the body was built from; `app/memory/profile.py` says what that
    number is and is not good for.
    """

    __tablename__ = "learner_profiles"

    learner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learners.id", name="fk_profiles_learner"), primary_key=True
    )
    body: Mapped[str] = mapped_column(Text)
    atom_count: Mapped[int] = mapped_column(Integer)
    #: `onupdate` as well as the default, because a rebuild rewrites this row
    #: rather than inserting one — without it the column would keep saying when
    #: the profile was first built and never when it last was.
    rebuilt_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now()
    )


class KC(Base):
    """One Common Core standard, used as a concept identifier.

    Not authored here: ~480 public, stable, human-meaningful ids that every
    model already recognizes, which is why the annotator can name them
    without being taught a private vocabulary.
    """

    __tablename__ = "kcs"

    id: Mapped[uuid.UUID] = _uuid_pk()
    #: `7.RP.A.2`, `K.CC.B.4.a`, `HSA-APR.D.6`. Unique because it, not the
    #: surrogate id, is what every other layer names a concept by: the seed
    #: reconciles on it, and an annotator only ever emits codes.
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    title: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text)
    #: 'K', '1'…'8', 'HS' — the publisher's own banding, kept as text because
    #: 'K' and 'HS' are not numbers and ordering by grade is not what it is for.
    grade: Mapped[str] = mapped_column(String(8))


#: 'prerequisite' is directed, prereq -> kc, and is the only kind traversal may
#: follow. 'related' is an undirected association between two standards that
#: illuminate each other; it carries no ordering, so walking it as a dependency
#: would invent an ordering the source never claimed. Stored one row per pair,
#: with the endpoints code-ordered, so a reader must match on either column.
KC_EDGE_KINDS: tuple[str, ...] = ("prerequisite", "related")
PREREQUISITE = "prerequisite"
_EDGE_KIND_CHECK = "kind IN ({})".format(
    ", ".join(f"'{kind}'" for kind in KC_EDGE_KINDS)
)


class KCEdge(Base):
    """An arc of the concept graph. See KC_EDGE_KINDS for what an arc means."""

    __tablename__ = "kc_edges"

    prereq_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("kcs.id", name="fk_edges_prereq"), primary_key=True
    )
    kc_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("kcs.id", name="fk_edges_kc"), primary_key=True
    )
    #: Part of the primary key: the same two standards can be both a
    #: prerequisite pair and a related pair, and those are two separate facts.
    kind: Mapped[str] = mapped_column(String(16), primary_key=True)

    __table_args__ = (
        # Every traversal filters on kind, so an unconstrained typo would not
        # fail anywhere — it would quietly delete an edge from the graph.
        CheckConstraint(_EDGE_KIND_CHECK, name="ck_kc_edges_kind"),
        # Prerequisite walks read edges by their dependent end: "what does this
        # standard need", once per hop.
        Index("ix_edges_kc", "kc_id", "kind"),
    )


class Observation(Base):
    """One piece of evidence about one learner on one concept.

    Append-only, and deliberately finer-grained than a score: `weight` is how
    much of the turn this concept accounts for, `outcome` is how it went, and
    `reliability` is how much the annotator's read of it should be trusted.
    Keeping the three apart is what lets the mastery update downweight a
    guessy inference without pretending it never happened.
    """

    __tablename__ = "observations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    learner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learners.id", name="fk_obs_learner")
    )
    #: Nullable because not every observation comes from a turn — a placement
    #: answer or a backfill from an old transcript has no turn to point at.
    turn_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("turns.id", name="fk_obs_turn"), nullable=True
    )
    kc_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("kcs.id", name="fk_obs_kc"))
    weight: Mapped[float] = mapped_column(Float)
    outcome: Mapped[float] = mapped_column(Float)
    reliability: Mapped[float] = mapped_column(Float)
    kind: Mapped[str] = mapped_column(String(24))
    difficulty: Mapped[float] = mapped_column(Float, server_default="0")
    misconception: Mapped[str | None] = mapped_column(Text, nullable=True)
    detail: Mapped[dict] = mapped_column(JSONB, server_default="{}")
    observed_at: Mapped[datetime] = mapped_column(server_default=func.now())

    __table_args__ = (
        # The mastery update reads one learner's history for one concept.
        Index("ix_obs_learner_kc", "learner_id", "kc_id"),
    )


class LearnerKCState(Base):
    """What we currently believe about one learner on one concept.

    Derived: rebuildable by replaying that learner's observations, which is
    why it is a single row per pair rather than a history. `theta` is a
    logit — 0 means no evidence either way, positive means some mastery — and
    `n_effective` is how much evidence stands behind it, so a theta of 1.2
    from one lucky answer can be told apart from the same number earned over
    a dozen.
    """

    __tablename__ = "learner_kc_state"

    learner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learners.id", name="fk_state_learner"), primary_key=True
    )
    kc_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("kcs.id", name="fk_state_kc"), primary_key=True
    )
    theta: Mapped[float] = mapped_column(Float, server_default="0")
    n_effective: Mapped[float] = mapped_column(Float, server_default="0.5")
    last_seen_at: Mapped[datetime | None] = mapped_column(nullable=True)
    #: When mastery was first reached, kept even if theta later decays, so
    #: "knew this in March and has since lost it" stays visible.
    first_mastered_at: Mapped[datetime | None] = mapped_column(nullable=True)
