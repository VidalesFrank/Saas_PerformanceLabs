"""add_wall_demands_analysis_type

Revision ID: 49b5c7c39908
Revises: e5f2a3b4c1d0
Create Date: 2026-09-02 18:48:16.581432

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '49b5c7c39908'
down_revision: Union[str, Sequence[str], None] = 'e5f2a3b4c1d0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Add wall_demands value to StructuralAnalysisType enum (PostgreSQL only)
    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.execute("ALTER TYPE structuralanalysistype ADD VALUE IF NOT EXISTS 'wall_demands'")


def downgrade() -> None:
    pass
