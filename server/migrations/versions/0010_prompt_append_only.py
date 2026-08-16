"""sessions: the frozen prompt head and the append-only session log

Two nullable columns on `sessions`, which is the row the turn prologue already
fetches and the turn commit already writes — so the prompt's whole cacheable
half becomes free to read and free to keep, with no round trip added in either
direction.

`prompt_preamble` is the prompt's frozen head: the portrait, the notes, the
digests, the mastery snapshot, the goal, the exercise, the plan and the board
scene as they stood when the session opened. It is built on the first turn and
served byte for byte on every turn after, which is what stops four memory
queries per turn — about 2,400 ms on a 262 ms link — and what stops the front of
the cached prefix moving.

`prompt_log` is the session log and the bookkeeping to extend it: the bytes
already sent, kept rather than rebuilt, because the invariant is "what went out
last turn is a prefix of what goes out this turn" and only the bytes can settle
that.

Both nullable, and both are read through `LogState.from_json` / an `or`, so a
session that predates this migration simply builds its head on the next turn and
starts its log there. Nothing backfills and nothing fails.

Revision ID: 0010
Revises: 0009
Create Date: 2026-08-16

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision: str = '0010'
down_revision: Union[str, Sequence[str], None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('sessions', sa.Column('prompt_preamble', sa.Text(), nullable=True))
    op.add_column('sessions', sa.Column('prompt_log', JSONB(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('sessions', 'prompt_log')
    op.drop_column('sessions', 'prompt_preamble')
