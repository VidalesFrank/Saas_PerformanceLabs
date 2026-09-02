"""Add design_columns to StructuralAnalysisType enum

Revision ID: c7d4e2f1a8b5
Revises: a3f2c1d8e9b0
Create Date: 2026-08-14

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'c7d4e2f1a8b5'
down_revision: Union[str, Sequence[str], None] = 'a3f2c1d8e9b0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.execute("ALTER TYPE structuralanalysistype ADD VALUE 'design_columns'")
    # SQLite stores enum values as plain strings — no migration needed


def downgrade() -> None:
    # PostgreSQL: removing enum values requires recreating the type (complex).
    # For dev/test purposes this is left as a no-op.
    pass
