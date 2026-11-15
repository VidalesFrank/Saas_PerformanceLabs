"""Regenera la sección MUNICIPIOS de `nsr10_data.py` desde el Excel oficial
`AjusteFHE_V02.xlsx` (hoja `Municipios`, 1029 municipios con Aa/Av actualizados
por los decretos complementarios del NSR-10).

Preserva intacto:
  - Encabezado + docstring + SOIL_TYPES.
  - Tablas Fa/Fv + breakpoints.
  - MICROZONIFICACION + helpers (zona_sismica, buscar_municipios, …).

Añade:
  - Campo `code_dane` (del Excel).
  - Campo `zona` ("ALTA" / "INTERMEDIA" / "BAJA") del Excel.
  - `lat/lon` heredados del engine previo para los municipios que ya existían.

Hace backup `.backup_<timestamp>.py` del archivo original antes de escribir.

Uso:
    ./.venv/Scripts/python.exe apps/api/scripts/regenerate_nsr10_data.py
"""
from __future__ import annotations

import re
import sys
import shutil
import unicodedata
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "engine" / "src"))

import openpyxl  # noqa: E402

TARGET = ROOT / "packages" / "engine" / "src" / "engine" / "seismic" / "nsr10_data.py"
EXCEL  = ROOT / "AjusteFHE_V02.xlsx"

# Primeros 2 dígitos del código DANE → nombre departamento.
DEPT_CODE: dict[int, str] = {
    5: "Antioquia", 8: "Atlántico", 11: "Bogotá D.C.", 13: "Bolívar",
    15: "Boyacá", 17: "Caldas", 18: "Caquetá", 19: "Cauca",
    20: "Cesar", 23: "Córdoba", 25: "Cundinamarca", 27: "Chocó",
    41: "Huila", 44: "La Guajira", 47: "Magdalena", 50: "Meta",
    52: "Nariño", 54: "Norte de Santander", 63: "Quindío",
    66: "Risaralda", 68: "Santander", 70: "Sucre", 73: "Tolima",
    76: "Valle del Cauca", 81: "Arauca", 85: "Casanare",
    86: "Putumayo", 88: "San Andrés", 91: "Amazonas", 94: "Guainía",
    95: "Guaviare", 97: "Vaupés", 99: "Vichada",
}

# Mapa de corrección para tildes graves mal codificadas (cp1252 vs utf-8).
GRAVE_TO_ACUTE = str.maketrans({"À": "Á", "È": "É", "Ì": "Í", "Ò": "Ó", "Ù": "Ú"})

# Typos de códigos DANE en el Excel → código correcto.
CODE_FIXUPS: dict[int, int] = {
    38820: 68820,  # TONA está en Santander (no existe depto 38).
}

# Overrides manuales por código DANE: (slug_canónico, nombre_display).
# Cubre las 32 capitales de departamento con nombres oficiales + tildes.
NAME_OVERRIDES: dict[int, tuple[str, str]] = {
    5001:  ("medellin",     "Medellín"),
    8001:  ("barranquilla", "Barranquilla"),
    11001: ("bogota",       "Bogotá D.C."),
    13001: ("cartagena",    "Cartagena de Indias"),
    15001: ("tunja",        "Tunja"),
    17001: ("manizales",    "Manizales"),
    18001: ("florencia",    "Florencia"),
    19001: ("popayan",      "Popayán"),
    20001: ("valledupar",   "Valledupar"),
    23001: ("monteria",     "Montería"),
    27001: ("quibdo",       "Quibdó"),
    41001: ("neiva",        "Neiva"),
    44001: ("riohacha",     "Riohacha"),
    47001: ("santa-marta",  "Santa Marta"),
    50001: ("villavicencio","Villavicencio"),
    52001: ("pasto",        "San Juan de Pasto"),
    54001: ("cucuta",       "Cúcuta"),
    63001: ("armenia",      "Armenia"),
    66001: ("pereira",      "Pereira"),
    68001: ("bucaramanga",  "Bucaramanga"),
    70001: ("sincelejo",    "Sincelejo"),
    73001: ("ibague",       "Ibagué"),
    76001: ("cali",         "Santiago de Cali"),
    81001: ("arauca",       "Arauca"),
    85001: ("yopal",        "Yopal"),
    86001: ("mocoa",        "Mocoa"),
    88001: ("san-andres",   "San Andrés"),
    91001: ("leticia",      "Leticia"),
    94001: ("inirida",      "Inírida"),
    95001: ("san-jose-del-guaviare", "San José del Guaviare"),
    97001: ("mitu",         "Mitú"),
    99001: ("puerto-carreno","Puerto Carreño"),
}


def strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def fix_accents(name: str) -> str:
    """Corrige tildes graves mal codificadas → agudas (CIÈNAGA → CIÉNAGA)."""
    return str(name).translate(GRAVE_TO_ACUTE)


def to_title_case(name: str) -> str:
    """Convierte 'AGUSTÍN CODAZZI' → 'Agustín Codazzi' con pequeñas correcciones."""
    s = fix_accents(name).strip().lower()
    # Palabras que deben quedar en minúsculas (conectores).
    MINOR = {"de", "del", "la", "las", "los", "y", "al", "en"}
    out = []
    for i, w in enumerate(s.split()):
        if i > 0 and w in MINOR:
            out.append(w)
        else:
            out.append(w.capitalize())
    return " ".join(out)


def to_slug(name: str, dept: str | None = None) -> str:
    """Nombre → slug URL-safe. Pasa 'Agustín Codazzi' → 'agustin-codazzi'."""
    base = strip_accents(fix_accents(name)).lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-")
    return base


def normalize_match(name: str) -> str:
    """Clave para matchear sin tildes/espacios/guiones/paréntesis."""
    s = strip_accents(fix_accents(name)).lower()
    s = re.sub(r"\(.*?\)", "", s)  # quita contenido entre paréntesis
    for ch in " -_.'":
        s = s.replace(ch, "")
    return s.strip()


def load_excel() -> list[dict]:
    """Devuelve la lista de municipios del Excel con campos normalizados."""
    wb = openpyxl.load_workbook(EXCEL, data_only=True)
    ws = wb["Municipios"]
    rows: list[dict] = []
    for row in ws.iter_rows(min_row=2, values_only=True):
        name, code, aa, av, zona = row[0], row[1], row[2], row[3], row[4]
        if name is None or aa is None or av is None:
            continue
        code_fixed = None
        if isinstance(code, (int, float)):
            code_fixed = CODE_FIXUPS.get(int(code), int(code))
        rows.append({
            "name":  to_title_case(name),
            "raw":   str(name).strip(),
            "code":  code_fixed,
            "Aa":    round(float(aa), 3),
            "Av":    round(float(av), 3),
            "zona":  str(zona).strip() if zona else None,
            "match": normalize_match(name),
        })
    return rows


# ─── Lectura del engine actual para heredar lat/lon ──────────────────────────
def load_engine_latlon() -> dict[str, tuple[float, float, str]]:
    """Devuelve dict[match_key] → (lat, lon, slug_actual)."""
    from engine.seismic.nsr10_data import MUNICIPIOS
    out: dict[str, tuple[float, float, str]] = {}
    for slug, m in MUNICIPIOS.items():
        key = normalize_match(m["nombre"])
        lat = m.get("lat")
        lon = m.get("lon")
        if lat is not None and lon is not None:
            out[key] = (float(lat), float(lon), slug)
    return out


