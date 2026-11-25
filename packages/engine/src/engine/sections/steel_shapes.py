"""Catalogo de perfiles metalicos: AISC v15.0 (W, HSS, Pipe) + Europeos
(IPE, HEA, HEB, HEM DIN 1025) + Colombianos (PTE rectangular, PHR redondo
con espesor parametrizado por el usuario).

Datos geometricos AISC: AISC Shape Database v15.0 (imperial -> SI).
Datos europeos: tablas DIN 1025-3 (HEB) / DIN 1025-5 (IPE, HEA, HEM) /
EN 10034, propiedades nominales publicadas.
Datos colombianos: NSR-10 F.2 / catalogos Perfitec, Acesco; para PTE/PHR
el catalogo solo lista las dimensiones nominales exteriores y el usuario
elige el espesor; las propiedades (A, I, J, Z, S) se calculan al vuelo
en `make_pte()` / `make_phr()`.

Convencion AISC de ejes locales:
    x = eje fuerte (direccion de la mayor inercia)
    y = eje debil
Se usan sufijos: Ix, Iy, Zx, Zy, Sx, Sy, rx, ry, J.

Convencion europea DIN (y-y fuerte, z-z debil) se mapea a AISC:
    Iy(EU) -> Ix(AISC) ; Iz(EU) -> Iy(AISC).

Unidades del catalogo (SI):
    - A         [mm^2]
    - Ix, Iy, J [mm^4]
    - Sx, Sy, Zx, Zy [mm^3]
    - rx, ry, d, bf, tw, tf, t_des [mm]

Notas:
    - AISC MVP con ~20 perfiles; extensible via `load_aisc_csv()` oficial.
    - Los t_des ("design thickness") para HSS son 0.93*t_nominal segun AISC
      Specification 2.2 (correccion por tolerancia de produccion).
    - PTE/PHR aceptan cualquier espesor positivo via factory; el catalogo
      publica tambien espesores sugeridos por fabricante.
"""
from __future__ import annotations

import csv
import math
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

DENSITY_STEEL_KG_M3 = 7850.0   # densidad acero estructural para masas computadas


# ─────────────────────────────────────────────────────────────────────────────
# Conversion imperial → SI
# ─────────────────────────────────────────────────────────────────────────────
IN_TO_MM     = 25.4
IN2_TO_MM2   = IN_TO_MM ** 2          # 645.16
IN3_TO_MM3   = IN_TO_MM ** 3          # 16387.064
IN4_TO_MM4   = IN_TO_MM ** 4          # 416231.4256
LBFT_TO_KGM  = 1.4881639


class ShapeType(str, Enum):
    # ── AISC (imperial, DB v15.0) ────────────────────────────────────────
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
    # ── Europeos (DIN 1025 / EN 10034, serie metrica) ────────────────────
    IPE       = "IPE"         # European I-beam (viga): flange paralelo
    HEA       = "HEA"         # European Wide Flange, serie ligera
    HEB       = "HEB"         # European Wide Flange, serie estandar
    HEM       = "HEM"         # European Wide Flange, serie reforzada
    # ── Colombianos (NSR-10 F.2, Perfitec / Acesco) ──────────────────────
    PTE       = "PTE"         # Perfil Tubular Estructural rectangular
    PHR       = "PHR"         # Perfil Hueco Redondo


# Familias de geometria (para discretizacion de fibras y compatibilidad AISC):
I_SHAPE_TYPES        = frozenset({
    ShapeType.W, ShapeType.S, ShapeType.M, ShapeType.HP,
    ShapeType.IPE, ShapeType.HEA, ShapeType.HEB, ShapeType.HEM,
})
BOX_SHAPE_TYPES      = frozenset({ShapeType.HSS_RECT, ShapeType.PTE})
ROUND_TUBE_TYPES     = frozenset({ShapeType.HSS_ROUND, ShapeType.PIPE, ShapeType.PHR})
PARAMETRIC_T_TYPES   = frozenset({ShapeType.PTE, ShapeType.PHR})  # espesor user-adjustable


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
# Factory para perfiles europeos DIN 1025 (datos nominales en SI metrico).
# ─────────────────────────────────────────────────────────────────────────────

_CM2_TO_MM2 = 100.0
_CM3_TO_MM3 = 1000.0
_CM4_TO_MM4 = 1.0e4
_CM_TO_MM   = 10.0


