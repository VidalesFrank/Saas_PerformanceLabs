"""Endpoints del modulo de espectros sismicos NSR-10."""

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from engine.seismic import buscar_municipios, compute_spectrum, compute_spectrum_from_params, get_microzonificacion, zona_sismica
from engine.seismic.nsr10_data import MICROZONIFICACION, MUNICIPIOS, SOIL_TYPES
from engine.seismic.spectrum import USE_GROUP_I, USE_GROUP_LABEL

router = APIRouter(prefix="/api/v1/seismic", tags=["seismic"])


class MunicipioOut(BaseModel):
    id: str
    nombre: str
    departamento: str
    Aa: float
    Av: float
    lat: float | None = None
    lon: float | None = None
    zona_sismica: str
    code_dane: int | None = None
    zona: str | None = None  # "ALTA" / "INTERMEDIA" / "BAJA" (del Excel oficial)


class AllMunicipiosOut(BaseModel):
    municipios: list[MunicipioOut]


class MunicipiosStats(BaseModel):
    total: int
    con_coordenadas: int
    por_zona: dict[str, int]
    por_departamento: dict[str, int]


class SoilTypeInfo(BaseModel):
    id: str
    nombre: str
    descripcion: str


class EspectroRequest(BaseModel):
    municipio_id: str = Field(..., description="ID del municipio (ej: 'bogota')")
    soil_type: str = Field(..., description="Tipo de suelo NSR-10: A, B, C, D, E")
    T_max: float = Field(default=4.0, ge=1.0, le=10.0, description="Periodo maximo del espectro (s)")
    use_group: str = Field(default="I", description="Grupo de uso NSR-10 A.2.5: I, II, III, IV")


class PuntoEspectro(BaseModel):
    T: float
    Sa: float
    Sd: float
    Sv: float


class ParametrosEspectro(BaseModel):
    Aa: float
    Av: float
    Fa: float
    Fv: float
    SDs: float
    SD1: float
    T0: float
    Ts: float
    TL: float
    I: float = 1.0
    use_group: str = "I"


class EspectroOut(BaseModel):
    municipio: MunicipioOut
    soil_type: str
    params: ParametrosEspectro
    puntos: list[PuntoEspectro]
    zona_sismica: str


class UseGroupInfo(BaseModel):
    id: str
    nombre: str
    I: float


@router.get("/municipios", response_model=list[MunicipioOut])
def search_municipios(
    q: str = Query(default="", description="Texto de busqueda (nombre o departamento)"),
    limit: int = Query(default=20, ge=1, le=100),
) -> list[dict]:
    """Busca municipios por nombre o departamento."""
    if not q.strip():
        return []
    return buscar_municipios(q, limit=limit)


@router.get("/municipios/all", response_model=list[MunicipioOut])
def all_municipios() -> list[dict]:
    """Retorna todos los municipios de la base de datos (para poblar el mapa)."""
    return [
        {"id": mid, **data, "zona_sismica": zona_sismica(data["Aa"])}
        for mid, data in MUNICIPIOS.items()
    ]


@router.get("/municipios/stats", response_model=MunicipiosStats)
def municipios_stats() -> dict:
    """Estadísticos globales del catálogo: totales por zona y departamento."""
    por_zona: dict[str, int] = {}
    por_departamento: dict[str, int] = {}
    con_coords = 0
    for data in MUNICIPIOS.values():
        z = zona_sismica(data["Aa"])
        por_zona[z] = por_zona.get(z, 0) + 1
        dep = data.get("departamento") or "N/D"
        por_departamento[dep] = por_departamento.get(dep, 0) + 1
        if data.get("lat") is not None and data.get("lon") is not None:
            con_coords += 1
    return {
        "total": len(MUNICIPIOS),
        "con_coordenadas": con_coords,
        "por_zona": por_zona,
        "por_departamento": dict(sorted(por_departamento.items(), key=lambda t: -t[1])),
    }


@router.get("/soil-types", response_model=list[SoilTypeInfo])
def get_soil_types() -> list[dict]:
    """Lista los tipos de perfil de suelo NSR-10 con sus descripciones."""
    return [
        {"id": k, "nombre": v["nombre"], "descripcion": v["descripcion"]}
        for k, v in SOIL_TYPES.items()
    ]


@router.get("/use-groups", response_model=list[UseGroupInfo])
def get_use_groups() -> list[dict]:
    """Lista los grupos de uso NSR-10 A.2.5 con el coeficiente de importancia I."""
    return [
        {"id": k, "nombre": USE_GROUP_LABEL[k], "I": USE_GROUP_I[k]}
        for k in ("I", "II", "III", "IV")
    ]


