"""
@author: Daniela Novoa, Orlando Arroyo, Frank Vidales
@owner: EstrucMed Ingeniería especializada S.A.S

-------------------------------------------------------------------------------
                    Módulo de Análisis Pushover Unidireccional
                Resultados + Visualización Interactiva (Dashboard)
-------------------------------------------------------------------------------

Este módulo ejecuta el análisis pushover en una dirección especificada 
(X o Y) sobre el modelo OpenSeesPy y genera el reporte correspondiente.

Incluye:
    • Generación de patrón lateral tipo FHE.
    • Control del desplazamiento mediante punto objetivo (nodo de control).
    • Registro de curva de capacidad: fuerza base vs desplazamiento.
    • Evaluación del mecanismo de colapso y deformaciones plásticas.

Además, se genera un **dashboard visual** que incluye:
    - Curva de capacidad interactiva (Plotly).
    - Tabla resumen de deformaciones y esfuerzos.
    - Animación de la deformación progresiva usando `opstool`.

Este módulo es clave para evaluar la capacidad sísmica del sistema 
estructural en análisis no lineal estático.

Unidades: Sistema Internacional (SI)
Norma base: NSR-10 (o FEMA 440/FEMA P-795 si se especifica)

"""     

import pandas as pd
import openseespy.opensees as ops
import sys
import os
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import base64
from tqdm import tqdm
import opseestools.analisis3D as an
import matplotlib.pyplot as plt
import pickle
import json

utils_path = os.getcwd()
sys.path.append(utils_path)

# Importar módulos personalizados
import utilities as ut

