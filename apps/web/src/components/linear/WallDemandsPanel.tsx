"use client";

import { useState, useMemo } from "react";
import type { WallDemandsResult, WallPierDemand } from "@/lib/structural-types";

interface Props {
  result: WallDemandsResult;
}

const COMBOS = ["1.4D", "1.2D+1.6L", "1.2D+L+E", "0.9D+E"];

export default function WallDemandsPanel({ result }: Props) {
  const { fhe_params, story_forces, pier_demands } = result;

  const [selectedCombo, setSelectedCombo]   = useState("1.2D+L+E");
  const [selectedStory, setSelectedStory]   = useState<string>("all");
  const [sortBy, setSortBy]                 = useState<keyof WallPierDemand>("Vu_x_kN");
  const [sortDesc, setSortDesc]             = useState(true);

  const stories = useMemo(() => {
    const s = [...new Set(pier_demands.map((d) => d.story))].sort();
    return s;
  }, [pier_demands]);

  const filtered = useMemo(() => {
    return pier_demands
      .filter((d) => d.combo === selectedCombo && (selectedStory === "all" || d.story === selectedStory))
      .sort((a, b) => {
        const av = a[sortBy] as number;
        const bv = b[sortBy] as number;
        return sortDesc ? bv - av : av - bv;
      });
  }, [pier_demands, selectedCombo, selectedStory, sortBy, sortDesc]);

  function handleSort(col: keyof WallPierDemand) {
    if (sortBy === col) setSortDesc((p) => !p);
    else { setSortBy(col); setSortDesc(true); }
  }

  const th = (col: keyof WallPierDemand, label: string) => (
    <th
      key={col}
      className="px-3 py-2 text-right text-[11px] font-semibold text-[var(--text-muted)] cursor-pointer select-none whitespace-nowrap hover:text-[var(--text)] transition-colors"
      onClick={() => handleSort(col)}
    >
      {label}{sortBy === col ? (sortDesc ? " ↓" : " ↑") : ""}
    </th>
  );

  const storyForcesX = Object.entries(story_forces.X).filter(([, v]) => v > 0);

  return (
    <div className="flex flex-col gap-5">

      {/* ── FHE Summary ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Parámetros FHE
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm">
            {[
              ["hn", `${fhe_params.hn_m} m`],
              ["T", `${fhe_params.T_s} s`],
              ["Cs", fhe_params.Cs.toFixed(4)],
              ["W", `${fhe_params.W_kN.toFixed(0)} kN`],
              ["Vb", `${fhe_params.Vb_kN.toFixed(1)} kN`],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-2">
                <span className="text-[var(--text-muted)]">{k}</span>
                <span className="font-mono font-medium text-[var(--text)]">{v}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3">
            Fuerzas por piso — X (kN)
          </p>
          <div className="flex flex-col gap-1">
            {storyForcesX.map(([story, fx]) => {
              const maxFx = Math.max(...storyForcesX.map(([, v]) => v));
              const pct = maxFx > 0 ? (fx / maxFx) * 100 : 0;
              return (
                <div key={story} className="flex items-center gap-2">
                  <span className="text-[11px] text-[var(--text-muted)] w-28 truncate">{story}</span>
                  <div className="flex-1 bg-[var(--surface-2)] rounded-full h-1.5">
                    <div
                      className="h-1.5 rounded-full"
                      style={{ width: `${pct}%`, background: "var(--accent)" }}
                    />
                  </div>
                  <span className="text-[11px] font-mono text-[var(--text)] w-14 text-right">
                    {fx.toFixed(1)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Filters ──────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-muted)]">Combinación:</span>
          <div className="flex gap-1">
            {COMBOS.map((c) => (
              <button
                key={c}
                onClick={() => setSelectedCombo(c)}
                className={[
                  "px-2.5 py-1 rounded text-[11px] font-medium transition-colors",
                  selectedCombo === c
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 ml-4">
          <span className="text-xs text-[var(--text-muted)]">Historia:</span>
          <select
            value={selectedStory}
            onChange={(e) => setSelectedStory(e.target.value)}
            className="text-[11px] bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]"
          >
            <option value="all">Todas</option>
            {stories.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>

        <span className="text-xs text-[var(--text-muted)] ml-auto">
          {filtered.length} pieres
        </span>
      </div>

      {/* ── Demands Table ────────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-[var(--border)] bg-[var(--surface-2)]">
              <tr>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-muted)]">Pier</th>
                <th className="px-3 py-2 text-left text-[11px] font-semibold text-[var(--text-muted)]">Historia</th>
                {th("lw_m",      "lw (m)")}
                {th("tw_m",      "tw (m)")}
                {th("hw_m",      "hw (m)")}
                {th("Pu_kN",     "Pu (kN)")}
                {th("Vu_x_kN",   "Vu_x (kN)")}
                {th("Vu_y_kN",   "Vu_y (kN)")}
                {th("Mu_x_kNm",  "Mu_x (kNm)")}
                {th("Mu_y_kNm",  "Mu_y (kNm)")}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {filtered.map((row, i) => {
                const Vu = Math.max(row.Vu_x_kN, row.Vu_y_kN);
                const isHighDemand = Vu > 20;
                return (
                  <tr key={i} className={isHighDemand ? "bg-[color-mix(in_srgb,var(--accent)_4%,transparent)]" : "hover:bg-[var(--surface-2)]"}>
                    <td className="px-3 py-1.5 font-mono text-xs text-[var(--text)] font-medium">{row.pier}</td>
                    <td className="px-3 py-1.5 text-xs text-[var(--text-muted)]">{row.story}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.lw_m.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.tw_m.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.hw_m.toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.Pu_kN.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs font-medium text-[var(--text)]">{row.Vu_x_kN.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.Vu_y_kN.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs font-medium text-[var(--text)]">{row.Mu_x_kNm.toFixed(1)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[var(--text)]">{row.Mu_y_kNm.toFixed(1)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
