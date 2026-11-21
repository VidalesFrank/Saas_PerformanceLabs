"""Catalogo de perfiles AISC v15.0 (W, HSS rect, HSS round / Pipe).

Datos propiedades geometricas extraidas del AISC Shape Database v15.0 (unidades
imperiales) y convertidas a SI (mm, mm^2, mm^3, mm^4). La estructura esta
disenada para extenderse facilmente a toda la base AISC importando el CSV
oficial (columna por columna) mediante `load_aisc_csv()`.

Convencion AISC de ejes locales:
    x = eje fuerte (direccion de la mayor inercia)
    y = eje debil
Se usan sufijos: Ix, Iy, Zx, Zy, Sx, Sy, rx, ry, J.

Unidades del catalogo (SI):
    - A         [mm^2]
    - Ix, Iy, J [mm^4]
    - Sx, Sy, Zx, Zy [mm^3]
    - rx, ry, d, bf, tw, tf, t_des [mm]

Notas:
    - Catalogo MVP con ~20 perfiles representativos. Para la base completa
      (273 W-shapes + 113 HSS-rect + 39 HSS-round, etc.) importar el CSV
      oficial AISC v15.0 con `load_aisc_csv()`.
    - Los t_des ("design thickness") para HSS son 0.93*t_nominal segun AISC
      Specification 2.2 (correccion por tolerancia de produccion).
"""
from __future__ import annotations

import csv
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


# ─────────────────────────────────────────────────────────────────────────────
# Conversion imperial → SI
# ─────────────────────────────────────────────────────────────────────────────
IN_TO_MM     = 25.4
IN2_TO_MM2   = IN_TO_MM ** 2          # 645.16
IN3_TO_MM3   = IN_TO_MM ** 3          # 16387.064
IN4_TO_MM4   = IN_TO_MM ** 4          # 416231.4256
LBFT_TO_KGM  = 1.4881639


class ShapeType(str, Enum):
    W         = "W"           # W-shape (wide-flange, I)
    M         = "M"           # M-shape (miscellaneous light I)
    S         = "S"           # S-shape (american standard)
    HP        = "HP"          # HP pile
    HSS_RECT  = "HSS_RECT"    # rectangular / square HSS
    HSS_ROUND = "HSS_ROUND"   # round HSS
    PIPE      = "PIPE"        # steel pipe (std / x-strong)
    L         = "L"           # single angle
    C         = "C"           # american standard channel
    MC        = "MC"          # miscellaneous channel
    WT        = "WT"          # structural tee cut from W
    T2L       = "2L"          # double angle


@dataclass(frozen=True)
class SteelShape:
    """Propiedades geometricas de un perfil AISC en unidades SI (mm).

    Todos los campos son opcionales salvo los que identifican el perfil para
    hacer el catalogo extensible a formas que no los requieren todos
    (p.ej. HSS redondo no tiene bf/tf separados).
    """

    name: str
    type: ShapeType
    weight_kgm: float       # peso por unidad de longitud [kg/m]
    A:         float        # area bruta [mm^2]
    Ix:        float        # inercia eje fuerte [mm^4]
    Iy:        float        # inercia eje debil [mm^4]
    Zx:        float        # modulo plastico eje fuerte [mm^3]
    Zy:        float        # modulo plastico eje debil [mm^3]
    Sx:        float        # modulo elastico eje fuerte [mm^3]
    Sy:        float        # modulo elastico eje debil [mm^3]
    rx:        float        # radio de giro eje fuerte [mm]
    ry:        float        # radio de giro eje debil [mm]
    J:         float        # constante torsional [mm^4]
    # Dimensiones (todas en mm, algunas aplican solo a ciertos tipos)
    d:         float = 0.0  # peralte (W, S, M, C, HP, HSS rect: lado largo)
    bf:        float = 0.0  # ancho de aleta (W, S, M, C; HSS rect: lado corto)
    tw:        float = 0.0  # espesor de alma
    tf:        float = 0.0  # espesor de aleta
    t_des:     float = 0.0  # espesor de diseno (HSS: 0.93*t_nom)
    OD:        float = 0.0  # diametro exterior (HSS round, Pipe)
    # Flags/metadata
    seismically_compact: bool = False  # cumple AISC 341-16 Tabla D1.1 (λhd)


