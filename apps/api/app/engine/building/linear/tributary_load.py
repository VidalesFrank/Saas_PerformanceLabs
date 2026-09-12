"""
TributaryLoadComputer — Módulo 1: Distribución de cargas de losa a elementos estructurales.

Implementa el método de líneas de 45° (NSR-10 C.13 / ACI 318-19 §8.10) para
losas en dos direcciones y carga uniforme simple para losas en una dirección.

Definiciones:
  a = span corto  (lado del panel de losa con menor longitud libre)
  b = span largo  (lado mayor)
  ratio = b/a

Distribuciones resultantes por borde:
  Losa 1 dirección (ratio > 2):
    Bordes lado corto: carga uniforme q = w · a/2     [kN/m]
    Bordes lado largo: q = 0

  Losa 2 direcciones (ratio ≤ 2):
    Bordes LARGOS (paralelos al span largo, perp_span = a):
      Distribución trapezoidal; equivalente uniforme:
        q_equiv = w · a/2 · (1 - a/(2·b))             [kN/m]
    Bordes CORTOS (paralelos al span corto, perp_span = b):
      Distribución triangular; equivalente uniforme:
        q_equiv = w · a/4                              [kN/m]

Verificación de equilibrio:
  2·q_long·b + 2·q_short·a = w·a·b  ✓

Unidades de entrada: m, kN/m², de salida: kN/m (marcos), kN (nodos).
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np


# ── Clasificación de patrones de carga ────────────────────────────────────────

_DEAD_KEYS = {'cm', 'dead', 'dl', 'd', 'permanente', 'muerta', 'sobrecarga permanente'}
_LIVE_KEYS = {'cv', 'live', 'll', 'l', 'variable', 'viva', 'uso'}


def _classify_pattern(name: str) -> str | None:
    """Retorna 'dead', 'live' o None si no reconoce el patrón."""
    n = name.lower().strip()
    if any(k in n for k in _DEAD_KEYS):
        return 'dead'
    if any(k in n for k in _LIVE_KEYS):
        return 'live'
    return None


# ── Carga de intensidades desde raw_data ──────────────────────────────────────

def load_slab_intensities(raw_data: dict) -> dict[str, dict]:
    """
    Lee la hoja 'Shell Loads - Uniform' y agrupa por element label (Unique Name).
    Retorna: {elem_label: {"dead_kNm2": float, "live_kNm2": float}}
    """
    import pandas as pd

    df = None
    for key in ('Shell Loads - Uniform',
                'TABLE:  "SHELL LOADS - UNIFORM"'):
        candidate = raw_data.get(key)
        if isinstance(candidate, pd.DataFrame) and not candidate.empty:
            df = candidate
            break
    if df is None:
        return {}

    # Descartar filas de unidades (Load no numérico)
    df = df[pd.to_numeric(df.get('Load', pd.Series(dtype=float)),
                          errors='coerce').notna()].copy()

    intensities: dict[str, dict] = {}
    for _, row in df.iterrows():
        # El label del elemento es 'Unique Name'; 'Label' es el label de objeto (F1, F3…)
        elem_label = str(row.get('Unique Name', '')).strip()
        if not elem_label or elem_label in ('nan', 'None', ''):
            continue

        pattern = str(row.get('Load Pattern', '')).strip()
        category = _classify_pattern(pattern)
        if category is None:
            continue

        try:
            val = float(row.get('Load', 0) or 0)
        except (TypeError, ValueError):
            continue

        if elem_label not in intensities:
            intensities[elem_label] = {'dead_kNm2': 0.0, 'live_kNm2': 0.0}
        intensities[elem_label][f'{category}_kNm2'] += val

    return intensities


# ── Geometría 2D de cuadrilátero ──────────────────────────────────────────────

def _dist2(p1: tuple, p2: tuple) -> float:
    return math.sqrt((p2[0] - p1[0]) ** 2 + (p2[1] - p1[1]) ** 2)


def _midpoint(p1: tuple, p2: tuple) -> tuple:
    return ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)


def _polygon_area(pts: list[tuple]) -> float:
    """Área de un polígono cualquiera por fórmula de Gauss (shoelace)."""
    n = len(pts)
    if n < 3:
        return 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        area += pts[i][0] * pts[j][1]
        area -= pts[j][0] * pts[i][1]
    return abs(area) / 2.0


# Alias retrocompat
_quad_area = _polygon_area


def _polygon_obb(pts: list[tuple]) -> tuple[float, float, tuple, tuple]:
    """
    Oriented Bounding Box del polígono aliniado con su eje principal de
    inercia (PCA sobre los vértices). Retorna:
      (a_short, b_long, u_short, u_long)
    con `a_short ≤ b_long` y `u_short ⟂ u_long` vectores unitarios 2D.

    Para polígonos irregulares (formas en L, T, U) esta aproximación
    ignora la concavidad y trabaja con el rectángulo circunscrito
    orientado. El error se compensa escalando las cargas por el ratio
    de áreas (área real / área OBB) para preservar la carga total.
    """
    xy = np.asarray(pts, dtype=float)
    if len(xy) < 2:
        return 0.0, 0.0, (1.0, 0.0), (0.0, 1.0)
    centroid = xy.mean(axis=0)
    centered = xy - centroid
    try:
        _, _, vh = np.linalg.svd(centered, full_matrices=False)
    except np.linalg.LinAlgError:
        return 0.0, 0.0, (1.0, 0.0), (0.0, 1.0)
    # vh[0] = dirección de mayor varianza (eje largo)
    u_long  = tuple(float(v) for v in vh[0])
    u_short = tuple(float(v) for v in vh[1])
    proj_long  = centered @ np.asarray(u_long)
    proj_short = centered @ np.asarray(u_short)
    b = float(proj_long.max()  - proj_long.min())
    a = float(proj_short.max() - proj_short.min())
    if a > b:
        a, b = b, a
        u_short, u_long = u_long, u_short
    return a, b, u_short, u_long


# ── Clase principal ───────────────────────────────────────────────────────────

class TributaryLoadComputer:
    """
    Calcula las cargas tributarias de losas a vigas y muros usando el método
    de líneas de 45° para losas bidireccionales.

    Parámetros
    ----------
    model           : modelo canónico dict (salida de CanonicalModelBuilder)
    slab_intensities: {element_label: {"dead_kNm2": float, "live_kNm2": float}}
                      (salida de load_slab_intensities)
    """

    TWO_WAY_THRESHOLD = 2.0   # ratio b/a máximo para losa 2 direcciones

    def __init__(self, model: dict, slab_intensities: dict):
        self._m  = model
        self._si = slab_intensities

        # Índices de búsqueda → construidos en _build_indices()
        self._beam_edges: dict[frozenset, str] = {}   # frozenset({ji,jj}) → frame_label
        self._wall_top_edges: dict[frozenset, str] = {}  # frozenset({j2,j3}) → shell_label

    # ── API pública ───────────────────────────────────────────────────────────

    def compute(self) -> dict:
        """
        Retorna:
        {
            "frame_loads":     {frame_label: {"dead_kNm": float, "live_kNm": float}},
            "node_loads":      {joint_label: {"dead_kN":  float, "live_kN":  float}},
            "summary": {
                "total_dead_kN": float,
                "total_live_kN": float,
                "slab_count":    int,
                "story_loads":   {story: {"dead_kN": float, "live_kN": float}},
                "slab_details":  [{label, story, area_m2, w_dead, w_live,
                                   one_way, ratio, ...}],
            }
        }
        """
        self._build_indices()

        frame_loads: dict[str, dict] = {}
        node_loads:  dict[str, dict] = {}
        story_loads: dict[str, dict] = {}
        slab_details: list[dict] = []

        joints  = self._m.get('joints', {})
        shells  = self._m.get('shells', {})

        for elem_label, sd in shells.items():
            if sd.get('element_type') != 'slab':
                continue

            joint_labels = sd.get('joints', [])
            if len(joint_labels) < 3:
                continue

            # Intensidades de carga para esta losa
            intensity = self._si.get(elem_label, {})
            if not intensity:
                # Intentar por area_label si el element_label no coincide
                area_lbl = sd.get('area_label', '')
                intensity = self._si.get(area_lbl, {})
            w_dead = intensity.get('dead_kNm2', 0.0)
            w_live = intensity.get('live_kNm2', 0.0)

            if w_dead == 0.0 and w_live == 0.0:
                continue  # sin carga → ignorar

            # Coordenadas XY de todos los joints del polígono (N vértices)
            pts = []
            valid_labels = []
            for lbl in joint_labels:
                jd = joints.get(lbl, {})
                if not jd:
                    continue
                pts.append((float(jd.get('x', 0.0)), float(jd.get('y', 0.0))))
                valid_labels.append(lbl)

            if len(pts) < 3:
                continue

            # Reasigna joint_labels a los que tienen coordenadas válidas
            joint_labels = valid_labels

            # Área y geometría de la losa
            area_m2 = _polygon_area(pts)
            story   = sd.get('story', '')

            # Acumular por piso
            if story not in story_loads:
                story_loads[story] = {'dead_kN': 0.0, 'live_kN': 0.0}

            # Calcular cargas por borde con método de 45°
            edge_loads = self._compute_edge_loads(pts, w_dead, w_live,
                                                   joint_labels, story)
            detail = {'label': elem_label, 'story': story,
                      'area_m2': round(area_m2, 3),
                      'w_dead_kNm2': w_dead, 'w_live_kNm2': w_live}

            for i, eload in enumerate(edge_loads):
                j_a = joint_labels[i]
                j_b = joint_labels[(i + 1) % len(joint_labels)]
                edge_key = frozenset({j_a, j_b})
                edge_len = _dist2(pts[i], pts[(i + 1) % len(pts)])

                d_total = eload['dead_kNm'] * edge_len
                l_total = eload['live_kNm'] * edge_len
                story_loads[story]['dead_kN'] += d_total
                story_loads[story]['live_kN'] += l_total

                if edge_key in self._beam_edges:
                    # ── Borde sobre viga ─────────────────────────────────────
                    fl = edge_key
                    label = self._beam_edges[edge_key]
                    if label not in frame_loads:
                        frame_loads[label] = {'dead_kNm': 0.0, 'live_kNm': 0.0}
                    frame_loads[label]['dead_kNm'] += eload['dead_kNm']
                    frame_loads[label]['live_kNm'] += eload['live_kNm']

                elif edge_key in self._wall_top_edges:
                    # ── Borde sobre muro: fuerza nodal en los 2 joints del borde ──
                    for jlbl in (j_a, j_b):
                        if jlbl not in node_loads:
                            node_loads[jlbl] = {'dead_kN': 0.0, 'live_kN': 0.0}
                        node_loads[jlbl]['dead_kN'] += d_total / 2
                        node_loads[jlbl]['live_kN'] += l_total / 2

                else:
                    # Borde libre o sin elemento identificado:
                    # Repartir a los joints del borde como cargas nodales
                    for jlbl in (j_a, j_b):
                        if jlbl not in node_loads:
                            node_loads[jlbl] = {'dead_kN': 0.0, 'live_kN': 0.0}
                        node_loads[jlbl]['dead_kN'] += d_total / 2
                        node_loads[jlbl]['live_kN'] += l_total / 2

            slab_details.append(detail)

        # Totales
        total_dead = sum(v['dead_kN'] for v in story_loads.values())
        total_live = sum(v['live_kN'] for v in story_loads.values())

        return {
            'frame_loads': frame_loads,
            'node_loads':  node_loads,
            'summary': {
                'total_dead_kN': round(total_dead, 2),
                'total_live_kN': round(total_live, 2),
                'slab_count':    len(slab_details),
                'story_loads':   {s: {k: round(v, 2) for k, v in d.items()}
                                  for s, d in story_loads.items()},
                'slab_details':  slab_details,
            },
        }

    # ── Construcción de índices ───────────────────────────────────────────────

    def _build_indices(self) -> None:
        frames = self._m.get('frames', {})
        shells = self._m.get('shells', {})
        joints = self._m.get('joints', {})

        # Índice de vigas: par de joints → frame_label
        # Solo elementos horizontales (beams): dz pequeño comparado con dxy
        for label, fd in frames.items():
            ji = fd['joint_i']
            jj = fd['joint_j']
            ji_d = joints.get(ji, {})
            jj_d = joints.get(jj, {})
            dz  = abs(float(jj_d.get('z', 0)) - float(ji_d.get('z', 0)))
            dxy = math.sqrt(
                (float(jj_d.get('x', 0)) - float(ji_d.get('x', 0))) ** 2 +
                (float(jj_d.get('y', 0)) - float(ji_d.get('y', 0))) ** 2
            )
            if dz < dxy:  # elemento horizontal = viga
                key = frozenset({ji, jj})
                self._beam_edges[key] = label

        # Índice de borde superior de muros: (j2, j3) → shell_label
        # joints[2] y joints[3] están en la historia actual (parte superior del muro)
        for label, sd in shells.items():
            if sd.get('element_type') != 'wall':
                continue
            js = sd.get('joints', [])
            if len(js) >= 4:
                key = frozenset({js[2], js[3]})
                self._wall_top_edges[key] = label

    # ── Método de 45°: carga equivalente por borde ────────────────────────────

    def _compute_edge_loads(
        self,
        pts:          list[tuple],
        w_dead:       float,
        w_live:       float,
        joint_labels: list[str],
        story:        str,
    ) -> list[dict]:
        """
        Para un polígono de N ≥ 3 vértices, calcula la carga uniforme
        equivalente por arista usando el método de líneas de 45° sobre
        el rectángulo equivalente OBB (Oriented Bounding Box) del polígono.

        Simplificación de ingeniería:
          1. OBB alineado con eje principal de inercia → dimensiones (a, b).
          2. Se calcula la carga estándar por unidad de longitud de los
             lados corto/largo del OBB (fórmulas clásicas 45°).
          3. Cada arista real se clasifica como "paralela al lado corto"
             o "paralela al lado largo" según su dirección (|u_edge·u_long|).
          4. La carga total del polígono (w·A_poly) se conserva escalando
             las cargas por A_poly / A_obb — compensa la sobreestimación
             cuando el polígono es cóncavo (formas en L, T, U).

        Retorna lista de N dicts: [{dead_kNm, live_kNm}, ...] alineada a
        las aristas i→i+1 del polígono.
        """
        n = len(pts)
        if n < 3:
            return []

        a, b, u_short, u_long = _polygon_obb(pts)
        if a < 0.01 or b < 0.01:
            return [{'dead_kNm': 0.0, 'live_kNm': 0.0} for _ in range(n)]

        area_poly = _polygon_area(pts)
        area_obb  = a * b
        scale = (area_poly / area_obb) if area_obb > 1e-9 else 1.0

        is_two_way = (b / a) <= self.TWO_WAY_THRESHOLD

        # Carga por unidad de longitud según el método clásico de 45°
        # (referida al rectángulo OBB, se escala luego por A_poly / A_obb).
        if is_two_way:
            q_short_dead = w_dead * a / 4.0                    # triangular
            q_short_live = w_live * a / 4.0
            q_long_dead  = w_dead * (a / 2) * (1.0 - a / (2 * b))  # trapezoidal
            q_long_live  = w_live * (a / 2) * (1.0 - a / (2 * b))
        else:
            # Losa unidireccional: la carga viaja hacia los lados CORTOS
            # del rectángulo (los que son paralelos a u_long).
            q_short_dead = 0.0
            q_short_live = 0.0
            q_long_dead  = w_dead * a / 2
            q_long_live  = w_live * a / 2

        u_long_arr = np.asarray(u_long)
        edge_loads: list[dict] = []
        for i in range(n):
            x1, y1 = pts[i]
            x2, y2 = pts[(i + 1) % n]
            edge_len = math.hypot(x2 - x1, y2 - y1)
            if edge_len < 1e-9:
                edge_loads.append({'dead_kNm': 0.0, 'live_kNm': 0.0})
                continue
            u_edge = np.array([(x2 - x1) / edge_len, (y2 - y1) / edge_len])
            cos_theta = abs(float(u_edge @ u_long_arr))

            # cos_theta ≈ 1 → arista paralela al eje largo → es un lado
            # LARGO del OBB → recibe la carga trapezoidal q_long.
            # cos_theta ≈ 0 → arista perpendicular al eje largo → es un
            # lado CORTO del OBB → recibe la carga triangular q_short.
            # Interpolación lineal para orientaciones intermedias.
            w_long_share  = cos_theta          # peso hacia lado largo
            w_short_share = 1.0 - cos_theta    # peso hacia lado corto

            q_dead = (q_long_dead * w_long_share + q_short_dead * w_short_share) * scale
            q_live = (q_long_live * w_long_share + q_short_live * w_short_share) * scale

            edge_loads.append({'dead_kNm': round(q_dead, 4),
                                'live_kNm': round(q_live, 4)})

        return edge_loads
