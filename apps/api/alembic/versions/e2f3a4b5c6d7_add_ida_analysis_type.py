"""add_ida_analysis_type

Añade el valor 'ida' al enum StructuralAnalysisType para Incremental
Dynamic Analysis multi-registro FEMA P-695.

Revision ID: e2f3a4b5c6d7
Revises: d1a2b3c4e5f6
Create Date: 2026-11-05 21:30:00.000000
"""
from typing import Sequence, Union

from alembic import op


revision: str = 'e2f3a4b5c6d7'
down_revision: Union[str, Sequence[str], None] = 'd1a2b3c4e5f6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == 'postgresql':
        # ALTER TYPE ADD VALUE no puede ejecutarse dentro de una transacción
        # antes de PG 12. Postgres 12+ lo permite; para versiones anteriores
        # habría que usar COMMIT antes. En este proyecto usamos PG 15 (ver
        # docker-compose.prod.yml), así que esto funciona in-transaction.
        op.execute(
            "ALTER TYPE structuralanalysistype "
            "ADD VALUE IF NOT EXISTS 'ida'"
        )


def downgrade() -> None:
    # No se pueden eliminar valores de un enum PostgreSQL de forma segura.
    pass
