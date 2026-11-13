"use client";

import "leaflet/dist/leaflet.css";
import { CircleMarker, MapContainer, Popup, TileLayer } from "react-leaflet";
import type { LocalPair } from "@/lib/structural-types";

interface Props {
  pairs: LocalPair[];
  selectedStation: string | null;
  onSelect: (station: string) => void;
}

// Color por región — alineado con la paleta del sidebar.
const REGION_COLOR: Record<string, string> = {
  CALI:      "#2563eb",
  MANIZALES: "#059669",
  PEREIRA:   "#d97706",
  SGC:       "#dc2626",
};

/** Mini mapa Leaflet para la página catálogo. Cada estación es un pin por
 * región; el pin seleccionado se agranda. Centrado en Colombia por defecto. */
export default function StationsMap({ pairs, selectedStation, onSelect }: Props) {
  const points = pairs
    .filter((p) => p.latitude != null && p.longitude != null)
    .map((p) => ({
      key: `${p.region}/${p.station}`,
      station: p.station,
      region:  p.region,
      lat: p.latitude as number,
      lon: p.longitude as number,
      soil: p.soil_class,
      pga_ns: p.pga?.[0] ?? null,
      pga_ew: p.pga?.[1] ?? null,
    }));

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
      {points.map((pt) => {
        const sel   = pt.station === selectedStation;
        const color = REGION_COLOR[pt.region] ?? "#64748b";
        return (
          <CircleMarker
            key={pt.key}
            center={[pt.lat, pt.lon]}
            radius={sel ? 11 : 5}
            pathOptions={{
              color:       sel ? "#fff" : color,
              fillColor:   color,
              fillOpacity: sel ? 0.95 : 0.75,
              weight:      sel ? 3 : 1,
            }}
            eventHandlers={{ click: () => onSelect(pt.station) }}
          >
            <Popup>
              <div className="text-xs leading-5">
                <div className="font-semibold">{pt.station}</div>
                <div className="text-text-muted">{pt.region} · suelo {pt.soil ?? "s/d"}</div>
                <div className="mt-1 font-mono">
                  PGA NS: {pt.pga_ns != null ? `${pt.pga_ns.toFixed(3)} g` : "—"}
                </div>
                <div className="font-mono">
                  PGA EW: {pt.pga_ew != null ? `${pt.pga_ew.toFixed(3)} g` : "—"}
                </div>
              </div>
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
