---
name: numpy version constraint
description: numpy está pinned a 1.26.x en Docker — no usar APIs de numpy 2.0+
type: feedback
originSessionId: 586fb21a-4430-4c79-a711-769311da2bc4
---
El requirements.txt pina `numpy==1.26.4` para el entorno Docker/producción. El entorno local de dev puede tener numpy 2.x.

**Why:** Se descubrió cuando `np.trapezoid` (añadida en numpy 2.0) causó un Internal Server Error en producción. Localmente funcionaba con numpy 2.5.1.

**How to apply:** Al escribir código en `packages/engine`, evitar funciones exclusivas de numpy 2.x:
- Usar `np.trapz` NO (`np.trapezoid` no existe en 1.26)
- O mejor aún: implementar regla trapezoidal directamente: `0.5 * np.sum((y[:-1]+y[1:]) * np.diff(x))`
- Antes de usar cualquier función numpy poco común, verificar en qué versión fue añadida.
