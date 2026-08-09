"""learner uploads: what a file was called and what it became

Five columns, all nullable, added to `attachments`. Every attachment written
before this migration is a board render, a dictation or an ink blob, and none
of them has a filename — so there is nothing to backfill. `learner_upload` is
the one kind that arrives named, may need converting before a model can read
it, and is referred to by id from a later turn, which is why it is the one
that has to remember what it was called, what it became, and what it looks
like. See `app.store.models.Attachment` for the field-by-field reasoning.

Revision ID: 0005
Revises: 0004
Create Date: 2026-08-09

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('attachments', sa.Column('filename', sa.String(length=255), nullable=True))
    op.add_column('attachments', sa.Column('page_count', sa.Integer(), nullable=True))
    op.add_column('attachments', sa.Column('converted_blob_key', sa.String(length=128), nullable=True))
    op.add_column('attachments', sa.Column('converted_content_type', sa.String(length=64), nullable=True))
    op.add_column('attachments', sa.Column('thumbnail_blob_key', sa.String(length=128), nullable=True))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('attachments', 'thumbnail_blob_key')
    op.drop_column('attachments', 'converted_content_type')
    op.drop_column('attachments', 'converted_blob_key')
    op.drop_column('attachments', 'page_count')
    op.drop_column('attachments', 'filename')
