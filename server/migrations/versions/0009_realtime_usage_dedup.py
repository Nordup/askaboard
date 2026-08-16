"""realtime_usage: bill one response once — unique (session_id, response_id)

`report_id` (the primary key) only dedupes a *retry* of the same report. On
2026-08-16 the device delivered one `response.done` through two event paths,
minted a fresh `report_id` for each, and `resp_EDGpjGPNsbMjzhymaXFX6` billed
twice — two identical rows in the same second. The unique index here is the
server-side half of the fix; `Recorder.record_realtime_usage` inserts with ON
CONFLICT DO NOTHING, so a second delivery still gets its 200.

The DELETE below is the backfill: for each (session_id, response_id) that
appears more than once, every row after the first (by `created_at`, then by
`id` as the tie-break for rows born in the same second) is removed. Safe
because the rows are two reports of the same usage event — identical token
counts, identical cost. Rows with a NULL `session_id` or `response_id` are
untouched, and stay out of the index's way: Postgres treats NULLs as distinct
in a unique index.

Revision ID: 0009
Revises: 0008
Create Date: 2026-08-16

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.execute(
        """
        DELETE FROM realtime_usage a
        USING realtime_usage b
        WHERE a.session_id = b.session_id
          AND a.response_id = b.response_id
          AND a.id <> b.id
          AND (a.created_at, a.id::text) > (b.created_at, b.id::text)
        """
    )
    op.create_index(
        'uq_realtime_usage_session_response',
        'realtime_usage', ['session_id', 'response_id'], unique=True,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        'uq_realtime_usage_session_response', table_name='realtime_usage'
    )