def _din_i(
    name: str, shape_type: ShapeType, weight_kgm: float,
    d_mm: float, bf_mm: float, tw_mm: float, tf_mm: float,
    A_cm2:  float,
    Iy_cm4: float, Iz_cm4: float,
    Wply_cm3: float, Wplz_cm3: float,
    Wely_cm3: float, Welz_cm3: float,
    iy_cm: float, iz_cm: float, It_cm4: float,
) -> SteelShape:
    """Factory para IPE/HEA/HEB/HEM con dimensiones y propiedades DIN 1025.

    Convencion europea (DIN): y-y = eje fuerte, z-z = eje debil.
    Mapeo a convencion AISC usada en SteelShape:
        Ix(AISC) <- Iy(EU)  (eje fuerte, mayor inercia)
        Iy(AISC) <- Iz(EU)  (eje debil)
        Zx       <- Wpl,y   ;  Zy <- Wpl,z
        Sx       <- Wel,y   ;  Sy <- Wel,z
        rx       <- iy      ;  ry <- iz
        J        <- It      (constante de torsion uniforme)
    """
    return SteelShape(
        name=name, type=shape_type, weight_kgm=weight_kgm,
        A =A_cm2  * _CM2_TO_MM2,
        Ix=Iy_cm4 * _CM4_TO_MM4,
        Iy=Iz_cm4 * _CM4_TO_MM4,
        Zx=Wply_cm3 * _CM3_TO_MM3,
        Zy=Wplz_cm3 * _CM3_TO_MM3,
        Sx=Wely_cm3 * _CM3_TO_MM3,
        Sy=Welz_cm3 * _CM3_TO_MM3,
        rx=iy_cm * _CM_TO_MM,
        ry=iz_cm * _CM_TO_MM,
        J =It_cm4 * _CM4_TO_MM4,
        d=d_mm, bf=bf_mm, tw=tw_mm, tf=tf_mm,
    )


# ─────────────────────────────────────────────────────────────────────────────
# Factories parametricas PTE/PHR (espesor seleccionado por el usuario).
# ─────────────────────────────────────────────────────────────────────────────

def make_pte(d_mm: float, b_mm: float, t_mm: float) -> SteelShape:
    """Perfil Tubular Estructural rectangular (PTE) con espesor libre.

    Modelo idealizado: tubo rectangular hueco de pared constante t, esquinas
    exteriores sin redondeo. Propiedades:
        A  = d*b - (d-2t)*(b-2t)
        Ix = (b*d^3 - (b-2t)*(d-2t)^3)/12      (eje fuerte, perpendicular a d)
        Iy = (d*b^3 - (d-2t)*(b-2t)^3)/12
        Zx = (b*d^2 - (b-2t)*(d-2t)^2)/4
        Zy = (d*b^2 - (d-2t)*(b-2t)^2)/4
        J  = 4*A_enc^2*t / p_enc   (Bredt para seccion cerrada de pared delgada,
                                    A_enc y p_enc tomados sobre la linea media)

    Nomenclatura: `PTE-<d>x<b>x<t>` con `t` sin cero final. Ej. PTE-100x50x3,
    PTE-200x100x4.5.
    """
    if d_mm <= 0 or b_mm <= 0 or t_mm <= 0:
        raise ValueError(f"PTE: dimensiones positivas requeridas (d={d_mm}, b={b_mm}, t={t_mm})")
    if 2.0 * t_mm >= min(d_mm, b_mm):
        raise ValueError(
            f"PTE: espesor t={t_mm} mm invalido para d={d_mm}x{b_mm} "
            "(2t >= lado menor). Usa un espesor menor."
        )

    d_in = d_mm - 2.0 * t_mm
    b_in = b_mm - 2.0 * t_mm
    A    = d_mm * b_mm - d_in * b_in
    Ix   = (b_mm * d_mm**3 - b_in * d_in**3) / 12.0
    Iy   = (d_mm * b_mm**3 - d_in * b_in**3) / 12.0
    Sx   = Ix / (d_mm / 2.0)
    Sy   = Iy / (b_mm / 2.0)
    Zx   = (b_mm * d_mm**2 - b_in * d_in**2) / 4.0
    Zy   = (d_mm * b_mm**2 - d_in * b_in**2) / 4.0
    rx   = math.sqrt(Ix / A)
    ry   = math.sqrt(Iy / A)
    # Bredt-Batho para seccion cerrada de pared delgada:
    d_mid = d_mm - t_mm
    b_mid = b_mm - t_mm
    A_enc = d_mid * b_mid
    p_enc = 2.0 * (d_mid + b_mid)
    J     = 4.0 * A_enc**2 * t_mm / p_enc
    weight_kgm = DENSITY_STEEL_KG_M3 * (A * 1.0e-6)

    t_tag = _format_thickness(t_mm)
    name = f"PTE-{_int_or_float(d_mm)}x{_int_or_float(b_mm)}x{t_tag}"

    return SteelShape(
        name=name, type=ShapeType.PTE, weight_kgm=weight_kgm,
        A=A, Ix=Ix, Iy=Iy, Zx=Zx, Zy=Zy, Sx=Sx, Sy=Sy,
        rx=rx, ry=ry, J=J,
        d=d_mm, bf=b_mm, t_des=t_mm,
    )