@router.post("/espectro", response_model=EspectroOut)
def calcular_espectro(body: EspectroRequest) -> dict:
    """Calcula el espectro elastico de diseno NSR-10 para un municipio y tipo de suelo."""
    mun = MUNICIPIOS.get(body.municipio_id)
    if mun is None:
        raise HTTPException(status_code=404, detail=f"Municipio '{body.municipio_id}' no encontrado.")

    try:
        result = compute_spectrum(
            Aa=mun["Aa"],
            Av=mun["Av"],
            soil_type=body.soil_type,
            T_max=body.T_max,
            use_group=body.use_group,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    params_raw = result["params"]
    return {
        "municipio": {
            "id": body.municipio_id,
            **mun,
            "zona_sismica": result["zona_sismica"],
        },
        "soil_type": body.soil_type,
        "params": {
            "Aa": mun["Aa"],
            "Av": mun["Av"],
            "Fa": params_raw["Fa"],
            "Fv": params_raw["Fv"],
            "SDs": params_raw["SDs"],
            "SD1": params_raw["SD1"],
            "T0": params_raw["T0"],
            "Ts": params_raw["Ts"],
            "TL": params_raw["TL"],
            "I":  params_raw["I"],
            "use_group": params_raw["use_group"],
        },
        "puntos": result["puntos"],
        "zona_sismica": result["zona_sismica"],
    }


# ---------------------------------------------------------------------------
# Microzonificación
# ---------------------------------------------------------------------------

class MicrozonificacionZonaOut(BaseModel):
    id: str
    nombre: str
    descripcion: str
    color: str
    Fa_eff: float
    Fv_eff: float
    SDs: float
    SD1: float
    T0: float
    Ts: float
    TL: float


class MicrozonificacionOut(BaseModel):
    nombre: str
    estudio: str
    Aa_base: float
    Av_base: float
    nota: str
    zonas: list[MicrozonificacionZonaOut]


class EspectroMicrozonificacionRequest(BaseModel):
    municipio_id: str = Field(..., description="ID del municipio con microzonificacion (ej: 'bogota')")
    zona_id: str = Field(..., description="ID de la zona de microzonificacion (ej: 'cerros')")
    T_max: float = Field(default=4.0, ge=1.0, le=10.0)
    use_group: str = Field(default="I", description="Grupo de uso NSR-10 A.2.5: I, II, III, IV")


class EspectroMicrozonificacionOut(BaseModel):
    municipio_id: str
    zona_id: str
    zona_nombre: str
    params: dict
    puntos: list[PuntoEspectro]


@router.get("/microzonificacion/{municipio_id}", response_model=MicrozonificacionOut)
def get_microzonificacion_municipio(municipio_id: str) -> dict:
    """Retorna los datos de microzonificacion sismica para un municipio (si existe estudio oficial)."""
    data = get_microzonificacion(municipio_id)
    if data is None:
        raise HTTPException(
            status_code=404,
            detail=f"No hay estudio de microzonificacion para '{municipio_id}'.",
        )
    return data


@router.get("/microzonificacion", response_model=list[str])
def list_municipios_con_microzonificacion() -> list[str]:
    """Lista los IDs de municipios que tienen estudio de microzonificacion disponible."""
    return list(MICROZONIFICACION.keys())


@router.post("/espectro/microzonificacion", response_model=EspectroMicrozonificacionOut)
def calcular_espectro_microzonificacion(body: EspectroMicrozonificacionRequest) -> dict:
    """Calcula el espectro elastico para una zona especifica de microzonificacion."""
    micro = get_microzonificacion(body.municipio_id)
    if micro is None:
        raise HTTPException(
            status_code=404,
            detail=f"No hay microzonificacion para '{body.municipio_id}'.",
        )

    zona = next((z for z in micro["zonas"] if z["id"] == body.zona_id), None)
    if zona is None:
        raise HTTPException(
            status_code=404,
            detail=f"Zona '{body.zona_id}' no encontrada en la microzonificacion de '{body.municipio_id}'.",
        )

    result = compute_spectrum_from_params(
        SDs=zona["SDs"],
        SD1=zona["SD1"],
        T0=zona["T0"],
        Ts=zona["Ts"],
        TL=zona["TL"],
        T_max=body.T_max,
        use_group=body.use_group,
    )

    return {
        "municipio_id": body.municipio_id,
        "zona_id": body.zona_id,
        "zona_nombre": zona["nombre"],
        "params": result["params"],
        "puntos": result["puntos"],
    }
