"""Portable web workspace and GPT-Live duration records.

Revision ID: 0011
Revises: 0010
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision: str = "0011"
down_revision: Union[str, Sequence[str], None] = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "web_workspaces",
        sa.Column("session_id", UUID(as_uuid=True), sa.ForeignKey("sessions.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("revision", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("title", sa.String(length=255), nullable=False, server_default="Untitled session"),
        sa.Column("workspace", JSONB(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_table(
        "live_sessions",
        sa.Column("live_session_id", sa.String(length=128), primary_key=True),
        sa.Column("session_id", UUID(as_uuid=True), nullable=True),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_live_sessions_session_id", "live_sessions", ["session_id"])
    op.create_table(
        "live_usage",
        sa.Column("live_session_id", sa.String(length=128), primary_key=True),
        sa.Column("session_id", UUID(as_uuid=True), nullable=True),
        sa.Column("model", sa.String(length=64), nullable=False),
        sa.Column("duration_seconds", sa.Integer(), nullable=False),
        sa.Column("cost_usd", sa.Float(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_live_usage_session_id", "live_usage", ["session_id"])


def downgrade() -> None:
    op.drop_index("ix_live_sessions_session_id", table_name="live_sessions")
    op.drop_table("live_sessions")
    op.drop_index("ix_live_usage_session_id", table_name="live_usage")
    op.drop_table("live_usage")
    op.drop_table("web_workspaces")
