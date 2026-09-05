"""Ground Motion Analysis Engine — Performance Labs.

Motor científico para importación, procesamiento y análisis de acelerogramas sísmicos.
Diseñado para ser independiente del framework web: sin FastAPI, sin Pydantic.

Módulos:
  io/         — detección y parsing de archivos
  processing/ — integración, corrección de línea base, filtrado
  analysis/   — intensidad, frecuencia, espectros de respuesta
  record.py   — estructura de datos interna (GroundMotionRecord)
  units.py    — conversiones de unidades
"""
