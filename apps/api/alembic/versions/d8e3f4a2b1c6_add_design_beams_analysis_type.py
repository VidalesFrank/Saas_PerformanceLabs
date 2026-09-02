"""Add design_beams to StructuralAnalysisType enum

Revision ID: d8e3f4a2b1c6
Revises: c7d4e2f1a8b5
Create Date: 2026-08-14

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'd8e3f4a2b1c6'
down_revision: Union[str, Sequence[str], None] = 'c7d4e2f1a8b5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.execute("ALTER TYPE structuralanalysistype ADD VALUE 'design_beams'")
    # SQLite: enum values stored as plain strings — no migration needed


def downgrade() -> None:
    pass
