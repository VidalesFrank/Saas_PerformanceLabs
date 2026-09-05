"""Add wall_projects and wall_jobs tables (Módulo 5 — Muros RC 3D)

Revision ID: e5f2a3b4c1d0
Revises: d8e3f4a2b1c6
Create Date: 2026-09-02

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = 'e5f2a3b4c1d0'
down_revision: Union[str, Sequence[str], None] = 'd8e3f4a2b1c6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    from sqlalchemy import inspect as sa_inspect
    from sqlalchemy.dialects.postgresql import ENUM as pgENUM

    bind    = op.get_bind()
    dialect = bind.dialect.name
    tables  = sa_inspect(bind).get_table_names()

    # ── Enums (PostgreSQL only, idempotent via DO block) ──────────────────────
    if dialect == 'postgresql':
        op.execute("""
            DO $$ BEGIN
                CREATE TYPE wallprojectstatus AS ENUM ('empty', 'ready', 'running', 'done');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
        """)
        op.execute("""
            DO $$ BEGIN
                CREATE TYPE walljobtype AS ENUM ('gravity', 'modal', 'pushover');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
        """)
        op.execute("""
            DO $$ BEGIN
                CREATE TYPE walljobstatus AS ENUM ('pending', 'running', 'success', 'failed', 'cancelled');
            EXCEPTION WHEN duplicate_object THEN null;
            END $$;
        """)

    # ── Tipos de columna según dialecto ──────────────────────────────────────
    # create_type=False → SQLAlchemy asume que el tipo YA existe (creado arriba)
    if dialect == 'postgresql':
        t_project_status = pgENUM('empty', 'ready', 'running', 'done',
                                  name='wallprojectstatus', create_type=False)
        t_job_type       = pgENUM('gravity', 'modal', 'pushover',
                                  name='walljobtype', create_type=False)
        t_job_status     = pgENUM('pending', 'running', 'success', 'failed', 'cancelled',
                                  name='walljobstatus', create_type=False)
    else:
        t_project_status = sa.Enum('empty', 'ready', 'running', 'done')
        t_job_type       = sa.Enum('gravity', 'modal', 'pushover')
        t_job_status     = sa.Enum('pending', 'running', 'success', 'failed', 'cancelled')

    # ── wall_projects ─────────────────────────────────────────────────────────
    if 'wall_projects' not in tables:
        op.create_table(
            'wall_projects',
            sa.Column('id',            sa.String(36),   primary_key=True),
            sa.Column('owner_id',      sa.String(36),   sa.ForeignKey('users.id'), nullable=False),
            sa.Column('name',          sa.String(255),  nullable=False),
            sa.Column('description',   sa.Text(),       nullable=True),
            sa.Column('document_path', sa.String(1000), nullable=True),
            sa.Column('document_hash', sa.String(64),   nullable=True),
            sa.Column('status',        t_project_status, nullable=False, server_default='empty'),
            sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index('ix_wall_projects_owner_id', 'wall_projects', ['owner_id'])

    # ── wall_jobs ─────────────────────────────────────────────────────────────
    if 'wall_jobs' not in tables:
        op.create_table(
            'wall_jobs',
            sa.Column('id',             sa.String(36),   primary_key=True),
            sa.Column('celery_task_id', sa.String(255),  nullable=True, index=True),
            sa.Column('project_id',     sa.String(36),   sa.ForeignKey('wall_projects.id'), nullable=False),
            sa.Column('owner_id',       sa.String(36),   sa.ForeignKey('users.id'), nullable=False),
            sa.Column('job_type',       t_job_type,      nullable=False),
            sa.Column('status',         t_job_status,    nullable=False, server_default='pending'),
            sa.Column('push_direction', sa.String(4),    nullable=True),
            sa.Column('result_path',    sa.String(1000), nullable=True),
            sa.Column('error_message',  sa.Text(),       nullable=True),
            sa.Column('result_summary', sa.JSON(),       nullable=True),
            sa.Column('created_at',     sa.DateTime(timezone=True), nullable=False),
            sa.Column('finished_at',    sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index('ix_wall_jobs_project_id', 'wall_jobs', ['project_id'])


def downgrade() -> None:
    op.drop_table('wall_jobs')
    op.drop_table('wall_projects')

    bind = op.get_bind()
    if bind.dialect.name == 'postgresql':
        op.execute('DROP TYPE IF EXISTS walljobstatus')
        op.execute('DROP TYPE IF EXISTS walljobtype')
        op.execute('DROP TYPE IF EXISTS wallprojectstatus')
