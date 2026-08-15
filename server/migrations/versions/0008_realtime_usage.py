"""realtime_usage: the voice path's token bill, one row per response

Before this table the realtime path recorded nothing: the call runs WebRTC
device↔OpenAI with the server as SDP proxy only, so the usage events never
touch a route that writes. The device now reports each `response.done`'s
counts to `POST /v1/realtime/usage`, priced at write time, and
`Recorder.spend_today()` sums `cost_usd` here alongside `turns.cost_usd` —
which is what finally puts voice spend under `DAILY_SPEND_CAP_USD`.

`session_id` is deliberately not a foreign key: sessions are created lazily
by the first turn, and a voice call can start — and bill — before any turn
exists. See `app.store.models.RealtimeUsage`.

Revision ID: 0008
Revises: 0007
Create Date: 2026-08-15

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PGUUID


# revision identifiers, used by Alembic.
revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'realtime_usage',
        sa.Column('id', PGUUID(as_uuid=True), primary_key=True),
        sa.Column('session_id', PGUUID(as_uuid=True), nullable=True),
        sa.Column('response_id', sa.String(length=64), nullable=True),
        sa.Column('model', sa.String(length=64), nullable=False),
        sa.Column('audio_input_tokens', sa.Integer(), nullable=False),
        sa.Column('cached_audio_input_tokens', sa.Integer(), nullable=False),
        sa.Column('audio_output_tokens', sa.Integer(), nullable=False),
        sa.Column('text_input_tokens', sa.Integer(), nullable=False),
        sa.Column('cached_text_input_tokens', sa.Integer(), nullable=False),
        sa.Column('text_output_tokens', sa.Integer(), nullable=False),
        sa.Column('cost_usd', sa.Float(), nullable=True),
        sa.Column(
            'created_at', sa.DateTime(timezone=True),
            server_default=sa.text('now()'), nullable=False,
        ),
    )
    op.create_index(
        'ix_realtime_usage_session_id', 'realtime_usage', ['session_id']
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('ix_realtime_usage_session_id', table_name='realtime_usage')
    op.drop_table('realtime_usage')