def make_phr(OD_mm: float, t_mm: float) -> SteelShape:
    """Perfil Hueco Redondo (PHR) colombiano con espesor libre.

    Tuberia estructural circular hueca con pared constante t.
        A  = pi/4 * (OD^2 - ID^2)
        I  = pi/64 * (OD^4 - ID^4)       (Ix = Iy por simetria)
        S  = I / (OD/2)
        Z  = (OD^3 - ID^3)/6              (plastico, seccion anular)
        J  = 2*I                          (polar = 2*I para seccion circular)

    Nomenclatura: `PHR-<OD>x<t>`. Ej. PHR-100x3, PHR-75x2.5.
    """
    if OD_mm <= 0 or t_mm <= 0:
        raise ValueError(f"PHR: dimensiones positivas requeridas (OD={OD_mm}, t={t_mm})")
    if 2.0 * t_mm >= OD_mm:
        raise ValueError(
            f"PHR: espesor t={t_mm} mm invalido para OD={OD_mm} (2t >= OD)."
        )

    ID = OD_mm - 2.0 * t_mm
    A  = math.pi * (OD_mm**2 - ID**2) / 4.0
    I  = math.pi * (OD_mm**4 - ID**4) / 64.0
    S  = I / (OD_mm / 2.0)
    Z  = (OD_mm**3 - ID**3) / 6.0
    r  = math.sqrt(I / A)
    J  = 2.0 * I
    weight_kgm = DENSITY_STEEL_KG_M3 * (A * 1.0e-6)

    t_tag = _format_thickness(t_mm)
    name = f"PHR-{_int_or_float(OD_mm)}x{t_tag}"

    return SteelShape(
        name=name, type=ShapeType.PHR, weight_kgm=weight_kgm,
        A=A, Ix=I, Iy=I, Zx=Z, Zy=Z, Sx=S, Sy=S,
        rx=r, ry=r, J=J,
        OD=OD_mm, t_des=t_mm,
    )


def _format_thickness(t_mm: float) -> str:
    """Formato compacto para espesor: `3` si es entero, `2.5` en otro caso."""
    if abs(t_mm - round(t_mm)) < 1e-6:
        return str(int(round(t_mm)))
    return f"{t_mm:g}"


def _int_or_float(x: float) -> str:
    """Entero sin punto si es exacto, decimal en otro caso (p.ej. 63.5)."""
    if abs(x - round(x)) < 1e-6:
        return str(int(round(x)))
    return f"{x:g}"


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


# ─────────────────────────────────────────────────────────────────────────────
# Catalogos europeos DIN 1025 (IPE, HEA, HEB, HEM).
# Unidades de las tablas: h,bf,tw,tf [mm]; A [cm^2]; Iy,Iz,It [cm^4]; Wply,Wplz,
# Wely,Welz [cm^3]; iy,iz [cm]; mass [kg/m]. Convencion europea y-y fuerte.
# Los helpers `_din_i(...)` mapean a convencion AISC usada internamente.
# ─────────────────────────────────────────────────────────────────────────────

