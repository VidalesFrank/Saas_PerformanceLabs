"""
Detección de eventos locales de daño en pórticos (fibras).

Para cada elemento, detecta el primer paso en que se cruza un umbral de
deformación material y lo persiste como evento con step/tiempo/ubicación.

Eventos capturados (orden típico de aparición en una columna):

  1. first_yield_bar     : |ε_s| > ε_sy en alguna barra (fluencia del acero)
  2. cover_crush         : ε_c < -ε_cu_cover en el recubrimiento (típ. -0.006)
  3. core_crush          : ε_c < -ε_cu_core en núcleo confinado (del spec Mander)
  4. bar_buckling        : ε_s < -ε_bk compresión de barra longitudinal
                            (Dhakal-Maekawa 2002 simplificado por s/db)
  5. bar_fracture        : ε_s > +ε_su (fractura por tensión)

Entrada principal:
  - `col_sect_def`, `bm_sect_def` capturados en el NPZ del pushover o NLTHA.
    Formato (n_steps, n_elementos, 8): 8 = [axial_i, κz_i, κy_i, torsión_i,
    axial_j, κz_j, κy_j, torsión_j] con convención OpenSees.
  - `spec`: nonlinear_model.json completo (para extraer b, h, cover, εcu,
    posiciones de barras, s/db).
  - `element_lines`: lista con fid, kind, story, b_m, h_m, lp_m — para mapear
    tags de ops a fid "humanos".

Devuelve una lista de eventos y un resumen agregado por tipo.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional

import numpy as np


EventType = Literal[
    "first_yield_bar", "cover_crush", "core_crush",
    "bar_buckling", "bar_fracture",
]

# Umbrales por defecto (sobreescritos por el spec cuando esté disponible)
_DEFAULT_EPS_SY        = 0.0021   # fy=420 / E=200000
_DEFAULT_EPS_SU        = 0.10     # A615 Gr60 nominal
_DEFAULT_EPS_CU_COVER  = 0.006    # recubrimiento no confinado
_DEFAULT_EPS_BK_CONF   = 0.05     # pandeo con s/db ≤ 8 (confinamiento DMO/DES, valor probado)
_DEFAULT_EPS_BK_POOR   = 0.025    # pandeo con s/db > 10 (bajo confinamiento)
# Umbrales del núcleo según s/db — mismo criterio que pandeo: un núcleo bien
# confinado tolera deformaciones mucho mayores antes de aplastarse. Si s/db > 10
# el estribo pierde eficacia y el núcleo se comporta cerca del no-confinado.
_DEFAULT_EPS_CU_CORE_CONF = 0.05  # núcleo bien confinado (s/db ≤ 8)
_DEFAULT_EPS_CU_CORE_POOR = 0.025 # núcleo pobremente confinado (s/db > 10)
_EPS_PRECISION         = 1e-6


# ─────────────────────────────────────────────────────────────────────────────
# Metadata por elemento
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ElementMeta:
    fid:          str
    kind:         str          # "column" | "beam"
    story:        str
    ele_tag:      int
    b_m:          float
    h_m:          float
    cover_m:      float
    # Umbrales material
    eps_cu_core:  float        # εcu núcleo confinado (del spec Mander)
    eps_cu_cover: float        # εcu recubrimiento (típ 0.006)
    eps_sy:       float
    eps_su:       float
    eps_bk:       float        # pandeo del refuerzo (Dhakal-Maekawa simpl.)
    # Posiciones extremas (coordenadas locales, m)
    cover_corners: list[tuple[float, float]]  # 4 esquinas del rect bruto
    core_corners:  list[tuple[float, float]]  # 4 esquinas del núcleo
    bar_positions: list[tuple[float, float]]  # (y, z) de cada barra long.


# ─────────────────────────────────────────────────────────────────────────────
# Construcción de metadata desde el spec
# ─────────────────────────────────────────────────────────────────────────────

def _bar_diam_m(label: str, default: float = 15.9) -> float:
    """#5=15.9 mm, #6=19.1, #7=22.2, #8=25.4, #9=28.7, #10=32.3, #11=35.8."""
    tbl = {"#3": 9.5, "#4": 12.7, "#5": 15.9, "#6": 19.1, "#7": 22.2,
           "#8": 25.4, "#9": 28.7, "#10": 32.3, "#11": 35.8}
    return tbl.get(str(label).strip(), default) / 1000.0


