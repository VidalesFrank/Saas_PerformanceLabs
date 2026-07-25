"use client";

import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import type { MunicipioInfo, ZonaSismica } from "@/lib/seismic-types";

const ZONE_COLOR: Record<ZonaSismica, string> = {
  baja: "#087f5b",
  intermedia: "#b45309",
  alta: "#c81e3a",
};

const ZONE_LABEL: Record<ZonaSismica, string> = {
  baja: "Baja",
  intermedia: "Intermedia",
  alta: "Alta",
};

function MapController({ municipio }: { municipio: MunicipioInfo | null }) {
  const map = useMap();
  useEffect(() => {
    if (municipio) {
      map.setView([municipio.lat, municipio.lon], 11, { animate: true });
    }
  }, [municipio, map]);
  return null;
}

interface SeismicMapProps {
  municipios: MunicipioInfo[];
  selected: MunicipioInfo | null;
  onSelect: (m: MunicipioInfo) => void;
}

export default function SeismicMap({ municipios, selected, onSelect }: SeismicMapProps) {
  return (
    <MapContainer
      center={[4.5, -74.1]}
      zoom={6}
      style={{ height: "100%", width: "100%", borderRadius: "0.5rem" }}
      attributionControl={false}
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='© <a href="https://openstreetmap.org">OpenStreetMap</a>'
      />
      <MapController municipio={selected} />

      {municipios.map((m) => {
        const isSelected = selected?.id === m.id;
        const color = ZONE_COLOR[m.zona_sismica];
        return (
          <CircleMarker
            key={m.id}
            center={[m.lat, m.lon]}
            radius={isSelected ? 12 : 6}
            pathOptions={{
              color: isSelected ? "#fff" : color,
              fillColor: color,
              fillOpacity: isSelected ? 0.95 : 0.75,
              weight: isSelected ? 3 : 1,
            }}
            eventHandlers={{ click: () => onSelect(m) }}
          >
            <Popup>
              <div className="text-xs leading-5">
                <div className="font-semibold">{m.nombre}</div>
                <div className="text-text-muted">{m.departamento}</div>
                <div className="mt-1">
                  <span style={{ color }}>● {ZONE_LABEL[m.zona_sismica]}</span>
                </div>
                <div>Aa = {m.Aa} g &nbsp;|&nbsp; Av = {m.Av} g</div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}

      {/* Leyenda */}
      <div
        style={{
          position: "absolute",
          bottom: 24,
          right: 10,
          zIndex: 1000,
          background: "rgba(255,255,255,0.92)",
          border: "1px solid #d7dbe4",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 11,
          lineHeight: "1.8",
          boxShadow: "0 1px 4px rgba(0,0,0,0.12)",
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Amenaza sísmica</div>
        {(["baja", "intermedia", "alta"] as ZonaSismica[]).map((z) => (
          <div key={z} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: ZONE_COLOR[z],
              }}
            />
            {ZONE_LABEL[z]}
          </div>
        ))}
      </div>
    </MapContainer>
  );
}
