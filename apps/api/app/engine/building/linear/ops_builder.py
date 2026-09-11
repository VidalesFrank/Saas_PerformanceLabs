"""
LinearOPSBuilder — Módulo 1: Constructor del modelo OpenSees desde structural_model.json.

Construye el modelo elástico lineal para análisis modal:
  - elasticBeamColumn para todos los marcos
  - ShellMITC4 (ElasticMembranePlateSection) para paneles de muro
  - Masas concentradas en nodos CM por piso
  - Restricciones de diafragma rígido por piso (rigidDiaphragm)

Unidades de entrada: metros, kN, MPa (del modelo canónico)
Unidades OpenSees : metros, kN, seg  → E en kN/m² = MPa × 1000
"""
import math


# Tag base para nodos CM virtuales (evita colisión con tags de juntas ETABS)
_CM_TAG_OFFSET = 10_000_000


def _wall_drilling_dof(joint_labels: list, joints_data: dict) -> int:
    """
    Returns the 1-based DOF index of the drilling rotation for a ShellMITC4 wall.
    The drilling DOF is the rotation about the element's outward normal.
      - Wall in XZ plane (normal ≈ Y): drilling = Ry → DOF 5
      - Wall in YZ plane (normal ≈ X): drilling = Rx → DOF 4
      - Horizontal slab (normal ≈ Z):  drilling = Rz → DOF 6
    """
    try:
        pts = [
            [float(joints_data.get(j, {}).get("x", 0)),
             float(joints_data.get(j, {}).get("y", 0)),
             float(joints_data.get(j, {}).get("z", 0))]
            for j in joint_labels[:3]
        ]
        v1 = [pts[1][i] - pts[0][i] for i in range(3)]
        v2 = [pts[2][i] - pts[0][i] for i in range(3)]
        nx = v1[1] * v2[2] - v1[2] * v2[1]
        ny = v1[2] * v2[0] - v1[0] * v2[2]
        nz = v1[0] * v2[1] - v1[1] * v2[0]
        dom = [abs(nx), abs(ny), abs(nz)].index(max(abs(nx), abs(ny), abs(nz)))
        return (4, 5, 6)[dom]   # Rx, Ry, Rz
    except Exception:
        return 5  # default: Ry (vertical wall in XZ plane)


