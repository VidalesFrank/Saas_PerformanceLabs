"""add ground motion tables

Revision ID: a1b2c3d4e5f6
Revises: e5f2a3b4c1d0
Create Date: 2026-09-04 09:00:00.000000
"""
from alembic import op
import sqlalchemy as sa


revision = 'a1b2c3d4e5f6'
down_revision = 'e5f2a3b4c1d0'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'gm_records',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('name', sa.String(255), nullable=False),
        sa.Column('source_file', sa.String(500), nullable=True),
        sa.Column('raw_data_path', sa.String(1000), nullable=True),
        sa.Column('dt', sa.Float(), nullable=True),
        sa.Column('n_samples', sa.Integer(), nullable=True),
        sa.Column('duration', sa.Float(), nullable=True),
        sa.Column('acc_unit_original', sa.String(20), nullable=True),
        sa.Column('metadata_json', sa.JSON(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    )

    op.create_table(
        'gm_jobs',
        sa.Column('id', sa.String(36), primary_key=True),
        sa.Column('celery_task_id', sa.String(255), nullable=True, index=True),
        sa.Column('job_type', sa.String(30), nullable=False),
        sa.Column('status', sa.Enum('pending', 'running', 'success', 'failed', 'cancelled',
                                     name='gmjobstatus'), nullable=False, server_default='pending'),
        sa.Column('result_path', sa.String(1000), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column('result_summary', sa.JSON(), nullable=True),
        sa.Column('record_id', sa.String(36), sa.ForeignKey('gm_records.id'), nullable=False),
        sa.Column('owner_id', sa.String(36), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table('gm_jobs')
    op.drop_table('gm_records')
    op.execute("DROP TYPE IF EXISTS gmjobstatus")
