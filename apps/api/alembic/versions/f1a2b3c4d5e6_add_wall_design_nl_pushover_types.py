"""add_wall_design_nl_pushover_analysis_types

Revision ID: f1a2b3c4d5e6
Revises: b0c1d2e3f4a5
Create Date: 2026-09-11 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f1a2b3c4d5e6'
down_revision: Union[str, Sequence[str], None] = 'b0c1d2e3f4a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.execute("ALTER TYPE structuralanalysistype ADD VALUE IF NOT EXISTS 'wall_design'")
        op.execute("ALTER TYPE structuralanalysistype ADD VALUE IF NOT EXISTS 'nl_pushover'")


def downgrade() -> None:
    pass
