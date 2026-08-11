"""Módulo 1 — tablas structural_projects y structural_jobs

Revision ID: a3f2c1d8e9b0
Revises: bb1a326dfbc0
Create Date: 2026-07-30

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a3f2c1d8e9b0'
down_revision: Union[str, Sequence[str], None] = 'bb1a326dfbc0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'structural_projects',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('owner_id', sa.String(length=36), nullable=False),
        sa.Column('name', sa.String(length=255), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('parameters_json', sa.Text(), nullable=True),
        sa.Column('input_file_path', sa.String(length=1000), nullable=True),
        sa.Column('e2k_file_path', sa.String(length=1000), nullable=True),
        sa.Column('canonical_model_path', sa.String(length=1000), nullable=True),
        sa.Column('validation_status', sa.String(length=20), nullable=False, server_default='not_run'),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )

    op.create_table(
        'structural_jobs',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('celery_task_id', sa.String(length=255), nullable=True),
        sa.Column('analysis_type', sa.Enum('import_validate', 'modal', 'spectral',
                                           name='structuralanalysistype'), nullable=False),
        sa.Column('status', sa.Enum('pending', 'running', 'success', 'failed', 'cancelled',
                                    name='structuraljobstatus'), nullable=False),
        sa.Column('result_path', sa.String(length=1000), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('result_summary', sa.JSON(), nullable=True),
        sa.Column('project_id', sa.String(length=36), nullable=False),
        sa.Column('owner_id', sa.String(length=36), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ),
        sa.ForeignKeyConstraint(['project_id'], ['structural_projects.id'], ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_structural_jobs_celery_task_id', 'structural_jobs', ['celery_task_id'])


def downgrade() -> None:
    op.drop_index('ix_structural_jobs_celery_task_id', table_name='structural_jobs')
    op.drop_table('structural_jobs')
    op.drop_table('structural_projects')
    op.execute("DROP TYPE IF EXISTS structuralanalysistype")
    op.execute("DROP TYPE IF EXISTS structuraljobstatus")
