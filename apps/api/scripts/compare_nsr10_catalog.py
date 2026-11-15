"""Compara el catálogo NSR-10 interno (packages/engine) contra el Excel de
referencia `AjusteFHE_V02.xlsx` → hoja `Municipios` (1118 municipios oficiales).

Reporta:
  1. Municipios presentes en ambos — coinciden o difieren en Aa/Av.
  2. Municipios del Excel ausentes en el engine (candidatos a agregar).
  3. Municipios del engine ausentes en el Excel (nombres a revisar).

Normaliza nombres quitando tildes + lowercase + guiones intermedios para matchear
los slugs del engine (`la-pedrera`) con los nombres del Excel (`LA PEDRERA`).

Uso:
    ./.venv/Scripts/python.exe apps/api/scripts/compare_nsr10_catalog.py
"""
from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages" / "engine" / "src"))

import openpyxl  # noqa: E402

from engine.seismic.nsr10_data import MUNICIPIOS  # noqa: E402


EXCEL = ROOT / "AjusteFHE_V02.xlsx"

# Mismos fixups que `regenerate_nsr10_data.py`.
CODE_FIXUPS: dict[int, int] = {
    38820: 68820,  # TONA está en Santander.
}


def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def normalize(name: str) -> str:
    """Normaliza a slug comparable: sin tildes, minúsculas, sin espacios/guiones."""
    s = _strip_accents(str(name)).lower().strip()
    # quita cualquier separador para hacer match tolerante
    for ch in " -_.'":
        s = s.replace(ch, "")
    return s


def load_excel() -> dict[int, dict]:
    """Devuelve dict[code_dane] = {name, code, Aa, Av, zona, key}.

    Usa `code_dane` como key porque es único; el nombre puede repetirse
    (ARMENIA Quindío vs ARMENIA Antioquia) y colapsaría homónimos.
    """
    wb = openpyxl.load_workbook(EXCEL, data_only=True)
    ws = wb["Municipios"]
    out: dict[int, dict] = {}
    for row in ws.iter_rows(min_row=2, values_only=True):
        name = row[0]
        code = row[1]
        aa = row[2]
        av = row[3]
        zona = row[4]
        if name is None or aa is None or av is None:
            continue
        if not isinstance(code, (int, float)):
            continue
        code_int = CODE_FIXUPS.get(int(code), int(code))
        out[code_int] = {
            "name": str(name).strip(),
            "code": code_int,
            "Aa":   float(aa),
            "Av":   float(av),
            "zona": str(zona).strip() if zona else None,
            "key":  normalize(name),
        }
    return out


def load_engine() -> dict[int, dict]:
    """Devuelve dict[code_dane] = {slug, name, dept, Aa, Av, key}."""
    out: dict[int, dict] = {}
    for slug, m in MUNICIPIOS.items():
        code = m.get("code_dane")
        if code is None:
            continue
        out[int(code)] = {
            "slug": slug,
            "name": m["nombre"],
            "dept": m.get("departamento"),
            "Aa":   float(m["Aa"]),
            "Av":   float(m["Av"]),
            "key":  normalize(m["nombre"]),
        }
    return out


def main() -> int:
    excel = load_excel()
    engine = load_engine()

    print(f"=== Comparación catálogo NSR-10 ===")
    print(f"Excel (AjusteFHE_V02):     {len(excel):>5} municipios")
    print(f"Engine (nsr10_data.py):    {len(engine):>5} municipios")
    print()

    only_in_engine  = sorted(set(engine) - set(excel))
    only_in_excel   = sorted(set(excel) - set(engine))
    in_both         = sorted(set(engine) & set(excel))

    # ─── 1. Diferencias de valores en los que están en ambos ───────────────
    exact   = []
    diff_aa = []
    diff_av = []
    diff_both = []
    for k in in_both:
        e = engine[k]
        x = excel[k]
        d_aa = abs(e["Aa"] - x["Aa"]) > 1e-4
        d_av = abs(e["Av"] - x["Av"]) > 1e-4
        if d_aa and d_av:
            diff_both.append((k, e, x))
        elif d_aa:
            diff_aa.append((k, e, x))
        elif d_av:
            diff_av.append((k, e, x))
        else:
            exact.append(k)

    print(f"Presentes en ambos:        {len(in_both):>5}")
    print(f"  ├─ valores coinciden:    {len(exact):>5}")
    print(f"  ├─ difieren solo Aa:     {len(diff_aa):>5}")
    print(f"  ├─ difieren solo Av:     {len(diff_av):>5}")
    print(f"  └─ difieren Aa Y Av:     {len(diff_both):>5}")
    print()
    print(f"Sólo en Excel (faltan):    {len(only_in_excel):>5}")
    print(f"Sólo en Engine (revisar):  {len(only_in_engine):>5}")
    print()

    # ─── 2. Lista de discrepancias ─────────────────────────────────────────
    if diff_both or diff_aa or diff_av:
        print("─── DISCREPANCIAS DE VALORES ───")
        print(f"{'municipio':<28} {'slug engine':<28} {'Aa_eng':>7} {'Aa_xls':>7}  {'Av_eng':>7} {'Av_xls':>7}  flag")
        for k, e, x in sorted(diff_both + diff_aa + diff_av, key=lambda t: t[1]["name"]):
            flag = []
            if abs(e["Aa"] - x["Aa"]) > 1e-4: flag.append("ΔAa")
            if abs(e["Av"] - x["Av"]) > 1e-4: flag.append("ΔAv")
            print(f"{x['name']:<28} {e['slug']:<28} {e['Aa']:>7.3f} {x['Aa']:>7.3f}  {e['Av']:>7.3f} {x['Av']:>7.3f}  {','.join(flag)}")
        print()

    # ─── 3. Resumen de los faltantes por departamento (desde código DANE) ──
    # Primeros 2 dígitos del código DANE = departamento.
    DEPT_CODE = {
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
    by_dept: dict[str, int] = {}
    for k in only_in_excel:
        code = excel[k]["code"]
        if isinstance(code, int):
            dept_code = code // 1000
            dept = DEPT_CODE.get(dept_code, f"?{dept_code}")
        else:
            dept = "sin-code"
        by_dept[dept] = by_dept.get(dept, 0) + 1

    print("─── MUNICIPIOS FALTANTES POR DEPARTAMENTO ───")
    for dept, n in sorted(by_dept.items(), key=lambda t: -t[1]):
        print(f"  {dept:<22} {n:>4}")
    print()

    # ─── 4. Sólo en Engine (posibles nombres a corregir) ───────────────────
    if only_in_engine:
        print(f"─── SÓLO EN ENGINE (revisar nombre, {len(only_in_engine)}) ───")
        for k in only_in_engine[:30]:
            e = engine[k]
            print(f"  {e['slug']:<30} {e['name']:<30} {e.get('dept')}")
        if len(only_in_engine) > 30:
            print(f"  … +{len(only_in_engine) - 30} más")

    return 0


if __name__ == "__main__":
    sys.exit(main())
