"""learner model: kcs, edges, observations, mastery state

Storage plus one vocabulary. `kcs` and `kc_edges` are filled by
`app.learner.kcs.seed_kcs` from a checked-in JSON rather than by an INSERT
here: the seed is 480 standards and 899 edges, it is reconciled on re-run, and
a migration that carried it would have to be re-opened every time the source
is rebuilt.

`kcs.code` gets a unique *index* rather than a unique constraint plus a
separate index. `Column(unique=True, index=True)` in the models produces
exactly one index object, and the test schema is built from that metadata
while production is built from this file — anything the two do differently is
a difference the tests cannot see.

Revision ID: 0004
Revises: 0003
Create Date: 2026-08-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'kcs',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('grade', sa.String(length=8), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_kcs_code'), 'kcs', ['code'], unique=True)

    op.create_table(
        'kc_edges',
        sa.Column('prereq_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('kc_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        # Spelled out rather than built from models.KC_EDGE_KINDS, for the same
        # reason 0003's category check is: this records what was legal the day
        # it ran. Every traversal filters on `kind`, so without the check a typo
        # would not fail anywhere — it would quietly delete an edge.
        sa.CheckConstraint("kind IN ('prerequisite', 'related')",
                           name='ck_kc_edges_kind'),
        sa.ForeignKeyConstraint(['prereq_id'], ['kcs.id'], name='fk_edges_prereq'),
        sa.ForeignKeyConstraint(['kc_id'], ['kcs.id'], name='fk_edges_kc'),
        # `kind` is part of the key: two standards can be both a prerequisite
        # pair and a related pair, and those are two separate facts.
        sa.PrimaryKeyConstraint('prereq_id', 'kc_id', 'kind'),
    )
    # Prerequisite walks read edges by their dependent end, once per hop.
    op.create_index('ix_edges_kc', 'kc_edges', ['kc_id', 'kind'])

    op.create_table(
        'observations',
        sa.Column('id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('learner_id', postgresql.UUID(as_uuid=True), nullable=False),
        # Nullable: a placement answer or a backfill from an old transcript has
        # no turn to point at.
        sa.Column('turn_id', postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column('kc_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('weight', sa.Float(), nullable=False),
        sa.Column('outcome', sa.Float(), nullable=False),
        sa.Column('reliability', sa.Float(), nullable=False),
        sa.Column('kind', sa.String(length=24), nullable=False),
        sa.Column('difficulty', sa.Float(), server_default='0', nullable=False),
        sa.Column('misconception', sa.Text(), nullable=True),
        sa.Column('detail', postgresql.JSONB(), server_default='{}', nullable=False),
        sa.Column('observed_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['learner_id'], ['learners.id'], name='fk_obs_learner'),
        sa.ForeignKeyConstraint(['turn_id'], ['turns.id'], name='fk_obs_turn'),
        sa.ForeignKeyConstraint(['kc_id'], ['kcs.id'], name='fk_obs_kc'),
        sa.PrimaryKeyConstraint('id'),
    )
    # The mastery update reads one learner's history for one concept.
    op.create_index('ix_obs_learner_kc', 'observations', ['learner_id', 'kc_id'])

    op.create_table(
        'learner_kc_state',
        sa.Column('learner_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('kc_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('theta', sa.Float(), server_default='0', nullable=False),
        sa.Column('n_effective', sa.Float(), server_default='0.5', nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('first_mastered_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['learner_id'], ['learners.id'],
                                name='fk_state_learner'),
        sa.ForeignKeyConstraint(['kc_id'], ['kcs.id'], name='fk_state_kc'),
        # One row per learner per concept: this is a belief, not a history. The
        # history is `observations`, which this is replayable from.
        sa.PrimaryKeyConstraint('learner_id', 'kc_id'),
    )


def downgrade() -> None:
    """Downgrade schema."""
    # Reverse dependency order; each table takes its own indexes and foreign
    # keys with it.
    op.drop_table('learner_kc_state')
    op.drop_table('observations')
    op.drop_table('kc_edges')
    op.drop_table('kcs')
