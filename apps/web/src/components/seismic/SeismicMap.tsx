"use client";

import "leaflet/dist/leaflet.css";
import { Fragment, useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import { LatLngBounds } from "leaflet";
import type { MunicipioInfo, ZonaSismica } from "@/lib/seismic-types";
import { useTheme } from "@/lib/theme";

// Colores vibrantes (accent tech) para legibilidad sobre Positron y Dark Matter.
const ZONE_COLOR: Record<ZonaSismica, string> = {
  baja:       "#10b981",
  intermedia: "#f59e0b",
  alta:       "#ef4444",
};

const ZONE_LABEL: Record<ZonaSismica, string> = {
  baja:       "Baja",
  intermedia: "Intermedia",
  alta:       "Alta",
};

function MapController({ municipio }: { municipio: MunicipioInfo | null }) {
  const map = useMap();
  useEffect(() => {
    if (municipio && municipio.lat != null && municipio.lon != null) {
      map.setView([municipio.lat, municipio.lon], 11, { animate: true });
    }
  }, [municipio, map]);
  return null;
}

/** Encuadra todos los municipios con coordenadas al cargar.
 * Usa un setTimeout 0 para asegurar que Leaflet tenga el contenedor ya
 * dimensionado (si el mapa se monta antes de que el layout termine, fitBounds
 * calcula mal el zoom y queda fuera de rango). */
function FitBoundsOnce({ bounds }: { bounds: LatLngBounds | null }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds || !bounds.isValid()) return;
    const t = setTimeout(() => {
      map.invalidateSize();
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 6, animate: false });
    }, 60);
    return () => clearTimeout(t);
  }, [bounds, map]);
  return null;
}

interface SeismicMapProps {
  municipios: MunicipioInfo[];
  selected: MunicipioInfo | null;
  onSelect: (m: MunicipioInfo) => void;
}

export default function SeismicMap({ municipios, selected, onSelect }: SeismicMapProps) {
  const { theme } = useTheme();

  // Filtra los que tienen coordenadas (muchos del nuevo catálogo vienen sin lat/lon).
  const points = useMemo(
    () => municipios.filter((m) => m.lat != null && m.lon != null) as Array<MunicipioInfo & { lat: number; lon: number }>,
    [municipios],
  );

  // Bounds para encuadre inicial (solo primera carga; después el MapController zooma al seleccionado).
  const bounds = useMemo<LatLngBounds | null>(() => {
    if (points.length === 0) return null;
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    return new LatLngBounds(
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    );
  }, [points]);

  // OSM estándar (libre, sin API key). El className `pl-tile-{theme}` aplica
  // un filtro CSS (en globals.css) que simula el look Positron / Dark Matter
  // premium sin depender de providers que requieren key.
  const tileUrl = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";

  return (
    <MapContainer
      center={[4.5, -74.1]}
      zoom={6}
      style={{ height: "100%", width: "100%", borderRadius: "0.5rem" }}
      attributionControl={false}
      scrollWheelZoom={true}
    >
      <TileLayer
        key={theme}
        url={tileUrl}
        attribution='© <a href="https://openstreetmap.org">OpenStreetMap</a>'
        maxZoom={19}
        className={`pl-tile-${theme}`}
      />
      <FitBoundsOnce bounds={bounds} />
      <MapController municipio={selected} />

      {points.map((m) => {
        const isSelected = selected?.id === m.id;
        const color = ZONE_COLOR[m.zona_sismica];
        return (
          <Fragment key={m.id}>
            {isSelected && (
              <CircleMarker
                center={[m.lat, m.lon]}
                radius={20}
                pathOptions={{
                  color,
                  fillColor:   color,
                  fillOpacity: 0.18,
                  weight:      0,
                  interactive: false,
                }}
              />
            )}
            <CircleMarker
              center={[m.lat, m.lon]}
              radius={isSelected ? 10 : 4.5}
              pathOptions={{
                color:       isSelected ? "#ffffff" : color,
                fillColor:   color,
                fillOpacity: isSelected ? 1 : 0.78,
                weight:      isSelected ? 3 : 1,
              }}
              eventHandlers={{ click: () => onSelect(m) }}
            >
              <Tooltip
                permanent={isSelected}
                direction="top"
                offset={[0, isSelected ? -14 : -6]}
                opacity={0.95}
              >
                <span className="font-mono text-[11px] font-semibold">{m.nombre}</span>
              </Tooltip>
              <Popup>
                <div className="text-xs leading-5">
                  <div className="font-semibold">{m.nombre}</div>
                  <div className="text-slate-500">{m.departamento}</div>
                  <div className="mt-1">
                    <span style={{ color }}>● {ZONE_LABEL[m.zona_sismica]}</span>
                  </div>
                  <div>Aa = {m.Aa} g &nbsp;|&nbsp; Av = {m.Av} g</div>
                  {m.code_dane != null && (
                    <div className="text-[10px] text-slate-400 mt-0.5">DANE {m.code_dane}</div>
                  )}
                </div>
              </Popup>
            </CircleMarker>
          </Fragment>
        );
      })}

      {/* Leyenda con tokens y glow sutil, alineada al lenguaje futurista. */}
      <div
        style={{
          position:  "absolute",
          bottom:    24,
          right:     10,
          zIndex:    1000,
          background: theme === "dark" ? "rgba(15, 26, 46, 0.92)" : "rgba(255, 255, 255, 0.95)",
          color:      theme === "dark" ? "#e7ebf5" : "#0f172a",
          border:     `1px solid ${theme === "dark" ? "#233149" : "#cbd5e1"}`,
          borderRadius: 10,
          padding:    "8px 12px",
          fontSize:   11,
          lineHeight: "1.8",
          boxShadow:  "0 4px 12px rgba(0,0,0,0.18)",
          backdropFilter: "blur(6px)",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 4, letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 9.5, opacity: 0.75 }}>
          Amenaza sísmica
        </div>
        {(["alta", "intermedia", "baja"] as ZonaSismica[]).map((z) => (
          <div key={z} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display:       "inline-block",
                width:         10,
                height:        10,
                borderRadius:  "50%",
                background:    ZONE_COLOR[z],
                boxShadow:     `0 0 6px ${ZONE_COLOR[z]}`,
              }}
            />
            {ZONE_LABEL[z]}
          </div>
        ))}
        {points.length > 0 && (
          <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid ${theme === "dark" ? "#233149" : "#e2e8f0"}`, fontSize: 9.5, opacity: 0.7 }}>
            {points.length.toLocaleString()} municipios
          </div>
        )}
      </div>
    </MapContainer>
  );
}
