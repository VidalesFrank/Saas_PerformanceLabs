"""Downsampling visual de series de tiempo largas.

LTTB (Largest-Triangle-Three-Buckets) — algoritmo estándar para reducir
puntos en gráficas preservando visualmente los picos y la envolvente.
Referencia: Sveinn Steinarsson (2013), tesis MSc Univ. Islandia.

Regla de uso: LTTB es SOLO para visualización. Ningún cálculo físico
(PGA, PGV, PGD, espectros, filtrado, integración) debe usar la señal
decimada — siempre usar la señal completa.
"""

from __future__ import annotations

import numpy as np


def lttb_downsample(
    x: np.ndarray,
    y: np.ndarray,
    n_out: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Reduce (x, y) a n_out puntos preservando picos visuales.

    Divide el intervalo en n_out-2 bins uniformes; primer y último punto
    siempre se conservan. Para cada bin intermedio, elige el punto que
    forma el triángulo de mayor área con el punto ya elegido del bin
    anterior y el centroide del bin siguiente. Complejidad O(n).

    Args:
        x: eje x monotónico (típicamente tiempo).
        y: eje y (aceleración/velocidad/desplazamiento).
        n_out: número de puntos deseados en la salida (>= 3).

    Returns:
        (x_ds, y_ds) — ambos arrays de longitud n_out (o len(x) si n<=n_out).
    """
    n = len(x)
    if n_out >= n or n_out < 3:
        return x.copy(), y.copy()

    # Bin size para los n_out-2 bins intermedios (dejamos afuera primer y último)
    bin_size = (n - 2) / (n_out - 2)

    sampled_idx = np.empty(n_out, dtype=np.int64)
    sampled_idx[0] = 0
    sampled_idx[-1] = n - 1
    a = 0  # índice del último punto seleccionado

    for i in range(n_out - 2):
        # Rango del bin actual
        b_start = int(np.floor(i * bin_size) + 1)
        b_end   = int(np.floor((i + 1) * bin_size) + 1)
        b_end   = min(b_end, n - 1)

        # Rango del bin siguiente (para calcular el centroide)
        c_start = int(np.floor((i + 1) * bin_size) + 1)
        c_end   = int(np.floor((i + 2) * bin_size) + 1)
        c_end   = min(c_end, n)

        # Centroide del bin siguiente
        if c_end > c_start:
            cx = x[c_start:c_end].mean()
            cy = y[c_start:c_end].mean()
        else:
            cx = x[-1]
            cy = y[-1]

        # Puntos candidatos del bin actual
        xs = x[b_start:b_end]
        ys = y[b_start:b_end]

        # Área del triángulo con vértices (x[a], y[a]) — (xs[k], ys[k]) — (cx, cy)
        # A = 0.5 * |x_a*(y_k - cy) + x_k*(cy - y_a) + cx*(y_a - y_k)|
        areas = np.abs(
            x[a] * (ys - cy)
            + xs * (cy - y[a])
            + cx * (y[a] - ys)
        )
        pick = b_start + int(np.argmax(areas))
        sampled_idx[i + 1] = pick
        a = pick

    return x[sampled_idx], y[sampled_idx]


def lttb_indices(x: np.ndarray, y: np.ndarray, n_out: int) -> np.ndarray:
    """Como lttb_downsample pero retorna solo los índices seleccionados.

    Útil cuando se necesita aplicar el mismo muestreo a varios canales
    (raw + SI + procesado) manteniendo alineación exacta.
    """
    n = len(x)
    if n_out >= n or n_out < 3:
        return np.arange(n)

    bin_size = (n - 2) / (n_out - 2)
    sampled_idx = np.empty(n_out, dtype=np.int64)
    sampled_idx[0] = 0
    sampled_idx[-1] = n - 1
    a = 0

    for i in range(n_out - 2):
        b_start = int(np.floor(i * bin_size) + 1)
        b_end   = int(np.floor((i + 1) * bin_size) + 1)
        b_end   = min(b_end, n - 1)
        c_start = int(np.floor((i + 1) * bin_size) + 1)
        c_end   = int(np.floor((i + 2) * bin_size) + 1)
        c_end   = min(c_end, n)

        if c_end > c_start:
            cx = x[c_start:c_end].mean()
            cy = y[c_start:c_end].mean()
        else:
            cx = x[-1]
            cy = y[-1]

        xs = x[b_start:b_end]
        ys = y[b_start:b_end]
        areas = np.abs(
            x[a] * (ys - cy) + xs * (cy - y[a]) + cx * (y[a] - ys)
        )
        pick = b_start + int(np.argmax(areas))
        sampled_idx[i + 1] = pick
        a = pick

    return sampled_idx