# Tuple compacto: (h, bf, tw, tf, A, Iy, Iz, Wply, Wplz, Wely, Welz, iy, iz, It, mass)
_IPE_TABLE: list[tuple[int, int, float, float, float, float, float,
                        float, float, float, float, float, float, float, float]] = [
    (80,   46,  3.8,  5.2,   7.64,    80.14,    8.49,   23.22,  5.818,   20.03,  3.691, 3.24, 1.054,   0.698,   6.00),
    (100,  55,  4.1,  5.7,  10.3,    171.0,    15.92,  39.41,   9.146,   34.20,  5.789, 4.07, 1.244,   1.198,   8.10),
    (120,  64,  4.4,  6.3,  13.21,   317.8,    27.67,  60.73,  13.58,    52.96,  8.649, 4.90, 1.448,   1.741,  10.40),
    (140,  73,  4.7,  6.9,  16.43,   541.2,    44.92,  88.34,  19.25,    77.32, 12.31,  5.74, 1.653,   2.451,  12.90),
    (160,  82,  5.0,  7.4,  20.09,   869.3,    68.31, 123.9,   26.10,   108.7,  16.66,  6.58, 1.844,   3.597,  15.80),
    (180,  91,  5.3,  8.0,  23.95,  1317.0,   100.9,  166.4,   34.60,   146.3,  22.16,  7.42, 2.053,   4.792,  18.80),
    (200, 100,  5.6,  8.5,  28.48,  1943.0,   142.4,  220.6,   44.61,   194.3,  28.47,  8.26, 2.235,   6.980,  22.40),
    (220, 110,  5.9,  9.2,  33.37,  2772.0,   204.9,  285.4,   58.11,   252.0,  37.25,  9.11, 2.479,   9.075,  26.20),
    (240, 120,  6.2,  9.8,  39.12,  3892.0,   283.6,  366.6,   73.92,   324.3,  47.27,  9.97, 2.692,  12.879,  30.70),
    (270, 135,  6.6, 10.2,  45.95,  5790.0,   419.9,  484.0,   96.95,   428.9,  62.20, 11.23, 3.020,  15.941,  36.10),
    (300, 150,  7.1, 10.7,  53.81,  8356.0,   603.8,  628.4,  125.2,    557.1,  80.50, 12.46, 3.351,  20.119,  42.20),
    (330, 160,  7.5, 11.5,  62.61, 11770.0,   788.1,  804.3,  153.7,    713.1,  98.52, 13.71, 3.547,  28.146,  49.10),
    (360, 170,  8.0, 12.7,  72.73, 16270.0,  1043.0, 1019.0,  191.1,    903.6, 122.8,  14.95, 3.787,  37.317,  57.10),
    (400, 180,  8.6, 13.5,  84.46, 23130.0,  1318.0, 1307.0,  229.0,   1156.0, 146.4,  16.55, 3.951,  51.081,  66.30),
    (450, 190,  9.4, 14.6,  98.82, 33740.0,  1676.0, 1702.0,  276.4,   1500.0, 176.4,  18.48, 4.121,  66.871,  77.60),
    (500, 200, 10.2, 16.0, 115.5,  48200.0,  2142.0, 2194.0,  335.9,   1928.0, 214.2,  20.43, 4.306,  89.291,  90.70),
    (550, 210, 11.1, 17.2, 134.4,  67120.0,  2668.0, 2787.0,  400.5,   2441.0, 254.1,  22.35, 4.454, 123.215, 106.00),
    (600, 220, 12.0, 19.0, 156.0,  92080.0,  3387.0, 3512.0,  485.6,   3069.0, 307.9,  24.30, 4.656, 165.400, 122.00),
]

# HEA — DIN 1025-5 (European Wide Flange, serie ligera)
_HEA_TABLE: list[tuple[int, int, float, float, float, float, float,
                        float, float, float, float, float, float, float, float]] = [
    (100,  96, 100,  5.0,  8.0,  21.24,   349.2,   133.8,   83.01,  41.14,   72.76,  26.76, 4.06, 2.51,   5.24,  16.70),  # type: ignore
]  # placeholder — se reemplaza inmediatamente abajo con la tupla correcta