def _buckling_strain(s_mm: float, db_mm: float, ratio: str = "auto") -> float:
    """
    Umbral de pandeo del refuerzo longitudinal.

    Criterio simplificado (adaptado de Dhakal-Maekawa 2002):
      - s/db ≤ 8  → ε_bk = 0.05   (buen confinamiento DMO/DES, valor probado)
      - 8 < s/db ≤ 10 → ε_bk interpolado lineal 0.05 → 0.025
      - s/db > 10 → ε_bk = 0.025  (bajo confinamiento)
    """
    if db_mm <= 0 or s_mm <= 0:
        return _DEFAULT_EPS_BK_CONF
    r = s_mm / db_mm
    if r <= 8.0:
        return _DEFAULT_EPS_BK_CONF
    if r >= 10.0:
        return _DEFAULT_EPS_BK_POOR
    # lineal entre 8 y 10
    t = (r - 8.0) / 2.0
    return _DEFAULT_EPS_BK_CONF + t * (_DEFAULT_EPS_BK_POOR - _DEFAULT_EPS_BK_CONF)


def _core_crush_strain(s_mm: float, db_mm: float) -> float:
    """
    Umbral de aplastamiento del núcleo confinado basado en s/db.

    Un núcleo con s/db ≤ 8 trabaja como confinado efectivo (estribos próximos
    sostienen el concreto más allá de su resistencia nominal), mientras que
    con s/db > 10 el estribo pierde su rol de confinamiento y el núcleo se
    comporta cerca del concreto no-confinado.

      - s/db ≤ 8  → ε_cu,core = 0.05   (confinamiento DMO/DES efectivo)
      - 8 < s/db ≤ 10 → interpolado lineal 0.05 → 0.025
      - s/db > 10 → ε_cu,core = 0.025  (confinamiento ineficaz)

    Esta regla reemplaza al valor Mander-based del spec en el detector de
    eventos post-análisis, para evitar sub-estimar la capacidad del núcleo y
    reportar aplastamientos espurios en elementos bien detallados.
    """
    if db_mm <= 0 or s_mm <= 0:
        return _DEFAULT_EPS_CU_CORE_CONF
    r = s_mm / db_mm
    if r <= 8.0:
        return _DEFAULT_EPS_CU_CORE_CONF
    if r >= 10.0:
        return _DEFAULT_EPS_CU_CORE_POOR
    t = (r - 8.0) / 2.0
    return _DEFAULT_EPS_CU_CORE_CONF + t * (_DEFAULT_EPS_CU_CORE_POOR - _DEFAULT_EPS_CU_CORE_CONF)


