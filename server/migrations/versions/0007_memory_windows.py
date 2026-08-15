"""memory windows: episodes per message range, rich summaries, saved notes

Purely additive except one constraint swap, and the swap is the point of the
revision. `uq_episodes_session` — one episode per session id, forever — is the
constraint that froze memory: the device reopens the same session across days,
so the first close recorded a fossil and every turn after it was permanently
unrememberable. `uq_episodes_session_window` replaces it with uniqueness on
`(session_id, seq_from)`, so a session is remembered window by window and a
mid-session close costs one window, not the rest of the session.

`seq_from`/`seq_to` are 1-based message ordinals: `messages.seq` is 0-based
and dense, so an episode covers the messages whose `seq` lies in
`[seq_from - 1, seq_to - 1]`. The backfill writes `seq_from=1,
seq_to=message_count` — exactly the range a one-per-session episode froze —
so the next window recorded for a reopened session starts at the first
message the fossil never saw.

The rest is columns: the rich summary (`title`, `narrative`, `next_steps`,
`topics`, `narrative_embedding`) beside the old two-sentence `digest`, which
stays for compatibility until the backfill pass has re-summarized history;
quarantine accounting (`extraction_attempts`, `quarantined_at`) so one poison
episode stops halting the whole drain; a generated `fts` tsvector on
`messages` so the entire stored history is full-text searchable; and
`memory_atoms.explicit` marking the learner's own saved notes, which are
never offered to consolidation as supersession targets.

Revision ID: 0007
Revises: 0006
Create Date: 2026-08-15

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from pgvector.sqlalchemy import HALFVEC
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # 0001 and 0003 already do this; repeated for their reason — a branch
    # restored without extensions would otherwise fail on `halfvec` below.
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    # The window. Server defaults describe an empty window (`1, 0`) and exist
    # so the NOT NULL add is legal on a populated table; the backfill below
    # immediately overwrites them for every existing row, and the application
    # always sets both explicitly.
    op.add_column('episodes', sa.Column(
        'seq_from', sa.Integer(), server_default='1', nullable=False))
    op.add_column('episodes', sa.Column(
        'seq_to', sa.Integer(), server_default='0', nullable=False))

    # The rich summary, all nullable: NULL means "summarized under the old
    # digest-only prompt (or not yet at all)", which is exactly what the
    # backfill pass selects on.
    op.add_column('episodes', sa.Column('title', sa.Text(), nullable=True))
    op.add_column('episodes', sa.Column('narrative', sa.Text(), nullable=True))
    op.add_column('episodes', sa.Column(
        'next_steps', postgresql.JSONB(), nullable=True))
    op.add_column('episodes', sa.Column(
        'topics', postgresql.ARRAY(sa.Text()), nullable=True))
    op.add_column('episodes', sa.Column(
        'narrative_embedding', HALFVEC(1024), nullable=True))

    # Quarantine accounting. Zero attempts is the honest state for every
    # episode that exists today — none of them has failed the new pipeline.
    op.add_column('episodes', sa.Column(
        'extraction_attempts', sa.Integer(), server_default='0', nullable=False))
    op.add_column('episodes', sa.Column(
        'quarantined_at', sa.DateTime(timezone=True), nullable=True))

    # Every pre-window episode covered its session from the first message —
    # that is what recording at close meant — so its window is ordinals
    # 1..message_count. Written before the constraint swap so no row ever
    # exists under the new constraint with a default (empty) window.
    op.execute("UPDATE episodes SET seq_from = 1, seq_to = message_count")

    # The swap. Dropping one-per-session is what un-freezes memory; the new
    # constraint keeps what the old one actually protected — a racing double
    # close cannot record the same window twice.
    op.drop_constraint('uq_episodes_session', 'episodes', type_='unique')
    op.create_unique_constraint(
        'uq_episodes_session_window', 'episodes', ['session_id', 'seq_from'])

    # Full-text search over every stored utterance, for `search_history`.
    # GENERATED so it cannot drift from `text`; a generated column on a
    # populated table is computed for existing rows at ADD COLUMN time.
    op.add_column('messages', sa.Column(
        'fts', postgresql.TSVECTOR(),
        sa.Computed("to_tsvector('english', text)", persisted=True),
        nullable=False))
    op.create_index('ix_messages_fts', 'messages', ['fts'],
                    postgresql_using='gin')

    # Explicitly saved notes. False for every existing atom — nothing written
    # before this revision was an explicit save, including the atoms the old
    # `remember` tool wrote, because nothing downstream distinguished them and
    # relabelling history would claim a guarantee those rows never had.
    op.add_column('memory_atoms', sa.Column(
        'explicit', sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('memory_atoms', 'explicit')
    op.drop_index('ix_messages_fts', table_name='messages')
    op.drop_column('messages', 'fts')
    # Restoring one-per-session is only possible while each session still has
    # at most one episode. Once windows have been recorded this raises on the
    # duplicate session_ids rather than silently deleting windows — a
    # downgrade that destroys recorded memory should have to be done by hand.
    op.drop_constraint('uq_episodes_session_window', 'episodes', type_='unique')
    op.create_unique_constraint('uq_episodes_session', 'episodes', ['session_id'])
    op.drop_column('episodes', 'quarantined_at')
    op.drop_column('episodes', 'extraction_attempts')
    op.drop_column('episodes', 'narrative_embedding')
    op.drop_column('episodes', 'topics')
    op.drop_column('episodes', 'next_steps')
    op.drop_column('episodes', 'narrative')
    op.drop_column('episodes', 'title')
    op.drop_column('episodes', 'seq_to')
    op.drop_column('episodes', 'seq_from')
