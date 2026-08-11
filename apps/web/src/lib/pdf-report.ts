// PDF report generator for section analyses — jsPDF v4, landscape A4 for charts, portrait for tables
import type {
  InteractionResult,
  MomentCurvatureResult,
  PMMSurfaceResult,
  PMMDemandResult,
  NSR10Result,
  NSR10CheckItem,
} from "./editor-api";

// ── Palette ───────────────────────────────────────────────────────────────────
type RGB = [number, number, number];
const C: Record<string, RGB> = {
  text:    [20,  30,  36],
  muted:   [100, 112, 122],
  border:  [210, 215, 220],
  accent:  [0,   176, 200],
  success: [21,  160,  72],
  danger:  [210,  40,  40],
  warning: [195, 132,   8],
  bg:      [248, 250, 252],
  hdr:     [4,   20,  26],
  white:   [255, 255, 255],
};
const MC_RGB: RGB[] = [
  [45, 212, 232],
  [245, 158,  11],
  [167, 139, 250],
  [52,  211, 153],
  [248, 113, 113],
];

// ── Type alias (avoid importing jsPDF at module level for SSR safety) ─────────
type Doc = import("jspdf").jsPDF;

// ── Download helper (explicit blob URL, avoids jsPDF's internal FileSaver) ────
function _download(doc: Doc, filename: string) {
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(v: number, dec = 1): string {
  if (!isFinite(v)) return "—";
  return v.toLocaleString("es-CO", { maximumFractionDigits: dec, minimumFractionDigits: dec });
}

function sf(doc: Doc, c: RGB) { doc.setFillColor(c[0], c[1], c[2]); }
function sd(doc: Doc, c: RGB) { doc.setDrawColor(c[0], c[1], c[2]); }
function st(doc: Doc, c: RGB) { doc.setTextColor(c[0], c[1], c[2]); }

// ── Header / Footer ───────────────────────────────────────────────────────────
function addHeader(doc: Doc, name: string, subtitle: string, pw: number) {
  sf(doc, C.hdr);
  doc.rect(0, 0, pw, 18, "F");
  st(doc, C.white);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("PerformanceLabs", 8, 7);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  if (name) doc.text(`Sección: ${name}`, 8, 13);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text(subtitle, pw - 8, 7, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  const d = new Date().toLocaleDateString("es-CO", { year: "numeric", month: "long", day: "numeric" });
  doc.text(d, pw - 8, 13, { align: "right" });
}

function addFooter(doc: Doc, pw: number, ph: number) {
  sd(doc, C.border);
  doc.setLineWidth(0.25);
  doc.line(8, ph - 10, pw - 8, ph - 10);
  st(doc, C.muted);
  doc.setFont("helvetica", "italic");
  doc.setFontSize(6.5);
  doc.text("PerformanceLabs · OpenSees · NSR-10 2010", 8, ph - 4.5);
  doc.text("Verificar resultados con profesional competente", pw - 8, ph - 4.5, { align: "right" });
}

// ── Stat boxes row ────────────────────────────────────────────────────────────
interface Stat { label: string; value: string; unit?: string; }

function drawStats(doc: Doc, stats: Stat[], x0: number, y0: number, bw = 52, bh = 14) {
  stats.forEach((s, i) => {
    const bx = x0 + i * (bw + 4);
    sf(doc, C.bg); sd(doc, C.border);
    doc.setLineWidth(0.25);
    doc.roundedRect(bx, y0, bw, bh, 1.5, 1.5, "FD");
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); st(doc, C.muted);
    doc.text(s.label, bx + 3, y0 + 5);
    doc.setFont("helvetica", "bold"); doc.setFontSize(9); st(doc, C.text);
    doc.text(s.value + (s.unit ? ` ${s.unit}` : ""), bx + 3, y0 + 11.5);
  });
}

// ── Chart: P-M interaction ────────────────────────────────────────────────────
function drawPMChart(
  doc: Doc,
  pts: Array<{ p_kn: number; m_knm: number }>,
  cx: number, cy: number, cw: number, ch: number,
) {
  if (pts.length < 2) return;
  const mMax = Math.max(...pts.map((p) => p.m_knm), 1) * 1.1;
  const pMax = Math.max(...pts.map((p) => p.p_kn)) * 1.08;
  const pMin = Math.min(...pts.map((p) => p.p_kn), 0) * 1.08;
  const pR = pMax - pMin || 1;
  const sx = (m: number) => cx + (m / mMax) * cw;
  const sy = (p: number) => cy + ch - ((p - pMin) / pR) * ch;

  sf(doc, C.bg); sd(doc, C.border); doc.setLineWidth(0.2);
  doc.rect(cx, cy, cw, ch, "FD");

  // Grid
  doc.setLineWidth(0.12); sd(doc, [220, 224, 230] as RGB);
  for (let i = 1; i < 5; i++) doc.line(cx + (i/5)*cw, cy, cx + (i/5)*cw, cy+ch);
  for (let i = 1; i < 6; i++) doc.line(cx, cy + (i/6)*ch, cx+cw, cy + (i/6)*ch);

  // Zero line
  const zy = sy(0);
  if (zy > cy && zy < cy+ch) {
    sd(doc, C.muted); doc.setLineWidth(0.28);
    doc.setLineDashPattern([2, 1], 0);
    doc.line(cx, zy, cx+cw, zy);
    doc.setLineDashPattern([], 0);
  }

  // Nominal curve
  sd(doc, C.accent); doc.setLineWidth(0.7);
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1,y1,x2,y2]=[sx(pts[i].m_knm),sy(pts[i].p_kn),sx(pts[i+1].m_knm),sy(pts[i+1].p_kn)];
    if ([x1,y1,x2,y2].every(isFinite)) doc.line(x1,y1,x2,y2);
  }

  // Ticks
  doc.setFont("helvetica","normal"); doc.setFontSize(6); st(doc,C.muted);
  for (let i=0;i<=5;i++) doc.text(fmt((i/5)*mMax,0), sx((i/5)*mMax), cy+ch+5, {align:"center"});
  for (let i=0;i<=6;i++) {
    const v=pMin+(i/6)*pR; const ty=sy(v);
    if(ty>=cy-2&&ty<=cy+ch+2) doc.text(fmt(v,0), cx-2, ty+1.5, {align:"right"});
  }
  doc.setFontSize(7.5);
  doc.text("M (kN·m)", cx+cw/2, cy+ch+11, {align:"center"});
  doc.text("P (kN)", cx-14, cy+ch/2, {align:"center", angle:90});
}