_HEA_TABLE = [
    # (h, bf, tw, tf, A, Iy, Iz, Wply, Wplz, Wely, Welz, iy, iz, It, mass)
    ( 96, 100,  5.0,  8.0,  21.24,    349.2,    133.8,    83.01,   41.14,    72.76,   26.76,  4.06, 2.51,    5.24,  16.70),
    (114, 120,  5.0,  8.0,  25.34,    606.2,    230.9,   119.5,    58.85,   106.3,    38.48,  4.89, 3.02,    5.99,  19.90),
    (133, 140,  5.5,  8.5,  31.42,   1033.0,    389.3,   173.5,    84.85,   155.4,    55.62,  5.73, 3.52,    8.13,  24.70),
    (152, 160,  6.0,  9.0,  38.77,   1673.0,    615.6,   245.1,   117.6,    220.1,    76.95,  6.57, 3.98,   12.19,  30.40),
    (171, 180,  6.0,  9.5,  45.25,   2510.0,    924.6,   324.9,   156.5,    293.6,   102.7,   7.45, 4.52,   14.80,  35.50),
    (190, 200,  6.5, 10.0,  53.83,   3692.0,   1336.0,   429.5,   203.8,    388.6,   133.6,   8.28, 4.98,   20.98,  42.30),
    (210, 220,  7.0, 11.0,  64.34,   5410.0,   1955.0,   568.5,   270.6,    515.2,   177.7,   9.17, 5.51,   28.46,  50.50),
    (230, 240,  7.5, 12.0,  76.84,   7763.0,   2769.0,   744.6,   351.7,    675.1,   230.7,  10.05, 6.00,   41.55,  60.30),
    (250, 260,  7.5, 12.5,  86.82,  10450.0,   3668.0,   919.8,   430.2,    836.4,   282.1,  10.97, 6.50,   52.37,  68.20),
    (270, 280,  8.0, 13.0,  97.26,  13670.0,   4763.0,  1112.0,   518.1,   1013.0,   340.2,  11.86, 7.00,   62.10,  76.40),
    (290, 300,  8.5, 14.0, 112.5,   18260.0,   6310.0,  1383.0,   641.2,   1260.0,   420.6,  12.74, 7.49,   85.17,  88.30),
    (310, 300,  9.0, 15.5, 124.4,   22930.0,   6985.0,  1628.0,   709.7,   1479.0,   465.7,  13.58, 7.49,  108.0,   97.60),
    (330, 300,  9.5, 16.5, 133.5,   27690.0,   7436.0,  1850.0,   755.9,   1678.0,   495.7,  14.40, 7.46,  127.2,  104.80),
    (350, 300, 10.0, 17.5, 142.8,   33090.0,   7887.0,  2088.0,   802.3,   1891.0,   525.8,  15.22, 7.43,  148.8,  112.10),
    (390, 300, 11.0, 19.0, 159.0,   45070.0,   8564.0,  2562.0,   872.9,   2311.0,   571.0,  16.84, 7.34,  189.0,  125.00),
    (440, 300, 11.5, 21.0, 178.0,   63720.0,   9465.0,  3216.0,   965.5,   2896.0,   631.0,  18.92, 7.29,  243.8,  139.80),
    (490, 300, 12.0, 23.0, 197.5,   86970.0,  10370.0,  3949.0,  1059.0,   3550.0,   691.1,  21.00, 7.24,  309.3,  155.00),
    (540, 300, 12.5, 24.0, 211.8,  111900.0,  10820.0,  4622.0,  1107.0,   4146.0,   721.3,  22.99, 7.15,  351.7,  166.20),
    (590, 300, 13.0, 25.0, 226.5,  141200.0,  11270.0,  5350.0,  1156.0,   4787.0,   751.4,  24.97, 7.05,  397.8,  177.80),
]
# Nombre del perfil se forma como `HEA-100` donde 100 es el tag nominal de la serie.
_HEA_TAGS = [100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300,
             320, 340, 360, 400, 450, 500, 550, 600]

