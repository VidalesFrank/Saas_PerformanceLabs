"""Datos NSR-10: municipios colombianos con Aa/Av, y tablas de factores de sitio.

Fuente: NSR-10 Titulo A, Tabla A.2.3-1 (coeficientes sismicos por municipio)
        y Tablas A.2.4-1 / A.2.4-2 (factores de sitio Fa y Fv).

ADVERTENCIA: Los valores de Aa y Av deben verificarse contra la Tabla A.2.3-1
oficial del NSR-10 para cada proyecto especifico. Esta base de datos cubre los
municipios mas representativos; para municipios no listados se debe interpolar
de la zonificacion del mapa de amenaza sismica o consultar el documento oficial.

Unidades: Aa y Av en fraccion de g (adimensional).
Coordenadas: lat/lon WGS-84 (centroide aproximado del municipio).
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Descripciones de tipos de perfil de suelo (NSR-10 Tabla A.2.3-1 / A.2.5)
# ---------------------------------------------------------------------------
SOIL_TYPES: dict[str, dict[str, str]] = {
    "A": {
        "nombre": "Perfil A — Roca dura",
        "descripcion": "Roca con Vs > 1500 m/s. Sin suelo blando.",
    },
    "B": {
        "nombre": "Perfil B — Roca",
        "descripcion": "Roca con 760 m/s < Vs ≤ 1500 m/s.",
    },
    "C": {
        "nombre": "Perfil C — Suelo muy denso o roca blanda",
        "descripcion": "360 m/s < Vs ≤ 760 m/s, N > 50 o Su > 100 kPa.",
    },
    "D": {
        "nombre": "Perfil D — Suelo rígido",
        "descripcion": "180 m/s ≤ Vs ≤ 360 m/s, 15 ≤ N ≤ 50 o 50 kPa ≤ Su ≤ 100 kPa.",
    },
    "E": {
        "nombre": "Perfil E — Suelo blando",
        "descripcion": "Vs < 180 m/s, N < 15 o Su < 50 kPa. Incluye suelos colapsables.",
    },
    "F": {
        "nombre": "Perfil F — Suelos especiales",
        "descripcion": "Requiere estudio de sitio especifico (licuacion, turba, arcilla muy blanda, etc.).",
    },
}

# ---------------------------------------------------------------------------
# Tablas de factores de sitio — NSR-10 Tablas A.2.4-1 y A.2.4-2
# Interpolacion lineal entre los puntos de quiebre; extrapolacion por clamping.
# Columnas corresponden a Aa (o Av) = [0.10, 0.20, 0.30, 0.40, 0.50]
# Ejemplo: Fa(D, Aa=0.15) = interp(0.15, [0.10,0.20], [1.6,1.4]) = 1.50
#          Fv(D, Av=0.20) = directo en break 0.20                  = 2.00
# ---------------------------------------------------------------------------

_AA_BREAKS = [0.10, 0.20, 0.30, 0.40, 0.50]
_AV_BREAKS = [0.10, 0.20, 0.30, 0.40, 0.50]

# Fa — factor de amplificacion en periodo corto (funcion de Aa y tipo de suelo)
FA_TABLE: dict[str, list[float]] = {
    "A": [0.8, 0.8, 0.8, 0.8, 0.8],
    "B": [1.0, 1.0, 1.0, 1.0, 1.0],
    "C": [1.2, 1.1, 1.0, 1.0, 1.0],
    "D": [1.6, 1.4, 1.2, 1.1, 1.0],
    "E": [2.5, 1.7, 1.2, 0.9, 0.9],
}

# Fv — factor de amplificacion en periodo largo (funcion de Av y tipo de suelo)
FV_TABLE: dict[str, list[float]] = {
    "A": [0.8, 0.8, 0.8, 0.8, 0.8],
    "B": [1.0, 1.0, 1.0, 1.0, 1.0],
    "C": [1.7, 1.6, 1.5, 1.4, 1.3],
    "D": [2.4, 2.0, 1.8, 1.6, 1.5],
    "E": [3.5, 3.2, 2.8, 2.4, 2.4],
}

# ---------------------------------------------------------------------------
# Base de datos de municipios
# Campos: nombre, departamento, Aa, Av, lat, lon
# ---------------------------------------------------------------------------
MUNICIPIOS: dict[str, dict] = {
    # ===== AMAZONAS =====
    "leticia": {"nombre": "Leticia", "departamento": "Amazonas", "Aa": 0.10, "Av": 0.10, "lat": -4.215, "lon": -69.940},
    "puerto-narino": {"nombre": "Puerto Nariño", "departamento": "Amazonas", "Aa": 0.10, "Av": 0.10, "lat": -3.775, "lon": -70.381},

    # ===== ANTIOQUIA =====
    "medellin": {"nombre": "Medellín", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.244, "lon": -75.574},
    "bello": {"nombre": "Bello", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.337, "lon": -75.556},
    "itagui": {"nombre": "Itagüí", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.185, "lon": -75.599},
    "envigado": {"nombre": "Envigado", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.168, "lon": -75.591},
    "rionegro": {"nombre": "Rionegro", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.155, "lon": -75.374},
    "apartado": {"nombre": "Apartadó", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 7.879, "lon": -76.630},
    "turbo": {"nombre": "Turbo", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 8.093, "lon": -76.728},
    "caucasia": {"nombre": "Caucasia", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.10, "lat": 7.988, "lon": -75.197},
    "puerto-berrio": {"nombre": "Puerto Berrío", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 6.489, "lon": -74.403},
    "yarumal": {"nombre": "Yarumal", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.977, "lon": -75.421},
    "santa-fe-de-antioquia": {"nombre": "Santa Fe de Antioquia", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.556, "lon": -75.828},

    # ===== ARAUCA =====
    "arauca": {"nombre": "Arauca", "departamento": "Arauca", "Aa": 0.10, "Av": 0.15, "lat": 7.090, "lon": -70.762},
    "saravena": {"nombre": "Saravena", "departamento": "Arauca", "Aa": 0.15, "Av": 0.20, "lat": 6.946, "lon": -71.874},
    "tame": {"nombre": "Tame", "departamento": "Arauca", "Aa": 0.15, "Av": 0.20, "lat": 6.462, "lon": -71.730},

    # ===== ATLÁNTICO =====
    "barranquilla": {"nombre": "Barranquilla", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.964, "lon": -74.796},
    "soledad": {"nombre": "Soledad", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.917, "lon": -74.767},
    "malambo": {"nombre": "Malambo", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.854, "lon": -74.777},
    "sabanalarga": {"nombre": "Sabanalarga", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.637, "lon": -74.922},

    # ===== BOGOTÁ D.C. =====
    "bogota": {"nombre": "Bogotá D.C.", "departamento": "Bogotá D.C.", "Aa": 0.15, "Av": 0.20, "lat": 4.711, "lon": -74.072},

    # ===== BOLÍVAR =====
    "cartagena": {"nombre": "Cartagena", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 10.391, "lon": -75.479},
    "magangue": {"nombre": "Magangué", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 9.241, "lon": -74.754},
    "el-carmen-de-bolivar": {"nombre": "El Carmen de Bolívar", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 9.718, "lon": -75.122},

    # ===== BOYACÁ =====
    "tunja": {"nombre": "Tunja", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.535, "lon": -73.362},
    "sogamoso": {"nombre": "Sogamoso", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.716, "lon": -72.933},
    "chiquinquira": {"nombre": "Chiquinquirá", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.15, "lat": 5.617, "lon": -73.818},
    "duitama": {"nombre": "Duitama", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.827, "lon": -73.023},

    # ===== CALDAS =====
    "manizales": {"nombre": "Manizales", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.068, "lon": -75.517},
    "chinchina": {"nombre": "Chinchiná", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 4.988, "lon": -75.607},
    "la-dorada": {"nombre": "La Dorada", "departamento": "Caldas", "Aa": 0.15, "Av": 0.20, "lat": 5.450, "lon": -74.665},
    "riosucio-caldas": {"nombre": "Riosucio", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.419, "lon": -75.706},
    "villamaria": {"nombre": "Villamaría", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.025, "lon": -75.518},

    # ===== CAQUETÁ =====
    "florencia": {"nombre": "Florencia", "departamento": "Caquetá", "Aa": 0.20, "Av": 0.25, "lat": 1.614, "lon": -75.606},
    "san-vicente-del-caguan": {"nombre": "San Vicente del Caguán", "departamento": "Caquetá", "Aa": 0.15, "Av": 0.20, "lat": 2.113, "lon": -74.769},

    # ===== CASANARE =====
    "yopal": {"nombre": "Yopal", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 5.338, "lon": -72.396},
    "aguazul": {"nombre": "Aguazul", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 5.170, "lon": -72.551},
    "villanueva-casanare": {"nombre": "Villanueva", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 4.612, "lon": -72.928},

    # ===== CAUCA =====
    "popayan": {"nombre": "Popayán", "departamento": "Cauca", "Aa": 0.20, "Av": 0.25, "lat": 2.440, "lon": -76.614},
    "santander-de-quilichao": {"nombre": "Santander de Quilichao", "departamento": "Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.013, "lon": -76.484},
    "puerto-tejada": {"nombre": "Puerto Tejada", "departamento": "Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.230, "lon": -76.415},
    "patia": {"nombre": "Patía (El Bordo)", "departamento": "Cauca", "Aa": 0.25, "Av": 0.25, "lat": 2.065, "lon": -77.046},

    # ===== CESAR =====
    "valledupar": {"nombre": "Valledupar", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 10.464, "lon": -73.253},
    "aguachica": {"nombre": "Aguachica", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 8.306, "lon": -73.620},

    # ===== CHOCÓ =====
    "quibdo": {"nombre": "Quibdó", "departamento": "Chocó", "Aa": 0.30, "Av": 0.30, "lat": 5.695, "lon": -76.661},
    "istmina": {"nombre": "Istmina", "departamento": "Chocó", "Aa": 0.35, "Av": 0.35, "lat": 5.160, "lon": -76.683},
    "riosucio-choco": {"nombre": "Riosucio", "departamento": "Chocó", "Aa": 0.40, "Av": 0.40, "lat": 7.443, "lon": -77.118},
    "nuqui": {"nombre": "Nuquí", "departamento": "Chocó", "Aa": 0.40, "Av": 0.40, "lat": 5.706, "lon": -77.268},
    "bahia-solano": {"nombre": "Bahía Solano", "departamento": "Chocó", "Aa": 0.40, "Av": 0.40, "lat": 6.228, "lon": -77.400},
    "acandi": {"nombre": "Acandí", "departamento": "Chocó", "Aa": 0.30, "Av": 0.30, "lat": 8.511, "lon": -77.282},

    # ===== CÓRDOBA =====
    "monteria": {"nombre": "Montería", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.757, "lon": -75.890},
    "lorica": {"nombre": "Lorica", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 9.238, "lon": -75.816},
    "montelibano": {"nombre": "Montelíbano", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 7.979, "lon": -75.419},

    # ===== CUNDINAMARCA =====
    "soacha": {"nombre": "Soacha", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.577, "lon": -74.217},
    "facatativa": {"nombre": "Facatativá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.817, "lon": -74.357},
    "zipaquira": {"nombre": "Zipaquirá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 5.023, "lon": -74.009},
    "fusagasuga": {"nombre": "Fusagasugá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.337, "lon": -74.363},
    "girardot": {"nombre": "Girardot", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.302, "lon": -74.800},

    # ===== GUAINÍA =====
    "puerto-inirida": {"nombre": "Puerto Inírida", "departamento": "Guainía", "Aa": 0.05, "Av": 0.05, "lat": 3.865, "lon": -67.922},

    # ===== GUAVIARE =====
    "san-jose-del-guaviare": {"nombre": "San José del Guaviare", "departamento": "Guaviare", "Aa": 0.10, "Av": 0.10, "lat": 2.571, "lon": -72.640},

    # ===== HUILA =====
    "neiva": {"nombre": "Neiva", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.928, "lon": -75.280},
    "pitalito": {"nombre": "Pitalito", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 1.852, "lon": -76.051},
    "garzon": {"nombre": "Garzón", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.197, "lon": -75.627},
    "la-plata": {"nombre": "La Plata", "departamento": "Huila", "Aa": 0.25, "Av": 0.30, "lat": 2.385, "lon": -75.897},

    # ===== LA GUAJIRA =====
    "riohacha": {"nombre": "Riohacha", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.15, "lat": 11.545, "lon": -72.907},
    "maicao": {"nombre": "Maicao", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.10, "lat": 11.382, "lon": -72.247},
    "uribia": {"nombre": "Uribia", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.10, "lat": 11.714, "lon": -72.264},

    # ===== MAGDALENA =====
    "santa-marta": {"nombre": "Santa Marta", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 11.244, "lon": -74.200},
    "cienaga": {"nombre": "Ciénaga", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 11.006, "lon": -74.251},
    "fundacion": {"nombre": "Fundación", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 10.524, "lon": -74.190},

    # ===== META =====
    "villavicencio": {"nombre": "Villavicencio", "departamento": "Meta", "Aa": 0.15, "Av": 0.15, "lat": 4.142, "lon": -73.626},
    "acacias": {"nombre": "Acacías", "departamento": "Meta", "Aa": 0.15, "Av": 0.15, "lat": 3.989, "lon": -73.758},
    "granada-meta": {"nombre": "Granada", "departamento": "Meta", "Aa": 0.10, "Av": 0.15, "lat": 3.540, "lon": -73.704},
    "puerto-lopez": {"nombre": "Puerto López", "departamento": "Meta", "Aa": 0.10, "Av": 0.10, "lat": 4.085, "lon": -72.959},

    # ===== NARIÑO =====
    "pasto": {"nombre": "Pasto", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 1.214, "lon": -77.281},
    "ipiales": {"nombre": "Ipiales", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 0.830, "lon": -77.643},
    "tuquerres": {"nombre": "Túquerres", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 1.088, "lon": -77.619},
    "tumaco": {"nombre": "Tumaco", "departamento": "Nariño", "Aa": 0.40, "Av": 0.45, "lat": 1.808, "lon": -78.769},
    "barbacoas": {"nombre": "Barbacoas", "departamento": "Nariño", "Aa": 0.40, "Av": 0.40, "lat": 1.673, "lon": -78.141},
    "la-union-narino": {"nombre": "La Unión", "departamento": "Nariño", "Aa": 0.20, "Av": 0.25, "lat": 1.595, "lon": -77.132},

    # ===== NORTE DE SANTANDER =====
    "cucuta": {"nombre": "Cúcuta", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.893, "lon": -72.505},
    "pamplona": {"nombre": "Pamplona", "departamento": "Norte de Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.377, "lon": -72.649},
    "ocana": {"nombre": "Ocaña", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 8.235, "lon": -73.356},

    # ===== PUTUMAYO =====
    "mocoa": {"nombre": "Mocoa", "departamento": "Putumayo", "Aa": 0.30, "Av": 0.30, "lat": 1.149, "lon": -76.649},
    "puerto-asis": {"nombre": "Puerto Asís", "departamento": "Putumayo", "Aa": 0.25, "Av": 0.30, "lat": 0.506, "lon": -76.508},
    "la-hormiga": {"nombre": "La Hormiga (Valle del Guamuez)", "departamento": "Putumayo", "Aa": 0.30, "Av": 0.35, "lat": 0.448, "lon": -76.897},
    "orito": {"nombre": "Orito", "departamento": "Putumayo", "Aa": 0.25, "Av": 0.30, "lat": 0.662, "lon": -76.877},

    # ===== QUINDÍO =====
    "armenia": {"nombre": "Armenia", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.534, "lon": -75.681},
    "calarca": {"nombre": "Calarcá", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.527, "lon": -75.640},
    "montenegro": {"nombre": "Montenegro", "departamento": "Quindío", "Aa": 0.25, "Av": 0.25, "lat": 4.565, "lon": -75.754},
    "quimbaya": {"nombre": "Quimbaya", "departamento": "Quindío", "Aa": 0.25, "Av": 0.25, "lat": 4.621, "lon": -75.764},

    # ===== RISARALDA =====
    "pereira": {"nombre": "Pereira", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.814, "lon": -75.696},
    "dosquebradas": {"nombre": "Dosquebradas", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.840, "lon": -75.673},
    "santa-rosa-de-cabal": {"nombre": "Santa Rosa de Cabal", "departamento": "Risaralda", "Aa": 0.25, "Av": 0.25, "lat": 4.869, "lon": -75.621},
    "la-virginia": {"nombre": "La Virginia", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.899, "lon": -75.880},

    # ===== SAN ANDRÉS =====
    "san-andres": {"nombre": "San Andrés", "departamento": "San Andrés y Providencia", "Aa": 0.10, "Av": 0.10, "lat": 12.536, "lon": -81.716},

    # ===== SANTANDER =====
    "bucaramanga": {"nombre": "Bucaramanga", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.119, "lon": -73.123},
    "floridablanca": {"nombre": "Floridablanca", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.064, "lon": -73.089},
    "giron": {"nombre": "Girón", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.073, "lon": -73.170},
    "barrancabermeja": {"nombre": "Barrancabermeja", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.063, "lon": -73.850},
    "velez": {"nombre": "Vélez", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.010, "lon": -73.678},

    # ===== SUCRE =====
    "sincelejo": {"nombre": "Sincelejo", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.304, "lon": -75.397},
    "corozal": {"nombre": "Corozal", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.321, "lon": -75.285},

    # ===== TOLIMA =====
    "ibague": {"nombre": "Ibagué", "departamento": "Tolima", "Aa": 0.20, "Av": 0.20, "lat": 4.438, "lon": -75.232},
    "espinal": {"nombre": "Espinal", "departamento": "Tolima", "Aa": 0.20, "Av": 0.20, "lat": 4.152, "lon": -74.892},
    "honda": {"nombre": "Honda", "departamento": "Tolima", "Aa": 0.15, "Av": 0.20, "lat": 5.209, "lon": -74.744},
    "chaparral": {"nombre": "Chaparral", "departamento": "Tolima", "Aa": 0.25, "Av": 0.25, "lat": 3.726, "lon": -75.491},

    # ===== VALLE DEL CAUCA =====
    "cali": {"nombre": "Cali", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.451, "lon": -76.532},
    "buenaventura": {"nombre": "Buenaventura", "departamento": "Valle del Cauca", "Aa": 0.35, "Av": 0.35, "lat": 3.883, "lon": -77.017},
    "palmira": {"nombre": "Palmira", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.539, "lon": -76.304},
    "buga": {"nombre": "Guadalajara de Buga", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.900, "lon": -76.299},
    "cartago": {"nombre": "Cartago", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.745, "lon": -75.913},
    "tulua": {"nombre": "Tuluá", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.084, "lon": -76.199},
    "jamundi": {"nombre": "Jamundí", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.263, "lon": -76.538},
    "yumbo": {"nombre": "Yumbo", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.592, "lon": -76.492},

    # ===== VAUPÉS =====
    "mitu": {"nombre": "Mitú", "departamento": "Vaupés", "Aa": 0.10, "Av": 0.10, "lat": 1.198, "lon": -70.173},

    # ===== VICHADA =====
    "puerto-carreno": {"nombre": "Puerto Carreño", "departamento": "Vichada", "Aa": 0.05, "Av": 0.05, "lat": 6.188, "lon": -67.487},
}


def zona_sismica(Aa: float) -> str:
    """Clasifica la zona de amenaza sismica segun NSR-10 A.2.3."""
    if Aa <= 0.10:
        return "baja"
    if Aa <= 0.20:
        return "intermedia"
    return "alta"


def buscar_municipios(query: str, limit: int = 20) -> list[dict]:
    """Busca municipios por nombre o departamento (case-insensitive, sin tildes exactas)."""
    q = query.strip().lower()
    if not q:
        return []

    results = []
    for mid, data in MUNICIPIOS.items():
        haystack = f"{data['nombre']} {data['departamento']}".lower()
        if q in haystack:
            results.append({
                "id": mid,
                **data,
                "zona_sismica": zona_sismica(data["Aa"]),
            })
    return results[:limit]
