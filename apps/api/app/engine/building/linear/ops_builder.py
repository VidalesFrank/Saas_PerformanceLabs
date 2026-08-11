"""
LinearOPSBuilder — Módulo 1: Constructor del modelo OpenSees desde structural_model.json.

Construye el modelo elástico lineal para análisis modal:
  - elasticBeamColumn para todos los marcos
  - Masas concentradas en nodos CM por piso
  - Restricciones de diafragma rígido por piso (rigidDiaphragm)

Unidades de entrada: metros, kN, MPa (del modelo canónico)
Unidades OpenSees : metros, kN, seg  → E en kN/m² = MPa × 1000
"""
import math


# Tag base para nodos CM virtuales (evita colisión con tags de juntas ETABS)
_CM_TAG_OFFSET = 10_000_000


def _joint_tag(label: str) -> int:
    """Convierte el label de junta (string) a entero para OpenSees."""
    try:
        return int(label)
    except ValueError:
        return abs(hash(label)) % (_CM_TAG_OFFSET - 1000) + 1000


def _element_len(joints: dict, label_i: str, label_j: str) -> tuple[float, float, float, float]:
    """Retorna (dx, dy, dz, L) del elemento."""
    ji = joints.get(label_i, {})
    jj = joints.get(label_j, {})
    dx = float(jj.get("x", 0)) - float(ji.get("x", 0))
    dy = float(jj.get("y", 0)) - float(ji.get("y", 0))
    dz = float(jj.get("z", 0)) - float(ji.get("z", 0))
    L  = math.sqrt(dx**2 + dy**2 + dz**2)
    return dx, dy, dz, L


def _vecxz_for_element(dx: float, dy: float, dz: float, L: float) -> list[float]:
    """
    Retorna el vector perpendicular al eje local x, en el plano xz local.
    - Elementos verticales (dz dominante): vecxz = [1, 0, 0]
    - Elementos horizontales: vecxz = [0, 0, 1]
    - Verifica que no sea paralelo al eje local.
    """
    if L < 1e-9:
        return [1.0, 0.0, 0.0]

    # Eje local x normalizado
    ex = [dx / L, dy / L, dz / L]

    # Candidatos por prioridad
    for candidate in ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]):
        # Producto cruzado ex × candidate
        cx = ex[1] * candidate[2] - ex[2] * candidate[1]
        cy = ex[2] * candidate[0] - ex[0] * candidate[2]
        cz = ex[0] * candidate[1] - ex[1] * candidate[0]
        mag = math.sqrt(cx**2 + cy**2 + cz**2)
        if mag > 0.01:
            return list(candidate)

    return [1.0, 0.0, 0.0]  # fallback (no debería ocurrir)