# HEB — DIN 1025-3 (European Wide Flange, serie estandar)
_HEB_TABLE: list[tuple[int, int, float, float, float, float, float,
                        float, float, float, float, float, float, float, float]] = [
    (100, 100,  6.0, 10.0,  26.04,    449.5,    167.3,   104.2,    51.42,    89.91,   33.45,  4.16, 2.53,    9.28,  20.40),
    (120, 120,  6.5, 11.0,  34.01,    864.4,    317.5,   165.2,    80.97,   144.1,    52.92,  5.04, 3.06,   13.84,  26.70),
    (140, 140,  7.0, 12.0,  42.96,   1509.0,    549.7,   245.4,   119.8,    215.6,    78.52,  5.93, 3.58,   20.06,  33.70),
    (160, 160,  8.0, 13.0,  54.25,   2492.0,    889.2,   354.0,   170.0,    311.5,   111.2,   6.78, 4.05,   31.24,  42.60),
    (180, 180,  8.5, 14.0,  65.25,   3831.0,   1363.0,   481.4,   231.0,    425.7,   151.4,   7.66, 4.57,   42.16,  51.20),
    (200, 200,  9.0, 15.0,  78.08,   5696.0,   2003.0,   642.5,   305.8,    569.6,   200.3,   8.54, 5.07,   59.28,  61.30),
    (220, 220,  9.5, 16.0,  91.04,   8091.0,   2843.0,   827.0,   393.9,    735.5,   258.5,   9.43, 5.59,   76.57,  71.50),
    (240, 240, 10.0, 17.0, 106.0,   11260.0,   3923.0,  1053.0,   498.4,    938.3,   326.9,  10.31, 6.08,  102.7,   83.20),
    (260, 260, 10.0, 17.5, 118.4,   14920.0,   5135.0,  1283.0,   602.2,   1148.0,   395.0,  11.22, 6.58,  123.8,   93.00),
    (280, 280, 10.5, 18.0, 131.4,   19270.0,   6595.0,  1534.0,   717.6,   1376.0,   471.0,  12.11, 7.09,  143.7,  103.10),
    (300, 300, 11.0, 19.0, 149.1,   25170.0,   8563.0,  1869.0,   870.1,   1678.0,   570.9,  12.99, 7.58,  185.0,  117.00),
    (320, 300, 11.5, 20.5, 161.3,   30820.0,   9239.0,  2149.0,   939.1,   1926.0,   615.9,  13.82, 7.57,  225.1,  126.70),
    (340, 300, 12.0, 21.5, 170.9,   36660.0,   9690.0,  2408.0,   985.7,   2156.0,   646.0,  14.65, 7.53,  257.2,  134.20),
    (360, 300, 12.5, 22.5, 180.6,   43190.0,  10140.0,  2683.0,  1032.0,   2400.0,   676.1,  15.46, 7.49,  292.5,  141.80),
    (400, 300, 13.5, 24.0, 197.8,   57680.0,  10820.0,  3232.0,  1104.0,   2884.0,   721.3,  17.08, 7.40,  355.7,  155.30),
    (450, 300, 14.0, 26.0, 218.0,   79890.0,  11720.0,  3982.0,  1197.0,   3551.0,   781.4,  19.14, 7.33,  440.5,  171.10),
    (500, 300, 14.5, 28.0, 238.6,  107200.0,  12620.0,  4815.0,  1292.0,   4287.0,   841.6,  21.19, 7.27,  538.4,  187.30),
    (550, 300, 15.0, 29.0, 254.1,  136700.0,  13080.0,  5591.0,  1341.0,   4971.0,   871.8,  23.20, 7.17,  600.3,  199.40),
    (600, 300, 15.5, 30.0, 270.0,  171000.0,  13530.0,  6425.0,  1391.0,   5701.0,   902.0,  25.17, 7.08,  667.2,  211.90),
]
_HEB_TAGS = _HEA_TAGS  # mismo esquema de tags 100..600

