"use client";

import { MacroFiber, regionLabel, getFormulationInfo, WallFormulation } from "@/lib/wall-types";

interface Props {
  fiber:       MacroFiber;
  formulation: WallFormulation;
}

export default function MacrofiberDetailPanel({ fiber, formulation }: Props) {
  const info = getFormulationInfo(formulation);

  const rows: [string, string, string][] = [
    ["Region",        regionLabel(fiber.region), "auto"],
    ["Width",         `${(fiber.width_m * 1000).toFixed(1)} mm`, "auto"],
    ["Thickness",     `${(fiber.thickness_m * 1000).toFixed(1)} mm`, "auto"],
    ["Concrete",      fiber.concrete_name || "—", fiber.concrete_name ? "user" : "missing"],
    ["Vertical Steel",fiber.steel_v_name  || "—", fiber.steel_v_name  ? "user" : "missing"],
    ["rho_v",         `${(fiber.rho_vertical * 100).toFixed(3)} %`, fiber.rho_vertical > 0 ? "user" : "missing"],
    ...(info.uses_rc_panel ? [
      ["Horizontal Steel", fiber.steel_h_name || "—", fiber.steel_h_name ? "user" : "missing"] as [string, string, string],
      ["rho_h",            `${(fiber.rho_horizontal * 100).toFixed(3)} %`, fiber.rho_horizontal > 0 ? "user" : "missing"] as [string, string, string],
      ["Panel Model",      "FSAM", "auto"] as [string, string, string],
    ] : []),
  ];

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4 space-y-3">
      <h4 className="text-sm font-bold text-[var(--text-primary)]">
        Macrofiber MF{fiber.index}
      </h4>
      <table className="w-full text-xs">
        <tbody>
          {rows.map(([label, value, status]) => (
            <tr key={label} className="border-b border-[var(--border)] last:border-0">
              <td className="py-1.5 pr-3 text-[var(--text-muted)] font-medium w-36">{label}</td>
              <td className="py-1.5 font-mono text-[var(--text-primary)]">{value}</td>
              <td className="py-1.5 pl-3">
                <StatusBadge status={status as "auto" | "user" | "missing"} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {fiber.rc_panel_key && (
        <p className="text-[10px] text-[var(--text-muted)] font-mono break-all">
          Panel key: {fiber.rc_panel_key}
        </p>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "auto" | "user" | "missing" }) {
  const map = {
    auto:    ["DEFAULT / AUTO",  "text-sky-400"],
    user:    ["USER DEFINED",    "text-emerald-400"],
    missing: ["MISSING",         "text-red-400"],
  } as const;
  const [label, cls] = map[status];
  return (
    <span className={`text-[9px] font-semibold uppercase tracking-wider ${cls}`}>
      {label}
    </span>
  );
}
