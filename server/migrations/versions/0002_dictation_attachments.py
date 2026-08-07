"""dictation attachments

A dictation has no turn_id — that is only minted client-side when the
student hits Send, and the audio exists before that. turn_id becomes
nullable so an attachment can be written against a session instead; the
constraint that at least one of the two is set lives in
Recorder.record_attachment, not in the schema (nullability alone cannot
express "at least one of two columns").

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-07 18:50:35.414761

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Named explicitly rather than left for Alembic to autogenerate as
# unnamed (constraint_name=None): an unnamed constraint cannot be targeted
# by downgrade()'s drop_constraint, which would otherwise be a real
# migration you can run but can never cleanly reverse.
SESSION_FK = "fk_attachments_session_id_sessions"


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('attachments', sa.Column('session_id', sa.UUID(), nullable=True))
    op.alter_column('attachments', 'turn_id',
               existing_type=sa.UUID(),
               nullable=True)
    op.create_index(op.f('ix_attachments_session_id'), 'attachments', ['session_id'], unique=False)
    op.create_foreign_key(SESSION_FK, 'attachments', 'sessions', ['session_id'], ['id'])


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint(SESSION_FK, 'attachments', type_='foreignkey')
    op.drop_index(op.f('ix_attachments_session_id'), table_name='attachments')
    op.alter_column('attachments', 'turn_id',
               existing_type=sa.UUID(),
               nullable=False)
    op.drop_column('attachments', 'session_id')