# HEM — DIN 1025-5 (European Wide Flange, serie reforzada)
_HEM_TABLE: list[tuple[int, int, float, float, float, float, float,
                        float, float, float, float, float, float, float, float]] = [
    (120, 106, 12.0, 20.0,  53.24,   1143.0,    399.2,   235.8,   116.3,    190.4,    75.32,  4.63, 2.74,   68.21,  41.80),
    (140, 126, 12.5, 21.0,  66.41,   2018.0,    702.8,   350.6,   171.6,    288.2,   111.6,   5.51, 3.25,   91.66,  52.10),
    (160, 146, 13.0, 22.0,  80.57,   3291.0,   1144.0,   493.8,   240.5,    411.4,   156.8,   6.39, 3.77,  120.1,   63.20),
    (180, 166, 14.0, 23.0,  97.05,   5098.0,   1759.0,   674.6,   325.5,    566.5,   211.9,   7.25, 4.26,  162.4,   76.20),
    (200, 186, 14.5, 24.0, 113.3,    7483.0,   2580.0,   883.4,   425.2,    748.3,   277.4,   8.13, 4.77,  203.3,   88.90),
    (220, 206, 15.0, 25.0, 131.3,   10640.0,   3651.0,  1135.0,   543.2,    967.4,   354.5,   9.00, 5.27,  259.4,  103.10),
    (240, 226, 15.5, 26.0, 149.4,   14600.0,   5012.0,  1419.0,   675.2,   1217.0,   443.5,   9.89, 5.79,  315.3,  117.30),
    (270, 248, 18.0, 32.0, 199.6,   24290.0,   8153.0,  2117.0,  1006.0,   1799.0,   657.5,  11.03, 6.39,  625.5,  156.70),
    (290, 268, 18.0, 32.5, 219.6,   31310.0,  10450.0,  2524.0,  1192.0,   2159.0,   779.7,  11.94, 6.90,  719.0,  172.40),
    (310, 288, 18.5, 33.0, 240.2,   39550.0,  13160.0,  2966.0,  1397.0,   2551.0,   913.9,  12.83, 7.40,  807.3,  188.50),
    (340, 310, 21.0, 39.0, 303.1,   59200.0,  19400.0,  4078.0,  1913.0,   3482.0,  1252.0,  13.97, 7.95, 1408.0,  237.90),
    (359, 309, 21.0, 40.0, 312.0,   68130.0,  19710.0,  4435.0,  1951.0,   3796.0,  1276.0,  14.78, 7.95, 1515.0,  244.90),
    (377, 309, 21.0, 40.0, 315.8,   76370.0,  19710.0,  4718.0,  1953.0,   4052.0,  1276.0,  15.55, 7.90, 1555.0,  247.90),
    (395, 308, 21.0, 40.0, 318.8,   84870.0,  19520.0,  4989.0,  1942.0,   4297.0,  1268.0,  16.32, 7.83, 1592.0,  250.30),
    (432, 307, 21.0, 40.0, 325.8,  104100.0,  19340.0,  5571.0,  1934.0,   4820.0,  1260.0,  17.88, 7.70, 1660.0,  255.70),
    (478, 307, 21.0, 40.0, 335.4,  131500.0,  19340.0,  6331.0,  1938.0,   5501.0,  1260.0,  19.80, 7.59, 1729.0,  263.20),
    (524, 306, 21.0, 40.0, 344.3,  161900.0,  19150.0,  7094.0,  1932.0,   6180.0,  1251.0,  21.69, 7.46, 1786.0,  270.30),
    (572, 306, 21.0, 40.0, 354.4,  198000.0,  19160.0,  7933.0,  1937.0,   6923.0,  1252.0,  23.63, 7.35, 1844.0,  278.20),
    (620, 305, 21.0, 40.0, 363.7,  237400.0,  18980.0,  8772.0,  1930.0,   7660.0,  1245.0,  25.55, 7.22, 1899.0,  285.50),
]
_HEM_TAGS = _HEA_TAGS


def _build_din_catalog(
    tags: list[int], table: list[tuple], shape_type: ShapeType, prefix: str,
) -> dict[str, SteelShape]:
    out: dict[str, SteelShape] = {}
    assert len(tags) == len(table), (
        f"{prefix}: {len(tags)} tags vs {len(table)} filas (desajuste tabular)"
    )
    for tag, row in zip(tags, table):
        h, bf, tw, tf, A, Iy, Iz, Wply, Wplz, Wely, Welz, iy, iz, It, mass = row
        name = f"{prefix}-{tag}"
        out[name] = _din_i(
            name, shape_type, mass,
            float(h), float(bf), tw, tf,
            A, Iy, Iz, Wply, Wplz, Wely, Welz, iy, iz, It,
        )
    return out


# Serie IPE usa el tag = h directamente (IPE-80, IPE-100, ..., IPE-600).
_IPE_TAGS = [row[0] for row in _IPE_TABLE]

IPE_SHAPES: dict[str, SteelShape] = _build_din_catalog(_IPE_TAGS, _IPE_TABLE, ShapeType.IPE, "IPE")
HEA_SHAPES: dict[str, SteelShape] = _build_din_catalog(_HEA_TAGS, _HEA_TABLE, ShapeType.HEA, "HEA")
HEB_SHAPES: dict[str, SteelShape] = _build_din_catalog(_HEB_TAGS, _HEB_TABLE, ShapeType.HEB, "HEB")
HEM_SHAPES: dict[str, SteelShape] = _build_din_catalog(_HEM_TAGS, _HEM_TABLE, ShapeType.HEM, "HEM")


