"""memory: learners, episodes, atoms, profile

Storage only — nothing reads or writes these tables yet.

Two things here are worth knowing before reading the DDL:

`memory_atoms.fts` is GENERATED rather than maintained by the application:
hybrid retrieval needs a tsvector on every row, and a generated column cannot
drift out of sync with `text` the way a trigger or an application write can.

`memory_atoms.embedding` is `halfvec`, which reaches Alembic through
pgvector's own SQLAlchemy type rather than through `sa.` — half precision
costs ~nothing in recall at this scale and halves both the row and the index.

Revision ID: 0003
Revises: 0002
Create Date: 2026-08-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import HALFVEC
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Spelled out rather than imported from app.config: a migration is a record of
# what was done to the database on the day it ran, and it has to keep producing
# that same result even after the constant it was written against moves.
SOLE_LEARNER_ID = '00000000-0000-4000-8000-000000000001'


def upgrade() -> None:
    """Upgrade schema."""
    # 0001 already does this; repeated because a branch created from before
    # 0001's vector work — or restored from a dump without extensions — would
    # otherwise fail on `halfvec` below with a bare "type does not exist".
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        'learners',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('display_name', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    # The one learner. Seeded here rather than by application startup so that
    # every environment which can run migrations has a learner to hang memory
    # off, and so the foreign keys below are satisfiable the moment they exist.
    op.execute(
        f"INSERT INTO learners (id, display_name) "
        f"VALUES ('{SOLE_LEARNER_ID}', 'me')"
    )

    op.create_table(
        'episodes',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('learner_id', sa.UUID(), nullable=False),
        sa.Column('session_id', sa.UUID(), nullable=False),
        sa.Column('transcript', sa.Text(), nullable=False),
        sa.Column('digest', sa.Text(), nullable=True),
        sa.Column('message_count', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('closed_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.Column('extracted_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['learner_id'], ['learners.id'],
                                name='fk_episodes_learner'),
        # `session_id` is deliberately not a foreign key to `sessions`: this is
        # the table everything else is rebuilt from, and its durability must not
        # be bounded by the lifetime of the rows it points at. Purging a session
        # should cost the back-reference, not the episode.
        sa.UniqueConstraint('session_id', name='uq_episodes_session'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_episodes_learner_id'), 'episodes', ['learner_id'])
    op.create_index(op.f('ix_episodes_session_id'), 'episodes', ['session_id'])
    op.create_index(op.f('ix_episodes_closed_at'), 'episodes', ['closed_at'])

    op.create_table(
        'memory_atoms',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('learner_id', sa.UUID(), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('category', sa.String(length=16), nullable=False),
        sa.Column('embedding', HALFVEC(1024), nullable=True),
        sa.Column('valid_from', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.Column('valid_to', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ingested_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.Column('invalidated_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('superseded_by', sa.UUID(), nullable=True),
        sa.Column('source_session_id', sa.UUID(), nullable=True),
        sa.Column('source_turn_ids', postgresql.ARRAY(sa.UUID()),
                  server_default='{}', nullable=False),
        sa.Column('stated', sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column('fts', postgresql.TSVECTOR(),
                  sa.Computed("to_tsvector('english', text)", persisted=True),
                  nullable=False),
        # Spelled out rather than built from models.MEMORY_CATEGORIES, for the
        # same reason SOLE_LEARNER_ID is: this records the six values that were
        # legal the day it ran. Widening the set later is its own ALTER, and a
        # CHECK is what makes that cheap — an LLM writes this column, and
        # without it one typo becomes a seventh category nothing ever matches.
        sa.CheckConstraint(
            "category IN ('preference', 'goal', 'context', 'skill_state', "
            "'misconception', 'episode_ref')",
            name='ck_memory_atoms_category',
        ),
        sa.ForeignKeyConstraint(['learner_id'], ['learners.id'],
                                name='fk_atoms_learner'),
        sa.ForeignKeyConstraint(['superseded_by'], ['memory_atoms.id'],
                                name='fk_atoms_superseded_by'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_memory_atoms_learner_id'), 'memory_atoms', ['learner_id'])
    op.create_index(op.f('ix_memory_atoms_category'), 'memory_atoms', ['category'])
    op.create_index('ix_memory_atoms_fts', 'memory_atoms', ['fts'],
                    postgresql_using='gin')
    # Retrieval only ever wants live atoms, so the index only holds them:
    # superseded rows accumulate forever and would otherwise bloat every
    # lookup that will never look at them.
    op.create_index(
        'ix_memory_atoms_live', 'memory_atoms', ['learner_id', 'category'],
        postgresql_where=sa.text('valid_to IS NULL'),
    )

    # Created here rather than alongside the code that first writes it: this is
    # the migration that introduces `learners`, and a later revision adding the
    # table would either have to re-open this one or carry a second copy of the
    # foreign key it depends on.
    op.create_table(
        'learner_profiles',
        sa.Column('learner_id', sa.UUID(), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        sa.Column('atom_count', sa.Integer(), nullable=False),
        sa.Column('rebuilt_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['learner_id'], ['learners.id'],
                                name='fk_profiles_learner'),
        # The learner id is the whole key: the profile is a cache of that
        # learner's live atoms, so a rebuild replaces the one row rather than
        # appending a version nobody would read.
        sa.PrimaryKeyConstraint('learner_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Reverse dependency order; each table takes its own indexes and foreign
    # keys with it. The `vector` extension is left in place — 0001 created it
    # and this revision only borrowed it.
    op.drop_table('learner_profiles')
    op.drop_table('memory_atoms')
    op.drop_table('episodes')
    op.drop_table('learners')