def _column_bar_positions(reinf: dict, b: float, h: float, cover: float,
                          db_default_m: float) -> list[tuple[float, float]]:
    """
    Posiciones de barras longitudinales en coordenadas locales (y, z).

    Reglas:
      - Si hay `groups` granular (corners/top/bot/left/right), reparte cada grupo.
      - Si no, usa la distribución típica 1 anillo con n_bars distribuidos
        en caras superior/inferior/laterales (misma lógica que el ops builder).
    """
    long_r = reinf.get("longitudinal", {}) or {}
    groups = long_r.get("groups") or {}
    # Fallback aplanado si está nested bajo "groups"
    if not groups and all(k not in long_r for k in ("corners", "top_face", "bot_face",
                                                     "left_face", "right_face")):
        groups = {}
    out: list[tuple[float, float]] = []

    def _append_edge(n: int, y1: float, z1: float, y2: float, z2: float) -> None:
        if n <= 0:
            return
        for i in range(n):
            t = 0.0 if n == 1 else i / (n - 1)
            out.append((y1 + t * (y2 - y1), z1 + t * (z2 - z1)))

    # Si hay granular: corners + 4 caras con sus propios db
    corners_grp = groups.get("corners") if groups else long_r.get("corners")
    if corners_grp is not None:
        db_corner_m = _bar_diam_m(corners_grp.get("bar_label", "#5"))
        yl = -b / 2.0 + cover + db_corner_m / 2.0
        yh =  b / 2.0 - cover - db_corner_m / 2.0
        zl = -h / 2.0 + cover + db_corner_m / 2.0
        zh =  h / 2.0 - cover - db_corner_m / 2.0
        n_corners = int(corners_grp.get("n_bars", 4))
        if n_corners >= 4:
            out.extend([(yl, zl), (yh, zl), (yl, zh), (yh, zh)])
        # caras: barras intermedias (sin esquinas)
        def _face(key: str, pts_fn):
            g = (groups.get(key) if groups else long_r.get(key)) or {}
            n = int(g.get("n_bars", 0))
            if n <= 0:
                return
            pts_fn(n)
        _face("top_face",   lambda n: _append_edge(n, yl, zh, yh, zh))
        _face("bot_face",   lambda n: _append_edge(n, yl, zl, yh, zl))
        _face("left_face",  lambda n: _append_edge(n, yl, zl, yl, zh))
        _face("right_face", lambda n: _append_edge(n, yh, zl, yh, zh))
        return out

    # Distribución clásica: 1 anillo con n_bars distribuidos
    n_bars = int(long_r.get("n_bars", 8))
    if n_bars < 4:
        return out
    db_m = _bar_diam_m(long_r.get("bar_label", "#5"), default=db_default_m * 1000)
    yl = -b / 2.0 + cover + db_m / 2.0
    yh =  b / 2.0 - cover - db_m / 2.0
    zl = -h / 2.0 + cover + db_m / 2.0
    zh =  h / 2.0 - cover - db_m / 2.0

    n_face = max(2, int(round(n_bars / 4.0)) + 1)
    n_face = min(n_face, (n_bars + 2) // 2)
    n_side_total = max(0, n_bars - 2 * n_face)
    n_side_per_face = n_side_total // 2

    _append_edge(n_face, yl, zh, yh, zh)  # top
    _append_edge(n_face, yl, zl, yh, zl)  # bottom
    if n_side_per_face > 0 and zh > zl:
        _append_edge(n_side_per_face + 2, yl, zl, yl, zh)
        _append_edge(n_side_per_face + 2, yh, zl, yh, zh)
    return out


def _beam_bar_positions(reinf: dict, b: float, h: float, cover: float) -> list[tuple[float, float]]:
    zones = reinf.get("zones", {}) or {}
    end_i = zones.get("end_i", {})
    top   = end_i.get("top", {}) or {}
    bot   = end_i.get("bot", {}) or {}
    n_top = int(top.get("n_bars", 2))
    n_bot = int(bot.get("n_bars", 2))
    db_top = _bar_diam_m(top.get("bar_label", "#5"))
    db_bot = _bar_diam_m(bot.get("bar_label", "#5"))
    yl = -b / 2.0 + cover + max(db_top, db_bot) / 2.0
    yh =  b / 2.0 - cover - max(db_top, db_bot) / 2.0
    z_top =  h / 2.0 - cover - db_top / 2.0
    z_bot = -h / 2.0 + cover + db_bot / 2.0

    out: list[tuple[float, float]] = []
    for i in range(n_top):
        t = 0.0 if n_top == 1 else i / (n_top - 1)
        out.append((yl + t * (yh - yl), z_top))
    for i in range(n_bot):
        t = 0.0 if n_bot == 1 else i / (n_bot - 1)
        out.append((yl + t * (yh - yl), z_bot))
    return out


_OVERRIDE_KEYS = (
    "eps_sy", "eps_cu_cover", "eps_cu_core", "eps_su", "eps_bk",
)


def default_thresholds() -> dict[str, float]:
    """Umbrales globales por defecto que puede sobrescribir el usuario."""
    return {
        "eps_sy":       _DEFAULT_EPS_SY,
        "eps_cu_cover": _DEFAULT_EPS_CU_COVER,
        # Núcleo confinado DMO/DES con s/db≤8 — mismo valor probado que el pandeo.
        "eps_cu_core":  _DEFAULT_EPS_CU_CORE_CONF,
        "eps_su":       _DEFAULT_EPS_SU,
        "eps_bk":       _DEFAULT_EPS_BK_CONF,
    }


def observed_threshold_ranges(elements_meta: dict[str, ElementMeta]) -> dict[str, dict]:
    """
    Devuelve el rango min/max observado por elemento para los umbrales que
    varían entre elementos (ε_cu_core y ε_bk). Útil para informar al usuario
    cuánta heterogeneidad hay antes de forzar un valor global.
    """
    core = [m.eps_cu_core for m in elements_meta.values()]
    bk   = [m.eps_bk       for m in elements_meta.values()]
    def _stats(xs: list[float]) -> dict:
        if not xs:
            return {"min": 0.0, "max": 0.0, "mean": 0.0, "n": 0}
        return {
            "min":  round(float(min(xs)), 5),
            "max":  round(float(max(xs)), 5),
            "mean": round(float(sum(xs) / len(xs)), 5),
            "n":    len(xs),
        }
    return {"eps_cu_core": _stats(core), "eps_bk": _stats(bk)}


def _apply_overrides(meta: ElementMeta, override: Optional[dict]) -> ElementMeta:
    """Sustituye los umbrales globales en una metadata ya construida.

    Solo se aplican las claves presentes en el dict. Claves ausentes conservan
    el valor computado desde el spec (Mander, s/db).
    """
    if not override:
        return meta
    kwargs = {k: getattr(meta, k) for k in _OVERRIDE_KEYS}
    for k in _OVERRIDE_KEYS:
        v = override.get(k)
        if v is None:
            continue
        try:
            kwargs[k] = float(v)
        except (TypeError, ValueError):
            continue
    return ElementMeta(
        fid=meta.fid, kind=meta.kind, story=meta.story, ele_tag=meta.ele_tag,
        b_m=meta.b_m, h_m=meta.h_m, cover_m=meta.cover_m,
        cover_corners=meta.cover_corners, core_corners=meta.core_corners,
        bar_positions=meta.bar_positions, **kwargs,
    )


def build_elements_meta(
    spec: dict,
    element_lines: list[dict],
    thresholds_override: Optional[dict] = None,
) -> dict[str, ElementMeta]:
    """
    Construye el diccionario `fid → ElementMeta` para columnas y vigas del
    spec no lineal. Para cada elemento usa el bloque de confinamiento `end`
    (zona de rótula) porque los eventos de aplastamiento/pandeo ocurren allí.
    """
    out: dict[str, ElementMeta] = {}
    columns = (spec.get("elements", {}) or {}).get("columns", {}) or {}
    beams   = (spec.get("elements", {}) or {}).get("beams",   {}) or {}

    # Mapa fid → ele_tag / story / dimensiones desde element_lines
    el_by_fid: dict[str, dict] = {str(el["fid"]): el for el in element_lines}

    def _meta_for_column(fid: str, col: dict, el: dict) -> ElementMeta:
        geo = col.get("geometry", {}) or {}
        b     = float(geo.get("b_m",     el.get("b_m",     0.30)))
        h     = float(geo.get("h_m",     el.get("h_m",     0.30)))
        cover = float(geo.get("cover_m", 0.040))
        fy_mpa = float(geo.get("fy_MPa", 420.0))

        reinf = col.get("reinforcement", {}) or {}
        tran  = reinf.get("transverse", {}) or {}
        s_conf = float(tran.get("s_confined_mm", 100.0))
        long_r = reinf.get("longitudinal", {}) or {}
        db_mm  = _bar_diam_m(long_r.get("bar_label", "#5")) * 1000.0
        eps_bk = _buckling_strain(s_conf, db_mm)
        # Umbral del núcleo según s/db (criterio consistente con el pandeo).
        # Si el spec expone un ε_cu Mander más conservador se descarta: la
        # evidencia experimental de confinamiento efectivo con s/db≤8 soporta
        # 0.05 como piso real para núcleos DMO/DES bien detallados.
        eps_cu_core = _core_crush_strain(s_conf, db_mm)
        eps_sy = fy_mpa / 200_000.0

        # Esquinas del recubrimiento (cover) y del núcleo
        cover_corners = [(-b/2, -h/2), (b/2, -h/2), (-b/2, h/2), (b/2, h/2)]
        yc1 = -b/2 + cover; yc2 =  b/2 - cover
        zc1 = -h/2 + cover; zc2 =  h/2 - cover
        core_corners  = [(yc1, zc1), (yc2, zc1), (yc1, zc2), (yc2, zc2)]
        bar_positions = _column_bar_positions(reinf, b, h, cover,
                                              _bar_diam_m("#5"))
        return ElementMeta(
            fid=fid, kind="column", story=str(el.get("story", "")),
            ele_tag=int(el.get("ele_tag", 0)),
            b_m=b, h_m=h, cover_m=cover,
            eps_cu_core=eps_cu_core, eps_cu_cover=_DEFAULT_EPS_CU_COVER,
            eps_sy=eps_sy, eps_su=_DEFAULT_EPS_SU, eps_bk=eps_bk,
            cover_corners=cover_corners, core_corners=core_corners,
            bar_positions=bar_positions,
        )

    def _meta_for_beam(fid: str, bm: dict, el: dict) -> ElementMeta:
        geo = bm.get("geometry", {}) or {}
        b     = float(geo.get("b_m",     el.get("b_m",     0.30)))
        h     = float(geo.get("h_m",     el.get("h_m",     0.40)))
        cover = float(geo.get("cover_m", 0.040))
        fy_mpa = float(geo.get("fy_MPa", 420.0))

        reinf = bm.get("reinforcement", {}) or {}
        # Vigas: el spec guarda estribos en `shear` (ver element_data._beam_transverse);
        # columnas en `transverse`. Fallback mutuo para cualquier modelo histórico.
        tran = reinf.get("shear") or reinf.get("transverse") or {}
        s_conf = float(tran.get("s_confined_mm", 100.0))
        top = (reinf.get("zones", {}) or {}).get("end_i", {}).get("top", {}) or {}
        db_mm = _bar_diam_m(top.get("bar_label", "#5")) * 1000.0
        eps_bk = _buckling_strain(s_conf, db_mm)
        # Umbral del núcleo según s/db (ver nota en _meta_for_column).
        eps_cu_core = _core_crush_strain(s_conf, db_mm)
        eps_sy = fy_mpa / 200_000.0

        cover_corners = [(-b/2, -h/2), (b/2, -h/2), (-b/2, h/2), (b/2, h/2)]
        yc1 = -b/2 + cover; yc2 =  b/2 - cover
        zc1 = -h/2 + cover; zc2 =  h/2 - cover
        core_corners  = [(yc1, zc1), (yc2, zc1), (yc1, zc2), (yc2, zc2)]
        bar_positions = _beam_bar_positions(reinf, b, h, cover)
        return ElementMeta(
            fid=fid, kind="beam", story=str(el.get("story", "")),
            ele_tag=int(el.get("ele_tag", 0)),
            b_m=b, h_m=h, cover_m=cover,
            eps_cu_core=eps_cu_core, eps_cu_cover=_DEFAULT_EPS_CU_COVER,
            eps_sy=eps_sy, eps_su=_DEFAULT_EPS_SU, eps_bk=eps_bk,
            cover_corners=cover_corners, core_corners=core_corners,
            bar_positions=bar_positions,
        )

    for fid, col in columns.items():
        el = el_by_fid.get(str(fid))
        if not el or el.get("kind") != "column":
            continue
        out[str(fid)] = _apply_overrides(
            _meta_for_column(str(fid), col, el), thresholds_override,
        )

    for fid, bm in beams.items():
        el = el_by_fid.get(str(fid))
        if not el or el.get("kind") != "beam":
            continue
        out[str(fid)] = _apply_overrides(
            _meta_for_beam(str(fid), bm, el), thresholds_override,
        )

    return out


# ─────────────────────────────────────────────────────────────────────────────
# Detección por paso
# ─────────────────────────────────────────────────────────────────────────────

def _strain_at(y: float, z: float,
               eps_a: float, kz: float, ky: float) -> float:
    """
    Deformación axial de una fibra en coordenadas locales (y, z).

    Convención OpenSees FiberSection3d (ver `FiberSection3d::setTrialSectionDeformation`):
        ε(y, z) = ε_axial + κz · y - κy · z
    """
    return eps_a + kz * y - ky * z


def _end_extreme_strains(
    eps_a: float, kz: float, ky: float,
    corners: list[tuple[float, float]],
) -> tuple[float, float]:
    """Devuelve (ε_max_tension, ε_min_compresion) sobre las esquinas dadas."""
    vals = [_strain_at(y, z, eps_a, kz, ky) for (y, z) in corners]
    return (max(vals), min(vals))


@dataclass
class Event:
    fid:         str
    kind:        str
    story:       str
    step:        int
    time_s:      Optional[float]       # None para pushover
    type:        EventType
    location:    str                   # "end_i" | "end_j"
    strain:      float
    threshold:   float
    direction:   Optional[str] = None  # "X" | "Y" (pushover direccional)

    def to_json(self) -> dict:
        return {
            "fid": self.fid, "kind": self.kind, "story": self.story,
            "step": self.step, "time_s": self.time_s,
            "type": self.type, "location": self.location,
            "strain": round(self.strain, 6),
            "threshold": round(self.threshold, 6),
            "direction": self.direction,
        }


def detect_events_from_history(
    *,
    sect_def:    np.ndarray,          # (n_steps, n_elementos, 8)
    tags:        list[int],            # ele_tag en orden de columnas (o vigas)
    tag_to_fid:  dict[int, str],       # mapa ele_tag → fid
    elements_meta: dict[str, ElementMeta],
    time_vector: Optional[np.ndarray] = None,  # (n_steps,) s si NLTHA
    direction:   Optional[str] = None,
) -> list[Event]:
    """
    Recorre la historia (n_steps, n_elementos, 8) y detecta el primer paso en
    que cada elemento cruza cada umbral. Devuelve lista de eventos únicos.
    """
    if sect_def is None or sect_def.ndim != 3 or sect_def.shape[0] == 0:
        return []
    n_steps, n_el, ncols = sect_def.shape
    if ncols < 7:
        return []

    # First-trip memory: (fid, type, location) → step
    seen: set[tuple[str, EventType, str]] = set()
    events: list[Event] = []

    for e_i in range(n_el):
        tag = tags[e_i] if e_i < len(tags) else -1
        fid = tag_to_fid.get(int(tag))
        if fid is None:
            continue
        meta = elements_meta.get(fid)
        if meta is None:
            continue

        # Para cada paso, evaluar los 2 extremos
        for step in range(n_steps):
            d = sect_def[step, e_i]
            # 8 valores: [axial_i, κz_i, κy_i, torsión_i, axial_j, κz_j, κy_j, torsión_j]
            for end_name, offset in (("end_i", 0), ("end_j", 4)):
                eps_a = float(d[offset + 0])
                kz    = float(d[offset + 1])
                ky    = float(d[offset + 2])

                # Concreto cubierta (recubrimiento)
                _, min_cover = _end_extreme_strains(eps_a, kz, ky,
                                                     meta.cover_corners)
                if min_cover < -meta.eps_cu_cover:
                    key = (fid, "cover_crush", end_name)
                    if key not in seen:
                        seen.add(key)
                        events.append(Event(
                            fid=fid, kind=meta.kind, story=meta.story,
                            step=step, time_s=_time_at(time_vector, step),
                            type="cover_crush", location=end_name,
                            strain=min_cover, threshold=-meta.eps_cu_cover,
                            direction=direction,
                        ))

                # Concreto núcleo confinado
                _, min_core = _end_extreme_strains(eps_a, kz, ky,
                                                    meta.core_corners)
                if min_core < -meta.eps_cu_core:
                    key = (fid, "core_crush", end_name)
                    if key not in seen:
                        seen.add(key)
                        events.append(Event(
                            fid=fid, kind=meta.kind, story=meta.story,
                            step=step, time_s=_time_at(time_vector, step),
                            type="core_crush", location=end_name,
                            strain=min_core, threshold=-meta.eps_cu_core,
                            direction=direction,
                        ))

                # Barras longitudinales
                if meta.bar_positions:
                    bar_strains = [_strain_at(y, z, eps_a, kz, ky)
                                   for (y, z) in meta.bar_positions]
                    eps_bar_min = min(bar_strains)   # máx compresión
                    eps_bar_max = max(bar_strains)   # máx tensión

                    # Primera fluencia
                    if max(abs(eps_bar_min), abs(eps_bar_max)) > meta.eps_sy:
                        key = (fid, "first_yield_bar", end_name)
                        if key not in seen:
                            seen.add(key)
                            events.append(Event(
                                fid=fid, kind=meta.kind, story=meta.story,
                                step=step, time_s=_time_at(time_vector, step),
                                type="first_yield_bar", location=end_name,
                                strain=eps_bar_min if abs(eps_bar_min) > abs(eps_bar_max)
                                        else eps_bar_max,
                                threshold=meta.eps_sy, direction=direction,
                            ))

                    # Pandeo (compresión)
                    if eps_bar_min < -meta.eps_bk:
                        key = (fid, "bar_buckling", end_name)
                        if key not in seen:
                            seen.add(key)
                            events.append(Event(
                                fid=fid, kind=meta.kind, story=meta.story,
                                step=step, time_s=_time_at(time_vector, step),
                                type="bar_buckling", location=end_name,
                                strain=eps_bar_min, threshold=-meta.eps_bk,
                                direction=direction,
                            ))

                    # Fractura (tensión)
                    if eps_bar_max > meta.eps_su:
                        key = (fid, "bar_fracture", end_name)
                        if key not in seen:
                            seen.add(key)
                            events.append(Event(
                                fid=fid, kind=meta.kind, story=meta.story,
                                step=step, time_s=_time_at(time_vector, step),
                                type="bar_fracture", location=end_name,
                                strain=eps_bar_max, threshold=meta.eps_su,
                                direction=direction,
                            ))

    # Ordenar por paso
    events.sort(key=lambda e: (e.step, e.fid, e.location))
    return events


def _time_at(t_vec: Optional[np.ndarray], step: int) -> Optional[float]:
    if t_vec is None:
        return None
    if step < 0 or step >= len(t_vec):
        return None
    return float(t_vec[step])


# ─────────────────────────────────────────────────────────────────────────────
# API alto nivel
# ─────────────────────────────────────────────────────────────────────────────

def detect_events_pushover(
    *, npz_path: str, spec: dict, element_lines: list[dict],
    direction: str, thresholds_override: Optional[dict] = None,
) -> dict:
    """Carga el NPZ del pushover y devuelve `{events, summary}`."""
    data = np.load(npz_path, allow_pickle=False)
    elements_meta = build_elements_meta(spec, element_lines, thresholds_override)
    tag_to_fid: dict[int, str] = {
        int(el["ele_tag"]): str(el["fid"]) for el in element_lines
    }

    col_tags = [int(x) for x in data["col_tags"]] if "col_tags" in data.files else []
    bm_tags  = [int(x) for x in data["bm_tags"]]  if "bm_tags"  in data.files else []

    events: list[Event] = []
    if "col_sect_def" in data.files and col_tags:
        events += detect_events_from_history(
            sect_def=data["col_sect_def"], tags=col_tags,
            tag_to_fid=tag_to_fid, elements_meta=elements_meta,
            time_vector=None, direction=direction,
        )
    if "bm_sect_def" in data.files and bm_tags:
        events += detect_events_from_history(
            sect_def=data["bm_sect_def"], tags=bm_tags,
            tag_to_fid=tag_to_fid, elements_meta=elements_meta,
            time_vector=None, direction=direction,
        )
    return _finalize(events)


def detect_events_nlth(
    *, npz_path: str, spec: dict, element_lines: list[dict],
    thresholds_override: Optional[dict] = None,
) -> dict:
    """
    Carga el NPZ de NLTHA (que debe tener `sect_def` capturado con stride) y
    devuelve `{events, summary}` con tiempo en segundos (no step index).

    `thresholds_override` sustituye los umbrales globales calculados desde el
    spec/geometría; útil para re-evaluar sin re-correr el NLTHA.
    """
    data = np.load(npz_path, allow_pickle=False)
    if "sect_def" not in data.files:
        return {"events": [], "summary": _empty_summary(),
                "status": "no_sect_def_captured"}

    elements_meta = build_elements_meta(spec, element_lines, thresholds_override)
    tag_to_fid: dict[int, str] = {
        int(el["ele_tag"]): str(el["fid"]) for el in element_lines
    }
    tags = [int(x) for x in data["sect_tags"]] if "sect_tags" in data.files else []
    t_sampled = data["sect_t"] if "sect_t" in data.files else None

    events = detect_events_from_history(
        sect_def=data["sect_def"], tags=tags,
        tag_to_fid=tag_to_fid, elements_meta=elements_meta,
        time_vector=t_sampled, direction=None,
    )
    out = _finalize(events)
    # Metadata para el panel editable del frontend. `user_override` guarda lo
    # que el usuario mandó; `defaults` y `observed` ayudan a elegir sliders
    # (los dos últimos son por elemento, no un único valor global).
    out["thresholds_user_override"] = {k: float(v) for k, v in (thresholds_override or {}).items()
                                        if v is not None and k in _OVERRIDE_KEYS}
    out["thresholds_defaults"] = default_thresholds()
    out["thresholds_observed"] = observed_threshold_ranges(elements_meta)
    return out


def _finalize(events: list[Event]) -> dict:
    """Serializa + agrega resumen."""
    summary = _empty_summary()
    for e in events:
        summary[e.type] = summary.get(e.type, 0) + 1
    return {
        "events": [e.to_json() for e in events],
        "summary": summary,
        "status": "success",
    }


def _empty_summary() -> dict[str, int]:
    return {
        "first_yield_bar": 0, "cover_crush": 0, "core_crush": 0,
        "bar_buckling": 0, "bar_fracture": 0,
    }
