"""Catalogo de modulos/productos de la plataforma.

Transcrito de PlanteamientoDesarrollosEmpresaOpenSees.docx (los 6 modulos +
la tabla de Nivel/Estado). Es la fuente de verdad que alimenta el dashboard, y
tambien funciona como roadmap vivo del producto: se edita este archivo a medida
que el estado real de cada item cambia.

nivel: "free" | "pro" | "premium" | None (sin definir aun)
estado: "idea" | "en_desarrollo" | "listo"
"""

CATALOG = [
    {
        "id": "constructor-modelos",
        "name": "Constructor de Modelos Estructurales",
        "products": [
            {
                "id": "constructor-modelos-etabs",
                "name": "Constructor de modelos desde ETABS (XLSX / .e2k)",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/projects",
                "hidden": True,
            },
            {
                "id": "validacion-modelo",
                "name": "Validacion y verificacion del modelo estructural",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/projects",
                "hidden": True,
            },
            {
                "id": "analisis-modal-lineal",
                "name": "Analisis modal lineal (periodos, modos, participacion de masas)",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/projects",
                "hidden": True,
            },
            {
                "id": "analisis-espectral-rsa",
                "name": "Analisis espectral RSA NSR-10 (CQC/SRSS) + ajuste FHE",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/projects",
                "hidden": True,
            },
            {
                "id": "diseno-elementos",
                "name": "Diseno de elementos (columnas, vigas, muros) NSR-10",
                "nivel": "pro",
                "estado": "idea",
                "route": None,
                "hidden": True,
            },
            {
                "id": "exportacion-modelo-nl",
                "name": "Exportacion de modelo no lineal al Modulo 3",
                "nivel": "premium",
                "estado": "idea",
                "route": None,
                "hidden": True,
            },
        ],
    },
    {
        "id": "modelado",
        "name": "Módulo 1 - Modelación y Análisis Preliminar de Edificios",
        "products": [
            {
                "id": "constructor-modelos-etabs",
                "name": "Constructor de modelos desde ETABS (XLSX / .e2k)",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/projects",
            },
            {"id": "import-etabs", "name": "Importación ETABS", "nivel": "pro", "estado": "en_desarrollo", "route": "/projects"},
            {"id": "import-sap2000", "name": "Importación SAP2000", "nivel": None, "estado": "idea", "route": None},
            {"id": "import-ifc", "name": "Importación IFC (BIM)", "nivel": None, "estado": "idea", "route": None},
            {"id": "conv-opensees", "name": "Conversión automática a OpenSees", "nivel": "pro", "estado": "en_desarrollo", "route": "/projects"},
            {"id": "editor-grafico", "name": "Editor gráfico", "nivel": None, "estado": "idea", "route": None},
            {"id": "gestion-materiales", "name": "Gestión de materiales", "nivel": None, "estado": "idea", "route": None, "hidden": True},
            {"id": "gestion-secciones", "name": "Gestión de secciones", "nivel": None, "estado": "idea", "route": None, "hidden": True},
            {"id": "gestion-cargas", "name": "Gestión de cargas", "nivel": None, "estado": "idea", "route": None, "hidden": True},
            {"id": "gestion-combinaciones", "name": "Gestión de combinaciones", "nivel": None, "estado": "idea", "route": None, "hidden": True},
            {
                "id": "generador-espectros",
                "name": "Generador de espectros y parametros sismicos",
                "nivel": "free", "estado": "en_desarrollo", "route": "/seismic",
            },
        ],
    },
    {
        "id": "secciones",
        "name": "Módulo 2 - Ingeniería de Secciones",
        "products": [
            {
                "id": "diagrama-interaccion",
                "name": "Diagrama de interacción (Columnas/Muros/Pilas)",
                "nivel": "free", "estado": "en_desarrollo", "route": "/analysis/interaction",
            },
            {
                "id": "interaccion-biaxial",
                "name": "Interacción Biaxial P-M-M",
                "nivel": "pro", "estado": "en_desarrollo", "route": "/analysis/pmm",
            },
            {
                "id": "momento-curvatura",
                "name": "Curva momento-curvatura con modelos de confinamiento",
                "nivel": "pro", "estado": "en_desarrollo", "route": "/analysis/moment-curvature",
            },
            {
                "id": "carga-axial-sobreesfuerzo",
                "name": "Relación de carga axial y chequeos de sobreesfuerzo",
                "nivel": "free", "estado": "idea", "route": None, "hidden": True,
            },
            {
                "id": "disenador-fibras",
                "name": "Disenador de secciones de fibras",
                "nivel": "pro", "estado": "idea", "route": None, "hidden": True,
            },
            {
                "id": "biblioteca-secciones",
                "name": "Editor gráfico de secciones (CAD)",
                "nivel": "pro", "estado": "en_desarrollo", "route": "/sections",
            },
            {"id": "editor-refuerzo", "name": "Editor de refuerzo", "nivel": None, "estado": "idea", "route": None, "hidden": True},
            {"id": "confinamiento", "name": "Confinamiento", "nivel": None, "estado": "idea", "route": None, "hidden": True},
            {
                "id": "calculadoras-diseno",
                "name": "Calculadoras de diseño (ARCO)",
                "nivel": "pro", "estado": "en_desarrollo", "route": None,
            },
            {"id": "conexiones-acero", "name": "Conexiones de acero", "nivel": "pro", "estado": "idea", "route": None},
        ],
    },
    {
        "id": "analisis-no-lineal-3d",
        "name": "Módulo 3 - Análisis No Lineal de Edificios",
        "products": [
            {
                "id": "analisis-edificio",
                "name": "Análisis no lineal 3D de edificios (Modal + Pushover + Dinamico + IDA)",
                "nivel": "premium",
                "estado": "en_desarrollo",
                "route": "/building",
            },
            {
                "id": "analisis-edificio-2D",
                "name": "Análisis no lineal 2D de edificios (Modal + Pushover + Dinamico + IDA)",
                "nivel": "premium",
                "estado": "en_desarrollo",
                "route": None,
            },
            {
                "id": "seleccion-registros",
                "name": "Selección y escalamiento de registros sismicos",
                "nivel": "premium",
                "estado": "en_desarrollo",
                "route": None,
            },
            {"id": "analisis-ciclico", "name": "Análisis ciclico", "nivel": None, "estado": "idea", "route": None},
        ],
    },
    {
        "id": "desempeno",
        "name": "Módulo 4 - Evaluación del Desempeño",
        "products": [
            {
                "id": "evaluacion-desempeno",
                "name": "Evaluación de desempeño (modelo de perdidas)",
                "nivel": "premium", "estado": "en_desarrollo", "route": None,
            },
            {
                "id": "evaluacion-refuerzo",
                "name": "Evaluación de refuerzo de edificaciones",
                "nivel": "premium", "estado": "idea", "route": None,
            },
            {"id": "calculo-r-elemento", "name": "álculo del R de cada elemento", "nivel": "premium", "estado": "idea", "route": None},
            {"id": "r-diferencial", "name": "Diseño con R diferencial de elementos", "nivel": "premium", "estado": "idea", "route": None},
            {
                "id": "estudios-parametricos",
                "name": "Estudios parametricos y de sensibilidad de desempeno",
                "nivel": "premium", "estado": "idea", "route": None,
            },
        ],
    },
    {
        "id": "riesgo",
        "name": "Modulo 5 - Riesgo",
        "products": [
            {"id": "fragilidad", "name": "Fragilidad", "nivel": None, "estado": "idea", "route": None},
            {"id": "curvas-vulnerabilidad", "name": "Curvas de vulnerabilidad", "nivel": None, "estado": "idea", "route": None},
            {"id": "prob-colapso", "name": "Probabilidad de colapso", "nivel": None, "estado": "idea", "route": None},
            {"id": "perdidas-economicas", "name": "Perdidas economicas", "nivel": None, "estado": "idea", "route": None},
            {"id": "tiempo-recuperacion", "name": "Tiempo de recuperacion", "nivel": None, "estado": "idea", "route": None},
            {"id": "riesgo-anual", "name": "Riesgo anual esperado", "nivel": None, "estado": "idea", "route": None},
        ],
    },
    {
        "id": "decisiones",
        "name": "Modulo 6 - Toma de decisiones",
        "products": [
            {
                "id": "reporte-recomendaciones",
                "name": "Reporte de desempeno y recomendaciones de intervencion",
                "nivel": None, "estado": "idea", "route": None,
            },
        ],
    },
]