// ── Chart: M-φ ────────────────────────────────────────────────────────────────
interface MCRun { result: MomentCurvatureResult; color: RGB; }

function drawMCChart(doc: Doc, runs: MCRun[], cx: number, cy: number, cw: number, ch: number) {
  if (!runs.length) return;
  const allPhi = runs.flatMap((r) => r.result.curve.map((p) => p.phi));
  const allMom = runs.flatMap((r) => r.result.curve.map((p) => p.moment));
  const phiMax = Math.max(...allPhi) * 1.05;
  const momMax = Math.max(...allMom) * 1.12;
  const sx = (v: number) => cx + (v/phiMax)*cw;
  const sy = (v: number) => cy + ch - (v/momMax)*ch;

  sf(doc,C.bg); sd(doc,C.border); doc.setLineWidth(0.2);
  doc.rect(cx,cy,cw,ch,"FD");
  doc.setLineWidth(0.12); sd(doc,[220,224,230] as RGB);
  for(let i=1;i<5;i++) { doc.line(cx+(i/5)*cw,cy,cx+(i/5)*cw,cy+ch); doc.line(cx,cy+(i/5)*ch,cx+cw,cy+(i/5)*ch); }

  runs.forEach((run) => {
    const { curve, phi_yield, moment_yield, phi_ultimate, moment_ultimate } = run.result;
    sd(doc,run.color); doc.setLineWidth(0.65); doc.setLineDashPattern([],0);
    for(let i=0;i<curve.length-1;i++){
      const [x1,y1,x2,y2]=[sx(curve[i].phi),sy(curve[i].moment),sx(curve[i+1].phi),sy(curve[i+1].moment)];
      if([x1,y1,x2,y2].every(isFinite)) doc.line(x1,y1,x2,y2);
    }
    if(isFinite(phi_yield)&&isFinite(moment_yield)){
      sf(doc,C.success); sd(doc,C.success); doc.circle(sx(phi_yield),sy(moment_yield),1.4,"F");
    }
    if(isFinite(phi_ultimate)&&isFinite(moment_ultimate)){
      sf(doc,C.danger); sd(doc,C.danger); doc.circle(sx(phi_ultimate),sy(moment_ultimate),1.4,"F");
    }
  });

  doc.setFont("helvetica","normal"); doc.setFontSize(6); st(doc,C.muted);
  for(let i=0;i<=5;i++) doc.text(fmt((i/5)*phiMax,4), sx((i/5)*phiMax), cy+ch+5, {align:"center"});
  for(let i=0;i<=5;i++){
    const v=(i/5)*momMax; const ty=sy(v);
    if(ty>=cy-2&&ty<=cy+ch+2) doc.text(fmt(v,0), cx-2, ty+1.5, {align:"right"});
  }
  doc.setFontSize(7.5);
  doc.text("Curvatura φ (1/m)", cx+cw/2, cy+ch+11, {align:"center"});
  doc.text("Momento M (kN·m)", cx-14, cy+ch/2, {align:"center", angle:90});
}