def _joint_tag(label: str) -> int:
    """Convierte el label de junta a entero para OpenSees.
    Maneja tanto '313' como '313.0' (pandas lee enteros Excel como float)."""
    try:
        return int(float(label))
    except (TypeError, ValueError):
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
        self._create_shell_elements(ops)
        # Sin esto, el DOF de drilling de los nodos de muro en la base tiene
        # K≈0 (penalización ShellMITC4) y M=0 → modo espurio de cuerpo
        # rígido casi-cero que rompe la factorización de Arnoldi de ARPACK
        # (ver docstring de _add_tiny_mass_to_wall_nodes). Estaba definida
        # pero nunca se llamaba.
        self._add_tiny_mass_to_wall_nodes(ops)
        cm_nodes = self._create_cm_nodes_and_masses(ops)
        self._apply_diaphragms(ops, cm_nodes)

        return {"cm_nodes": cm_nodes}

    # ── Nodos ─────────────────────────────────────────────────────────────────

    def _create_nodes(self, ops) -> None:
        frames = self._m.get("frames", {})
        shells = self._m.get("shells", {})
        restraints = set(self._m.get("restraints", {}).keys())

        used: set[str] = restraints.copy()
        used |= {fd["joint_i"] for fd in frames.values()}
        used |= {fd["joint_j"] for fd in frames.values()}

        # Track wall joints separately (used later in _create_shell_elements and _apply_diaphragms)
        self._wall_joints: set[str] = set()
        for sd in shells.values():
            if sd.get("element_type") == "wall":
                self._wall_joints.update(sd.get("joints", []))
        used |= self._wall_joints

        # Corners de losa (floor) sin frame ni muro propio: las losas no se
        # modelan como shell de rigidez (solo los muros — ver
        # _create_shell_elements), así que estos joints no aportan rigidez
        # individual. Pero si son corner real de una losa y no se crean como
        # nodo, quedan totalmente ausentes del dominio OpenSees — invisibles
        # en el visor 3D y sin desplazamiento propio, aunque su masa sí
        # llegue al CM del piso (vía "masses", independiente de esto).
        # Se agregan igual que cualquier nodo "flotante": _apply_diaphragms
        # ya fija Uz/Rx/Ry en todo joint sin frame ni muro válido conectado
        # y ata Ux/Uy/Rz al diafragma rígido — no agregan GDL libres nuevos
        # ni riesgo de singularidad.
        floor_joints: set[str] = set()
        for sd in shells.values():
            if sd.get("element_type") != "wall":
                floor_joints.update(sd.get("joints", []))
        used |= floor_joints

        self._created_joints = used  # usado en _apply_diaphragms
        self._valid_frame_joints: set[str] = set()  # llenado en _create_frame_elements

        # Registrar la z exacta (float IEEE-754) de cada story desde sus joints.
        # OpenSeesPy 3.7.x usa comparación float exacta en rigidDiaphragm; el CM
        # debe crearse con la misma representación que los nodos esclavos.
        self._story_z_exact: dict[str, float] = {}

        for label, jd in self._m.get("joints", {}).items():
            if label not in used:
                continue
            story = jd.get("story", "")
            if story and story not in self._story_z_exact and label in self._wall_joints:
                self._story_z_exact[story] = float(jd["z"])
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

            # Beams articulados (RELEASE=PINNED o element_type=beam): no se crean como elementos
            # de barra — no aportan rigidez lateral (igual que ETABS con beams pinned).
            # Sus joints quedan como nodos flotantes en el diafragma (Uz,Rx,Ry fijados).
            # Solo se crean elementos para vigas con continuidad de momento (columnas/dinteles).
            release = fd.get("release", "")
            is_pinned = (release.upper() == "PINNED" or
                         fd.get("element_type", "").lower() == "beam")
            if is_pinned:
                continue

            ele_tag = ele_idx + 1
            ops.element("elasticBeamColumn", ele_tag, ni, nj, A, E, G, J, Iy, Iz, transf)

            # Track joints connected to valid frame elements (non-floating nodes)
            self._valid_frame_joints.add(fd["joint_i"])
            self._valid_frame_joints.add(fd["joint_j"])

    # ── Elementos shell (muros) ───────────────────────────────────────────────

    def _create_shell_elements(self, ops) -> None:
        """
        ShellMITC4 con ElasticMembranePlateSection para paneles de muro.
        Unidades: kN, m → E en kPa (MPa × 1000).

        Cada panel se subdivide en N_SUB=2 elementos verticales para reducir
        shear locking. ETABS (WALLMESHMAXSIZE=1.25m, h_piso=2.45m) también usa 2
        elementos por piso, lo que reduce el ratio h/b de 16.3→8.15.

        El DOF de drilling NO se fija — _add_tiny_mass_to_wall_nodes provee M=ε.
        """
        shells     = self._m.get("shells", {})
        joints_dat = self._m.get("joints", {})
        materials  = self._m.get("materials", {})
        n_frames   = len(self._m.get("frames", {}))

        N_SUB = 1   # 1 elemento por panel por piso — MITC4 no sufre shear locking para membrana
        nu    = 0.2
        TINY  = 1e-6  # (sin uso con N_SUB=1)

        default_E_kPa = 25_000_000.0
        if materials:
            default_E_kPa = float(next(iter(materials.values())).get("E_mpa", 25000)) * 1000.0

        _SEC_BASE = 900_100
        sec_key_to_tag: dict[tuple, int] = {}
        sec_counter = _SEC_BASE
        ele_tag = n_frames + 1

        # Nodos intermedios: (tag_bot, tag_top, nivel) → tag OpenSees
        # Nodos compartidos por paneles adyacentes se crean solo una vez.
        _INTERP_OFFSET = 5_000_000
        interp_nodes: dict[tuple, int] = {}
        interp_counter = _INTERP_OFFSET

        for sd in shells.values():
            if sd.get("element_type") != "wall":
                continue
            joint_labels = sd.get("joints", [])
            if len(joint_labels) != 4:
                continue
            # Orden canónico: [j1=bot-izq, j2=bot-der, j3=top-der, j4=top-izq]
            tags = [_joint_tag(j) for j in joint_labels]
            if len(set(tags)) < 4:
                continue

            h = sd.get("thickness_m", 0.0)
            if h <= 0:
                h = 0.2
            # E_mpa viene del material de la sección (cargado por model_builder).
            # stiffness_modifier: leído del E2K si ETABS lo define; default 1.0 (rigidez bruta).
            # Para análisis NSR-10 con secciones fisuradas, pasar modifier=0.35 en los params
            # del análisis — NO aplicarlo aquí sin verificar si el ETABS lo tiene.
            raw_E_kPa = float(sd.get("E_mpa", 0)) * 1000.0 or default_E_kPa
            modifier  = float(sd.get("stiffness_modifier", 1.0))
            E_kPa     = raw_E_kPa * modifier

            sec_key = (round(E_kPa, 0), nu, round(h, 4))
            if sec_key not in sec_key_to_tag:
                sec_counter += 1
                ops.section("ElasticMembranePlateSection",
                            sec_counter, E_kPa, nu, round(h, 4), 0.0)
                sec_key_to_tag[sec_key] = sec_counter
            sec_id = sec_key_to_tag[sec_key]

            # Coordenadas de las 4 esquinas para interpolar
            coords = [
                [float(joints_dat.get(j, {}).get(k, 0)) for k in ('x', 'y', 'z')]
                for j in joint_labels
            ]
            # Aristas: izquierda = j1→j4, derecha = j2→j3
            left_tags  = [tags[0]]
            right_tags = [tags[1]]

            for sub in range(1, N_SUB):
                alpha = sub / N_SUB

                xl = coords[0][0] + alpha * (coords[3][0] - coords[0][0])
                yl = coords[0][1] + alpha * (coords[3][1] - coords[0][1])
                zl = coords[0][2] + alpha * (coords[3][2] - coords[0][2])
                key_l = (tags[0], tags[3], sub)
                if key_l not in interp_nodes:
                    interp_counter += 1
                    interp_nodes[key_l] = interp_counter
                    ops.node(interp_counter, xl, yl, zl)
                    # Sin ops.fix ni masa en nodos intermedios.
                    # ShellMITC4 provee K>0 en los 6 DOFs (drilling penalty incluido).
                    # M=0 → condensación estática, no aparecen en el eigenvalue problem.
                left_tags.append(interp_nodes[key_l])

                xr = coords[1][0] + alpha * (coords[2][0] - coords[1][0])
                yr = coords[1][1] + alpha * (coords[2][1] - coords[1][1])
                zr = coords[1][2] + alpha * (coords[2][2] - coords[1][2])
                key_r = (tags[1], tags[2], sub)
                if key_r not in interp_nodes:
                    interp_counter += 1
                    interp_nodes[key_r] = interp_counter
                    ops.node(interp_counter, xr, yr, zr)
                right_tags.append(interp_nodes[key_r])

            left_tags.append(tags[3])   # j4 = top-izq
            right_tags.append(tags[2])  # j3 = top-der

            for sub in range(N_SUB):
                n1, n2 = left_tags[sub],   right_tags[sub]
                n3, n4 = right_tags[sub+1], left_tags[sub+1]
                if len({n1, n2, n3, n4}) < 4:
                    continue
                ops.element("ShellMITC4", ele_tag, n1, n2, n3, n4, sec_id)
                ele_tag += 1

    # ── Nodos CM y masas ──────────────────────────────────────────────────────

    def _wall_mass_per_cm_story(self) -> dict[str, float]:
        """
        Calcula masa de peso propio de muros [t] a agregar en cada CM de piso.
        ETABS (MASSSOURCE INCLUDEELEMENTS=Yes) incluye self-weight de muros lumpada
        en el piso superior de cada panel. gamma_concreto = 24 kN/m³.
        """
        GAMMA_kN_m3 = 24.0
        G_m_s2      = 9.81
        shells  = self._m.get("shells", {})
        joints  = self._m.get("joints", {})
        masses  = self._m.get("masses", {})

        # Ordenar stories con CM de menor a mayor z
        story_z = {str(md.get("story", "")): float(md.get("z_m", 0.0))
                   for md in masses.values()}
        ordered = sorted(story_z, key=lambda s: story_z[s])

        # Acumular z mínima por story desde joints (para incluir el BASE)
        base_z: dict[str, float] = {}
        for jd in joints.values():
            st = str(jd.get("story", ""))
            z  = float(jd.get("z", 0.0))
            if st and (st not in base_z or z < base_z[st]):
                base_z[st] = z

        all_stories_sorted = sorted(base_z, key=lambda s: base_z[s])
        # Mapa: bottom_story → siguiente story que tiene nodo CM
        next_cm: dict[str, str] = {}
        for st in all_stories_sorted:
            z_st = base_z[st]
            for cm_st in ordered:
                if story_z[cm_st] > z_st + 1e-3:
                    next_cm[st] = cm_st
                    break

        # Masa de muros agrupada por story de joints inferiores
        wall_mass_t: dict[str, float] = {}
        for sd in shells.values():
            if sd.get("element_type") != "wall":
                continue
            jl = sd.get("joints", [])
            if len(jl) < 4:
                continue
            t = sd.get("thickness_m", 0.0) or 0.2
            try:
                def _c(j, k):
                    return float(joints.get(str(j), {}).get(k, 0.0))
                dx = _c(jl[1], 'x') - _c(jl[0], 'x')
                dy = _c(jl[1], 'y') - _c(jl[0], 'y')
                width  = math.sqrt(dx**2 + dy**2)
                height = abs(_c(jl[3], 'z') - _c(jl[0], 'z'))
                mass_t = t * width * height * GAMMA_kN_m3 * 1000.0 / G_m_s2 / 1000.0
            except Exception:
                continue
            bot_st = str(joints.get(str(jl[0]), {}).get("story", ""))
            wall_mass_t[bot_st] = wall_mass_t.get(bot_st, 0.0) + mass_t

        # Reasignar al CM del piso superior
        result: dict[str, float] = {s: 0.0 for s in ordered}
        for bot_st, mass_t in wall_mass_t.items():
            cm_st = next_cm.get(bot_st, "")
            if cm_st in result:
                result[cm_st] += mass_t
        return result

    def _create_cm_nodes_and_masses(self, ops) -> dict:
        """
        Crea un nodo maestro en el CM de cada piso con la masa de diafragma.
        Incluye peso propio de muros (igual que ETABS MASSSOURCE INCLUDEELEMENTS=Yes).
        Retorna: {story_name: {"tag": int, "z": float}}
        """
        masses   = self._m.get("masses", {})
        cm_nodes: dict[str, dict] = {}
        wall_extra = self._wall_mass_per_cm_story()

        for idx, (_, md) in enumerate(masses.items()):
            story = str(md.get("story", f"story_{idx}"))
            cm_tag = _CM_TAG_OFFSET + idx + 1

            x = float(md.get("x_cm_m", 0.0))
            y = float(md.get("y_cm_m", 0.0))
            # Usar la z exacta (IEEE-754) que registró _create_nodes desde los joints
            # del piso; evita que rigidDiaphragm ignore los nodos por diff de float.
            story_z_exact = getattr(self, "_story_z_exact", {})
            z = story_z_exact.get(story, float(md.get("z_m", 0.0)))

            ops.node(cm_tag, x, y, z)

            extra = wall_extra.get(story, 0.0)
            mx  = float(md.get("mass_x_t",    0.0)) + extra
            my  = float(md.get("mass_y_t",    0.0)) + extra
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
        Solo incluye joints que fueron creados como nodos en _create_nodes.

        Estrategia para eliminar singularidades K=0,M=0:
        - Nodos de muro: _add_tiny_mass_to_wall_nodes agrega M=ε en Uz/Rx/Ry.
          El DOF de drilling (Ry/Rx) tiene K≈0 del ShellMITC4 pero M=ε → K-σM
          es invertible para cualquier σ>0. fullGenLapack/symmBandLapack manejan
          esto sin problemas.
        - Nodos flotantes (marcos sin sección, sin muro conectado): todos sus
          DOFs libres tienen K=0 y M=0 → se fijan Uz, Rx, Ry para eliminar
          la singularidad.
        - Nodos de marcos válidos: tienen K>0 del elemento → no necesitan fix.
        """
        joints      = self._m.get("joints", {})
        restraints  = set(self._m.get("restraints", {}).keys())
        created     = getattr(self, "_created_joints", set())
        wall_joints = getattr(self, "_wall_joints", set())
        valid_fr_j  = getattr(self, "_valid_frame_joints", set())

        # Construir story_joints rastreando labels (para clasificar flotantes)
        story_labels: dict[str, list[str]] = {}
        for label, jd in joints.items():
            if label not in created:
                continue
            story = jd.get("story", "")
            if story in cm_nodes and label not in restraints:
                story_labels.setdefault(story, []).append(label)

        for story, cm_info in cm_nodes.items():
            labels = story_labels.get(story, [])
            if not labels:
                continue
            slave_tags = [_joint_tag(l) for l in labels]
            try:
                ops.rigidDiaphragm(3, cm_info["tag"], *slave_tags)
            except Exception as e:
                print(f"[ops_builder] rigidDiaphragm {story}: {e}")

            # Fijar Uz,Rx,Ry SOLO en nodos flotantes (sin elemento válido conectado).
            for label, tag in zip(labels, slave_tags):
                if label not in wall_joints and label not in valid_fr_j:
                    try:
                        ops.fix(tag, 0, 0, 1, 1, 1, 0)
                    except Exception:
                        pass

    # ── Masa mínima en nodos de muro ─────────────────────────────────────────

    def _add_tiny_mass_to_wall_nodes(self, ops) -> None:
        """
        Agrega masa mínima ε=1e-6 t a los DOFs libres de nodos de muro para
        prevenir modos de energía cero (K≈0, M=0) que hacen indefinida K.

        - Nodos NO restringidos (piso superior): UZ,RX,RY tienen K>0 del ShellMITC4
          pero M=0. Añadimos ε en {UZ, RX, RY} → ω_ficticio >> ω_estructural.
        - Nodos restringidos en BASE: UX,UY,UZ fijos; RX,RY,RZ libres. El DOF de
          drilling (RY para muros XZ) tiene K≈0 (penalización ShellMITC4) y M=0
          → modo de cuerpo rígido. Añadimos ε en {RX, RY, RZ} para evitarlo.
        """
        restraints  = set(self._m.get("restraints", {}).keys())
        wall_joints = getattr(self, "_wall_joints", set())
        TINY = 1e-6  # toneladas — ω_ficticio ≈ sqrt(K/ε) >> ω_estructural
        done: set[int] = set()
        for label in wall_joints:
            tag = _joint_tag(label)
            if tag in done:
                continue
            try:
                if label in restraints:
                    # Nodo de BASE: UX,UY,UZ fijos; rotaciones RX,RY,RZ libres.
                    # Añadir ε en rotaciones libres para prevenir modos de cuerpo rígido.
                    ops.mass(tag, 0.0, 0.0, 0.0, TINY, TINY, TINY)
                else:
                    # Nodo de PISO: constrained en UX,UY,RZ por diafragma; UZ,RX,RY libres.
                    ops.mass(tag, 0.0, 0.0, TINY, TINY, TINY, 0.0)
                done.add(tag)
            except Exception:
                pass
