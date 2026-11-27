"""add role column to users

Agrega la columna `role` (enum admin|collaborator) a la tabla users.
Default `admin` para preservar el acceso de los usuarios existentes.
Los usuarios `collaborator` ven solo los módulos listados en el catalogo
filtrado por rol (Ground Motion, Espectros NSR-10 y Catalogos sísmicos).

Revision ID: a4b5c6d7e8f9
Revises: f3a4b5c6d7e8
Create Date: 2026-11-26
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "a4b5c6d7e8f9"
down_revision: Union[str, Sequence[str], None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        # Postgres: crear tipo enum explicito y usarlo
        op.execute("CREATE TYPE userrole AS ENUM ('admin', 'collaborator')")
        op.add_column(
            "users",
            sa.Column(
                "role",
                sa.Enum("admin", "collaborator", name="userrole", create_type=False),
                nullable=False,
                server_default="admin",
            ),
        )
    else:
        # SQLite: enum se mapea a VARCHAR con CHECK constraint via SQLAlchemy
        with op.batch_alter_table("users") as batch_op:
            batch_op.add_column(
                sa.Column(
                    "role",
                    sa.Enum("admin", "collaborator", name="userrole"),
                    nullable=False,
                    server_default="admin",
                )
            )


def downgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        op.drop_column("users", "role")
        op.execute("DROP TYPE IF EXISTS userrole")
    else:
        with op.batch_alter_table("users") as batch_op:
            batch_op.drop_column("role")