// ── Chart: P-M envelope from PMM surface ─────────────────────────────────────
function drawPMEnvelope(
  doc: Doc,
  curves: PMMSurfaceResult["curves"],
  cx: number, cy: number, cw: number, ch: number,
) {
  const allPts = curves.flatMap((c) => c.points);
  if (!allPts.length) return;
  const mAll = allPts.map((p) => Math.sqrt(p.mx*p.mx + p.my*p.my));
  const mMax = Math.max(...mAll, 1) * 1.1;
  const pMax = Math.max(...allPts.map((p) => p.p)) * 1.08;
  const pMin = Math.min(...allPts.map((p) => p.p), 0) * 1.08;
  const pR = pMax - pMin || 1;
  const sx = (m: number) => cx + (m/mMax)*cw;
  const sy = (p: number) => cy + ch - ((p-pMin)/pR)*ch;

  sf(doc,C.bg); sd(doc,C.border); doc.setLineWidth(0.2);
  doc.rect(cx,cy,cw,ch,"FD");
  doc.setLineWidth(0.12); sd(doc,[220,224,230] as RGB);
  for(let i=1;i<5;i++) { doc.line(cx+(i/5)*cw,cy,cx+(i/5)*cw,cy+ch); doc.line(cx,cy+(i/6)*ch,cx+cw,cy+(i/6)*ch); }

  const zy=sy(0);
  if(zy>cy&&zy<cy+ch){
    sd(doc,C.muted); doc.setLineWidth(0.28); doc.setLineDashPattern([2,1],0);
    doc.line(cx,zy,cx+cw,zy); doc.setLineDashPattern([],0);
  }

  sd(doc,C.accent); doc.setLineWidth(0.4);
  curves.forEach((curve) => {
    const mapped = curve.points.map((p) => ({ m: Math.sqrt(p.mx*p.mx+p.my*p.my), p: p.p }));
    for(let i=0;i<mapped.length-1;i++){
      const [x1,y1,x2,y2]=[sx(mapped[i].m),sy(mapped[i].p),sx(mapped[i+1].m),sy(mapped[i+1].p)];
      if([x1,y1,x2,y2].every(isFinite)) doc.line(x1,y1,x2,y2);
    }
  });

  doc.setFont("helvetica","normal"); doc.setFontSize(6); st(doc,C.muted);
  for(let i=0;i<=5;i++) doc.text(fmt((i/5)*mMax,0), sx((i/5)*mMax), cy+ch+5, {align:"center"});
  for(let i=0;i<=6;i++){
    const v=pMin+(i/6)*pR; const ty=sy(v);
    if(ty>=cy-2&&ty<=cy+ch+2) doc.text(fmt(v,0), cx-2, ty+1.5, {align:"right"});
  }
  doc.setFontSize(7.5);
  doc.text("|M| resultante (kN·m)", cx+cw/2, cy+ch+11, {align:"center"});
  doc.text("P (kN)", cx-14, cy+ch/2, {align:"center", angle:90});
}

