"""
WallDemandAnalyzer — Módulo 1 (muros): Análisis FHE y combinaciones NSR-10.

Corre sobre el dominio OpenSees activo (construido por WallModelBuilder):
  1. Análisis gravitacional  → P_D por pier por historia
  2. FHE en X y en Y        → V_X, V_Y, M_X, M_Y por pier por historia
  3. Combos NSR-10 C.9.2.1  → envolvente de diseño (Pu, Vu, Mu)

Unidades de salida: kN, kN·m.
"""
from __future__ import annotations

import math
from typing import Any


# ── NSR-10: combos de diseño ─────────────────────────────────────────────────
# (alpha_D, alpha_L, alpha_E, label)
_COMBOS_NSR10 = [
    (1.4,  0.0, 0.0, "1.4D"),
    (1.2,  1.6, 0.0, "1.2D+1.6L"),
    (1.2,  1.0, 1.0, "1.2D+L+E"),    # E seísmo máximo
    (0.9,  0.0, 1.0, "0.9D+E"),       # mínima compresión + sismo
]

GRAVITY = 9.81  # m/s²


class WallDemandAnalyzer:
    """
    Parámetros
    ----------
    build_info          : dict retornado por WallModelBuilder.build()
    model               : modelo canónico JSON
    seismic_params      : dict con llaves Aa, Av, Fa, Fv, R, importance_factor
    gravity_overrides   : {"Pier|Story": {"dead_kN": float, "live_kN": float}}
                          Del GravityOPSBuilder (ShellMITC4 + método 45°)
    story_forces_rsa    : {"X": {story: Fx_kN}, "Y": {story: Fy_kN}}
                          Fuerzas por piso del análisis espectral RSA (CQC, ya escaladas
                          por FHEChecker). Si se proveen, reemplazan el FHE interno.
    """

    def __init__(self, build_info: dict, model: dict, seismic_params: dict,
                 gravity_overrides: dict | None = None,
                 story_forces_rsa: dict | None = None):
        self._bi  = build_info
        self._m   = model
        self._sp  = seismic_params
        self._gov = gravity_overrides or {}
        self._rsa = story_forces_rsa   # None → usa FHE interno

    # ── API pública ───────────────────────────────────────────────────────────

    def run(self) -> dict:
        """
        Retorna:
        {
            "story_forces":   {X: {...}, Y: {...}},        # fuerzas por piso (kN)
            "fhe_params":     {source, W_kN, Vb_kN, ...},
            "pier_demands":   [{pier, story, combo, Pu, Vu_x, Vu_y, Mu_x, Mu_y}],
            "gravity_axials": {pier|story → P_D_kN},
        }
        """
        import openseespy.opensees as ops

        pier_geom  = self._bi["pier_geom"]
        ele_map    = self._bi["pier_elements"]
        cm_nodes   = self._bi["cm_nodes"]
        stories    = self._bi["stories_order"]
        node_map   = self._bi["node_map"]

        # ── 1. Peso total (siempre del modelo canónico) ───────────────────────
        masses     = self._m.get("masses", {})
        story_mass = {md["story"]: md["mass_x_t"]
                      for md in masses.values() if "story" in md}
        W_kN       = sum(story_mass.values()) * GRAVITY
        hn         = max(self._bi["stories_z"].values())

        # ── 2. Fuerzas laterales por piso: RSA o FHE ─────────────────────────
        if self._rsa:
            story_forces_x = {s: float(v) for s, v in self._rsa.get("X", {}).items()}
            story_forces_y = {s: float(v) for s, v in self._rsa.get("Y", {}).items()}
            Vb_kN  = sum(story_forces_x.values())
            source = "RSA"
            print(f"[wall_demands] Fuerzas RSA: Vb_x={Vb_kN:.1f} kN  pisos={len(story_forces_x)}")
            demand_params = {
                "hn_m":   round(hn, 2),
                "source": source,
                "W_kN":   round(W_kN, 1),
                "Vb_kN":  round(Vb_kN, 1),
            }
        else:
            T          = 0.0488 * (hn ** 0.75)      # NSR-10 A.4.2.1 muros
            Cs, Vb_kN = self._base_shear(W_kN, T)
            story_forces_x, story_forces_y = self._distribute_fhe(
                Vb_kN, story_mass, stories, T
            )
            source = "FHE"
            print(f"[wall_demands] Fuerzas FHE: T={T:.3f}s  Vb={Vb_kN:.1f} kN")
            demand_params = {
                "hn_m":   round(hn, 2),
                "T_s":    round(T, 3),
                "Cs":     round(Cs, 5),
                "source": source,
                "W_kN":   round(W_kN, 1),
                "Vb_kN":  round(Vb_kN, 1),
            }

        # ── 2. Fuerzas gravitacionales por pier ──────────────────────────────
        # Si vienen overrides del GravityOPSBuilder (ShellMITC4 + 45°) los usamos.
        # Si no (compatibilidad hacia atrás), usamos la distribución por masa.
        if self._gov:
            P_D = self._pier_gravity_from_overrides(pier_geom)
        else:
            P_D = self._run_gravity(ops, pier_geom, ele_map, node_map, story_mass, stories)

        # ── 3. Análisis lateral X ─────────────────────────────────────────────
        V_x, M_x = self._run_lateral(
            ops, "X", story_forces_x, cm_nodes, pier_geom, ele_map, node_map, stories
        )

        # ── 4. Análisis lateral Y ─────────────────────────────────────────────
        V_y, M_y = self._run_lateral(
            ops, "Y", story_forces_y, cm_nodes, pier_geom, ele_map, node_map, stories
        )

        # ── 5. Combinaciones NSR-10 ───────────────────────────────────────────
        if self._gov:
            P_L = {(pier, story): abs(self._gov.get(f'{pier}|{story}', {}).get('live_kN', 0.0))
                   for (pier, story) in P_D}
        else:
            P_L = {k: 0.0 for k in P_D}  # sin override: conservador L=0
        combos = self._combine(pier_geom, P_D, P_L, V_x, V_y, M_x, M_y)

        return {
            "fhe_params": demand_params,
            "story_forces": {
                "X": {s: round(story_forces_x.get(s, 0.0), 2) for s in stories},
                "Y": {s: round(story_forces_y.get(s, 0.0), 2) for s in stories},
            },
            "gravity_axials": {
                f"{p}|{s}": round(v, 2) for (p, s), v in P_D.items()
            },
            "pier_demands": combos,
        }

    # ── FHE: cortante basal y distribución por piso ───────────────────────────

    def _base_shear(self, W_kN: float, T: float) -> tuple[float, float]:
        """NSR-10 A.4.2: Cs y Vb."""
        Aa  = float(self._sp.get("Aa",  0.15))
        Av  = float(self._sp.get("Av",  0.15))
        Fa  = float(self._sp.get("Fa",  1.2))
        Fv  = float(self._sp.get("Fv",  1.8))
        R   = float(self._sp.get("R",   5.0))
        I   = float(self._sp.get("importance_factor", 1.0))

        SDS = Aa * Fa * 2.5   # aceleración espectral de diseño corto período
        SD1 = Av * Fv         # aceleración espectral de diseño período 1s

        if T > 0:
            Cs_T = SD1 / (T * R / I)
        else:
            Cs_T = SDS / (R / I)

        Cs_cap = SDS / (R / I)
        Cs_min = max(0.044 * SDS * I, 0.01)
        Cs = max(min(Cs_cap, Cs_T), Cs_min)

        return Cs, Cs * W_kN

    def _distribute_fhe(
        self,
        Vb: float,
        story_mass: dict[str, float],
        stories: list[str],
        T: float,
    ) -> tuple[dict, dict]:
        """
        NSR-10 A.4.3.2: Fx = Cvx × Vb
        Cvx = Wi × hi^k / Σ(Wj × hj^k)
        k = 1 si T ≤ 0.5s, k = 2 si T ≥ 2.5s, lineal entre.
        Distribuye misma envolvente a X e Y (edificio simétrico fase 1).
        """
        k = 1.0
        if T > 2.5:
            k = 2.0
        elif T > 0.5:
            k = 1.0 + (T - 0.5) / 2.0

        stories_z = self._bi["stories_z"]
        denom = sum(
            story_mass.get(s, 0.0) * GRAVITY * (stories_z.get(s, 0.0) ** k)
            for s in stories[1:]   # skip base story (z=0 → contributes 0 anyway)
        )
        if denom < 1e-9:
            denom = 1.0

        forces: dict[str, float] = {}
        for s in stories:
            Wi = story_mass.get(s, 0.0) * GRAVITY
            hi = stories_z.get(s, 0.0)
            forces[s] = Vb * Wi * (hi ** k) / denom

        return forces, dict(forces)  # misma distribución en X e Y por ahora

    # ── Gravitacional desde ShellMITC4 ───────────────────────────────────────

    def _pier_gravity_from_overrides(self, pier_geom: dict) -> dict[tuple, float]:
        """
        Construye P_D por (pier, story) a partir de los resultados del
        GravityOPSBuilder (ShellMITC4 + método de 45°).
        Usa Dead + Live como carga de servicio total; los combos NSR-10
        aplican los factores sobre P_D (dead) y P_L (live) en _combine().
        """
        P_D: dict[tuple, float] = {}
        for (pier, story) in pier_geom:
            key   = f'{pier}|{story}'
            loads = self._gov.get(key, {})
            P_D[(pier, story)] = abs(loads.get('dead_kN', 0.0))
        return P_D

    # ── Análisis gravitacional (fallback: distribución por masa) ──────────────

    def _run_gravity(
        self,
        ops,
        pier_geom:  dict,
        ele_map:    dict,
        node_map:   dict,
        story_mass: dict,
        stories:    list[str],
    ) -> dict[tuple, float]:
        """
        Aplica el peso de cada piso como cargas puntuales en los nodos top
        del pier, proporcionales al área transversal (lw × tw).
        Retorna P_D por (pier, story) en kN (compresión positiva).
        """
        # Área total de pieres por piso
        area_by_story: dict[str, float] = {}
        for (pier, story), g in pier_geom.items():
            area_by_story[story] = area_by_story.get(story, 0.0) + g["A_m2"]

        ops.timeSeries("Linear", 1)
        ops.pattern("Plain", 1, 1)

        for story in stories[1:]:  # skip base
            W_story = story_mass.get(story, 0.0) * GRAVITY  # kN
            A_total = area_by_story.get(story, 1.0)
            for (pier, st), g in pier_geom.items():
                if st != story:
                    continue
                frac = g["A_m2"] / A_total
                P_pier = W_story * frac         # kN por pier (hacia abajo)
                idx = g["story_idx"]
                n_left  = node_map[(pier, idx, 0)]
                n_right = node_map[(pier, idx, 1)]
                # Reparte la mitad a cada nodo top
                ops.load(n_left,  0.0, 0.0, -P_pier / 2, 0.0, 0.0, 0.0)
                ops.load(n_right, 0.0, 0.0, -P_pier / 2, 0.0, 0.0, 0.0)

        self._run_static(ops, n_steps=10, dt=0.1)

        # Extrae axial en la base de cada pier (nodos base)
        P_D: dict[tuple, float] = {}
        for (pier, story), ele_tag in ele_map.items():
            f = ops.eleForce(ele_tag)   # 24 DOF: [f_ni_1..6, f_nj_1..6, f_nk_1..6, f_nl_1..6]
            # Fz en nodos base (ni, nj) → índices 2 y 8
            Fz_i = f[2]; Fz_j = f[8]
            P_D[(pier, story)] = abs(Fz_i + Fz_j)  # compresión positiva
        return P_D

    # ── Análisis lateral FHE ──────────────────────────────────────────────────

    def _run_lateral(
        self,
        ops,
        direction:    str,
        story_forces: dict[str, float],
        cm_nodes:     dict,
        pier_geom:    dict,
        ele_map:      dict,
        node_map:     dict,
        stories:      list[str],
    ) -> tuple[dict[tuple, float], dict[tuple, float]]:
        """
        Aplica fuerzas de piso en los nodos CM (dirección X o Y).
        Retorna (V, M) por (pier, story) en kN y kN·m.
        """
        # Mantener gravedad como carga constante y agregar lateral
        ops.loadConst("-time", 0.0)

        ts_tag  = 10 if direction == "X" else 20
        pat_tag = 10 if direction == "X" else 20
        ops.timeSeries("Linear", ts_tag)
        ops.pattern("Plain", pat_tag, ts_tag)

        dof_idx = 0 if direction == "X" else 1  # X=DOF 1 (idx 0), Y=DOF 2 (idx 1)
        for story, cm in cm_nodes.items():
            Fx = story_forces.get(story, 0.0)
            load = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
            load[dof_idx] = Fx
            ops.load(cm["tag"], *load)

        self._run_static(ops, n_steps=10, dt=0.1)

        V: dict[tuple, float] = {}
        M: dict[tuple, float] = {}

        for (pier, story), ele_tag in ele_map.items():
            f   = ops.eleForce(ele_tag)
            g   = pier_geom[(pier, story)]
            hw  = g["hw"]

            # Corte horizontal en base del elemento (nodos ni, nj)
            # Para X: Fx en nodos base → índices 0 y 6
            # Para Y: Fy en nodos base → índices 1 y 7
            if direction == "X":
                Vi = -(f[0] + f[6])   # suma Fx base, signo de reacción
            else:
                Vi = -(f[1] + f[7])

            # Momento en base por equilibrio estático: M = V × hw
            # (válido para un pier de una historia; para multi-historia el
            #  momento acumulado se calcula post-proceso en la API)
            Mi = abs(Vi) * hw

            V[(pier, story)] = abs(Vi)
            M[(pier, story)] = Mi

        return V, M

    # ── Combinaciones NSR-10 ──────────────────────────────────────────────────

    def _combine(
        self,
        pier_geom: dict,
        P_D:  dict[tuple, float],
        P_L:  dict[tuple, float],
        V_x:  dict[tuple, float],
        V_y:  dict[tuple, float],
        M_x:  dict[tuple, float],
        M_y:  dict[tuple, float],
    ) -> list[dict]:
        """Genera la envolvente de demandas de diseño NSR-10 C.9.2.1."""
        rows: list[dict] = []

        for (pier, story), g in pier_geom.items():
            pd_val = P_D.get((pier, story), 0.0)
            pl_val = P_L.get((pier, story), 0.0)
            vx     = V_x.get((pier, story), 0.0)
            vy     = V_y.get((pier, story), 0.0)
            mx     = M_x.get((pier, story), 0.0)
            my     = M_y.get((pier, story), 0.0)

            # Dirección dominante: la que produce mayor cortante
            V_E = max(vx, vy)
            M_E = mx if vx >= vy else my

            for alpha_D, alpha_L, alpha_E, label in _COMBOS_NSR10:
                Pu = alpha_D * pd_val + alpha_L * pl_val
                if alpha_E > 0:
                    # NSR-10 A.2.5.6: sismo en dos direcciones ortogonales
                    Vu_x = alpha_E * vx
                    Vu_y = alpha_E * vy
                    Mu_x = alpha_E * mx
                    Mu_y = alpha_E * my
                else:
                    Vu_x = Vu_y = Mu_x = Mu_y = 0.0

                rows.append({
                    "pier":    pier,
                    "story":   story,
                    "combo":   label,
                    "Pu_kN":   round(Pu, 2),
                    "Vu_x_kN": round(Vu_x, 2),
                    "Vu_y_kN": round(Vu_y, 2),
                    "Mu_x_kNm": round(Mu_x, 2),
                    "Mu_y_kNm": round(Mu_y, 2),
                    "lw_m":    g["lw"],
                    "tw_m":    g["tw"],
                    "hw_m":    g["hw"],
                })

        return rows

    # ── Solver estático interno ───────────────────────────────────────────────

    @staticmethod
    def _run_static(ops, n_steps: int = 10, dt: float = 0.1) -> bool:
        ops.constraints("Transformation")
        ops.numberer("RCM")
        ops.system("BandGeneral")
        ops.test("NormDispIncr", 1e-6, 100, 0)
        ops.algorithm("Newton")
        ops.integrator("LoadControl", dt)
        ops.analysis("Static")
        ok = ops.analyze(n_steps)
        return ok == 0
