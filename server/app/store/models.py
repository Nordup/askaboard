from __future__ import annotations

import uuid
from datetime import datetime

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import (
    Boolean, Computed, DateTime, Float, ForeignKey, Index, Integer, String, Text, func,
    text as sa_text, true,
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

    session: Mapped[Session] = relationship(back_populates="messages")


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
    # ink | audio. The first two are kept apart on purpose — see BOARD_KIND.
    kind: Mapped[str] = mapped_column(String(16))
    blob_key: Mapped[str] = mapped_column(String(128))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    bytes: Mapped[int] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    content_type: Mapped[str] = mapped_column(String(64))
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
    """One closed session, as raw material. Ground truth for every derived row.

    Atoms, the profile and the learner model are all rebuildable from this
    plus the session tables. Nothing here is ever rewritten, which is what
    makes a bad extraction prompt a recoverable mistake: delete the atoms,
    clear `extracted_at`, run the new prompt over the same transcripts.

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
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", name="fk_episodes_session"), index=True
    )
    transcript: Mapped[str] = mapped_column(Text)
    digest: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_count: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime]
    closed_at: Mapped[datetime] = mapped_column(server_default=func.now(), index=True)
    #: NULL means "not yet extracted". The backlog is a column rather than a
    #: queue because the queue would be a second thing to keep consistent with
    #: this table, and a crashed extraction has to be safe to simply re-run.
    extracted_at: Mapped[datetime | None] = mapped_column(nullable=True)


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
    #: preference | goal | context | skill_state | misconception | episode_ref.
    #: A plain string rather than a Postgres ENUM: the set is still being
    #: discovered, and adding a value to an ENUM is a migration on a table the
    #: extractor writes to, whereas widening a vocabulary the extractor is
    #: prompted with should not be.
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
    #: Generated rather than maintained by the application: hybrid retrieval
    #: needs a tsvector on every row, and a GENERATED column cannot drift out
    #: of sync with `text` the way a trigger or an application write can.
    #: SQLAlchemy knows a Computed column is read-only and leaves it out of
    #: INSERTs, so nothing here ever writes it.
    fts: Mapped[str] = mapped_column(
        TSVECTOR, Computed("to_tsvector('english', text)", persisted=True)
    )

    __table_args__ = (
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

    Purely derived — recomputable from the live atoms — which is why the
    learner id is also the primary key: a rebuild replaces the single row
    instead of appending a version nobody would read. `atom_count` records
    what the body was built from, so a rebuild can be skipped when nothing
    has changed.
    """

    __tablename__ = "learner_profiles"

    learner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("learners.id", name="fk_profiles_learner"), primary_key=True
    )
    body: Mapped[str] = mapped_column(Text)
    atom_count: Mapped[int] = mapped_column(Integer)
    rebuilt_at: Mapped[datetime] = mapped_column(server_default=func.now())
