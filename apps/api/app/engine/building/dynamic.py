"""
@author: Daniela Novoa, Orlando Arroyo, Frank Vidales
@owner: EstrucMed Ingeniería especializada S.A.S

-------------------------------------------------------------------------------
                      CSI Model Converter to OpenSeesPy
                          Versión: ETABS17 v17.0.1
    
        Funciones para generar análisis dinámico de una estructura en 3D

Unidades: Sistema Internacional (SI) - metros (m)
Norma utilizada: NSR-10.
-------------------------------------------------------------------------------
""" 
#%% ==> IMPORTAR LIBRERIAS
import os
import sys

# --- Importar ruta principal del proyecto
root_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
sys.path.append(root_path)

# --- Importar librerias de Python
from typing import List, Tuple, Dict, Any, Optional
import numpy as np
import openseespy.opensees as ops

# --- Dependencias esperadas del entorno de análisis
import opseestools.analisis3D as optools_an

#%% UTILIDADES --> PASAR A UTILITIES PENDIENTE
def _compute_tol(default: float = 1e-4) -> float:
    """ Calcula la tolerancia en función del tamaño del modelo si hay nodos ya creados. """
    try:
        nn = len(ops.getNodeTags())
        return 0.1 * np.sqrt(max(nn, 1) * 6)
    except Exception:
        return default

def _read_pair(fema_records: Dict[str, Any], ind: int) -> Tuple[list, float, int]:
    """Devuelve (record_paths, dt, nsteps) para la pareja 'ind'."""
    rec1 = fema_records[str(2 * ind)]
    rec2 = fema_records[str(2 * ind + 1)]
    record_paths = [rec1['file_path'], rec2['file_path']]
    dt = rec1['time_increment']
    nsteps = min(rec1['steps_number'], rec2['steps_number'])
    return record_paths, dt, nsteps

def _control_nodes_from_store(store_data: Dict[str, Any]) -> Tuple[List[int], int]:
    """
    Construye la lista de nodos de control (base + COM ordenados por Z).
    Devuelve (node_record, base_id).
    """
    com_info = store_data.get("center_of_mass_information", {})
    if not com_info:
        raise ValueError("center_of_mass_information está vacío en 'store_data'.")

    items = sorted(
        ((int(nid), float(v["global_z"])) for nid, v in com_info.items()),
        key=lambda t: t[1]
    )
    node_ids = [nid for nid, _ in items]

    base_joints = store_data["model_data"]["Base"]["joints_data"]
    base_id = int(sorted(base_joints.keys(), key=lambda s: int(s))[0])

    node_record: List[int] = [base_id, *node_ids]
    if not node_record:
        raise ValueError("No se encontraron nodos de control en 'store_data'.")
    
    return node_record, base_id


def _pick_record_elements(store_data: Dict[str, Any], prefer: str = "frame") -> Tuple[List[int], str]:
    """Selecciona elementos a registrar (frame/wall/shell) a partir de store_data.

    Parameters
    ----------
    store_data : dict
        Diccionario del modelo procesado.
    prefer : str
        'frame', 'wall', 'shell' o 'auto'.

    Returns
    -------
    (elements, eletype)
        elements: lista de eleTags
        eletype: 'frame' | 'wall' | 'shell'
    """

    prefer = (prefer or "auto").strip().lower()
    if prefer == "auto":
        prefer = "frame"

    model = store_data.get("model_data", {}) or {}

    def _collect(key: str) -> List[int]:
        out: List[int] = []
        for _, d in model.items():
            dd = d.get(key)
            if isinstance(dd, dict) and dd:
                try:
                    out.extend(int(k) for k in dd.keys())
                except Exception:
                    # si por alguna razón son strings no numéricos
                    pass
        return sorted(set(out))

    beams = _collect("beams_data")
    walls = _collect("walls_data")
    slabs = _collect("slabs_data")

    if prefer == "wall":
        if walls:
            return walls, "wall"
        if beams:
            return beams, "frame"
        if slabs:
            return slabs, "shell"
    elif prefer == "shell":
        if slabs:
            return slabs, "shell"
        if beams:
            return beams, "frame"
        if walls:
            return walls, "wall"
    else:  # frame por defecto
        if beams:
            return beams, "frame"
        if walls:
            return walls, "wall"
        if slabs:
            return slabs, "shell"

    raise ValueError("[ERROR] No se encontraron elementos (beams/walls/slabs) en store_data para registrar.")