// ── Generic compact table (no page break, for short data sets) ────────────────
interface ColDef { h: string; k: string; w: number; a?: "left"|"right"|"center"; }

function drawTable<T extends Record<string, string>>(
  doc: Doc, rows: T[], cols: ColDef[], x0: number, y0: number, rh = 8,
): number {
  const tw = cols.reduce((s,c)=>s+c.w,0);
  // Header
  sf(doc,[35,50,58] as RGB); doc.rect(x0,y0,tw,rh,"F");
  st(doc,C.white); doc.setFont("helvetica","bold"); doc.setFontSize(7);
  let hx=x0;
  cols.forEach((c)=>{
    const tx=c.a==="right"?hx+c.w-2:c.a==="center"?hx+c.w/2:hx+2;
    doc.text(c.h,tx,y0+rh-2,{align:c.a??("left" as const)});
    hx+=c.w;
  });
  let y=y0+rh;
  rows.forEach((row,ri)=>{
    sf(doc,ri%2===0?C.white:[247,250,252] as RGB);
    sd(doc,C.border); doc.setLineWidth(0.1);
    doc.rect(x0,y,tw,rh,"FD");
    doc.setFont("helvetica","normal"); doc.setFontSize(7); st(doc,C.text);
    let cx2=x0;
    cols.forEach((c)=>{
      const tx=c.a==="right"?cx2+c.w-2:c.a==="center"?cx2+c.w/2:cx2+2;
      const parts=doc.splitTextToSize(String(row[c.k]??""),c.w-4);
      doc.text(parts[0]??"",tx,y+rh-2,{align:c.a??("left" as const)});
      cx2+=c.w;
    });
    y+=rh;
  });
  return y;
}

// ── EXPORT: Diagrama P-M ──────────────────────────────────────────────────────
export async function exportPMPDF(
  sectionName: string,
  result: InteractionResult,
  thetaDeg: number,
) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation:"landscape", unit:"mm", format:"a4" });
  const [pw, ph] = [297, 210];

  addHeader(doc, sectionName, `Diagrama P-M — θ=${thetaDeg}°`, pw);
  addFooter(doc, pw, ph);

  drawStats(doc, [
    { label:"P máx (compresión)", value:fmt(result.p_max_kn,1), unit:"kN" },
    { label:"P mín (tensión)",    value:fmt(result.p_min_kn,1), unit:"kN" },
    { label:"M máx",             value:fmt(result.m_max_knm,1), unit:"kN·m" },
    { label:"Puntos calculados", value:String(result.points.length) },
    { label:"Ángulo θ",          value:`${thetaDeg}°` },
  ], 8, 22);

  drawPMChart(doc, result.points, 22, 42, 252, 133);

  doc.setFont("helvetica","italic"); doc.setFontSize(7); st(doc,C.muted);
  doc.text("Curva nominal calculada con OpenSees · Factorización φ·P-M según ACI 318-19.", 22, 191);

  // Data table (first 20 pts on same page if space, otherwise skip)
  if (result.points.length <= 20) {
    // no room on landscape for full table; omit here, user has CSV
  }

  const filename = `PM_${sectionName}_theta${thetaDeg}.pdf`;
  console.log("[pdf-report] saving", filename);
  _download(doc, filename);
  console.log("[pdf-report] done", filename);
}

// ── EXPORT: Curva M-φ ─────────────────────────────────────────────────────────
interface MCRunExport { axialKn: number; result: MomentCurvatureResult; }

