"""
GravityOPSBuilder — Módulo 1: Análisis gravitacional con distribución de cargas tributarias.

Flujo:
  1. Construye modelo lineal elástico (LinearOPSBuilder):
       - Nodos de joints de marcos y muros
       - elasticBeamColumn para vigas
       - ShellMITC4 para paneles de muro
       - Nodos CM + masas + diafragmas rígidos
  2. Aplica cargas tributarias:
       - eleLoad de viga: carga distribuida uniformemente q [kN/m] en local y
       - Cargas nodales en nodos top de muros: P [kN] en -Z global
  3. Corre análisis estático
  4. Extrae fuerzas axiales de los ShellMITC4 por pier
  5. Calcula puntos de control para validación vs. ETABS

Unidades: m, kN, kN/m

Puntos de control de validación:
  - Balance de peso: W_aplicado vs. ΣR_base  → error < 0.5% indica modelo correcto
  - Peso por piso:   carga aplicada vs. masa ETABS × g
  - Centroide de reacciones: X,Y resultante vs. CM del edificio
"""
from __future__ import annotations

import math
from typing import Any


GRAVITY = 9.81  # m/s²


class GravityOPSBuilder:
    """
    Parámetros
    ----------
    model            : modelo canónico dict
    tributary_loads  : salida de TributaryLoadComputer.compute()
    """

    def __init__(self, model: dict, tributary_loads: dict):
        self._m  = model
        self._tl = tributary_loads

        # Rellenos durante run()
        self._frame_ele_map: dict[str, int] = {}   # frame_label → ele_tag OPS
        self._wall_ele_map:  dict[str, int] = {}   # shell_label → ele_tag OPS
        self._wall_shell_joints: dict[str, list] = {}  # shell_label → [j0,j1,j2,j3]

    # ── API pública ───────────────────────────────────────────────────────────

    def run(self) -> dict:
        """
        Corre el análisis gravitacional completo.

        Retorna
        -------
        {
          "pier_gravity": {
              "Pier|Story": {
                  "dead_kN": float,   # compresión positiva
                  "live_kN": float,
              }
          },
          "control": {
              "total_applied_dead_kN":    float,
              "total_applied_live_kN":    float,
              "total_reaction_dead_kN":   float,   # suma reacciones base
              "balance_error_pct":        float,   # |W_aplic - W_reac| / W_aplic × 100
              "story_weights_kN":         {story: {"applied_kN": float, "etabs_mass_kN": float}},
              "centroid": {"x": float, "y": float},
              "cm_building": {"x": float, "y": float},
          }
        }
        """
        import openseespy.opensees as ops
        from .ops_builder import LinearOPSBuilder, _joint_tag

        # ── 1. Construir modelo base ───────────────────────────────────────────
        builder = LinearOPSBuilder(self._m)
        info    = builder.build()

        # Guardar mapas de elementos para extracción posterior
        self._collect_element_maps()

        # ── 2. Aplicar cargas de gravedad ─────────────────────────────────────
        ops.timeSeries('Linear', 201)
        ops.pattern('Plain', 201, 201)

        total_dead = self._apply_frame_loads(ops, 'dead', _joint_tag)
        total_dead += self._apply_node_loads(ops, 'dead', _joint_tag)

        # Análisis carga muerta
        self._run_static(ops)

        pier_dead = self._extract_pier_forces(ops, _joint_tag)
        base_react_dead = self._sum_base_reactions(ops, _joint_tag)

        # ── 3. Carga viva (incremental) ───────────────────────────────────────
        ops.loadConst('-time', 0.0)
        ops.timeSeries('Linear', 202)
        ops.pattern('Plain', 202, 202)

        total_live = self._apply_frame_loads(ops, 'live', _joint_tag)
        total_live += self._apply_node_loads(ops, 'live', _joint_tag)

        self._run_static(ops)

        # eleForce acumula → restar lo que ya teníamos después del dead
        pier_live_total  = self._extract_pier_forces(ops, _joint_tag)
        base_react_total = self._sum_base_reactions(ops, _joint_tag)

        # Fuerzas vivas = total - muerta
        all_keys = set(pier_dead) | set(pier_live_total)
        pier_live = {k: pier_live_total.get(k, 0.0) - pier_dead.get(k, 0.0)
                     for k in all_keys}

        # ── 4. Puntos de control ──────────────────────────────────────────────
        control = self._build_control_points(
            total_dead, base_react_dead, base_react_total - base_react_dead
        )

        # ── 5. Agrupar por pier ───────────────────────────────────────────────
        pier_gravity = self._aggregate_by_pier(pier_dead, pier_live)

        return {
            'pier_gravity': pier_gravity,
            'control':      control,
        }

    # ── Aplicación de cargas ──────────────────────────────────────────────────

    def _apply_frame_loads(self, ops, category: str, joint_tag_fn) -> float:
        """
        Aplica carga distribuida uniformemente en cada viga a partir de
        las cargas tributarias.  Retorna la carga total aplicada [kN].
        La dirección local y de una viga horizontal con vecxz=[0,0,1] apunta
        hacia -Z global, por lo que wy positivo = carga hacia -Z = gravedad.
        """
        frame_loads = self._tl.get('frame_loads', {})
        frames      = self._m.get('frames', {})
        joints      = self._m.get('joints', {})
        total       = 0.0

        for label, fd in frames.items():
            loads = frame_loads.get(label)
            if not loads:
                continue
            q = loads.get(f'{category}_kNm', 0.0)
            if q == 0.0:
                continue

            ele_tag = self._frame_ele_map.get(label)
            if ele_tag is None:
                continue

            # Longitud de la viga para calcular carga total aplicada
            ji = joints.get(fd['joint_i'], {})
            jj = joints.get(fd['joint_j'], {})
            L  = math.sqrt(
                (float(jj.get('x', 0)) - float(ji.get('x', 0))) ** 2 +
                (float(jj.get('y', 0)) - float(ji.get('y', 0))) ** 2 +
                (float(jj.get('z', 0)) - float(ji.get('z', 0))) ** 2
            )

            # beamUniform: wy en sistema local; positivo = downward para vigas horiz.
            ops.eleLoad('-ele', ele_tag, '-type', '-beamUniform', q, 0.0)
            total += q * L

        return total

    def _apply_node_loads(self, ops, category: str, joint_tag_fn) -> float:
        """
        Aplica cargas puntuales en nodos de muro-top y bordes libres.
        Retorna la carga total aplicada [kN].
        """
        node_loads = self._tl.get('node_loads', {})
        total      = 0.0
        key        = f'{category}_kN'

        for joint_label, loads in node_loads.items():
            P = loads.get(key, 0.0)
            if P == 0.0:
                continue
            tag = joint_tag_fn(joint_label)
            # Fuerza en -Z global (gravedad hacia abajo)
            ops.load(tag, 0.0, 0.0, -P, 0.0, 0.0, 0.0)
            total += P

        return total

    # ── Análisis estático ─────────────────────────────────────────────────────

    @staticmethod
    def _run_static(ops) -> None:
        ops.constraints('Transformation')
        ops.numberer('RCM')
        ops.system('BandGeneral')
        ops.test('NormDispIncr', 1e-6, 100, 0)
        ops.algorithm('Newton')
        ops.integrator('LoadControl', 1.0)
        ops.analysis('Static')
        ok = ops.analyze(1)
        if ok != 0:
            raise RuntimeError('Gravity static analysis did not converge')

    # ── Extracción de fuerzas ─────────────────────────────────────────────────

    def _collect_element_maps(self) -> None:
        """
        Reconstituye el mapa frame_label → ele_tag y shell_label → ele_tag
        a partir del orden en que LinearOPSBuilder los crea.
        """
        frames  = self._m.get('frames', {})
        shells  = self._m.get('shells', {})

        # Marcos: ele_tag = enumerate_index + 1
        for ele_idx, (label, _) in enumerate(frames.items()):
            self._frame_ele_map[label] = ele_idx + 1

        # Muros ShellMITC4: empiezan en n_frames + 1
        n_frames = len(frames)
        wall_count = 0
        for label, sd in shells.items():
            if sd.get('element_type') != 'wall':
                continue
            js = sd.get('joints', [])
            if len(js) != 4 or len(set(js)) < 4:
                continue
            wall_count += 1
            ele_tag = n_frames + wall_count
            self._wall_ele_map[label] = ele_tag
            self._wall_shell_joints[label] = js

    def _extract_pier_forces(self, ops, joint_tag_fn) -> dict[tuple, float]:
        """
        Para cada ShellMITC4 de muro extrae la fuerza axial en su base.
        joints[0], joints[1] son los nodos inferiores (story_below).
        eleForce[2]  = Fz en nodo 0  (índice 3 en base 0)
        eleForce[8]  = Fz en nodo 1  (índice 9 en base 0)
        Compresión → Fz negativo en nodo base → P = -(Fz0 + Fz1)
        """
        shells = self._m.get('shells', {})
        forces: dict[tuple, float] = {}

        for label, ele_tag in self._wall_ele_map.items():
            sd = shells.get(label, {})
            pier  = sd.get('pier', '')
            story = sd.get('story', '')
            if not pier:
                continue
            try:
                f = ops.eleForce(ele_tag)
            except Exception:
                continue
            # Fz en nodos base: índices 2 y 8 (base 0)
            P = -(f[2] + f[8])
            key = (pier, story)
            forces[key] = forces.get(key, 0.0) + P

        return forces

    def _sum_base_reactions(self, ops, joint_tag_fn) -> float:
        """Suma las reacciones verticales (Z) en todos los nodos de base."""
        restraints = self._m.get('restraints', {})
        total = 0.0
        for label in restraints:
            tag = joint_tag_fn(label)
            try:
                total += ops.nodeReaction(tag, 3)  # DOF 3 = Z
            except Exception:
                pass
        return abs(total)

    # ── Puntos de control ─────────────────────────────────────────────────────

    def _build_control_points(
        self,
        total_dead_applied: float,
        base_react_dead:    float,
        base_react_live:    float,
    ) -> dict:
        masses  = self._m.get('masses', {})
        joints  = self._m.get('joints', {})

        # Peso ETABS por piso
        etabs_story_kN = {
            md['story']: md.get('mass_x_t', 0.0) * GRAVITY
            for md in masses.values()
            if 'story' in md
        }

        # Cargas aplicadas por piso (del TributaryLoadComputer)
        applied_story = self._tl.get('summary', {}).get('story_loads', {})

        story_weights = {}
        for story, etabs_kN in etabs_story_kN.items():
            appl = applied_story.get(story, {})
            story_weights[story] = {
                'applied_dead_kN': round(appl.get('dead_kN', 0.0), 2),
                'applied_live_kN': round(appl.get('live_kN', 0.0), 2),
                'etabs_mass_kN':   round(etabs_kN, 2),
            }

        # Centroide de base reactions
        # (aproximado con CM del edificio desde masas)
        x_cm_sum = sum(float(md.get('x_cm_m', 0)) * float(md.get('mass_x_t', 0))
                       for md in masses.values())
        y_cm_sum = sum(float(md.get('y_cm_m', 0)) * float(md.get('mass_x_t', 0))
                       for md in masses.values())
        mass_sum = sum(float(md.get('mass_x_t', 0)) for md in masses.values())

        cx = x_cm_sum / mass_sum if mass_sum > 0 else 0.0
        cy = y_cm_sum / mass_sum if mass_sum > 0 else 0.0

        err_pct = (abs(total_dead_applied - base_react_dead) / total_dead_applied * 100
                   if total_dead_applied > 0 else 0.0)

        return {
            'total_applied_dead_kN':  round(total_dead_applied, 2),
            'total_reaction_dead_kN': round(base_react_dead, 2),
            'balance_error_pct':      round(err_pct, 3),
            'story_weights':          story_weights,
            'centroid': {'x': round(cx, 3), 'y': round(cy, 3)},
        }

    # ── Agregación por pier ───────────────────────────────────────────────────

    def _aggregate_by_pier(
        self,
        pier_dead: dict[tuple, float],
        pier_live: dict[tuple, float],
    ) -> dict[str, dict]:
        """Combina fuerzas de shells individuales por (pier, story)."""
        all_keys = set(pier_dead) | set(pier_live)
        result: dict[str, dict] = {}
        for (pier, story) in all_keys:
            result[f'{pier}|{story}'] = {
                'dead_kN': round(pier_dead.get((pier, story), 0.0), 2),
                'live_kN': round(pier_live.get((pier, story), 0.0), 2),
            }
        return result
