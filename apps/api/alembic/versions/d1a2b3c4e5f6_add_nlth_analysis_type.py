"""add_nlth_analysis_type

Añade el valor 'nlth' al enum StructuralAnalysisType para el análisis
cronológico no lineal (time-history bidireccional).

Revision ID: d1a2b3c4e5f6
Revises: c9e0a1b2d3f4
Create Date: 2026-10-16 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'd1a2b3c4e5f6'
down_revision: Union[str, Sequence[str], None] = 'c9e0a1b2d3f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == 'postgresql':
        op.execute(
            "ALTER TYPE structuralanalysistype "
            "ADD VALUE IF NOT EXISTS 'nlth'"
        )


def downgrade() -> None:
    # No se pueden eliminar valores de un enum PostgreSQL de forma segura.
    pass
