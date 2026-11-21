"""drop building_projects, building_jobs y FK en field_assessments

Elimina el modulo 3 (/building): tablas building_projects + building_jobs,
enums asociados y la columna linked_building_project_id de field_assessments.

Toda la funcionalidad vive ahora en el Constructor de Modelos
(structural_projects).

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-11-20
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, Sequence[str], None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Drop building_projects + building_jobs + FK en field_assessments."""
    bind = op.get_bind()
    dialect = bind.dialect.name

    # 1. Drop columna FK en field_assessments (la constraint se cae con ella)
    with op.batch_alter_table("field_assessments") as batch_op:
        try:
            batch_op.drop_column("linked_building_project_id")
        except Exception:
            # En algunos backends la columna puede no existir ya; idempotente.
            pass

    # 2. Drop building_jobs (depende de building_projects)
    try:
        op.drop_table("building_jobs")
    except Exception:
        pass

    # 3. Drop building_projects
    try:
        op.drop_table("building_projects")
    except Exception:
        pass

    # 4. Drop enums (solo Postgres los crea como tipos nombrados)
    if dialect == "postgresql":
        for enum_name in ("buildinganalysistype", "buildingjobstatus"):
            try:
                op.execute(f"DROP TYPE IF EXISTS {enum_name}")
            except Exception:
                pass


def downgrade() -> None:
    """Re-crear tablas/enums. Solo por consistencia Alembic — no restaura datos."""
    bind = op.get_bind()
    dialect = bind.dialect.name

    if dialect == "postgresql":
        op.execute(
            "CREATE TYPE buildinganalysistype AS ENUM "
            "('archetype', 'modal', 'pushover', 'dynamic')"
        )
        op.execute(
            "CREATE TYPE buildingjobstatus AS ENUM "
            "('pending', 'running', 'success', 'failed', 'cancelled')"
        )

    op.create_table(
        "building_projects",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("parameters_json", sa.Text(), nullable=True),
        sa.Column("input_file_path", sa.String(length=1000), nullable=True),
        sa.Column("e2k_file_path", sa.String(length=1000), nullable=True),
        sa.Column("rebar_file_path", sa.String(length=1000), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "building_jobs",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("celery_task_id", sa.String(length=255), nullable=True),
        sa.Column(
            "analysis_type",
            sa.Enum("archetype", "modal", "pushover", "dynamic", name="buildinganalysistype"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.Enum("pending", "running", "success", "failed", "cancelled", name="buildingjobstatus"),
            nullable=False,
        ),
        sa.Column("result_path", sa.String(length=1000), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("result_summary", sa.JSON(), nullable=True),
        sa.Column("project_id", sa.String(length=36), nullable=False),
        sa.Column("owner_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["building_projects.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_building_jobs_celery_task_id", "building_jobs", ["celery_task_id"])

    with op.batch_alter_table("field_assessments") as batch_op:
        batch_op.add_column(
            sa.Column("linked_building_project_id", sa.String(length=36), nullable=True)
        )
        batch_op.create_foreign_key(
            "fk_field_assessments_building_project",
            "building_projects", ["linked_building_project_id"], ["id"],
        )
