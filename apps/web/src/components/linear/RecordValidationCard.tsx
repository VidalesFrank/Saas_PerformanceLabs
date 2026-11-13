"use client";

import type { NLTHUploadResult } from "@/lib/structural-types";

/**
 * Tarjeta que valida visualmente la configuración del registro antes de lanzar
 * (Ola 3 2026-11-04). Combina PGA, duración simulada y dtrec del usuario vs el
 * detectado por el parser. Da al ingeniero una señal clara de si el análisis
 * va a correr con parámetros sensatos antes de pelear con el solver.
 *
 * Reglas:
 *  - PGA  <0.3g verde | 0.3-0.8g amarillo | >0.8g rojo (sismo muy fuerte)
 *  - Duración <60s verde | 60-120s amarillo | >120s rojo (backend rechaza)
 *  - dtrec manual vs detectado: coincidencia verde | diferencia >2× rojo
 */
export function RecordValidationCard({
  uploadX, uploadY, dtrec, units, scale,
}: {
  uploadX?: NLTHUploadResult | null;
  uploadY?: NLTHUploadResult | null;
  dtrec:  number;
  units:  "g" | "mps2" | "cm/s2";
  scale:  number;
}) {
  if (!uploadX && !uploadY) return null;

  // Factor para convertir |PGA raw| según unidades declaradas → g
  const unitsFactor = units === "g" ? 1
                    : units === "mps2" ? 1 / 9.81
                    : units === "cm/s2" ? 1 / 981
                    : 1;

  const pgaX_g = uploadX ? Math.abs(uploadX.pga) * unitsFactor * scale : null;
  const pgaY_g = uploadY ? Math.abs(uploadY.pga) * unitsFactor * scale : null;
  const pgaMax = Math.max(pgaX_g ?? 0, pgaY_g ?? 0);

  // Duración simulada efectiva (dtrec que va a usar OpenSees × n_samples)
  const durX = uploadX ? uploadX.n_samples * dtrec : 0;
  const durY = uploadY ? uploadY.n_samples * dtrec : 0;
  const durMax = Math.max(durX, durY);

  // Cross-check dtrec manual vs detectado por parser
  const detectedX = uploadX?.dt_detected ?? null;
  const detectedY = uploadY?.dt_detected ?? null;
  const detected = detectedX ?? detectedY ?? null;
  const dtrecMismatch = detected != null && detected > 0 && (
    dtrec > detected * 2 || dtrec < detected / 2
  );

  // Semáforos
  const pgaSeverity   = pgaMax > 0.8 ? "red" : pgaMax > 0.3 ? "amber" : "green";
  const durSeverity   = durMax > 120 ? "red" : durMax > 60 ? "amber" : "green";
  const dtrecSeverity = dtrecMismatch ? "red"
                      : detected != null ? "green"
                      : "amber";
  const unitsSeverity = (uploadX?.units_hint && uploadY?.units_hint) ? "green" : "amber";

  const overall =
    (pgaSeverity === "red" || durSeverity === "red" || dtrecSeverity === "red")
      ? "red"
      : (pgaSeverity === "amber" || durSeverity === "amber" || dtrecSeverity === "amber" || unitsSeverity === "amber")
        ? "amber" : "green";

  const overallLabel = overall === "red"
    ? "⚠ No está listo para lanzar — corrige los parámetros marcados"
    : overall === "amber"
      ? "Listo con advertencias — revisa los parámetros marcados en amarillo"
      : "Configuración validada — listo para lanzar";

  const overallCls = overall === "red"
    ? "border-rose-500/40 bg-rose-500/5"
    : overall === "amber"
      ? "border-amber-500/40 bg-amber-500/5"
      : "border-emerald-500/40 bg-emerald-500/5";

  const overallTextCls = overall === "red"
    ? "text-rose-800 dark:text-rose-300"
    : overall === "amber"
      ? "text-amber-800 dark:text-amber-300"
      : "text-emerald-800 dark:text-emerald-300";

  return (
    <div className={`rounded-lg border ${overallCls} px-3 py-3 space-y-3`}>
      <div className={`text-sm font-semibold ${overallTextCls}`}>
        {overallLabel}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat
          label="PGA máx"
          value={`${pgaMax.toFixed(3)} g`}
          hint={pgaSeverity === "red"
            ? "Sismo muy fuerte — verifica que el record y escala sean correctos"
            : pgaSeverity === "amber"
              ? "Sismo moderado-fuerte"
              : "Sismo suave-moderado"}
          severity={pgaSeverity}
        />
        <Stat
          label="Duración simulada"
          value={`${durMax.toFixed(1)} s`}
          hint={durSeverity === "red"
            ? "¡Backend rechazará! Excede 120s. Revisa dtrec."
            : durSeverity === "amber"
              ? "Larga — puede tardar varios minutos"
              : "Normal"}
          severity={durSeverity}
        />
        <Stat
          label="dtrec"
          value={`${dtrec.toFixed(5)} s`}
          hint={dtrecMismatch
            ? `No coincide con el parser (${detected?.toFixed(5)}s) — probable error`
            : detected
              ? `Coincide con lo detectado (${detected.toFixed(5)}s)`
              : "El parser no detectó dt — verifica manualmente"}
          severity={dtrecSeverity}
        />
        <Stat
          label="Unidades"
          value={units}
          hint={unitsSeverity === "green"
            ? "Detectadas automáticamente del archivo"
            : "No se detectaron — verifica que coincidan con el archivo"}
          severity={unitsSeverity}
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--text-muted)]">
        {uploadX && (
          <span>
            X: {uploadX.n_samples} muestras · PGA {(pgaX_g ?? 0).toFixed(3)} g ·
            {" "}{(uploadX.n_samples * dtrec).toFixed(1)} s simulados
          </span>
        )}
        {uploadY && (
          <span>
            Y: {uploadY.n_samples} muestras · PGA {(pgaY_g ?? 0).toFixed(3)} g ·
            {" "}{(uploadY.n_samples * dtrec).toFixed(1)} s simulados
          </span>
        )}
      </div>
    </div>
  );
}

function Stat({
  label, value, hint, severity,
}: {
  label: string; value: string; hint: string;
  severity: "green" | "amber" | "red";
}) {
  const bar = severity === "red" ? "bg-rose-500"
            : severity === "amber" ? "bg-amber-500"
            : "bg-emerald-500";
  const valTxt = severity === "red" ? "text-rose-800 dark:text-rose-300"
               : severity === "amber" ? "text-amber-800 dark:text-amber-300"
               : "text-emerald-800 dark:text-emerald-300";
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--panel-muted)] px-2.5 py-2 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${bar}`} />
        <span className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          {label}
        </span>
      </div>
      <div className={`text-sm font-mono font-semibold ${valTxt}`}>{value}</div>
      <div className="text-[10px] text-[var(--text-muted)] leading-tight">{hint}</div>
    </div>
  );
}
