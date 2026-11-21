"""Catalogo de modulos/productos de la plataforma.

Reorganizado por *flujos de trabajo* (no por numeración del doc maestro) para
que el dashboard muestre pocas tarjetas útiles en vez de una lista densa de
sub-features. El roadmap original queda en el grupo `roadmap` colapsable.

Campos:
  * group       — cómo agrupa el dashboard (modelacion|sismologia|secciones|campo|roadmap)
  * desc        — bajada corta usada en header del grupo
  * icon        — id en module-visuals.tsx ICON_D
  * color       — token de la paleta tech (cyan|blue|emerald|amber|violet)
  * products[]:
      - subtitle  — una línea bajo el nombre en la card
      - featured  — true => aparece también como atajo grande en el hero
      - nivel     — "free" | "pro" | "premium" | None
      - estado    — "idea" | "en_desarrollo" | "listo"
      - route     — ruta Next.js o None (tarjeta inactiva)
"""

CATALOG = [
    {
        "id": "modelacion",
        "name": "Modelación y análisis",
        "group": "modelacion",
        "desc": "Importación ETABS, generación de modelo OpenSees y análisis no lineal 3D",
        "icon": "building",
        "color": "cyan",
        "products": [
            {
                "id": "constructor-modelos",
                "name": "Constructor de Modelos",
                "subtitle": "Importa ETABS o modela desde cero. Análisis lineal y no lineal (pushover, NLTHA, IDA, desempeño CSM) en un solo módulo",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/projects",
                "featured": True,
            },
            {
                "id": "muros-rc-3d",
                "name": "Muros RC 3D",
                "subtitle": "Diseño automático y análisis no lineal con E-SFI-MVLEM-3D",
                "nivel": "premium",
                "estado": "en_desarrollo",
                "route": "/wall-projects",
            },
        ],
    },
    {
        "id": "sismologia",
        "name": "Sismología y registros",
        "group": "sismologia",
        "desc": "Espectros NSR-10 por municipio y procesamiento completo de acelerogramas",
        "icon": "wave",
        "color": "blue",
        "products": [
            {
                "id": "espectros-nsr10",
                "name": "Espectros NSR-10",
                "subtitle": "Sa, Sd y Sv por municipio, tipo de suelo y amortiguamiento",
                "nivel": "free",
                "estado": "en_desarrollo",
                "route": "/seismic",
                "featured": True,
            },
            {
                "id": "ground-motion",
                "name": "Análisis de Acelerogramas",
                "subtitle": "Historia a-v-d, IM (PGA/PGV/Arias/CAV), FFT/PSD y espectros Newmark-β",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/ground-motion",
                "featured": True,
            },
        ],
    },
    {
        "id": "secciones",
        "name": "Ingeniería de secciones",
        "group": "secciones",
        "desc": "Diseño y verificación de secciones RC con confinamiento Mander y fibras",
        "icon": "section",
        "color": "emerald",
        "products": [
            {
                "id": "editor-secciones",
                "name": "Editor gráfico (CAD)",
                "subtitle": "Editor paramétrico con snap, fibras y verificación NSR-10 en vivo",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/sections",
            },
            {
                "id": "interaccion-pm",
                "name": "Diagrama P-M",
                "subtitle": "Diagrama de interacción para columnas, muros y pilas",
                "nivel": "free",
                "estado": "en_desarrollo",
                "route": "/analysis/interaction",
            },
            {
                "id": "interaccion-pmm",
                "name": "P-M-M Biaxial",
                "subtitle": "Superficie de interacción biaxial 3D con rotación de fibras",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/analysis/pmm",
            },
            {
                "id": "momento-curvatura",
                "name": "Momento-Curvatura",
                "subtitle": "Curva M-φ con confinamiento Mander y ductilidad μφ",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/analysis/moment-curvature",
            },
        ],
    },
    {
        "id": "campo",
        "name": "Campo y triaje post-sismo",
        "group": "campo",
        "desc": "Evaluación rápida de edificaciones en campo tras un evento sísmico",
        "icon": "clipboard",
        "color": "amber",
        "products": [
            {
                "id": "triaje-post-sismo",
                "name": "Triaje post-sismo",
                "subtitle": "ATC-20 / AIS-IDIGER + Building Rating FEMA P-2018 con reporte PDF",
                "nivel": "pro",
                "estado": "en_desarrollo",
                "route": "/field-assessment",
            },
        ],
    },
    {
        "id": "roadmap",
        "name": "Roadmap",
        "group": "roadmap",
        "desc": "Módulos en diseño — evaluación de desempeño, riesgo y recomendaciones",
        "icon": "gauge",
        "color": "violet",
        "products": [
            {
                "id": "desempeno",
                "name": "Evaluación de desempeño",
                "subtitle": "ATC-40 / FEMA 356 / ASCE 41 — CSM, N2 y modelos de pérdidas",
                "nivel": "premium",
                "estado": "idea",
                "route": None,
            },
            {
                "id": "riesgo",
                "name": "Riesgo sísmico",
                "subtitle": "Fragilidad, probabilidad de colapso y pérdidas económicas (EAL)",
                "nivel": "premium",
                "estado": "idea",
                "route": None,
            },
            {
                "id": "decisiones",
                "name": "Toma de decisiones",
                "subtitle": "Reportes automáticos de desempeño y recomendaciones de intervención",
                "nivel": "premium",
                "estado": "idea",
                "route": None,
            },
        ],
    },
]