export async function exportMCPDF(sectionName: string, runs: MCRunExport[]) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation:"landscape", unit:"mm", format:"a4" });
  const [pw, ph] = [297, 210];

  const latest = runs[runs.length-1].result;
  addHeader(doc, sectionName, `Curva M-φ — ${runs.length} corrida(s)`, pw);
  addFooter(doc, pw, ph);

  drawStats(doc, [
    { label:"Ductilidad μφ", value:fmt(latest.ductility,2) },
    { label:"Mmax",          value:fmt(latest.moment_max,1), unit:"kN·m" },
    { label:"φy",            value:fmt(latest.phi_yield,4),  unit:"1/m" },
    { label:"φu",            value:fmt(latest.phi_ultimate,4), unit:"1/m" },
    { label:"EI secante",    value:fmt(latest.ei_secant_kNm2/1000,0), unit:"MN·m²" },
  ], 8, 22);

  const runsRGB: MCRun[] = runs.map((r,i)=>({ result:r.result, color:MC_RGB[i%MC_RGB.length] }));
  drawMCChart(doc, runsRGB, 22, 42, 252, 128);

  // Legend
  if (runs.length > 1) {
    let lx=22;
    runs.forEach((r,i)=>{
      sf(doc,MC_RGB[i%MC_RGB.length]); sd(doc,MC_RGB[i%MC_RGB.length]);
      doc.rect(lx,177,10,3,"F");
      st(doc,C.text); doc.setFont("helvetica","normal"); doc.setFontSize(7);
      doc.text(`P=${r.axialKn} kN`, lx+12, 179.5);
      lx+=48;
    });
  }

  // Comparison table (page 2)
  if (runs.length > 1) {
    doc.addPage("a4","l");
    addHeader(doc, sectionName, "Comparativa M-φ", pw);
    addFooter(doc, pw, ph);

    doc.setFont("helvetica","bold"); doc.setFontSize(9); st(doc,C.text);
    doc.text("Tabla comparativa de curvas M-φ", 8, 26);

    const rows = runs.map((r)=>({
      p:    fmt(r.result.axial_load_kn,0),
      mmax: fmt(r.result.moment_max,1),
      phy:  fmt(r.result.phi_yield,4),
      phu:  fmt(r.result.phi_ultimate,4),
      mu:   fmt(r.result.ductility,2),
      ei:   fmt(r.result.ei_secant_kNm2/1000,0),
      fail: r.result.failure_reached?"Sí":"No",
    }));
    drawTable(doc, rows, [
      {h:"P (kN)",       k:"p",    w:32, a:"right"},
      {h:"Mmax (kN·m)", k:"mmax", w:38, a:"right"},
      {h:"φy (1/m)",     k:"phy",  w:38, a:"right"},
      {h:"φu (1/m)",     k:"phu",  w:38, a:"right"},
      {h:"μφ",           k:"mu",   w:25, a:"right"},
      {h:"EI (MN·m²)",  k:"ei",   w:38, a:"right"},
      {h:"Falla",        k:"fail", w:22, a:"center"},
    ], 8, 32);
  }

  _download(doc, `MC_${sectionName}.pdf`);
}

// ── EXPORT: Superficie P-M-M ──────────────────────────────────────────────────
export async function exportPMMPDF(sectionName: string, result: PMMSurfaceResult) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation:"landscape", unit:"mm", format:"a4" });
  const [pw, ph] = [297, 210];

  addHeader(doc, sectionName, "Superficie P-M-M Biaxial", pw);
  addFooter(doc, pw, ph);

  drawStats(doc, [
    { label:"P máx (compresión)", value:fmt(result.p_max_kn,1), unit:"kN" },
    { label:"P mín (tensión)",   value:fmt(result.p_min_kn,1), unit:"kN" },
    { label:"M máx",             value:fmt(result.m_max_knm,1), unit:"kN·m" },
    { label:"Meridianos",        value:String(result.curves.length) },
    { label:"Demandas",          value:String(result.demands_out.length) },
  ], 8, 22);

  drawPMEnvelope(doc, result.curves, 22, 42, 252, 128);

  doc.setFont("helvetica","italic"); doc.setFontSize(7); st(doc,C.muted);
  doc.text("Proyección P vs |M| — cada meridiano corresponde a un ángulo de aplicación de momento.", 22, 183);

  // Demands table
  if (result.demands_out.length > 0) {
    doc.addPage("a4","l");
    addHeader(doc, sectionName, "Verificación de Demandas P-M-M", pw);
    addFooter(doc, pw, ph);

    doc.setFont("helvetica","bold"); doc.setFontSize(9); st(doc,C.text);
    doc.text("Verificación de combinaciones de carga (DCR)", 8, 26);

    const rows = (result.demands_out as PMMDemandResult[]).map((d,i)=>({
      n:  String(i+1),
      p:  fmt(d.p_kn,1),
      mx: fmt(d.mx_knm,1),
      my: fmt(d.my_knm,1),
      md: fmt(d.m_demand_knm,1),
      mc: fmt(d.m_capacity_knm,1),
      dcr:d.dcr===Infinity?"∞":fmt(d.dcr,3),
      est:d.inside?"OK":"FALLA",
    }));
    drawTable(doc, rows, [
      {h:"#",           k:"n",  w:14, a:"center"},
      {h:"P (kN)",      k:"p",  w:32, a:"right"},
      {h:"Mx (kN·m)",  k:"mx", w:34, a:"right"},
      {h:"My (kN·m)",  k:"my", w:34, a:"right"},
      {h:"M dem",       k:"md", w:32, a:"right"},
      {h:"M cap",       k:"mc", w:32, a:"right"},
      {h:"DCR",         k:"dcr",w:28, a:"right"},
      {h:"Estado",      k:"est",w:26, a:"center"},
    ], 8, 32);
  }

  _download(doc, `PMM_${sectionName}.pdf`);
}

