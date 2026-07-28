"""
@author: Daniela Novoa, Orlando Arroyo, Frank Vidales
@owner: EstrucMed Ingeniería especializada S.A.S

-------------------------------------------------------------------------------
                      CSI Model Converter to OpenSeesPy
                          Versión: ETABS17 v17.0.1
    
    Lee, procesa y genera el modelo lineal y no lineal de edificios en 3D

Este script contiene:
    
    1. Lectura y procesamiento de datos
    2. Almacenamiento de data para base de datos
    3. Generador del modelo

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
import numpy as np
import pandas as pd
from tqdm import tqdm
import warnings
import re 
import math
import ast

# --- Librerias opensees
import opstool as opst
import openseespy.opensees as ops
import opseestools.utilidades as optools_ut
import opseestools.analisis3D as optools_an

#%% ==> LECTURA Y PROCESAMIENTO DE DATOS

# Clase principar para el procesamiento de los datos CSI
class CsiDataProcessor:
    def __init__(self):
        
        self.initial_parameters = ImportParametersData(root_path).initial_parameters        # Initial Parameters
        self.raw_importer = ImportCSIData(root_path)                                        # CSI dict data

        # VALIDACIÓN DE HOJAS según initial_parameters
        self.raw_importer.validate_input_model_sheets(self.initial_parameters)
        self.raw_data = self.raw_importer.raw_data

        self.function_kwargs = {
            'rcmrf_store_data_builder': ['joints','center_of_mass','materials','slabsTA','beamsTA','columns'],
            'wrcf_store_data_builder': ['joints','center_of_mass','materials','slabs','beams','walls'],
            'dual_store_data_builder': ['joints','center_of_mass','materials','slabs','beams','columns','walls'],
        }

        self.processor = ProcessModelObjects(self.raw_data, self.initial_parameters)

        self.joints = self.processor.df_joints                  # Processed joints
        self.center_of_mass = self.processor.center_of_mass     # Processed center of mass nodes
        self.materials = self.processor.df_materials            # Processed materials
        self.slabs = self.processor.df_slabs                    # Processed slabs
        self.beams = self.processor.df_beams                    # Processed beams
        self.slabsTA = self.processor.df_slabsTA                # Processed slabsTA
        self.beamsTA = self.processor.df_beamsTA                # Processed beamsTA
        self.columns = self.processor.df_columns                # Processed columns
        self.walls = self.processor.df_walls                    # Processed walls
        
        self.processed_data = {
            'joints': self.joints,
            'center_of_mass': self.center_of_mass,
            'materials': self.materials,
            'slabs': self.slabs, 
            'slabsTA': self.slabsTA,
            'beams': self.beams,
            'beamsTA': self.beamsTA,
            'columns': self.columns,
            'walls': self.walls
        }

        if getattr(self.processor, "warnings", []):
            print("\n".join(self.processor.warnings))
        
# Clase que importa y almacena en un diccionario la informacion de ETABS
class ImportCSIData:
    
    tables_name = {
        # OBJECTS AND ELEMENTS TABLES -----------------------------------------------------
        'TABLE:  "OBJECTS AND ELEMENTS - JOINTS"':      'Objects and Elements - Joints',
        'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"':      'Objects and Elements - Shells',
        'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"':      'Objects and Elements - Frames',
        'TABLE:  "FLOOR CONNECTIVITY"':                 'Floor Connectivity',
        # CONCRETE PROPERTIES -------------------------------------------------------------
        'TABLE:  "MATERIAL PROPERTIES - CONCRETE"':     'Material Properties - Concrete',
        # CENTER OF MASS PROPERTIES -------------------------------------------------------
        'TABLE:  "MASS SUMMARY BY DIAPHRAGM"':          'Mass Summary by Diaphragm',
        'TABLE:  "JOINT ASSIGNMENTS - DIAPHRAGMS"':     'Joint Assignments - Diaphragms',
        # JOINT PROPERTIES ----------------------------------------------------------------
        'TABLE:  "JOINT ASSIGNMENTS - RESTRAINTS"':     'Joint Assignments - Restraints',
        # FRAME PROPERTIES ----------------------------------------------------------------
        'TABLE:  "FRAME SECTIONS"':                     'Frame Sections',   
        'TABLE:  "FRAME ASSIGNMENTS - SECTIONS"':       'Frame Assignments - Sections',
        'TABLE:  "FRAME ASSIGNMENTS - LOCAL AXES"':     'Frame Assignments - Local Axes',
        'TABLE:  "FRAME ASSIGNMENTS - OFFSETS"':        'Frame Assignments - Offsets',
        'TABLE:  "FRAME LOADS - DISTRIBUTED"':          'Frame Loads - Distributed',
        # SHELL PROPERTIES ----------------------------------------------------------------
        'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"':       'Shell Assignments - Sections',
        # COLUMN PROPERTIES ---------------------------------------------------------------
        'TABLE:  "CONCRETE COLUMN REBAR DATA"':         'Concrete Column Rebar Data',
        'TABLE:  "CONCRETE COLUMN SUMMARY - ACI3"':     'Concrete Column Summary - ACI 3',
        # BEAM PROPERTIES -----------------------------------------------------------------
        'TABLE:  "CONCRETE BEAM REBAR DATA"':           'Concrete Beam Rebar Data',
        'TABLE:  "CONCRETE BEAM SUMMARY - ACI3"':       'Concrete Beam Summary - ACI 318',
        # SLAB PROPERTIES -----------------------------------------------------------------
        'TABLE:  "SHELL SECTIONS - SLAB"':              'Shell Sections - Slab',
        'TABLE:  "SHELL LOADS - UNIFORM"':              'Shell Loads - Uniform',
        # WALL PROPERTIES -----------------------------------------------------------------
        'TABLE:  "SHELL SECTIONS - WALL"':              'Shell Sections - Wall',
        'TABLE:  "PIER SECTION PROPERTIES"':            'Pier Section Properties', 
        'TABLE:  "SHEAR WALL PIER SUMMARY - ACI 3"':    'Shear Wall Pier Summary - ACI 3',
        'TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"':    'Shell Assignments - Pier Spandr',
        }
    
    def __init__(self, root_path):
        
        # self.csi_file_path = os.path.join(root_path,'data','temp','csi_tables','input_model.xlsx')
        self.csi_file_path = os.path.join(root_path,'data','database','input_model.xlsx')
        self.csi_file = pd.ExcelFile(self.csi_file_path)
        self.sheet_names = self.csi_file.sheet_names
        # --> Importar la data CSI
        self.import_csi_data()

    def import_csi_data(self):
        self.raw_data = {}
        print('\n')
        for key, sheet in tqdm(self.tables_name.items(), desc="Reading ETABS tables"):
            if sheet in self.sheet_names:
                self.raw_data[key] = pd.read_excel(self.csi_file_path, sheet_name=sheet, skiprows=1).drop(index=0)
            else:
                self.raw_data[key] = None
    
    def validate_input_model_sheets(self, initial_parameters: dict):
        """
        Valida que input_model.xlsx tenga las hojas necesarias según:
        - structure_system: RCMRF / WRCF / DUAL
        - rebar_type: Ingresado / Diseño ETABS
        """
        # Hojas base SIEMPRE necesarias para que el parser no quede en None
        required_base = {
            'Objects and Elements - Joints',
            'Objects and Elements - Shells',
            'Objects and Elements - Frames',
            'Floor Connectivity',
            'Material Properties - Concrete',
            'Mass Summary by Diaphragm',
            'Joint Assignments - Restraints',
            'Frame Sections',
            'Frame Assignments - Sections',
            'Shell Assignments - Sections',
            'Shell Sections - Slab',
            'Shell Loads - Uniform',
        }

        # Opcionales (pueden no existir)
        optional = {
            'Frame Assignments - Local Axes',
            'Frame Assignments - Offsets',
            'Frame Loads - Distributed',
        }

        system = str(initial_parameters.get('structure_system', '')).strip().upper()
        rebar_type = str(initial_parameters.get('rebar_type', '')).strip()

        # Rebar condicional
        required_rebar = set()
        if rebar_type == 'Ingresado':
            # deben existir “Rebar Data”
            required_rebar |= {'Concrete Beam Rebar Data'}
            if system in ('RCMRF', 'DUAL'):
                required_rebar |= {'Concrete Column Rebar Data'}
        else:
            # deben existir “Summary - ACI”
            required_rebar |= {'Concrete Beam Summary - ACI 318'}
            if system in ('RCMRF', 'DUAL'):
                required_rebar |= {'Concrete Column Summary - ACI 3'}

        # Muros condicional
        required_walls = set()
        if system in ('WRCF', 'DUAL'):
            required_walls |= {
                'Shell Sections - Wall',
                'Pier Section Properties',
                'Shear Wall Pier Summary - ACI 3',
                'Shell Assignments - Pier Spandr',
            }

        # Columnas condicional
        required_columns = set()
        if system in ('RCMRF', 'DUAL'):
            # OJO: columnas vienen de frames+assignments, pero si faltan tablas de refuerzo de columna fallará
            required_columns |= set()  # ya cubiertas por required_base + required_rebar

        # Construcción final
        required = required_base | required_rebar | required_walls | required_columns

        # Comparar con sheet_names reales
        sheets_present = set(self.sheet_names)
        missing_required = sorted(list(required - sheets_present))

        # Para mensajes más claros: agrupar
        missing_groups = {}
        if missing_required:
            missing_groups['required'] = missing_required

        # Si el usuario dejó mal structure_system, esto lo detectas por faltantes típicos
        if missing_required:
            msg = (
                f"\n[ERROR] Faltan hojas obligatorias en input_model.xlsx para:\n"
                f"  - structure_system = {system}\n"
                f"  - rebar_type = {rebar_type}\n"
                f"Hojas faltantes:\n  - " + "\n  - ".join(missing_required) + "\n\n"
                f"Recomendación:\n"
                f"  1) Verifica 'Sistema estructural' en input_parameters.xlsx\n"
                f"  2) O agrega estas hojas al input_model.xlsx según el sistema/refuerzo.\n"
            )
            raise ValueError(msg)

        # Si todo ok, solo retorna True
        return True

    @staticmethod
    def _normalize_sheet(s: str) -> str:
        return str(s).strip().lower()

# Clase que importa los parametros iniciales
class ImportParametersData:
    def __init__(self, root_path):
        warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")
        self.params_file_path = os.path.join(root_path,'data','temp','csi_tables','input_parameters.xlsx')

        self.import_user_parameters()
        self.modify_dict()
    
    def import_user_parameters(self):
        user_parameters = pd.read_excel(self.params_file_path)

        def normalize_key(text):
            return text.strip().lower()\
               .replace(" ", "_")\
               .replace("á", "a").replace("é", "e").replace("í", "i")\
               .replace("ó", "o").replace("ú", "u").replace("ñ", "n")
        
        user_parameters.columns = ['parameter', 'value']
        self.user_project_data = {normalize_key(row["parameter"]): row["value"] for _, row in user_parameters.iterrows()}

    def modify_dict(self):

        self.initial_parameters = {
            'proyect_name': self.user_project_data.get('nombre_del_proyecto'),
            'city': self.user_project_data.get('ciudad'),
            'soil_type': self.user_project_data.get('tipo_perfil_de_suelo'),
            'edification_use': self.user_project_data.get('grupo_de_uso'),
            'construction_year': self.user_project_data.get('ano_de_construccion'),
            'code': self.user_project_data.get('norma_aplicada'),
            'structure_system': self.user_project_data.get('sistema_estructural'),
            'confined_elements': self.user_project_data.get('elementos_confinados', 'Si'),
            'energy_dissipation': self.user_project_data.get('capacidad_de_disipacion_de_energia', 'DMO'),
            'integration_points': self.user_project_data.get('puntos_de_integracion', 5),
            'load_case': self.user_project_data.get('combinacion_carga_de_servicio', '(0) 1CM + 0.25CV'),
            'cm_load': self.user_project_data.get('super_dead_load_pattern_name', 'CMsobreimpuesta'),
            'cv_load': self.user_project_data.get('live_load_pattern_name', 'CV'),
            'shell_craking': self.user_project_data.get('agrietamiento_de_las_losas', 1.0),
            'rebar_type': self.user_project_data.get('refuerzo_de_los_elementos', 'Ingresado')
        }

# Clase que procesa los objetos del modelo
class ProcessModelObjects:

    def __init__(self, raw_data:dict, initial_parameters:dict):

        base_keys = [
            'TABLE:  "OBJECTS AND ELEMENTS - JOINTS"',
            'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"',
            'TABLE:  "OBJECTS AND ELEMENTS - SHELLS"',
            'TABLE:  "FLOOR CONNECTIVITY"',
            'TABLE:  "MATERIAL PROPERTIES - CONCRETE"',
            'TABLE:  "MASS SUMMARY BY DIAPHRAGM"',
            'TABLE:  "JOINT ASSIGNMENTS - RESTRAINTS"',
            'TABLE:  "FRAME SECTIONS"',
            'TABLE:  "FRAME ASSIGNMENTS - SECTIONS"',
            'TABLE:  "SHELL ASSIGNMENTS - SECTIONS"',
            'TABLE:  "SHELL SECTIONS - SLAB"',
            'TABLE:  "SHELL LOADS - UNIFORM"',
        ]
        

        self.raw_data = raw_data
        self.initial_parameters = initial_parameters

        self._require_tables(base_keys)
        self.warnings = []

        self.process_joints_and_center_of_mass()
        self.process_concrete_materials()
        self.process_slab_sections()
        self.process_beam_sections()
        self.process_slab_sections_TALoad()
        self.process_beam_sections_TALoad()
        self.process_column_sections()
        self.process_wall_sections()

    def _require_tables(self, keys):
        missing = [k for k in keys if not isinstance(self.raw_data.get(k), pd.DataFrame)]
        if missing:
            raise ValueError(
                "[ERROR] Tablas ETABS faltantes o vacías:\n  - " + "\n  - ".join(missing)
            )
    
    def _warn_once(self, key, msg):
        # evita repetir el mismo warning 1000 veces
        if not hasattr(self, "_warn_keys"):
            self._warn_keys = set()
        if key not in self._warn_keys:
            self._warn_keys.add(key)
            self.warnings.append(msg)

    # Procesar los joints y nos nodos en el centro de masa
    def process_joints_and_center_of_mass(self):

        joints = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - JOINTS"']
        frames = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - FRAMES"']
        shells = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - SHELLS"']
        restraints = self.raw_data['TABLE:  "JOINT ASSIGNMENTS - RESTRAINTS"']
        mass_by_diaphragm = self.raw_data['TABLE:  "MASS SUMMARY BY DIAPHRAGM"']
        #nodes_by_diaphragm = self.raw_data['TABLE:  "JOINT ASSIGNMENTS - DIAPHRAGMS"']

        self._validate_shell_max_4_joints(shells)
        
        joints = joints[joints["Object Type"] == "Joint"]
        
        unique_jshells = []
        if isinstance(frames, pd.DataFrame):
            unique_jframes = pd.concat([frames['Joint I'], frames['Joint J']]).unique()

        unique_jshells = pd.concat([shells['Joint 1'], shells['Joint 2'], shells['Joint 3'], shells['Joint 4']]).unique()
        
        used_joints = set(unique_jframes).union(set(unique_jshells))
        joints = joints[joints['Element Label'].isin(used_joints)]
        
        restraints.rename(columns={'Unique Name': 'Element Label'}, inplace=True)
        restraints['contraint_values'] = restraints.apply(
            lambda row: [1 if row[dof]=='Yes' else 0 for dof in ['UX','UY','UZ','RX','RY','RZ']], axis=1)
        
        joints = joints.merge(restraints[['Element Label','contraint_values']], on='Element Label', how='left')
        
        joints['Element Label'] = joints['Element Label'].astype(int) # Asegurarnos que sean enteros
        
        # Center of mass nodes
        coordz = np.sort(pd.unique(joints['Global Z']))
        
        com_nodes = [100000 * (i + 1) for i in range(len(coordz[1::]))]
        com_nodes = sorted(com_nodes, reverse=True)
        
        #grouped_nodes = nodes_by_diaphragm.groupby('Diaphragm')['Unique Name'].apply(list).to_dict()
        
        center_of_mass = {}
        for i, row in mass_by_diaphragm.iterrows():
            #diaphragm_name = row['Diaphragm'] 
            center_of_mass[str(100000 * len(mass_by_diaphragm) - 100000 * (i - 1))] = {
                'mass_x': row['Mass X'],
                'mass_y': row['Mass Y'],
                'mass_moment_of_inertia': row['Mass Moment of Inertia'],
                'global_x': row['X Mass Center'],
                'global_y': row['Y Mass Center'],
                'global_z': coordz[int(row['Story'][5:])],
                #'nodes_diaph': grouped_nodes.get(diaphragm_name, []) 
            }
            
        self.center_of_mass = center_of_mass
        self.df_joints = joints

    # Procesar los materiales en concreto
    def process_concrete_materials(self):
        materials = self.raw_data['TABLE:  "MATERIAL PROPERTIES - CONCRETE"']
        materials.rename(columns={'Name': 'Material'}, inplace=True)
        materials['unconfined_tag'] = [i + 1 for i in range(len(materials))]
        materials['confined_tag'] = [i + (len(materials) + 1) for i in range(len(materials))]
        materials['steel_tag'] = [(len(materials)*2 + 1)]*len(materials)
        materials['wwm_tag'] = [(len(materials)*2 + 2)]*len(materials)
        materials =  materials.drop(['Lightweight?'], axis = 1)
        
        self.df_materials = materials
    
    # Procesar las losas 
    def process_slab_sections(self):
        OE_shells = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'].copy()
        AS_shells = self.raw_data['TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'].copy()
        SC_shells = self.raw_data['TABLE:  "SHELL SECTIONS - SLAB"'].copy()
        JOINTS_copy = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - JOINTS"'].copy()
        # CARGA DISTRIBUIDA EN LA LOSA (VIVA Y MUERTA)
        LD_shells = self.raw_data['TABLE:  "SHELL LOADS - UNIFORM"'].copy()

        materials = self.df_materials.copy()
        
        
        SC_shells = pd.merge(SC_shells, materials[['Material', 'Fc', 'G',
                                                    'unconfined_tag', 'confined_tag',
                                                    'steel_tag']], on = 'Material', how = 'inner')
        
        SC_shells.rename(columns = {'Name': 'Section'}, inplace = True)
        SC_shells['slab_tag'] = [int(-(index + 1)) for index in range(len(SC_shells))]
        
        
        # Paso 1: identificar duplicados en 'Object Label'
        duplicated_keys = OE_shells.duplicated(subset=['Story', 'Area Label'], keep=False)
        duplicados = OE_shells[duplicated_keys]  
        
        consolidados = []
        for (story, area_label), group in duplicados.groupby(['Story','Area Label']):
            joints_final = pd.concat([group['Joint 1'], group['Joint 2'],
                                      group['Joint 3'], group['Joint 4']])
            unique_joints = joints_final.value_counts()
        
            # Nodos que aparecen solo una vez → extremos del conjunto
            extremos = unique_joints[unique_joints == 1].index.tolist()
            
            if len(extremos) not in (3, 4):
                continue
            
            # Aplicar orden geometrico
            extremos_ordenados = self.ordenar_joints_poligono(extremos, story, JOINTS_copy)

            # Manejo de triángulos vs cuadriláteros
            if len(extremos_ordenados) == 3:
                j1, j2, j3 = extremos_ordenados
                j4 = j3  # o 0 / np.nan,
            else:
                j1, j2, j3, j4 = extremos_ordenados
                if (j1, j2, j3, j4) == 104:
                    print(f'{story}, {area_label}')

            new_row = {
                'Story': story,
                'Element Label': int(str(group['Element Label'].iloc[0]).split('-')[0]),
                'Area Type': group['Area Type'].iloc[0],
                'Area Label': area_label,
                'Joint 1': j1,
                'Joint 2': j2,
                'Joint 3': j3,
                'Joint 4': j4,
            }
            
            consolidados.append(new_row)

        df_consolidados = pd.DataFrame(consolidados)
        
        # Paso 3: eliminar duplicados del df original y agregar los consolidados
        OE_shells = pd.concat([
            OE_shells[~OE_shells['Area Label'].isin(duplicados['Area Label'])],
            df_consolidados
        ], ignore_index=True)

        GN_Slabs = OE_shells[OE_shells['Area Type'] == 'Floor']
        AS_shells.rename(columns={'Unique Name': 'Element Label'}, inplace = True)
        GN_Slabs = pd.merge(OE_shells, AS_shells[['Element Label', 'Section']], on='Element Label', how='inner')
        GN_Slabs = pd.merge(GN_Slabs, SC_shells[['Section', 'Slab Thickness', 'Material', 'Fc', 'slab_tag', 'One-Way Load Distribution?']], on='Section', how='inner')
        
        # Paso 4: Agregar carga muerta y viva
        def carga_viva(row):
            cargas_label = LD_shells[(LD_shells['Label'] == row['Area Label']) & (LD_shells['Story'] == row['Story'])]
            carga_viva = cargas_label.loc[cargas_label['Load Pattern'] == self.initial_parameters.get('cv_load'), 'Load'].sum() if len(cargas_label) else 0.0

            if len(cargas_label) and (cargas_label['Load Pattern'] == self.initial_parameters.get('cv_load')).sum() == 0:
                self._warn_once(
                    "cv_not_found",
                    f"[WARNING] No se encontró Live Load Pattern '{self.initial_parameters.get('cv_load')}' en SHELL LOADS - UNIFORM. Se asignó 0.0."
                )
            return carga_viva

        def carga_muerta(row):
            cargas_label = LD_shells[(LD_shells['Label'] == row['Area Label']) & (LD_shells['Story'] == row['Story'])]
            carga_muerta = cargas_label.loc[cargas_label['Load Pattern'] == self.initial_parameters.get('cm_load'), 'Load'].sum() if len(cargas_label) else 0.0

            if len(cargas_label) and (cargas_label['Load Pattern'] == self.initial_parameters.get('cm_load')).sum() == 0:
                self._warn_once(
                    "cm_not_found",
                    f"[WARNING] No se encontró DEAD Load Pattern '{self.initial_parameters.get('cm_load')}' en SHELL LOADS - UNIFORM. Se asignó 0.0."
                )

            return carga_muerta
        
        
        GN_Slabs['live_load'] = GN_Slabs.apply(carga_viva, axis=1)
        GN_Slabs['dead_load'] = GN_Slabs.apply(carga_muerta, axis=1)

        self.df_slabs = GN_Slabs
    
    # Procesar las losas / Carga tributaria en las vigas 
    def process_slab_sections_TALoad(self):
        OE_shells = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'].copy()
        AS_shells = self.raw_data['TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'].copy()
        SC_shells = self.raw_data['TABLE:  "SHELL SECTIONS - SLAB"'].copy()
        JOINTS_copy = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - JOINTS"'].copy()

        materials = self.df_materials.copy()
        
        
        SC_shells = pd.merge(SC_shells, materials[['Material', 'Fc', 'G',
                                                    'unconfined_tag', 'confined_tag',
                                                    'steel_tag']], on = 'Material', how = 'inner')
        
        SC_shells.rename(columns = {'Name': 'Section'}, inplace = True)
        SC_shells['slab_tag'] = [int(-(index + 1)) for index in range(len(SC_shells))]
        
        
        # Paso 1: identificar duplicados en 'Object Label'
        duplicated_keys = OE_shells.duplicated(subset=['Story', 'Area Label'], keep=False)
        duplicados = OE_shells[duplicated_keys]  
        
        consolidados = []
        for (story, area_label), group in duplicados.groupby(['Story','Area Label']):
            joints_final = pd.concat([group['Joint 1'], group['Joint 2'],
                                      group['Joint 3'], group['Joint 4']])
            unique_joints = joints_final.value_counts()
        
            # Nodos que aparecen solo una vez → extremos del conjunto
            extremos = unique_joints[unique_joints == 1].index.tolist()
            
            if len(extremos) not in (3, 4):
                continue
            
            # Aplicar orden geometrico
            extremos_ordenados = self.ordenar_joints_poligono(extremos, story, JOINTS_copy)

            # Manejo de triángulos vs cuadriláteros
            if len(extremos_ordenados) == 3:
                j1, j2, j3 = extremos_ordenados
                j4 = j3  # o 0 / np.nan,
            else:
                j1, j2, j3, j4 = extremos_ordenados
                if (j1, j2, j3, j4) == 104:
                    print(f'{story}, {area_label}')

            new_row = {
                'Story': story,
                'Element Label': int(str(group['Element Label'].iloc[0]).split('-')[0]),
                'Area Type': group['Area Type'].iloc[0],
                'Area Label': area_label,
                'Joint 1': j1,
                'Joint 2': j2,
                'Joint 3': j3,
                'Joint 4': j4,
            }
            
            consolidados.append(new_row)

        df_consolidados = pd.DataFrame(consolidados)
        
        # Paso 3: eliminar duplicados del df original y agregar los consolidados
        OE_shells = pd.concat([
            OE_shells[~OE_shells['Area Label'].isin(duplicados['Area Label'])],
            df_consolidados
        ], ignore_index=True)

        GN_Slabs = OE_shells[OE_shells['Area Type'] == 'Floor']
        AS_shells.rename(columns={'Unique Name': 'Element Label'}, inplace = True)
        GN_Slabs = pd.merge(OE_shells, AS_shells[['Element Label', 'Section']], on='Element Label', how='inner')
        GN_Slabs = pd.merge(GN_Slabs, SC_shells[['Section', 'Slab Thickness', 'Material', 'Fc', 'slab_tag', 'One-Way Load Distribution?']], on='Section', how='inner')
        
        GN_Slabs['live_load'] = [0.0]*len(GN_Slabs)
        GN_Slabs['dead_load'] = [0.0]*len(GN_Slabs)

        self.df_slabsTA = GN_Slabs

    # Procesar vigas / Carga tributaria en las vigas 
    def process_beam_sections_TALoad(self,  slabs_override = None, factorLD=1.0):

        # =============== GUARD: tablas esperadas ===============
        key_oe = 'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"'
        if not isinstance(self.raw_data.get(key_oe), pd.DataFrame):
            self.df_beamsTA = None
            return None
        
        # -------- INPUT FRAMES ---------
        OE_frames = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - FRAMES"'].copy()
        SC_frames = self.raw_data['TABLE:  "FRAME SECTIONS"'].copy()
        AS_frames = self.raw_data['TABLE:  "FRAME ASSIGNMENTS - SECTIONS"'].copy()

        # -------- INPUT SLABS --------
        fl_cnt = self.raw_data['TABLE:  "FLOOR CONNECTIVITY"'].copy()

        # Tipo de refuerzo -->
        if self.initial_parameters.get('rebar_type') == 'Ingresado':
            RB_beams = self.raw_data['TABLE:  "CONCRETE BEAM REBAR DATA"'].copy()
            aci_rebar = False
        else:
            RB_beams = self.raw_data['TABLE:  "CONCRETE BEAM SUMMARY - ACI3"'].copy()
            aci_rebar = True
    
        LD_shells = self.raw_data['TABLE:  "SHELL LOADS - UNIFORM"'].copy()
        LD_frames = self.raw_data['TABLE:  "FRAME LOADS - DISTRIBUTED"']
    
        materials = self.df_materials.copy()
        joints = self.df_joints.copy()
        slabs = slabs_override.copy() if isinstance(slabs_override, pd.DataFrame) else self.df_slabs.copy()

        OE_frames_copy = OE_frames[OE_frames['Object Type']=='Frame']

        # Process slabs data --> Areas + Perimeter + nodes in order
        slabs = slabs[['Story', 'Element Label', 'Area Label', 'Slab Thickness', 'One-Way Load Distribution?']]
        fl_cnt.rename(columns={'Unique Name': 'Element Label'}, inplace=True)
        slabs = pd.merge(slabs, fl_cnt[['Element Label', 'Points', 'Perimeter', 'Area']])

        # Asignar joints en orden -->
        for idx, row in slabs.iterrows():
            slb_jnt = row['Points'].split(';')
            for jdx, val in enumerate(slb_jnt):
                slabs.loc[idx, f'Joint {jdx + 1}'] = int(val)
            if len(slb_jnt) == 3:
                slabs.loc[idx, 'Joint 4'] = None
        
        # ================= ORGANIZAR DATAFRAMES =================
        # SECCIONES -->
        SC_beams = pd.merge(
            SC_frames,
            materials[['Material', 'Fc', 'G', 'unconfined_tag', 'confined_tag', 'steel_tag']],
            on='Material', how='inner'
        )
        SC_beams = SC_beams.rename(columns={'Name': 'Design Section'})
        SC_beams = SC_beams[['Design Section', 'Material', 'Fc', 'G', 'unconfined_tag',
                             'confined_tag', 'steel_tag', 't3', 't2', 'Area', 'I33', 'I22', 'J']]
    
        # ASIGNACIONES -->
        AS_frames = AS_frames.drop(columns=[c for c in ['Design Section'] if c in AS_frames.columns])
        AS_frames = AS_frames.rename(columns={
            'Unique Name': 'Element Label',
            'Label': 'Object Label',
            'Analysis Section': 'Design Section'
        })
    
        # REFUERZO -->
        if aci_rebar:
            # RB_beams = RB_beams.rename(columns={'Label': 'Object Label'})
            # RB_beams = RB_beams.groupby(['Story', 'Object Label', 'Design Section']).agg({
            #     'As Top': 'max',
            #     'As Bottom': 'max'
            # }).reset_index()
            RB_beams = RB_beams[["Story", "Label", "Design Section", "Station", "As Top", "As Bottom"]]
        else:
            RB_beams = RB_beams.rename(columns={'Frame Property': 'Design Section'})
            RB_beams = RB_beams[['Design Section', '#bottom', 'area bottom', '#top', 'area top', 'Top Cover']]
    
        # ================= OBJECTS AND ELEMENTS =================
        # Process beams data -->
        OE_frames = OE_frames[OE_frames['Object Type'] == 'Frame']
        # Identificar los frames duplicados (frames con joints intermedios)
        duplicated_keys = OE_frames.duplicated(subset=['Story', 'Object Label'], keep=False)
        duplicados = OE_frames[duplicated_keys]

        # Agregar al dataframe VIGAS COMPLETAS (Estas vigas NO se modelan)
        consolidados = []
        for name, group in duplicados.groupby(['Story', 'Object Label']):
            other_joints = pd.concat([group['Joint I'], group['Joint J']])
            unique_joints = other_joints.value_counts()
            extremos = unique_joints[unique_joints == 1].index.tolist()

            try:
                if len(extremos) == 2:
                    new_row = {
                        'Story': group['Story'].iloc[0],
                        'Element Label': str(group['Element Label'].iloc[0]).split('-')[0] + '-CMPL',
                        'Object Type': group['Object Type'].iloc[0],
                        'Object Label': name[1],
                        'Joint I': extremos[0],
                        'Joint J': extremos[1]
                    }
                    consolidados.append(new_row)
            except Exception:
                raise ValueError(
                    f'Por favor revisa la modelación de la Viga {group["Object Type"].iloc[0]} '
                    f'en el nivel {group["Story"].iloc[0]}'
                )
    
        df_consolidados = pd.DataFrame(consolidados)

        # Modificar nombres UNICOS de los duplicados (Estos SI se modelan)
        duplicados_copy = duplicados.copy()
        # duplicados_copy[['base','seq']] = duplicados_copy['Element Label'].str.extract(r'(\d+)-(\d+)').astype(int)
        # TOTAL_WIDTH = 7 
        # base_str = duplicados_copy['base'].astype(str)
        # seq_str  = duplicados_copy['seq'].astype(str)
        # zeros    = (TOTAL_WIDTH - base_str.str.len() - seq_str.str.len()).clip(lower=0)
        # duplicados_copy['Element Label'] = base_str + zeros.map(lambda z: '0'*z) + seq_str
        # duplicados_copy['Element Label'] = duplicados_copy['Element Label'].astype(int)

        # duplicados_copy = duplicados.copy()
        mask = duplicados_copy['Element Label'].astype(str).str.contains('-', regex=False, na=False)
        if len(mask) > 0:
            tmp = duplicados_copy.loc[mask, 'Element Label'].str.extract(r'(\d+)-(\d+)')
            tmp.columns = ['base', 'seq']
            tmp = tmp.astype('Int64')  # soporta NA si hubiera algo raro
            DIGITS_SEQ = 4  # por ejemplo 6 -> factor = 1_000_000
            factor = 10 ** DIGITS_SEQ
            new_ids = (tmp['base'].astype('Int64') * factor + tmp['seq'].astype('Int64')).astype('Int64')
            duplicados_copy.loc[mask, 'Element Label'] = new_ids.astype('Int64')
            duplicados_copy['Element Label'] = duplicados_copy['Element Label'].astype('int64', errors='ignore')
            # duplicados_copy.drop(columns=['base','seq'], inplace=True)
    
            # DATAFRAME COMPLETO -> Elimina los duplicados iniciales, 
            # agrega los duplicados con nombres nuevos y agrega vigas completas
            OE_beams = pd.concat([
                OE_frames[~OE_frames['Object Label'].isin(duplicados['Object Label'])],
                duplicados_copy,
                df_consolidados
            ], ignore_index=True)
        else:
            OE_beams = OE_frames

        # ================= PROCESAR INFORMACION =================
        # Merge asignaciones
        OE_beams = pd.merge(
            OE_beams,
            AS_frames[['Story','Object Label', 'Design Type', 'Design Section', 'Section Type']],
            on=['Story','Object Label'], how='inner'
        )
        OE_beams = OE_beams[OE_beams['Design Type'] == 'Beam']
    
        # Merge secciones
        OE_beams = pd.merge(OE_beams, SC_beams, on='Design Section', how='inner')
        OE_beams = OE_beams.drop(columns=[c for c in ['Object Type'] if c in OE_beams.columns])
    
        # Merge refuerzo + generar rebar_data
        if aci_rebar:
            # OE_beams = pd.merge(OE_beams, RB_beams, on=['Story', 'Object Label', 'Design Section'], how='left')
            # OE_beams['rebar_data'] = OE_beams.apply(self.generate_rebardata_aci3, axis=1)

            OE_beams_Rebar = self.process_Rebar_Beams(RB_beams)
            OE_beams_Rebar.rename(columns = {'Label': 'Object Label'}, inplace = True)
            OE_beams = pd.merge(OE_beams, OE_beams_Rebar, on = ['Story', 'Object Label'], how = 'inner')
            OE_beams['rebar_data'] = OE_beams.apply(self.generate_rebardata_aci3, axis=1, args=('beams',))
        else:
            OE_beams = pd.merge(OE_beams, RB_beams, on='Design Section', how='left')
            OE_beams['rebar_data'] = OE_beams.apply(self.generate_rebardata_user, axis=1)

        # ================= GEOMETRY TRANSFORMATION ==============
        jointsB = joints.copy()
        GEN_beamns = OE_beams.copy()
    
        # Coordenadas Joint I
        jointsB_I = jointsB.rename(columns={'Element Label': 'Joint I'})
        GEN_beamns = pd.merge(
            GEN_beamns, jointsB_I[['Joint I', 'Global X', 'Global Y', 'Global Z']],
            on='Joint I', how='inner'
        ).rename(columns={'Global X': 'X_JointI', 'Global Y': 'Y_JointI', 'Global Z': 'Z_JointI'})
        GEN_beamns['CoordI'] = GEN_beamns.apply(lambda r: [r['X_JointI'], r['Y_JointI'], r['Z_JointI']], axis=1)
    
        # Coordenadas Joint J
        jointsB_J = jointsB.rename(columns={'Element Label': 'Joint J'})
        GEN_beamns = pd.merge(
            GEN_beamns, jointsB_J[['Joint J', 'Global X', 'Global Y', 'Global Z']],
            on='Joint J', how='inner'
        ).rename(columns={'Global X': 'X_JointJ', 'Global Y': 'Y_JointJ', 'Global Z': 'Z_JointJ'})
        GEN_beamns['CoordJ'] = GEN_beamns.apply(lambda r: [r['X_JointJ'], r['Y_JointJ'], r['Z_JointJ']], axis=1)
    
        # Vector de transformación (guardando división por cero)
        vectrans = []
        for _, row in GEN_beamns.iterrows():
            A = np.array(row['CoordI'], dtype=float)
            B = np.array(row['CoordJ'], dtype=float)
            AB = B - A
            cP = np.cross(AB, [0.0, 0.0, 1.0])
            nrm = np.linalg.norm(cP)
            if not np.isfinite(nrm) or nrm < 1e-12:
                cP = np.array([0.0, 1.0, 0.0])  # fallback
            else:
                cP = cP / nrm
            vectrans.append(cP)
        GEN_beamns['geometry_transformation_vector'] = vectrans

        # ================== ASIGNAR CARGAS DISTRIBUIDAS ==================
        # Factores carga muerta y viva
        F_cm, F_cv = self.extraer_coeficientes(self.initial_parameters.get('load_case'))
    
        # -------- Preparar data de losas: coordenadas y orden CCW seguro
        GN_Slabs = slabs.copy()
        jointsS = joints.copy()

        # Merge coordenadas de los 4 joints (puede que algunos sean NaN)
        for i in range(1, 5):
            joint_col = f'Joint {i}'
            joints_subset = jointsS[['Element Label', 'Global X', 'Global Y']].rename(
                columns={'Element Label': joint_col, 'Global X': f'XJ{i}', 'Global Y': f'YJ{i}'}
            )
            GN_Slabs = pd.merge(GN_Slabs, joints_subset, on=joint_col, how='left')

        # Dirección 1D/2D robusta
        GN_Slabs['shell-direction'] = np.where(
            GN_Slabs['One-Way Load Distribution?'].astype(str).str.lower().eq('yes'),
            '1direction', '2direction'
        )

        # Crear lados jointi - jointj para comparar con beams
        for idx, row in GN_Slabs.iterrows():
            if len(row['Points'].split(';')) == 4:
                for ii in range(1, 5):
                    jj = 1 if ii == 4 else ii + 1
                    x = [row[f'XJ{ii}'], row[f'XJ{jj}']]
                    y = [row[f'YJ{ii}'], row[f'YJ{jj}']]
                    GN_Slabs.loc[idx, f'LJ{ii}-J{jj}'] = np.hypot(x[1] - x[0], y[1] - y[0])
            else:
                for ii in range(1, 4):
                    jj = 1 if ii == 3 else ii + 1
                    x = [row[f'XJ{ii}'], row[f'XJ{jj}']]
                    y = [row[f'YJ{ii}'], row[f'YJ{jj}']]
                    GN_Slabs.loc[idx, f'LJ{ii}-J{jj}'] = np.hypot(x[1] - x[0], y[1] - y[0])

        def assign_tributary_area(row, i, j):
            lado = row.get(f'LJ{i}-J{j}', np.nan)
            area = row.get('Area', np.nan)
            perim = row.get('Perimeter', np.nan)
            if pd.isna(lado) or pd.isna(area) or pd.isna(perim) or perim <= 0:
                return np.nan
    
            if row['shell-direction'] == '2direction':
                # heurística proporcional al perímetro
                return (area / perim) * lado
    
            # 1D → soportes perpendiculares a la dirección principal (usamos lado largo como referencia)
            lados = [row.get(f'LJ{k}-J{(k % 4) + 1}', np.nan) for k in range(1, 5)]
            lados_validos = [l for l in lados if pd.notna(l)]
            if not lados_validos:
                return np.nan
            Lmax = max(lados_validos)
            if np.isclose(lado, Lmax, atol=1e-3):
                return 0.5 * area
            else:
                return 0.0

        # Calcular AT por lado consecutivo
        for i in range(1, 5):
            j = 1 if i == 4 else i + 1
            col_name = f'AT-J{i}-J{j}'
            GN_Slabs[col_name] = GN_Slabs.apply(lambda r: assign_tributary_area(r, i, j), axis=1)

        GN_Slabs['AT-J3-J1'] = GN_Slabs.apply(lambda r: assign_tributary_area(r, 3, 1), axis=1)
            
        # ---- Combinaciones slab→beam (ajustado para 3-nodos)
        def slabjoints_combinations(row):
            joints_row = [row.get('Joint 1'), row.get('Joint 2'), row.get('Joint 3'), row.get('Joint 4')]
            valid_joints = [int(j) for j in joints_row if pd.notna(j)]
    
            result = {
                'Story': row['Story'],
                'Floor Label': row['Area Label'],
                'eL': row['Slab Thickness'],
            }
    
            pairs = []
            if len(valid_joints) == 4:
                j1, j2, j3, j4 = valid_joints
                pairs = [
                    ('J1_J2', 'AT-J1-J2', f'{j1} - {j2}'),
                    ('J2_J3', 'AT-J2-J3', f'{j2} - {j3}'),
                    ('J3_J4', 'AT-J3-J4', f'{j3} - {j4}'),
                    ('J4_J1', 'AT-J4-J1', f'{j4} - {j1}'),
                    ('J2_J1', 'AT-J1-J2', f'{j2} - {j1}'),
                    ('J3_J2', 'AT-J2-J3', f'{j3} - {j2}'),
                    ('J4_J3', 'AT-J3-J4', f'{j4} - {j3}'),
                    ('J1_J4', 'AT-J4-J1', f'{j1} - {j4}'),
                ]
            elif len(valid_joints) == 3:
                j1, j2, j3 = valid_joints
                # Necesitamos crear AT-J3-J1 además de AT-J1-J2 y AT-J2-J3
                # Ya tenemos AT-J1-J2 y AT-J2-J3 en las columnas; creamos AT-J3-J1 ahora:
                # (si no existe, el get devolverá NaN sin romper)
                pairs = [
                    ('J1_J2', 'AT-J1-J2', f'{j1} - {j2}'),
                    ('J2_J3', 'AT-J2-J3', f'{j2} - {j3}'),
                    ('J3_J1', 'AT-J3-J1', f'{j3} - {j1}'),
                    ('J2_J1', 'AT-J1-J2', f'{j2} - {j1}'),
                    ('J3_J2', 'AT-J2-J3', f'{j3} - {j2}'),
                    ('J1_J3', 'AT-J3-J1', f'{j1} - {j3}'),
                ]
            else:
                raise ValueError(f"Losa con cantidad inesperada de nodos: {len(valid_joints)}")
    
            for key_name, at_col, combo in pairs:
                result[key_name] = combo
                result[f'at-{key_name}'] = row.get(at_col, np.nan)
    
            return result
    
        GN_Slabs = GN_Slabs.apply(slabjoints_combinations, axis=1, result_type='expand')

        # Longitud de cada viga (en planta)
        GEN_beamns['lenght'] = (
            (GEN_beamns['X_JointJ'] - GEN_beamns['X_JointI'])**2
          + (GEN_beamns['Y_JointJ'] - GEN_beamns['Y_JointI'])**2
        )**0.5
        # Evitar longitudes cero
        GEN_beamns['lenght'] = GEN_beamns['lenght'].where(GEN_beamns['lenght'] > 1e-9, other=np.nan)
    
        # Secciones únicas (para ACI3: refuerzo define "sección")
        GEN_beamns['rebar_data_str'] = GEN_beamns['rebar_data'].apply(
            lambda x: str(dict(sorted(x.items()))) if isinstance(x, dict) else str(x)
        )
        section_beamns = GEN_beamns.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        section_beamns['section_tag'] = np.arange(1, len(section_beamns) + 1)
        GEN_beamns = pd.merge(
            GEN_beamns, section_beamns[['Design Section', 'rebar_data_str', 'section_tag']],
            on=['Design Section', 'rebar_data_str'], how='left'
        )
    
        self.sectioncount = int(np.sort(pd.unique(GEN_beamns['section_tag']))[-1])
        GEN_beamns_cmpl = GEN_beamns['Element Label'].astype(str).str.contains('CMPL', case=False, na=False)
        self.df_beamsTA = GEN_beamns[~GEN_beamns_cmpl].copy()
        df_beams_else = GEN_beamns[~GEN_beamns_cmpl].copy()
    
        # Combinaciones beam (Ji_Jj / Jj_Ji)
        def beamjoints_combinations(row):
            j1, j2 = map(int, [row['Joint I'], row['Joint J']])
            return [
                row['Story'],
                row['Object Label'],
                row['Element Label'],
                row['lenght'],
                row['Area'],
                f'{j1} - {j2}',
                f'{j2} - {j1}'
            ]
    
        GEN_beamns_pairs = GEN_beamns.apply(beamjoints_combinations, axis=1, result_type='expand')
        GEN_beamns_pairs.columns = ['Story', 'Beam Label', 'Element Label', 'Lenght', 'Atv', 'Ji_Jj', 'Jj_Ji']
    
        # Armar combos slab (directos y opuestos)
        slab_combinations = []
        # claves posibles según 4-nodos
        keys4 = ['J1_J2', 'J2_J1', 'J2_J3', 'J3_J2', 'J3_J4', 'J4_J3', 'J4_J1', 'J1_J4']
        # y 3-nodos (triángulo)
        keys3 = ['J1_J2', 'J2_J1', 'J2_J3', 'J3_J2', 'J3_J1', 'J1_J3']
    
        for _, row in GN_Slabs.iterrows():
            keys = keys4 if all(k in row for k in keys4) else keys3
            for key in keys:
                slab_combinations.append({
                    'Story': row['Story'],
                    'Floor Label': row['Floor Label'],
                    'eL': row['eL'],
                    'Combination': row[key],
                    'AT': row.get(f'at-{key}', np.nan)
                })
        slab_df = pd.DataFrame(slab_combinations)

        df = GEN_beamns_pairs.copy()

        # 1) Separar segmentos y la fila "completa" (*-CMPL)
        is_cmpl = df['Element Label'].astype(str).str.contains('CMPL', case=False, na=False)
        segments = df[~is_cmpl].copy()
        beams_cmpl = df[is_cmpl].copy()

        # 2) Losa(s) extra por segmento (match con Ji_Jj o Jj_Ji)
        m1 = segments.merge(
            slab_df, left_on=['Story','Ji_Jj'], right_on=['Story','Combination'],
            how='left', suffixes=('', '_slab1')
        )
        m2 = segments.merge(
            slab_df, left_on=['Story','Jj_Ji'], right_on=['Story','Combination'],
            how='left', suffixes=('', '_slab2')
        )

        # Nos quedamos solo con los matches válidos (AT no nulo)
        cols_base = segments.columns.tolist()
        cols_slab = ['Floor Label','eL','Combination','AT']

        seg_extra = pd.concat([
            m1.loc[m1['AT'].notna(), cols_base + cols_slab],
            m2.loc[m2['AT'].notna(), cols_base + cols_slab],
        ], ignore_index=True)

        # 3) Losa "global" por viga (desde la fila *-CMPL, match por Ji_Jj o Jj_Ji)
        g1 = beams_cmpl.merge(
            slab_df, left_on=['Story','Ji_Jj'], right_on=['Story','Combination'], how='left'
        )
        g2 = beams_cmpl.merge(
            slab_df, left_on=['Story','Jj_Ji'], right_on=['Story','Combination'], how='left'
        )

        # Combinar posibles matches y quedarnos con 1 por (Story, Beam Label)
        global_slab = pd.concat([
            g1.loc[g1['AT'].notna(), ['Story','Beam Label','Lenght'] + cols_slab],
            g2.loc[g2['AT'].notna(), ['Story','Beam Label','Lenght'] + cols_slab],
        ], ignore_index=True).drop_duplicates(['Story','Beam Label'])

        # 4) Propagar la losa global a todos los segmentos de esa viga
        seg_global = segments.merge(
            global_slab, on=['Story','Beam Label'], how='left', suffixes=('', '_global')
        )

        # Usar la losa global si existe (no nula) y reemplazar la longitud por la de la viga completa
        mask_global = seg_global['Floor Label'].notna()
        seg_global.loc[mask_global, 'Lenght'] = seg_global.loc[mask_global, 'Lenght_global']

        # Limpieza de columnas _global
        seg_global = seg_global.drop(columns=[c for c in seg_global.columns if c.endswith('_global')])

        # 5) Salida: filas con losa global + filas con losas extra; sin la fila *-CMPL
        out_cols = cols_base + cols_slab
        out = pd.concat([
            seg_global[out_cols],  # siempre una por segmento (la global)
            seg_extra[out_cols],   # + una extra si aplica (Ji_Jj/Jj_Ji)
        ], ignore_index=True)

        # Orden opcional
        out = out.sort_values(['Story','Beam Label','Element Label','Floor Label']).reset_index(drop=True)
        out = out.drop_duplicates(subset=['Story', 'Beam Label', 'Element Label', 'Floor Label']).reset_index(drop=True)
        out['Wcv'] = F_cm * 24.0 * out['Atv']

        # Carga distribuida equivalente por losa: q = (AT/L) * ( Fcm*(SI + propio losa) + Fcv*CV )
        def calcular_wcl(row):
            L = row['Lenght']
            if not np.isfinite(L) or L <= 1e-9:
                return np.nan
            cargas_label = LD_shells[(LD_shells['Label'] == row['Floor Label']) & (LD_shells['Story'] == row['Story'])]
            # Si no hay registros, que sean cero
            carga_muerta = cargas_label.loc[cargas_label['Load Pattern'] == self.initial_parameters.get('cm_load'), 'Load'].sum() if len(cargas_label) else 0.0
            carga_viva = cargas_label.loc[cargas_label['Load Pattern'] == self.initial_parameters.get('cv_load'), 'Load'].sum() if len(cargas_label) else 0.0
            # propio losa = 24 * eL (kN/m2)
            q_m2 = F_cm * (carga_muerta + 24.0 * row['eL']) + F_cv * carga_viva
            return (row['AT'] / L) * q_m2 
        
        out['Wcl'] = out.apply(calcular_wcl, axis=1)
        out = out.dropna(subset=['Floor Label'])

        # Agregar Wv de cargas distribuidas de frame
        # Solo si hay
        out['Wv'] = [0]*len(out)
        if isinstance(LD_frames, pd.DataFrame):
        
            LD_frames = LD_frames.rename(columns={'Label': 'Beam Label'})
            LD_frames = LD_frames[LD_frames['Direction'] == 'Gravity']
    
            out = pd.merge(out, LD_frames[['Story', 'Beam Label', 'Force at End']], on=['Story', 'Beam Label'], how='left')
            out['Wv'] = out['Force at End'].where(pd.notna(out['Force at End']), other=0.0)
            out = out.drop_duplicates(subset=['Story', 'Beam Label', 'Element Label', 'Floor Label']).reset_index(drop=True)

        # ======= Agrupar por viga completa =======
        agrupado = (
            out.groupby('Element Label', as_index=False)
            .agg({'Wcl': 'sum', 'Wcv': 'mean', 'Wv': 'mean'})
        )

        # Fuerza distribuida final
        agrupado['Distributed force'] = (agrupado[['Wcv', 'Wcl', 'Wv']].sum(axis=1)) * factorLD
        
        beam_distributed_forces = agrupado
    
        # Merge a df_beams principal
        self.df_beamsTA = pd.merge(
            self.df_beamsTA,
            beam_distributed_forces[['Element Label', 'Distributed force']],
            on='Element Label', how='left'
        )
        self.df_beamsTA['Distributed force'] = self.df_beamsTA['Distributed force'].where(
            pd.notna(self.df_beamsTA['Distributed force']), other=0.0
        )

        return
    
    # Procesar vigas / solo carga externa
    def process_beam_sections(self):

        # =============== GUARD: tablas esperadas ===============
        key_oe = 'TABLE:  "OBJECTS AND ELEMENTS - FRAMES"'
        if not isinstance(self.raw_data.get(key_oe), pd.DataFrame):
            self.df_beams = None
            return None
        
        # -------- INPUT FRAMES ---------
        OE_frames = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - FRAMES"'].copy()
        SC_frames = self.raw_data['TABLE:  "FRAME SECTIONS"'].copy()
        AS_frames = self.raw_data['TABLE:  "FRAME ASSIGNMENTS - SECTIONS"'].copy()

        # Tipo de refuerzo -->
        if self.initial_parameters.get('rebar_type') == 'Ingresado':
            RB_beams = self.raw_data['TABLE:  "CONCRETE BEAM REBAR DATA"'].copy()
            aci_rebar = False
        else:
            RB_beams = self.raw_data['TABLE:  "CONCRETE BEAM SUMMARY - ACI3"'].copy()
            aci_rebar = True
    
        LD_frames = self.raw_data['TABLE:  "FRAME LOADS - DISTRIBUTED"']
    
        materials = self.df_materials.copy()
        joints = self.df_joints.copy()
        
        # ================= ORGANIZAR DATAFRAMES =================
        # SECCIONES -->
        SC_beams = pd.merge(
            SC_frames,
            materials[['Material', 'Fc', 'G', 'unconfined_tag', 'confined_tag', 'steel_tag']],
            on='Material', how='inner'
        )
        SC_beams = SC_beams.rename(columns={'Name': 'Design Section'})
        SC_beams = SC_beams[['Design Section', 'Material', 'Fc', 'G', 'unconfined_tag',
                             'confined_tag', 'steel_tag', 't3', 't2', 'Area', 'I33', 'I22', 'J']]
    
        # ASIGNACIONES -->
        AS_frames = AS_frames.drop(columns=[c for c in ['Design Section'] if c in AS_frames.columns])
        AS_frames = AS_frames.rename(columns={
            'Unique Name': 'Element Label',
            'Label': 'Object Label',
            'Analysis Section': 'Design Section'
        })
    
        # REFUERZO -->
        if aci_rebar:
            # RB_beams = RB_beams.rename(columns={'Label': 'Object Label'})
            # RB_beams = RB_beams.groupby(['Story', 'Object Label', 'Design Section']).agg({
            #     'As Top': 'max',
            #     'As Bottom': 'max'
            # }).reset_index()
            RB_beams = RB_beams[["Story", "Label", "Design Section", "Station", "As Top", "As Bottom"]]

        else:
            RB_beams = RB_beams.rename(columns={'Frame Property': 'Design Section'})
            RB_beams = RB_beams[['Design Section', '#bottom', 'area bottom', '#top', 'area top', 'Top Cover']]
    
        # ================= OBJECTS AND ELEMENTS =================
        # Process beams data -->
        OE_frames = OE_frames[OE_frames['Object Type'] == 'Frame']
        # Identificar los frames duplicados (frames con joints intermedios)
        duplicated_keys = OE_frames.duplicated(subset=['Story', 'Object Label'], keep=False)
        duplicados = OE_frames[duplicated_keys]

        # Agregar al dataframe VIGAS COMPLETAS (Estas vigas NO se modelan)
        consolidados = []
        for name, group in duplicados.groupby(['Story', 'Object Label']):
            other_joints = pd.concat([group['Joint I'], group['Joint J']])
            unique_joints = other_joints.value_counts()
            extremos = unique_joints[unique_joints == 1].index.tolist()

            try:
                if len(extremos) == 2:
                    new_row = {
                        'Story': group['Story'].iloc[0],
                        'Element Label': str(group['Element Label'].iloc[0]).split('-')[0] + '-CMPL',
                        'Object Type': group['Object Type'].iloc[0],
                        'Object Label': name[1],
                        'Joint I': extremos[0],
                        'Joint J': extremos[1]
                    }
                    consolidados.append(new_row)
            except Exception:
                raise ValueError(
                    f'Por favor revisa la modelación de la Viga {group["Object Type"].iloc[0]} '
                    f'en el nivel {group["Story"].iloc[0]}'
                )
    
        df_consolidados = pd.DataFrame(consolidados)

        # Modificar nombres UNICOS de los duplicados (Estos SI se modelan)
        duplicados_copy = duplicados.copy()
        # duplicados_copy[['base','seq']] = duplicados_copy['Element Label'].str.extract(r'(\d+)-(\d+)').astype(int)
        # TOTAL_WIDTH = 7 
        # base_str = duplicados_copy['base'].astype(str)
        # seq_str  = duplicados_copy['seq'].astype(str)
        # zeros    = (TOTAL_WIDTH - base_str.str.len() - seq_str.str.len()).clip(lower=0)
        # duplicados_copy['Element Label'] = base_str + zeros.map(lambda z: '0'*z) + seq_str
        # duplicados_copy['Element Label'] = duplicados_copy['Element Label'].astype(int)

        # duplicados_copy = duplicados.copy()

        mask = duplicados_copy['Element Label'].astype(str).str.contains('-', regex=False, na=False)
        if len(mask) > 0:
            tmp = duplicados_copy.loc[mask, 'Element Label'].str.extract(r'(\d+)-(\d+)')
            tmp.columns = ['base', 'seq']
            tmp = tmp.astype('Int64')  # soporta NA si hubiera algo raro
            DIGITS_SEQ = 4  # por ejemplo 6 -> factor = 1_000_000
            factor = 10 ** DIGITS_SEQ
            new_ids = (tmp['base'].astype('Int64') * factor + tmp['seq'].astype('Int64')).astype('Int64')
            duplicados_copy.loc[mask, 'Element Label'] = new_ids.astype('Int64')
            duplicados_copy['Element Label'] = duplicados_copy['Element Label'].astype('int64', errors='ignore')
            # duplicados_copy.drop(columns=['base','seq'], inplace=True)
    
            # DATAFRAME COMPLETO -> Elimina los duplicados iniciales, 
            # agrega los duplicados con nombres nuevos y agrega vigas completas
            OE_beams = pd.concat([
                OE_frames[~OE_frames['Object Label'].isin(duplicados['Object Label'])],
                duplicados_copy,
                df_consolidados
            ], ignore_index=True)
        
        else:
            OE_beams = OE_frames


        # ================= PROCESAR INFORMACION =================
        # Merge asignaciones
        OE_beams = pd.merge(
            OE_beams,
            AS_frames[['Story','Object Label', 'Design Type', 'Design Section', 'Section Type']],
            on=['Story','Object Label'], how='inner'
        )
        OE_beams = OE_beams[OE_beams['Design Type'] == 'Beam']
    
        # Merge secciones
        OE_beams = pd.merge(OE_beams, SC_beams, on='Design Section', how='inner')
        OE_beams = OE_beams.drop(columns=[c for c in ['Object Type'] if c in OE_beams.columns])
    
        # Merge refuerzo + generar rebar_data
        if aci_rebar:
            # OE_beams = pd.merge(OE_beams, RB_beams, on=['Story', 'Object Label', 'Design Section'], how='left')
            # OE_beams['rebar_data'] = OE_beams.apply(self.generate_rebardata_aci3_VA, axis=1)

            OE_beams_Rebar = self.process_Rebar_Beams(RB_beams)
            OE_beams_Rebar.rename(columns = {'Label': 'Object Label'}, inplace = True)
            OE_beams = pd.merge(OE_beams, OE_beams_Rebar, on = ['Story', 'Object Label'], how = 'inner')
            OE_beams['rebar_data'] = OE_beams.apply(self.generate_rebardata_aci3, axis=1, args=('beams',))
        else:
            OE_beams = pd.merge(OE_beams, RB_beams, on='Design Section', how='left')
            OE_beams['rebar_data'] = OE_beams.apply(self.generate_rebardata_user, axis=1)

        # ================= GEOMETRY TRANSFORMATION ==============
        jointsB = joints.copy()
        GEN_beamns = OE_beams.copy()
    
        # Coordenadas Joint I
        jointsB_I = jointsB.rename(columns={'Element Label': 'Joint I'})
        GEN_beamns = pd.merge(
            GEN_beamns, jointsB_I[['Joint I', 'Global X', 'Global Y', 'Global Z']],
            on='Joint I', how='inner'
        ).rename(columns={'Global X': 'X_JointI', 'Global Y': 'Y_JointI', 'Global Z': 'Z_JointI'})
        GEN_beamns['CoordI'] = GEN_beamns.apply(lambda r: [r['X_JointI'], r['Y_JointI'], r['Z_JointI']], axis=1)
    
        # Coordenadas Joint J
        jointsB_J = jointsB.rename(columns={'Element Label': 'Joint J'})
        GEN_beamns = pd.merge(
            GEN_beamns, jointsB_J[['Joint J', 'Global X', 'Global Y', 'Global Z']],
            on='Joint J', how='inner'
        ).rename(columns={'Global X': 'X_JointJ', 'Global Y': 'Y_JointJ', 'Global Z': 'Z_JointJ'})
        GEN_beamns['CoordJ'] = GEN_beamns.apply(lambda r: [r['X_JointJ'], r['Y_JointJ'], r['Z_JointJ']], axis=1)
    
        # Vector de transformación (guardando división por cero)
        vectrans = []
        for _, row in GEN_beamns.iterrows():
            A = np.array(row['CoordI'], dtype=float)
            B = np.array(row['CoordJ'], dtype=float)
            AB = B - A
            cP = np.cross(AB, [0.0, 0.0, 1.0])
            nrm = np.linalg.norm(cP)
            if not np.isfinite(nrm) or nrm < 1e-12:
                cP = np.array([0.0, 1.0, 0.0])  # fallback
            else:
                cP = cP / nrm
            vectrans.append(cP)
        GEN_beamns['geometry_transformation_vector'] = vectrans
        
        # Longitud de cada viga (en planta)
        GEN_beamns['lenght'] = (
            (GEN_beamns['X_JointJ'] - GEN_beamns['X_JointI'])**2
          + (GEN_beamns['Y_JointJ'] - GEN_beamns['Y_JointI'])**2
        )**0.5
        
        # Evitar longitudes cero
        GEN_beamns['lenght'] = GEN_beamns['lenght'].where(GEN_beamns['lenght'] > 1e-9, other=np.nan)
    
        # Secciones únicas (para ACI3: refuerzo define "sección")
        GEN_beamns['rebar_data_str'] = GEN_beamns['rebar_data'].apply(
            lambda x: str(dict(sorted(x.items()))) if isinstance(x, dict) else str(x)
        )
        section_beamns = GEN_beamns.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        section_beamns['section_tag'] = np.arange(1, len(section_beamns) + 1)
        GEN_beamns = pd.merge(
            GEN_beamns, section_beamns[['Design Section', 'rebar_data_str', 'section_tag']],
            on=['Design Section', 'rebar_data_str'], how='left'
        )
        
        
        self.sectioncount = int(np.sort(pd.unique(GEN_beamns['section_tag']))[-1])
        GEN_beamns_cmpl = GEN_beamns['Element Label'].astype(str).str.contains('CMPL', case=False, na=False)
        self.df_beams = GEN_beamns[~GEN_beamns_cmpl].copy()

        # ================== CARGAS DISTRIBUIDAS SIMPLIFICADAS ==================
        # ---- 1) Peso propio de la viga
        # Factores de carga
        F_cm, F_cv = self.extraer_coeficientes(self.initial_parameters.get('load_case'))

        df_beams_loads = self.df_beams.copy()
        # γ_concreto ≈ 24 kN/m³ //  w_self = Fcm * γ * Area_sec
        gamma_concrete = 24.0  # kN/m³
        df_beams_loads['w_self'] = F_cm * gamma_concrete * df_beams_loads['Area']  # kN/m

        # ---- 2) Carga distribuida externa desde LD_frames
        df_beams_loads['w_ext'] = 0.0

        if isinstance(LD_frames, pd.DataFrame):

            LDf = LD_frames.copy()
            LDf = LDf[LDf['Direction'] == 'Gravity']

            LDf = LDf.rename(columns={'Label': 'Object Label'})

            df_ext = (
                LDf.groupby(['Story', 'Object Label'], as_index=False)
                   .agg({'Force at End': 'sum'})
            )

            df_beams_loads = pd.merge(
                df_beams_loads,
                df_ext[['Story', 'Object Label', 'Force at End']],
                on=['Story', 'Object Label'],
                how='left'
            )

            df_beams_loads['w_ext'] = df_beams_loads['Force at End'].where(
                pd.notna(df_beams_loads['Force at End']), other=0.0
            )

        # ---- 3) Carga distribuida total en la viga
        df_beams_loads['Distributed force'] = (df_beams_loads['w_self'] + df_beams_loads['w_ext']) 

        # Nos quedamos solo con las columnas necesarias para unir a self.df_beams
        beam_distributed_forces = df_beams_loads[['Element Label', 'Distributed force']].copy()

        # ---- 4) Merge a df_beams principal
        self.df_beams = pd.merge(
            self.df_beams,
            beam_distributed_forces,
            on='Element Label',
            how='left'
        )

        self.df_beams['Distributed force'] = self.df_beams['Distributed force'].where(
            pd.notna(self.df_beams['Distributed force']), other=0.0
        )

        self._validate_beams_geometry(self.df_beams)

        return

    # Procesar columnas
    def process_column_sections(self):

        if self.initial_parameters.get('structure_system') == 'WRCF':
            self.df_columns = None
            return None

        OE_frames = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - FRAMES"']
        SC_frames = self.raw_data['TABLE:  "FRAME SECTIONS"']
        AS_frames = self.raw_data['TABLE:  "FRAME ASSIGNMENTS - SECTIONS"']
        AS_axes = self.raw_data['TABLE:  "FRAME ASSIGNMENTS - LOCAL AXES"']
        AS_offsets = self.raw_data['TABLE:  "FRAME ASSIGNMENTS - OFFSETS"']

        # Tipo de refuerzo -->
        if self.initial_parameters.get('rebar_type') == 'Ingresado':
            RB_column = self.raw_data['TABLE:  "CONCRETE COLUMN REBAR DATA"']
            aci_rebar = False
        else:
            RB_column = self.raw_data['TABLE:  "CONCRETE COLUMN SUMMARY - ACI3"']
            aci_rebar = True
        
        materials = self.df_materials
        joints = self.df_joints
        
        sectioncount = self.sectioncount

        # ------------------------ ORGANIZAR DATAFRAMES ----->
        # SECCIONES -->
        SC_columns = pd.merge(SC_frames, materials[['Material', 'Fc', 'G',
                                                    'unconfined_tag', 'confined_tag',
                                                    'steel_tag']], on = 'Material', how = 'inner')

        SC_columns.rename(columns = {'Name': 'Design Section'}, inplace = True)
        # SC_columns = SC_columns[['Design Section', 'Material', 'Fc', 'G', 'unconfined_tag', 
        #                          'confined_tag', 'steel_tag', 't3', 't2', 'Area', 'I33', 'I22', 'J']]
        
        SC_columns = SC_columns[['Design Section', 'Material', 'Fc', 'G', 'unconfined_tag', 
                         'confined_tag', 'steel_tag', 't3', 't2', 'Area', 'I33', 'I22', 'J', 'Shape']]
        
        # ASIGNACIONES -->
        AS_frames =  AS_frames.drop(['Design Section'], axis = 1)
        AS_frames.rename(columns = {'Unique Name':'Element Label','Label': 'Object Label','Analysis Section':'Design Section'}, inplace = True)
        # REFUERZO -->
        if aci_rebar:
            RB_column = RB_column[["Story", "Label", "Design Section", "Station", "As", "Mid Bar As", "Corner Bar As"]]


            # RB_column.rename(columns = {'Unique Name': 'Element Label'}, inplace = True)
            # RB_column = RB_column.groupby(['Element Label', 'Design Section']).agg({
            #     'As': 'max',
            #     'Corner Bar As': 'max',
            #     'Mid Bar As': 'max'
            #     }).reset_index()
        else:
            RB_column.rename(columns = {'Frame Property': 'Design Section'}, inplace = True)
            RB_column = RB_column[['Design Section','# Long. Bars 3-axis','# Long. Bars 2-axis','Corner Bar Area','Cover']]
        
        # ------------------------ PROCESAR INFORMACION ----->
        # Agregar al datafranme principal las asignaciones de cada elemento
        OE_columns = pd.merge(OE_frames, AS_frames[['Element Label', 'Design Type', 'Design Section', 'Section Type']], on = 'Element Label', how = 'inner')
        OE_columns = OE_columns[OE_columns['Design Type'] == 'Column']

        # Agregar al datafrane principal la informacion de las secciones
        OE_columns = pd.merge(OE_columns, SC_columns, on='Design Section', how = 'inner')
        OE_columns = OE_columns.drop(['Object Type'], axis = 1)

        # Agregar informacion del refuerzo y generar rebar_data
        if aci_rebar:
            # OE_columns = pd.merge(OE_columns, RB_column, on = ['Element Label', 'Design Section'], how = 'inner')
            # OE_columns['rebar_data'] = OE_columns.apply(self.generate_rebardata_aci3, axis=1)
            RB_column_full = pd.merge(
                                        RB_column,
                                        SC_columns[['Design Section', 't3', 't2', 'Shape']], 
                                        on='Design Section',
                                        how='inner')
            OE_columns_Rebar = self.process_Rebar_Columns(RB_column_full)
            OE_columns_Rebar.rename(columns = {'Label': 'Object Label'}, inplace = True)
            OE_columns = pd.merge(OE_columns, OE_columns_Rebar, on = ['Story', 'Object Label'], how = 'inner')
            OE_columns['rebar_data'] = OE_columns.apply(self.generate_rebardata_aci3, axis=1, args=('columns',))

        else:
            OE_columns = pd.merge(OE_columns, RB_column, on = 'Design Section', how = 'inner')
            OE_columns['rebar_data'] = OE_columns.apply(self.generate_rebardata_user, axis=1)

        # ------------------------ CALCULAR LA FUERZA PUNTUAL EN LOS NODOS DE LAS COLUMNAS ----->
        jointsC = joints.copy()
        GEN_columns = OE_columns.copy()

        jointsC.rename(columns={'Element Label':'Joint I'}, inplace=True)
        GEN_columns = pd.merge(GEN_columns, jointsC[['Joint I','Global Z']], on='Joint I', how='inner').rename(columns={'Global Z': 'Z_JointI'})

        jointsC.rename(columns={'Joint I':'Joint J'}, inplace=True)
        GEN_columns = pd.merge(GEN_columns, jointsC[['Joint J','Global Z']], on='Joint J', how='inner').rename(columns={'Global Z': 'Z_JointJ'})

        # Asegurarnos que el Joint J tiene mayor z que el Joint I
        GEN_columns['max_node'] = GEN_columns.apply(lambda row: row['Joint I'] if row['Z_JointI'] >= row['Z_JointJ'] else row['Joint J'], axis=1)

        # Calcular la longitud de la columna
        GEN_columns['lenght'] = np.abs(GEN_columns['Z_JointJ']-GEN_columns['Z_JointI'])

        # Calcular carga sobre el nodo
        GEN_columns['puntual_force'] = 24 * GEN_columns['lenght'] * GEN_columns['Area']
        nodes_with_col_above = set(GEN_columns['Joint I'].values) # Nodos con ninguna columna asignada (base)
        GEN_columns['has_col_above'] = GEN_columns['Joint J'].isin(nodes_with_col_above)
        GEN_columns.loc[~GEN_columns['has_col_above'], 'puntual_force'] = 0.0

        # ------------------------ CREAR VECTORES DE TRANSFORMACION GEOMETRICA -----> 
        max_z = np.max(jointsC['Global Z']) # Maxima altura
        GEN_columns.loc[(GEN_columns['Z_JointI'] == max_z) | (GEN_columns['Z_JointJ'] == max_z), 'puntual_force'] = 0 
        
        if isinstance(AS_axes, pd.DataFrame):
            AS_axes = AS_axes[AS_axes['Design Type'] == 'Column'].rename(columns={'Unique Name': 'Element Label'})
            GEN_columns = pd.merge(GEN_columns, AS_axes[['Element Label', 'Angle']], on='Element Label', how='left')
            
            # Fill missing angle values with zero
            angles = [0 if math.isnan(row['Angle']) else row['Angle'] for _, row in GEN_columns.iterrows()]
            
        else:
            # If no axis table exists, use angle = 0 for all
            angles = [0] * len(GEN_columns)

        GEN_columns['angle'] = angles
        GEN_columns['geometry_transformation_vector'] = [[-math.sin(math.radians(theta)), math.cos(math.radians(theta)), 0] for theta in GEN_columns['angle'].to_list()]
        
        # ------------------------ CALCULAR OFFSETS -----> 
        if isinstance(AS_offsets, pd.DataFrame):
            AS_offsets.rename(columns= {'Unique Name': 'Element Label'}, inplace = True)
            GEN_columns = pd.merge(GEN_columns, AS_offsets[['Element Label', 'Offset I-end', 'Offset J-end']], on = 'Element Label', how = 'left')
            GEN_columns['offset_i'] = [[0,0,0] if math.isnan(val) else [0,0, val] for val in GEN_columns['Offset I-end']]
            GEN_columns['offset_j'] = [[0,0,0] if math.isnan(val) else [0,0,-val] for val in GEN_columns['Offset J-end']]
        else:
            GEN_columns['offset_i'] = None
            GEN_columns['offset_j'] = None
        
        # ------------------------ ASIGNAR SECCIONES UNICAS -----> 
        GEN_columns['rebar_data_str'] = GEN_columns['rebar_data'].apply(lambda x: str(dict(sorted(x.items()))) if isinstance(x, dict) else str(x))
        section_columns = GEN_columns.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        section_columns['section_tag'] = [sectioncount + (index + 1) for index in range(len(section_columns))]
        
        GEN_columns = pd.merge(GEN_columns, section_columns[['Design Section', 'rebar_data_str', 'section_tag']], on = ['Design Section', 'rebar_data_str'], how = 'left')
    
        self.df_columns = GEN_columns

    # Procesar muros
    def process_wall_sections(self):

        if self.initial_parameters.get('structure_system') == 'RCMRF':
            self.df_walls = None
            return None

        AS_shells    = self.raw_data['TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'].copy()
        SC_walls     = self.raw_data['TABLE:  "SHELL SECTIONS - WALL"'].copy()
        AS_pier      = self.raw_data['TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"'].copy()
        SC_piers     = self.raw_data['TABLE:  "PIER SECTION PROPERTIES"'].copy()
        OE_shells    = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'].copy()
        pier_rebar   = self.raw_data['TABLE:  "SHEAR WALL PIER SUMMARY - ACI 3"'].copy()

        materials = self.df_materials
        joints    = self.df_joints
        joints2    = self.df_joints.copy()

        SC_walls = pd.merge(
            SC_walls,
            materials[['Material','Fc','G','unconfined_tag','confined_tag','steel_tag','wwm_tag']],
            on='Material', how='inner'
        )
        SC_walls['shear_tag'] = [1000 + i for i in range(len(SC_walls))]
        SC_walls.rename(columns={'Name': 'Section'}, inplace=True)

        AS_shells = AS_shells.rename(columns={'Unique Name': 'Element Label'})
        AS_shells = pd.merge(AS_shells, SC_walls, on='Section', how='inner')

        OE_walls = OE_shells[OE_shells['Area Type'] == 'Wall'].copy()
        OE_walls = pd.merge(
            OE_walls,
            AS_shells[['Element Label','Section','Thickness','Material','Fc','G',
                    'unconfined_tag','confined_tag','steel_tag','wwm_tag','shear_tag']],
            on='Element Label', how='inner'
        )

        # Asignación de Pier + propiedades del pier
        AS_pier = AS_pier.rename(columns={'Unique Name': 'Element Label'})
        AS_pier = pd.merge(AS_pier,
                        SC_piers[['Story','Pier','# Area Objects','Width Bottom']],
                        on=['Story','Pier'], how='left')
        OE_walls = pd.merge(
            OE_walls,
            AS_pier[['Element Label','Pier','# Area Objects','Width Bottom']],
            on='Element Label', how='inner'
        )

        pier_rebar = pier_rebar.rename(columns={'Pier Label':'Pier'})
        pier_rebar = pier_rebar[pier_rebar['Station'] == 'Bottom'].fillna(0)
        pier_rebar['Cuantia_Val'] = pier_rebar['Required Reinf']/100.0

        OE_walls = pd.merge(
            OE_walls,
            pier_rebar[['Story','Pier','Cuantia_Val','Boundary Zone Left','Boundary Zone Right']],
            on=['Story','Pier'], how='left'
        )

        # Orientación y longitud
        nodesW = []
        for _, row in OE_walls.iterrows():
            p1 = int(row['Joint 1']); p2 = int(row['Joint 2'])
            p3 = int(row['Joint 3']); p4 = int(row['Joint 4'])
            nodesW.append([p1, p2, p3, p4])

        coords_dict = joints.set_index('Element Label')[['Global X','Global Y','Global Z']].to_dict(orient='index')
        coords_nodesW = [
            [[coords_dict[el]['Global X'], coords_dict[el]['Global Y'], coords_dict[el]['Global Z']] for el in sublist]
            for sublist in nodesW
        ]

        order_list, lenght_list = [], []
        for i, nodes in enumerate(nodesW):
            orientation, lenght, node = self.wallsOrientation(nodes, coords_nodesW[i])
            lenght_list.append(lenght)  # Longitud del tramo de shell
            order_list.append(node)     # Orden de nodos 

        OE_walls['Nodes Orientation'] = order_list
        OE_walls['Nodes Lenght']      = lenght_list

        # 8) *********** NUEVO: construir fibras con la nueva build ***********
        muros = self.build_muros_with_fibers(
            df_joints         = self.df_joints,
            df_shells         = self.raw_data['TABLE:  "OBJECTS AND ELEMENTS - SHELLS"'],
            df_mat_conc       = self.raw_data['TABLE:  "MATERIAL PROPERTIES - CONCRETE"'],
            df_shell_sections = self.raw_data['TABLE:  "SHELL SECTIONS - WALL"'],
            df_assign_shell_sec = self.raw_data['TABLE:  "SHELL ASSIGNMENTS - SECTIONS"'],
            df_assign_pier    = self.raw_data['TABLE:  "SHELL ASSIGNMENTS - PIER SPANDR"'],
            df_pier_props     = self.raw_data['TABLE:  "PIER SECTION PROPERTIES"'],
            df_design_aci     = self.raw_data['TABLE:  "SHEAR WALL PIER SUMMARY - ACI 3"'],
            NDE='DMO',           
            MAX_ANCHO_FIBRA=0.30  
        )

        registros = []
        for pier, pisos in muros.items():
            for story, d in pisos.items():
                for sh in d.get("Shells", []):
                    # Listas provenientes de la build:
                    ancho   = sh.get('ancho_fibras', [])
                    espesor = sh.get('espesor_fibras', [])
                    cuantia = sh.get('cuantia_fibras', [])
                    tconc   = sh.get('tipo_concreto', [])
                    # Mapear Conf/Unconf a tags concretos y de acero con el mismo criterio
                    registros.append({
                        'Story': str(story),
                        'Pier':  str(pier),
                        'Area Label': str(sh.get('Name_Shell')),
                        'Ancho': ancho,
                        'Espesor': espesor,   
                        'Cuantia': cuantia,
                        'TipoConcreto': tconc, 
                        'Num_Macro': [1]*len(ancho), 
                    })

        df_div_nuevo = pd.DataFrame(registros)

        if not df_div_nuevo.empty:
            tags = OE_walls[['Story','Pier','confined_tag','unconfined_tag','steel_tag','wwm_tag']].drop_duplicates()
            df_div_nuevo = pd.merge(df_div_nuevo, tags, on=['Story','Pier'], how='left')

            conc_list, steel_list = [], []
            for _, r in df_div_nuevo.iterrows():
                c_conf = int(r['confined_tag'])   if pd.notna(r['confined_tag'])   else None
                c_unco = int(r['unconfined_tag']) if pd.notna(r['unconfined_tag']) else None
                s_conf = int(r['steel_tag'])      if pd.notna(r['steel_tag'])      else None
                s_w   = int(r['wwm_tag'])         if pd.notna(r['wwm_tag'])        else None

                conc = [(c_conf if tc=='Conf' else c_unco) for tc in r['TipoConcreto']]
                stl  = [(s_conf if tc=='Conf' else s_w)    for tc in r['TipoConcreto']]
                conc_list.append(conc)
                steel_list.append(stl)

            df_div_nuevo['Concreto'] = conc_list
            df_div_nuevo['Acero']    = steel_list
            df_div_nuevo.drop(columns=['TipoConcreto'], inplace=True)

        OE_walls_final = pd.merge(
            OE_walls,
            df_div_nuevo.drop(columns=['Pier']),          
            on=['Story','Area Label'], how='left'
        )

        def wall_self_weight(row, nodes_base_muros, coords_dict):
            j1 = int(row['Nodes Orientation'][0])
            j3 = int(row['Nodes Orientation'][2])
            j4 = int(row['Nodes Orientation'][3])
            
            # Coordenadas
            z1 = coords_dict[j1]['Global Z']
            z3 = coords_dict[j3]['Global Z']
            h = abs(z3 - z1)
            if h < 1e-6:
                print("Error en la interpretacion del orden de los nodos")
                return 0.0

            # Peso muro por piso
            W_muro = 24 * row['Thickness'] * row['Nodes Lenght'] * h  # kN
            if W_muro <= 0.0:
                return 0.0

            soporta_arriba = (j3 in nodes_base_muros) or (j4 in nodes_base_muros)
            if not soporta_arriba:
                return 0.0

            return W_muro / 2.0
        
        # Todos los nodos de la base de cada muro
        nodes_base_muros = set()
        nodes_ordenados = OE_walls_final['Nodes Orientation'].tolist()
        for nodes in nodes_ordenados:
            nodes_base_muros.add(nodes[0])
            nodes_base_muros.add(nodes[1])

        OE_walls_final['puntual_load_force'] = OE_walls_final.apply(wall_self_weight, axis=1, args=(nodes_base_muros, coords_dict))
    
        self.df_walls = OE_walls_final

    @staticmethod
    def ordenar_joints_poligono(extremos, story, joints_df):
        """
        Ordena los joints (IDs) de 'extremos' para que recorran la losa
        de forma continua (CCW o CW) usando sus coordenadas X, Y.
        """
        # 1) Extraer solo esos joints en el Story correspondiente
        sub = joints_df[joints_df['Element Label'].isin(extremos)].copy()

        # Verificar que se encontraron todos
        if len(sub) != len(extremos):
            # AQUI UNA VERIFICACION O WARNING
            pass

        # 2) Calcular centroide
        cols = ['Global X', 'Global Y']
        sub[cols] = sub[cols].apply(pd.to_numeric, errors='coerce')

        if sub[cols].isna().any().any():
            raise ValueError(f"Coordenadas no numéricas en joints: {sub}")

        cx = sub['Global X'].mean()
        cy = sub['Global Y'].mean()

        sub['angle'] = np.arctan2(sub['Global Y'] - cy, sub['Global X'] - cx)

        # 4) Ordenar por ángulo → recorrido CCW alrededor del centro
        sub = sub.sort_values('angle').reset_index(drop=True)

        # 5) (Opcional) fijar nodo de inicio: el de menor (Y, luego X)
        idx_start = sub[['Global Y', 'Global X']].sort_values(
            by=['Global Y', 'Global X'],
            ascending=[True, True]
        ).index[0]

        # Rotar la lista para que empiece en ese nodo
        ordered = pd.concat([sub.loc[idx_start:], sub.loc[:idx_start-1]])

        # 6) Devolver IDs en orden
        return ordered['Element Label'].tolist()

    @staticmethod
    def generate_rebardata_aci3_VA(row):

        # Referencia NSR-10 -> Tabla C.3.5.3-2
        bar_catalog = {
            '#9': {'diameter': 28.7, 'area': 645},
            '#8': {'diameter': 25.4, 'area': 510},
            '#7': {'diameter': 22.2, 'area': 387},
            '#6': {'diameter': 19.1, 'area': 284},
            '#5': {'diameter': 15.9, 'area': 199},
            '#4': {'diameter': 12.7, 'area': 129},
            #'#3': {'diameter': 9.5,  'area': 71}
        }

        B = row['t2']
        H = row['t3']
        cover = 0.04  # m

         # Intenta leer fc y fy desde row, con defaults razonables
        fc_MPa = float(row.get('Fc'))
        fy_MPa = 420

        # -------------------------------------------------------
        # Helpers de cuantía mínima NSR-10
        # -------------------------------------------------------

        def As_min_beam_NSR10(fc_MPa, fy_MPa, b_mm, d_mm):
            """
            NSR-10: C.10.5 -> Refuerzo minino en elementos sometidos a flexion
            Unidades: fc, fy en MPa, b,d en mm => As en mm²
            """
            # término concreto
            As1 = (0.25 * np.sqrt(fc_MPa) / fy_MPa) * b_mm * d_mm
            # término acero
            As2 = (1.4 / fy_MPa) * b_mm * d_mm
            return max(As1, As2)/2

        def As_min_column_NSR10(b_mm, h_mm, rho_min=0.01):
            """
            NSR-10 columnas reforzadas:
            ρ_min = 1%  => As_min = 0.01 * Ag
            (no depende directamente de fc/fy en la expresión simplificada)
            """
            Ag_mm2 = b_mm * h_mm
            return rho_min * Ag_mm2

        def get_effective_depth(H_m, cover_m, bar_diam_ref_mm=16.0):
            """
            Estima d a partir de H y cover, usando un diámetro de barra de referencia.
            """
            db_ref_m = bar_diam_ref_mm / 1000.0  # mm -> m
            d_m = H_m - cover_m - 0.5 * db_ref_m
            # Evitar valores raros
            d_m = max(d_m, 0.5 * H_m)
            return d_m

        def fallback_config(As_total):
            """
            Si no cabe ninguna configuración según NSR-10,
            usar 2 barras #4 o #3 como mínimo y repartir As_total.
            """
            fallback_bar = bar_catalog['#4']  # Barra mas pequena
            min_bars = 2
            Ab_m2 = fallback_bar['area'] / 1e6  # convertir mm² a m²
            As_per_bar = As_total / min_bars
            return min_bars, max(As_per_bar, 1e-6)

        def get_bar_config(As_req, free_length, prefer_smallest=True):
            """
            Busca una configuración de barras que quepa en el largo libre.
            """
            for bar_name, bar_data in sorted(bar_catalog.items(), key=lambda x: x[1]['diameter'], reverse=not prefer_smallest):
                db_m = bar_data['diameter'] / 1000
                Ab = bar_data['area']  # mm²
                e_min = max(1.5 * db_m, 0.04)
                n_bars = int(np.ceil(As_req / Ab))
                s_module = db_m + e_min
                L_required = n_bars * s_module
                if L_required <= free_length + e_min:
                    return n_bars, Ab / 1e6  # m²
            # Si no cabe ninguna configuración
            return fallback_config(As_req)

        if row['Section Type'] == 'Concrete Rectangular':
            if row['Design Type'] == 'Column':
                As_total = row['As']
                As_corner = row.get('Corner Bar As', 0)
                As_middle = row.get('Mid Bar As', 0) or 0

                As_requerido_col = max(As_total, As_min_column_NSR10(B*1000, H*1000))

                As_axis2 = (As_requerido_col - (As_middle + As_corner)) / 2 + As_corner / 2
                As_axis3 = As_middle

                free_len_ax2 = B - 2 * cover
                n_bars_ax2, Ab_ax2 = get_bar_config(As_axis2, free_len_ax2)

                if As_middle == 0:
                    return {
                        'number_bars_axis3': 2,
                        'number_bars_axis2': n_bars_ax2,
                        'cover': cover,
                        'bar_area_axis3': 1e-6,
                        'bar_area_axis2': Ab_ax2
                    }
                else:
                    free_len_ax3 = H - 2 * cover
                    n_bars_ax3_face, Ab_ax3 = get_bar_config(As_axis3 / 2, free_len_ax3)

                    return {
                        'number_bars_axis3': n_bars_ax3_face * 2,
                        'number_bars_axis2': n_bars_ax2,
                        'cover': cover,
                        'bar_area_axis3': Ab_ax3,
                        'bar_area_axis2': Ab_ax2
                    }

            else:  # Viga
                d_m = get_effective_depth(H_m=H, cover_m=cover, bar_diam_ref_mm=15.9)
                As_top = max(row.get('As Top', 0), As_min_beam_NSR10(fc_MPa, fy_MPa, B*1000, d_m*1000)/1e6)
                As_bottom = max(row.get('As Bottom', 0), As_min_beam_NSR10(fc_MPa, fy_MPa, B*1000, d_m*1000)/1e6)
                free_length = B - 2 * cover

                n_top, Ab_top = get_bar_config(As_top, free_length)
                n_bot, Ab_bot = get_bar_config(As_bottom, free_length)

                return {
                    'number_bars_top': n_top,
                    'bar_area_top': Ab_top,
                    'cover': cover,
                    'number_bars_bottom': n_bot,
                    'bar_area_bottom': Ab_bot
                }

        elif row['Section Type'] == 'Concrete Circle':
            if pd.isna(H):
                return {
                    'number_bars_circumference': 2,
                    'cover': cover,
                    'bar_area_circumference': 1e-6
                }
            else:
                D = H
                As_total = row['As']
                for bar_name, bar_data in bar_catalog.items():
                    db_m = bar_data['diameter'] / 1000
                    Ab = bar_data['area']
                    D_eff = D - 2 * (cover + 0.0095 + 0.5 * db_m)
                    if D_eff <= 0:
                        continue
                    L_libre = np.pi * D_eff
                    e_min = max(1.5 * db_m, 0.04)
                    n_bars = int(np.ceil(As_total / Ab))
                    s_module = db_m + e_min
                    L_required = n_bars * s_module

                    if L_required <= L_libre + e_min:
                        return {
                            'number_bars_circumference': n_bars,
                            'cover': cover,
                            'bar_area_circumference': Ab / 1e6
                        }
                # Fallback si ninguna configuración cabe
                n_bars_fallback, Ab_fallback = fallback_config(As_total)
                return {
                    'number_bars_circumference': n_bars_fallback,
                    'cover': cover,
                    'bar_area_circumference': Ab_fallback
                }

        # Fallback general por si no entra en ningún caso
        return {
            'number_bars': 2,
            'cover': cover,
            'bar_area': 129/1e6 
        }
    
    @staticmethod
    def generate_rebardata_aci3_1(row):
        """
        Genera información de armado a partir de resultados de diseño (tipo ETABS),
        imponiendo cuantía mínima según NSR-10 y alineando con un catálogo de barras.

        Suposiciones:
        - t2, t3 en [m]
        - As, As Top, As Bottom, etc. en [mm²]
        - fc_MPa, fy_MPa en [MPa]
        """

        # -------------------------------------------------------
        # Catálogo de barras (NSR-10 / ACI estándar)
        # -------------------------------------------------------
        bar_catalog = {
            '#9': {'diameter': 28.7, 'area': 645},  # mm²
            '#8': {'diameter': 25.4, 'area': 510},
            '#7': {'diameter': 22.2, 'area': 387},
            '#6': {'diameter': 19.1, 'area': 284},
            '#5': {'diameter': 15.9, 'area': 199},
            '#4': {'diameter': 12.7, 'area': 129},
            # '#3': {'diameter': 9.5,  'area': 71},
        }

        # -------------------------------------------------------
        # Parámetros geométricos y materiales
        # -------------------------------------------------------
        B = float(row['t2'])  # m
        H = float(row['t3'])  # m
        cover = 0.04          # m (recubrimiento)

        # Intenta leer fc y fy desde row, con defaults razonables
        fc_raw = float(row.get("Fc"))
        fc_MPa = fc_raw/1000.0 if fc_raw > 200 else fc_raw
        fy_MPa = 420

        # -------------------------------------------------------
        # Helpers de cuantía mínima NSR-10
        # -------------------------------------------------------

        def As_min_beam_NSR10(fc_MPa, fy_MPa, b_mm, d_mm):
            """
            NSR-10 / ACI-318:
            As,min = max( 3*sqrt(145*fc)/fy * b d , 200/fy * b d )
            Unidades: fc, fy en MPa, b,d en mm => As en mm²
            """
            # # término concreto
            # As1 = (3.0 * np.sqrt(145.0 * fc_MPa) / fy_MPa) * b_mm * d_mm
            # # término acero
            # As2 = (200.0 / fy_MPa) * b_mm * d_mm
            # return max(As1, As2)
        
            As1 = (0.25 * np.sqrt(fc_MPa) / fy_MPa) * b_mm * d_mm
            As2 = (1.4 / fy_MPa) * b_mm * d_mm
            return max(As1, As2)

        def As_min_column_NSR10(b_mm, h_mm, rho_min=0.01):
            """
            NSR-10 columnas reforzadas:
            ρ_min = 1%  => As_min = 0.01 * Ag
            (no depende directamente de fc/fy en la expresión simplificada)
            """
            Ag_mm2 = b_mm * h_mm
            return rho_min * Ag_mm2

        # -------------------------------------------------------
        # Helpers geométricos
        # -------------------------------------------------------

        def get_effective_depth(H_m, cover_m, bar_diam_ref_mm=16.0):
            """
            Estima d a partir de H y cover, usando un diámetro de barra de referencia.
            """
            db_ref_m = bar_diam_ref_mm / 1000.0  # mm -> m
            d_m = H_m - cover_m - 0.5 * db_ref_m
            # Evitar valores raros
            d_m = max(d_m, 0.5 * H_m)
            return d_m

        # -------------------------------------------------------
        # Helpers de armado: fallback + configuración
        # -------------------------------------------------------

        def fallback_config(As_req_mm2, min_bars=2):
            """
            Si no cabe ninguna configuración con el chequeo geométrico,
            usar la barra más pequeña y tantas como se requieran,
            pero nunca menos de min_bars.
            """
            # Barra más pequeña por diámetro
            smallest = sorted(bar_catalog.items(), key=lambda x: x[1]['diameter'])[0][1]
            Ab_mm2 = smallest['area']
            n_bars = max(min_bars, int(np.ceil(As_req_mm2 / max(Ab_mm2, 1e-9))))
            return n_bars, Ab_mm2 / 1e6  # m²

        def get_bar_config(As_req_mm2, free_length_m, min_bars=2, prefer_smallest=True):
            """
            Busca una configuración de barras que:
            - suministre al menos As_req_mm2
            - quepa en el largo libre 'free_length_m'
            - use al menos 'min_bars' barras

            Retorna:
            - n_bars
            - área por barra [m²]
            """
            # Ordena catálogo por diámetro
            bars_sorted = sorted(
                bar_catalog.items(),
                key=lambda x: x[1]['diameter'],
                reverse=not prefer_smallest
            )

            for _, bar_data in bars_sorted:
                db_m = bar_data['diameter'] / 1000.0  # m
                Ab_mm2 = bar_data['area']            # mm²

                e_min = max(1.5 * db_m, 0.04)        # separación mínima [m]
                n_bars = max(min_bars, int(np.ceil(As_req_mm2 / max(Ab_mm2, 1e-9))))
                s_module = db_m + e_min              # módulo barra+espacio
                L_required = n_bars * s_module       # largo requerido

                if L_required <= free_length_m + e_min:
                    return n_bars, Ab_mm2 / 1e6      # m²

            # Si no se encontró nada que quepa, usar fallback
            return fallback_config(As_req_mm2, min_bars=min_bars)

        # -------------------------------------------------------
        # Lógica principal por tipo de sección
        # -------------------------------------------------------

        sec_type = row['Section Type']
        design_type = row.get('Design Type', '')

        # ==============
        # RECTANGULAR
        # ==============
        if sec_type == 'Concrete Rectangular':

            # -------------------------
            # COLUMNAS RECTANGULARES
            # -------------------------
            if design_type == 'Column':
                # ETABS
                As_total_etabs = float(row.get('As', 0.0))               # mm²
                As_corner = float(row.get('Corner Bar As', 0.0) or 0.0)  # mm²
                As_middle = float(row.get('Mid Bar As', 0.0) or 0.0)     # mm²

                b_mm = B * 1000.0
                h_mm = H * 1000.0

                # As mínimo por NSR-10 (ρ_min = 1%)
                As_min_col = As_min_column_NSR10(b_mm, h_mm, rho_min=0.01)

                # As que realmente vamos a exigir en la columna
                As_total_req = max(As_total_etabs, As_min_col)

                # Intentamos respetar la distribución original (corner/mid) si existe,
                # pero imponiendo un mínimo "2 top, 2 bottom, 2 intermedio" (6 barras total).
                # Para no enredar mucho, asignamos:
                #   - Eje 2 (top/bottom): ~2/3 de As_total_req
                #   - Eje 3 (intermedio): ~1/3 de As_total_req
                if As_total_etabs > 0.0:
                    # Distribución original estimada
                    As_axis2_etabs = max(
                        0.0,
                        (As_total_etabs - (As_middle + As_corner)) / 2.0 + As_corner / 2.0
                    )
                    As_axis3_etabs = max(0.0, As_middle)
                else:
                    As_axis2_etabs = 0.0
                    As_axis3_etabs = 0.0

                # Distribución mínima "geométrica"
                As_axis2_min = (2.0 / 3.0) * As_total_req
                As_axis3_min = As_total_req - As_axis2_min

                As_axis2_req = max(As_axis2_etabs, As_axis2_min)
                As_axis3_req = max(As_axis3_etabs, As_axis3_min)

                # Longitudes libres
                free_len_ax2 = B - 2.0 * cover
                free_len_ax3 = H - 2.0 * cover

                # Eje 2: al menos 4 barras (2 top + 2 bottom)
                n_bars_ax2, Ab_ax2 = get_bar_config(
                    As_req_mm2=As_axis2_req,
                    free_length_m=free_len_ax2,
                    min_bars=4
                )

                # Eje 3: al menos 2 barras (intermedias)
                n_bars_ax3, Ab_ax3 = get_bar_config(
                    As_req_mm2=As_axis3_req,
                    free_length_m=free_len_ax3,
                    min_bars=2
                )

                return {
                    'number_bars_axis2': n_bars_ax2,
                    'bar_area_axis2': Ab_ax2,  # m²
                    'number_bars_axis3': n_bars_ax3,
                    'bar_area_axis3': Ab_ax3,  # m²
                    'cover': cover
                }

            # -------------------------
            # VIGAS RECTANGULARES
            # -------------------------
            else:  # Design Type != 'Column' => Viga
                As_top_etabs = float(row.get('As Top', 0.0))     # mm²
                As_bottom_etabs = float(row.get('As Bottom', 0.0))  # mm²

                # b y d para cuantía mínima
                b_mm = B * 1000.0
                # Usamos un diámetro de referencia ~#5 para estimar d
                d_m = get_effective_depth(H_m=H, cover_m=cover, bar_diam_ref_mm=15.9)
                d_mm = d_m * 1000.0

                # As,min total de la viga
                As_min_total = As_min_beam_NSR10(
                    fc_MPa=fc_MPa,
                    fy_MPa=fy_MPa,
                    b_mm=b_mm,
                    d_mm=d_mm
                )

                # Repartimos As_min en top y bottom por simplicidad
                As_min_face = 0.5 * As_min_total

                # As a exigir en cada cara:
                As_top_req = max(As_top_etabs, As_min_face)
                As_bottom_req = max(As_bottom_etabs, As_min_face)

                # Largo libre en dirección de barras (ancho de la viga)
                free_length = B - 2.0 * cover

                # Siempre mínimo 2 barras top y 2 barras bottom
                n_top, Ab_top = get_bar_config(
                    As_req_mm2=As_top_req,
                    free_length_m=free_length,
                    min_bars=2
                )
                n_bot, Ab_bot = get_bar_config(
                    As_req_mm2=As_bottom_req,
                    free_length_m=free_length,
                    min_bars=2
                )

                return {
                    'number_bars_top': n_top,
                    'bar_area_top': Ab_top,     # m²
                    'number_bars_bottom': n_bot,
                    'bar_area_bottom': Ab_bot, # m²
                    'cover': cover
                }

        # ==============
        # CIRCULAR
        # ==============
        elif sec_type == 'Concrete Circle':
            # Interpretamos como columna circular
            if pd.isna(H):
                # Sección mal definida: al menos 6 barras pequeñas
                n_bars_fallback, Ab_fallback = fallback_config(
                    As_req_mm2=0.0,
                    min_bars=6
                )
                return {
                    'number_bars_circumference': n_bars_fallback,
                    'bar_area_circumference': Ab_fallback,  # m²
                    'cover': cover
                }
            else:
                D = H  # m (diámetro)
                D_mm = D * 1000.0

                As_total_etabs = float(row.get('As', 0.0))  # mm²

                # Ag para columna circular
                Ag_mm2 = np.pi * (D_mm ** 2) / 4.0
                As_min_col = 0.01 * Ag_mm2  # 1% de Ag

                As_total_req = max(As_total_etabs, As_min_col)

                # Búsqueda de barra y número mínimo (>= 6 barras)
                best_config = None

                for _, bar_data in bar_catalog.items():
                    db_m = bar_data['diameter'] / 1000.0
                    Ab_mm2 = bar_data['area']

                    # Diámetro efectivo para el círculo de barras
                    D_eff = D - 2.0 * (cover + 0.0095 + 0.5 * db_m)  # 9.5 mm ~ Ø estribo
                    if D_eff <= 0.0:
                        continue

                    L_libre = np.pi * D_eff
                    e_min = max(1.5 * db_m, 0.04)
                    n_bars = max(6, int(np.ceil(As_total_req / max(Ab_mm2, 1e-9))))
                    s_module = db_m + e_min
                    L_required = n_bars * s_module

                    if L_required <= L_libre + e_min:
                        best_config = (n_bars, Ab_mm2 / 1e6)
                        break

                if best_config is None:
                    n_bars, Ab_bar = fallback_config(
                        As_req_mm2=As_total_req,
                        min_bars=6
                    )
                else:
                    n_bars, Ab_bar = best_config

                return {
                    'number_bars_circumference': n_bars,
                    'bar_area_circumference': Ab_bar,  # m²
                    'cover': cover
                }

        # -------------------------------------------------------
        # Fallback general si nada aplica
        # -------------------------------------------------------
        n_bars_fallback, Ab_fallback = fallback_config(As_req_mm2=0.0, min_bars=2)
        return {
            'number_bars': n_bars_fallback,
            'bar_area': Ab_fallback,  # m²
            'cover': cover
        }

    @staticmethod
    def generate_rebardata_user(row):

        if row['Section Type'] == 'Concrete Rectangular':
            if row['Design Type'] == 'Beam':
                return {
                    'number_bars_top': row['#top'],
                    'bar_area_top': row['area top'] / 1e6 ,
                    'cover': row['Top Cover'],
                    'number_bars_bottom': row['#bottom'],
                    'bar_area_bottom': row['area bottom'] / 1e6 
                }
            else:
                if row['# Long. Bars 3-axis'] < 2:
                    return {
                        'number_bars_axis3': 2,
                        'number_bars_axis2': row['# Long. Bars 2-axis'],
                        'cover': row['Cover'],
                        'bar_area_axis3': (row['Corner Bar Area'] / 1e6) / 2  if row['Corner Bar Area'] > 0 else 1e-6,
                        'bar_area_axis2': row['Corner Bar Area'] / 1e6 
                    }
                else:
                    return {
                        'number_bars_axis3': row['# Long. Bars 3-axis'],
                        'number_bars_axis2': row['# Long. Bars 2-axis'],
                        'cover': row['Cover'],
                        'bar_area_axis3': row['Corner Bar Area'] / 1e6 ,
                        'bar_area_axis2': row['Corner Bar Area'] / 1e6 
                    }

    @staticmethod
    def extraer_coeficientes(formula):
        match = re.search(r'\(.*?\)\s*([\d.]+)\s*CM\s*\+\s*([\d.]+)\s*CV', formula)
        if match:
            coef_cm = float(match.group(1))
            coef_cv = float(match.group(2))
            return coef_cm, coef_cv
        else:
            print(f"Error: No se pudo interpretar el caso de carga: '{formula}'.")
            sys.exit()

    @staticmethod
    def wallsOrientation(nodes, coords_nodes, tol=1e-3):

        def almost_eq(a, b, t=tol):
            return abs(a - b) <= t

        # Desempaquetar
        nodeA, nodeB, nodeC, nodeD = nodes
        CA, CB, CC, CD = coords_nodes

        dx = CB[0] - CA[0]
        dy = CB[1] - CA[1]

        # Clasificación con tolerancia
        if almost_eq(dx, 0.0):
            orient = 2            # vertical (eje Y)
            longitud = abs(CB[1] - CA[1])
            # Ordenar pares por Y
            if CB[1] >= CA[1]:
                bottom_pair = [(nodeA, CA), (nodeB, CB)]
            else:
                bottom_pair = [(nodeB, CB), (nodeA, CA)]
            if CD[1] >= CC[1]:
                top_pair = [(nodeC, CC), (nodeD, CD)]
            else:
                top_pair = [(nodeD, CD), (nodeC, CC)]
            order = [bottom_pair[0][0], bottom_pair[1][0], top_pair[1][0], top_pair[0][0]]

        elif almost_eq(dy, 0.0):
            orient = 1            # horizontal (eje X)
            longitud = abs(CB[0] - CA[0])
            # Ordenar pares por X
            if CB[0] >= CA[0]:
                left_pair = [(nodeA, CA), (nodeB, CB)]
            else:
                left_pair = [(nodeB, CB), (nodeA, CA)]
            if CD[0] >= CC[0]:
                right_pair = [(nodeC, CC), (nodeD, CD)]
            else:
                right_pair = [(nodeD, CD), (nodeC, CC)]
            order = [left_pair[0][0], left_pair[1][0], right_pair[1][0], right_pair[0][0]]

        else:
            # Ligeramente diagonal: decide por eje dominante
            if abs(dx) >= abs(dy):
                orient = 1        # tratar como horizontal
                longitud = abs(CB[0] - CA[0])
                # Orden por X
                if CB[0] >= CA[0]:
                    left_pair = [(nodeA, CA), (nodeB, CB)]
                else:
                    left_pair = [(nodeB, CB), (nodeA, CA)]
                if CD[0] >= CC[0]:
                    right_pair = [(nodeC, CC), (nodeD, CD)]
                else:
                    right_pair = [(nodeD, CD), (nodeC, CC)]
                order = [left_pair[0][0], left_pair[1][0], right_pair[1][0], right_pair[0][0]]
            else:
                orient = 2        # tratar como vertical
                longitud = abs(CB[1] - CA[1])
                # Orden por Y
                if CB[1] >= CA[1]:
                    bottom_pair = [(nodeA, CA), (nodeB, CB)]
                else:
                    bottom_pair = [(nodeB, CB), (nodeA, CA)]
                if CD[1] >= CC[1]:
                    top_pair = [(nodeC, CC), (nodeD, CD)]
                else:
                    top_pair = [(nodeD, CD), (nodeC, CC)]
                order = [bottom_pair[0][0], bottom_pair[1][0], top_pair[1][0], top_pair[0][0]]

        # Fallbacks de seguridad
        if longitud is None or longitud <= 0:
            # longitud degenerada: usa distancia 2D entre A y B como proxy
            from math import hypot
            longitud = hypot(dx, dy)

        if len(order) != 4:
            order = [nodeA, nodeB, nodeC, nodeD]

        return orient, longitud, order
    
    @staticmethod
    def build_muros_with_fibers(df_joints, df_shells, df_mat_conc, df_shell_sections,
                                df_assign_shell_sec, df_assign_pier, df_pier_props, df_design_aci,
                                NDE='DMO', MAX_ANCHO_FIBRA=0.30):
        """
        Devuelve: muros[pier][story] -> dict con:
            - Properties: Lw (m), tw (m), LHEB_I/D (m), fc (MPa)
            - Reinforcing_Steel: Rho_long, As_req
            - Shells: lista con fibras:
                ancho_fibras, espesor_fibras, cuantia_fibras, tipo_concreto ('Conf'/'Unconf'),
                tipo_refuerzo, direccion, y joints (ids y coords)
        """
        # --- Diccionario de coords de nodos (id-> xyz) ---
        coord_dict = df_joints.set_index('Element Label')[['Global X','Global Y','Global Z']].to_dict('index')

        # --- Normaliza ids a str ---
        def s(x): 
            try: return str(int(x))
            except: return str(x)

        df_shells = df_shells.copy()
        for c in ['Joint 1','Joint 2','Joint 3','Joint 4','Area Label','Element Label']:
            df_shells[c] = df_shells[c].apply(s)

        df_assign_pier = df_assign_pier.copy()
        df_assign_pier.rename(columns={'Unique Name':'Element Label'}, inplace=True)
        df_assign_pier['Element Label'] = df_assign_pier['Element Label'].apply(s)

        # --- Une pier a cada shell ---
        shells = pd.merge(
            df_shells, 
            df_assign_pier[['Element Label','Pier','Story']],
            on=['Element Label','Story'], how='inner'
        )

        # --- arma diccionario base muros[pier][story] ---
        muros = {}
        for _, sh in shells.iterrows():
            pier = str(sh['Pier']); story = str(sh['Story'])
            muros.setdefault(pier, {}).setdefault(story, {
                "coordinates": {k: None for k in ["Cx_bottom","Cy_bottom","Cz_bottom","Cx_top","Cy_top","Cz_top"]},
                "Properties": {"Lw": None,"tw": None,"Angulo": None,"LHEB_I": 0.0,"LHEB_D": 0.0,"fc": None},
                "Reinforcing_Steel": {"Rho_long": None,"As_req": None},
                "Design": {"Comp_left": None,"Comp_right": None,"c_left": None,"c_right": None,
                           "c_limit": None,"comp_limit": None,"LHEB_I": 0.0,"LHEB_D": 0.0},
                "Shells": []
            })

            # coords & ids
            j1, j2, j3, j4 = [s(sh[f'Joint {k}']) for k in [1,2,3,4]]
            J = {
                'id1': j1, 'id2': j2, 'id3': j3, 'id4': j4,
                'p1': coord_dict[int(j1)], 'p2': coord_dict[int(j2)],
                'p3': coord_dict[int(j3)], 'p4': coord_dict[int(j4)]
            }
            muros[pier][story]["Shells"].append({
                "Name_Shell": str(sh['Area Label']), "Label": str(sh['Element Label']),
                "Joint1": {"id": j1, **J['p1']}, "Joint2": {"id": j2, **J['p2']},
                "Joint3": {"id": j3, **J['p3']}, "Joint4": {"id": j4, **J['p4']},
            })

        # --- agrega propiedades de pier (Lw, tw, ángulo, fc y CGs) ---
        df_pier_props = pd.merge(
            df_pier_props, 
            df_mat_conc[['Material','Fc']], left_on='Material', right_on='Material', how='left'
        )
        for _, r in df_pier_props.iterrows():
            pier = str(r['Pier']); story = str(r['Story'])
            if pier in muros and story in muros[pier]:
                d = muros[pier][story]
                d["coordinates"].update({
                    "Cx_bottom": r.get("CG Bottom X"), "Cy_bottom": r.get("CG Bottom Y"), "Cz_bottom": r.get("CG Bottom Z"),
                    "Cx_top":    r.get("CG Top X"),    "Cy_top":    r.get("CG Top Y"),    "Cz_top":    r.get("CG Top Z"),
                })
                d["Properties"].update({
                    "Lw": r.get("Width Bottom", None) if r.get("Width Bottom", None) is not None else None,
                    "tw": r.get("Thickness Bottom", None) if r.get("Thickness Bottom", None) is not None else None,
                    "Angulo": r.get("Axis Angle", None),
                    "fc": r.get("Fc", None)/1000 if r.get("Fc", None) is not None else None,  # MPa
                })

        # --- función limites (idéntica a tu lógica) ---
        def calcular_limites_muro(lw, c_left, c_right, comp_left, comp_right, nde, fc):
            if lw is None or lw <= 0: return {k:0.0 for k in ["c_limit","comp_limit","LHEB_I","LHEB_D"]}
            nde = nde.upper()
            if nde == "DMO": du_hw, esf1, esf2 = 0.0035, 0.30, 0.22
            elif nde == "DES": du_hw, esf1, esf2 = 0.0070, 0.20, 0.15
            else: raise ValueError("NDE debe ser 'DMO' o 'DES'")
            c_limit = round(lw/(600*du_hw), 3)
            comp_limit = round(esf1*float(fc or 21), 3)
            LHEB_I = 0.0; LHEB_D = 0.0
            if (comp_left and comp_left>comp_limit) or (c_left and c_left>c_limit):
                LHEB_I = round(max(c_left - 0.1*lw, (c_left or 0)/2), 3)
            if (comp_right and comp_right>comp_limit) or (c_right and c_right>c_limit):
                LHEB_D = round(max(c_right - 0.1*lw, (c_right or 0)/2), 3)
            return {"c_limit": c_limit, "comp_limit": comp_limit, "LHEB_I": LHEB_I, "LHEB_D": LHEB_D}

        # --- integra tabla ACI (c, compresiones, cuantía requerida) ---
        dfD = df_design_aci.copy()
        dfD.rename(columns={'Pier Label':'Pier'}, inplace=True)
        for (pier, pisos) in muros.items():
            df_pier = dfD[dfD['Pier'].astype(str).str.strip()==pier]
            if df_pier.empty: continue
            for story, d in pisos.items():
                # ETABS a veces no trae Story en esta tabla -> aplicamos a todos los pisos de ese pier
                lw, tw, fc = d["Properties"]["Lw"], d["Properties"]["tw"], d["Properties"]["fc"] or 21
                # tomamos la fila "Bottom" o la 1ra disponible
                row = df_pier[df_pier['Station']=='Bottom'].head(1)
                if row.empty: row = df_pier.head(1)
                c_left  = float(row['C Depth Left'].iloc[0])/1 if pd.notna(row['C Depth Left'].iloc[0]) else None
                c_right = float(row['C Depth Right'].iloc[0])/1 if pd.notna(row['C Depth Right'].iloc[0]) else None
                comp_left  = float(row['Compressive Stress Left'].iloc[0])/1000 if pd.notna(row['Compressive Stress Left'].iloc[0]) else None
                comp_right = float(row['Compressive Stress Right'].iloc[0])/1000 if pd.notna(row['Compressive Stress Right'].iloc[0]) else None
                limites = calcular_limites_muro(lw, c_left, c_right, comp_left, comp_right, NDE, fc)
                d["Design"].update({
                    "Comp_left": comp_left, "Comp_right": comp_right,
                    "c_left": c_left, "c_right": c_right,
                    "c_limit": limites["c_limit"], "comp_limit": limites["comp_limit"],
                    "LHEB_I": limites["LHEB_I"], "LHEB_D": limites["LHEB_D"],
                })
                cuantia = float(row['Required Reinf'].iloc[0])/100 if pd.notna(row['Required Reinf'].iloc[0]) else 0.0
                as_req = round(cuantia*(lw or 0)*(tw or 0)*1e6, 0) if lw and tw else 0.0
                d["Reinforcing_Steel"].update({"Rho_long": cuantia, "As_req": as_req})
                d["Properties"].update({"LHEB_I": limites["LHEB_I"], "LHEB_D": limites["LHEB_D"]})

        # --- discretización en fibras por shell (usa LHEB y cuantía) ---
        for pier, pisos in muros.items():
            for story, d in pisos.items():
                Lw = d["Properties"]["Lw"] or 0.0
                tw = d["Properties"]["tw"] or 0.0
                LHEB_I = d["Properties"]["LHEB_I"] or 0.0
                LHEB_D = d["Properties"]["LHEB_D"] or 0.0
                cuantia = d["Reinforcing_Steel"]["Rho_long"] or 0.0
                shells = d["Shells"]
                if not shells: continue

                # dirección del muro
                j1, j2 = shells[0]["Joint1"], shells[0]["Joint2"]
                dx, dy = abs(j1["Global X"]-j2["Global X"]), abs(j1["Global Y"]-j2["Global Y"])
                direccion = "X" if dx >= dy else "Y"

                # extremos globales del muro a lo largo de la dirección
                if direccion == "X":
                    coord_min = min([min(s["Joint1"]["Global X"], s["Joint2"]["Global X"]) for s in shells])
                    coord_max = max([max(s["Joint1"]["Global X"], s["Joint2"]["Global X"]) for s in shells])
                else:
                    coord_min = min([min(s["Joint1"]["Global Y"], s["Joint2"]["Global Y"]) for s in shells])
                    coord_max = max([max(s["Joint1"]["Global Y"], s["Joint2"]["Global Y"]) for s in shells])

                conf_left = (coord_min, coord_min + LHEB_I)
                conf_right = (coord_max - LHEB_D, coord_max)
                todo_conf = cuantia >= 1.0

                for sh in shells:
                    if direccion == "X":
                        cmin = min(sh["Joint1"]["Global X"], sh["Joint2"]["Global X"])
                        cmax = max(sh["Joint1"]["Global X"], sh["Joint2"]["Global X"])
                    else:
                        cmin = min(sh["Joint1"]["Global Y"], sh["Joint2"]["Global Y"])
                        cmax = max(sh["Joint1"]["Global Y"], sh["Joint2"]["Global Y"])

                    Lloc = cmax - cmin
                    zonas = []
                    if todo_conf:
                        zonas = [("Conf", Lloc)]
                    else:
                        ol = max(0.0, min(cmax, conf_left[1])  - max(cmin, conf_left[0])) if LHEB_I>0 else 0.0
                        orr= max(0.0, min(cmax, conf_right[1]) - max(cmin, conf_right[0])) if LHEB_D>0 else 0.0
                        mid = Lloc - ol - orr
                        if ol  > 1e-6: zonas.append(("Conf",  ol))
                        if mid > 1e-6: zonas.append(("Unconf", mid))
                        if orr > 1e-6: zonas.append(("Conf",  orr))
                        if not zonas:  zonas = [("Unconf", Lloc)]

                    tipo_concreto, ancho_f, esp_f, cuant_f, tipo_ref = [], [], [], [], []
                    for (tipo, a_zona) in zonas:
                        amax = 0.15 if tipo=="Conf" else MAX_ANCHO_FIBRA
                        nsub = max(1, int(np.ceil(a_zona/amax)))
                        asub = round(a_zona/nsub, 3)
                        tipo_concreto.extend([tipo]*nsub)
                        ancho_f.extend([asub]*nsub)
                        esp_f.extend([tw]*nsub)
                        cuant_f.extend([cuantia]*nsub)
                        tipo_ref.extend(["RB"]*nsub)
                    sh.update({
                        "direccion": direccion,
                        "n_macro_fibras": len(ancho_f),
                        "ancho_fibras": ancho_f,
                        "espesor_fibras": esp_f,
                        "cuantia_fibras": cuant_f,
                        "tipo_concreto": tipo_concreto,
                        "tipo_refuerzo": tipo_ref
                    })

        return muros
    
    # Helpers para identificar losas soportadas por muros -> Sistema dual
    @staticmethod
    def wall_top_edges_by_story(df_walls):
        edges = {}
        if df_walls is None or not isinstance(df_walls, pd.DataFrame):
            return edges

        for _, r in df_walls.iterrows():
            st = r['Story']
            nodes = r.get('Nodes Orientation', None)
            if not nodes or len(nodes) != 4:
                continue
            j3 = int(nodes[2]); j4 = int(nodes[3])
            e = tuple(sorted((j3, j4)))
            edges.setdefault(st, set()).add(e)
        return edges
    
    @staticmethod
    def slabs_touching_walls(df_slabs, wall_edges_by_story):
        df = df_slabs.copy()
        df['touch_wall'] = False

        for idx, r in df.iterrows():
            st = r['Story']
            edges = wall_edges_by_story.get(st, set())
            j = [r.get('Joint 1'), r.get('Joint 2'), r.get('Joint 3'), r.get('Joint 4')]
            j = [int(x) for x in j if pd.notna(x)]

            if len(j) < 3:
                continue

            pairs = []
            if len(j) == 3:
                pairs = [(j[0], j[1]), (j[1], j[2]), (j[2], j[0])]
            else:
                pairs = [(j[0], j[1]), (j[1], j[2]), (j[2], j[3]), (j[3], j[0])]

            hit = any(tuple(sorted(p)) in edges for p in pairs)
            df.loc[idx, 'touch_wall'] = bool(hit)

        return df

    # Validaciones geometria:
    @staticmethod
    def _validate_beams_geometry(df_beams):
        if df_beams is None or not isinstance(df_beams, pd.DataFrame):
            return
        if 'lenght' not in df_beams.columns:
            return

        badL = df_beams[df_beams['lenght'].isna() | (df_beams['lenght'] <= 1e-6)]
        if not badL.empty:
            cols = [c for c in ['Story','Object Label','Element Label','Joint I','Joint J','lenght'] if c in badL.columns]
            ex = badL[cols].head(10).to_string(index=False)
            raise ValueError(
                "[ERROR] Hay vigas con longitud 0/NaN (joints coincidentes o geometría inválida).\n"
                f"Ejemplos:\n{ex}\n"
                "Solución: revisa que Joint I y Joint J no sean el mismo nodo, o que la geometría no tenga elementos degenerados."
            )

    def _validate_shell_max_4_joints(self, shells_df: pd.DataFrame):
        """
        Valida que ningún shell tenga Joint 5+ asignado.
        Si existe 'Joint 5' (o superiores) y viene con valor != NaN/0, lanza error
        mostrando qué elementos lo tienen.
        """
        if shells_df is None or not isinstance(shells_df, pd.DataFrame) or shells_df.empty:
            return

        # Detectar columnas Joint N
        joint_cols = [c for c in shells_df.columns if str(c).strip().lower().startswith("joint ")]
        if not joint_cols:
            return

        # Sacar números de "Joint N"
        def _joint_num(col):
            try:
                return int(str(col).strip().split()[-1])
            except Exception:
                return None

        joint_nums = {c: _joint_num(c) for c in joint_cols}
        extra_joint_cols = [c for c, n in joint_nums.items() if n is not None and n >= 5]

        # Si el excel no trae Joint 5+, no hay nada que validar
        if not extra_joint_cols:
            return

        # Marcar shells donde algún Joint 5+ venga con dato
        tmp = shells_df.copy()
        for c in extra_joint_cols:
            # a veces viene como string, a veces como número
            tmp[c] = pd.to_numeric(tmp[c], errors="coerce")

        mask = False
        for c in extra_joint_cols:
            mask = mask | tmp[c].notna() & (tmp[c] != 0)

        bad = tmp.loc[mask].copy()
        if bad.empty:
            return

        cols_show = [c for c in ['Story', 'Area Label', 'Element Label', 'Area Type'] if c in bad.columns]
        cols_show += [c for c in ['Joint 1','Joint 2','Joint 3','Joint 4'] if c in bad.columns]
        cols_show += [c for c in extra_joint_cols if c in bad.columns]

        ex = bad[cols_show].head(20).to_string(index=False)

        raise ValueError(
            "[ERROR] Se detectaron shells con más de 4 joints (Joint 5 o superior).\n"
            "Este convertidor solo admite losas/muros con máximo 4 nodos por shell.\n\n"
            f"Elementos con Joint 5+ (primeros 20):\n{ex}\n\n"
            "Solución: en ETABS subdivide esos shells (malla/mesh) a triángulos o cuadriláteros."
        )








    @staticmethod
    def generate_rebardata_aci3(row, type:str):
        if type == 'beams':
            return {
                    'bar_area_top_initial': row['Bar_Top_Area_I'] / 1e6,
                    'bar_area_top_middle': row['Bar_Top_Area_Mid'] / 1e6,
                    'bar_area_top_final': row['Bar_Top_Area_F'] / 1e6,
                    'bar_area_bottom_initial': row['Bar_Bot_Area_I'] / 1e6,
                    'bar_area_bottom_middle': row['Bar_Bot_Area_Mid'] / 1e6,
                    'bar_area_bottom_final': row['Bar_Bot_Area_F'] / 1e6,
                    'number_bars_initial': row['Num_Barras_I'],
                    'number_bars_middle': row['Num_Barras_Mid'],
                    'number_bars_final': row['Num_Barras_F'],
                }
        else:
            return {
                    'bar_area_tb_initial': row['As_Bar_Top_I'] / 1e6,
                    'bar_area_tb_middle': row['As_Bar_Top_Mid'] / 1e6,
                    'bar_area_tb_final': row['As_Bar_Top_F'] / 1e6,
                    'bar_area_mid_initial': row['As_Bar_Mid_I'] / 1e6,
                    'bar_area_mid_middle': row['As_Bar_Mid_Mid'] / 1e6,
                    'bar_area_mid_final': row['As_Bar_Mid_F'] / 1e6,
                    'number_bars_tb_initial': row['Num_Barras_Top_Bottom_I'],
                    'number_bars_tb_middle': row['Num_Barras_Top_Bottom_Mid'],
                    'number_bars_tb_final': row['Num_Barras_Top_Bottom_F'],\
                    'number_bars_mid_initial': row['Num_Barras_Mid_I'],
                    'number_bars_mid_middle': row['Num_Barras_Mid_Mid'],
                    'number_bars_mid_final': row['Num_Barras_Mid_F'],
                }


    # -------------------------------------------------------
    # FUNCIÓN PRINCIPAL
    # -------------------------------------------------------
    def process_Rebar_Columns(self, df, cover=0.05, s_max=0.20, max_bar='#6'):

        df_sub = df.copy()
        df_rect = df_sub[df_sub["Shape"] != "Concrete Circle"].copy()

        if df_rect.empty:
            return None

        # ----------------------------
        # EXTRAER DIMENSIONES
        # ----------------------------
        df_rect[["Dim_Menor", "Dim_Mayor"]] = df_rect["Design Section"] \
            .apply(self.extraer_dimensiones)

        # ----------------------------
        # CALCULAR BARRAS POR LADO
        # ----------------------------
        df_rect["Num_Barras_Top_Bottom"] = df_rect["Dim_Menor"] \
            .apply(lambda x: self.calcular_barras_por_lado(x, cover, s_max))

        df_rect["Num_Barras_Mid"] = df_rect["Dim_Mayor"] \
            .apply(lambda x: self.calcular_barras_por_lado(x, cover, s_max))

        # Total barras perimetrales
        df_rect["Num_Bars_Total"] = (
            2 * df_rect["Num_Barras_Top_Bottom"] +
            2 * df_rect["Num_Barras_Mid"] - 4
        )

        # ----------------------------
        # ÁREA POR BARRA REQUERIDA
        # ----------------------------
        df_rect["As_req_bar"] = df_rect["As"] / df_rect["Num_Bars_Total"]

        df_rect[["Bar_Label", "Bar_Area"]] = df_rect["As_req_bar"] \
            .apply(lambda x: pd.Series(self.barra_mas_cercana(x, max_bar)))

        # Usamos área uniforme
        df_rect["As_Bar_Top"] = df_rect["Bar_Area"]
        df_rect["As_Bar_Mid"] = df_rect["Bar_Area"]

        # ----------------------------
        # DEFINIR ZONAS I - MID - F
        # ----------------------------
        df_rect["Zone"] = df_rect.groupby(["Story", "Label"])["Station"] \
            .transform(lambda x: pd.Series(["I", "Mid", "F"],
                                           index=x.sort_values().index))

        # ----------------------------
        # ORGANIZAR Y PIVOTEAR
        # ----------------------------
        df_final = df_rect[[
            "Story", "Label", "Station",
            "Num_Barras_Top_Bottom",
            "Num_Barras_Mid",
            "As_Bar_Top",
            "As_Bar_Mid",
            "Zone"
        ]]

        df_pivot = df_final.pivot_table(
            index=["Story", "Label"],
            columns="Zone",
            values=[
                "Num_Barras_Top_Bottom",
                "Num_Barras_Mid",
                "As_Bar_Top",
                "As_Bar_Mid"
            ]
        )
        
        print(df_pivot)

        df_pivot.columns = [f"{col[0]}_{col[1]}" for col in df_pivot.columns]
        df_ff = df_pivot.reset_index()

        df_ff_rect = df_ff[[
            "Story", "Label",
            "Num_Barras_Top_Bottom_I", "As_Bar_Top_I", "Num_Barras_Mid_I", "As_Bar_Mid_I",
            "Num_Barras_Top_Bottom_Mid", "As_Bar_Top_Mid", "Num_Barras_Mid_Mid", "As_Bar_Mid_Mid",
            "Num_Barras_Top_Bottom_F", "As_Bar_Top_F", "Num_Barras_Mid_F", "As_Bar_Mid_F"
        ]]

        return df_ff_rect

    def process_Rebar_Columns(self, df, cover=0.05, s_max=0.15, max_bar='#7'):
        
        df_sub = df.copy()
        df_rect = df_sub[df_sub["Shape"] != "Concrete Circle"].copy()
        # df_sub = df.copy()
        # df_rect = df_sub[df_sub["Shape"] != "Concrete Circle"].copy()
        df_circ = df_sub[df_sub["Shape"] == "Concrete Circle"].copy()

        if df_rect.empty:
            return None

        # ----------------------------
        # EXTRAER DIMENSIONES
        # ----------------------------
        df_rect[["Dim_Menor", "Dim_Mayor"]] = df_rect["Design Section"] \
            .apply(self.extraer_dimensiones)

        # ----------------------------
        # CALCULAR BARRAS POR LADO
        # ----------------------------
        df_rect["Num_Barras_Top_Bottom"] = df_rect["Dim_Menor"] \
            .apply(lambda x: self.calcular_barras_por_lado(x, cover, s_max))

        df_rect["Num_Barras_Mid"] = df_rect["Dim_Mayor"] \
            .apply(lambda x: self.calcular_barras_por_lado(x, cover, s_max))

        # Total barras perimetrales
        df_rect["Num_Bars_Total"] = (
            2 * df_rect["Num_Barras_Top_Bottom"] +
            2 * df_rect["Num_Barras_Mid"]
        )

        # ----------------------------
        # ÁREA POR BARRA REQUERIDA
        # ----------------------------
        df_rect["As_req_bar"] = df_rect["As"] / df_rect["Num_Bars_Total"]
        
        df_rect[["Bar_Label", "Bar_Area"]] = df_rect["As_req_bar"] \
            .apply(lambda x: pd.Series(self.barra_mas_cercana(x, max_bar)))

        # Usamos área uniforme
        df_rect["As_Bar_Top"] = df_rect["Bar_Area"]
        df_rect["As_Bar_Mid"] = df_rect["Bar_Area"]

        # ----------------------------
        # DEFINIR ZONAS I - MID - F
        # ----------------------------
        df_rect["Zone"] = df_rect.groupby(["Story", "Label"])["Station"] \
            .transform(lambda x: pd.Series(["I", "Mid", "F"],
                                           index=x.sort_values().index))

        # ----------------------------
        # ORGANIZAR Y PIVOTEAR
        # ----------------------------
        df_final = df_rect[[
            "Story", "Label", "Station",
            "Num_Barras_Top_Bottom",
            "Num_Barras_Mid",
            "As_Bar_Top",
            "As_Bar_Mid",
            "Zone"
        ]]

        df_pivot = df_final.pivot_table(
            index=["Story", "Label"],
            columns="Zone",
            values=[
                "Num_Barras_Top_Bottom",
                "Num_Barras_Mid",
                "As_Bar_Top",
                "As_Bar_Mid"
            ]
        )
        
        df_pivot.columns = [f"{col[0]}_{col[1]}" for col in df_pivot.columns]
        df_ff = df_pivot.reset_index()

        df_ff_rect = df_ff[[
            "Story", "Label",
            "Num_Barras_Top_Bottom_I", "As_Bar_Top_I", "Num_Barras_Mid_I", "As_Bar_Mid_I",
            "Num_Barras_Top_Bottom_Mid", "As_Bar_Top_Mid", "Num_Barras_Mid_Mid", "As_Bar_Mid_Mid",
            "Num_Barras_Top_Bottom_F", "As_Bar_Top_F", "Num_Barras_Mid_F", "As_Bar_Mid_F"
        ]]
        
        
        
        
        # df_sub = df.copy()
        # df_rect = df_sub[df_sub["Shape"] != "Concrete Circle"].copy()
        # df_circ = df_sub[df_sub["Shape"] == "Concrete Circle"].copy()
        
        # # --------------------
        # # --- RECTANGULARES
        # # --------------------
        # if not df_rect.empty:
        #     df_sub = df_rect.copy()
            
        #     # --- Cálculos previos ---
        #     df_sub["Prom_Bar_As"] = df_sub[["Mid Bar As", "Corner Bar As"]].mean(axis=1)
        #     df_sub["Num_Bars"] = df_sub["As"] / df_sub["Prom_Bar_As"]
        #     df_sub["Zone"] = df_sub.groupby(["Story", "Label"])["Station"] \
        #         .transform(lambda x: pd.Series(["I", "Mid", "F"], index=x.sort_values().index))
                
        #     # Extraer dimensiones
        #     df_sub[["Dim_Menor", "Dim_Mayor"]] = df_sub["Design Section"].apply(self.extraer_dimensiones)
            
        #     # Cálculo de barras por cara corta
        #     df_sub["Num_Barras_Top_Bottom"] = df_sub["Dim_Menor"].apply(self.calcular_num_barras_top_bottom)
        #     df_sub["Num_Barras_Mid"] = (df_sub["Num_Bars"] - 2 * df_sub["Num_Barras_Top_Bottom"]) / 2
            
        #     # Cálculo de As por barra y redondeo hacia arriba
        #     df_sub["As_Bar_Corner"] = df_sub["As"] / df_sub["Num_Bars"]
        #     df_sub[["Bar_Corner_Label", "Bar_Corner_Area"]] = df_sub["As_Bar_Corner"].apply(
        #         lambda x: pd.Series(self.barra_mas_cercana(x))
        #     )
            
        #     # Asignar barras mid
        #     df_sub["As_Mid"] = df_sub["As"] - 4 * df_sub["Bar_Corner_Area"]
        #     df_sub["As_Bar_Mid"] = df_sub["As_Mid"] / 8
        #     df_sub[["Bar_Mid_Label", "Bar_Mid_Area"]] = df_sub["As_Bar_Mid"].apply(
        #         lambda x: pd.Series(self.barra_mas_cercana(x))
        #     )
            
        #     # --- Organizar y pivotear ---
        #     df_final = df_sub[["Story", "Label", "Station", "Num_Barras_Top_Bottom", "Num_Barras_Mid", "Bar_Corner_Area", "Bar_Mid_Area"]].copy()
            
        #     df_final["As_Bar_Top"] = (2 * df_final["Bar_Corner_Area"] + (df_final["Num_Barras_Top_Bottom"] - 2) * df_final["Bar_Mid_Area"]) / df_final["Num_Barras_Top_Bottom"]
        #     df_final["As_Bar_Mid"] = df_final["Bar_Mid_Area"]
        #     df_final["Zone"] = df_final.groupby(["Story", "Label"])["Station"] \
        #         .transform(lambda x: pd.Series(["I", "Mid", "F"], index=x.sort_values().index))
                
        #     df_pivot = df_final.pivot_table(
        #         index=["Story", "Label"],
        #         columns="Zone",
        #         values=["Num_Barras_Top_Bottom", "Num_Barras_Mid", "As_Bar_Top", "As_Bar_Mid"]
        #     )
            
        #     df_pivot.columns = [f"{col[0]}_{col[1]}" for col in df_pivot.columns]
        #     df_ff = df_pivot.reset_index()
        #     df_ff_rect = df_ff[["Story", "Label",
        #                 "Num_Barras_Top_Bottom_I", "As_Bar_Top_I", "Num_Barras_Mid_I", "As_Bar_Mid_I",
        #                 "Num_Barras_Top_Bottom_Mid", "As_Bar_Top_Mid", "Num_Barras_Mid_Mid", "As_Bar_Mid_Mid",
        #                 "Num_Barras_Top_Bottom_F", "As_Bar_Top_F", "Num_Barras_Mid_F", "As_Bar_Mid_F"]]
        
        # else:
        #     df_ff_rect = pd.DataFrame()
        
        # --------------------
        # --- CIRCULARES
        # --------------------
        if not df_circ.empty:
            # Calcular circunferencia útil
            df_circ["Circunf_ref"] = np.pi * (df_circ["t3"] - 0.08)
        
            # Número de barras
            df_circ["Num_Barras"] = np.ceil(df_circ["Circunf_ref"] / 0.20)
        
            # As por barra
            df_circ["As_Bar"] = df_circ["As"] / df_circ["Num_Barras"]
        
            # Seleccionar barra comercial más cercana
            df_circ[["Bar_Label", "Bar_Area"]] = df_circ["As_Bar"].apply(
                lambda x: pd.Series(self.barra_mas_cercana(x))
            )
        
            # Organizar salida simple para circulares
            df_ff_circ = df_circ[["Story", "Label", "Num_Barras", "Bar_Label", "Bar_Area"]].copy()
            
            for zone in ["I", "Mid", "F"]:
                df_ff_circ[f"Num_Barras_Top_Bottom_{zone}"] = df_ff_circ["Num_Barras"]
                df_ff_circ[f"As_Bar_Top_{zone}"] = df_ff_circ["Bar_Area"]
                df_ff_circ[f"Num_Barras_Mid_{zone}"] = 0
                df_ff_circ[f"As_Bar_Mid_{zone}"] = 0
            
            df_ff_circ = df_ff_circ[[
                "Story", "Label",
                "Num_Barras_Top_Bottom_I", "As_Bar_Top_I", "Num_Barras_Mid_I", "As_Bar_Mid_I",
                "Num_Barras_Top_Bottom_Mid", "As_Bar_Top_Mid", "Num_Barras_Mid_Mid", "As_Bar_Mid_Mid",
                "Num_Barras_Top_Bottom_F", "As_Bar_Top_F", "Num_Barras_Mid_F", "As_Bar_Mid_F"
            ]]
            
        else:
            df_ff_circ = pd.DataFrame()
        
        # --------------------
        # --- UNIR RESULTADOS
        # --------------------
        if not df_ff_rect.empty and not df_ff_circ.empty:
            return pd.concat([df_ff_rect, df_ff_circ], ignore_index=True)
        elif not df_ff_rect.empty:
            return df_ff_rect
        else:
            return df_ff_circ
        


    def process_Rebar_Beams(self, df):
    
        df_sub = df.copy()
    
        # -----------------------------
        # 1️⃣ Extraer dimensiones
        # -----------------------------
        df_sub[["Dim_Menor", "Dim_Mayor"]] = df_sub["Design Section"].apply(self.extraer_dimensiones)
    
        # Cuantía mínima más realista (≈0.25%)
        df_sub['As_Min'] = 0.0025 * df_sub['Dim_Menor'] * (df_sub['Dim_Mayor'] - 0.05) * 1e6
    
        # -----------------------------
        # 2️⃣ Obtener estaciones I-Mid-F
        # -----------------------------
        df_res = self.extraer_valores_station(df_sub)
    
        # Aplicar mínimo sin exagerar
        df_res['As Top'] = np.maximum(df_res['As Top'], df_res['As_Min'])
        df_res['As Bottom'] = np.maximum(df_res['As Bottom'], df_res['As_Min'])
    
        # -----------------------------
        # 3️⃣ Asignar zonas
        # -----------------------------
        df_res["Zone"] = df_res.groupby(["Story", "Label"])["Station"] \
            .transform(lambda x: pd.Series(["I", "Mid", "F"], index=x.sort_values().index))
    
        # ---------------------------------------------------
        # 4️⃣ Calcular barras óptimas (sin sobrerreforzar)
        # ---------------------------------------------------
        resultados_top = df_res.apply(
            lambda row: pd.Series(
                self.calcular_num_barras_optimo(row["As Top"], row["Dim_Menor"])
            ), axis=1
        )
        resultados_top.columns = ["Num_Barras_Top", "Bar_Top_Label", "Bar_Top_Area"]
    
        resultados_bot = df_res.apply(
            lambda row: pd.Series(
                self.calcular_num_barras_optimo(row["As Bottom"], row["Dim_Menor"])
            ), axis=1
        )
        resultados_bot.columns = ["Num_Barras_Bot", "Bar_Bot_Label", "Bar_Bot_Area"]
    
        df_res = pd.concat([df_res, resultados_top, resultados_bot], axis=1)
    
        # usar mayor número de barras entre top y bottom
        df_res["Num_Barras"] = df_res[["Num_Barras_Top","Num_Barras_Bot"]].max(axis=1)
    
        # recalcular área real instalada
        df_res["Bar_Top_Area"] = df_res["Bar_Top_Area"]
        df_res["Bar_Bot_Area"] = df_res["Bar_Bot_Area"]
    
        # ---------------------------------------------------
        # 5️⃣ Organizar formato final
        # ---------------------------------------------------
        df_final = df_res[[
            "Story", "Label", "Zone",
            "Num_Barras", "Bar_Top_Area", "Bar_Bot_Area"
        ]].copy()
    
        df_pivot = df_final.pivot_table(
            index=["Story", "Label"],
            columns="Zone",
            values=["Num_Barras", "Bar_Top_Area", "Bar_Bot_Area"]
        )
    
        df_pivot.columns = [f"{col[0]}_{col[1]}" for col in df_pivot.columns]
        df_ff = df_pivot.reset_index()
    
        df_ff = df_ff[[
            "Story", "Label",
            "Num_Barras_I", "Bar_Top_Area_I", "Bar_Bot_Area_I",
            "Num_Barras_Mid", "Bar_Top_Area_Mid", "Bar_Bot_Area_Mid",
            "Num_Barras_F", "Bar_Top_Area_F", "Bar_Bot_Area_F"
        ]]
    
        return df_ff

    # def process_Rebar_Beams(self, df):
        
    #     df_sub = df.copy()
        
    #     # Extraer dimensiones
    #     df_sub[["Dim_Menor", "Dim_Mayor"]] = df_sub["Design Section"].apply(self.extraer_dimensiones)
    #     df_sub['As_Min'] = 0.0025*df_sub['Dim_Menor']*(df_sub['Dim_Mayor']-0.05)*1e6
        
    #     df_res = self.extraer_valores_station(df_sub)
    #     df_res['As Top'] = df_res[['As Top', 'As_Min']].max(axis=1)
    #     df_res['As Bottom'] = df_res[['As Bottom', 'As_Min']].max(axis=1)
        
    #     # --- Cálculos previos ---
    #     df_res["Zone"] = df_res.groupby(["Story", "Label"])["Station"] \
    #         .transform(lambda x: pd.Series(["I", "Mid", "F"], index=x.sort_values().index))
            
    #     # # Cálculo de barras por cara corta
    #     df_res["Num_Barras"] = df_res["Dim_Menor"].apply(self.calcular_num_barras_top_bottom)
        
    #     # # Cálculo de As por barra y redondeo hacia arriba
    #     df_res["As_Bar_Top"] = df_res["As Top"] / df_res["Num_Barras"]
    #     df_res[["Bar_Top_Label", "Bar_Top_Area"]] = df_res["As_Bar_Top"].apply(
    #         lambda x: pd.Series(self.barra_mas_cercana(x))
    #     )
        
    #     df_res["As_Bar_Bot"] = df_res["As Bottom"] / df_res["Num_Barras"]
    #     df_res[["Bar_Bot_Label", "Bar_Bot_Area"]] = df_res["As_Bar_Bot"].apply(
    #         lambda x: pd.Series(self.barra_mas_cercana(x))
    #     )
        
    #     # --- Organizar y pivotear ---
    #     df_final = df_res[["Story", "Label", "Station", "Zone", "Num_Barras", "Bar_Top_Area", "Bar_Bot_Area"]].copy()
        
    #     df_pivot = df_final.pivot_table(
    #         index=["Story", "Label"],
    #         columns="Zone",
    #         values=["Num_Barras", "Bar_Top_Area", "Bar_Bot_Area"]
    #     )
        
    #     df_pivot.columns = [f"{col[0]}_{col[1]}" for col in df_pivot.columns]
    #     df_ff = df_pivot.reset_index()
    #     df_ff = df_ff[["Story", "Label",
    #             "Num_Barras_I", "Bar_Top_Area_I", "Bar_Bot_Area_I",
    #             "Num_Barras_Mid", "Bar_Top_Area_Mid", "Bar_Bot_Area_Mid",
    #             "Num_Barras_F", "Bar_Top_Area_F", "Bar_Bot_Area_F"]]
        
    #     return df_ff
    
    
    
    @staticmethod
    def calcular_num_barras_optimo(As_req, b):
    
        # Catálogo constructivo recomendado (ordenado)
        barras = [
            ("#3", 71),
            ("#4", 129),
            ("#5", 199),
            ("#6", 284),
            ("#7", 387),
            ("#8", 510),
        ]
    
        for name, area in barras:
    
            n = int(np.ceil(As_req / area))
    
            if n < 2:
                n = 2  # mínimo 2 barras
    
            # separación mínima constructiva
            ancho_mm = b * 1000
            sep = (ancho_mm - 80) / (n - 1) if n > 1 else 999
    
            if sep >= 60:  # mínimo 6 cm separación
                return n, name, area
    
        # Si nada cumple → usar la más grande
        name, area = barras[-1]
        n = int(np.ceil(As_req / area))
        return n, name, area

    # --- Funciones auxiliares ---
    @staticmethod
    def extraer_dimensiones(ds):
        match = re.search(r'_(\d+\.\d+)x(\d+\.\d+)', ds)
        if match:
            menor = float(match.group(1))
            mayor = float(match.group(2))
            return pd.Series([menor, mayor])
        else:
            return pd.Series([None, None])
        
        
    @staticmethod
    def calcular_barras_por_lado(dim, cover=0.05, s_max=0.15):
        L_libre = dim - 2 * cover
        n = int(np.ceil(L_libre / s_max)) + 1
        return max(n, 2)  # mínimo 2 barras por lado

    @staticmethod
    def calcular_num_barras_top_bottom(dim_menor):
        if dim_menor < 0.15:
            return 1
        elif dim_menor < 0.30:
            return 2
        elif dim_menor < 0.55:
            return 3
        elif dim_menor < 0.90:
            return 4
        else:
            return int(np.round(dim_menor / 0.20))


    @staticmethod
    def barra_mas_cercana(as_bar_req, max_bar='#6'):

        bar_catalog = {
            '#10': {'diameter': 32.3, 'area': 819},
            '#8':  {'diameter': 25.4, 'area': 510},
            '#7':  {'diameter': 22.2, 'area': 387},
            '#6':  {'diameter': 19.1, 'area': 284},
            '#5':  {'diameter': 15.9, 'area': 199},
            '#4':  {'diameter': 12.7, 'area': 129},
            '#3':  {'diameter': 9.5,  'area': 71}
        }

        # Ordenar por área
        barras_ordenadas = sorted(bar_catalog.items(),
                                  key=lambda x: x[1]['area'])

        # Limitar tamaño máximo permitido
        max_area = bar_catalog[max_bar]['area']

        for bar_name, props in barras_ordenadas:

            if props['area'] > max_area:
                break

            if props['area'] >= as_bar_req:
                return bar_name, props['area']

        # Si ninguna cumple → devolver barra máxima permitida
        return max_bar, bar_catalog[max_bar]['area']

    # @staticmethod
    # def barra_mas_cercana(as_bar_corner):
        
    #     bar_catalog = {
    #         '#10': {'diameter': 32.3, 'area': 819},
    #         '#8': {'diameter': 25.4, 'area': 510},
    #         '#7': {'diameter': 22.2, 'area': 387},
    #         '#6': {'diameter': 19.1, 'area': 284},
    #         '#5': {'diameter': 15.9, 'area': 199},
    #         '#4': {'diameter': 12.7, 'area': 129},
    #         '#3': {'diameter': 9.5,  'area': 71}
    #     }
        
    #     barras_ordenadas = sorted(bar_catalog.items(), key=lambda x: x[1]['area'])
    #     for bar_name, props in barras_ordenadas:
    #         if props['area'] >= as_bar_corner:
    #             return bar_name, props['area']
    #     return barras_ordenadas[-1][0], barras_ordenadas[-1][1]['area']

    @staticmethod
    def extraer_valores_station(df):
        # Asegúrate de que Station sea numérico
        df['Station'] = pd.to_numeric(df['Station'], errors='coerce')
        
        # Función auxiliar para obtener las 3 filas deseadas por grupo
        def get_three_rows(group):
            group_sorted = group.sort_values('Station').reset_index(drop=True)
            n = len(group_sorted)
            idx_start = 0
            idx_middle = n // 2
            idx_end = n - 1
            return group_sorted.loc[[idx_start, idx_middle, idx_end]]
        
        # Agrupar por columnas clave y aplicar la función
        result_df = df.groupby(['Story', 'Label', 'Design Section'], 
                            group_keys=False, observed=True).apply(get_three_rows)
        
        return result_df




#%% ALMACENAMIENTO DE DATA PRA BASE DE DATOS

class StoreDataBuilder(CsiDataProcessor):

    def run_batch_store(self):

        function_name = f'{self.initial_parameters.get("structure_system").lower()}_store_data_builder'
        args_names = self.function_kwargs.get(function_name, [])
        kwargs = {key: self.processed_data.get(key) for key in args_names}

        try:
            store_data = getattr(self, function_name)(**kwargs)

        except Exception as e:
            raise ValueError(f'Error al generar la data procesada para el sistema {self.initial_parameters.get("structure_system")}')
        
        return store_data
    
    def rcmrf_store_data_builder(self, joints, center_of_mass, materials, slabsTA, beamsTA, columns):
        store_data = {}

        # Almacenar general data
        store_data = self.general_data(store_data, self.initial_parameters, joints, center_of_mass)

        # Almacenar data materiales
        store_data = self.material_definitions(store_data, materials)

        # Almacenar data secciones
        section_columns = columns.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        section_slabs = slabsTA.groupby(['Section']).first().reset_index()
        section_slabs.rename(columns = {'Section':'Design Section', 'slab_tag':'section_tag'}, inplace = True)
        section_beams = beamsTA.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        sections_all = pd.concat([section_columns, section_beams, section_slabs])
        store_data = self.section_definitions(store_data, sections_all)

        # Generación de datos de modelo por pisos y elementos
        store_data['model_data'] = {}
        for story in joints['Story'].unique():
            # Informacion de los nodos ->
            joints_dict = self.joints_informations(joints, story)
            store_data['model_data'][story] = {'joints_data': joints_dict}
            # Informacion de las losas ->
            slabs_dict = self.slabs_information(slabsTA, story, info='No-Consider')
            store_data['model_data'][story]['slabs_data'] = slabs_dict
            # Informacion de las vigas ->
            beams_dict = self.beams_information(beamsTA, story)
            store_data['model_data'][story]['beams_data'] = beams_dict
            # Informacion de las columnas ->
            columns_dict = self.columns_information(columns, story)
            store_data['model_data'][story]['columns_data'] = columns_dict
        
        return store_data

    def dual_store_data_builder(self, joints, center_of_mass, materials, slabs, beams, columns, walls):
        store_data = {}

        # Almacenar general data
        store_data = self.general_data(store_data, self.initial_parameters, joints, center_of_mass)

        # Almacenar data materiales
        store_data = self.material_definitions(store_data, materials)

        # Almacenar data secciones
        section_columns = columns.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        section_slabs = slabs.groupby(['Section']).first().reset_index()
        section_slabs.rename(columns = {'Section':'Design Section', 'slab_tag':'section_tag'}, inplace = True)
        section_beams = beams.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        sections_all = pd.concat([section_columns, section_beams, section_slabs])
        store_data = self.section_definitions(store_data, sections_all)

        # Helpers internos ->
        def mark_is_dintel(df_beams, wall_edges_by_story):
            df = df_beams.copy()
            df['is_dintel'] = False
            for idx, r in df.iterrows():
                st = r['Story']
                edges = wall_edges_by_story.get(st, set())
                e = tuple(sorted((int(r['Joint I']), int(r['Joint J']))))
                if e in edges:
                    df.loc[idx, 'is_dintel'] = True
            return df

        # Identificar losas que tocan muros y partir cargas-> 
        wall_edges = ProcessModelObjects.wall_top_edges_by_story(walls) # Bordes superiores de muros
        slabs_marked = ProcessModelObjects.slabs_touching_walls(slabs, wall_edges) # Losas con flag Touch_wall
        slabs_frame = slabs_marked[~slabs_marked['touch_wall']].copy() # Losas soportadas por porticos
        #slabs_wall  = slabs_marked[ slabs_marked['touch_wall']].copy() # Losas soportadas por muros (debug)

        # Calcular vigas con TA SOLO usando slabs_frame
        _ = self.processor.process_beam_sections_TALoad(slabs_override=slabs_frame, factorLD = 0.9) 
        df_beamsTA_dual = self.processor.df_beamsTA.copy() # TA aplicado a vigas, pero aún NO excluye dinteles

        # Marcar dinteles y mezclar cargas (dintel = carga simple)
        # Marcar is_dintel en ambos DFs (simple y TA)
        df_beams_simple = mark_is_dintel(beams, wall_edges)          # simple = peso propio + LD_frames
        df_beamsTA_dual = mark_is_dintel(df_beamsTA_dual, wall_edges)

        # 5.2 Mezcla robusta por una llave
        #    CAMBIA ESTA LLAVE si tu DF usa otra (p.ej. 'beam_tag' o 'Element')
        key = 'Element Label'
        if key not in df_beams_simple.columns or key not in df_beamsTA_dual.columns:
            key = 'Unique Name'

        # DF base = TA (para las no dintel), pero:
        # - para dinteles se reemplaza Distributed force por la del DF simple
        # - Se cubren las vigas que existan en simple y no estén en TA (por seguridad)
        df_beams_out = df_beamsTA_dual.merge(
            df_beams_simple[[key, 'Distributed force', 'is_dintel']].rename(columns={'Distributed force': 'DF_simple'}),
            on=key,
            how='outer',
            suffixes=('', '_from_simple')
        )

        # Si una viga solo venía del DF simple y no estaba en TA, su Distributed force quedará NaN:
        # en ese caso tomamos DF_simple
        if 'Distributed force' in df_beams_out.columns:
            df_beams_out['Distributed force'] = df_beams_out['Distributed force'].fillna(df_beams_out['DF_simple'])
        else:
            pass

        # Reemplazo SOLO para dinteles
        mask_dintel = df_beams_out['is_dintel'] == True
        df_beams_out.loc[mask_dintel, 'Distributed force'] = df_beams_out.loc[mask_dintel, 'DF_simple']

        # Limpieza auxiliar
        df_beams_out.drop(columns=[c for c in ['DF_simple'] if c in df_beams_out.columns], inplace=True)

        # Generación de datos de modelo por pisos y elementos
        store_data['model_data'] = {}
        for story in joints['Story'].unique():
            # Informacion de los nodos ->
            joints_dict = self.joints_informations(joints, story)
            store_data['model_data'][story] = {'joints_data': joints_dict}
            # Informacion de las losas -> slabs_information debe poner consider = touch_wall SOLO si info=='DUAL'
            slabs_dict = self.slabs_information(slabs_marked, story, info='DUAL')
            store_data['model_data'][story]['slabs_data'] = slabs_dict
            # Informacion de las vigas -> Usando DF final ya mezclado (dintel simple + normal TA)
            beams_dict = self.beams_information(df_beams_out, story)
            store_data['model_data'][story]['beams_data'] = beams_dict
            # Informacion de las columnas ->
            columns_dict = self.columns_information(columns, story)
            store_data['model_data'][story]['columns_data'] = columns_dict
            # Informacion de los muros ->
            walls_dict = self.wall_information(walls, story)
            store_data['model_data'][story]['walls_data'] = walls_dict
        
        return store_data

    def wrcf_store_data_builder(self, joints, center_of_mass, materials, slabs, beams, walls):
        store_data = {}

        # Almacenar general data
        store_data = self.general_data(store_data, self.initial_parameters, joints, center_of_mass)

        # Almacenar data materiales
        store_data = self.material_definitions(store_data, materials)

        # Almacenar data secciones
        section_slabs = slabs.groupby(['Section']).first().reset_index()
        section_slabs.rename(columns = {'Section':'Design Section', 'slab_tag':'section_tag'}, inplace = True)
        section_beams = beams.groupby(['Design Section', 'rebar_data_str']).first().reset_index()
        sections_all = pd.concat([section_slabs, section_beams])
        store_data = self.section_definitions(store_data, sections_all)

        # Generación de datos de modelo por pisos y elementos
        store_data['model_data'] = {}
        for story in joints['Story'].unique():
            # Informacion de los nodos ->
            joints_dict = self.joints_informations(joints, story)
            store_data['model_data'][story] = {'joints_data': joints_dict}
            # Informacion de las losas ->
            slabs_dict = self.slabs_information(slabs, story)
            store_data['model_data'][story]['slabs_data'] = slabs_dict
            # Informacion de las vigas ->
            beams_dict = self.beams_information(beams, story)
            store_data['model_data'][story]['beams_data'] = beams_dict
            # Informacion de los muros ->
            walls_dict = self.wall_information(walls, story)
            store_data['model_data'][story]['walls_data'] = walls_dict
        
        return store_data

    @staticmethod
    def general_data(store_data, initial_parameters, joints, center_of_mass):

        # Información general fija --> 
        store_data['general_data'] = initial_parameters
        store_data['general_data']['number_stories'] = len(joints['Story'].unique()) - 1
        store_data['center_of_mass_information'] = center_of_mass

        return store_data

    @staticmethod
    def material_definitions(store_data, materials):

        # Definicion de materiales -->
        store_data['definitions'] = {}
        store_data['definitions']['material_definitions'] = {
            'concrete_materials': {},
            'steel_materials': {
                'fy': 420000,
                'E': 200000000,
                'steel_tag': int(len(materials) * 2 + 1),
                'wwm_tag': int(len(materials) * 2 + 2)
            }
        }
        
        for idx, row in materials.reset_index().iterrows():
            key = row['Material'].lower().replace(' ', '_')
            store_data['definitions']['material_definitions']['concrete_materials'][key] = {
                'fc': row['Fc'],
                'E': row['E'],
                'G': row['G'],
                'energy_dissipation': store_data['general_data']['energy_dissipation'],
                'confined_tag': row['confined_tag'],
                'unconfined_tag': row['unconfined_tag']
            }
        
        return store_data

    @staticmethod
    def section_definitions(store_data, sections_all):

        # Definición de secciones -->
        store_data['definitions']['section_definitions'] = {}
        
        for _, row in sections_all.iterrows():
            material_key = row['Material'].lower().replace(' ', '_')
            section_tag = int(row['section_tag'])
            
            if row['Design Type'] == 'Column' or row['Design Type'] == 'Beam':
                
                section_type = row['Section Type'].lower().replace(' ', '_')
                rebar_data = row['rebar_data']
                
                # # Checkear rebar data
                # if row['Design Type'] == 'Beam':
                #     if row['rebar_data']['number_bars_top'] < 2:
                #         row['rebar_data']['number_bars_top'] = 2
                #     if row['rebar_data']['number_bars_bottom'] < 2:
                #         row['rebar_data']['number_bars_bottom'] = 2
                        
                # if row['Design Type'] == 'Column' and row['rebar_data'].get('number_bars_circumference', None) is None:
                #     if row['rebar_data']['number_bars_axis3'] < 2:
                #         row['rebar_data']['number_bars_axis3'] = 2
                #     if row['rebar_data']['number_bars_axis2'] < 2:
                #         row['rebar_data']['number_bars_axis2'] = 2
                

                geometry = {
                    'area': row['Area'],
                    'inertia_localaxis3': row['I33'],
                    'inertia_localaxis2': row['I22'],
                    'polar_torsion': row['J'],
                }
                if section_type == 'concrete_rectangular':
                    geometry['base'] = row['t2']
                    geometry['height'] = row['t3']
                elif section_type == 'concrete_circle':
                    geometry['diameter'] = row['t3']
                    
                section_results = {
                    
                    'design_section': row['Design Section'],
                    'design_type': row['Design Type'].lower(),
                    'section_type': section_type,
                    'section_tag': int(section_tag),
                    'rebar_data': rebar_data,
                    'material': {
                        'material': material_key,
                        'fc': row['Fc'],
                        'G': row['G'],
                        'confined_tag': store_data['definitions']['material_definitions']['concrete_materials'][material_key]['confined_tag'],
                        'unconfined_tag': store_data['definitions']['material_definitions']['concrete_materials'][material_key]['unconfined_tag'],
                        'steel_tag': store_data['definitions']['material_definitions']['steel_materials']['steel_tag']
                    },
                    'geometry': geometry
                }
                
            else:
                section_results = {
                    
                    'design_section': row['Design Section'],
                    'design_type': 'slab',
                    'section_tag': int(section_tag),
                    'slab_thickness': row['Slab Thickness'],
                    'material': {
                        'material': material_key,
                        'fc': row['Fc']
                    }
                }

            store_data['definitions']['section_definitions'][str(section_tag)] = section_results
        
        return store_data
    
    @staticmethod
    def joints_informations(joints, story):

        joints_story = joints[joints['Story'] == story]
        joints_dict = {}
        for _, row in joints_story.iterrows():
            joints_dict[str(row['Element Label'])] = {
                'object_label': row['Object Label'],
                'global_x': row['Global X'],
                'global_y': row['Global Y'],
                'global_z': row['Global Z'],
                'constraint_values': row['contraint_values']
            }
        return joints_dict
    
    @staticmethod
    def slabs_information(slabs, story, info=None):

        slabs_story = slabs[slabs["Story"] == story].copy()
        slabs_story['element_label'] = slabs_story['Element Label'].astype(str)
        slabs_story['section_type'] = [string.lower().replace(' ', '_') for string in slabs_story['Section'].to_list()]
        
        slabs_dict = {}
        for _, row in slabs_story.iterrows():
            material_key = row['Material'].lower().replace(' ', '_')
            element_key = str(int(float(row['element_label'])*-1))

            if info == 'DUAL':
                consider = bool(row.get('touch_wall', False))
            else:
                # Comportamiento actual para RCMRF/WRCF
                consider = True if info is None else False
            
            slabs_dict[element_key] = {
                'object_label': row['Area Label'],
                'joint_1': row['Joint 1'],
                'joint_2': row['Joint 2'],
                'joint_3': row['Joint 3'],
                'joint_4': row['Joint 4'],
                'design_section': row['Section'],
                'section_tag': row['slab_tag'],
                'material_properties': {
                    'concrete_properties': {
                        'material': material_key,
                        'fc': row['Fc']
                        }
                    },
                'loads': {
                    'consider': consider,
                    'q_dead': float(row.get('Q_dead', 0.0)),
                    'q_live': float(row.get('Q_live', 0.0)),
                },
                'slab_thickness': row['Slab Thickness'],
                }
        
        return slabs_dict
    
    @staticmethod
    def beams_information(beams, story):

        beams_story = beams[beams["Story"] == story].copy() 
        beams_story['element_label'] = beams_story['Element Label'].astype(str)
        beams_story['section_type'] = [string.lower().replace(' ', '_') for string in beams_story['Section Type'].to_list()]
        
        beams_dict = {}
        for _, row in beams_story.iterrows():
            
            material_key = row['Material'].lower().replace(' ', '_')
            element_key = str(row['element_label']).split('.')
            element_key = element_key[0]
            section_type = row['section_type']
            
            # # Checkear rebar data
            # if row['rebar_data']['number_bars_top'] < 2:
            #     row['rebar_data']['number_bars_top'] = 2
            # if row['rebar_data']['number_bars_bottom'] < 2:
            #     row['rebar_data']['number_bars_bottom'] = 2
            
            geometry = {
                'area': row['Area'],
                'inertia_localaxis3': row['I33'],
                'inertia_localaxis2': row['I22'],
                'polar_torsion': row['J'],
            }
            if section_type == 'concrete_rectangular':
                geometry['base'] = row['t2']
                geometry['height'] = row['t3']
            
            beams_dict[element_key] = {
                'object_label': row['Object Label'],
                'joint_i': row['Joint I'],
                'joint_j': row['Joint J'],
                'section_type': section_type,
                'design_section': row['Design Section'],
                'section_tag': row['section_tag'],
                'lenght': row['lenght'],
                'material_properties': {
                    'concrete_properties': {
                        'material': material_key,
                        'confined_tag' : row['confined_tag'],
                        'unconfined_tag' : row['unconfined_tag'],
                        'fc': row['Fc'],
                        'poisson_coeficient': row['G']
                        },
                    'steel_properties':{
                        'steel_tag': row['steel_tag'],
                        'fy': 420000,
                        'Es': 200000000,
                        }
                    },
                'geometry': geometry,
                'rebar_data': row['rebar_data'],
                'distributed_force': row['Distributed force'],
                'geometry_transformation_vector': row['geometry_transformation_vector'],
                }
        return beams_dict
        
    @staticmethod
    def columns_information(columns, story):

        columns_story = columns[columns["Story"] == story].copy() 
        columns_story['element_label'] = columns_story['Element Label'].astype(str)
        columns_story['section_type'] = [string.lower().replace(' ', '_') for string in columns_story['Section Type'].to_list()]
        
        columns_dict = {}
        for _, row in columns_story.iterrows():
            material_key = row['Material'].lower().replace(' ', '_')
            element_key = str(row['element_label']).split('.')
            element_key = element_key[0]
            section_type = row['section_type']
            
            # Chequear rebar data
            if row['rebar_data'].get('number_bars_axis3', None) is not None:
                if row['rebar_data']['number_bars_axis3'] < 2:
                    row['rebar_data']['number_bars_axis3'] = 2
                if row['rebar_data']['number_bars_axis2'] < 2:
                    row['rebar_data']['number_bars_axis2'] = 2
            
            geometry = {
                'area': row['Area'],
                'inertia_localaxis3': row['I33'],
                'inertia_localaxis2': row['I22'],
                'polar_torsion': row['J'],
            }
            if section_type == 'concrete_rectangular':
                geometry['base'] = row['t2']
                geometry['height'] = row['t3']
            elif section_type == 'concrete_circle':
                geometry['diameter'] = row['t3']
            
            columns_dict[element_key] = {
                'object_label': row['Object Label'],
                'joint_i': row['Joint I'],
                'joint_j': row['Joint J'],
                'section_type': section_type,
                'design_section': row['Design Section'],
                'section_tag': row['section_tag'],
                'lenght': row['lenght'],
                'material_properties': {
                    'concrete_properties': {
                        'material': material_key,
                        'confined_tag' : row['confined_tag'],
                        'unconfined_tag' : row['unconfined_tag'],
                        'fc': row['Fc'],
                        'poisson_coeficient': row['G']
                        },
                    'steel_properties':{
                        'steel_tag': row['steel_tag'],
                        'fy': 420000,
                        'Es': 200000000,
                        }
                    },
                'geometry': geometry,
                'rebar_data': row['rebar_data'],
                'demand': {
                    'puntual_force': row['puntual_force'],
                    'load_node': row['max_node'],
                    },
                'geometry_transformation_vector': row['geometry_transformation_vector'],
                'offsets_vectors':{
                    'offset_i': row['offset_i'],
                    'offset_j': row['offset_j']
                    }
                }
        return columns_dict

    @staticmethod
    def wall_information(walls, story):

        def _to_list_safe(v):
            if v is None:
                return []
            # Si es NaN escalar
            try:
                if isinstance(v, float) and math.isnan(v):
                    return []
            except Exception:
                pass
            # Si es string que parece lista
            if isinstance(v, str):
                s = v.strip()
                if s.startswith('[') and s.endswith(']'):
                    try:
                        parsed = ast.literal_eval(s)
                        return list(parsed) if isinstance(parsed, (list, tuple, np.ndarray)) else [parsed]
                    except Exception:
                        return []
                # si no es lista, tratar como escalar no vacío
                return [] if s == '' else [s]
            # ndarray / tuple / list
            if isinstance(v, np.ndarray):
                return v.tolist()
            if isinstance(v, (list, tuple)):
                return list(v)
            if isinstance(v, pd.Series):
                return v.tolist()
            return [v]

        walls_story = walls[walls["Story"] == story].copy()
        walls_story['element_label'] = walls_story['Element Label'].astype(str)
        walls_story['design_section'] = [
            str(s).lower().replace(' ', '_') for s in walls_story['Section'].to_list()
        ]

        walls_dict = {}
        for _, row in walls_story.iterrows():
            # Material 
            material_val = row.get('Material', '')
            material_key = str(material_val).lower().replace(' ', '_')

            # Element key 
            raw_label = str(row['element_label'])
            element_key = raw_label.split('.', 1)[0]

            design_section = row['design_section']

            # Nodes Orientation
            nodes = row.get('Nodes Orientation', None)
            if not nodes or len(nodes) != 4:
                continue

            # Listas de fibras 
            ancho     = _to_list_safe(row.get('Ancho', []))
            num_macro = _to_list_safe(row.get('Num_Macro', []))
            conc      = _to_list_safe(row.get('Concreto', []))
            acero     = _to_list_safe(row.get('Acero', []))
            cuantia   = _to_list_safe(row.get('Cuantia', []))
            espesor   = _to_list_safe(row.get('Espesor', []))

            # Alinear longitudes 
            n = min(len(ancho), len(num_macro), len(conc), len(acero), len(cuantia)) if len(ancho) else 0
            if n == 0:
                thickness_fibers = []
                width_fibers     = []
                number_fibers    = []
                concrete_fibers  = []
                steel_fibers     = []
                cuantia_fibers   = []
            else:
                ancho     = ancho[:n]
                num_macro = num_macro[:n]
                conc      = conc[:n]
                acero     = acero[:n]
                cuantia   = cuantia[:n]
                thickness_fibers = espesor
                width_fibers     = ancho
                number_fibers    = num_macro
                concrete_fibers  = conc
                steel_fibers     = acero
                cuantia_fibers   = cuantia

            walls_dict[element_key] = {
                'object_label': row['Area Label'],
                'pier_label': row['Pier'],
                'joint_1': nodes[0],
                'joint_2': nodes[1],
                'joint_3': nodes[2],
                'joint_4': nodes[3],
                'design_section': design_section,
                'shear_tag': row['shear_tag'],
                'thickness': row['Thickness'],
                'total_lenght': row['Nodes Lenght'],
                'demand':{
                    'pf_joint3': {'node': nodes[2], 'force': row['puntual_load_force']},
                    'pf_joint4': {'node': nodes[3], 'force': row['puntual_load_force']},
                },
                'material_properties': {
                    'concrete_properties': {
                        'material': material_key,
                        'confined_tag': row['confined_tag_x'],
                        'unconfined_tag': row['unconfined_tag_x'],
                        'fc': row['Fc'],
                        'poisson_coeficient': row['G'],
                    },
                    'steel_properties': {
                        'steel_tag': row['steel_tag_x'],
                        'wwm_tag': row['wwm_tag_x'],
                        'fy': 420000,
                        'Es': 200000000,
                    }
                },
                'wall_fibers': {
                    'thickness_fibers': thickness_fibers,
                    'width_fibers': width_fibers,
                    'number_fibers': number_fibers,
                    'concrete_fibers': concrete_fibers,
                    'steel_fibers': steel_fibers,
                    'cuantia_fibers': cuantia_fibers,
                }
            }

        return walls_dict

#%% GENERADOR DE MODELO

class OPSModelBuilder:

    def __init__(self, store_data:dict, linear_model=False, modal_analysis=False, load_names = {'dead': 'SD', 'live': 'Livex'}):
        self.store_data = store_data
        self.linear_model = linear_model
        self.modal_analysis = modal_analysis
        self.load_names = load_names

    def builder(self, root_path):
        tqdm.write(f" Initializing OpenSees Model for : {self.store_data['general_data']['structure_system']} system - {'linear model' if self.linear_model else 'non-linear model'}") 
        self.initialize_model()
        self.build_nodes()
        self.define_materials()
        self.define_sections()
        self.build_elements()
        # self.apply_loads()
        self.assign_com_masses()
        
        # Generar carpeta guardar resultados
        if not os.path.exists(os.path.join(root_path, 'outputs')):
            os.makedirs(os.path.join(root_path, 'outputs'))
        
        if self.modal_analysis:
            self._modal_analysis(os.path.join(root_path, 'outputs'))
        else:
            self.store_data['output_data'] = {} # Crear diccionario de todas formas (vacio)
    
    def _modal_analysis(self, output_path):
        ops.eigen(min(len(self.store_data['model_data'])-1, 10))
        ops.modalProperties('-print', '-file', os.path.join(output_path,'modal_report.txt'), '-unorm')
        dict_modal = ops.modalProperties('-return')
        
        participationMassRatios = []
        for mx, my, mz, rmx, rmy, rmz in zip(dict_modal['partiMassRatiosMX'], dict_modal['partiMassRatiosMY'],
                                             dict_modal['partiMassRatiosMZ'], dict_modal['partiMassRatiosRMX'],
                                             dict_modal['partiMassRatiosRMY'],dict_modal['partiMassRatiosRMZ']):
            
            participationMassRatios.append([mx, my, mz, rmx, rmy, rmz])
        
        self.store_data['output_data'] = {
            'modal_analysis': {
                'total_masses': {
                    mass: val for (mass, val) in zip(['mx', 'my', 'mz', 'rmx', 'rmy', 'rmz'], dict_modal['totalMass'])
                    },
                'center_of_mass': {
                    mass: val for (mass, val) in zip(['x', 'y', 'z'], dict_modal['centerOfMass'])
                    },
                'modes': {
                        f'mode{k}': {
                            'period': dict_modal['eigenPeriod'][k],
                            'participation_mass_ratios': {
                                mass: val
                                for (mass, val) in zip(['mx', 'my', 'mz', 'rmx', 'rmy', 'rmz'], participationMassRatios[k])
                            }
                        }
                        for k in range(int(dict_modal['domainSize'][0]))
                    }
                }
            }
                
    def initialize_model(self):
        ops.wipe()
        ops.model('basic', '-ndm', 3, '-ndf', 6)
     
    def build_nodes(self):
        for _, story_data in self.store_data['model_data'].items():
            joints = story_data.get('joints_data', {})
            for node_id, node_data in joints.items():
                node_id_int = int(node_id)
                x, y, z = node_data['global_x'], node_data['global_y'], node_data['global_z']
                ops.node(node_id_int, x, y, z)
                if isinstance(node_data['constraint_values'], list):
                    ops.fix(node_id_int, *node_data['constraint_values'])

    def define_materials(self):
        material_defs = self.store_data.get('definitions').get('material_definitions', {})
        concrete_materials = material_defs['concrete_materials']
        steel_tag = material_defs['steel_materials']['steel_tag']
        wwm_tag = material_defs['steel_materials']['wwm_tag']
        
        # Crear el material para M.E. 
        Fy_malla = 450.0      # MPa
        Es      = 210000.0    # MPa
        b_malla = 0.03
        
        ops.uniaxialMaterial('Steel01', int(wwm_tag)+1, Fy_malla, Es, b_malla)
        ops.uniaxialMaterial('MinMax', int(wwm_tag), int(wwm_tag)+1, '-min', -0.008, '-max', 0.025)
        
        index = 0
        for material, concrete_data in concrete_materials.items():
            _, _, _, = optools_ut.col_materials(
                fcn = concrete_data['fc'],
                detailing = concrete_data['energy_dissipation'], 
                steeltag = steel_tag + index,
                unctag = concrete_data['unconfined_tag'], 
                conftag = concrete_data['confined_tag'],
                )
            index += 1000000

    # def define_sections(self):
        
    #     confined_elements = self.store_data.get('general_data')['confined_elements']
        
    #     for section_id, section in self.store_data.get('definitions')['section_definitions'].items():
    #         ID = int(section_id)
    #         material = section['material']
    #         if section['design_type'] == 'slab':       
    #             # fc = material['fc'] / 1000.0              # MPa
    #             # E = 4700 * math.sqrt(fc) * 1000.0         # kN/m² (como ya lo hacías)
    #             # nu = 0.2
    #             # mat_tag = 1000 + ID                        # por ejemplo

    #             # ops.nDMaterial('ElasticIsotropic', mat_tag, E, nu)

    #             # # 2) Sección tipo LayeredShell (por ejemplo 4 capas iguales)
    #             # t_total = section['slab_thickness']       # eL, en m
    #             # n_layers = 4
    #             # t_layer = t_total / n_layers

    #             # sec_tag = int(ID)
    #             # ops.section('LayeredShell', sec_tag,
    #             #             n_layers,
    #             #             mat_tag, t_layer,
    #             #             mat_tag, t_layer,
    #             #             mat_tag, t_layer,
    #             #             mat_tag, t_layer)
          
    #             fc = material['fc']
    #             Eslab = 4700 * math.sqrt(fc) * 1000
    #             ops.section('ElasticMembranePlateSection', int(ID), self.store_data['general_data']['shell_craking'] * Eslab, 0.3, section['slab_thickness'], 0.0)

    #         else: # Beams and columns
    #             geometry = section['geometry']
    #             rebar_data = section['rebar_data']
                
                
    #             if self.linear_model:
    #                 fc = material['fc']
    #                 E = 4700 * math.sqrt(fc) * 1000
    #                 ops.section('Elastic', int(ID), E, geometry['area'], 
    #                             geometry['inertia_localaxis3'], geometry['inertia_localaxis2'],
    #                             material['G'], geometry['polar_torsion'])
                                
    #             else:
                    
    #                 confined_tag = material.get('confined_tag')
    #                 if confined_elements == 'No':
    #                     confined_tag = material.get('unconfined_tag')
                    
    #                 if section['design_type'] == 'beam':
                        
    #                     _= self.BuildRCSection(int(ID), geometry.get('height'), geometry.get('base'), 
    #                                    rebar_data.get('cover'), rebar_data.get('cover'), confined_tag, 
    #                                    material.get('unconfined_tag'), material.get('steel_tag'), int(rebar_data.get('number_bars_top')),
    #                                    rebar_data.get('bar_area_top'), int(rebar_data.get('number_bars_bottom')), rebar_data.get('bar_area_bottom'), 
    #                                    2, 1e-14, 12, 12, 8, 8)

    #                 elif section['design_type'] == 'column':
                        
    #                     if section['section_type'] == 'concrete_rectangular':
                            
    #                         _= self.BuildRCSection(int(ID), geometry.get('height'), geometry.get('base'), 
    #                                        rebar_data.get('cover'), rebar_data.get('cover'), confined_tag, 
    #                                        material.get('unconfined_tag'), material.get('steel_tag'), int(rebar_data.get('number_bars_axis2')),
    #                                        rebar_data.get('bar_area_axis2'), int(rebar_data.get('number_bars_axis2')), rebar_data.get('bar_area_axis2'), 
    #                                        int(2*(rebar_data.get('number_bars_axis3')-2)), rebar_data.get('bar_area_axis3'),
    #                                        12, 12, 8, 8)
                            
                    
    #                     elif section['section_type'] == 'concrete_circle':
                        
    #                         _= self.BuildRCSectionCircular(int(ID), geometry.get('diameter'), rebar_data.get('cover'), 
    #                                                0.0095, confined_tag, material.get('unconfined_tag'), 
    #                                                material.get('steel_tag'), int(rebar_data.get('number_bars_circumference')), 
    #                                                rebar_data.get('bar_area_circumference'), 8, 5, 8, 2)
    #                     pass
                
    #             ops.beamIntegration('Lobatto', ID, ID, self.store_data['general_data']['integration_points'])

    def define_sections(self):
        for section_id, section in self.store_data.get('definitions')['section_definitions'].items():
            ID = int(section_id)
            material = section['material']
            
            if section['design_type'] == 'slab':
                fc = material['fc']
                Eslab = 4700 * math.sqrt(fc) * 1000
                ops.section('ElasticMembranePlateSection', int(ID), self.store_data['general_data']['shell_craking'] * Eslab, 0.3, section['slab_thickness'], 0.0)
            
            else: # Beams and columns
                geometry = section['geometry']
                rebar_data = section['rebar_data']
                
                if self.linear_model:
                        
                    fc = material['fc']
                    E = 4700 * math.sqrt(fc) * 1000
                    area_m2 = geometry['area']/1e4
                    I2_m4 = geometry['inertia_localaxis2'] / 1e8
                    I3_m4 = geometry['inertia_localaxis3'] / 1e8
                    J_m4  = geometry['polar_torsion'] / 1e8
                    ops.section('Elastic', int(ID), E, area_m2, 
                                I3_m4, I2_m4,
                                material['G'], J_m4)
                    
                    ops.beamIntegration('Lobatto', ID, ID, self.store_data['general_data']['integration_points'])
                    
                else:
                    # Genereación de Sección no Lineal
                    # ---------------------------------------------------------------------------------------------------
                    if self.store_data['general_data']['rebar_type'] == 'Ingresado':
                        # ------------ GENERAR SECCIÓN ESTANDAR CON REFUERZO INCLUIDO ------------------
                        if section['design_type'] == 'beam':
                            _= self.BuildRCSection(int(ID), geometry.get('height'), geometry.get('base'), 
                                           rebar_data.get('cover'), rebar_data.get('cover'), material.get('confined_tag'), 
                                           material.get('unconfined_tag'), material.get('steel_tag'), int(rebar_data.get('number_bars_top')),
                                           rebar_data.get('bar_area_top'), int(rebar_data.get('number_bars_bottom')), rebar_data.get('bar_area_bottom'), 
                                           2, 1e-14, 
                                           12, 12, 8, 8)
                        
                        elif section['design_type'] == 'column':
                            if section['section_type'] == 'concrete_rectangular':
                                _= self.BuildRCSection(int(ID), geometry.get('height'), geometry.get('base'), 
                                               rebar_data.get('cover'), rebar_data.get('cover'), material.get('confined_tag'), 
                                               material.get('unconfined_tag'), material.get('steel_tag'), int(rebar_data.get('number_bars_axis2')),
                                               rebar_data.get('bar_area_axis2'), int(rebar_data.get('number_bars_axis2')), rebar_data.get('bar_area_axis2'), 
                                               int(2*(rebar_data.get('number_bars_axis3')-2)), rebar_data.get('bar_area_axis3'),
                                               12, 12, 8, 8)
                            
                            elif section['section_type'] == 'concrete_circle':
                                _= self.BuildRCSectionCircular(int(ID), geometry.get('diameter'), rebar_data.get('cover'), 
                                                       0.0095, material.get('confined_tag'), material.get('unconfined_tag'), 
                                                       material.get('steel_tag'), int(rebar_data.get('number_bars_circumference')), 
                                                       rebar_data.get('bar_area_circumference'), 8, 5, 8, 2)
                                
                        
                        ops.beamIntegration('Lobatto', ID, ID, self.store_data['general_data']['integration_points'])
                    
                    else:
                        sec_I = ID*1000 + 1
                        sec_Mid = ID*1000 + 2
                        sec_F = ID*1000 + 3
                        
                        if section['design_type'] == 'beam':
                            # Zone Left
                            _ = self.BuildRCSection(int(sec_I), geometry.get('height'), geometry.get('base'),
                                                    0.04, 0.04,
                                                    material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                    int(rebar_data.get('number_bars_initial')), rebar_data.get('bar_area_top_initial'),
                                                    int(rebar_data.get('number_bars_initial')), rebar_data.get('bar_area_bottom_initial'),
                                                    2, 1e-14,
                                                    12, 12, 8, 8)
                            
                            # Zone Mid
                            _ = self.BuildRCSection(int(sec_Mid), geometry.get('height'), geometry.get('base'),
                                                    0.04, 0.04,
                                                    material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                    int(rebar_data.get('number_bars_middle')), rebar_data.get('bar_area_top_middle'),
                                                    int(rebar_data.get('number_bars_middle')), rebar_data.get('bar_area_bottom_middle'),
                                                    2, 1e-14,
                                                    12, 12, 8, 8)
                        
                            # Zone Right
                            _ = self.BuildRCSection(int(sec_F), geometry.get('height'), geometry.get('base'),
                                                    0.04, 0.04,
                                                    material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                    int(rebar_data.get('number_bars_final')), rebar_data.get('bar_area_top_final'),
                                                    int(rebar_data.get('number_bars_final')), rebar_data.get('bar_area_bottom_final'),
                                                    2, 1e-14,
                                                    12, 12, 8, 8)
                            
                        elif section['design_type'] == 'column':
                            if section['section_type'] == 'concrete_rectangular':
                                                        # Zone Left
                                _ = self.BuildRCSection(int(sec_I), geometry.get('height'), geometry.get('base'),
                                                        0.04, 0.04,
                                                        material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                        int(rebar_data.get('number_bars_tb_initial')), rebar_data.get('bar_area_tb_initial'),
                                                        int(rebar_data.get('number_bars_tb_initial')), rebar_data.get('bar_area_tb_initial'),
                                                        int(rebar_data.get('number_bars_mid_initial')*2), rebar_data.get('bar_area_mid_initial'),
                                                        12, 12, 8, 8)
                                
                                # Zone Mid
                                _ = self.BuildRCSection(int(sec_Mid), geometry.get('height'), geometry.get('base'),
                                                        0.04, 0.04,
                                                        material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                        int(rebar_data.get('number_bars_tb_middle')), rebar_data.get('bar_area_tb_middle'),
                                                        int(rebar_data.get('number_bars_tb_middle')), rebar_data.get('bar_area_tb_middle'),
                                                        int(rebar_data.get('number_bars_mid_middle')*2), rebar_data.get('bar_area_mid_middle'),
                                                        12, 12, 8, 8)
                                
                                # Zone Right
                                _ = self.BuildRCSection(int(sec_F), geometry.get('height'), geometry.get('base'),
                                                        0.04, 0.04,
                                                        material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                        int(rebar_data.get('number_bars_tb_final')), rebar_data.get('bar_area_tb_final'),
                                                        int(rebar_data.get('number_bars_tb_final')), rebar_data.get('bar_area_tb_final'),
                                                        int(rebar_data.get('number_bars_mid_final')*2), rebar_data.get('bar_area_mid_final'),
                                                        12, 12, 8, 8)
                        
                            elif section['section_type'] == 'concrete_circle':
                                # Zone Left
                                _= self.BuildRCSectionCircular(int(sec_I), geometry.get('diameter'), rebar_data.get('cover'), 
                                                       0.0095, 
                                                       material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                       int(rebar_data.get('number_bars_tb_initial')), rebar_data.get('bar_area_tb_initial'), 
                                                       8, 5, 8, 2)
                                # Zone Mid
                                _= self.BuildRCSectionCircular(int(sec_Mid), geometry.get('diameter'), rebar_data.get('cover'), 
                                                       0.0095, 
                                                       material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                       int(rebar_data.get('number_bars_tb_middle')), rebar_data.get('bar_area_tb_middle'), 
                                                       8, 5, 8, 2)
                                # Zone Right
                                _= self.BuildRCSectionCircular(int(sec_F), geometry.get('diameter'), rebar_data.get('cover'), 
                                                       0.0095, 
                                                       material.get('confined_tag'), material.get('unconfined_tag'), material.get('steel_tag'), 
                                                       int(rebar_data.get('number_bars_tb_final')), rebar_data.get('bar_area_tb_final'), 
                                                       8, 5, 8, 2)
                                
                        # pass
                        weights = [0.05,0.272222222,0.355555556,0.272222222,0.05]
                        locations = [0.0, 0.172673, 0.50, 0.827326, 1.0]
                        sections = [sec_I, sec_I, sec_Mid, sec_F, sec_F]
                        
                        ops.beamIntegration('UserDefined', ID, len(sections), *sections, *locations, *weights)


    @staticmethod
    def BuildRCSection(ID, HSec, BSec, coverH, coverB,
                       coreID, coverID, steelID,
                       numBarsTop, barAreaTop,
                       numBarsBot, barAreaBot,
                       numBarsIntTot, barAreaInt,
                       nfCoreY, nfCoreZ, nfCoverY, nfCoverZ):
        
        coverY = HSec/2.0
        coverZ = BSec/2.0
        coreY = coverY - coverH
        coreZ = coverZ - coverB
        # numBarsInt = int(numBarsIntTot/2)
        numBarsInt = max(0, int(round(numBarsIntTot/2)))
        GJ = 1e6
    
        target = 0.025   # tamaño fibra ≈ 2.5 cm

        # nfCoreY = max(8,  int((coreY*2)/target))
        # nfCoreZ = max(8,  int((coreZ*2)/target))
        
        nfCoreY = min(20, max(6, int((coreY*2)/target)))
        nfCoreZ = min(20, max(6, int((coreZ*2)/target)))
        
        nfCoverY = max(4, int(nfCoreY/2))
        nfCoverZ = max(4, int(nfCoreZ/2))
        
        ops.section('Fiber', ID, '-GJ', GJ)
        
        sM  = [['patch', 'quad', coreID,nfCoreZ,nfCoreY,-coreY,coreZ,-coreY,-coreZ,coreY,-coreZ,coreY,coreZ],
               ['patch', 'quad', coverID,2,nfCoverY,-coverY,coverZ,-coreY,coreZ,coreY,coreZ,coverY,coverZ],
               ['patch', 'quad', coverID,2,nfCoverY,-coreY,-coreZ,-coverY,-coverZ,coverY,-coverZ,coreY,-coreZ], 
               ['patch', 'quad', coverID,nfCoverZ,2,-coverY,coverZ,-coverY,-coverZ,-coreY,-coreZ,-coreY,coreZ],
               ['patch', 'quad', coverID,nfCoverZ,2,coreY,coreZ,coreY,-coreZ,coverY,-coverZ,coverY,coverZ]]
        
        if numBarsInt > 0:
            nespacios = numBarsInt + 1
            a = HSec - 2*coverH
            b = a/nespacios
            sM.append(['layer','straight',steelID,numBarsInt,barAreaInt,-coreY+b,coreZ,coreY-b,coreZ]) # este
            sM.append(['layer','straight',steelID,numBarsInt,barAreaInt,-coreY+b,-coreZ,coreY-b,-coreZ]) # y este
        
        sM += [
            ['layer', 'straight', steelID,numBarsTop,barAreaTop,coreY,coreZ,coreY,-coreZ],
            ['layer', 'straight', steelID,numBarsBot,barAreaBot,-coreY,coreZ,-coreY,-coreZ],
        ]
        
           
        for item in sM:
            if item[0] == 'patch':
                _, patch_type, *params = item
                ops.patch(patch_type, *params) 
            if item[0] == 'layer':
                _, layer_type, *params = item
                ops.layer(layer_type, *params) 
        
        return sM


    # @staticmethod
    # def BuildRCSection(ID,HSec,BSec,coverH,coverB,coreID,coverID,
    #                    steelID,numBarsTop,barAreaTop,numBarsBot,
    #                    barAreaBot,numBarsIntTot,barAreaInt,nfCoreY,
    #                    nfCoreZ,nfCoverY,nfCoverZ):
        
    #     coverY = HSec/2.0
    #     coverZ = BSec/2.0
    #     coreY = coverY - coverH
    #     coreZ = coverZ - coverB
    #     numBarsInt = int(numBarsIntTot/2)
    #     GJ = 1e6
        
    #     target = 0.025   # tamaño fibra ≈ 2.5 cm

    #     nfCoreY = max(8,  int((coreY*2)/target))
    #     nfCoreZ = max(8,  int((coreZ*2)/target))
        
    #     nfCoverY = max(4, int(nfCoreY/2))
    #     nfCoverZ = max(4, int(nfCoreZ/2))
        
        
    #     ops.section('Fiber', ID, '-GJ', GJ)
        
    #     sM  = [['patch', 'quad', coreID,nfCoreZ,nfCoreY,-coreY,coreZ,-coreY,-coreZ,coreY,-coreZ,coreY,coreZ],
    #            ['patch', 'quad', coverID,2,nfCoverY,-coverY,coverZ,-coreY,coreZ,coreY,coreZ,coverY,coverZ],
    #            ['patch', 'quad', coverID,2,nfCoverY,-coreY,-coreZ,-coverY,-coverZ,coverY,-coverZ,coreY,-coreZ], 
    #            ['patch', 'quad', coverID,nfCoverZ,2,-coverY,coverZ,-coverY,-coverZ,-coreY,-coreZ,-coreY,coreZ],
    #            ['patch', 'quad', coverID,nfCoverZ,2,coreY,coreZ,coreY,-coreZ,coverY,-coverZ,coverY,coverZ]]
        

    #     if numBarsInt > 0:
    #         nespacios = numBarsInt + 1
    #         a = HSec - 2*coverH
    #         b = a/nespacios
    #         sM.append(['layer','straight',steelID,numBarsInt,barAreaInt,-coreY+b,coreZ,coreY-b,coreZ]) # este
    #         sM.append(['layer','straight',steelID,numBarsInt,barAreaInt,-coreY+b,-coreZ,coreY-b,-coreZ]) # y este
        
    #     if numBarsTop > 1 and numBarsBot > 1:
    #         sM += [
    #             ['layer', 'straight', steelID, numBarsTop,barAreaTop,coreY,coreZ,coreY,-coreZ],
    #             ['layer', 'straight', steelID, numBarsBot,barAreaBot,-coreY,coreZ,-coreY,-coreZ],
    #         ]
    #     elif numBarsTop > 1 and numBarsBot < 1:
    #         sM += [
    #             ['layer', 'straight', steelID, numBarsTop,barAreaTop,coreY,coreZ,coreY,-coreZ],
    #         ]
    #     elif numBarsTop < 1 and numBarsBot > 1:
    #         sM += [
    #             ['layer', 'straight', steelID, numBarsBot,barAreaBot,-coreY,coreZ,-coreY,-coreZ],
    #         ]

            
    #     for item in sM:
    #         if item[0] == 'patch':
    #             _, patch_type, *params = item
    #             ops.patch(patch_type, *params) 
    #         if item[0] == 'layer':
    #             _, layer_type, *params = item
    #             ops.layer(layer_type, *params) 
        
    #     return sM
    
    @staticmethod
    def BuildRCSection_VA(
        ID, HSec, BSec,
        coverH, coverB,
        coreID, coverID,
        steelID,
        numBarsTop, barAreaTop,
        numBarsBot, barAreaBot,
        numBarsIntTot, barAreaInt,
        nfCoreY, nfCoreZ,
        nfCoverY, nfCoverZ
    ):
        """
        Sección rectangular de concreto reforzado para forceBeamColumn 3D.
        Unidades en m y kN (E ya viene en kN/m² en el material).
        """
    
        # --- 1) Geometría básica
        coverY = HSec / 2.0   # semialtura total
        coverZ = BSec / 2.0   # semibase total
        coreY  = coverY - coverH
        coreZ  = coverZ - coverB
    
        # Validaciones geométricas
        if coreY <= 0 or coreZ <= 0:
            print(f"[WARN] Section {ID}: coreY/coreZ <= 0 (HSec={HSec}, BSec={BSec}, coverH={coverH}, coverB={coverB}).")
            # Para no reventar, forzamos un núcleo mínimo
            coreY = max(coreY, 0.001)
            coreZ = max(coreZ, 0.001)
    
        # Discretización mínima razonable
        # nfCoreY   = max(int(nfCoreY),   4)
        # nfCoreZ   = max(int(nfCoreZ),   4)
        # nfCoverY  = max(int(nfCoverY),  2)
        # nfCoverZ  = max(int(nfCoverZ),  2)
        
        target = 0.025   # tamaño fibra 2.5 cm

        nfCoreY = max(8, int((coreY*2)/target))
        nfCoreZ = max(8, int((coreZ*2)/target))
        
        nfCoverY = max(4, int(nfCoreY/2))
        nfCoverZ = max(4, int(nfCoreZ/2))
    
        # Número de barras intermedias por cara
        numBarsInt = int(numBarsIntTot / 2) if numBarsIntTot is not None else 0
    
        # Torsión: algo grande pero no infinito
        GJ = 1e6  # puedes ajustarlo luego
    
        ops.section("Fiber", ID, "-GJ", GJ)
    
        # --- 2) Patches de concreto
        sM = [
            # Núcleo confinado
            ["patch", "quad", coreID, nfCoreZ, nfCoreY,
             -coreY,  coreZ,
             -coreY, -coreZ,
              coreY, -coreZ,
              coreY,  coreZ],
    
            # Recubrimiento superior
            ["patch", "quad", coverID, 2, nfCoverY,
             -coverY,  coverZ,
             -coreY,   coreZ,
              coreY,   coreZ,
              coverY,  coverZ],
    
            # Recubrimiento inferior
            ["patch", "quad", coverID, 2, nfCoverY,
             -coreY,  -coreZ,
             -coverY, -coverZ,
              coverY, -coverZ,
              coreY,  -coreZ],
    
            # Recubrimiento izquierdo
            ["patch", "quad", coverID, nfCoverZ, 2,
             -coverY,  coverZ,
             -coverY, -coverZ,
             -coreY,  -coreZ,
             -coreY,   coreZ],
    
            # Recubrimiento derecho
            ["patch", "quad", coverID, nfCoverZ, 2,
              coreY,   coreZ,
              coreY,  -coreZ,
              coverY, -coverZ,
              coverY,  coverZ],
        ]
    
        # --- 3) Barras intermedias (opcional, pero yo las quitaría por ahora)
        if numBarsInt > 0 and barAreaInt > 0:
            nespacios = numBarsInt + 1
            a = HSec - 2.0 * coverH
            b = a / nespacios
            # cara superior
            sM.append(["layer", "straight", steelID, numBarsInt, barAreaInt,
                       -coreY + b,  coreZ,
                        coreY - b,  coreZ])
            # cara inferior
            sM.append(["layer", "straight", steelID, numBarsInt, barAreaInt,
                       -coreY + b, -coreZ,
                        coreY - b, -coreZ])
    
        # --- 4) Barras superior e inferior
        # si viene 1 barra, igual la modelamos (no la descartamos)
        if numBarsTop > 0:
            sM.append(["layer", "straight", steelID, int(numBarsTop), barAreaTop,
                       coreY,  coreZ,
                       coreY, -coreZ])
    
        if numBarsBot > 0:
            sM.append(["layer", "straight", steelID, int(numBarsBot), barAreaBot,
                       -coreY,  coreZ,
                       -coreY, -coreZ])
    
        # --- 5) Enviar a OpenSees
        for item in sM:
            if item[0] == "patch":
                _, patch_type, *params = item
                ops.patch(patch_type, *params)
            elif item[0] == "layer":
                _, layer_type, *params = item
                ops.layer(layer_type, *params)
            
        return sM

    @staticmethod
    def BuildRCSectionCircular(ID, DSec, cover, d_stirrup, coreID, coverID, steelID,
                                NumBars, barArea, nfCoreRadial, nfCoreCirc, nfCoverRadial, nfCoverCirc):

        GJ = 1e6
        Rcover_ext = DSec / 2
        Rcore_ext = Rcover_ext - cover
        Rcore_int = 0.0  # núcleo confinado comienza desde el centro

        ops.section('Fiber', ID, '-GJ', GJ)
        
        # Acero longitudinal
        R_barras = Rcore_ext - d_stirrup - (np.sqrt(barArea / np.pi) / 2)  # centro de las barras
            
        sM  = [['patch', 'circ', coreID, nfCoreRadial, nfCoreCirc, 0.0, 0.0, Rcore_int, Rcore_ext, 0.0, 360],
               ['patch', 'circ', coverID, nfCoverRadial, nfCoverCirc, 0.0, 0.0, Rcore_ext, Rcover_ext, 0.0, 360],   
               ['layer', 'circ', steelID, NumBars, barArea, 0.0, 0.0, R_barras]]

        for item in sM:
            if item[0] == 'patch':
                _, patch_type, *params = item
                ops.patch(patch_type, *params) 
            if item[0] == 'layer':
                _, layer_type, *params = item
                ops.layer(layer_type, *params) 
        
        return sM
    
    def build_elements(self):
        index_sum = 0
        for story, story_data in self.store_data['model_data'].items():
            
            # GENERAR COLUMNAS -->
            if story_data.get('columns_data', None) is not None:   
                columns = story_data['columns_data']
                for elem_id, col in columns.items():
                    eid = int(elem_id)
                    transfTag = eid
                    
                    node_i = int(col['joint_i'])
                    node_j = int(col['joint_j'])
                    section_tag = int(col['section_tag'])
                    vectrans = col['geometry_transformation_vector']
                    offset_i = col['offsets_vectors']['offset_i']
                    offset_j = col['offsets_vectors']['offset_j']
                    
                    if offset_i is None and offset_j is None:
                        ops.geomTransf('PDelta', transfTag, *vectrans)
                    else:
                        ops.geomTransf('PDelta', transfTag, *vectrans, '-jntOffset', *offset_i, *offset_j)
                    
                    if self.linear_model:
                        ops.element('elasticBeamColumn', eid, node_i, node_j, section_tag, transfTag)
                    else:
                        ops.element('forceBeamColumn', eid, node_i, node_j, transfTag, section_tag)
            
            # GENERAR VIGAS -->
            if story_data.get('beams_data', None) is not None:
                
                beams = story_data['beams_data']
                for elem_id, beam in beams.items():
                    eid = int(elem_id)
                    transfTag = eid
                    node_i = int(beam['joint_i'])
                    node_j = int(beam['joint_j'])
                    section_tag = int(beam['section_tag'])
                    vectrans = beam['geometry_transformation_vector']
                                        
                    ops.geomTransf('Linear', transfTag, *vectrans)
                    L = beam['lenght']     # m
                    h = beam['geometry']['height']     # m
                    ratio = L / h if h > 0 else 999.0  # súper esbelta si h=0 por error
                        
                    if self.linear_model:
                        ops.element('elasticBeamColumn', eid, node_i, node_j, section_tag, transfTag)
                    else:
                        if self.store_data['general_data']['structure_system'] == 'RCMRF': 
                            ops.element('forceBeamColumn', eid, node_i, node_j, transfTag, section_tag)
                        else:
                            if ratio >= 6.8:
                                 ops.element('forceBeamColumn', eid, node_i, node_j, transfTag, section_tag)
                            else:
                                ops.element('elasticBeamColumn', eid, node_i, node_j, section_tag, transfTag)

                        # if self.store_data['general_data']['structure_system'] == 'WRCF': 
                        #     # ops.element('TrussSection', eid, node_i, node_j, section_tag)
                        #     ops.element('elasticBeamColumn', eid, node_i, node_j, section_tag, transfTag)
                        # else: ops.element('forceBeamColumn', eid, node_i, node_j, transfTag, section_tag)
            
            # GENERAR LOSAS -->
            if story_data.get('slabs_data', None) is not None:

                slabs = story_data['slabs_data']
                for elem_id, slab in slabs.items():
                    eid = int(str(elem_id))
                    section_tag = int(slab['section_tag'])
                    
                    # === TRIANGULAR SLAB ===
                    if (
                        slab['joint_1'] is None or slab['joint_2'] is None or 
                        slab['joint_3'] is None or slab['joint_4'] is None or 
                        math.isnan(slab['joint_1']) or math.isnan(slab['joint_2']) or
                        math.isnan(slab['joint_3']) or math.isnan(slab['joint_4']) 
                    ):
                        # Identify which joint is missing and build triangle with the remaining 3
                        if math.isnan(slab['joint_1']):
                            nodoslosa = [int(slab['joint_2']), int(slab['joint_3']), int(slab['joint_4'])]
                        elif math.isnan(slab['joint_2']):
                            nodoslosa = [int(slab['joint_1']), int(slab['joint_3']), int(slab['joint_4'])]
                        elif math.isnan(slab['joint_3']):
                            nodoslosa = [int(slab['joint_1']), int(slab['joint_2']), int(slab['joint_4'])]
                        else:  # Joint 4 is NaN
                            nodoslosa = [int(slab['joint_1']), int(slab['joint_2']), int(slab['joint_3'])]
            
                        # Define triangular shell element
                        ops.element('ShellDKGT', eid, *nodoslosa, section_tag)
                        # ops.element('ASDShellT3', eid, *nodoslosa, section_tag)
                    
                    # === QUADRILATERAL SLAB ===
                    else:
                        nodoslosa = [
                            int(slab['joint_1']), int(slab['joint_2']),
                            int(slab['joint_3']), int(slab['joint_4'])
                        ]
            
                        # Define quadrilateral shell element
                        ops.element('ShellDKGQ', eid, *nodoslosa, section_tag)
                        # ops.element('ASDShellQ4', eid, *nodoslosa, section_tag)

            # GENERAR MUROS -->
            if story_data.get('walls_data', None) is not None:

                walls = story_data['walls_data']
                for elem_id2, wall in walls.items():
                    eid2 = -int(elem_id2)
                    wall_fibers = wall['wall_fibers']
                    materials = wall['material_properties']
                    
                    node_ele = [int(wall['joint_1']),
                                int(wall['joint_2']),
                                int(wall['joint_3']),
                                int(wall['joint_4'])]
                                                    
                    t = wall_fibers['thickness_fibers']
                    width = wall_fibers['width_fibers']
                    rho = wall_fibers['cuantia_fibers']
                    concrete = wall_fibers['concrete_fibers']
                    steel = wall_fibers['steel_fibers']
                    num_fib = int(sum(wall_fibers['number_fibers']))
                    
                    fc = materials['concrete_properties']['fc']
                    E = 1000*4400*(fc/1000)**0.5
                    tagshear = 5000 + index_sum
                    G = E*0.4
                    ops.uniaxialMaterial('Elastic', tagshear, G*1.5)
                    index_sum += 1
                                    
                    ops.element('MVLEM_3D', eid2, *node_ele, num_fib,'-thick',*t,'-width',*width,'-rho',*rho,'-matConcrete',*concrete,'-matSteel',*steel,'-matShear',tagshear)

    def apply_loads(self):

        ops.timeSeries('Linear', 1)
        ops.pattern('Plain',1,1)

        for _, story_data in self.store_data['model_data'].items():

            # APLICAR CARGAS EN LOSAS -->
            if story_data.get('slabs_data', None) is not None:
                slabs = story_data.get('slabs_data', {})
                
                for elem_id, slab in slabs.items():
                    ele_tag = int(elem_id) 
                    if slab.get('loads').get('consider'):
                        q_dead = float(slab.get('loads').get('dead_load', 0.0))
                        q_live = float(slab.get('loads').get('live_load', 0.0))
                        
                        q_comb = 1.0 * (q_dead + 24*slab.get('slab_thickness')) + 0.25 * q_live

                        if abs(q_comb) < 1e-9:
                            continue
                            
                        opst.pre.transform_surface_uniform_load(
                            ele_tags=[ele_tag],
                            p=-q_comb,
                        )
            
            # APLICAR CARGAS EN VIGAS -->
            if story_data.get('beams_data', None) is not None:
                beams = story_data.get('beams_data', {})
                for elem_id, beam in beams.items():
                    eid = int(elem_id)
                    force = float(beam.get('distributed_force', 0.0))  # kN/m
                    if abs(force) < 1e-9:
                        continue                    
                    ops.eleLoad('-ele', eid, '-type', '-beamUniform', -force, 0.0)
            
            # APLICAR CARGAS EN COLUMNAS -->
            if story_data.get('columns_data', None) is not None:
                columns = story_data['columns_data']
                for elem_id, col in columns.items():
                    eid = int(col.get('demand').get('load_node'))
                    force = col.get('demand').get('puntual_force')
                    ops.load(eid,0.0,0.0,-float(force),0.0,0.0,0.0)

            
            # APLICAR CARGAS EN MUROS -->
            if story_data.get('walls_data', None) is not None:
                walls = story_data['walls_data']
                for _, wall in walls.items():
                    j3 = wall['demand']['pf_joint3']['node']
                    j4 = wall['demand']['pf_joint4']['node']
                    w_node = wall['demand']['pf_joint3']['force']
                    ops.load(j3, 0.0, 0.0, -w_node, 0.0, 0.0, 0.0)
                    ops.load(j4, 0.0, 0.0, -w_node, 0.0, 0.0, 0.0)
                            
    def assign_com_masses(self):
        
        center_of_mass_information = self.store_data.get('center_of_mass_information')
        model_data = self.store_data.get('model_data')
        story_names = list(sorted(model_data.keys()))
        
        for index, (node_tag, data_com) in enumerate(sorted(center_of_mass_information.items())):
            dia1 = list(model_data.get(story_names[index+1]).get('joints_data').keys())
            dia = [int(node) for node in dia1]
            # Create mass center node
            ops.node(int(node_tag),data_com.get('global_x'),data_com.get('global_y'),data_com.get('global_z'))
            # Fix the node in Z and all rotational DOFs except torsion
            ops.fix(int(node_tag), 0, 0, 1, 1, 1, 0)
            # Assign mass and rotational inertia (about vertical axis)
            ops.mass(int(node_tag),data_com.get('mass_x')/1000,data_com.get('mass_y')/1000,0.0,0.0,0.0,data_com.get('mass_moment_of_inertia'))
            # Create rigid diaphragm at this level linking joints to mass center
            ops.rigidDiaphragm(3, int(node_tag), *dia)
    