# ─── Generación del nuevo bloque MUNICIPIOS ──────────────────────────────────
def render_municipios_block(excel_rows: list[dict], engine_latlon: dict) -> tuple[str, dict]:
    """Devuelve (texto_python, stats)."""
    # Agrupa por departamento.
    by_dept: dict[str, list[dict]] = {}
    unknown_dept: list[dict] = []
    for r in excel_rows:
        if r["code"] is None:
            unknown_dept.append(r)
            continue
        dept_code = r["code"] // 1000
        dept = DEPT_CODE.get(dept_code)
        if dept is None:
            unknown_dept.append(r)
            continue
        by_dept.setdefault(dept, []).append(r)

    # Agrupa homónimos para decidir quién lleva el slug base (sin sufijo).
    # Regla: el municipio cuyo code DANE termina en 001 (capital del depto) gana.
    # Si ninguno es capital, el menor code DANE gana.
    homonyms: dict[str, list[tuple[int, str, dict]]] = {}
    for dept, rows in by_dept.items():
        for r in rows:
            base = to_slug(r["name"])
            homonyms.setdefault(base, []).append((r["code"] or 10**9, dept, r))

    winners: dict[int, str] = {}  # code_dane → slug (solo para los winners de homónimos)
    for base, cands in homonyms.items():
        # Preferencia: capital de depto (code % 1000 == 1), luego menor code.
        cands.sort(key=lambda t: (0 if (t[0] % 1000) == 1 else 1, t[0]))
        winner_code = cands[0][0]
        winners[winner_code] = base

    slug_used: set[str] = set()
    def resolve_slug(name: str, dept: str, code: int | None) -> str:
        # Override explícito por código DANE (capitales nacionales).
        if code is not None and code in NAME_OVERRIDES:
            forced = NAME_OVERRIDES[code][0]
            slug_used.add(forced)
            return forced
        base = to_slug(name)
        cands = homonyms.get(base, [])
        is_homonym = len(cands) > 1
        is_winner  = code is not None and winners.get(code) == base
        # Slug base sólo para ganadores o nombres únicos.
        if (not is_homonym) or is_winner:
            if base not in slug_used:
                slug_used.add(base)
                return base
        # Perdedores de homónimos van a sufijo con el código DANE del depto.
        suffix = to_slug(dept).split("-")[0][:4]
        cand = f"{base}-{suffix}"
        if cand not in slug_used:
            slug_used.add(cand)
            return cand
        n = 2
        while f"{base}-{suffix}-{n}" in slug_used:
            n += 1
        slug_used.add(f"{base}-{suffix}-{n}")
        return f"{base}-{suffix}-{n}"

    def display_name(r: dict) -> str:
        code = r["code"]
        if code is not None and code in NAME_OVERRIDES:
            return NAME_OVERRIDES[code][1]
        return r["name"]

    lines: list[str] = ["MUNICIPIOS: dict[str, dict] = {"]
    inherited_latlon = 0
    for dept in sorted(by_dept.keys()):
        lines.append("")
        lines.append(f"    # ===== {dept.upper()} =====")
        rows = sorted(by_dept[dept], key=lambda r: r["name"])
        for r in rows:
            slug = resolve_slug(r["name"], dept, r["code"])
            latlon = engine_latlon.get(r["match"])
            if latlon is not None:
                lat, lon, _ = latlon
                inherited_latlon += 1
                latlon_s = f'"lat": {lat}, "lon": {lon}'
            else:
                latlon_s = '"lat": None, "lon": None'
            code_s = f'"code_dane": {r["code"]}' if r["code"] is not None else '"code_dane": None'
            zona_s = f'"zona": "{r["zona"]}"' if r["zona"] else '"zona": None'
            name_s = display_name(r).replace('"', '\\"')
            lines.append(
                f'    "{slug}": {{"nombre": "{name_s}", "departamento": "{dept}", '
                f'"Aa": {r["Aa"]:.3f}, "Av": {r["Av"]:.3f}, {latlon_s}, '
                f'{code_s}, {zona_s}}},'
            )
    if unknown_dept:
        lines.append("")
        lines.append("    # ===== SIN DEPARTAMENTO IDENTIFICABLE =====")
        for r in unknown_dept:
            slug = resolve_slug(r["name"], "zz", r["code"])
            lines.append(
                f'    "{slug}": {{"nombre": "{r["name"]}", "departamento": "N/D", '
                f'"Aa": {r["Aa"]:.3f}, "Av": {r["Av"]:.3f}, '
                f'"lat": None, "lon": None, "code_dane": None, '
                f'"zona": "{r["zona"]}" }},'
            )
    lines.append("}")
    text = "\n".join(lines) + "\n"
    stats = {
        "n_total":         len(excel_rows),
        "n_unknown_dept":  len(unknown_dept),
        "n_latlon_hered":  inherited_latlon,
        "n_depts":         len(by_dept),
    }
    return text, stats


# ─── Reemplaza el bloque MUNICIPIOS en el archivo preservando todo lo demás ──
def main() -> int:
    excel_rows    = load_excel()
    engine_latlon = load_engine_latlon()
    new_block, stats = render_municipios_block(excel_rows, engine_latlon)

    original = TARGET.read_text(encoding="utf-8")

    # Encuentra la región exacta MUNICIPIOS: dict[...] = { … }\n (tolerante a saltos).
    pattern = re.compile(r"MUNICIPIOS: dict\[str, dict\] = \{.*?^\}\s*\n", re.DOTALL | re.MULTILINE)
    match = pattern.search(original)
    if match is None:
        print("ERROR: no se encontró el bloque MUNICIPIOS en el archivo.", file=sys.stderr)
        return 2

    updated = original[:match.start()] + new_block + original[match.end():]

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = TARGET.with_suffix(f".backup_{stamp}.py")
    shutil.copy2(TARGET, backup)
    TARGET.write_text(updated, encoding="utf-8")

    print(f"✓ Backup creado:       {backup.name}")
    print(f"✓ Archivo actualizado: {TARGET.name}")
    print()
    print(f"  Municipios escritos:        {stats['n_total']}")
    print(f"  Con lat/lon heredado:       {stats['n_latlon_hered']}")
    print(f"  Departamentos:              {stats['n_depts']}")
    print(f"  Sin departamento (N/D):     {stats['n_unknown_dept']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