// ── EXPORT: Verificación NSR-10 (portrait, with page breaks) ─────────────────
export async function exportNSR10PDF(sectionName: string, result: NSR10Result) {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ orientation:"portrait", unit:"mm", format:"a4" });
  const [pw, ph] = [210, 297];

  addHeader(doc, sectionName, "Verificación NSR-10", pw);
  addFooter(doc, pw, ph);

  // Summary banner
  const s = result.summary;
  const allOk = s.fail===0 && s.warning===0;
  const hasFail = s.fail>0;
  const bannerFill: RGB = allOk ? [210,245,220] : hasFail ? [255,230,230] : [255,248,215];
  const bannerText: RGB = allOk ? C.success : hasFail ? C.danger : C.warning;
  const bannerBorder: RGB = allOk ? [100,200,130] : hasFail ? [210,80,80] : [200,160,50];

  sf(doc, bannerFill); sd(doc, bannerBorder); doc.setLineWidth(0.5);
  doc.roundedRect(8, 22, pw-16, 18, 2, 2, "FD");

  const summaryLabel = allOk ? "CUMPLE todos los criterios NSR-10"
    : hasFail ? `NO CUMPLE — ${s.fail} criterio(s) fallido(s)`
    : `REVISAR — ${s.warning} criterio(s) a revisar`;

  doc.setFont("helvetica","bold"); doc.setFontSize(10); st(doc, bannerText);
  doc.text(summaryLabel, 14, 31);

  const elementLabel = result.element_type.charAt(0).toUpperCase() + result.element_type.slice(1);
  doc.setFont("helvetica","normal"); doc.setFontSize(7.5); st(doc, C.muted);
  doc.text(`${elementLabel} · ${result.ductility} · ${s.ok} de ${s.total} verificaciones OK`, 14, 36);

  // Mini count badges
  const badges = [
    {label:"OK",     value:s.ok,      color:C.success},
    {label:"Falla",  value:s.fail,    color:C.danger},
    {label:"Revisar",value:s.warning, color:C.warning},
  ];
  let bx=pw-8-badges.length*20;
  badges.forEach((b)=>{
    sf(doc,C.white); sd(doc,b.color); doc.setLineWidth(0.4);
    doc.roundedRect(bx,23,17,8,1,1,"FD");
    doc.setFont("helvetica","bold"); doc.setFontSize(9); st(doc,b.color);
    doc.text(String(b.value), bx+8.5, 29, {align:"center"});
    doc.setFont("helvetica","normal"); doc.setFontSize(5.5); st(doc,C.muted);
    doc.text(b.label, bx+8.5, 33, {align:"center"});
    bx+=20;
  });

  // Table header
  const colW = [28,68,22,22,28,24]; // Article, Desc, Calc, Límite, Estado, Unid
  const tw = colW.reduce((a,b)=>a+b,0);
  const tx0=8; let ty=48; const rh=8;

  function renderTableHeader() {
    sf(doc,[35,50,58] as RGB); doc.rect(tx0,ty,tw,rh,"F");
    st(doc,C.white); doc.setFont("helvetica","bold"); doc.setFontSize(7);
    const hdrs=["Artículo","Descripción","Calculado","Límite","Estado","Unidad"];
    let hx=tx0;
    colW.forEach((w,i)=>{ doc.text(hdrs[i], hx+2, ty+rh-2); hx+=w; });
    ty+=rh;
  }

  doc.setFont("helvetica","bold"); doc.setFontSize(9); st(doc,C.text);
  doc.text("Verificaciones NSR-10", tx0, 45);
  renderTableHeader();

  const STATUS_COLORS: Record<string,RGB> = {
    ok:C.success, fail:C.danger, warning:C.warning, info:C.muted,
  };
  const STATUS_LABELS: Record<string,string> = {
    ok:"OK", fail:"FALLA", warning:"REVISAR", info:"INFO",
  };

  result.checks.forEach((c: NSR10CheckItem, ri: number) => {
    // Page break
    if (ty + rh > ph - 14) {
      doc.addPage("a4","p");
      addHeader(doc, sectionName, "NSR-10 (continuación)", pw);
      addFooter(doc, pw, ph);
      ty=22;
      doc.setFont("helvetica","bold"); doc.setFontSize(9); st(doc,C.text);
      doc.text("Verificaciones NSR-10 (continuación)", tx0, ty+5);
      ty+=9;
      renderTableHeader();
    }

    const sc = STATUS_COLORS[c.status];
    sf(doc, ri%2===0?C.white:[247,250,252] as RGB);
    sd(doc,C.border); doc.setLineWidth(0.1);
    doc.rect(tx0,ty,tw,rh,"FD");

    // Status strip
    sf(doc,sc); doc.rect(tx0,ty,1.5,rh,"F");

    doc.setFont("helvetica","normal"); doc.setFontSize(6.5);
    let cx5=tx0+2;

    // Article
    st(doc,C.muted);
    doc.text(c.article, cx5, ty+rh-2.5);
    cx5+=colW[0];

    // Description (truncate)
    st(doc,C.text);
    const descParts = doc.splitTextToSize(c.description, colW[1]-4);
    doc.text(descParts[0]??"", cx5, ty+rh-2.5);
    cx5+=colW[1];

    // Demand value
    const showVals = c.status!=="info" && c.unit!=="—";
    const dec = c.unit==="%"?3:c.unit==="mm"?1:1;
    doc.setFont("helvetica","bold"); st(doc,sc);
    doc.text(showVals?fmt(c.demand,dec):"—", cx5+colW[2]-2, ty+rh-2.5, {align:"right"});
    cx5+=colW[2];

    // Limit
    doc.setFont("helvetica","normal"); st(doc,C.muted);
    doc.text(showVals&&c.limit>0?fmt(c.limit,dec):"—", cx5+colW[3]-2, ty+rh-2.5, {align:"right"});
    cx5+=colW[3];

    // Status badge
    sf(doc,sc); doc.roundedRect(cx5+1,ty+1.5,colW[4]-2,rh-3,1,1,"F");
    st(doc,C.white); doc.setFont("helvetica","bold"); doc.setFontSize(6);
    doc.text(STATUS_LABELS[c.status], cx5+colW[4]/2-0.5, ty+rh-2.5, {align:"center"});
    cx5+=colW[4];

    // Unit
    doc.setFont("helvetica","normal"); doc.setFontSize(6); st(doc,C.muted);
    if (showVals && c.unit && c.unit!=="—") doc.text(c.unit, cx5+1, ty+rh-2.5);
    cx5+=colW[5];

    ty+=rh;

    // Note row (if exists)
    if (c.note) {
      if(ty+5>ph-14){
        doc.addPage("a4","p"); addHeader(doc,sectionName,"NSR-10 (continuación)",pw);
        addFooter(doc,pw,ph); ty=22;
        renderTableHeader();
      }
      sf(doc,ri%2===0?C.white:[247,250,252] as RGB);
      sd(doc,C.border); doc.setLineWidth(0.1);
      doc.rect(tx0,ty,tw,5,"FD");
      doc.setFont("helvetica","italic"); doc.setFontSize(6); st(doc,C.muted);
      const noteParts=doc.splitTextToSize(c.note, tw-8);
      doc.text(noteParts[0]??"", tx0+31, ty+3.5);
      ty+=5;
    }
  });

  _download(doc, `NSR10_${sectionName}_${result.element_type}_${result.ductility}.pdf`);
}
