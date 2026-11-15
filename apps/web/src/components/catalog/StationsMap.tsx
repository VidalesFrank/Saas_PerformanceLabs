"use client";

import "leaflet/dist/leaflet.css";
import { Fragment, useEffect, useMemo } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMap } from "react-leaflet";
import { LatLngBounds } from "leaflet";
import type { LocalPair } from "@/lib/structural-types";
import { useTheme } from "@/lib/theme";
import { regionColor } from "@/lib/region-colors";

// Re-export para consumers que ya importaban desde aquí.
export { regionColor } from "@/lib/region-colors";

interface Props {
  pairs: LocalPair[];
  selectedStation: string | null;
  onSelect: (station: string) => void;
}

/** Hijo que encuadra el mapa para que todas las estaciones queden visibles.
 * Solo dispara al cambiar los puntos, no la selección — evita que mover el mapa
 * al hacer clic en una estación se sienta como "reset". */
function FitBoundsOnChange({ bounds }: { bounds: LatLngBounds | null }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds || !bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [36, 36], maxZoom: 9, animate: true });
  }, [bounds, map]);
  return null;
}

/** Mini mapa Leaflet para la página catálogo. Pins por región, el seleccionado
 * tiene halo + label permanente; los no seleccionados muestran label en hover.
 * Tiles CartoDB alineados al tema (Positron / Dark Matter). */
export default function StationsMap({ pairs, selectedStation, onSelect }: Props) {
  const { theme } = useTheme();

  const points = useMemo(
    () =>
      pairs
        .filter((p) => p.latitude != null && p.longitude != null)
        .map((p) => ({
          key:    `${p.region}/${p.station}`,
          station: p.station,
          region:  p.region,
          lat:     p.latitude as number,
          lon:     p.longitude as number,
          soil:    p.soil_class,
          pga_ns:  p.pga?.[0] ?? null,
          pga_ew:  p.pga?.[1] ?? null,
        })),
    [pairs],
  );

  const bounds = useMemo<LatLngBounds | null>(() => {
    if (points.length === 0) return null;
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    return new LatLngBounds(
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    );
  }, [points]);

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
      <FitBoundsOnChange bounds={bounds} />

      {points.map((pt) => {
        const sel   = pt.station === selectedStation;
        const color = regionColor(pt.region);
        return (
          <Fragment key={pt.key}>
            {sel && (
              <CircleMarker
                center={[pt.lat, pt.lon]}
                radius={18}
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
              center={[pt.lat, pt.lon]}
              radius={sel ? 9 : 5}
              pathOptions={{
                color:       sel ? "#ffffff" : color,
                fillColor:   color,
                fillOpacity: sel ? 1 : 0.82,
                weight:      sel ? 3 : 1,
              }}
              eventHandlers={{ click: () => onSelect(pt.station) }}
            >
              <Tooltip
                permanent={sel}
                direction="top"
                offset={[0, sel ? -14 : -6]}
                opacity={0.95}
              >
                <span className="font-mono text-[11px] font-semibold">{pt.station}</span>
              </Tooltip>
              <Popup>
                <div className="text-xs leading-5">
                  <div className="font-semibold">{pt.station}</div>
                  <div className="text-slate-500">{pt.region} · suelo {pt.soil ?? "s/d"}</div>
                  <div className="mt-1 font-mono">
                    PGA NS: {pt.pga_ns != null ? `${pt.pga_ns.toFixed(3)} g` : "—"}
                  </div>
                  <div className="font-mono">
                    PGA EW: {pt.pga_ew != null ? `${pt.pga_ew.toFixed(3)} g` : "—"}
                  </div>
                </div>
              </Popup>
            </CircleMarker>
          </Fragment>
        );
      })}
    </MapContainer>
  );
}
