"""add_frame_pushover_type_and_progress_json

Añade:
- Nuevo valor 'frame_pushover' al enum StructuralAnalysisType
- Columna 'progress_json' (JSON) a structural_jobs para progreso en vivo

Revision ID: c9e0a1b2d3f4
Revises: 088e3e907642
Create Date: 2026-10-02 10:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c9e0a1b2d3f4'
down_revision: Union[str, Sequence[str], None] = '088e3e907642'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # Enum: solo PostgreSQL requiere ALTER TYPE; SQLite guarda enum como VARCHAR.
    if dialect == 'postgresql':
        op.execute(
            "ALTER TYPE structuralanalysistype "
            "ADD VALUE IF NOT EXISTS 'frame_pushover'"
        )

    # Añadir columna progress_json (nullable, sin default)
    op.add_column(
        'structural_jobs',
        sa.Column('progress_json', sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column('structural_jobs', 'progress_json')
    # No se puede eliminar valores de un enum PostgreSQL fácilmente;
    # el downgrade solo elimina la columna.