class LinearOPSBuilder:
    """
    Construye el modelo OpenSees lineal elástico desde el structural_model.json.

    Uso:
        builder = LinearOPSBuilder(model_dict)
        info = builder.build()   # llama a OpenSees internamente
        # info["cm_nodes"] = {story: {"tag": int, "z": float}}
    """

    def __init__(self, model: dict):
        self._m = model

    def build(self) -> dict:
        import openseespy.opensees as ops

        ops.wipe()
        ops.model("basic", "-ndm", 3, "-ndf", 6)

        self._create_nodes(ops)
        self._apply_restraints(ops)
        self._create_frame_elements(ops)
        cm_nodes = self._create_cm_nodes_and_masses(ops)
        self._apply_diaphragms(ops, cm_nodes)

        return {"cm_nodes": cm_nodes}

    # ── Nodos ─────────────────────────────────────────────────────────────────

    def _create_nodes(self, ops) -> None:
        # Solo crear nodos referenciados por elementos de marco o restricciones
        # para evitar nodos flotantes que hacen singular la matriz K.
        frames = self._m.get("frames", {})
        restraints = set(self._m.get("restraints", {}).keys())
        used = restraints | {fd["joint_i"] for fd in frames.values()} | {fd["joint_j"] for fd in frames.values()}
        for label, jd in self._m.get("joints", {}).items():
            if label not in used:
                continue
            tag = _joint_tag(label)
            ops.node(tag, float(jd["x"]), float(jd["y"]), float(jd["z"]))

    # ── Restricciones ─────────────────────────────────────────────────────────

    def _apply_restraints(self, ops) -> None:
        for label, dofs in self._m.get("restraints", {}).items():
            tag = _joint_tag(label)
            ops.fix(tag, *[int(d) for d in dofs])

    # ── Elementos de marco ────────────────────────────────────────────────────

    def _create_frame_elements(self, ops) -> None:
        joints   = self._m.get("joints", {})
        sections = self._m.get("sections", {})
        frames   = self._m.get("frames", {})

        # Caché de geomTransf por vecxz (evita crear duplicados)
        transf_cache: dict[tuple, int] = {}
        transf_counter = [1]

        def get_transf(vecxz: list) -> int:
            key = tuple(round(v, 4) for v in vecxz)
            if key not in transf_cache:
                tag = transf_counter[0]
                ops.geomTransf("Linear", tag, *vecxz)
                transf_cache[key] = tag
                transf_counter[0] += 1
            return transf_cache[key]

        for ele_idx, (_, fd) in enumerate(frames.items()):
            sec_name = fd.get("section", "")
            sec = sections.get(sec_name)
            if not sec:
                continue

            ni = _joint_tag(fd["joint_i"])
            nj = _joint_tag(fd["joint_j"])

            dx, dy, dz, L = _element_len(joints, fd["joint_i"], fd["joint_j"])
            if L < 1e-6:
                continue

            vecxz  = _vecxz_for_element(dx, dy, dz, L)
            transf = get_transf(vecxz)

            # Propiedades de sección — conversión MPa → kN/m²
            A  = float(sec.get("A_m2",   0.01))
            E  = float(sec.get("E_mpa",  25000)) * 1000.0
            G  = float(sec.get("G_mpa",  10417)) * 1000.0
            J  = float(sec.get("J_m4",   1e-5))
            Iy = float(sec.get("I22_m4", 1e-5))   # eje débil
            Iz = float(sec.get("I33_m4", 1e-5))   # eje fuerte

            if A <= 0 or E <= 0:
                continue

            ele_tag = ele_idx + 1
            ops.element("elasticBeamColumn", ele_tag, ni, nj, A, E, G, J, Iy, Iz, transf)

    # ── Nodos CM y masas ──────────────────────────────────────────────────────

    def _create_cm_nodes_and_masses(self, ops) -> dict:
        """
        Crea un nodo maestro en el CM de cada piso con la masa de diafragma.
        Retorna: {story_name: {"tag": int, "z": float}}
        """
        masses   = self._m.get("masses", {})
        cm_nodes: dict[str, dict] = {}

        for idx, (_, md) in enumerate(masses.items()):
            story = str(md.get("story", f"story_{idx}"))
            cm_tag = _CM_TAG_OFFSET + idx + 1

            x = float(md.get("x_cm_m", 0.0))
            y = float(md.get("y_cm_m", 0.0))
            z = float(md.get("z_m",    0.0))

            ops.node(cm_tag, x, y, z)

            mx  = float(md.get("mass_x_t",    0.0))
            my  = float(md.get("mass_y_t",    0.0))
            mrz = float(md.get("mass_rz_tm2", 0.0))

            # DOFs: Mx My Mz Mrx Mry Mrz
            # Mz=0 → no análisis vertical; Mrx=Mry=0 → diafragma horizontal
            ops.mass(cm_tag, mx, my, 0.0, 0.0, 0.0, mrz)

            # Fijar z, Rx, Ry del nodo CM: solo modos laterales (x, y, Rz libres)
            # Sin esto, los DOFs verticales del CM tienen masa=0 y K=0 → K singular
            ops.fix(cm_tag, 0, 0, 1, 1, 1, 0)

            cm_nodes[story] = {"tag": cm_tag, "z": z}

        return cm_nodes

    # ── Diafragmas rígidos ────────────────────────────────────────────────────

    def _apply_diaphragms(self, ops, cm_nodes: dict) -> None:
        """
        Aplica rigidDiaphragm(3, master, *slaves) por piso.
        Los nodos restringidos (base) no son slaves.
        """
        joints     = self._m.get("joints", {})
        restraints = set(self._m.get("restraints", {}).keys())

        # Agrupar juntas libres por piso
        story_joints: dict[str, list[int]] = {}
        for label, jd in joints.items():
            story = jd.get("story", "")
            if story in cm_nodes and label not in restraints:
                story_joints.setdefault(story, []).append(_joint_tag(label))

        for story, cm_info in cm_nodes.items():
            slaves = story_joints.get(story, [])
            if not slaves:
                continue
            try:
                ops.rigidDiaphragm(3, cm_info["tag"], *slaves)
            except Exception as e:
                print(f"[ops_builder] rigidDiaphragm {story}: {e}")
