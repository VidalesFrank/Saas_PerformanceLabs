"use client";

import { useState, useMemo } from "react";
import type { WallDesignResult, WallDesignRow } from "@/lib/structural-types";

interface Props {
  result: WallDesignResult;
}

type SortKey = keyof Pick<
  WallDesignRow,
  "pier" | "story" | "lw_m" | "tw_m" | "max_dcr" | "phi_Mn_kNm" | "phi_Vn_kN" | "Vu_kN" | "rho_h_pct" | "rho_v_pct"
>;

export default function WallDesignPanel({ result }: Props) {
  const { designs, n_ok, n_ng, n_ebe, max_dcr, fc_mpa, fy_mpa, ductility, ebe_method } = result;

  const [filterStory, setFilterStory]   = useState("all");
  const [filterStatus, setFilterStatus] = useState<"all" | "ok" | "ng">("all");
  const [filterEbe, setFilterEbe]       = useState(false);
  const [sortBy, setSortBy]             = useState<SortKey>("max_dcr");
  const [sortDesc, setSortDesc]         = useState(true);

  const stories = useMemo(
    () => [...new Set(designs.map((d) => d.story))].sort(),
    [designs]
  );

  const filtered = useMemo(() => {
    return designs
      .filter((d) => {
        if (filterStory !== "all" && d.story !== filterStory) return false;
        if (filterStatus === "ok" && !d.ok)  return false;
        if (filterStatus === "ng" && d.ok)   return false;
        if (filterEbe && !d.ebe_required)    return false;
        return true;
      })
      .sort((a, b) => {
        const av = a[sortBy] as number | string;
        const bv = b[sortBy] as number | string;
        if (typeof av === "string") return sortDesc ? bv.toString().localeCompare(av) : av.localeCompare(bv.toString());
        return sortDesc ? (bv as number) - (av as number) : (av as number) - (bv as number);
      });
  }, [designs, filterStory, filterStatus, filterEbe, sortBy, sortDesc]);

  function handleSort(col: SortKey) {
    if (sortBy === col) setSortDesc((p) => !p);
    else { setSortBy(col); setSortDesc(col !== "pier" && col !== "story"); }
  }

  const pct_ok  = result.pier_count > 0 ? (n_ok / result.pier_count) * 100 : 0;
  const pct_ebe = result.pier_count > 0 ? (n_ebe / result.pier_count) * 100 : 0;

  const Th = ({ col, label, right = true }: { col: SortKey; label: string; right?: boolean }) => (
    <th
      onClick={() => handleSort(col)}
      className={`px-3 py-2 text-[11px] font-semibold text-[var(--text-muted)] cursor-pointer select-none whitespace-nowrap hover:text-[var(--text)] transition-colors ${right ? "text-right" : "text-left"}`}
    >
      {label}{sortBy === col ? (sortDesc ? " ↓" : " ↑") : ""}
    </th>
  );

  return (
    <div className="flex flex-col gap-5">

      {/* ── Stats ───────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "Pieres OK",  value: `${n_ok} / ${result.pier_count}`, sub: `${pct_ok.toFixed(0)}%`,  color: n_ng === 0 ? "#22c55e" : "#f59e0b" },
          { label: "Pieres NG",  value: String(n_ng),                      sub: n_ng > 0 ? "Requieren ajuste" : "Todos OK",  color: n_ng > 0 ? "#ef4444" : "#22c55e" },
          { label: "Con EBE",    value: `${n_ebe}`,                        sub: `${pct_ebe.toFixed(0)}% · ${ebe_method === "displacement" ? "Método A (desp.)" : "Método B (σ)"}`, color: "#8b5cf6" },
          { label: "DCR máx.",   value: max_dcr.toFixed(3),                sub: max_dcr > 1 ? "EXCEDE capacidad" : "Dentro de capacidad", color: max_dcr > 1 ? "#ef4444" : "#22c55e" },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
            <p className="text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">{label}</p>
            <p className="text-2xl font-bold" style={{ color }}>{value}</p>
            <p className="text-[11px] text-[var(--text-muted)] mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      {/* ── Params bar ──────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 flex items-center gap-6 text-sm flex-wrap">
        {[
          ["f'c", `${fc_mpa} MPa`],
          ["fy", `${fy_mpa} MPa`],
          ["Ductilidad", ductility],
          ["Método EBE", ebe_method === "displacement" ? "A — desplazamiento (δu/hw)" : "B — esfuerzo (σ)"],
        ].map(([k, v]) => (
          <div key={k} className="flex items-center gap-2">
            <span className="text-[var(--text-muted)]">{k}</span>
            <span className="font-mono font-medium text-[var(--text)]">{v}</span>
          </div>
        ))}
      </div>

      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">Estado:</span>
          <div className="flex gap-1">
            {(["all", "ok", "ng"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                className={[
                  "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                  filterStatus === s
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {s === "all" ? "Todos" : s.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">Historia:</span>
          <select
            value={filterStory}
            onChange={(e) => setFilterStory(e.target.value)}
            className="text-[11px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]"
          >
            <option value="all">Todas</option>
            {stories.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            checked={filterEbe}
            onChange={(e) => setFilterEbe(e.target.checked)}
            className="rounded"
          />
          <span className="text-xs text-[var(--text-muted)]">Solo con EBE</span>
        </label>

        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {filtered.length} pieres
        </span>
      </div>

      {/* ── Table ───────────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface-2)]">
              <tr>
                <Th col="pier"       label="Pier"      right={false} />
                <Th col="story"      label="Historia"  right={false} />
                <th className="px-3 py-2 text-center text-[11px] font-semibold text-[var(--text-muted)]">Estado</th>
                <Th col="max_dcr"    label="DCR máx." />
                <Th col="lw_m"       label="lw (m)"   />
                <Th col="tw_m"       label="tw (m)"   />
                <Th col="phi_Mn_kNm" label="φMn (kNm)" />
                <Th col="phi_Vn_kN"  label="φVn (kN)" />
                <Th col="Vu_kN"      label="Vu (kN)"  />
                <Th col="rho_h_pct"  label="ρh (%)"   />
                <Th col="rho_v_pct"  label="ρv (%)"   />
                <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">Alma H</th>
                <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">Alma V</th>
                <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">EBE</th>
                <th className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)]">lc (m)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((row, i) => {
                const isNg  = !row.ok;
                const isEbe = row.ebe_required;
                const dcrColor = row.max_dcr > 1 ? "#ef4444" : row.max_dcr > 0.85 ? "#f59e0b" : "var(--text)";
                return (
                  <tr
                    key={i}
                    className={[
                      isNg
                        ? "bg-[color-mix(in_srgb,#ef4444_5%,transparent)]"
                        : isEbe
                        ? "bg-[color-mix(in_srgb,#8b5cf6_4%,transparent)]"
                        : "hover:bg-[var(--surface-2)]",
                    ].join(" ")}
                  >
                    <td className="px-3 py-1.5 font-mono text-xs font-medium text-[var(--text)]">{row.pier}</td>
                    <td className="px-3 py-1.5 text-xs text-[var(--text-muted)]">{row.story}</td>
                    <td className="px-3 py-1.5 text-center">
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-bold ${isNg ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>
                        {isNg ? "NG" : "OK"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs font-medium" style={{ color: dcrColor }}>{row.max_dcr.toFixed(3)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.lw_m.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.tw_m.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.phi_Mn_kNm?.toFixed(1) ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.phi_Vn_kN?.toFixed(1) ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.Vu_kN?.toFixed(1) ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.rho_h_pct?.toFixed(3) ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.rho_v_pct?.toFixed(3) ?? "—"}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[11px] text-[var(--text)]">
                      {row.web_horiz_db_mm ? `#${barNo(row.web_horiz_db_mm)}@${row.web_horiz_sp_mm.toFixed(0)}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[11px] text-[var(--text)]">
                      {row.web_vert_db_mm ? `#${barNo(row.web_vert_db_mm)}@${row.web_vert_sp_mm.toFixed(0)}` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      {isEbe ? (
                        <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-100 text-purple-700">EBE</span>
                      ) : (
                        <span className="text-[11px] text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">
                      {isEbe ? row.lc_m.toFixed(3) : "—"}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={15} className="px-4 py-6 text-center text-xs text-[var(--text-muted)]">
                    No hay pieres con los filtros seleccionados.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Legend ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-4 text-[11px] text-[var(--text-muted)]">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-[color-mix(in_srgb,#ef4444_20%,transparent)] border border-red-300 inline-block" />
          NG — alguna verificación falla
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded-sm bg-[color-mix(in_srgb,#8b5cf6_15%,transparent)] border border-purple-300 inline-block" />
          EBE requerido (NSR-10 C.21.9.6)
        </span>
        <span className="flex items-center gap-1.5">
          Alma: #N@sp mm (2 cortinas)
        </span>
      </div>
    </div>
  );
}

/** Convierte diámetro mm → número de barra estándar colombiano/americano. */
function barNo(db: number): string {
  const map: Record<number, string> = {
    9.5: "3", 12.7: "4", 15.9: "5", 19.1: "6",
    22.2: "7", 25.4: "8", 32.3: "10", 35.8: "11",
    12: "12", 16: "16", 19: "19", 25: "25", 32: "32",
  };
  return map[db] ?? db.toFixed(0);
}
