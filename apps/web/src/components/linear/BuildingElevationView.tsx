"use client";

/**
 * BuildingElevationView — Vista en elevación 2D del modelo estructural.
 *
 * Corta el modelo por un plano vertical paralelo al eje X (vista frontal,
 * mira hacia +Y) o al eje Y (vista lateral, mira hacia +X) a una coordenada
 * dada, y renderiza los elementos que intersecan.
 *
 * Comparte el modo de dibujo con Building2DPlanView y permite crear muros,
 * columnas, vigas e infills en la elevación — indispensable para infills
 * porque un panel de mampostería vive en un bay (2 columnas + 2 pisos).
 */
import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import type {
  ModelGeometry,
  SectionData,
  GridDefinition,
  MasonryMaterial,
  DrawingTool,
  InfillPanel,
} from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  geometry: ModelGeometry;
  height?: number;
  sections?: Record<string, SectionData>;
  grid?: GridDefinition;
  masonryMaterials?: Record<string, MasonryMaterial>;
  infills?: Record<string, InfillPanel>;
  projectId?: string;
  onModelChanged?: () => void | Promise<void>;
  onElementClick?: (info: { id: string; type: "wall" | "beam" | "column" | "infill"; label: string }) => void;
}

interface PendingPoint { x: number; y: number; jointId?: string }   // x = horizontal, y = z (elevación)

type Cut = "X" | "Y";   // eje que varía en la horizontal (X → corte YZ; Y → corte XZ)

const COLORS = {
  bg:        "var(--surface)",
  grid:      "rgba(148, 163, 184, 0.20)",
  gridUser:  "rgba(37, 99, 235, 0.30)",
  gridAxis:  "#2563eb",
  axis:      "#94a3b8",
  wall:      "#0f766e",
  wallFill:  "rgba(15, 118, 110, 0.55)",
  column:    "#b91c1c",
  columnFill:"rgba(220, 38, 38, 0.80)",
  beam:      "#475569",
  beamFill:  "rgba(100, 116, 139, 0.60)",
  slab:      "#3b82f6",
  ground:    "#78350f",
  ghost:     "#f59e0b",
  snap:      "#22c55e",
  infill:    "#d97706",
  infillFill:"rgba(217, 119, 6, 0.30)",
  strut:     "#c2410c",
};

