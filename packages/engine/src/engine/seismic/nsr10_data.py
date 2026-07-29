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
# ---------------------------------------------------------------------------

_AA_BREAKS = [0.10, 0.20, 0.30, 0.40, 0.50]
_AV_BREAKS = [0.10, 0.20, 0.30, 0.40, 0.50]

FA_TABLE: dict[str, list[float]] = {
    "A": [0.8, 0.8, 0.8, 0.8, 0.8],
    "B": [1.0, 1.0, 1.0, 1.0, 1.0],
    "C": [1.2, 1.1, 1.0, 1.0, 1.0],
    "D": [1.6, 1.4, 1.2, 1.1, 1.0],
    "E": [2.5, 1.7, 1.2, 0.9, 0.9],
}

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
    "la-pedrera": {"nombre": "La Pedrera", "departamento": "Amazonas", "Aa": 0.10, "Av": 0.10, "lat": -1.329, "lon": -69.606},

    # ===== ANTIOQUIA =====
    "medellin": {"nombre": "Medellín", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.244, "lon": -75.574},
    "bello": {"nombre": "Bello", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.337, "lon": -75.556},
    "itagui": {"nombre": "Itagüí", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.185, "lon": -75.599},
    "envigado": {"nombre": "Envigado", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.168, "lon": -75.591},
    "rionegro": {"nombre": "Rionegro", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.155, "lon": -75.374},
    "caldas-ant": {"nombre": "Caldas", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.095, "lon": -75.637},
    "copacabana": {"nombre": "Copacabana", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.350, "lon": -75.511},
    "la-estrella": {"nombre": "La Estrella", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.156, "lon": -75.645},
    "sabaneta": {"nombre": "Sabaneta", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.151, "lon": -75.618},
    "marinilla": {"nombre": "Marinilla", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.175, "lon": -75.333},
    "el-carmen-de-viboral": {"nombre": "El Carmen de Viboral", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.083, "lon": -75.337},
    "la-ceja": {"nombre": "La Ceja del Tambo", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.027, "lon": -75.431},
    "andes-ant": {"nombre": "Andes", "departamento": "Antioquia", "Aa": 0.20, "Av": 0.25, "lat": 5.656, "lon": -75.881},
    "ciudad-bolivar-ant": {"nombre": "Ciudad Bolívar", "departamento": "Antioquia", "Aa": 0.20, "Av": 0.25, "lat": 5.845, "lon": -76.021},
    "fredonia": {"nombre": "Fredonia", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 5.928, "lon": -75.676},
    "sonson": {"nombre": "Sonsón", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 5.712, "lon": -75.315},
    "apartado": {"nombre": "Apartadó", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 7.879, "lon": -76.630},
    "turbo": {"nombre": "Turbo", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 8.093, "lon": -76.728},
    "caucasia": {"nombre": "Caucasia", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.10, "lat": 7.988, "lon": -75.197},
    "puerto-berrio": {"nombre": "Puerto Berrío", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 6.489, "lon": -74.403},
    "yarumal": {"nombre": "Yarumal", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.977, "lon": -75.421},
    "santa-fe-de-antioquia": {"nombre": "Santa Fe de Antioquia", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.556, "lon": -75.828},
    "segovia": {"nombre": "Segovia", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 7.087, "lon": -74.703},
    "el-bagre": {"nombre": "El Bagre", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.10, "lat": 7.597, "lon": -74.809},
    "chigorodo": {"nombre": "Chigorodó", "departamento": "Antioquia", "Aa": 0.10, "Av": 0.15, "lat": 7.672, "lon": -76.687},
    "guarne": {"nombre": "Guarne", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.285, "lon": -75.447},
    "barbosa-ant": {"nombre": "Barbosa", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.437, "lon": -75.335},
    "san-carlos-ant": {"nombre": "San Carlos", "departamento": "Antioquia", "Aa": 0.15, "Av": 0.20, "lat": 6.189, "lon": -74.992},

    # ===== ARAUCA =====
    "arauca": {"nombre": "Arauca", "departamento": "Arauca", "Aa": 0.10, "Av": 0.15, "lat": 7.090, "lon": -70.762},
    "saravena": {"nombre": "Saravena", "departamento": "Arauca", "Aa": 0.15, "Av": 0.20, "lat": 6.946, "lon": -71.874},
    "tame": {"nombre": "Tame", "departamento": "Arauca", "Aa": 0.15, "Av": 0.20, "lat": 6.462, "lon": -71.730},
    "fortul": {"nombre": "Fortul", "departamento": "Arauca", "Aa": 0.10, "Av": 0.15, "lat": 6.758, "lon": -71.772},
    "arauquita": {"nombre": "Arauquita", "departamento": "Arauca", "Aa": 0.15, "Av": 0.20, "lat": 7.022, "lon": -71.422},

    # ===== ATLÁNTICO =====
    "barranquilla": {"nombre": "Barranquilla", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.964, "lon": -74.796},
    "soledad": {"nombre": "Soledad", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.917, "lon": -74.767},
    "malambo": {"nombre": "Malambo", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.854, "lon": -74.777},
    "sabanalarga": {"nombre": "Sabanalarga", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.637, "lon": -74.922},
    "baranoa": {"nombre": "Baranoa", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.797, "lon": -74.921},
    "puerto-colombia": {"nombre": "Puerto Colombia", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.987, "lon": -74.955},
    "galapa": {"nombre": "Galapa", "departamento": "Atlántico", "Aa": 0.05, "Av": 0.05, "lat": 10.896, "lon": -74.889},

    # ===== BOGOTÁ D.C. =====
    "bogota": {"nombre": "Bogotá D.C.", "departamento": "Bogotá D.C.", "Aa": 0.15, "Av": 0.20, "lat": 4.711, "lon": -74.072},

    # ===== BOLÍVAR =====
    "cartagena": {"nombre": "Cartagena", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 10.391, "lon": -75.479},
    "magangue": {"nombre": "Magangué", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 9.241, "lon": -74.754},
    "el-carmen-de-bolivar": {"nombre": "El Carmen de Bolívar", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 9.718, "lon": -75.122},
    "mompox": {"nombre": "Mompox", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 9.243, "lon": -74.427},
    "achi": {"nombre": "Achí", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 8.564, "lon": -74.561},
    "san-pablo-bolivar": {"nombre": "San Pablo", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.15, "lat": 8.003, "lon": -73.944},
    "simiti": {"nombre": "Simití", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.15, "lat": 8.002, "lon": -73.949},
    "turbaco": {"nombre": "Turbaco", "departamento": "Bolívar", "Aa": 0.10, "Av": 0.10, "lat": 10.332, "lon": -75.421},

    # ===== BOYACÁ =====
    "tunja": {"nombre": "Tunja", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.535, "lon": -73.362},
    "sogamoso": {"nombre": "Sogamoso", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.716, "lon": -72.933},
    "chiquinquira": {"nombre": "Chiquinquirá", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.15, "lat": 5.617, "lon": -73.818},
    "duitama": {"nombre": "Duitama", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.827, "lon": -73.023},
    "paipa": {"nombre": "Paipa", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.779, "lon": -73.113},
    "moniquira": {"nombre": "Moniquirá", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.15, "lat": 5.878, "lon": -73.574},
    "samaca": {"nombre": "Samacá", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.487, "lon": -73.487},
    "ramiriqui": {"nombre": "Ramiriquí", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.402, "lon": -73.337},
    "garagoa": {"nombre": "Garagoa", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.090, "lon": -73.357},
    "guateque": {"nombre": "Guateque", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.017, "lon": -73.461},
    "santa-rosa-de-viterbo": {"nombre": "Santa Rosa de Viterbo", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.877, "lon": -72.982},
    "soata": {"nombre": "Soatá", "departamento": "Boyacá", "Aa": 0.10, "Av": 0.15, "lat": 6.331, "lon": -72.685},
    "guican": {"nombre": "Güicán", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 6.466, "lon": -72.415},
    "el-cocuy": {"nombre": "El Cocuy", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 6.404, "lon": -72.445},
    "nobsa": {"nombre": "Nobsa", "departamento": "Boyacá", "Aa": 0.15, "Av": 0.20, "lat": 5.768, "lon": -72.959},

    # ===== CALDAS =====
    "manizales": {"nombre": "Manizales", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.068, "lon": -75.517},
    "chinchina": {"nombre": "Chinchiná", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 4.988, "lon": -75.607},
    "la-dorada": {"nombre": "La Dorada", "departamento": "Caldas", "Aa": 0.15, "Av": 0.20, "lat": 5.450, "lon": -74.665},
    "riosucio-caldas": {"nombre": "Riosucio", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.419, "lon": -75.706},
    "villamaria": {"nombre": "Villamaría", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.025, "lon": -75.518},
    "palestina-caldas": {"nombre": "Palestina", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.027, "lon": -75.706},
    "anserma": {"nombre": "Anserma", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.224, "lon": -75.791},
    "aguadas": {"nombre": "Aguadas", "departamento": "Caldas", "Aa": 0.20, "Av": 0.25, "lat": 5.611, "lon": -75.450},
    "supia": {"nombre": "Supía", "departamento": "Caldas", "Aa": 0.25, "Av": 0.25, "lat": 5.454, "lon": -75.635},
    "manzanares": {"nombre": "Manzanares", "departamento": "Caldas", "Aa": 0.15, "Av": 0.20, "lat": 5.244, "lon": -75.152},
    "pensilvania": {"nombre": "Pensilvania", "departamento": "Caldas", "Aa": 0.15, "Av": 0.20, "lat": 5.395, "lon": -75.163},

    # ===== CAQUETÁ =====
    "florencia": {"nombre": "Florencia", "departamento": "Caquetá", "Aa": 0.20, "Av": 0.25, "lat": 1.614, "lon": -75.606},
    "san-vicente-del-caguan": {"nombre": "San Vicente del Caguán", "departamento": "Caquetá", "Aa": 0.15, "Av": 0.20, "lat": 2.113, "lon": -74.769},
    "belen-de-los-andaquies": {"nombre": "Belén de los Andaquíes", "departamento": "Caquetá", "Aa": 0.20, "Av": 0.25, "lat": 1.433, "lon": -75.865},
    "curillo": {"nombre": "Curillo", "departamento": "Caquetá", "Aa": 0.20, "Av": 0.25, "lat": 0.733, "lon": -76.006},
    "la-montanita": {"nombre": "La Montañita", "departamento": "Caquetá", "Aa": 0.20, "Av": 0.25, "lat": 1.434, "lon": -75.480},

    # ===== CASANARE =====
    "yopal": {"nombre": "Yopal", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 5.338, "lon": -72.396},
    "aguazul": {"nombre": "Aguazul", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 5.170, "lon": -72.551},
    "villanueva-casanare": {"nombre": "Villanueva", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 4.612, "lon": -72.928},
    "paz-de-ariporo": {"nombre": "Paz de Ariporo", "departamento": "Casanare", "Aa": 0.05, "Av": 0.10, "lat": 5.880, "lon": -71.899},
    "tauramena": {"nombre": "Tauramena", "departamento": "Casanare", "Aa": 0.10, "Av": 0.15, "lat": 5.018, "lon": -72.740},

    # ===== CAUCA =====
    "popayan": {"nombre": "Popayán", "departamento": "Cauca", "Aa": 0.20, "Av": 0.25, "lat": 2.440, "lon": -76.614},
    "santander-de-quilichao": {"nombre": "Santander de Quilichao", "departamento": "Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.013, "lon": -76.484},
    "puerto-tejada": {"nombre": "Puerto Tejada", "departamento": "Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.230, "lon": -76.415},
    "patia": {"nombre": "Patía (El Bordo)", "departamento": "Cauca", "Aa": 0.25, "Av": 0.25, "lat": 2.065, "lon": -77.046},
    "silvia": {"nombre": "Silvia", "departamento": "Cauca", "Aa": 0.20, "Av": 0.25, "lat": 2.607, "lon": -76.382},
    "caldono": {"nombre": "Caldono", "departamento": "Cauca", "Aa": 0.20, "Av": 0.25, "lat": 2.805, "lon": -76.493},
    "morales-cauca": {"nombre": "Morales", "departamento": "Cauca", "Aa": 0.25, "Av": 0.30, "lat": 2.761, "lon": -76.638},
    "miranda": {"nombre": "Miranda", "departamento": "Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.246, "lon": -76.226},
    "corinto": {"nombre": "Corinto", "departamento": "Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.177, "lon": -76.246},
    "el-tambo": {"nombre": "El Tambo", "departamento": "Cauca", "Aa": 0.25, "Av": 0.30, "lat": 2.462, "lon": -76.821},
    "piamonte": {"nombre": "Piamonte", "departamento": "Cauca", "Aa": 0.25, "Av": 0.30, "lat": 0.353, "lon": -76.532},

    # ===== CESAR =====
    "valledupar": {"nombre": "Valledupar", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 10.464, "lon": -73.253},
    "aguachica": {"nombre": "Aguachica", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 8.306, "lon": -73.620},
    "bosconia": {"nombre": "Bosconia", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 9.978, "lon": -73.891},
    "codazzi": {"nombre": "Agustín Codazzi", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 10.025, "lon": -73.235},
    "pailitas": {"nombre": "Pailitas", "departamento": "Cesar", "Aa": 0.10, "Av": 0.10, "lat": 8.956, "lon": -73.631},
    "la-paz-cesar": {"nombre": "La Paz", "departamento": "Cesar", "Aa": 0.10, "Av": 0.15, "lat": 10.376, "lon": -73.170},

    # ===== CHOCÓ =====
    "quibdo": {"nombre": "Quibdó", "departamento": "Chocó", "Aa": 0.30, "Av": 0.30, "lat": 5.695, "lon": -76.661},
    "istmina": {"nombre": "Istmina", "departamento": "Chocó", "Aa": 0.35, "Av": 0.35, "lat": 5.160, "lon": -76.683},
    "riosucio-choco": {"nombre": "Riosucio", "departamento": "Chocó", "Aa": 0.40, "Av": 0.40, "lat": 7.443, "lon": -77.118},
    "nuqui": {"nombre": "Nuquí", "departamento": "Chocó", "Aa": 0.40, "Av": 0.40, "lat": 5.706, "lon": -77.268},
    "bahia-solano": {"nombre": "Bahía Solano", "departamento": "Chocó", "Aa": 0.40, "Av": 0.40, "lat": 6.228, "lon": -77.400},
    "acandi": {"nombre": "Acandí", "departamento": "Chocó", "Aa": 0.30, "Av": 0.30, "lat": 8.511, "lon": -77.282},
    "condoto": {"nombre": "Condoto", "departamento": "Chocó", "Aa": 0.35, "Av": 0.35, "lat": 5.099, "lon": -76.655},
    "tadoo": {"nombre": "Tadó", "departamento": "Chocó", "Aa": 0.35, "Av": 0.35, "lat": 5.262, "lon": -76.567},

    # ===== CÓRDOBA =====
    "monteria": {"nombre": "Montería", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.757, "lon": -75.890},
    "lorica": {"nombre": "Lorica", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 9.238, "lon": -75.816},
    "montelibano": {"nombre": "Montelíbano", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 7.979, "lon": -75.419},
    "cerete": {"nombre": "Cereté", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.884, "lon": -75.793},
    "cienaga-de-oro": {"nombre": "Ciénaga de Oro", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.888, "lon": -75.625},
    "sahagun": {"nombre": "Sahagún", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.951, "lon": -75.453},
    "planeta-rica": {"nombre": "Planeta Rica", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.404, "lon": -75.581},
    "tierralta": {"nombre": "Tierralta", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.170, "lon": -76.057},
    "pueblo-nuevo": {"nombre": "Pueblo Nuevo", "departamento": "Córdoba", "Aa": 0.10, "Av": 0.10, "lat": 8.616, "lon": -75.533},

    # ===== CUNDINAMARCA =====
    "soacha": {"nombre": "Soacha", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.577, "lon": -74.217},
    "facatativa": {"nombre": "Facatativá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.817, "lon": -74.357},
    "zipaquira": {"nombre": "Zipaquirá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 5.023, "lon": -74.009},
    "fusagasuga": {"nombre": "Fusagasugá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.337, "lon": -74.363},
    "girardot": {"nombre": "Girardot", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.302, "lon": -74.800},
    "chia": {"nombre": "Chía", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.860, "lon": -73.921},
    "cajica": {"nombre": "Cajicá", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.918, "lon": -73.981},
    "tenjo": {"nombre": "Tenjo", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.872, "lon": -74.143},
    "madrid": {"nombre": "Madrid", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.731, "lon": -74.262},
    "mosquera": {"nombre": "Mosquera", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.706, "lon": -74.230},
    "funza": {"nombre": "Funza", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.716, "lon": -74.210},
    "cota": {"nombre": "Cota", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.809, "lon": -74.105},
    "la-calera": {"nombre": "La Calera", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.724, "lon": -73.968},
    "guasca": {"nombre": "Guasca", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.864, "lon": -73.876},
    "villeta": {"nombre": "Villeta", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 5.018, "lon": -74.470},
    "tocaima": {"nombre": "Tocaima", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.457, "lon": -74.640},
    "anapoima": {"nombre": "Anapoima", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.549, "lon": -74.537},
    "arbelaez": {"nombre": "Arbeláez", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.272, "lon": -74.416},
    "silvania": {"nombre": "Silvania", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 4.400, "lon": -74.393},
    "utica": {"nombre": "Útica", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 5.179, "lon": -74.479},
    "guaduas": {"nombre": "Guaduas", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 5.075, "lon": -74.600},
    "nemocon": {"nombre": "Nemocón", "departamento": "Cundinamarca", "Aa": 0.15, "Av": 0.20, "lat": 5.068, "lon": -73.881},

    # ===== GUAINÍA =====
    "puerto-inirida": {"nombre": "Puerto Inírida", "departamento": "Guainía", "Aa": 0.05, "Av": 0.05, "lat": 3.865, "lon": -67.922},

    # ===== GUAVIARE =====
    "san-jose-del-guaviare": {"nombre": "San José del Guaviare", "departamento": "Guaviare", "Aa": 0.10, "Av": 0.10, "lat": 2.571, "lon": -72.640},
    "calamar-guaviare": {"nombre": "Calamar", "departamento": "Guaviare", "Aa": 0.05, "Av": 0.10, "lat": 1.999, "lon": -72.641},

    # ===== HUILA =====
    "neiva": {"nombre": "Neiva", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.928, "lon": -75.280},
    "pitalito": {"nombre": "Pitalito", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 1.852, "lon": -76.051},
    "garzon": {"nombre": "Garzón", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.197, "lon": -75.627},
    "la-plata": {"nombre": "La Plata", "departamento": "Huila", "Aa": 0.25, "Av": 0.30, "lat": 2.385, "lon": -75.897},
    "campoalegre": {"nombre": "Campoalegre", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.688, "lon": -75.333},
    "hobo": {"nombre": "Hobo", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.564, "lon": -75.449},
    "rivera": {"nombre": "Rivera", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.780, "lon": -75.240},
    "san-agustin": {"nombre": "San Agustín", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 1.887, "lon": -76.272},
    "algeciras": {"nombre": "Algeciras", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.527, "lon": -75.321},
    "acevedo": {"nombre": "Acevedo", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 1.821, "lon": -75.897},
    "aipe": {"nombre": "Aipe", "departamento": "Huila", "Aa": 0.15, "Av": 0.20, "lat": 3.225, "lon": -75.241},
    "palermo": {"nombre": "Palermo", "departamento": "Huila", "Aa": 0.20, "Av": 0.25, "lat": 2.890, "lon": -75.431},

    # ===== LA GUAJIRA =====
    "riohacha": {"nombre": "Riohacha", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.15, "lat": 11.545, "lon": -72.907},
    "maicao": {"nombre": "Maicao", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.10, "lat": 11.382, "lon": -72.247},
    "uribia": {"nombre": "Uribia", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.10, "lat": 11.714, "lon": -72.264},
    "san-juan-del-cesar": {"nombre": "San Juan del Cesar", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.15, "lat": 10.767, "lon": -73.006},
    "fonseca": {"nombre": "Fonseca", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.15, "lat": 10.897, "lon": -72.855},
    "manaure": {"nombre": "Manaure", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.10, "lat": 11.780, "lon": -72.450},
    "distraccion": {"nombre": "Distracción", "departamento": "La Guajira", "Aa": 0.10, "Av": 0.15, "lat": 10.993, "lon": -72.866},

    # ===== MAGDALENA =====
    "santa-marta": {"nombre": "Santa Marta", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 11.244, "lon": -74.200},
    "cienaga": {"nombre": "Ciénaga", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 11.006, "lon": -74.251},
    "fundacion": {"nombre": "Fundación", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 10.524, "lon": -74.190},
    "el-banco": {"nombre": "El Banco", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.10, "lat": 9.003, "lon": -73.975},
    "plato": {"nombre": "Plato", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.10, "lat": 9.791, "lon": -74.783},
    "pivijay": {"nombre": "Pivijay", "departamento": "Magdalena", "Aa": 0.05, "Av": 0.05, "lat": 10.468, "lon": -74.619},
    "aracataca": {"nombre": "Aracataca", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.15, "lat": 10.593, "lon": -74.190},
    "san-zenon": {"nombre": "San Zenón", "departamento": "Magdalena", "Aa": 0.10, "Av": 0.10, "lat": 9.258, "lon": -74.493},

    # ===== META =====
    "villavicencio": {"nombre": "Villavicencio", "departamento": "Meta", "Aa": 0.15, "Av": 0.15, "lat": 4.142, "lon": -73.626},
    "acacias": {"nombre": "Acacías", "departamento": "Meta", "Aa": 0.15, "Av": 0.15, "lat": 3.989, "lon": -73.758},
    "granada-meta": {"nombre": "Granada", "departamento": "Meta", "Aa": 0.10, "Av": 0.15, "lat": 3.540, "lon": -73.704},
    "puerto-lopez": {"nombre": "Puerto López", "departamento": "Meta", "Aa": 0.10, "Av": 0.10, "lat": 4.085, "lon": -72.959},
    "cumaral": {"nombre": "Cumaral", "departamento": "Meta", "Aa": 0.10, "Av": 0.15, "lat": 4.271, "lon": -73.488},
    "restrepo-meta": {"nombre": "Restrepo", "departamento": "Meta", "Aa": 0.10, "Av": 0.15, "lat": 4.255, "lon": -73.566},
    "san-martin-meta": {"nombre": "San Martín", "departamento": "Meta", "Aa": 0.10, "Av": 0.10, "lat": 3.697, "lon": -73.699},
    "puerto-gaitan": {"nombre": "Puerto Gaitán", "departamento": "Meta", "Aa": 0.05, "Av": 0.10, "lat": 4.314, "lon": -72.082},
    "lejanias": {"nombre": "Lejanías", "departamento": "Meta", "Aa": 0.10, "Av": 0.15, "lat": 3.534, "lon": -74.020},

    # ===== NARIÑO =====
    "pasto": {"nombre": "Pasto", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 1.214, "lon": -77.281},
    "ipiales": {"nombre": "Ipiales", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 0.830, "lon": -77.643},
    "tuquerres": {"nombre": "Túquerres", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 1.088, "lon": -77.619},
    "tumaco": {"nombre": "Tumaco", "departamento": "Nariño", "Aa": 0.40, "Av": 0.45, "lat": 1.808, "lon": -78.769},
    "barbacoas": {"nombre": "Barbacoas", "departamento": "Nariño", "Aa": 0.40, "Av": 0.40, "lat": 1.673, "lon": -78.141},
    "la-union-narino": {"nombre": "La Unión", "departamento": "Nariño", "Aa": 0.20, "Av": 0.25, "lat": 1.595, "lon": -77.132},
    "la-cruz": {"nombre": "La Cruz", "departamento": "Nariño", "Aa": 0.20, "Av": 0.25, "lat": 1.601, "lon": -76.966},
    "samaniego": {"nombre": "Samaniego", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 1.339, "lon": -77.590},
    "el-charco": {"nombre": "El Charco", "departamento": "Nariño", "Aa": 0.40, "Av": 0.40, "lat": 2.477, "lon": -78.113},
    "olaya-herrera": {"nombre": "Olaya Herrera", "departamento": "Nariño", "Aa": 0.40, "Av": 0.45, "lat": 2.367, "lon": -78.573},
    "cumbal": {"nombre": "Cumbal", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 0.900, "lon": -77.794},
    "ricaurte-narino": {"nombre": "Ricaurte", "departamento": "Nariño", "Aa": 0.40, "Av": 0.40, "lat": 1.218, "lon": -78.008},
    "la-llanada": {"nombre": "La Llanada", "departamento": "Nariño", "Aa": 0.25, "Av": 0.30, "lat": 1.589, "lon": -77.523},
    "belen-narino": {"nombre": "Belén", "departamento": "Nariño", "Aa": 0.20, "Av": 0.25, "lat": 1.617, "lon": -77.109},

    # ===== NORTE DE SANTANDER =====
    "cucuta": {"nombre": "Cúcuta", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.893, "lon": -72.505},
    "pamplona": {"nombre": "Pamplona", "departamento": "Norte de Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.377, "lon": -72.649},
    "ocana": {"nombre": "Ocaña", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 8.235, "lon": -73.356},
    "tibu": {"nombre": "Tibú", "departamento": "Norte de Santander", "Aa": 0.10, "Av": 0.15, "lat": 8.664, "lon": -72.735},
    "los-patios": {"nombre": "Los Patios", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.837, "lon": -72.490},
    "villa-del-rosario": {"nombre": "Villa del Rosario", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.831, "lon": -72.469},
    "el-zulia": {"nombre": "El Zulia", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.934, "lon": -72.598},
    "abrego": {"nombre": "Ábrego", "departamento": "Norte de Santander", "Aa": 0.15, "Av": 0.20, "lat": 8.085, "lon": -73.222},
    "teorama": {"nombre": "Teorama", "departamento": "Norte de Santander", "Aa": 0.10, "Av": 0.15, "lat": 8.442, "lon": -73.296},

    # ===== PUTUMAYO =====
    "mocoa": {"nombre": "Mocoa", "departamento": "Putumayo", "Aa": 0.30, "Av": 0.30, "lat": 1.149, "lon": -76.649},
    "puerto-asis": {"nombre": "Puerto Asís", "departamento": "Putumayo", "Aa": 0.25, "Av": 0.30, "lat": 0.506, "lon": -76.508},
    "la-hormiga": {"nombre": "La Hormiga", "departamento": "Putumayo", "Aa": 0.30, "Av": 0.35, "lat": 0.448, "lon": -76.897},
    "orito": {"nombre": "Orito", "departamento": "Putumayo", "Aa": 0.25, "Av": 0.30, "lat": 0.662, "lon": -76.877},
    "sibundoy": {"nombre": "Sibundoy", "departamento": "Putumayo", "Aa": 0.30, "Av": 0.30, "lat": 1.207, "lon": -76.928},
    "san-francisco-putumayo": {"nombre": "San Francisco", "departamento": "Putumayo", "Aa": 0.30, "Av": 0.35, "lat": 1.135, "lon": -76.887},
    "villagarzon": {"nombre": "Villagarzón", "departamento": "Putumayo", "Aa": 0.25, "Av": 0.30, "lat": 1.037, "lon": -76.623},

    # ===== QUINDÍO =====
    "armenia": {"nombre": "Armenia", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.534, "lon": -75.681},
    "calarca": {"nombre": "Calarcá", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.527, "lon": -75.640},
    "montenegro": {"nombre": "Montenegro", "departamento": "Quindío", "Aa": 0.25, "Av": 0.25, "lat": 4.565, "lon": -75.754},
    "quimbaya": {"nombre": "Quimbaya", "departamento": "Quindío", "Aa": 0.25, "Av": 0.25, "lat": 4.621, "lon": -75.764},
    "filandia": {"nombre": "Filandia", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.673, "lon": -75.655},
    "la-tebaida": {"nombre": "La Tebaida", "departamento": "Quindío", "Aa": 0.25, "Av": 0.25, "lat": 4.447, "lon": -75.797},
    "buenavista-quindio": {"nombre": "Buenavista", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.465, "lon": -75.615},
    "pijao": {"nombre": "Pijao", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.327, "lon": -75.698},
    "genova": {"nombre": "Génova", "departamento": "Quindío", "Aa": 0.25, "Av": 0.30, "lat": 4.215, "lon": -75.756},

    # ===== RISARALDA =====
    "pereira": {"nombre": "Pereira", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.814, "lon": -75.696},
    "dosquebradas": {"nombre": "Dosquebradas", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.840, "lon": -75.673},
    "santa-rosa-de-cabal": {"nombre": "Santa Rosa de Cabal", "departamento": "Risaralda", "Aa": 0.25, "Av": 0.25, "lat": 4.869, "lon": -75.621},
    "la-virginia": {"nombre": "La Virginia", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.899, "lon": -75.880},
    "belen-de-umbria": {"nombre": "Belén de Umbría", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 5.208, "lon": -75.876},
    "quinchia": {"nombre": "Quinchía", "departamento": "Risaralda", "Aa": 0.25, "Av": 0.25, "lat": 5.338, "lon": -75.729},
    "marsella": {"nombre": "Marsella", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 4.937, "lon": -75.749},
    "santuario-risaralda": {"nombre": "Santuario", "departamento": "Risaralda", "Aa": 0.20, "Av": 0.25, "lat": 5.068, "lon": -75.962},
    "pueblo-rico": {"nombre": "Pueblo Rico", "departamento": "Risaralda", "Aa": 0.30, "Av": 0.30, "lat": 5.235, "lon": -76.030},

    # ===== SAN ANDRÉS =====
    "san-andres": {"nombre": "San Andrés", "departamento": "San Andrés y Providencia", "Aa": 0.10, "Av": 0.10, "lat": 12.536, "lon": -81.716},

    # ===== SANTANDER =====
    "bucaramanga": {"nombre": "Bucaramanga", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.119, "lon": -73.123},
    "floridablanca": {"nombre": "Floridablanca", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.064, "lon": -73.089},
    "giron": {"nombre": "Girón", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.073, "lon": -73.170},
    "barrancabermeja": {"nombre": "Barrancabermeja", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 7.063, "lon": -73.850},
    "velez": {"nombre": "Vélez", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.010, "lon": -73.678},
    "lebrija": {"nombre": "Lebrija", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 7.127, "lon": -73.219},
    "piedecuesta": {"nombre": "Piedecuesta", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 6.990, "lon": -73.050},
    "san-gil": {"nombre": "San Gil", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.553, "lon": -73.136},
    "socorro": {"nombre": "Socorro", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.463, "lon": -73.267},
    "malaga": {"nombre": "Málaga", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.697, "lon": -72.738},
    "san-vicente-de-chucuri": {"nombre": "San Vicente de Chucurí", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 6.893, "lon": -73.413},
    "barbosa-santander": {"nombre": "Barbosa", "departamento": "Santander", "Aa": 0.20, "Av": 0.25, "lat": 5.931, "lon": -73.611},
    "charala": {"nombre": "Charalá", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.287, "lon": -73.145},
    "suaita": {"nombre": "Suaita", "departamento": "Santander", "Aa": 0.15, "Av": 0.20, "lat": 6.095, "lon": -73.441},

    # ===== SUCRE =====
    "sincelejo": {"nombre": "Sincelejo", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.304, "lon": -75.397},
    "corozal": {"nombre": "Corozal", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.321, "lon": -75.285},
    "sampues": {"nombre": "Sampués", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.191, "lon": -75.331},
    "since": {"nombre": "Sincé", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.236, "lon": -75.145},
    "san-marcos": {"nombre": "San Marcos", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 8.659, "lon": -75.125},
    "tolu": {"nombre": "Tolú", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.534, "lon": -75.577},
    "morroa": {"nombre": "Morroa", "departamento": "Sucre", "Aa": 0.10, "Av": 0.10, "lat": 9.324, "lon": -75.298},

    # ===== TOLIMA =====
    "ibague": {"nombre": "Ibagué", "departamento": "Tolima", "Aa": 0.20, "Av": 0.20, "lat": 4.438, "lon": -75.232},
    "espinal": {"nombre": "Espinal", "departamento": "Tolima", "Aa": 0.20, "Av": 0.20, "lat": 4.152, "lon": -74.892},
    "honda": {"nombre": "Honda", "departamento": "Tolima", "Aa": 0.15, "Av": 0.20, "lat": 5.209, "lon": -74.744},
    "chaparral": {"nombre": "Chaparral", "departamento": "Tolima", "Aa": 0.25, "Av": 0.25, "lat": 3.726, "lon": -75.491},
    "libano": {"nombre": "Líbano", "departamento": "Tolima", "Aa": 0.20, "Av": 0.20, "lat": 4.921, "lon": -75.063},
    "lerida": {"nombre": "Lérida", "departamento": "Tolima", "Aa": 0.20, "Av": 0.20, "lat": 4.871, "lon": -74.929},
    "ambalema": {"nombre": "Ambalema", "departamento": "Tolima", "Aa": 0.15, "Av": 0.20, "lat": 4.784, "lon": -74.770},
    "fresno": {"nombre": "Fresno", "departamento": "Tolima", "Aa": 0.20, "Av": 0.25, "lat": 5.155, "lon": -75.044},
    "mariquita": {"nombre": "Mariquita", "departamento": "Tolima", "Aa": 0.15, "Av": 0.20, "lat": 5.198, "lon": -74.893},
    "melgar": {"nombre": "Melgar", "departamento": "Tolima", "Aa": 0.15, "Av": 0.20, "lat": 4.203, "lon": -74.643},
    "purificacion": {"nombre": "Purificación", "departamento": "Tolima", "Aa": 0.15, "Av": 0.20, "lat": 3.857, "lon": -74.931},
    "planadas": {"nombre": "Planadas", "departamento": "Tolima", "Aa": 0.25, "Av": 0.25, "lat": 3.195, "lon": -75.647},
    "rovira": {"nombre": "Rovira", "departamento": "Tolima", "Aa": 0.20, "Av": 0.25, "lat": 4.244, "lon": -75.265},

    # ===== VALLE DEL CAUCA =====
    "cali": {"nombre": "Cali", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.451, "lon": -76.532},
    "buenaventura": {"nombre": "Buenaventura", "departamento": "Valle del Cauca", "Aa": 0.35, "Av": 0.35, "lat": 3.883, "lon": -77.017},
    "palmira": {"nombre": "Palmira", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.539, "lon": -76.304},
    "buga": {"nombre": "Guadalajara de Buga", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.900, "lon": -76.299},
    "cartago": {"nombre": "Cartago", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.745, "lon": -75.913},
    "tulua": {"nombre": "Tuluá", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.084, "lon": -76.199},
    "jamundi": {"nombre": "Jamundí", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.263, "lon": -76.538},
    "yumbo": {"nombre": "Yumbo", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.592, "lon": -76.492},
    "candelaria": {"nombre": "Candelaria", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.406, "lon": -76.346},
    "pradera": {"nombre": "Pradera", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.413, "lon": -76.243},
    "florida-valle": {"nombre": "Florida", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.25, "lat": 3.326, "lon": -76.236},
    "guacari": {"nombre": "Guacarí", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.760, "lon": -76.336},
    "ginebra": {"nombre": "Ginebra", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.736, "lon": -76.272},
    "el-cerrito": {"nombre": "El Cerrito", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 3.693, "lon": -76.289},
    "zarzal": {"nombre": "Zarzal", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.394, "lon": -76.071},
    "roldanillo": {"nombre": "Roldanillo", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.416, "lon": -76.155},
    "sevilla": {"nombre": "Sevilla", "departamento": "Valle del Cauca", "Aa": 0.20, "Av": 0.25, "lat": 4.268, "lon": -75.940},
    "calima": {"nombre": "Calima (Darién)", "departamento": "Valle del Cauca", "Aa": 0.25, "Av": 0.30, "lat": 3.945, "lon": -76.480},

    # ===== VAUPÉS =====
    "mitu": {"nombre": "Mitú", "departamento": "Vaupés", "Aa": 0.10, "Av": 0.10, "lat": 1.198, "lon": -70.173},

    # ===== VICHADA =====
    "puerto-carreno": {"nombre": "Puerto Carreño", "departamento": "Vichada", "Aa": 0.05, "Av": 0.05, "lat": 6.188, "lon": -67.487},
    "la-primavera": {"nombre": "La Primavera", "departamento": "Vichada", "Aa": 0.05, "Av": 0.05, "lat": 5.492, "lon": -70.409},
}


# ---------------------------------------------------------------------------
# Microzonificacion sismica — espectros especificos por ciudad
#
# Fuentes:
#   Bogotá  — IDIGER/FOPAE, Microzonificación Sísmica de Bogotá D.C. (2010)
#   Medellín — AMVA/U. Antioquia, Microzonificación Sísmica del Valle de Aburrá (2006)
#   Cali    — OSSO/DAGMA, Microzonificación Sísmica de Cali (2005)
#   Pereira — CARDER, Microzonificación Sísmica de Pereira (2007)
#   Armenia — Microzonificación post-sismo del Quindío (2000)
#   Manizales — CRECE/INGEOMINAS, Microzonificación Sísmica de Manizales (2002)
#   Bucaramanga — AMB/CDMB, Microzonificación Sísmica del AMB (2015)
#
# Los parámetros SDs, SD1, T0, Ts se calculan a partir de Aa_base, Av_base y
# los factores de amplificación efectivos de cada zona (Fa_eff, Fv_eff):
#   SDs = 2.5 * Aa_base * Fa_eff
#   SD1 = Av_base * Fv_eff
#   Ts  = SD1 / SDs
#   T0  = 0.2 * Ts
# ---------------------------------------------------------------------------
MICROZONIFICACION: dict[str, dict] = {
    "bogota": {
        "nombre": "Bogotá D.C.",
        "estudio": "Microzonificación Sísmica de Bogotá D.C. — IDIGER/FOPAE (2010)",
        "Aa_base": 0.15,
        "Av_base": 0.20,
        "nota": (
            "Estudio actualizado por el IDIGER. Define 6 zonas geotécnicas-sísmicas "
            "que van desde roca en los cerros orientales hasta rellenos y lacustres "
            "blandos en la sabana. Los factores Fa_eff/Fv_eff reflejan la amplificación "
            "real medida con registros de movimiento fuerte."
        ),
        "zonas": [
            {
                "id": "cerros",
                "nombre": "Zona 1 — Cerros (Roca)",
                "descripcion": "Afloramientos de roca y depósitos superficiales muy delgados en los cerros orientales.",
                "color": "#087f5b",
                "Fa_eff": 0.80, "Fv_eff": 0.80,
                "SDs": 0.3000, "SD1": 0.1600, "T0": 0.1067, "Ts": 0.5333, "TL": 4.0,
            },
            {
                "id": "piedemonte",
                "nombre": "Zona 2 — Piedemonte",
                "descripcion": "Abanicos aluviales y depósitos de ladera consolidados al pie de los cerros.",
                "color": "#2f9e44",
                "Fa_eff": 1.00, "Fv_eff": 1.20,
                "SDs": 0.3750, "SD1": 0.2400, "T0": 0.1280, "Ts": 0.6400, "TL": 4.0,
            },
            {
                "id": "lacustre-firme",
                "nombre": "Zona 3 — Lacustre Firme",
                "descripcion": "Sedimentos lacustres de la antigua laguna de Bogotá, densos y sobreconsolidados.",
                "color": "#f59f00",
                "Fa_eff": 1.20, "Fv_eff": 1.80,
                "SDs": 0.4500, "SD1": 0.3600, "T0": 0.1600, "Ts": 0.8000, "TL": 4.0,
            },
            {
                "id": "lacustre-suave",
                "nombre": "Zona 4 — Lacustre Suave",
                "descripcion": "Arcillas blandas a muy blandas de origen lacustre, alta plasticidad y compresibilidad.",
                "color": "#e67700",
                "Fa_eff": 1.50, "Fv_eff": 2.80,
                "SDs": 0.5625, "SD1": 0.5600, "T0": 0.1991, "Ts": 0.9956, "TL": 4.0,
            },
            {
                "id": "aluvial",
                "nombre": "Zona 5 — Depósitos Aluviales",
                "descripcion": "Gravas y arenas aluviales de los ríos Bogotá, Fucha, Tunjuelo y Juan Amarillo.",
                "color": "#1971c2",
                "Fa_eff": 1.30, "Fv_eff": 2.20,
                "SDs": 0.4875, "SD1": 0.4400, "T0": 0.1805, "Ts": 0.9026, "TL": 4.0,
            },
            {
                "id": "rellenos",
                "nombre": "Zona 6 — Rellenos Artificiales",
                "descripcion": "Rellenos heterogéneos y zonas de humedales drenados, comportamiento impredecible.",
                "color": "#c92a2a",
                "Fa_eff": 1.70, "Fv_eff": 3.20,
                "SDs": 0.6375, "SD1": 0.6400, "T0": 0.2008, "Ts": 1.0039, "TL": 4.0,
            },
        ],
    },
    "medellin": {
        "nombre": "Medellín (Valle de Aburrá)",
        "estudio": "Microzonificación Sísmica del Valle de Aburrá — AMVA / U. de Antioquia (2006)",
        "Aa_base": 0.15,
        "Av_base": 0.20,
        "nota": (
            "Estudio para el Área Metropolitana del Valle de Aburrá. Identifica 5 zonas "
            "según la velocidad de onda de corte y condición geomorfológica: laderas altas "
            "en roca, suelos firmes de ladera, suelos intermedios, suelos blandos en fondo "
            "de valle y zonas especiales de ladera con riesgo geotécnico."
        ),
        "zonas": [
            {
                "id": "ladera-roca",
                "nombre": "Zona A — Ladera Alta (Roca)",
                "descripcion": "Roca granítica y metamórfica en cotas altas de las laderas del Aburrá.",
                "color": "#087f5b",
                "Fa_eff": 0.90, "Fv_eff": 0.90,
                "SDs": 0.3375, "SD1": 0.1800, "T0": 0.1067, "Ts": 0.5333, "TL": 4.0,
            },
            {
                "id": "suelo-firme",
                "nombre": "Zona B — Suelo Firme de Ladera",
                "descripcion": "Saprolitos y depósitos de ladera con Vs > 300 m/s.",
                "color": "#2f9e44",
                "Fa_eff": 1.10, "Fv_eff": 1.50,
                "SDs": 0.4125, "SD1": 0.3000, "T0": 0.1455, "Ts": 0.7273, "TL": 4.0,
            },
            {
                "id": "suelo-intermedio",
                "nombre": "Zona C — Suelo Intermedio",
                "descripcion": "Aluviones y depósitos coluviales de resistencia media en las terrazas intermedias.",
                "color": "#f59f00",
                "Fa_eff": 1.30, "Fv_eff": 2.00,
                "SDs": 0.4875, "SD1": 0.4000, "T0": 0.1641, "Ts": 0.8205, "TL": 4.0,
            },
            {
                "id": "suelo-blando",
                "nombre": "Zona D — Suelo Blando (Fondo de Valle)",
                "descripcion": "Sedimentos aluviales finos y arcillas blandas en el fondo del valle del río Medellín.",
                "color": "#e67700",
                "Fa_eff": 1.50, "Fv_eff": 2.80,
                "SDs": 0.5625, "SD1": 0.5600, "T0": 0.1991, "Ts": 0.9956, "TL": 4.0,
            },
            {
                "id": "ladera-suelo",
                "nombre": "Zona E — Ladera con Suelo Residual",
                "descripcion": "Laderas con perfiles de suelo residual profundo y potencial de inestabilidad.",
                "color": "#862e9c",
                "Fa_eff": 1.20, "Fv_eff": 1.70,
                "SDs": 0.4500, "SD1": 0.3400, "T0": 0.1511, "Ts": 0.7556, "TL": 4.0,
            },
        ],
    },
    "cali": {
        "nombre": "Cali",
        "estudio": "Microzonificación Sísmica de Santiago de Cali — OSSO / DAGMA (2005)",
        "Aa_base": 0.25,
        "Av_base": 0.25,
        "nota": (
            "Estudio de la Corporación OSSO para el DAGMA. Cali está ubicada en el "
            "piedemonte de la Cordillera Occidental cerca de la falla de Cali-Patía. "
            "Define 5 zonas: desde cerros en roca hasta la llanura aluvial del río Cauca "
            "con suelos blandos. Los factores de amplificación exceden las tablas estándar "
            "NSR-10 para suelos tipo D/E en las zonas de planicie."
        ),
        "zonas": [
            {
                "id": "cerros-roca",
                "nombre": "Zona 1 — Cerros (Roca y Suelo Firme)",
                "descripcion": "Roca metamórfica y suelos residuales muy compactos en los cerros occidentales.",
                "color": "#087f5b",
                "Fa_eff": 0.90, "Fv_eff": 0.90,
                "SDs": 0.5625, "SD1": 0.2250, "T0": 0.0800, "Ts": 0.4000, "TL": 4.0,
            },
            {
                "id": "piedemonte-cali",
                "nombre": "Zona 2 — Piedemonte",
                "descripcion": "Abanicos aluviales y depósitos de ladera compactos al pie de la cordillera.",
                "color": "#2f9e44",
                "Fa_eff": 1.10, "Fv_eff": 1.20,
                "SDs": 0.6875, "SD1": 0.3000, "T0": 0.0873, "Ts": 0.4364, "TL": 4.0,
            },
            {
                "id": "planicie-firme",
                "nombre": "Zona 3 — Planicie Aluvial Firme",
                "descripcion": "Gravas y arenas aluviales densas del abanico del río Cali.",
                "color": "#f59f00",
                "Fa_eff": 1.20, "Fv_eff": 1.60,
                "SDs": 0.7500, "SD1": 0.4000, "T0": 0.1067, "Ts": 0.5333, "TL": 4.0,
            },
            {
                "id": "llanura-blanda",
                "nombre": "Zona 4 — Llanura Aluvial Blanda",
                "descripcion": "Arcillas y limos blandos de la llanura de inundación del río Cauca.",
                "color": "#e67700",
                "Fa_eff": 1.40, "Fv_eff": 2.20,
                "SDs": 0.8750, "SD1": 0.5500, "T0": 0.1257, "Ts": 0.6286, "TL": 4.0,
            },
            {
                "id": "retiro-rios",
                "nombre": "Zona 5 — Zona de Retiro de Ríos",
                "descripcion": "Depósitos muy blandos en márgenes de ríos y zonas de humedales drenados.",
                "color": "#c92a2a",
                "Fa_eff": 1.50, "Fv_eff": 2.80,
                "SDs": 0.9375, "SD1": 0.7000, "T0": 0.1493, "Ts": 0.7467, "TL": 4.0,
            },
        ],
    },
    "pereira": {
        "nombre": "Pereira",
        "estudio": "Microzonificación Sísmica de Pereira — CARDER / FOREC (2007)",
        "Aa_base": 0.20,
        "Av_base": 0.25,
        "nota": (
            "Estudio desarrollado por CARDER como parte de la reconstrucción post-sismo "
            "del Eje Cafetero (1999). Pereira presenta una topografía muy quebrada con "
            "depósitos de ceniza volcánica del Nevado del Ruiz que amplifican el movimiento. "
            "4 zonas que van de ladera en roca hasta valles aluviales con suelos blandos."
        ),
        "zonas": [
            {
                "id": "ladera-roca-pereira",
                "nombre": "Zona 1 — Ladera en Roca",
                "descripcion": "Afloramientos de roca diorítica y suelos residuales muy compactos en cotas altas.",
                "color": "#087f5b",
                "Fa_eff": 0.90, "Fv_eff": 0.90,
                "SDs": 0.4500, "SD1": 0.2250, "T0": 0.1000, "Ts": 0.5000, "TL": 4.0,
            },
            {
                "id": "ladera-suelo-pereira",
                "nombre": "Zona 2 — Ladera con Suelo y Ceniza",
                "descripcion": "Cenizas volcánicas compactadas y saprolitos en laderas intermedias.",
                "color": "#2f9e44",
                "Fa_eff": 1.20, "Fv_eff": 1.50,
                "SDs": 0.6000, "SD1": 0.3750, "T0": 0.1250, "Ts": 0.6250, "TL": 4.0,
            },
            {
                "id": "valle-firme-pereira",
                "nombre": "Zona 3 — Valle Aluvial Firme",
                "descripcion": "Terrazas aluviales y depósitos fluviales densos en los fondos de quebradas.",
                "color": "#f59f00",
                "Fa_eff": 1.30, "Fv_eff": 2.00,
                "SDs": 0.6500, "SD1": 0.5000, "T0": 0.1538, "Ts": 0.7692, "TL": 4.0,
            },
            {
                "id": "valle-blando-pereira",
                "nombre": "Zona 4 — Valle Aluvial Blando",
                "descripcion": "Depósitos finos y cenizas re-depositadas en zonas bajas con drenaje deficiente.",
                "color": "#e67700",
                "Fa_eff": 1.50, "Fv_eff": 2.80,
                "SDs": 0.7500, "SD1": 0.7000, "T0": 0.1867, "Ts": 0.9333, "TL": 4.0,
            },
        ],
    },
    "armenia": {
        "nombre": "Armenia",
        "estudio": "Microzonificación Sísmica de Armenia — FOREC / OSSO (2000)",
        "Aa_base": 0.25,
        "Av_base": 0.30,
        "nota": (
            "Estudio elaborado tras el sismo del Quindío del 25 de enero de 1999 (Mw 6.2). "
            "Armenia está construida sobre un plateau disectado de cenizas volcánicas del "
            "Nevado del Ruiz, con gran variabilidad local de amplificación. Se identificaron "
            "4 zonas de respuesta sísmica diferenciada."
        ),
        "zonas": [
            {
                "id": "roca-firme-armenia",
                "nombre": "Zona 1 — Roca y Suelo Muy Firme",
                "descripcion": "Roca o suelo residual muy compacto con Vs > 600 m/s en cabeceras de cuencas.",
                "color": "#087f5b",
                "Fa_eff": 0.90, "Fv_eff": 0.90,
                "SDs": 0.5625, "SD1": 0.2700, "T0": 0.0960, "Ts": 0.4800, "TL": 4.0,
            },
            {
                "id": "ceniza-compacta-armenia",
                "nombre": "Zona 2 — Ceniza Volcánica Compacta",
                "descripcion": "Depósitos de ceniza volcánica medianamente compactos, Vs entre 300-600 m/s.",
                "color": "#2f9e44",
                "Fa_eff": 1.10, "Fv_eff": 1.30,
                "SDs": 0.6875, "SD1": 0.3900, "T0": 0.1135, "Ts": 0.5673, "TL": 4.0,
            },
            {
                "id": "ceniza-blanda-armenia",
                "nombre": "Zona 3 — Ceniza Blanda y Aluvial",
                "descripcion": "Cenizas re-depositadas y aluviones sueltos en fondos de quebradas, Vs 150-300 m/s.",
                "color": "#f59f00",
                "Fa_eff": 1.30, "Fv_eff": 1.80,
                "SDs": 0.8125, "SD1": 0.5400, "T0": 0.1329, "Ts": 0.6646, "TL": 4.0,
            },
            {
                "id": "rellenos-blandos-armenia",
                "nombre": "Zona 4 — Rellenos y Suelos Blandos",
                "descripcion": "Rellenos heterogéneos y suelos blandos en terrazas bajas y cañadas.",
                "color": "#c92a2a",
                "Fa_eff": 1.50, "Fv_eff": 2.50,
                "SDs": 0.9375, "SD1": 0.7500, "T0": 0.1600, "Ts": 0.8000, "TL": 4.0,
            },
        ],
    },
    "manizales": {
        "nombre": "Manizales",
        "estudio": "Microzonificación Sísmica de Manizales — CRECE / INGEOMINAS (2002)",
        "Aa_base": 0.25,
        "Av_base": 0.25,
        "nota": (
            "Manizales está emplazada sobre una cresta de la Cordillera Central con "
            "pendientes pronunciadas y depósitos de ceniza volcánica del Nevado del Ruiz. "
            "La alta amenaza sísmica (Aa=0.25) y la variabilidad topográfica producen "
            "amplificaciones muy diferentes entre las zonas alta (roca) y baja (rellenos)."
        ),
        "zonas": [
            {
                "id": "roca-ladera-alta",
                "nombre": "Zona 1 — Roca y Ladera Alta",
                "descripcion": "Afloramientos de roca ígnea y metamórfica en zonas de cresta y escarpes.",
                "color": "#087f5b",
                "Fa_eff": 0.90, "Fv_eff": 0.85,
                "SDs": 0.5625, "SD1": 0.2125, "T0": 0.0756, "Ts": 0.3778, "TL": 4.0,
            },
            {
                "id": "ladera-intermedia",
                "nombre": "Zona 2 — Ladera Intermedia con Suelo",
                "descripcion": "Saprolitos y cenizas compactas en laderas de pendiente moderada.",
                "color": "#2f9e44",
                "Fa_eff": 1.10, "Fv_eff": 1.20,
                "SDs": 0.6875, "SD1": 0.3000, "T0": 0.0873, "Ts": 0.4364, "TL": 4.0,
            },
            {
                "id": "ceniza-aluvial",
                "nombre": "Zona 3 — Ceniza Volcánica y Aluvial",
                "descripcion": "Cenizas volcánicas re-depositadas y aluviones sueltos en terrazas medias.",
                "color": "#f59f00",
                "Fa_eff": 1.30, "Fv_eff": 1.70,
                "SDs": 0.8125, "SD1": 0.4250, "T0": 0.1046, "Ts": 0.5231, "TL": 4.0,
            },
            {
                "id": "zonas-bajas-rellenos",
                "nombre": "Zona 4 — Zonas Bajas y Rellenos",
                "descripcion": "Rellenos antrópicos y suelos blandos en cañadas y zonas de expansión urbana.",
                "color": "#c92a2a",
                "Fa_eff": 1.50, "Fv_eff": 2.40,
                "SDs": 0.9375, "SD1": 0.6000, "T0": 0.1280, "Ts": 0.6400, "TL": 4.0,
            },
        ],
    },
    "bucaramanga": {
        "nombre": "Bucaramanga",
        "estudio": "Microzonificación Sísmica del Área Metropolitana de Bucaramanga — AMB / CDMB (2015)",
        "Aa_base": 0.20,
        "Av_base": 0.25,
        "nota": (
            "Bucaramanga está sobre una terraza aluvial disectada (Mesa de Ruitoque) "
            "con suelos residuales de rocas metamórficas y sedimentarias. El estudio del AMB "
            "cubre también Floridablanca, Girón y Piedecuesta. Define 4 zonas sísmicas "
            "según condición de suelo y posición topográfica."
        ),
        "zonas": [
            {
                "id": "roca-creston",
                "nombre": "Zona 1 — Roca y Crestón Rocoso",
                "descripcion": "Pizarras, esquistos y areniscas aflorantes con Vs > 700 m/s en zonas de escarpe.",
                "color": "#087f5b",
                "Fa_eff": 0.90, "Fv_eff": 0.90,
                "SDs": 0.4500, "SD1": 0.2250, "T0": 0.1000, "Ts": 0.5000, "TL": 4.0,
            },
            {
                "id": "suelo-firme-ladera",
                "nombre": "Zona 2 — Suelo Firme de Ladera",
                "descripcion": "Saprolitos compactos y depósitos coluviales densos en laderas del cañón del Río de Oro.",
                "color": "#2f9e44",
                "Fa_eff": 1.10, "Fv_eff": 1.40,
                "SDs": 0.5500, "SD1": 0.3500, "T0": 0.1273, "Ts": 0.6364, "TL": 4.0,
            },
            {
                "id": "terraza-aluvial",
                "nombre": "Zona 3 — Terraza Aluvial",
                "descripcion": "Depósitos aluviales y terrazas medias sobre el río Suratá y tributarios.",
                "color": "#f59f00",
                "Fa_eff": 1.30, "Fv_eff": 2.00,
                "SDs": 0.6500, "SD1": 0.5000, "T0": 0.1538, "Ts": 0.7692, "TL": 4.0,
            },
            {
                "id": "mesa-ruitoque",
                "nombre": "Zona 4 — Mesa de Ruitoque y Suelo Blando",
                "descripcion": "Arcillas expansivas y suelos blandos en la mesa tabular y zonas de cañadas.",
                "color": "#e67700",
                "Fa_eff": 1.50, "Fv_eff": 2.60,
                "SDs": 0.7500, "SD1": 0.6500, "T0": 0.1733, "Ts": 0.8667, "TL": 4.0,
            },
        ],
    },
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


def get_microzonificacion(municipio_id: str) -> dict | None:
    """Retorna los datos de microzonificacion sismica para un municipio, o None si no existe."""
    return MICROZONIFICACION.get(municipio_id)