# ─────────────────────────────────────────────────────────────────────────────
# Helpers de construccion desde valores imperiales
# ─────────────────────────────────────────────────────────────────────────────

def _w(
    name: str, weight_lbft: float,
    d_in: float, bf_in: float, tw_in: float, tf_in: float,
    A_in2: float, Ix_in4: float, Iy_in4: float,
    Zx_in3: float, Zy_in3: float, Sx_in3: float, Sy_in3: float,
    rx_in: float, ry_in: float, J_in4: float,
) -> SteelShape:
    return SteelShape(
        name=name, type=ShapeType.W,
        weight_kgm=weight_lbft * LBFT_TO_KGM,
        A =A_in2 * IN2_TO_MM2,
        Ix=Ix_in4 * IN4_TO_MM4, Iy=Iy_in4 * IN4_TO_MM4,
        Zx=Zx_in3 * IN3_TO_MM3, Zy=Zy_in3 * IN3_TO_MM3,
        Sx=Sx_in3 * IN3_TO_MM3, Sy=Sy_in3 * IN3_TO_MM3,
        rx=rx_in * IN_TO_MM, ry=ry_in * IN_TO_MM,
        J =J_in4 * IN4_TO_MM4,
        d=d_in * IN_TO_MM, bf=bf_in * IN_TO_MM,
        tw=tw_in * IN_TO_MM, tf=tf_in * IN_TO_MM,
    )


def _hss_rect(
    name: str, weight_lbft: float,
    H_in: float, B_in: float, t_nom_in: float,
    A_in2: float, Ix_in4: float, Iy_in4: float,
    Zx_in3: float, Zy_in3: float, Sx_in3: float, Sy_in3: float,
    rx_in: float, ry_in: float, J_in4: float,
) -> SteelShape:
    return SteelShape(
        name=name, type=ShapeType.HSS_RECT,
        weight_kgm=weight_lbft * LBFT_TO_KGM,
        A =A_in2 * IN2_TO_MM2,
        Ix=Ix_in4 * IN4_TO_MM4, Iy=Iy_in4 * IN4_TO_MM4,
        Zx=Zx_in3 * IN3_TO_MM3, Zy=Zy_in3 * IN3_TO_MM3,
        Sx=Sx_in3 * IN3_TO_MM3, Sy=Sy_in3 * IN3_TO_MM3,
        rx=rx_in * IN_TO_MM, ry=ry_in * IN_TO_MM,
        J =J_in4 * IN4_TO_MM4,
        d=H_in * IN_TO_MM, bf=B_in * IN_TO_MM,
        t_des=(0.93 * t_nom_in) * IN_TO_MM,
    )


