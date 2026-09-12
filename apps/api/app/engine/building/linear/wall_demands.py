"""
WallDemandAnalyzer — Módulo 1 (muros): Análisis por casos + combinaciones NSR-10.

Corre 4 análisis independientes sobre el dominio MVLEM_3D (WallModelBuilder):
  1. Caso CM (Dead)   → P_D, Vx_D, Vy_D, Mx_D, My_D por pier
  2. Caso CV (Live)   → P_L, Vx_L, Vy_L, Mx_L, My_L por pier
  3. Caso Sx          → P_Sx, Vx_Sx, Vy_Sx, Mx_Sx, My_Sx por pier
  4. Caso Sy          → P_Sy, Vx_Sy, Vy_Sy, Mx_Sy, My_Sy por pier

Luego superpone según NSR-10 B.2.4:
  1.4D         →  aD·(P,V,M)_D
  1.2D+1.6L    →  1.2·(P,V,M)_D + 1.6·(P,V,M)_L
  1.2D+L+E     →  1.2·(P,V,M)_D + 1.0·(P,V,M)_L + 1.0·(P,V,M)_S(peor)
  0.9D+E       →  0.9·(P,V,M)_D − 1.0·(P,V,M)_S (para máx tensión / mín compresión)

Convención de fuerzas (globales, del eleForce del MVLEM_3D en nodos base i,j):
  P    = |Fz_i + Fz_j|            axial (compresión positiva)
  Vx   = |Fx_i + Fx_j|            cortante en dir X global
  Vy   = |Fy_i + Fy_j|            cortante en dir Y global
  Mx   = Vy · hw                  momento sobre eje X (por Vy actuando a altura hw)
  My   = Vx · hw                  momento sobre eje Y (por Vx actuando a altura hw)

Unidades de salida: kN, kN·m.
"""
from __future__ import annotations

import math
from typing import Any


