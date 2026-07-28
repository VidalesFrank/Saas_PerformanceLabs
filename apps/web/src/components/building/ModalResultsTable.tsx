"use client";

import type { ModeRow, ModalResult } from "@/lib/building-types";
import { ModeShapeViewer } from "./ModeShapeViewer";

interface Props {
  data: ModalResult;
}

function PartBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ flex: 1, minWidth: 50 }}>
      <div style={{ fontSize: 10, color: "var(--color-text-muted)", marginBottom: 2 }}>
        {label} {value.toFixed(1)}%
      </div>
      <div style={{ height: 4, background: "var(--color-border)", borderRadius: 2 }}>
        <div style={{ height: "100%", width: `${Math.min(value, 100)}%`, background: color, borderRadius: 2, transition: "width .4s" }} />
      </div>
    </div>
  );
}

function CumMassBar({ label, data, keyCum, color }: { label: string; data: ModeRow[]; keyCum: "Ux_cum" | "Uy_cum" | "Rz_cum"; color: string }) {
  const threshold90 = data.findIndex(m => m[keyCum] >= 90);
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-text-muted">{label}</div>
      <div className="flex flex-col gap-1">
        {data.map(m => (
          <div key={m.mode} className="flex items-center gap-2">
            <span className="w-5 text-right text-[10px] text-text-muted">{m.mode}</span>
            <div className="flex-1 overflow-hidden rounded" style={{ height: 6, background: "var(--color-border)" }}>
              <div style={{ height: "100%", width: `${Math.min(m[keyCum], 100)}%`, background: color, transition: "width .4s" }} />
            </div>
            <span
              className="w-10 text-right text-[10px] font-mono"
              style={{ color: m[keyCum] >= 90 ? "var(--color-success)" : "var(--color-text-muted)", fontWeight: m[keyCum] >= 90 ? 700 : 400 }}
            >
              {m[keyCum].toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      {threshold90 >= 0 && (
        <div className="mt-2 text-[11px] font-semibold" style={{ color: "var(--color-success)" }}>
          ≥ 90% en modo {threshold90 + 1}
        </div>
      )}
    </div>
  );
}

function ModeCard({ m, color }: { m: ModeRow; color: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-text-muted">Modo {m.mode}</div>
      <div className="mb-2 font-mono text-2xl font-bold" style={{ color: "var(--color-accent)", lineHeight: 1 }}>
        {m.T.toFixed(3)}{" "}
        <span className="text-sm font-normal text-text-muted">s</span>
      </div>
      <div className="flex gap-2">
        <PartBar label="Ux" value={m.Ux_pct} color="var(--color-accent)" />
        <PartBar label="Uy" value={m.Uy_pct} color="#4a9fd4" />
        <PartBar label="Rz" value={m.Rz_pct} color="#e8761e" />
      </div>
    </div>
  );
}

export function ModalResultsTable({ data }: Props) {
  const { modes_table, num_modes, num_floors, viewer } = data;

  return (
    <div className="flex flex-col gap-5">

      {/* Tarjetas de los 3 primeros modos */}
      <div className="grid grid-cols-3 gap-3">
        {modes_table.slice(0, 3).map((m, i) => (
          <ModeCard key={m.mode} m={m} color={["#75b72a", "#4a9fd4", "#e8761e"][i]} />
        ))}
      </div>

      {/* Info de modelo */}
      <div className="text-xs text-text-muted">
        {num_modes} modos calculados · {num_floors} pisos
        {" · "}
        <span style={{ color: viewer ? "var(--color-accent)" : "var(--color-warning)", fontWeight: 600 }}>
          {viewer ? "visor 3D disponible" : "visor 3D no disponible"}
        </span>
      </div>

      {/* Visor 3D de formas modales */}
      {viewer
        ? <ModeShapeViewer viewer={viewer} modesTable={modes_table} />
        : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700">
            Datos del visor no disponibles. Vuelve a ejecutar el Análisis Modal.
          </div>
        )
      }

      {/* Tabla completa */}
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr style={{ background: "#2d3b1e" }}>
              {["Modo", "T (s)", "Ux (%)", "Uy (%)", "Rz (%)", "ΣUx (%)", "ΣUy (%)", "ΣRz (%)"].map(h => (
                <th key={h} className="px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wide text-white whitespace-nowrap">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {modes_table.map((m, idx) => {
              const dominant = m.Ux_pct > m.Uy_pct ? "x" : "y";
              return (
                <tr key={m.mode} style={{ background: idx % 2 === 0 ? "white" : "#f8f8f7" }}>
                  <td className="border-b border-border px-3 py-2 text-center font-semibold text-xs">{m.mode}</td>
                  <td className="border-b border-border px-3 py-2 text-center font-mono text-xs font-semibold" style={{ color: "var(--color-accent)" }}>{m.T.toFixed(4)}</td>
                  <td className="border-b border-border px-3 py-2 text-center text-xs" style={{ color: dominant === "x" ? "#75b72a" : undefined, fontWeight: dominant === "x" ? 700 : 400 }}>{m.Ux_pct.toFixed(2)}</td>
                  <td className="border-b border-border px-3 py-2 text-center text-xs" style={{ color: dominant === "y" ? "#4a9fd4" : undefined, fontWeight: dominant === "y" ? 700 : 400 }}>{m.Uy_pct.toFixed(2)}</td>
                  <td className="border-b border-border px-3 py-2 text-center text-xs" style={{ color: "#e8761e" }}>{m.Rz_pct.toFixed(2)}</td>
                  <td className="border-b border-border px-3 py-2 text-center font-mono text-[11px] text-text-muted">{m.Ux_cum.toFixed(2)}</td>
                  <td className="border-b border-border px-3 py-2 text-center font-mono text-[11px] text-text-muted">{m.Uy_cum.toFixed(2)}</td>
                  <td className="border-b border-border px-3 py-2 text-center font-mono text-[11px] text-text-muted">{m.Rz_cum.toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Barras de masa acumulada */}
      <div className="grid grid-cols-3 gap-3">
        <CumMassBar label="Masa acumulada Ux" data={modes_table} keyCum="Ux_cum" color="var(--color-accent)" />
        <CumMassBar label="Masa acumulada Uy" data={modes_table} keyCum="Uy_cum" color="#4a9fd4" />
        <CumMassBar label="Masa acumulada Rz" data={modes_table} keyCum="Rz_cum" color="#e8761e" />
      </div>

    </div>
  );
}