export default function BuildingElevationView({
  geometry,
  height = 640,
  sections,
  grid,
  masonryMaterials,
  infills,
  projectId,
  onModelChanged,
  onElementClick,
}: Props) {
  const canEdit = !!projectId;

  const [cut, setCut] = useState<Cut>("X");
  const [showGrid, setShowGrid] = useState(true);
  // Coordenada del plano de corte. cut="X" → corta perpendicular a Y, valor = Y del plano.
  const [cutValue, setCutValue] = useState<number | null>(null);
  const [tolerance, setTolerance] = useState(0.75);   // ancho de banda (m) para incluir elementos "cercanos"

  // ── Bounds y candidatos de plano ───────────────────────────────────────────
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
    for (const j of Object.values(geometry.joints)) {
      if (j.x < minX) minX = j.x; if (j.x > maxX) maxX = j.x;
      if (j.y < minY) minY = j.y; if (j.y > maxY) maxY = j.y;
      if (j.z > maxZ) maxZ = j.z;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 20, maxY: 20, maxZ: 10 };
    return { minX, minY, maxX, maxY, maxZ };
  }, [geometry.joints]);

  // Sugerencias de planos de corte: promedios de coordenadas de muros + ejes del grid
  const planeSuggestions = useMemo(() => {
    const ys = new Set<number>();
    const xs = new Set<number>();
    for (const s of Object.values(geometry.shells)) {
      if (s.element_type !== "wall") continue;
      let sumX = 0, sumY = 0, n = 0;
      for (const jl of s.joints) {
        const j = geometry.joints[jl];
        if (!j) continue;
        sumX += j.x; sumY += j.y; n++;
      }
      if (n) {
        ys.add(Number((sumY / n).toFixed(2)));
        xs.add(Number((sumX / n).toFixed(2)));
      }
    }
    // Añade ejes del usuario
    if (grid) {
      for (const a of grid.axes_x) xs.add(Number(a.coord_m.toFixed(2)));
      for (const a of grid.axes_y) ys.add(Number(a.coord_m.toFixed(2)));
    }
    return {
      X: Array.from(ys).sort((a, b) => a - b),   // cortes cut="X" varían el X — el plano es Y=const
      Y: Array.from(xs).sort((a, b) => a - b),
    };
  }, [geometry.shells, geometry.joints, grid]);

  useEffect(() => {
    if (cutValue !== null) return;
    const list = planeSuggestions[cut];
    if (list.length) setCutValue(list[0]);
    else setCutValue(cut === "X" ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2);
  }, [cut, cutValue, planeSuggestions, bounds]);

  // Cambia el default cuando el usuario cambia de eje de corte
  useEffect(() => {
    const list = planeSuggestions[cut];
    if (list.length) setCutValue(list[0]);
  }, [cut, planeSuggestions]);

  // ── Helpers de proyección ──────────────────────────────────────────────────
  // cut="X" → horizontal del SVG = coordenada X del modelo; plano a Y = cutValue.
  // cut="Y" → horizontal del SVG = coordenada Y del modelo; plano a X = cutValue.
  const horizOf = useCallback((jx: number, jy: number) => (cut === "X" ? jx : jy), [cut]);
  const perpOf  = useCallback((jx: number, jy: number) => (cut === "X" ? jy : jx), [cut]);

  const withinCut = useCallback((jx: number, jy: number) => {
    if (cutValue === null) return false;
    return Math.abs(perpOf(jx, jy) - cutValue) <= tolerance;
  }, [cutValue, perpOf, tolerance]);

  // ── Filtros por plano ──────────────────────────────────────────────────────
  const framesInCut = useMemo(() => {
    const res: { id: string; ix: number; iz: number; jx: number; jz: number; kind: "column" | "beam"; section: string }[] = [];
    for (const [id, f] of Object.entries(geometry.frames)) {
      const ji = geometry.joints[f.joint_i];
      const jj = geometry.joints[f.joint_j];
      if (!ji || !jj) continue;
      if (!(withinCut(ji.x, ji.y) && withinCut(jj.x, jj.y))) continue;
      res.push({
        id,
        ix: horizOf(ji.x, ji.y), iz: ji.z,
        jx: horizOf(jj.x, jj.y), jz: jj.z,
        kind: f.element_type,
        section: f.section,
      });
    }
    return res;
  }, [geometry.frames, geometry.joints, withinCut, horizOf]);

  const wallsInCut = useMemo(() => {
    interface WallVis {
      id: string; pier: string; x1: number; z1: number; x2: number; z2: number;
      thickness_m: number;
    }
    const groups = new Map<string, WallVis>();
    for (const [shellId, s] of Object.entries(geometry.shells)) {
      if (s.element_type !== "wall") continue;
      let sumX = 0, sumY = 0, n = 0;
      const pts: { x: number; z: number }[] = [];
      for (const jl of s.joints) {
        const j = geometry.joints[jl];
        if (!j) continue;
        sumX += j.x; sumY += j.y; n++;
        pts.push({ x: horizOf(j.x, j.y), z: j.z });
      }
      if (!n) continue;
      const cx = sumX / n, cy = sumY / n;
      if (!withinCut(cx, cy)) continue;
      // Rango horizontal + vertical del muro en el corte
      let minH = Infinity, maxH = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const p of pts) {
        if (p.x < minH) minH = p.x; if (p.x > maxH) maxH = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
      }
      const key = (s.pier || shellId) + "|" + Math.round(minH * 10) + "|" + Math.round(minZ * 10);
      if (!groups.has(key)) {
        groups.set(key, {
          id: shellId, pier: s.pier || shellId,
          x1: minH, z1: minZ, x2: maxH, z2: maxZ,
          thickness_m: s.thickness_m ?? 0.2,
        });
      }
    }
    return [...groups.values()];
  }, [geometry.shells, geometry.joints, withinCut, horizOf]);

  const infillsInCut = useMemo(() => {
    if (!infills) return [];
    const res: {
      id: string; pier: string; x1: number; z1: number; x2: number; z2: number;
      opening_ratio: number; masonry_material_id: string; thickness_m: number;
    }[] = [];
    for (const [id, inf] of Object.entries(infills)) {
      const wall = wallsInCut.find((w) => w.pier === inf.pier);
      if (!wall) continue;
      const story = geometry.stories[inf.story];
      if (!story) continue;
      const zTop = story.elevation_m;
      const zBase = Math.max(0, zTop - (story.height_m ?? (zTop - wall.z1)));
      res.push({
        id, pier: inf.pier ?? "",
        x1: wall.x1, z1: zBase,
        x2: wall.x2, z2: zTop,
        opening_ratio: inf.opening_ratio,
        masonry_material_id: inf.masonry_material_id,
        thickness_m: inf.thickness_m,
      });
    }
    return res;
  }, [infills, wallsInCut, geometry.stories]);

  // ── ViewBox de la elevación ────────────────────────────────────────────────
  const modelH = Math.max(
    cut === "X" ? bounds.maxX - bounds.minX : bounds.maxY - bounds.minY,
    1,
  );
  const modelV = Math.max(bounds.maxZ, 1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; startPan: { x: number; y: number }; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const PAD = Math.max(modelH, modelV) * 0.10;
  const vbW = (modelH + 2 * PAD) / zoom;
  const vbH = (modelV + 2 * PAD) / zoom;
  const originH = cut === "X" ? bounds.minX : bounds.minY;
  const vbX = originH - PAD + pan.x;
  const vbY = -PAD + pan.y;
  // SVG Y crece hacia abajo — invertimos para que z crezca hacia arriba
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  const gridStep = useMemo(() => {
    const span = Math.max(modelH, modelV);
    if (span >= 40) return 5; if (span >= 20) return 2;
    if (span >= 8) return 1; return 0.5;
  }, [modelH, modelV]);

  // ── Herramienta de dibujo ──────────────────────────────────────────────────
  const [tool, setTool] = useState<DrawingTool>("select");
  const [pending, setPending] = useState<PendingPoint[]>([]);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [defaultSection, setDefaultSection] = useState<string>("");
  const [defaultThickness, setDefaultThickness] = useState(0.20);
  const [defaultMasonry, setDefaultMasonry] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!sections) return;
    const first = Object.keys(sections)[0] ?? "";
    if (first && !defaultSection) setDefaultSection(first);
  }, [sections, defaultSection]);
  useEffect(() => {
    if (!masonryMaterials) return;
    const first = Object.keys(masonryMaterials)[0] ?? "";
    if (first && !defaultMasonry) setDefaultMasonry(first);
  }, [masonryMaterials, defaultMasonry]);
  useEffect(() => { setPending([]); setSaveError(null); }, [tool, cut, cutValue]);

  // Joints candidatos para snap (en el plano de corte)
  const jointsInCut = useMemo(() => {
    const res: { id: string; x: number; z: number }[] = [];
    for (const [id, j] of Object.entries(geometry.joints)) {
      if (!withinCut(j.x, j.y)) continue;
      res.push({ id, x: horizOf(j.x, j.y), z: j.z });
    }
    return res;
  }, [geometry.joints, withinCut, horizOf]);

  // ── Coordenada mouse → modelo ──────────────────────────────────────────────
  const svgToModel = useCallback((clientX: number, clientY: number) => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    return { x: vbX + px * vbW, y: -(vbY + py * vbH) };   // invierte Y para elevación
  }, [vbX, vbY, vbW, vbH]);

  const snapPoint = useCallback((mx: number, mz: number): PendingPoint => {
    const tol = Math.max(modelH, modelV) * 0.02 / zoom;
    let bestJoint: { id: string; x: number; z: number; d: number } | null = null;
    for (const j of jointsInCut) {
      const d = Math.hypot(j.x - mx, j.z - mz);
      if (d < tol && (!bestJoint || d < bestJoint.d)) {
        bestJoint = { id: j.id, x: j.x, z: j.z, d };
      }
    }
    if (bestJoint) return { x: bestJoint.x, y: bestJoint.z, jointId: bestJoint.id };

    // Snap al eje horizontal (grid.axes_x/y según cut) + a alturas de piso
    let sx = mx, sz = mz;
    if (grid) {
      const axes = cut === "X" ? grid.axes_x : grid.axes_y;
      let best = Infinity;
      for (const a of axes) {
        const d = Math.abs(a.coord_m - mx);
        if (d < tol && d < best) { sx = a.coord_m; best = d; }
      }
    }
    let bestZ = Infinity;
    for (const s of Object.values(geometry.stories)) {
      const d = Math.abs(s.elevation_m - mz);
      if (d < tol && d < bestZ) { sz = s.elevation_m; bestZ = d; }
    }
    return { x: sx, y: sz };
  }, [jointsInCut, grid, cut, modelH, modelV, zoom, geometry.stories]);

  // ── Zoom / pan ────────────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const f = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((z) => Math.min(20, Math.max(0.2, z * f)));
  }, []);
  const onMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, startPan: { ...pan }, moved: false };
  }, [pan]);
  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const pt = svgToModel(e.clientX, e.clientY);
    if (pt) setPointer(pt);
    if (!dragRef.current || !svgRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    if (Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
    const rect = svgRef.current.getBoundingClientRect();
    setPan({
      x: dragRef.current.startPan.x - (dx / rect.width) * vbW,
      y: dragRef.current.startPan.y + (dy / rect.height) * vbH,   // Y invertida
    });
  }, [vbW, vbH, svgToModel]);
  const endDrag = useCallback(() => { dragRef.current = null; }, []);
  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  useEffect(() => { resetView(); }, [cut, cutValue, resetView]);

  // ── Handlers de click ──────────────────────────────────────────────────────
  const handleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (dragRef.current?.moved) return;
    if (!canEdit || tool === "select") return;
    const pt = svgToModel(e.clientX, e.clientY);
    if (!pt) return;
    const sp = snapPoint(pt.x, pt.y);
    setPending((prev) => [...prev, sp]);
  }, [canEdit, tool, svgToModel, snapPoint]);

  useEffect(() => {
    if (!canEdit || !projectId || saving) return;
    (async () => {
      if (tool === "column" && pending.length >= 2) {
        await createColumn(pending[0], pending[1]);
        setPending([]);
      } else if (tool === "beam" && pending.length >= 2) {
        await createBeam(pending[0], pending[1]);
        setPending([]);
      } else if (tool === "wall" && pending.length >= 2) {
        await createWall(pending[0], pending[1]);
        setPending([]);
      } else if (tool === "infill" && pending.length >= 2) {
        await createInfill(pending[0], pending[1]);
        setPending([]);
      }
    })();
  }, [pending, tool, canEdit, projectId, saving]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Creación desde elevación ───────────────────────────────────────────────
  const ensureJoint = useCallback(async (p: PendingPoint): Promise<string> => {
    if (p.jointId) return p.jointId;
    if (!projectId || cutValue === null) throw new Error("Sin projectId o plano de corte");
    const jx = cut === "X" ? p.x : cutValue;
    const jy = cut === "X" ? cutValue : p.x;
    const jz = p.y;
    let id = `J-${Math.round(jx * 100)}-${Math.round(jy * 100)}-${Math.round(jz * 100)}`;
    let n = 1;
    while (geometry.joints[id]) { id = `J-${Math.round(jx * 100)}-${Math.round(jy * 100)}-${Math.round(jz * 100)}-${n++}`; }
    // Story auto por z
    let story = "";
    for (const [name, s] of Object.entries(geometry.stories)) {
      if (Math.abs(s.elevation_m - jz) < 0.05) { story = name; break; }
    }
    await structuralEditorApi.createJoint(projectId, {
      id, x: jx, y: jy, z: jz, story,
      is_restrained: Math.abs(jz) < 1e-3,
      restraints: Math.abs(jz) < 1e-3 ? [1,1,1,1,1,1] : null,
    });
    return id;
  }, [projectId, cutValue, cut, geometry.joints, geometry.stories]);

  async function createColumn(a: PendingPoint, b: PendingPoint) {
    if (!projectId) return;
    if (!defaultSection) { setSaveError("Selecciona una sección primero"); return; }
    setSaving(true); setSaveError(null);
    try {
      // Columna vertical: se toma el x horizontal del primer punto y las dos alturas.
      const zLo = Math.min(a.y, b.y);
      const zHi = Math.max(a.y, b.y);
      const jb = await ensureJoint({ x: a.x, y: zLo });
      const jt = await ensureJoint({ x: a.x, y: zHi });
      const cid = `C-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      // Story = piso del joint superior
      let story = "";
      for (const [name, s] of Object.entries(geometry.stories)) {
        if (Math.abs(s.elevation_m - zHi) < 0.05) { story = name; break; }
      }
      await structuralEditorApi.createFrame(projectId, {
        id: cid, joint_i: jb, joint_j: jt,
        section: defaultSection, element_type: "column", story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createBeam(a: PendingPoint, b: PendingPoint) {
    if (!projectId) return;
    if (!defaultSection) { setSaveError("Selecciona una sección primero"); return; }
    setSaving(true); setSaveError(null);
    try {
      const ji = await ensureJoint(a);
      const jj = await ensureJoint(b);
      const bid = `V-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      let story = "";
      const zTop = Math.max(a.y, b.y);
      for (const [name, s] of Object.entries(geometry.stories)) {
        if (Math.abs(s.elevation_m - zTop) < 0.05) { story = name; break; }
      }
      await structuralEditorApi.createFrame(projectId, {
        id: bid, joint_i: ji, joint_j: jj,
        section: defaultSection, element_type: "beam", story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createWall(a: PendingPoint, b: PendingPoint) {
    if (!projectId) return;
    setSaving(true); setSaveError(null);
    try {
      const zLo = Math.min(a.y, b.y);
      const zHi = Math.max(a.y, b.y);
      const xL = Math.min(a.x, b.x);
      const xR = Math.max(a.x, b.x);
      const j1 = await ensureJoint({ x: xL, y: zLo });
      const j2 = await ensureJoint({ x: xR, y: zLo });
      const j3 = await ensureJoint({ x: xR, y: zHi });
      const j4 = await ensureJoint({ x: xL, y: zHi });
      const pier = `M-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      let story = "";
      for (const [name, s] of Object.entries(geometry.stories)) {
        if (Math.abs(s.elevation_m - zHi) < 0.05) { story = name; break; }
      }
      await structuralEditorApi.createShell(projectId, {
        id: pier, joints: [j1, j2, j3, j4],
        section: "", element_type: "wall",
        thickness_m: defaultThickness, pier, story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createInfill(a: PendingPoint, b: PendingPoint) {
    if (!projectId) return;
    if (!defaultMasonry) { setSaveError("Selecciona un material de mampostería"); return; }
    setSaving(true); setSaveError(null);
    try {
      const zHi = Math.max(a.y, b.y);
      // Story = piso al que pertenece la elevación superior del panel
      let story = "";
      for (const [name, s] of Object.entries(geometry.stories)) {
        if (Math.abs(s.elevation_m - zHi) < 0.05) { story = name; break; }
      }
      if (!story) {
        setSaveError("La elevación superior no coincide con un piso definido.");
        return;
      }
      // Busca el muro/pier en el corte que abarque el rango horizontal
      const xL = Math.min(a.x, b.x);
      const xR = Math.max(a.x, b.x);
      let bestPier = "";
      let bestOverlap = 0;
      for (const w of wallsInCut) {
        const overlap = Math.max(0, Math.min(w.x2, xR) - Math.max(w.x1, xL));
        if (overlap > bestOverlap) { bestOverlap = overlap; bestPier = w.pier; }
      }
      if (!bestPier) {
        setSaveError("Coloca el infill sobre un pier existente en la elevación.");
        return;
      }
      const iid = `INF-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      await structuralEditorApi.createInfill(projectId, {
        id: iid, pier: bestPier, story,
        thickness_m: defaultThickness,
        masonry_material_id: defaultMasonry,
        opening_ratio: 0.0, width_ratio: 0.25,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ── Grid en pantalla ───────────────────────────────────────────────────────
  const gridLines: React.ReactElement[] = [];
  const gxStart = Math.floor(vbX / gridStep) * gridStep;
  const gxEnd   = Math.ceil((vbX + vbW) / gridStep) * gridStep;
  const gyStart = Math.floor(vbY / gridStep) * gridStep;
  const gyEnd   = Math.ceil((vbY + vbH) / gridStep) * gridStep;
  for (let x = gxStart; x <= gxEnd + 1e-9; x += gridStep) {
    gridLines.push(<line key={`gx-${x.toFixed(3)}`} x1={x} y1={vbY} x2={x} y2={vbY + vbH}
      stroke={COLORS.grid} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />);
  }
  for (let y = gyStart; y <= gyEnd + 1e-9; y += gridStep) {
    gridLines.push(<line key={`gy-${y.toFixed(3)}`} x1={vbX} y1={y} x2={vbX + vbW} y2={y}
      stroke={COLORS.grid} strokeWidth={0.5} vectorEffect="non-scaling-stroke" />);
  }

  // Marca cada piso
  const storyLines: React.ReactElement[] = [];
  for (const [name, s] of Object.entries(geometry.stories)) {
    storyLines.push(
      <line key={`sl-${name}`} x1={vbX} y1={-s.elevation_m} x2={vbX + vbW} y2={-s.elevation_m}
        stroke={COLORS.gridUser} strokeWidth={0.8} strokeDasharray="6 3"
        vectorEffect="non-scaling-stroke" />,
      <text key={`slt-${name}`} x={vbX + 0.4} y={-s.elevation_m - 0.15}
        fill={COLORS.gridUser} fontSize={Math.max(0.3, modelV / 60)}
        style={{ fontWeight: 600, pointerEvents: "none" }}>
        {name} (z={s.elevation_m.toFixed(2)}m)
      </text>,
    );
  }

  // Suelo
  const groundLine = (
    <line x1={vbX} y1={0} x2={vbX + vbW} y2={0}
      stroke={COLORS.ground} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
  );

  // Ejes del usuario (grid ETABS): en cut=X vemos axes_x como verticales;
  // en cut=Y vemos axes_y como verticales. Los ejes perpendiculares al corte
  // no se dibujan (no aparecen como líneas visibles en un plano).
  const userAxisLines: React.ReactElement[] = [];
  if (showGrid && grid) {
    const axes = cut === "X" ? grid.axes_x : grid.axes_y;
    const yTop = -bounds.maxZ - 0.5;   // por encima del edificio
    const yBottom = 1.0;                // por debajo del suelo
    const fontSize = Math.max(0.32, modelV / 55);
    for (const a of axes) {
      const x = a.coord_m;
      userAxisLines.push(
        <line key={`uax-l-${a.name}`}
          x1={x} y1={yBottom} x2={x} y2={yTop}
          stroke={COLORS.gridAxis} strokeWidth={1.2}
          strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />,
        <text key={`uax-t-${a.name}`}
          x={x} y={yTop - 0.15}
          fill={COLORS.gridAxis} fontSize={fontSize}
          textAnchor="middle" style={{ fontWeight: 700, pointerEvents: "none" }}>
          {a.name}
        </text>,
      );
    }
  }

  const snapPreview = useMemo(() => {
    if (!canEdit || tool === "select" || !pointer) return null;
    return snapPoint(pointer.x, pointer.y);
  }, [canEdit, tool, pointer, snapPoint]);

  const svgCursor = dragRef.current ? "grabbing" : (tool !== "select" && canEdit ? "crosshair" : "grab");

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Toolbar principal */}
      <div className="px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap text-xs">
        <span className="font-semibold text-[var(--text)] uppercase tracking-wider">Elevación 2D</span>

        <div className="flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5">
          <button
            onClick={() => setCut("X")}
            className={`px-2 py-1 rounded text-[11px] font-medium ${cut === "X" ? "bg-blue-600 text-white" : "text-[var(--text-muted)]"}`}
          >Corte X (mira +Y)</button>
          <button
            onClick={() => setCut("Y")}
            className={`px-2 py-1 rounded text-[11px] font-medium ${cut === "Y" ? "bg-blue-600 text-white" : "text-[var(--text-muted)]"}`}
          >Corte Y (mira +X)</button>
        </div>

        <span className="text-[var(--text-muted)]">Plano en {cut === "X" ? "Y" : "X"}:</span>
        <select
          value={cutValue ?? ""}
          onChange={(e) => setCutValue(Number(e.target.value))}
          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]"
        >
          {planeSuggestions[cut].map((v) => (
            <option key={v} value={v}>{v.toFixed(2)} m</option>
          ))}
        </select>
        <input
          type="number" step="0.1" min={0.1} max={5}
          value={tolerance} onChange={(e) => setTolerance(Math.max(0.1, Number(e.target.value) || 0.75))}
          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] w-16 text-[11px]"
          title="Tolerancia del plano (m)"
        />

        {grid && ((grid.axes_x?.length ?? 0) > 0 || (grid.axes_y?.length ?? 0) > 0) && (
          <button
            onClick={() => setShowGrid(v => !v)}
            className={`text-[10px] px-2 py-1 rounded border ${showGrid ? "bg-blue-600 border-blue-600 text-white" : "text-[var(--text-muted)] border-[var(--border)]"}`}
            title="Ejes del grid ETABS">
            Grid
          </button>
        )}

        <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">
          {framesInCut.length} marcos · {wallsInCut.length} muros · {infillsInCut.length} infills en el plano
        </span>
        <button onClick={resetView} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 rounded border border-[var(--border)]">
          Reset
        </button>
      </div>

      {/* Toolbar de dibujo */}
      {canEdit && (
        <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-2 flex-wrap text-xs">
          <span className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">Herramienta</span>
          <ToolButton active={tool === "select"} onClick={() => setTool("select")} label="Seleccionar" />
          <ToolButton active={tool === "column"} onClick={() => setTool("column")} label="Columna" />
          <ToolButton active={tool === "beam"}   onClick={() => setTool("beam")}   label="Viga" />
          <ToolButton active={tool === "wall"}   onClick={() => setTool("wall")}   label="Muro" />
          <ToolButton active={tool === "infill"} onClick={() => setTool("infill")} label="Infill" />

          {(tool === "column" || tool === "beam") && (
            <>
              <span className="text-[var(--text-muted)] ml-2">Sección:</span>
              <select
                value={defaultSection}
                onChange={(e) => setDefaultSection(e.target.value)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] text-[11px]"
              >
                <option value="">— Sin sección —</option>
                {sections && Object.keys(sections).map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </>
          )}
          {(tool === "wall" || tool === "infill") && (
            <>
              <span className="text-[var(--text-muted)] ml-2">Espesor (m):</span>
              <input
                type="number" step="0.01" min={0.05} max={1.0}
                value={defaultThickness}
                onChange={(e) => setDefaultThickness(Math.max(0.05, Number(e.target.value) || 0.20))}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] w-20 text-[11px]"
              />
            </>
          )}
          {tool === "infill" && (
            <>
              <span className="text-[var(--text-muted)] ml-2">Mampostería:</span>
              <select
                value={defaultMasonry}
                onChange={(e) => setDefaultMasonry(e.target.value)}
                className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] text-[11px]"
              >
                <option value="">— Selecciona material —</option>
                {masonryMaterials && Object.entries(masonryMaterials).map(([id, m]) => (
                  <option key={id} value={id}>{m.name} · fm={m.fm_mpa} MPa</option>
                ))}
              </select>
            </>
          )}
          <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)]">
            {tool === "select" && "Modo selección"}
            {tool !== "select" && `${pending.length}/2 pt`}
            {saving && " · guardando..."}
          </span>
          {pending.length > 0 && (
            <button onClick={() => setPending([])} className="text-[10px] px-2 py-1 rounded border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]">
              Cancelar
            </button>
          )}
        </div>
      )}
      {saveError && (
        <div className="px-4 py-1.5 bg-red-50 border-b border-red-200 text-[11px] text-red-700 font-mono">{saveError}</div>
      )}

      <div className="relative" style={{ height, background: COLORS.bg }}>
        <svg
          ref={svgRef}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onClick={handleClick}
          style={{ width: "100%", height: "100%", cursor: svgCursor }}
        >
          <g transform="scale(1,-1)">
            {gridLines}
            {userAxisLines}
            {storyLines}
            {groundLine}

            {/* Infills primero (fondo) */}
            {infillsInCut.map((inf) => {
              const w = inf.x2 - inf.x1;
              const h = inf.z2 - inf.z1;
              return (
                <g key={`inf-${inf.id}`} pointerEvents={tool === "select" ? "auto" : "none"}>
                  <rect x={inf.x1} y={inf.z1} width={w} height={h}
                    fill={COLORS.infillFill} stroke={COLORS.infill} strokeWidth={0.8}
                    strokeDasharray={inf.opening_ratio > 0 ? "4 2" : undefined}
                    vectorEffect="non-scaling-stroke"
                    onClick={() => tool === "select" && onElementClick?.({ id: inf.id, type: "infill", label: inf.id })}
                    style={{ cursor: tool === "select" && onElementClick ? "pointer" : "default" }} />
                  {/* Puntales cruzados (referencia visual) */}
                  <line x1={inf.x1} y1={inf.z1} x2={inf.x2} y2={inf.z2}
                    stroke={COLORS.strut} strokeWidth={0.6} strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke" opacity={0.7} />
                  <line x1={inf.x2} y1={inf.z1} x2={inf.x1} y2={inf.z2}
                    stroke={COLORS.strut} strokeWidth={0.6} strokeDasharray="2 2"
                    vectorEffect="non-scaling-stroke" opacity={0.7} />
                </g>
              );
            })}

            {/* Muros */}
            {wallsInCut.map((w) => (
              <rect key={`w-${w.id}`} x={w.x1} y={w.z1} width={w.x2 - w.x1} height={w.z2 - w.z1}
                fill={COLORS.wallFill} stroke={COLORS.wall} strokeWidth={1.2}
                vectorEffect="non-scaling-stroke"
                onClick={() => tool === "select" && onElementClick?.({ id: w.id, type: "wall", label: w.pier })}
                style={{ cursor: tool === "select" && onElementClick ? "pointer" : "default", pointerEvents: tool === "select" ? "auto" : "none" }}
              />
            ))}

            {/* Frames */}
            {framesInCut.map((f) => {
              const sec = sections?.[f.section];
              const bw = f.kind === "column" ? (sec?.h_m ?? 0.3) : Math.max(sec?.h_m ?? 0.35, 0.2);
              const dx = f.jx - f.ix; const dz = f.jz - f.iz;
              const len = Math.hypot(dx, dz);
              if (len < 1e-6) return null;
              const ux = dx / len, uz = dz / len;
              const nx = -uz, nz = ux;
              const hw = bw / 2;
              const pts = [
                [f.ix + nx * hw, f.iz + nz * hw],
                [f.jx + nx * hw, f.jz + nz * hw],
                [f.jx - nx * hw, f.jz - nz * hw],
                [f.ix - nx * hw, f.iz - nz * hw],
              ].map((p) => `${p[0]},${p[1]}`).join(" ");
              return (
                <polygon key={`f-${f.id}`} points={pts}
                  fill={f.kind === "column" ? COLORS.columnFill : COLORS.beamFill}
                  stroke={f.kind === "column" ? COLORS.column : COLORS.beam}
                  strokeWidth={1.0} vectorEffect="non-scaling-stroke"
                  onClick={() => tool === "select" && onElementClick?.({ id: f.id, type: f.kind, label: f.id })}
                  style={{ cursor: tool === "select" && onElementClick ? "pointer" : "default", pointerEvents: tool === "select" ? "auto" : "none" }} />
              );
            })}

            {/* Ghost preview */}
            {pending.map((p, i) => (
              <circle key={`p-${i}`} cx={p.x} cy={p.y} r={0.15}
                fill={COLORS.ghost} vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "none" }} />
            ))}
            {pending.length >= 1 && snapPreview && tool !== "select" && (
              <line x1={pending[pending.length - 1].x} y1={pending[pending.length - 1].y}
                x2={snapPreview.x} y2={snapPreview.y}
                stroke={COLORS.ghost} strokeWidth={1.2} strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
            )}
            {snapPreview && canEdit && tool !== "select" && (
              <circle cx={snapPreview.x} cy={snapPreview.y} r={0.25}
                fill="none" stroke={snapPreview.jointId ? COLORS.snap : COLORS.ghost}
                strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "none" }} />
            )}
          </g>
        </svg>

        {/* Leyenda */}
        <div className="absolute bottom-2 left-2 flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur px-3 py-1.5 text-[11px] shadow-sm">
          <LegendChip fill={COLORS.wallFill}    stroke={COLORS.wall}   label="Muro" />
          <LegendChip fill={COLORS.columnFill}  stroke={COLORS.column} label="Columna" />
          <LegendChip fill={COLORS.beamFill}    stroke={COLORS.beam}   label="Viga" />
          <LegendChip fill={COLORS.infillFill}  stroke={COLORS.infill} label="Infill" />
          <span className="text-[var(--text-muted)] ml-2 font-mono">z↑ · plano en {cut === "X" ? "Y" : "X"}={cutValue?.toFixed(2)}m</span>
        </div>
      </div>
    </div>
  );
}

function ToolButton(
  { active, onClick, label }: { active: boolean; onClick: () => void; label: string },
) {
  return (
    <button onClick={onClick}
      className={[
        "px-2.5 py-1 rounded text-[11px] font-semibold transition-colors",
        active
          ? "bg-blue-600 text-white shadow-sm"
          : "bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface)]",
      ].join(" ")}>
      {label}
    </button>
  );
}

function LegendChip({ fill, stroke, label }: { fill: string; stroke: string; label: string }) {
  return (
    <span className="flex items-center gap-1 text-[var(--text-muted)]">
      <span style={{ width: 14, height: 8, background: fill, border: `1px solid ${stroke}`, display: "inline-block", borderRadius: 1 }} />
      {label}
    </span>
  );
}
