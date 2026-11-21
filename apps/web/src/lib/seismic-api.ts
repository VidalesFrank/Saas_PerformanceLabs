// Cliente ligero de /api/v1/seismic reutilizable por módulos que necesiten
// superponer espectros de referencia NSR-10 y Microzonificación.

import { api } from './api'
import type {
  EspectroMicrozonificacionResult,
  EspectroResult,
  MicrozonificacionInfo,
  MunicipioInfo,
  SoilTypeInfo,
  UseGroup,
  UseGroupInfo,
} from './seismic-types'

export async function getAllMunicipios(): Promise<MunicipioInfo[]> {
  return api.get<MunicipioInfo[]>('/api/v1/seismic/municipios/all', false)
}

export async function getSoilTypes(): Promise<SoilTypeInfo[]> {
  return api.get<SoilTypeInfo[]>('/api/v1/seismic/soil-types', false)
}

export async function getUseGroups(): Promise<UseGroupInfo[]> {
  return api.get<UseGroupInfo[]>('/api/v1/seismic/use-groups', false)
}

export async function searchMunicipios(query: string, limit = 20): Promise<MunicipioInfo[]> {
  if (!query.trim()) return []
  return api.get<MunicipioInfo[]>(
    `/api/v1/seismic/municipios?q=${encodeURIComponent(query)}&limit=${limit}`,
    false,
  )
}

export async function getMicrozonificacionList(): Promise<string[]> {
  return api.get<string[]>('/api/v1/seismic/microzonificacion', false)
}

export async function getMicrozonificacion(municipioId: string): Promise<MicrozonificacionInfo> {
  return api.get<MicrozonificacionInfo>(
    `/api/v1/seismic/microzonificacion/${municipioId}`,
    false,
  )
}

export async function computeEspectroNSR10(params: {
  municipio_id: string
  soil_type: string
  T_max?: number
  use_group?: UseGroup
}): Promise<EspectroResult> {
  return api.post<EspectroResult>('/api/v1/seismic/espectro', {
    T_max: 4.0,
    use_group: 'I',
    ...params,
  })
}

export async function computeEspectroMicrozonificacion(params: {
  municipio_id: string
  zona_id: string
  T_max?: number
  use_group?: UseGroup
}): Promise<EspectroMicrozonificacionResult> {
  return api.post<EspectroMicrozonificacionResult>('/api/v1/seismic/espectro/microzonificacion', {
    T_max: 4.0,
    use_group: 'I',
    ...params,
  })
}
