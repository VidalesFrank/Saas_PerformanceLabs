"""Crea un usuario con rol `collaborator` para onboarding de miembros del equipo.

Un colaborador solo ve los modulos listados en `COLLABORATOR_ALLOWED_MODULES`
(Ground Motion, Espectros NSR-10, Catalogo sismico, Dashboard). Puede subir
sus propios acelerogramas y procesarlos; ve el catalogo compartido completo
pero solo puede borrar/editar los registros que son suyos.

Uso:
    cd apps/api
    ../../.venv/Scripts/python.exe -m scripts.create_collaborator \
        --email colega@empresa.com \
        --name "Nombre Apellido" \
        --password "contrasena_segura_min8"

Si el usuario ya existe, el script actualiza su rol y opcionalmente su
contrasena (si se pasa --reset-password).
"""
from __future__ import annotations

import argparse
import getpass
import sys
from pathlib import Path

# Asegura que `app.*` sea importable cuando se ejecuta como script sin -m
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.auth import hash_password
from app.db import SessionLocal
from app.models import User, UserRole


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Crea (o actualiza) un usuario colaborador para compartir modulos puntuales."
    )
    parser.add_argument("--email", required=True, help="Correo electronico del colaborador.")
    parser.add_argument("--name", required=True, help="Nombre completo (se muestra en la UI).")
    parser.add_argument(
        "--password",
        default=None,
        help="Contrasena en claro (min 8). Si se omite, se pide interactivamente.",
    )
    parser.add_argument(
        "--reset-password",
        action="store_true",
        help="Si el usuario ya existe, re-hashea la contrasena. Sin esta flag conserva la actual.",
    )
    args = parser.parse_args()

    password = args.password or getpass.getpass("Contrasena del colaborador: ")
    if len(password) < 8:
        print("ERROR: la contrasena debe tener al menos 8 caracteres.", file=sys.stderr)
        return 2

    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == args.email).first()
        if existing:
            existing.full_name = args.name
            existing.role = UserRole.collaborator
            if args.reset_password:
                existing.password_hash = hash_password(password)
            db.commit()
            print(f"OK — usuario existente actualizado ({existing.email})")
            print(f"     role = {existing.role.value}")
            print(f"     id   = {existing.id}")
            return 0

        user = User(
            email=args.email,
            password_hash=hash_password(password),
            full_name=args.name,
            role=UserRole.collaborator,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        print(f"OK — colaborador creado ({user.email})")
        print(f"     role = {user.role.value}")
        print(f"     id   = {user.id}")
        print()
        print("Pasale la URL publica + credenciales:")
        print("   https://desktop-fdvh.tail71da9a.ts.net")
        print(f"   {args.email} / <contrasena que acabas de poner>")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