# ── NSR-10: combos de diseño ─────────────────────────────────────────────────
# (alpha_D, alpha_L, alpha_E, sign_E, label)
# sign_E: +1 → sismo suma a gravedad (compresión máx / cortante máx)
#         −1 → sismo resta (tensión / levantamiento — combo 0.9D+E)
_COMBOS_NSR10 = [
    (1.4,  0.0, 0.0,  0, "1.4D"),
    (1.2,  1.6, 0.0,  0, "1.2D+1.6L"),
    (1.2,  1.0, 1.0, +1, "1.2D+L+E"),     # E máximo suma
    (0.9,  0.0, 1.0, -1, "0.9D-E"),       # levantamiento / tensión
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

        # ── 3. Cuatro análisis independientes (D, L, Sx, Sy) ─────────────────
        gravity_dead = self._gravity_load_by_pier(pier_geom, "dead")
        gravity_live = self._gravity_load_by_pier(pier_geom, "live")

        case_D = self._run_case(
            ops, "D",
            gravity_loads=gravity_dead, lateral_dir=None, lateral_forces=None,
            cm_nodes=cm_nodes, pier_geom=pier_geom, ele_map=ele_map,
            node_map=node_map,
        )
        case_L = self._run_case(
            ops, "L",
            gravity_loads=gravity_live, lateral_dir=None, lateral_forces=None,
            cm_nodes=cm_nodes, pier_geom=pier_geom, ele_map=ele_map,
            node_map=node_map,
        )
        case_Sx = self._run_case(
            ops, "Sx",
            gravity_loads=None, lateral_dir="X", lateral_forces=story_forces_x,
            cm_nodes=cm_nodes, pier_geom=pier_geom, ele_map=ele_map,
            node_map=node_map,
        )
        case_Sy = self._run_case(
            ops, "Sy",
            gravity_loads=None, lateral_dir="Y", lateral_forces=story_forces_y,
            cm_nodes=cm_nodes, pier_geom=pier_geom, ele_map=ele_map,
            node_map=node_map,
        )

        print(
            f"[wall_demands] Casos ejecutados: D V_x_max={max(case_D['Vx'].values() or [0]):.2f} kN"
            f" | L V_x_max={max(case_L['Vx'].values() or [0]):.2f} kN"
            f" | Sx V_x_max={max(case_Sx['Vx'].values() or [0]):.2f} kN"
            f" | Sy V_y_max={max(case_Sy['Vy'].values() or [0]):.2f} kN"
        )

        # ── 4. Combinaciones NSR-10 B.2.4 por superposición ──────────────────
        combos = self._combine(pier_geom, case_D, case_L, case_Sx, case_Sy)

        # Compatibilidad: gravity_axials del caso D (para el UI/frontend actual)
        P_D = case_D["P"]

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

    # ── Cargas gravitacionales por pier (desde overrides o distribución por masa) ─

    def _gravity_load_by_pier(self, pier_geom: dict, kind: str) -> dict[str, float]:
        """
        Retorna la carga vertical Dead o Live por pier (kN, sentido gravitacional
        hacia abajo) construida desde los overrides del GravityOPSBuilder.
        Fallback: si no hay overrides para Live, retorna 0 por pier.

        kind: "dead" o "live"
        """
        key_kN = "dead_kN" if kind == "dead" else "live_kN"
        out: dict[str, float] = {}
        for (pier, story) in pier_geom:
            key   = f"{pier}|{story}"
            loads = self._gov.get(key, {}) if self._gov else {}
            out[key] = abs(float(loads.get(key_kN, 0.0)))
        return out

    # ── Análisis por caso de carga (D, L, Sx o Sy) ────────────────────────────

    def _run_case(
        self,
        ops,
        case_name:      str,
        gravity_loads:  dict[str, float] | None,
        lateral_dir:    str | None,
        lateral_forces: dict[str, float] | None,
        cm_nodes:       dict,
        pier_geom:      dict,
        ele_map:        dict,
        node_map:       dict,
    ) -> dict[str, dict[tuple, float]]:
        """
        Ejecuta un análisis lineal independiente para un caso de carga y extrae
        P, Vx, Vy, Mx, My por pier.

        - gravity_loads:  {"pier|story": F_kN}  → cargas Fz negativas en top nodes
                                                    del pier (repartidas 50/50).
        - lateral_dir:    "X" o "Y" o None
        - lateral_forces: {story: F_kN}          → aplicadas en el CM del piso.

        Entre casos se hace ops.reset() + wipeAnalysis() + remove pattern/ts
        para que cada análisis sea independiente (superposición lineal explícita).

        Retorna: {"P": {(pier,story): kN}, "Vx": ..., "Vy": ..., "Mx": ..., "My": ...}
        """
        # Reset del estado entre casos: limpia desplazamientos, reacciones y
        # patterns residuales. En análisis lineal esto garantiza que cada caso
        # arranque del estado indeformado sin cargas heredadas.
        ops.wipeAnalysis()
        try:
            ops.reset()
        except Exception:
            pass

        # Tags únicos por caso para no chocar con patterns residuales
        ts_tag  = {"D": 101, "L": 102, "Sx": 103, "Sy": 104}.get(case_name, 199)
        pat_tag = ts_tag

        try:
            ops.remove("loadPattern", pat_tag)
        except Exception:
            pass
        try:
            ops.remove("timeSeries", ts_tag)
        except Exception:
            pass

        ops.timeSeries("Linear", ts_tag)
        ops.pattern("Plain", pat_tag, ts_tag)

        # Aplicación de cargas
        if gravity_loads:
            for (pier, story), g in pier_geom.items():
                F = gravity_loads.get(f"{pier}|{story}", 0.0)
                if F == 0.0:
                    continue
                idx = g["story_idx"]
                n_left  = node_map[(pier, idx, 0)]
                n_right = node_map[(pier, idx, 1)]
                half = F / 2.0
                # Fz negativo → carga hacia abajo (compresión en el pier)
                ops.load(n_left,  0.0, 0.0, -half, 0.0, 0.0, 0.0)
                ops.load(n_right, 0.0, 0.0, -half, 0.0, 0.0, 0.0)

        if lateral_dir in ("X", "Y") and lateral_forces:
            dof_idx = 0 if lateral_dir == "X" else 1
            for story, cm in cm_nodes.items():
                F = lateral_forces.get(story, 0.0)
                if F == 0.0:
                    continue
                load = [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                load[dof_idx] = F
                ops.load(cm["tag"], *load)

        # Un solo paso con dt=1.0 aplica el pattern con factor 1.0 (lineal).
        self._run_static(ops, n_steps=1, dt=1.0)

        # Extracción de fuerzas por pier
        P: dict[tuple, float]  = {}
        Vx: dict[tuple, float] = {}
        Vy: dict[tuple, float] = {}
        Mx: dict[tuple, float] = {}
        My: dict[tuple, float] = {}

        for (pier, story), ele_tag in ele_map.items():
            f  = ops.eleForce(ele_tag)   # 24 DOF: 4 nodos × 6 DOF (global)
            hw = pier_geom[(pier, story)]["hw"]

            # Fuerzas sumadas en los dos nodos base (i, j):
            # i: índices 0..5   (Fx_i, Fy_i, Fz_i, Mx_i, My_i, Mz_i)
            # j: índices 6..11
            Fx_base = f[0] + f[6]
            Fy_base = f[1] + f[7]
            Fz_base = f[2] + f[8]

            P[(pier, story)]  = abs(Fz_base)     # compresión positiva
            Vx[(pier, story)] = abs(Fx_base)     # cortante en X global
            Vy[(pier, story)] = abs(Fy_base)     # cortante en Y global
            # Momento en la base por equilibrio: la fuerza horizontal aplicada
            # arriba genera un momento en la base = V × hw. Es una estimación
            # razonable para muros aislados; para multi-piso el momento real
            # incluye contribución de pisos superiores (superposición ya lo
            # captura al sumar los casos, no acumulado por piso).
            Mx[(pier, story)] = abs(Fy_base) * hw   # flexión sobre eje X (Vy·hw)
            My[(pier, story)] = abs(Fx_base) * hw   # flexión sobre eje Y (Vx·hw)

        # Limpia el pattern/ts para el próximo caso
        try:
            ops.remove("loadPattern", pat_tag)
        except Exception:
            pass
        try:
            ops.remove("timeSeries", ts_tag)
        except Exception:
            pass

        return {"P": P, "Vx": Vx, "Vy": Vy, "Mx": Mx, "My": My}

    # ── Combinaciones NSR-10 B.2.4 por superposición ──────────────────────────

    def _combine(
        self,
        pier_geom: dict,
        case_D:  dict[str, dict[tuple, float]],
        case_L:  dict[str, dict[tuple, float]],
        case_Sx: dict[str, dict[tuple, float]],
        case_Sy: dict[str, dict[tuple, float]],
    ) -> list[dict]:
        """
        Superpone los 4 casos (D, L, Sx, Sy) según NSR-10 B.2.4.

        Para cada combo con sismo (alpha_E ≠ 0), se elige la componente sísmica
        que MAXIMIZA cada demanda (Vu, Mu) en valor absoluto, tomando la peor
        entre Sx y Sy:
            Vu_x_E = max(|Vx_Sx|, |Vx_Sy|)
            Mu_x_E = max(|Mx_Sx|, |Mx_Sy|)

        Para el axial:
            sign_E = +1 (combo 1.2D+L+E) → Pu = 1.2·P_D + 1.0·P_L + max(P_S)
                                            (compresión máx para diseño flexo-compresión)
            sign_E = −1 (combo 0.9D−E)   → Pu = 0.9·P_D − max(P_S)
                                            (tensión máx / mín compresión para levantamiento)
        Nota: en el modelo lineal simétrico ideal P_S ≈ 0 en muros interiores;
        para muros perimetrales o cargados por sobre­carga excéntrica sí existe
        aporte sísmico axial.
        """
        rows: list[dict] = []

        for (pier, story), g in pier_geom.items():
            k = (pier, story)
            PD  = case_D ["P"].get(k, 0.0); VxD  = case_D ["Vx"].get(k, 0.0)
            VyD  = case_D ["Vy"].get(k, 0.0); MxD  = case_D ["Mx"].get(k, 0.0); MyD  = case_D ["My"].get(k, 0.0)
            PL  = case_L ["P"].get(k, 0.0); VxL  = case_L ["Vx"].get(k, 0.0)
            VyL  = case_L ["Vy"].get(k, 0.0); MxL  = case_L ["Mx"].get(k, 0.0); MyL  = case_L ["My"].get(k, 0.0)
            PSx = case_Sx["P"].get(k, 0.0); VxSx = case_Sx["Vx"].get(k, 0.0)
            VySx = case_Sx["Vy"].get(k, 0.0); MxSx = case_Sx["Mx"].get(k, 0.0); MySx = case_Sx["My"].get(k, 0.0)
            PSy = case_Sy["P"].get(k, 0.0); VxSy = case_Sy["Vx"].get(k, 0.0)
            VySy = case_Sy["Vy"].get(k, 0.0); MxSy = case_Sy["Mx"].get(k, 0.0); MySy = case_Sy["My"].get(k, 0.0)

            # Peor sismo para cada demanda (envolvente Sx vs Sy)
            P_S  = max(PSx,  PSy)
            VxS  = max(VxSx, VxSy)
            VyS  = max(VySx, VySy)
            MxS  = max(MxSx, MxSy)
            MyS  = max(MySx, MySy)

            for aD, aL, aE, sign_E, label in _COMBOS_NSR10:
                Pu   = aD * PD  + aL * PL  + aE * sign_E * P_S
                Vu_x = aD * VxD + aL * VxL + aE * VxS
                Vu_y = aD * VyD + aL * VyL + aE * VyS
                Mu_x = aD * MxD + aL * MxL + aE * MxS
                Mu_y = aD * MyD + aL * MyL + aE * MyS

                rows.append({
                    "pier":     pier,
                    "story":    story,
                    "combo":    label,
                    "Pu_kN":    round(Pu, 2),
                    "Vu_x_kN":  round(Vu_x, 2),
                    "Vu_y_kN":  round(Vu_y, 2),
                    "Mu_x_kNm": round(Mu_x, 2),
                    "Mu_y_kNm": round(Mu_y, 2),
                    "lw_m":     g["lw"],
                    "tw_m":     g["tw"],
                    "hw_m":     g["hw"],
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
