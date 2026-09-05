"""
WallModelBuilder — Módulo 1 (muros): Modelo MVLEM_3D elástico para pieres RC.

Construye el modelo OpenSees con elementos MVLEM_3D elásticos (fibras Elastic)
a partir del modelo canónico JSON + raw_data ETABS.  El dominio queda activo
para que WallDemandAnalyzer (wall_demands.py) lo use directamente.

Unidades OpenSees: m · kN · s
  → E [MPa] × 1000 → kPa = kN/m²

Referencia elemento: Kolozvari et al. (2018), MVLEM_3D.
"""
from __future__ import annotations

import math
from typing import Any

import pandas as pd

# ── Table keys del raw_data (coinciden con row-1 de cada sheet XLSX) ─────────
_K_PIER_PROPS  = 'TABLE:  "PIER SECTION PROPERTIES"'
_K_PIER_SPANDR = 'TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"'
_K_SHELLS      = 'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'
_K_SH_WALL     = 'TABLE:  "SHELL SECTIONS - WALL"'
_K_SH_ASSIGN   = 'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'
_K_MASS        = 'TABLE:  "MASS SUMMARY BY DIAPHRAGM"'

# ── Espacios de tags (evitan colisiones entre elementos del modelo) ────────────
_NODE_WALL_OFFSET = 20_000_000   # nodos de pier (2 base + 2 top por elemento)
_NODE_CM_OFFSET   = 10_000_000   # nodos CM (igual que ops_builder._CM_TAG_OFFSET)
_ELE_WALL_OFFSET  = 50_000_000   # elementos MVLEM_3D
_MAT_CONC_OFFSET  = 5_000_000    # materiales de concreto elástico
_MAT_SHEAR_OFFSET = 8_000_000    # resortes de corte
_MAT_STEEL_TAG    = 9_000_001    # acero elástico único (mismo Es en todo el modelo)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _f(val, default: float = 0.0) -> float:
    try:
        v = float(val)
        return v if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _s(val, default: str = "") -> str:
    if val is None or (isinstance(val, float) and math.isnan(val)):
        return default
    return str(val).strip()


# ── Builder principal ─────────────────────────────────────────────────────────