#%% RUTINA DINAMICO ADAPTATIVO DE DTAN
def dinamicoBD4_adaptive(
    record_paths: List[str],
    dtrec: float,
    nPts: int,
    dt: float,
    factor: float,
    damp: float,
    IDctrlNode: int,
    IDctrlDOF: int,
    nodes_control: List[int],
    elements: List[int],
    modes: List[int] = (0, 2),
    Kswitch: int = 1,
    Tol: Optional[float] = None,
    eletype: str = 'frame',
    # Parámetros de adaptación de paso
    reduce_factor: float = 0.5,     # cada fallo: dt *= 0.5
    dt_min: float = 1e-4,
    maxNumIter: int = 25,          
) -> tuple:
    """
    Versión de dinamicoBD4 con ajuste adaptativo de dtan:
    - Reduce dtan si un paso no converge.
    - Ocasionalmente aumenta dtan si hay racha de pasos bien (grow_every).
    - Mantiene el mismo *output signature* que tu dinamicoBD4 original (incluye Prot si frame).
    """

    # defaults
    if Tol is None:
        Tol = 1e-4

    # Preparación de direcciones ortogonales
    dir2 = 2 if IDctrlDOF == 1 else 1

    # Definir timeSeries y patterns 
    ops.timeSeries('Path', 1000, '-filePath', record_paths[0], '-dt', dtrec, '-factor', factor)
    ops.pattern('UniformExcitation', 1000, IDctrlDOF, '-accel', 1000)
    ops.timeSeries('Path', 1001, '-filePath', record_paths[1], '-dt', dtrec, '-factor', factor)
    ops.pattern('UniformExcitation', 1001, dir2, '-accel', 1001)

    # Damping 
    nmodes = max(modes) + 1
    eigval = ops.eigen(nmodes)

    eig1 = eigval[modes[0]]
    eig2 = eigval[modes[1]]

    w1 = eig1 ** 0.5
    w2 = eig2 ** 0.5

    beta = 2.0 * damp / (w1 + w2)
    alfa = 2.0 * damp * w1 * w2 / (w1 + w2)

    if Kswitch == 1:
        ops.rayleigh(alfa, 0.0, beta, 0.0)
    else:
        ops.rayleigh(alfa, beta, 0.0, 0.0)

    # Configuración base de análisis — ajustada para velocidad con fibras HystereticSM
    ops.wipeAnalysis()
    ops.constraints('Transformation')
    ops.numberer('RCM')
    ops.system('UmfPack')              # más rápido que BandGeneral para matrices dispersas
    ops.test('NormDispIncr', Tol, maxNumIter)
    ops.algorithm('KrylovNewton')      # converge en 2-4 its vs 8-15 its de Newton para fibras
    ops.integrator('Newmark', 0.5, 0.25)
    ops.analysis('Transient')

    # Algoritmos de fallback — solo los más efectivos para modelos no-lineales
    # Orden: KrylovNewton(initial) → BFGS → NewtonLineSearch
    algoritmos = {
        1: ('KrylovNewton', True),     # (nombre, usa -initial)
        2: ('BFGS',         False),
        3: ('NewtonLineSearch', False),
    }

    # Preparación de variables
    Nsteps = int(dtrec * nPts / max(dt, 1e-9)) + 1    # paso nominal con dt inicial
    dtecho1 = [ops.nodeDisp(IDctrlNode, IDctrlDOF)]
    dtecho2 = [ops.nodeDisp(IDctrlNode, dir2)]
    t = [ops.getTime()]

    nels = len(elements)
    nnodos = len(nodes_control)
    # Para muros MVLEM_3D y la mayoría de shells, globalForce suele venir con 24 entradas.
    ndofe = 24 if eletype in ('wall', 'shell') else 12
    # ** Nota: Dimensionamos primero y luego cortamos según tiempo real **
    Eds = np.zeros((nels, Nsteps + 1, ndofe), dtype=np.float32)
    Prot = np.zeros((nels, Nsteps + 1, 6)) if eletype == 'frame' else None
    node_disp = np.zeros((Nsteps + 1, nnodos))
    node_vel = np.zeros((Nsteps + 1, nnodos))
    node_acel = np.zeros((Nsteps + 1, nnodos))
    node_disp2 = np.zeros((Nsteps + 1, nnodos))
    node_acel2 = np.zeros((Nsteps + 1, nnodos))
    driftX = np.zeros((Nsteps + 1, nnodos - 1))
    driftY = np.zeros((Nsteps + 1, nnodos - 1))

    # Estado adaptativo
    time_target = dtrec * nPts
    ok = 0
    step = 0

    # Bucle por tiempo REAL
    while ops.getTime() + 1e-12 < time_target:
        # 1) intento con dt original
        ok = ops.analyze(1, dt)

        # 2) si falla: reducir dt directamente a dt/4 (convergencia más rápida)
        if ok != 0:
            dt_red = max(dt * reduce_factor * reduce_factor, dt_min)  # dt/4 de una vez
            while ok != 0 and dt_red >= dt_min:
                ok = ops.analyze(1, dt_red)
                if ok == 0:
                    break
                dt_red = max(dt_red * reduce_factor, dt_min)

        # 3) algoritmos alternativos con presupuesto de iteraciones acotado
        if ok != 0:
            for j, (alg_name, use_initial) in algoritmos.items():
                if use_initial:
                    ops.algorithm(alg_name, '-initial')
                else:
                    ops.algorithm(alg_name)
                ops.test('NormDispIncr', Tol, maxNumIter * 8)  # 8× (antes 50×)
                ok = ops.analyze(1, max(dt_red, dt_min))
                if ok == 0:
                    break

            # 4) si no hay convergencia por ningún camino: abortar
            if ok != 0:
                print('Análisis dinámico fallido')
                print('Desplazamiento alcanzado:', ops.nodeDisp(IDctrlNode, IDctrlDOF), 'm')
                break

            # Restaurar configuración base eficiente
            ops.test('NormDispIncr', Tol, maxNumIter)
            ops.algorithm('KrylovNewton')

        # ----- Registro de resultados -----
        step += 1
        if step >= node_disp.shape[0]:
            # crecer buffers si hace falta
            grow = max(1024, step // 2)
            
            def _grow(arr, tail_shape):
                new = np.zeros((arr.shape[0] + grow, *tail_shape), dtype=arr.dtype)
                new[:arr.shape[0]] = arr
                return new
            
            def _grow_time1(arr, grow):
                # arr: (nels, time, k)
                new = np.zeros((arr.shape[0], arr.shape[1] + grow, arr.shape[2]), dtype=arr.dtype)
                new[:, :arr.shape[1], :] = arr
                return new
            node_disp  = _grow(node_disp,  (nnodos,))
            node_vel   = _grow(node_vel,   (nnodos,))
            node_acel  = _grow(node_acel,  (nnodos,))
            node_disp2 = _grow(node_disp2, (nnodos,))
            node_acel2 = _grow(node_acel2, (nnodos,))
            driftX     = _grow(driftX,     (nnodos - 1,))
            driftY     = _grow(driftY,     (nnodos - 1,))
            # Eds        = _grow(Eds,        (nels, ndofe))
            if Eds is not None and step >= Eds.shape[1]:
                Eds = _grow_time1(Eds, grow)
        
            if Prot is not None and step >= Prot.shape[1]:
                Prot = _grow_time1(Prot, grow)

        dtecho1.append(ops.nodeDisp(IDctrlNode, IDctrlDOF))
        dtecho2.append(ops.nodeDisp(IDctrlNode, dir2))
        t.append(ops.getTime())

        for i, nd in enumerate(nodes_control):
            node_disp[step, i]  = ops.nodeDisp(nd, IDctrlDOF)
            node_disp2[step, i] = ops.nodeDisp(nd, dir2)
            node_vel[step, i]   = ops.nodeVel(nd, IDctrlDOF)
            node_acel[step, i]  = ops.nodeAccel(nd, IDctrlDOF)
            node_acel2[step, i] = ops.nodeAccel(nd, dir2)
            if i != 0:
                z  = ops.nodeCoord(nd, 3)
                zp = ops.nodeCoord(nodes_control[i - 1], 3)
                dz = z - zp
                if dz != 0.0:
                    driftX[step, i - 1] = (ops.nodeDisp(nd, 1) - ops.nodeDisp(nodes_control[i - 1], 1)) / dz
                    driftY[step, i - 1] = (ops.nodeDisp(nd, 2) - ops.nodeDisp(nodes_control[i - 1], 2)) / dz

        for e_i, e in enumerate(elements):
            try:
                gf = ops.eleResponse(e, 'globalForce')
                if gf is not None:
                    gf = np.asarray(gf, dtype=float).ravel()
                    # Ajuste defensivo si el tamaño no coincide con ndofe
                    m = min(len(gf), ndofe)
                    Eds[e_i, step, :m] = gf[:m]
            except Exception:
                pass
            if eletype == 'frame' and Prot is not None:
                try:
                    Prot[e_i, step, :] = ops.eleResponse(e, 'plasticDeformation')
                except Exception:
                    pass

    # Recortes y salidas
    techo1 = np.array(dtecho1)
    techo2 = np.array(dtecho2)
    techoT = np.sqrt(techo1**2 + techo2**2)
    tiempo = np.array(t)

    node_disp  = node_disp[:step + 1]
    node_vel   = node_vel[:step + 1]
    node_acel  = node_acel[:step + 1]
    node_disp2 = node_disp2[:step + 1]
    node_acel2 = node_acel2[:step + 1]
    driftX     = driftX[:step + 1]
    driftY     = driftY[:step + 1]
    Eds        = Eds[:, :step + 1]
    if Prot is not None:
        Prot = Prot[:, :step + 1]

    # Salida estable: siempre devolvemos Prot (None si no aplica) y Eds
    return (tiempo, techo1, techo2, techoT,
            node_disp, node_vel, node_acel, node_disp2, node_acel2,
            driftX, driftY, Prot, Eds)
    
#%% FUNCION QUE CORRE EL DINAMICO
def run_pair_dynamic(
    root_path:str,
    scale: float,
    ind: int,
    class_ops,
    store_data: Dict[str, Any],
    fema_records: Dict[str, Any],
    default_damp_ratio: float = 0.025,
    dt_analysis: float = 0.005,     
    eletype: str = 'frame'
):
    # Construir modelo 
    class_ops.builder(root_path)
    Tol = _compute_tol(1e-4)

    # Correr gravedad
    optools_an.gravedad(Tol=Tol)
    ops.loadConst('-time', 0.0)

    # Registros
    record_paths, dtrec, nsteps = _read_pair(fema_records, ind)

    # Nodos
    node_record, _ = _control_nodes_from_store(store_data)
    ctrl_node = max(node_record)
    factoran = 9.81 * float(scale)
    
    # Seleccionar elementos a registrar según el sistema del modelo.
    # Si el usuario fuerza eletype='frame' pero no hay beams, se hace fallback automático.
    elements_to_record, eletype_final = _pick_record_elements(store_data, prefer=eletype)
        

    # Llamar a la rutina “pushover-style”
    return dinamicoBD4_adaptive(
        record_paths=record_paths,
        dtrec=dtrec,
        nPts=nsteps,
        dt=dt_analysis,
        factor=factoran,
        damp=default_damp_ratio,
        IDctrlNode=ctrl_node,
        IDctrlDOF=1,
        nodes_control=node_record,
        elements=elements_to_record,
        modes=(0, 2),
        Kswitch=1,
        Tol=Tol,
        eletype=eletype_final,
        reduce_factor=0.5,
        dt_min=1e-4,
        maxNumIter=25,
    )