"""turn cache accounting: how much of the prompt the provider had already seen

Two nullable columns on `turns`. Both come straight off the provider's usage
object, which the recorder was reading three fields out of and discarding the
rest of — the whole of it is still in `llm_calls.usage`, so history is
recoverable, but nothing summarised it per turn and no log line said it.

They measure the prompt layout rather than the model: `cached_tokens` is how
much of this turn's input the provider served from a prefix it already held,
and `cache_write_tokens` is how much this turn put there. Every turn before
this migration has both NULL, which is honest — the numbers were not read.
See `app.store.models.Turn` for why they earn their own columns.

Revision ID: 0006
Revises: 0005
Create Date: 2026-08-10

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('turns', sa.Column('cached_tokens', sa.Integer(), nullable=True))
    op.add_column('turns', sa.Column('cache_write_tokens', sa.Integer(), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('turns', 'cache_write_tokens')
    op.drop_column('turns', 'cached_tokens')