def _pipe(
    name: str, weight_lbft: float,
    OD_in: float, t_nom_in: float,
    A_in2: float, I_in4: float, Z_in3: float, S_in3: float,
    r_in: float, J_in4: float,
) -> SteelShape:
    OD_mm = OD_in * IN_TO_MM
    return SteelShape(
        name=name, type=ShapeType.PIPE,
        weight_kgm=weight_lbft * LBFT_TO_KGM,
        A =A_in2 * IN2_TO_MM2,
        Ix=I_in4 * IN4_TO_MM4, Iy=I_in4 * IN4_TO_MM4,
        Zx=Z_in3 * IN3_TO_MM3, Zy=Z_in3 * IN3_TO_MM3,
        Sx=S_in3 * IN3_TO_MM3, Sy=S_in3 * IN3_TO_MM3,
        rx=r_in * IN_TO_MM, ry=r_in * IN_TO_MM,
        J =J_in4 * IN4_TO_MM4,
        OD=OD_mm, t_des=(0.93 * t_nom_in) * IN_TO_MM,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Catalogo MVP (AISC v15.0 Shape Database — subset)
# ─────────────────────────────────────────────────────────────────────────────
# Para extender al catalogo completo (273 W + 113 HSS-rect + 39 HSS-round
# + angulos, canales, WT, etc.), importar el CSV oficial con `load_aisc_csv`.
AISC_V15_SHAPES: dict[str, SteelShape] = {
    # ── W-shapes para vigas ───────────────────────────────────────────────
    "W12X26": _w("W12X26", 26.0, 12.2, 6.49, 0.230, 0.380,
                 7.65, 204.0, 17.3, 37.2, 8.17, 33.4, 5.34, 5.17, 1.51, 0.300),
    "W14X22": _w("W14X22", 22.0, 13.7, 5.00, 0.230, 0.335,
                 6.49, 199.0, 7.00, 33.2, 4.39, 29.0, 2.80, 5.54, 1.04, 0.208),
    "W14X30": _w("W14X30", 30.0, 13.8, 6.73, 0.270, 0.385,
                 8.85, 291.0, 19.6, 47.3, 8.99, 42.0, 5.82, 5.73, 1.49, 0.380),
    "W18X35": _w("W18X35", 35.0, 17.7, 6.00, 0.300, 0.425,
                 10.3, 510.0, 15.3, 66.5, 8.06, 57.6, 5.12, 7.04, 1.22, 0.506),
    "W18X50": _w("W18X50", 50.0, 18.0, 7.50, 0.355, 0.570,
                 14.7, 800.0, 40.1, 101.0, 16.6, 88.9, 10.7, 7.38, 1.65, 1.24),
    "W21X44": _w("W21X44", 44.0, 20.7, 6.50, 0.350, 0.450,
                 13.0, 843.0, 20.7, 95.4, 10.2, 81.6, 6.37, 8.06, 1.26, 0.770),
    "W21X62": _w("W21X62", 62.0, 21.0, 8.24, 0.400, 0.615,
                 18.3, 1330.0, 57.5, 144.0, 21.7, 127.0, 13.9, 8.54, 1.77, 1.83),
    "W24X55": _w("W24X55", 55.0, 23.6, 7.005, 0.395, 0.505,
                 16.2, 1350.0, 29.1, 134.0, 12.6, 114.0, 8.30, 9.11, 1.34, 1.18),
    "W24X76": _w("W24X76", 76.0, 23.9, 8.99, 0.440, 0.680,
                 22.4, 2100.0, 82.5, 200.0, 28.6, 176.0, 18.4, 9.69, 1.92, 2.68),
    "W27X84": _w("W27X84", 84.0, 26.7, 9.96, 0.460, 0.640,
                 24.7, 2850.0, 106.0, 244.0, 33.2, 213.0, 21.2, 10.7, 2.07, 2.81),

    # ── W-shapes para columnas (anchos ~= aleta) ─────────────────────────
    "W12X50":  _w("W12X50",  50.0, 12.2, 8.08, 0.370, 0.640,
                  14.6, 391.0, 56.3, 71.9, 21.3, 64.2, 13.9, 5.18, 1.96, 1.71),
    "W12X65":  _w("W12X65",  65.0, 12.1, 12.0, 0.390, 0.605,
                  19.1, 533.0, 174.0, 96.8, 44.1, 87.9, 29.1, 5.28, 3.02, 2.18),
    "W14X53":  _w("W14X53",  53.0, 13.9, 8.06, 0.370, 0.660,
                  15.6, 541.0, 57.7, 87.1, 22.0, 77.8, 14.3, 5.89, 1.92, 1.94),
    "W14X82":  _w("W14X82",  82.0, 14.3, 10.1, 0.510, 0.855,
                  24.0, 881.0, 148.0, 139.0, 44.8, 123.0, 29.3, 6.05, 2.48, 5.07),
    "W14X90":  _w("W14X90",  90.0, 14.0, 14.5, 0.440, 0.710,
                  26.5, 999.0, 362.0, 157.0, 75.6, 143.0, 49.9, 6.14, 3.70, 4.06),
    "W14X120": _w("W14X120", 120.0, 14.5, 14.7, 0.590, 0.940,
                  35.3, 1380.0, 495.0, 212.0, 102.0, 190.0, 67.5, 6.24, 3.74, 9.37),

    # ── HSS rectangulares / cuadrados (A500 Gr.C) ─────────────────────────
    "HSS6X6X3/8":   _hss_rect("HSS6X6X3/8",   27.4, 6.0, 6.0, 0.375,
                              7.58, 37.4, 37.4, 14.9, 14.9, 12.5, 12.5,
                              2.22, 2.22, 60.1),
    "HSS8X8X1/2":   _hss_rect("HSS8X8X1/2",   48.9, 8.0, 8.0, 0.500,
                              13.5, 125.0, 125.0, 37.5, 37.5, 31.2, 31.2,
                              3.03, 3.03, 226.0),
    "HSS10X10X1/2": _hss_rect("HSS10X10X1/2", 62.5, 10.0, 10.0, 0.500,
                              17.2, 256.0, 256.0, 59.5, 59.5, 51.2, 51.2,
                              3.86, 3.86, 454.0),
    "HSS12X12X1/2": _hss_rect("HSS12X12X1/2", 76.1, 12.0, 12.0, 0.500,
                              21.0, 432.0, 432.0, 90.1, 90.1, 71.9, 71.9,
                              4.53, 4.53, 748.0),

    # ── Pipes (HSS round A500 Gr.B) ──────────────────────────────────────
    "PIPE8STD":  _pipe("PIPE8STD",  28.6, 8.625, 0.322,
                       7.85, 63.3, 18.2, 14.7, 2.84, 126.0),
    "PIPE10STD": _pipe("PIPE10STD", 40.5, 10.75, 0.365,
                       11.5, 151.0, 34.0, 28.1, 3.63, 303.0),
}


def get_shape(name: str) -> SteelShape:
    """Lookup por nombre. Normaliza a MAYUSCULAS y acepta tanto 'W24X55'
    como 'W24x55'. Eleva KeyError con lista de opciones si no existe."""
    key = name.upper().replace(" ", "")
    if key not in AISC_V15_SHAPES:
        raise KeyError(
            f"Perfil '{name}' no esta en el catalogo AISC v15 cargado. "
            f"Disponibles ({len(AISC_V15_SHAPES)}): {sorted(AISC_V15_SHAPES)}"
        )
    return AISC_V15_SHAPES[key]


def list_shapes(shape_type: ShapeType | None = None) -> list[str]:
    """Devuelve la lista de nombres disponibles; filtra por tipo si se indica."""
    if shape_type is None:
        return sorted(AISC_V15_SHAPES)
    return sorted(k for k, s in AISC_V15_SHAPES.items() if s.type == shape_type)


# ─────────────────────────────────────────────────────────────────────────────
# Loader CSV AISC v15.0 (para completar el catalogo con la base oficial)
# ─────────────────────────────────────────────────────────────────────────────

def load_aisc_csv(csv_path: str | Path, *, units: str = "imperial") -> int:
    """Carga perfiles desde el CSV oficial AISC v15.0.

    El CSV oficial tiene columnas AISC_Manual_Label, Type, W (weight), A,
    d, bf, tw, tf, Ix, Iy, Zx, Zy, Sx, Sy, rx, ry, J, ... Si `units='imperial'`
    los valores se convierten a SI automaticamente. Si `units='si'` se asumen
    ya en unidades SI (mm, mm^2, etc.).

    Returns:
        numero de perfiles agregados al catalogo.
    """
    path = Path(csv_path)
    added = 0
    with path.open() as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            name = row.get("AISC_Manual_Label", "").upper().strip()
            type_raw = row.get("Type", "").strip().upper()
            if not name or not type_raw:
                continue
            try:
                stype = ShapeType(type_raw)
            except ValueError:
                continue  # tipo no soportado todavia

            def _f(key: str) -> float:
                try:
                    return float(row.get(key, "") or 0.0)
                except ValueError:
                    return 0.0

            c_a  = IN2_TO_MM2 if units == "imperial" else 1.0
            c_i  = IN4_TO_MM4 if units == "imperial" else 1.0
            c_z  = IN3_TO_MM3 if units == "imperial" else 1.0
            c_r  = IN_TO_MM   if units == "imperial" else 1.0
            c_w  = LBFT_TO_KGM if units == "imperial" else 1.0

            shape = SteelShape(
                name=name, type=stype,
                weight_kgm=_f("W") * c_w,
                A =_f("A") * c_a,
                Ix=_f("Ix") * c_i, Iy=_f("Iy") * c_i,
                Zx=_f("Zx") * c_z, Zy=_f("Zy") * c_z,
                Sx=_f("Sx") * c_z, Sy=_f("Sy") * c_z,
                rx=_f("rx") * c_r, ry=_f("ry") * c_r,
                J =_f("J") * c_i,
                d =_f("d") * c_r, bf=_f("bf") * c_r,
                tw=_f("tw") * c_r, tf=_f("tf") * c_r,
                t_des=_f("tdes") * c_r,
                OD=_f("OD") * c_r,
            )
            AISC_V15_SHAPES[name] = shape
            added += 1
    return added
