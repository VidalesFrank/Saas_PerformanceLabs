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
        "id": "modelado",
        "name": "Modulo 1 - Modelado e Interoperabilidad",
        "products": [
            {"id": "import-etabs", "name": "Importacion ETABS", "nivel": None, "estado": "idea", "route": None},
            {"id": "import-sap2000", "name": "Importacion SAP2000", "nivel": None, "estado": "idea", "route": None},
            {"id": "import-ifc", "name": "Importacion IFC (BIM)", "nivel": None, "estado": "idea", "route": None},
            {"id": "conv-opensees", "name": "Conversion automatica a OpenSees", "nivel": None, "estado": "idea", "route": None},
            {"id": "editor-grafico", "name": "Editor grafico", "nivel": None, "estado": "idea", "route": None},
            {"id": "gestion-materiales", "name": "Gestion de materiales", "nivel": None, "estado": "idea", "route": None},
            {"id": "gestion-secciones", "name": "Gestion de secciones", "nivel": None, "estado": "idea", "route": None},
            {"id": "gestion-cargas", "name": "Gestion de cargas", "nivel": None, "estado": "idea", "route": None},
            {"id": "gestion-combinaciones", "name": "Gestion de combinaciones", "nivel": None, "estado": "idea", "route": None},
            {
                "id": "generador-espectros",
                "name": "Generador de espectros y parametros sismicos",
                "nivel": "free", "estado": "en_desarrollo", "route": "/seismic",
            },
        ],
    },
    {
        "id": "secciones",
        "name": "Modulo 2 - Ingenieria de Secciones",
        "products": [
            {
                "id": "diagrama-interaccion",
                "name": "Diagrama de interaccion (Columnas/Muros/Pilas)",
                "nivel": "free", "estado": "en_desarrollo", "route": "/analysis/interaction",
            },
            {
                "id": "interaccion-biaxial",
                "name": "Interaccion Biaxial P-M-M",
                "nivel": "pro", "estado": "en_desarrollo", "route": "/analysis/pmm",
            },
            {
                "id": "momento-curvatura",
                "name": "Curva momento-curvatura con modelos de confinamiento",
                "nivel": "pro", "estado": "en_desarrollo", "route": "/analysis/moment-curvature",
            },
            {
                "id": "carga-axial-sobreesfuerzo",
                "name": "Relacion de carga axial y chequeos de sobreesfuerzo",
                "nivel": "free", "estado": "idea", "route": None,
            },
            {
                "id": "disenador-fibras",
                "name": "Disenador de secciones de fibras",
                "nivel": "pro", "estado": "idea", "route": None,
            },
            {"id": "biblioteca-secciones", "name": "Biblioteca de secciones", "nivel": None, "estado": "idea", "route": None},
            {"id": "editor-refuerzo", "name": "Editor de refuerzo", "nivel": None, "estado": "idea", "route": None},
            {"id": "confinamiento", "name": "Confinamiento", "nivel": None, "estado": "idea", "route": None},
            {
                "id": "calculadoras-diseno",
                "name": "Calculadoras de diseno (ARCO)",
                "nivel": "pro", "estado": "en_desarrollo", "route": None,
            },
            {"id": "conexiones-acero", "name": "Conexiones de acero", "nivel": "pro", "estado": "idea", "route": None},
        ],
    },
    {
        "id": "analisis-no-lineal-3d",
        "name": "Modulo 3 - Analisis No Lineal 3D de Edificios",
        "products": [
            {
                "id": "analisis-edificio",
                "name": "Analisis no lineal 3D de edificios (Modal + Pushover + Dinamico + IDA)",
                "nivel": "premium",
                "estado": "en_desarrollo",
                "route": "/building",
            },
            {
                "id": "seleccion-registros",
                "name": "Seleccion y escalamiento de registros sismicos",
                "nivel": "premium",
                "estado": "en_desarrollo",
                "route": None,
            },
            {"id": "analisis-ciclico", "name": "Analisis ciclico", "nivel": None, "estado": "idea", "route": None},
        ],
    },
    {
        "id": "desempeno",
        "name": "Modulo 4 - Evaluacion del Desempeno",
        "products": [
            {
                "id": "evaluacion-desempeno",
                "name": "Evaluacion de desempeno (modelo de perdidas)",
                "nivel": "premium", "estado": "en_desarrollo", "route": None,
            },
            {
                "id": "evaluacion-refuerzo",
                "name": "Evaluacion de refuerzo de edificaciones",
                "nivel": "premium", "estado": "idea", "route": None,
            },
            {"id": "calculo-r-elemento", "name": "Calculo del R de cada elemento", "nivel": "premium", "estado": "idea", "route": None},
            {"id": "r-diferencial", "name": "Diseno con R diferencial de elementos", "nivel": "premium", "estado": "idea", "route": None},
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
