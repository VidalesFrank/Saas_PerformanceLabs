"""
@author: Daniela Novoa, Orlando Arroyo, Frank Vidales
@owner: EstrucMed Ingeniería especializada S.A.S

-------------------------------------------------------------------------------
                      CSI Model Converter to OpenSeesPy
                          Versión: ETABS17 v17.0.1
    
            Utilidades/Funciones generales compartidas entre modulos

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

# --- Importar otras librerias de python
import numpy as np
import math
import json



#%% ==> JSON SERIALIZABLE

# Función para convertir automáticamente ndarrays a listas
def convertir_a_serializable(obj):
    if isinstance(obj, dict):
        return {k: convertir_a_serializable(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [convertir_a_serializable(i) for i in obj]
    elif isinstance(obj, np.ndarray):
        return convertir_a_serializable(obj.tolist())
    elif isinstance(obj, (np.floating, float)):
        if math.isnan(obj) or math.isinf(obj):
            return None
        return float(obj)
    elif isinstance(obj, (np.integer, int)):
        return int(obj)
    elif obj is None:
        return None
    else:
        return obj

#%% ==> GENERAR CATALOGO DE REGISTROS FEMA

def fema_records_json(folder_records, folder_data):
    
    # Incrementos de tiempo por registro
    time_increment = [
        0.01,0.01,0.01,0.01,0.01,0.01,0.01,0.01,0.01,0.01,
        0.005,0.005,0.01,0.01,0.01,0.01,0.005,0.005,
        0.05,0.05,0.02,0.02,0.0025,0.0025,0.005,0.005,
        0.005,0.005,0.02,0.02,0.005,0.005,0.01,0.01,
        0.02,0.02,0.005,0.005,0.005,0.005,0.01,0.01,
        0.005,0.005
    ]

    fema_records_json = {}
    txt_files = sorted([f for f in os.listdir(folder_records) if f.endswith('.txt')])
    
   
    
    for i, filename in enumerate(txt_files):
        file_path = os.path.join(folder_records, filename)
        
        # Leer los valores del archivo
        with open(file_path, 'r') as f:
            data = f.read()

        # Procesar: separar en números
        record_values = [float(val) for val in data.replace('\n', ' ').split() if val.strip()]
        
        # Solo metadatos, no cargamos los valores
        # Leemos los valores de cada registro para registrar los pasos del registro
        fema_records_json[i] = {
            'record_name': f'GM{i+1:02}',
            'file_path': file_path.replace('\\', '/'),  # ruta en formato seguro
            'time_increment': time_increment[i],
            'steps_number': len(record_values)
        }

    # Guardar como archivo .json
    output_path = os.path.join(folder_data, 'fema_records_database.json')
    with open(output_path, 'w') as f:
        json.dump(fema_records_json, f, indent=2)
