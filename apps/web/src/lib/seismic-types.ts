export type ZonaSismica = "baja" | "intermedia" | "alta";
export type SoilType = "A" | "B" | "C" | "D" | "E" | "F";

export interface MunicipioInfo {
  id: string;
  nombre: string;
  departamento: string;
  Aa: number;
  Av: number;
  lat: number | null;
  lon: number | null;
  zona_sismica: ZonaSismica;
  code_dane?: number | null;
  zona?: string | null;   // "ALTA" / "INTERMEDIA" / "BAJA" oficial del Excel
}

export interface MunicipiosStats {
  total: number;
  con_coordenadas: number;
  por_zona: Record<ZonaSismica, number>;
  por_departamento: Record<string, number>;
}

export type UseGroup = "I" | "II" | "III" | "IV";

export interface ParametrosEspectro {
  Aa: number;
  Av: number;
  Fa: number;
  Fv: number;
  SDs: number;
  SD1: number;
  T0: number;
  Ts: number;
  TL: number;
  I: number;
  use_group: UseGroup;
}

export interface UseGroupInfo {
  id: UseGroup;
  nombre: string;
  I: number;
}

export interface PuntoEspectro {
  T: number;
  Sa: number;
  Sd: number;
  Sv: number;
}

export interface EspectroResult {
  municipio: MunicipioInfo;
  soil_type: string;
  params: ParametrosEspectro;
  puntos: PuntoEspectro[];
  zona_sismica: ZonaSismica;
}

export interface SoilTypeInfo {
  id: string;
  nombre: string;
  descripcion: string;
}

export interface MicrozonificacionZona {
  id: string;
  nombre: string;
  descripcion: string;
  color: string;
  Fa_eff: number;
  Fv_eff: number;
  SDs: number;
  SD1: number;
  T0: number;
  Ts: number;
  TL: number;
}

export interface MicrozonificacionInfo {
  nombre: string;
  estudio: string;
  Aa_base: number;
  Av_base: number;
  nota: string;
  zonas: MicrozonificacionZona[];
}

export interface EspectroMicrozonificacionResult {
  municipio_id: string;
  zona_id: string;
  zona_nombre: string;
  params: {
    SDs: number;
    SD1: number;
    T0: number;
    Ts: number;
    TL: number;
  };
  puntos: PuntoEspectro[];
}