class pushoverclass:
        
    point_style = {
        'capacidad_maxima':        {'name': 'Capacidad máxima',                    'marker-color': '#000000', 'marker-size': 12, 'marker-symbol': 'square'      },
        'capacidad80':             {'name': 'Capacidad al 80%',                    'marker-color': '#000000', 'marker-size': 12, 'marker-symbol': 'diamond'     },
        'fluencia_acero':          {'name': 'Primera fluencia del acero',          'marker-color': '#75B72A', 'marker-size': 12, 'marker-symbol': 'triangle-up' },
        'agrietamiento_concreto':  {'name': 'Primer agriertamiento del concreto',  'marker-color': '#75B72A', 'marker-size': 12, 'marker-symbol': 'star'        }
        }
    
    def __init__(self, model_data, main_path, direction, tag_pattern, odb_tag, pattern_type, Dmax, DInc, push_error, maxNumIter, record_elements=False):
        
        self.model_data = model_data
        self.push_path = os.path.abspath(os.path.join(main_path, 'outputs', 'pushover_results'))
        self.dir = direction
        self.nPisos = self.model_data['general_data']['number_stories']
        self.pattern_type = 'uniforme' if self.nPisos > 12 else pattern_type.lower()
        self.Dmax = Dmax
        self.height = None
        self.odb_Tag = odb_tag
        self.tag_pattern = tag_pattern
        self.DInc = DInc
        self.push_error = push_error
        self.maxNumIter = maxNumIter
        self.record_elements = record_elements  # False = saltar eleResponse → mucho más rápido
        
        error = self.push_error
        Tol = error*np.sqrt(len(ops.getNodeTags())*6)
        
        an.gravedad(Tol)
        ops.loadConst('-time', 0.0)
        
        self.techo = None
        self.Vbasal_norm = None
        self.story_drift = None
        self.Vbasal = None
        self.global_forces = None
        self.plastic_rotations = None
        
    def run_analysis(self):
        print("▶️ Entrando a run_analysis")
        
        results = self._main_PSanalysis(self.tag_pattern, self.dir)
        
        self.techo = results['dtecho']
        self.Vbasal_norm = results['Vbasal_norm']
        self.Vbasal = results['Vbasal']
        self.story_drift = results['story_drift']
        self.global_forces = results['global_forces']
        self.plastic_rotations = results['plastic_rotations']
        print("▶️ Llamando export_results_report")
        print("📂 Ruta:", self.push_path)
        
        self.export_results_report()
        
        print("✅ export_results_report ejecutado")
    
    def _main_PSanalysis(self, tag_pattern, direction):
        dnodes = sorted([int(k) for k in self.model_data['center_of_mass_information'].keys()])
        
        masas = [subdic['mass_x'] / 1000
                for subdic in self.model_data['center_of_mass_information'].values()
                if 'mass_x' in subdic
                ]
                        
        coordz = [0]
        List_z = [subdic['global_z'] for subdic in self.model_data['center_of_mass_information'].values() if 'global_z' in subdic]
        coordz.extend(List_z)
        self.height = max(coordz)
                
        k = 1.0 # el k de toda la vida para la FHE
        Mest = np.sum(masas)
        
        # Asignación de Cargas Según Patrón
        if self.pattern_type == 'triangular':
            
            # Rutina para calcular mh^k para cada piso
            fi = []
            for i in range(len(dnodes)):
                fi.append(masas[i]*coordz[i+1]**k)
            fi = np.array(fi)
            
            fact = fi/np.sum(fi) # se calcula el factor de corte para cada piso según la norma
                    
        elif self.pattern_type == "uniforme":
            fact = np.array([1.0] * len(dnodes)) / len(dnodes)
            
        elif self.pattern_type == "modal":
            eigforce = []
            for i, n in enumerate(dnodes):
                dof = 1 if self.dir == 'X' else 2
                eigforce.append(ops.nodeEigenvector(n, dof, 1))
                
            eigforce = np.array(eigforce)
            fact = eigforce / np.sum(np.abs(eigforce))
            
        else:
            raise ValueError(f"Patrón de carga no válido: {self.pattern_type}")
            
        # Rutina para asignar las cargas
        ops.timeSeries('Linear', tag_pattern)
        ops.pattern('Plain',tag_pattern,tag_pattern)
        
        for i,n in enumerate(dnodes):
            if direction == 'X':
                ops.load(int(n),fact[i], 0.0, 0.0, 0.0, 0.0, 0.0)
            elif direction == 'Y':
                ops.load(int(n), 0.0, fact[i], 0.0, 0.0, 0.0, 0.0)
        
        IDctrlDOF = 1 if direction == 'X' else 2
        
        nodes_control= dnodes
        
        results = self._pushoveroutine(self.Dmax*self.height, self.DInc, dnodes[-1], IDctrlDOF, nodes_control,
                                       record_elements=self.record_elements)
        
        dtecho = results["techo"] * 100 / self.height
        Vbasal_norm = results["Vbasal"] / (Mest * 9.81)
        Vbasal = results.get("Vbasal", [])
        story_drift = results.get("story_drift", [])
        global_forces = results.get("global_forces", [])
        plastic_rotations = results.get("plastic_rotations", [])
        
        return {"dtecho": dtecho,
                "Vbasal_norm": Vbasal_norm,
                "story_drift": story_drift,
                "Vbasal": Vbasal,
                "global_forces": global_forces,
                "plastic_rotations": plastic_rotations}
            

    def _pushoveroutine(self, Dmax, Dincr, IDctrlNode, IDctrlDOF, nodes_control,
                        dincr_min = 1e-4, reduction_factor = 0.5,
                        vbasal_limit = 0.5, drift_limit = 0.15, eletype='frame',
                        record_elements = False):
        
        maxNumIter = self.maxNumIter
        elements = ops.getEleTags()
        
        # 1). Cálculo de la tolerancia dado el Error y número de grados de libertad
        # propuesto po Michael H. Scott 
        error = self.push_error
        Tol = error*np.sqrt(len(ops.getNodeTags())*6)

        # # 2). Configuración básica del análisis
        # ops.wipeAnalysis()
        # ops.constraints('Transformation')
        # ops.numberer('RCM')
        # # ops.system('BandGeneral')
        # # ops.system('UmfPack')
        # ops.system('SparseGeneral')
        # # ops.test('NormUnbalance', Tol, maxNumIter)
        # ops.test('NormDispIncr', 1e-4, 200)
        # # ops.algorithm('Newton')    
        # # ops.algorithm('KrylovNewton')
        # ops.algorithm('NewtonLineSearch', 'type', 'Bisection')
        # ops.integrator('DisplacementControl', IDctrlNode, IDctrlDOF, Dincr)
        # ops.analysis('Static')
        
        # 2). Configuración base optimizada para fibras HystereticSM
        ops.wipeAnalysis()
        ops.constraints('Transformation')
        ops.numberer('RCM')
        ops.system('UmfPack')
        ops.test('NormDispIncr', 1e-4, 25)          # 25 iter: falla rápido y prueba alternativas
        ops.algorithm('KrylovNewton')               # ~40% menos iteraciones que Newton en fibras
        ops.integrator('DisplacementControl', IDctrlNode, IDctrlDOF, Dincr)
        ops.analysis('Static')

        # 3). Algoritmos de fallback — solo los más efectivos para pushover no-lineal
        algoritmo = {1: 'KrylovNewton', 2: 'BFGS', 3: 'NewtonLineSearch', 4: 'SecantNewton'}
        
        # algoritmo = {
        #     1: 'KrylovNewton',       # el más robusto → dejar primero
        #     2: 'NewtonLineSearch',   # excelente cuando hay softening
        #     3: 'BFGS',               # muy bueno para degradación fuerte
        #     4: 'SecantNewton',       # útil cuando Newton falla
        #     5: 'PeriodicNewton',     # fallback final
        #     6: 'Broyden'             # opcional, a veces salva modelos difíciles
        # }
        

        # 4). Inicializar variables
        
        dtecho = [ops.nodeDisp(IDctrlNode,IDctrlDOF)] # Deriva de techo (lista)
        Vbasal = [ops.getTime()] # Vbasal (lista)
        drift = [] # Guardar derivas de piso (lista)
        
        Vmax = 0 # Contador de Vbasal máximo
        Dincr_red = Dincr # Paso reducido inicial
        step = 0 # Contador aumento de pasos
        
        # Registro de elementos — solo si se solicita explícitamente.
        # Con record_elements=False (web): ~866k llamadas eleResponse eliminadas → ×8 más rápido.
        # Con record_elements=True  (PKL/Excel): datos completos de fuerzas y rotaciones.
        if record_elements:
            global_forces     = {ele: [] for ele in elements}
            plastic_rotations = {ele: [] for ele in elements} if eletype == 'frame' else {}
        else:
            global_forces     = {}
            plastic_rotations = {}
        
        # 5). Rutina de análisis
        # Genera un bucle infinito hasta que el modelo deje de converger de manera definitiva
        
        while True:
            ok = ops.analyze(1)
            # 5.1). Probar convergencia con paso reducido (Intentar con pasos aún más pequeños)
            while ok != 0 and Dincr_red > dincr_min:
                Dincr_red *= reduction_factor # paso reducido
                ops.integrator('DisplacementControl', IDctrlNode, IDctrlDOF, Dincr_red)
                
                ok = ops.analyze(1)
                
                # 5.1.1). Si converge con paso reducido, continua con paso original
                if ok == 0:
                    # Si converge, restaura el paso original y continua el análisis
                    ops.integrator('DisplacementControl', IDctrlNode, IDctrlDOF, Dincr)
                    Dincr_red = Dincr
                    break
            
            # 5.2). Si no converge con paso reducido, intentar con algoritmos alternativos
            if ok != 0:
                for j in algoritmo:
                    alg = algoritmo[j]
                    if alg == 'KrylovNewton':
                        ops.algorithm(alg, '-initial')
                    else:
                        ops.algorithm(alg)
                    ops.test('NormDispIncr', 1e-4, maxNumIter)  # acotado, no 5000
                    ok = ops.analyze(1)
                    if ok == 0:
                        # Restaurar configuración base eficiente
                        ops.test('NormDispIncr', 1e-4, 25)
                        ops.algorithm('KrylovNewton')
                        ops.integrator('DisplacementControl', IDctrlNode, IDctrlDOF, Dincr)
                        break
                    
            # 5.3). Si no hay convergencia de ningun modo, el análisis falló
            if ok != 0:
                tqdm.write(f'🔶​ Desplazamiento alcanzado: {round(ops.nodeDisp(IDctrlNode,IDctrlDOF),4)} m')
                break
            
            current_drift = []
            for node_i, node_tag in enumerate(nodes_control):
                if node_i == 0:
                    current_drift.append((ops.nodeDisp(node_tag, IDctrlDOF) / (ops.nodeCoord(node_tag, 3))))
                else:
                    current_drift.append((ops.nodeDisp(node_tag, IDctrlDOF) - ops.nodeDisp(nodes_control[node_i - 1], IDctrlDOF)) / 
                                         (ops.nodeCoord(node_tag, 3) - ops.nodeCoord(nodes_control[node_i - 1], 3)))
                
            dtecho.append(ops.nodeDisp(IDctrlNode,IDctrlDOF))
            Vbasal.append(ops.getTime())
            drift.append(current_drift)
            
            if record_elements:
                for el_i, ele_tag in enumerate(elements):
                    try:
                        gf = ops.eleResponse(ele_tag, 'globalForce')
                        global_forces[ele_tag].append(gf)
                    except:
                        global_forces[ele_tag].append([np.nan]*6)

                    if eletype == 'frame':
                        try:
                            plast_rot = ops.eleResponse(ele_tag, 'plasticDeformation')
                            plastic_rotations[ele_tag].append(plast_rot)
                        except:
                            plastic_rotations[ele_tag].append([np.nan]*6)
            
            # 5.4). Actualizar Vmax: siempre y cuando encuentre un valor mas grande
            if Vbasal[-1] > Vmax:
                Vmax = Vbasal[-1]
                
            # # detectar softening estructural
            # if Vmax > 0 and Vbasal[-1] < 0.95*Vmax:
            #     Dincr = max(Dincr*0.7, dincr_min)
            #     ops.integrator('DisplacementControl', IDctrlNode, IDctrlDOF, Dincr)
                
            # 5.5). Comprobar si Vbasal se reduce al 75% de Vmax (75% por defecto)
            if Vbasal[-1] <= vbasal_limit * Vmax:
                tqdm.write(f'Capacidad basal reducida al {int(vbasal_limit*100)}% de la máxima ({Vmax:.2f} kN). Terminando análisis...')
                break
            
            # 5.6). Comprobar que una deriva de entre piso llegó a 6% (6% por defecto)
            if max(drift[-1]) >= drift_limit: 
                piso_deriva = np.where(drift[-1] == max(drift[-1]))[0][0]
                tqdm.write(f'La deriva del piso {piso_deriva} alcanzó un valor mayor o igual a {int(drift_limit*100)}%. Terminando análisis...')
                break
            
            # 5.7). Finalizar cuando el desplazamiento es mayor que el objetivo
            if ops.nodeDisp(IDctrlNode,IDctrlDOF) > Dmax:
                break
            
            step += 1 
            
        return {"techo": np.array(dtecho),
                "Vbasal": np.array(Vbasal), 
                "story_drift": np.array(drift), 
                "global_forces": global_forces, 
                "plastic_rotations": plastic_rotations}

    def _pushover_analysisPoints(self, section_resp, techo, V,  
                                        steel_yield_strain=0.0021, conc_crack_strain=0.00013):
        """
        Analiza el pushover basado en las deformaciones de sección (no fibras).
        Detecta capacidad máxima, 80%, primer agrietamiento y primera fluencia.
    
        Args:
            section_resp (dict): Diccionario con las respuestas de sección (Deformations).
            techo (array): Desplazamientos del techo en cada paso.
            V (array): Cortante basal en cada paso.
            steel_yield_strain (float): Deformación que indica fluencia.
            conc_crack_strain (float): Deformación que indica agrietamiento de concreto.
        
        Returns:
            dict: Resultados de Vmax, V80, Dcrack, Dyield.
        """
            
        # Capacidad máxima
        Vmax_idx = np.argmax(V)
        Vmax = V[Vmax_idx]
        Dmax = techo[Vmax_idx]
    
        # Capacidad al 80%
        eighty_percent = 0.8 * Vmax
        idx_80 = np.where(V >= eighty_percent)[0][-1]
        D80 = techo[idx_80]
        idx_80 = np.where(techo == D80)[0][0]
        V80 = V[idx_80]
        
        # Deformaciones de sección
        deformations = section_resp["sectionDeformations"]  # (time, eleTag, secPoint, components)
        # components típicamente son: [ε11, ε22, γ12, κ11, κ22, κ12] (varía un poco dependiendo del elemento)
    
        # Vamos a suponer que la deformación relevante para agrietamiento es ε11 o ε22
        # Por ahora tomo ε11 (componente 0) para vigas/columnas
    
        strains_e1 = deformations[..., 0]  # Extraer ε11 (tensión normal eje 1)
    
        # Considerar sólo extremos (secPoints 0 y último)
        strains_extremos = strains_e1[:, :, [0, -1]]  # (time, eleTag, 2)
    
        # Aplanar para facilitar análisis
        strains_flat = strains_extremos.values.reshape(strains_extremos.shape[0], -1)  # (time, eleTag*2)
    
        # Detectar primer agrietamiento
        idx_crack = None
        for i in range(strains_flat.shape[0]):
            positive_strains = strains_flat[i, strains_flat[i, :] > 0]  # Sólo tracción
            if (positive_strains >= conc_crack_strain).any():
                idx_crack = i
                break
            
        if idx_crack is not None:
            Dcrack = techo[idx_crack]
            Vcrack = V[idx_crack]
        else:
            Dcrack = Vcrack = None
    
        # Detectar primer fluencia
        idx_yield = None
        for i in range(strains_flat.shape[0]):
            if (strains_flat[i, :] >= steel_yield_strain).any():
                idx_yield = i
                break
    
        if idx_yield is not None:
            Dyield = techo[idx_yield]
            Vyield = V[idx_yield]
        else:
            Dyield = Vyield = None
    
        # Resultados
        result = {
            # key : (capacidad normalizada, deriva de techo)
            'capacidad_maxima': (Vmax, Dmax),
            'capacidad80': (V80, D80),
            'fluencia_acero': (Vyield, Dyield),
            'agrietamiento_concreto': (Vcrack, Dcrack)
        }
        
        return result
    
    def _proccessInfo(self):
        
        # Derivas 1% por piso y maximas
        idx_drift, max_drifts = [], []
        for i in range(np.size(self.drift,axis=1)):
            drift_story = self.drift[:,i]*100
            max_drifts.append(max(drift_story))
            for idx, drf in enumerate(drift_story):
                if drf >= 1:
                    idx_drift.append(idx)
                    break
                
        if len(idx_drift) > 0:
            for i, idx in enumerate(idx_drift):
                if idx is not None:
                    self.impPoints[f'1deriva_piso{i+1}'] = (self.vbasal[idx+1], self.techo[idx+1])
                else:
                    self.impPoints[f'1deriva_piso{i+1}'] = None
                    
        for i in range(len(max_drifts)):
            key = f'1deriva_piso{i+1}'
            self.point_style[key] = {
                'name': f'1% de deriva en el piso {i+1}',
                'marker-color': ut.generar_color_aleatorio(),
                'marker-size': 9,
                'marker-symbol': 'circle'
            }
                    
        self.fig_animation = opsvis.plot_nodal_responses_animation(
                                odb_tag=self.odb_Tag,
                                resp_type="disp",
                                resp_dof=["UX", "UY"],
                                framerate=30,
                                scale=3.0
                            )
        
        self.maxDrifts = max_drifts
        self.idx_drift = idx_drift
        

    def export_results_report(self):
        """
        Exporta los resultados del análisis pushover a Excel y genera figuras clave.
        Guarda todo en self.push_path.
        """
        
        # ---------------------------
        # 0. Crear estructura de carpetas
        # ---------------------------
        carpetas = {
            "datos": os.path.join(self.push_path, "datos"),
            "excel": os.path.join(self.push_path, "excel"),
            "imagenes": os.path.join(self.push_path, "imagenes")
        }
        for ruta in carpetas.values():
            os.makedirs(ruta, exist_ok=True)
        
        # ---------------------------
        # 1. Datos resumen
        # ---------------------------
        resumen = {
            'Deriva máxima': [max(self.techo)],
            'Cortante basal máximo (kN)': [max(self.Vbasal)],
            'Cortante basal normalizado máximo': [max(self.Vbasal_norm)],
        }
        df_resumen = pd.DataFrame(resumen)
    
        # ---------------------------
        # 2. Techo vs Cortantes
        # ---------------------------
        df_techo = pd.DataFrame({
            'Paso': list(range(len(self.techo))),
            'Deriva de Techo (%)': self.techo,
            'Cortante Basal (kN)': self.Vbasal,
            'Cortante Basal Normalizado (%)': self.Vbasal_norm,
        })
    
        # ---------------------------
        # 3. Derivas por piso
        # ---------------------------
        num_pisos = self.nPisos
        df_drift = pd.DataFrame(self.story_drift, columns=[f'Piso {i+1}' for i in range(num_pisos)])
        df_drift.insert(0, 'Paso', list(range(len(self.story_drift))))
        
        direction = f'_{self.dir}'
        
        # ---------------------------
        # 4. Exportar a Excel
        # ---------------------------
        excel_path = os.path.join(carpetas["excel"], f'pushover_resultados{direction}.xlsx')
        with pd.ExcelWriter(excel_path, engine='xlsxwriter') as writer:
            df_resumen.to_excel(writer, sheet_name='Resumen', index=False)
            df_techo.to_excel(writer, sheet_name='Techo', index=False)
            df_drift.to_excel(writer, sheet_name='Derivas', index=False)
        
        # ---------------------------
        # 5. Figura Pushover: Techo vs Vbasal_norm
        # ---------------------------
        fig, ax = plt.subplots(figsize=(8, 6))
        ax.plot(self.techo, self.Vbasal_norm, ls ='solid', color='blue', lw = 2.0)
        ax.set_xlabel('Deriva de techo (%)', fontsize=16, fontweight='bold')
        ax.set_ylabel('Vb/W', fontsize=16, fontweight='bold')
        ax.tick_params(labelsize = 14, width=2)
        ax.grid(True)
        fig.tight_layout()
        fig_path = os.path.join(carpetas["imagenes"], f'Pushover{direction}.png')
        fig.savefig(fig_path, dpi=300)
        plt.close(fig)
        
        # ---------------------------
        # 6. Guardar resultados
        # ---------------------------
        full_dict = {
            "dtecho": self.techo,
            "vbasal_norm": self.Vbasal_norm,
            "drifts": self.story_drift,
            "vbasal": self.Vbasal,
            "global_forces": self.global_forces,
            "plastic_rotations": self.plastic_rotations,
        }

        # PKL: datos completos (incluye fuerzas y rotaciones plásticas para Excel)
        pkl_path = os.path.join(carpetas["datos"], f"pushover_resultados{direction}.pkl")
        with open(pkl_path, 'wb') as f:
            pickle.dump(full_dict, f)

        # JSON: solo datos necesarios para la web (sin global_forces ni plastic_rotations)
        lean_dict = {
            "dtecho":      self.techo,
            "vbasal":      self.Vbasal,
            "vbasal_norm": self.Vbasal_norm,
            "drifts":      self.story_drift,
        }
        json_path = os.path.join(carpetas["datos"], f"pushover_resultados{direction}.json")
        try:
            serializable = json.loads(json.dumps(lean_dict, default=lambda o: o.tolist() if hasattr(o, "tolist") else o))
            with open(json_path, 'w') as f:
                json.dump(serializable, f, indent=2)
        except Exception as e:
            print(f"⚠️ No se pudo exportar a JSON: {e}")
        
        # ---------------------------
        # 7. Final
        # ---------------------------
        tqdm.write("✅ Resultados exportados correctamente")
        tqdm.write(f"📄 Excel: {excel_path}")
        tqdm.write(f"🖼️ Gráfico: {fig_path}")
        tqdm.write(f"📦 Pickle: {pkl_path}")
        tqdm.write(f"📝 JSON: {json_path}")
        print("📂 Guardando en:", self.push_path)
    