class WallModelBuilder:
    """
    Construye el modelo OpenSees (MVLEM_3D elástico) para un edificio de muros.

    Parámetros
    ----------
    model    : modelo canónico dict (salida de CanonicalModelBuilder.build())
    raw_data : tablas ETABS del XLSX (dict de DataFrames, keyed por TABLE string)
    n_fibers : número de macro-fibras por elemento MVLEM_3D (defecto 10)
    """

    NU_CONCRETE  = 0.2    # coeficiente de Poisson
    RHO_ELASTIC  = 0.005  # ratio acero ficticio para fase elástica

    def __init__(self, model: dict, raw_data: dict, n_fibers: int = 10):
        self._m        = model
        self._rd       = raw_data
        self._n_fibers = n_fibers

        # Llenados durante build()
        self._stories_order: list[str]              = []
        self._stories_z:     dict[str, float]       = {}
        self._joint_xy:      dict[str, tuple]       = {}  # label → (X, Y)

        self._pier_geom:    dict[tuple, dict] = {}   # (pier, story) → geom
        self._node_map:     dict[tuple, int]  = {}   # (pier, bnd_idx, side) → tag
        self._ele_map:      dict[tuple, int]  = {}   # (pier, story) → ele_tag
        self._cm_map:       dict[str, dict]   = {}   # story → {tag, x, y, z}
        self._wall_top_nodes: dict[str, list[int]] = {}  # story → [tags de top de piers]

        self._node_counter = _NODE_WALL_OFFSET
        self._ele_counter  = _ELE_WALL_OFFSET
        self._mat_shear_counter = _MAT_SHEAR_OFFSET

    # ── API pública ───────────────────────────────────────────────────────────

    def build(self) -> dict:
        """
        Construye el modelo OpenSees y retorna el diccionario de información
        necesario para el análisis (WallDemandAnalyzer).

        El dominio OpenSees queda ACTIVO (sin ops.wipe()) para que el
        analizador lo use directamente.
        """
        import openseespy.opensees as ops

        ops.wipe()
        ops.model("basic", "-ndm", 3, "-ndf", 6)

        self._load_stories()
        self._load_joint_xy()
        self._extract_pier_geometry()

        if not self._pier_geom:
            raise ValueError("No se encontraron pieres válidos en el modelo.")

        self._create_pier_nodes(ops)
        self._fix_base_nodes(ops)
        self._create_materials(ops)
        self._create_mvlem_elements(ops)
        self._create_cm_nodes(ops)
        self._apply_diaphragms(ops)

        return {
            "cm_nodes":      self._cm_map,
            "pier_geom":     self._pier_geom,
            "pier_elements": self._ele_map,
            "node_map":      self._node_map,
            "stories_order": self._stories_order,
            "stories_z":     self._stories_z,
            "wall_top_nodes": self._wall_top_nodes,
        }

    # ── Carga de datos base ───────────────────────────────────────────────────

    def _load_stories(self) -> None:
        stories = self._m.get("stories", {})
        self._stories_z     = {s: d["elevation_m"] for s, d in stories.items()}
        self._stories_order = sorted(stories, key=lambda s: stories[s]["elevation_m"])

    def _load_joint_xy(self) -> None:
        for label, jd in self._m.get("joints", {}).items():
            self._joint_xy[label] = (float(jd.get("x", 0.0)), float(jd.get("y", 0.0)))

    # ── Extracción de geometría de pieres ─────────────────────────────────────

    def _extract_pier_geometry(self) -> None:
        """
        Para cada (pier, story) lee lw, tw, hw, posición XY de los extremos,
        y propiedades de material del concreto.
        """
        pier_props_df  = self._rd.get(_K_PIER_PROPS)
        pier_spandr_df = self._rd.get(_K_PIER_SPANDR)
        shells_df      = self._rd.get(_K_SHELLS)
        sh_wall_df     = self._rd.get(_K_SH_WALL)
        sh_assign_df   = self._rd.get(_K_SH_ASSIGN)
        materials      = self._m.get("materials", {})

        if not isinstance(pier_props_df, pd.DataFrame) or pier_props_df.empty:
            return

        # ── Mapa elemento → sección de muro ──────────────────────────────────
        elem_to_sec: dict[str, str] = {}
        if isinstance(sh_assign_df, pd.DataFrame):
            lc = "Unique Name" if "Unique Name" in sh_assign_df.columns else "Element Label"
            for _, r in sh_assign_df.iterrows():
                lbl = _s(r.get(lc, "")); sec = _s(r.get("Section", ""))
                if lbl and sec:
                    elem_to_sec[lbl] = sec

        # ── Sección de muro → material de concreto ────────────────────────────
        sec_to_mat: dict[str, str] = {}
        if isinstance(sh_wall_df, pd.DataFrame):
            for _, r in sh_wall_df.iterrows():
                sec = _s(r.get("Name", "")); mat = _s(r.get("Material", ""))
                if sec:
                    sec_to_mat[sec] = mat

        # ── Shell → joints ────────────────────────────────────────────────────
        shell_to_joints: dict[str, list[str]] = {}
        if isinstance(shells_df, pd.DataFrame):
            for _, r in shells_df.iterrows():
                lbl = _s(r.get("Element Label", ""))
                js  = [_s(r.get(f"Joint {i}", "")) for i in range(1, 5)]
                if lbl:
                    shell_to_joints[lbl] = [j for j in js if j]

        # ── Pier × story → shells asignados ──────────────────────────────────
        ps_shells: dict[tuple, list[str]] = {}
        if isinstance(pier_spandr_df, pd.DataFrame):
            for _, r in pier_spandr_df.iterrows():
                pier  = _s(r.get("Pier", ""))
                story = _s(r.get("Story", ""))
                lbl   = _s(r.get("Unique Name", ""))
                if pier and story and lbl:
                    ps_shells.setdefault((pier, story), []).append(lbl)

        # ── Construir geometría por pier × story ──────────────────────────────
        for _, row in pier_props_df.iterrows():
            story = _s(row.get("Story", ""))
            pier  = _s(row.get("Pier",  ""))
            lw    = _f(row.get("Length",    0.0))
            tw    = _f(row.get("Thickness", 0.2))

            if not pier or not story or lw < 0.01:
                continue
            if story not in self._stories_order:
                continue

            idx = self._stories_order.index(story)
            if idx == 0:
                continue  # nivel base → sin elemento debajo

            z_top  = self._stories_z[story]
            z_base = self._stories_z[self._stories_order[idx - 1]]
            hw = z_top - z_base
            if hw < 0.01:
                continue

            # ── Extremos del muro desde joints de shells ──────────────────────
            shells_here  = ps_shells.get((pier, story), [])
            all_jlabels  = []
            for sl in shells_here:
                all_jlabels.extend(shell_to_joints.get(sl, []))

            unique_coords: list[tuple[float, float]] = []
            seen: set = set()
            for jl in all_jlabels:
                xy = self._joint_xy.get(jl)
                if xy and xy not in seen:
                    seen.add(xy); unique_coords.append(xy)

            if len(unique_coords) < 2:
                continue  # no se puede determinar posición → omitir

            # Par de puntos más lejanos = extremos del muro
            x1 = y1 = x2 = y2 = 0.0
            max_d = 0.0
            for i in range(len(unique_coords)):
                for j in range(i + 1, len(unique_coords)):
                    d = math.hypot(unique_coords[j][0] - unique_coords[i][0],
                                   unique_coords[j][1] - unique_coords[i][1])
                    if d > max_d:
                        max_d = d
                        x1, y1 = unique_coords[i]
                        x2, y2 = unique_coords[j]

            # ── Material de concreto ──────────────────────────────────────────
            Ec_kPa = 25_000_000.0  # 25 GPa por defecto
            fc_mpa = 21.0
            if shells_here:
                sec = elem_to_sec.get(shells_here[0], "")
                mat_name = sec_to_mat.get(sec, "")
                mat_data = materials.get(mat_name, {})
                if mat_data:
                    Ec_kPa = mat_data.get("E_mpa", 25000.0) * 1000.0
                    fc_mpa = mat_data.get("fpc_mpa", 21.0)

            Gc_kPa = Ec_kPa / (2.0 * (1.0 + self.NU_CONCRETE))

            self._pier_geom[(pier, story)] = {
                "pier": pier, "story": story,
                "lw": lw, "tw": tw, "hw": hw,
                "z_base": z_base, "z_top": z_top,
                "x1": x1, "y1": y1,
                "x2": x2, "y2": y2,
                "xc": (x1 + x2) / 2, "yc": (y1 + y2) / 2,
                "Ec_kPa": Ec_kPa,
                "Gc_kPa": Gc_kPa,
                "fc_mpa": fc_mpa,
                "story_idx": idx,       # 1-based from ground
                "A_m2": lw * tw,
            }

    # ── Nodos ─────────────────────────────────────────────────────────────────

    def _create_pier_nodes(self, ops) -> None:
        """
        Crea nodos en los extremos de cada pier (base y top).
        Nodos compartidos entre historias adyacentes se reutilizan.
        """
        self._wall_top_nodes = {s: [] for s in self._stories_order}

        for (pier, story), g in self._pier_geom.items():
            idx   = g["story_idx"]
            x1, y1 = g["x1"], g["y1"]
            x2, y2 = g["x2"], g["y2"]
            z_base = g["z_base"]
            z_top  = g["z_top"]

            # Nodos base (story boundary idx-1)
            for side, (xn, yn) in enumerate([(x1, y1), (x2, y2)]):
                key = (pier, idx - 1, side)
                if key not in self._node_map:
                    self._node_counter += 1
                    self._node_map[key] = self._node_counter
                    ops.node(self._node_counter, xn, yn, z_base)

            # Nodos top (story boundary idx)
            for side, (xn, yn) in enumerate([(x1, y1), (x2, y2)]):
                key = (pier, idx, side)
                if key not in self._node_map:
                    self._node_counter += 1
                    self._node_map[key] = self._node_counter
                    ops.node(self._node_counter, xn, yn, z_top)
                    self._wall_top_nodes[story].append(self._node_counter)

    def _fix_base_nodes(self, ops) -> None:
        """Restringe completamente todos los nodos en el nivel base (bnd_idx = 0)."""
        for (pier, bnd_idx, side), tag in self._node_map.items():
            if bnd_idx == 0:
                ops.fix(tag, 1, 1, 1, 1, 1, 1)

    # ── Materiales ────────────────────────────────────────────────────────────

    def _create_materials(self, ops) -> None:
        """
        Materiales elásticos para MVLEM_3D:
          - Un Elastic de concreto por Ec único (kPa)
          - Un Elastic de acero global (Es = 200 GPa)
          - Un Elastic de corte por pier×story (Gc × lw × tw)
        """
        # Acero único
        ops.uniaxialMaterial("Elastic", _MAT_STEEL_TAG, 200_000_000.0)

        # Concreto: uno por Ec único
        ec_to_tag: dict[float, int] = {}
        mat_conc_counter = _MAT_CONC_OFFSET

        for (pier, story), g in self._pier_geom.items():
            ec = round(g["Ec_kPa"], 0)
            if ec not in ec_to_tag:
                mat_conc_counter += 1
                ec_to_tag[ec] = mat_conc_counter
                ops.uniaxialMaterial("Elastic", mat_conc_counter, ec)
            g["mat_tag_conc"] = ec_to_tag[ec]

            # Resorte de corte individual (depende de lw × tw)
            self._mat_shear_counter += 1
            Ks = g["Gc_kPa"] * g["lw"] * g["tw"]   # kPa × m² → kN/m
            ops.uniaxialMaterial("Elastic", self._mat_shear_counter, Ks)
            g["mat_tag_shear"] = self._mat_shear_counter

    # ── Elementos MVLEM_3D ────────────────────────────────────────────────────

    def _create_mvlem_elements(self, ops) -> None:
        """
        Crea un elemento MVLEM_3D por pier × story.
        Orden de nodos: i(bot-left) j(bot-right) k(top-right) l(top-left).
        """
        m   = self._n_fibers
        rho = self.RHO_ELASTIC

        for (pier, story), g in self._pier_geom.items():
            idx = g["story_idx"]
            lw  = g["lw"]; tw = g["tw"]
            mc  = g["mat_tag_conc"]
            ms  = g["mat_tag_shear"]

            # Nodos: base-left, base-right, top-right, top-left
            ni = self._node_map[(pier, idx - 1, 0)]
            nj = self._node_map[(pier, idx - 1, 1)]
            nk = self._node_map[(pier, idx,     1)]
            nl = self._node_map[(pier, idx,     0)]

            self._ele_counter += 1
            ops.element(
                "MVLEM_3D", self._ele_counter,
                ni, nj, nk, nl,
                m,
                "-thick",       *([tw] * m),
                "-width",       *([lw / m] * m),
                "-rho",         *([rho] * m),
                "-matConcrete", *([mc] * m),
                "-matSteel",    *([_MAT_STEEL_TAG] * m),
                "-matShear",    ms,
                "-CoR",         0.4,
                "-Poisson",     self.NU_CONCRETE,
            )
            self._ele_map[(pier, story)] = self._ele_counter

    # ── Nodos CM y diafragmas ─────────────────────────────────────────────────

    def _create_cm_nodes(self, ops) -> None:
        """Nodos maestros con masa lumped (idéntico a LinearOPSBuilder)."""
        for idx, (_, md) in enumerate(self._m.get("masses", {}).items()):
            story  = str(md.get("story", ""))
            cm_tag = _NODE_CM_OFFSET + idx + 1
            x = float(md.get("x_cm_m", 0.0))
            y = float(md.get("y_cm_m", 0.0))
            z = float(md.get("z_m",    0.0))
            ops.node(cm_tag, x, y, z)
            ops.mass(cm_tag,
                     float(md.get("mass_x_t",    1.0)),
                     float(md.get("mass_y_t",    1.0)),
                     0.0, 0.0, 0.0,
                     float(md.get("mass_rz_tm2", 1.0)))
            ops.fix(cm_tag, 0, 0, 1, 1, 1, 0)
            self._cm_map[story] = {"tag": cm_tag, "x": x, "y": y, "z": z}

    def _apply_diaphragms(self, ops) -> None:
        """
        Restringe los nodos top de cada pier al nodo CM del piso
        mediante rigidDiaphragm en la dirección 3 (Z vertical).
        Adicionalmente fija RX y RY de los nodos esclavo: MVLEM_3D es un
        elemento in-plane y no aporta rigidez out-of-plane en esas rotaciones.
        """
        for story, cm_info in self._cm_map.items():
            slaves = self._wall_top_nodes.get(story, [])
            if not slaves:
                continue
            # Fix out-of-plane rotations before applying diaphragm
            for tag in slaves:
                ops.fix(tag, 0, 0, 0, 1, 1, 0)   # pin RX and RY
            try:
                ops.rigidDiaphragm(3, cm_info["tag"], *slaves)
            except Exception as e:
                print(f"[WallModelBuilder] rigidDiaphragm {story}: {e}")