# ─────────────────────────────────────────────────────────────────────────────
# Catalogos nominales PTE / PHR (espesor seleccionado por el usuario).
# ─────────────────────────────────────────────────────────────────────────────

# Lista de perfiles tubulares rectangulares colombianos tipicos (d x b, mm).
# El usuario selecciona el espesor al crear la seccion.
PTE_NOMINAL_SIZES: list[tuple[float, float]] = [
    # cuadrados
    (40,  40),  (50,  50),  (60,  60),  (75,  75),  (80,  80),
    (100, 100), (120, 120), (150, 150), (200, 200), (250, 250),
    (300, 300), (350, 350), (400, 400),
    # rectangulares
    (60,  40),  (75,  50),  (80,  40),  (100, 50),  (100, 60),  (100, 80),
    (120, 60),  (120, 80),  (150, 50),  (150, 100), (200, 100), (200, 150),
    (250, 100), (250, 150), (300, 100), (300, 150), (300, 200),
    (350, 200), (350, 250), (400, 200), (400, 300),
]

# Espesores sugeridos por fabricante para PTE (el usuario puede introducir otro).
PTE_DEFAULT_THICKNESSES: list[float] = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0, 10.0, 12.0]

# Diametros exteriores tipicos para PHR (mm).
PHR_NOMINAL_OD: list[float] = [
    31.75, 38.1, 50.8, 63.5, 75, 88.9, 100, 114.3, 125, 150, 168.3, 200, 219, 250, 273, 300,
]

# Espesores sugeridos para PHR por fabricante (el usuario puede introducir otro).
PHR_DEFAULT_THICKNESSES: list[float] = [2.0, 2.5, 3.0]


# ─────────────────────────────────────────────────────────────────────────────
# Catalogo agregado + lookup.
# ─────────────────────────────────────────────────────────────────────────────

# Catalogo global por nombre. AISC + europeos. Para PTE/PHR, no se precomputa:
# se genera on-the-fly con `make_pte` / `make_phr`.
ALL_SHAPES: dict[str, SteelShape] = {
    **AISC_V15_SHAPES,
    **IPE_SHAPES,
    **HEA_SHAPES,
    **HEB_SHAPES,
    **HEM_SHAPES,
}


def _normalize_shape_name(name: str) -> str:
    """Normaliza nombres: mayusculas, sin espacios, inserta guion para europeos.

    Ejemplos:
        'ipe 300' -> 'IPE-300'
        'IPE300'  -> 'IPE-300'
        'hea-200' -> 'HEA-200'
        'HEB 100' -> 'HEB-100'
        'W24x55'  -> 'W24X55'  (AISC se mantiene sin guion)
    """
    s = name.upper().replace(" ", "")
    # Normalizar europeos: 'IPE300' -> 'IPE-300', mantener si ya tiene guion.
    for prefix in ("IPE", "HEA", "HEB", "HEM"):
        if s.startswith(prefix) and len(s) > len(prefix):
            rest = s[len(prefix):]
            if not rest.startswith("-"):
                s = f"{prefix}-{rest}"
            break
    return s


def get_shape(name: str) -> SteelShape:
    """Lookup por nombre. Acepta variaciones:
        - 'W24X55', 'w24x55'       (AISC)
        - 'IPE300', 'IPE-300', 'ipe 300' (europeos)
        - 'HEA-200', 'HEB100', ...

    Para PTE/PHR usa `make_pte(d, b, t)` / `make_phr(OD, t)` — NO estan en
    el catalogo porque el espesor lo define el usuario al crear la seccion.
    """
    key = _normalize_shape_name(name)
    if key not in ALL_SHAPES:
        raise KeyError(
            f"Perfil '{name}' no esta en el catalogo. "
            f"Disponibles ({len(ALL_SHAPES)}): {sorted(ALL_SHAPES)}"
        )
    return ALL_SHAPES[key]


def list_shapes(shape_type: ShapeType | None = None) -> list[str]:
    """Devuelve la lista de nombres disponibles; filtra por tipo si se indica.

    Nota: PTE/PHR no aparecen aqui (son parametricos en espesor). Usa
    `PTE_NOMINAL_SIZES` y `PHR_NOMINAL_OD` para listar las dimensiones
    nominales expuestas al usuario.
    """
    if shape_type is None:
        return sorted(ALL_SHAPES)
    return sorted(k for k, s in ALL_SHAPES.items() if s.type == shape_type)


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
