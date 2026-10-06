"use client";

/**
 * Building2DPlanView — Vista en planta 2D por piso, SVG puro.
 *
 * Además de renderizar el layout XY del piso, incluye un modo de DIBUJO que
 * permite crear columnas, vigas, muros, losas e infills haciendo clic sobre
 * la planta. Snap a intersecciones de grid (definido por el usuario) y a
 * joints existentes con tolerancia dinámica según el zoom.
 *
 * Los muros consolidados por pier se dibujan con dimensiones REALES
 * amplificadas visualmente para que sean legibles.
 */
import { useMemo, useRef, useState, useCallback, useEffect } from "react";
import type {
  ModelGeometry,
  SectionData,
  GridDefinition,
  MasonryMaterial,
  DrawingTool,
} from "@/lib/structural-types";
import { structuralEditorApi } from "@/lib/structural-api";

interface Props {
  geometry: ModelGeometry;
  initialStory?: string;
  height?: number;
  sections?: Record<string, SectionData>;
  /** Definición de grid del usuario (ejes X/Y). Usado para snap y dibujo. */
  grid?: GridDefinition;
  /** Materiales de mampostería disponibles para infills. */
  masonryMaterials?: Record<string, MasonryMaterial>;
  /** Habilita modo dibujo. Si no viene projectId, solo lectura. */
  projectId?: string;
  /** Callback tras crear/eliminar elementos — la página debe recargar el modelo. */
  onModelChanged?: () => void | Promise<void>;
  onElementClick?: (info: { id: string; type: "slab" | "wall" | "beam" | "column" | "infill"; label: string }) => void;
}

interface HoverInfo { x: number; y: number; label: string; section?: string; extra?: string; }
interface PendingPoint { x: number; y: number; jointId?: string }

const COLORS = {
  slabFill:   "rgba(59, 130, 246, 0.10)",
  slabLine:   "#3b82f6",
  wall:       "#0f766e",
  wallFill:   "rgba(15, 118, 110, 0.75)",
  wallLbl:    "#083f39",
  beam:       "#475569",
  beamFill:   "rgba(100, 116, 139, 0.60)",
  column:     "#b91c1c",
  columnFill: "rgba(220, 38, 38, 0.80)",
  grid:       "rgba(148, 163, 184, 0.20)",
  gridBold:   "rgba(148, 163, 184, 0.45)",
  gridUser:   "rgba(37, 99, 235, 0.35)",
  axisX:      "#dc2626",
  axisY:      "#059669",
  ghost:      "#f59e0b",
  ghostFill:  "rgba(245, 158, 11, 0.30)",
  snap:       "#22c55e",
};

export default function Building2DPlanView({
  geometry,
  initialStory,
  height = 640,
  sections,
  grid,
  masonryMaterials,
  projectId,
  onModelChanged,
  onElementClick,
}: Props) {
  const canEdit = !!projectId;

  const storiesOrdered = useMemo(() => {
    return Object.entries(geometry.stories)
      .map(([name, info]) => ({ name, z: info.elevation_m ?? 0 }))
      .sort((a, b) => a.z - b.z)
      .map((s) => s.name);
  }, [geometry.stories]);

  const defaultStory = initialStory
    ?? storiesOrdered.find((s) => (geometry.stories[s]?.elevation_m ?? 0) > 0)
    ?? storiesOrdered[storiesOrdered.length - 1]
    ?? "";

  const [story, setStory] = useState<string>(defaultStory);
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [showSlabs, setShowSlabs] = useState(true);
  const [showWalls, setShowWalls] = useState(true);
  const [showFrames, setShowFrames] = useState(true);
  const [wallEmphasis, setWallEmphasis] = useState(true);
  const [hover, setHover] = useState<HoverInfo | null>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; startPan: { x: number; y: number }; moved: boolean } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // ── Estado de dibujo ───────────────────────────────────────────────────────
  const [tool, setTool] = useState<DrawingTool>("select");
  const [pending, setPending] = useState<PendingPoint[]>([]);
  const [pointerXY, setPointerXY] = useState<{ x: number; y: number } | null>(null);
  const [defaultSection, setDefaultSection] = useState<string>("");
  const [defaultThickness, setDefaultThickness] = useState(0.20);
  const [defaultMasonry, setDefaultMasonry] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Auto-selecciona sección por defecto cuando cambian las secciones disponibles
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

  // Al cambiar de herramienta, cancela clicks pendientes.
  useEffect(() => {
    setPending([]);
    setSaveError(null);
  }, [tool, story]);

  // ── Filtros ────────────────────────────────────────────────────────────────
  const slabsInStory = useMemo(() =>
    Object.entries(geometry.shells).filter(([, s]) => s.element_type === "slab" && s.story === story),
    [geometry.shells, story],
  );

  const wallsInStory = useMemo(() => {
    interface WallGroup {
      key: string; pier: string; section: string; thickness_m: number;
      shell_ids: string[];
      allXY: { x: number; y: number }[];
    }
    const groups = new Map<string, WallGroup>();
    for (const [shellId, s] of Object.entries(geometry.shells)) {
      if (s.element_type !== "wall") continue;
      if (s.story !== story) continue;
      const key = (s.pier || shellId) + "|" + (s.section || "");
      let g = groups.get(key);
      if (!g) {
        g = {
          key, pier: s.pier || shellId, section: s.section,
          thickness_m: s.thickness_m ?? 0.2, shell_ids: [], allXY: [],
        };
        groups.set(key, g);
      }
      g.shell_ids.push(shellId);
      for (const jl of s.joints) {
        const j = geometry.joints[jl];
        if (!j) continue;
        if (!g.allXY.some((u) => Math.abs(u.x - j.x) < 1e-4 && Math.abs(u.y - j.y) < 1e-4)) {
          g.allXY.push({ x: j.x, y: j.y });
        }
      }
    }
    return [...groups.values()];
  }, [geometry.shells, geometry.joints, story]);

  const framesInStory = useMemo(() =>
    Object.entries(geometry.frames).filter(([, f]) => f.story === story),
    [geometry.frames, story],
  );

  // Joints del piso actual — para snap
  const jointsInStory = useMemo(() => {
    const res: { id: string; x: number; y: number }[] = [];
    const info = geometry.stories[story];
    const zTarget = info?.elevation_m;
    for (const [id, j] of Object.entries(geometry.joints)) {
      if (zTarget !== undefined && Math.abs(j.z - zTarget) > 0.05) continue;
      if (j.story && j.story !== story && zTarget === undefined) continue;
      res.push({ id, x: j.x, y: j.y });
    }
    return res;
  }, [geometry.joints, geometry.stories, story]);

  // ── Bounds del modelo ─────────────────────────────────────────────────────
  const bounds = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const consider = (x: number, y: number) => {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    };
    for (const [, s] of slabsInStory)
      for (const jl of s.joints) { const j = geometry.joints[jl]; if (j) consider(j.x, j.y); }
    for (const g of wallsInStory)
      for (const p of g.allXY) consider(p.x, p.y);
    for (const [, f] of framesInStory) {
      const ji = geometry.joints[f.joint_i]; const jj = geometry.joints[f.joint_j];
      if (ji) consider(ji.x, ji.y); if (jj) consider(jj.x, jj.y);
    }
    // Considera también ejes del grid del usuario
    if (grid) {
      for (const ax of grid.axes_x) consider(ax.coord_m, isFinite(minY) ? minY : ax.coord_m);
      for (const ay of grid.axes_y) consider(isFinite(minX) ? minX : ay.coord_m, ay.coord_m);
    }
    if (!isFinite(minX)) for (const j of Object.values(geometry.joints)) consider(j.x, j.y);
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 10, maxY: 10 };
    return { minX, minY, maxX, maxY };
  }, [slabsInStory, wallsInStory, framesInStory, geometry.joints, grid]);

  const rawW = Math.max(bounds.maxX - bounds.minX, 1);
  const rawH = Math.max(bounds.maxY - bounds.minY, 1);
  const PAD_M = Math.max(rawW, rawH) * 0.10;

  const vbW = (rawW + 2 * PAD_M) / zoom;
  const vbH = (rawH + 2 * PAD_M) / zoom;
  const vbX = bounds.minX - PAD_M + pan.x;
  const vbY = bounds.minY - PAD_M + pan.y;
  const viewBox = `${vbX} ${vbY} ${vbW} ${vbH}`;

  // ── Grid step automático ───────────────────────────────────────────────────
  const gridStep = useMemo(() => {
    const span = Math.max(rawW, rawH);
    if (span >= 40) return 5; if (span >= 20) return 2;
    if (span >= 8) return 1; return 0.5;
  }, [rawW, rawH]);

  // ── Coordenadas mouse → modelo ────────────────────────────────────────────
  const svgToModel = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    if (!svgRef.current) return null;
    const rect = svgRef.current.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    return { x: vbX + px * vbW, y: vbY + py * vbH };
  }, [vbX, vbY, vbW, vbH]);

  // ── Snap: prioridad joint existente > intersección de grid ────────────────
  const snapPoint = useCallback((mx: number, my: number): PendingPoint => {
    const tol = Math.max(rawW, rawH) * 0.015 / zoom;   // ~1.5% del span, ajustado por zoom
    // Joints existentes
    let bestJoint: { id: string; x: number; y: number; d: number } | null = null;
    for (const j of jointsInStory) {
      const d = Math.hypot(j.x - mx, j.y - my);
      if (d < tol && (!bestJoint || d < bestJoint.d)) {
        bestJoint = { id: j.id, x: j.x, y: j.y, d };
      }
    }
    if (bestJoint) return { x: bestJoint.x, y: bestJoint.y, jointId: bestJoint.id };
    // Intersección de grid definido por el usuario
    if (grid && (grid.axes_x.length || grid.axes_y.length)) {
      const nx = nearestOr(mx, grid.axes_x.map((a) => a.coord_m), tol);
      const ny = nearestOr(my, grid.axes_y.map((a) => a.coord_m), tol);
      if (nx !== null || ny !== null) {
        return { x: nx ?? mx, y: ny ?? my };
      }
    }
    return { x: mx, y: my };
  }, [jointsInStory, grid, rawW, rawH, zoom]);

  // ── Zoom/Pan handlers ────────────────────────────────────────────────────
  const onWheel = useCallback((e: React.WheelEvent<SVGSVGElement>) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    setZoom((z) => Math.min(20, Math.max(0.2, z * factor)));
  }, []);
  const onMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    dragRef.current = { x: e.clientX, y: e.clientY, startPan: { ...pan }, moved: false };
  }, [pan]);
  const onMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const pt = svgToModel(e.clientX, e.clientY);
    if (pt) setPointerXY(pt);
    if (!dragRef.current || !svgRef.current) return;
    const dx = e.clientX - dragRef.current.x;
    const dy = e.clientY - dragRef.current.y;
    if (Math.hypot(dx, dy) > 4) dragRef.current.moved = true;
    const rect = svgRef.current.getBoundingClientRect();
    const scaleX = vbW / rect.width;
    const scaleY = vbH / rect.height;
    setPan({
      x: dragRef.current.startPan.x - dx * scaleX,
      y: dragRef.current.startPan.y - dy * scaleY,
    });
  }, [vbW, vbH, svgToModel]);
  const endDrag = useCallback(() => { dragRef.current = null; }, []);
  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);
  useEffect(() => { resetView(); }, [story, resetView]);

  // ── Handler de click en el SVG (drenaje según herramienta) ────────────────
  const handleSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    // Ignora si fue un arrastre real (no un click puntual)
    if (dragRef.current?.moved) return;
    if (!canEdit || tool === "select") return;
    const pt = svgToModel(e.clientX, e.clientY);
    if (!pt) return;
    const sp = snapPoint(pt.x, pt.y);
    setPending((prev) => [...prev, sp]);
  }, [tool, canEdit, svgToModel, snapPoint]);

  // ── Ejecuta la acción cuando pending alcanza el conteo objetivo ───────────
  useEffect(() => {
    if (!canEdit || !projectId) return;
    if (saving) return;
    (async () => {
      if (tool === "column" && pending.length >= 1) {
        await createColumnAt(pending[0]);
        setPending([]);
      } else if (tool === "beam" && pending.length >= 2) {
        await createFrameSpan(pending[0], pending[1], "beam");
        setPending([]);
      } else if (tool === "wall" && pending.length >= 2) {
        await createWallSpan(pending[0], pending[1]);
        setPending([]);
      } else if (tool === "infill" && pending.length >= 2) {
        await createInfillFromBay(pending[0], pending[1]);
        setPending([]);
      }
    })();
    // slab: se cierra explícitamente con doble-click, no aquí.
  }, [pending, tool, canEdit, projectId, saving]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Doble-click cierra polígono para losa
  const handleSvgDoubleClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!canEdit || tool !== "slab" || pending.length < 3) return;
    e.preventDefault();
    (async () => {
      await createSlab(pending);
      setPending([]);
    })();
  }, [canEdit, tool, pending]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── Acciones de guardado ─────────────────────────────────────────────────
  const ensureJoint = useCallback(async (p: PendingPoint, zForce?: number): Promise<string> => {
    if (p.jointId) return p.jointId;
    if (!projectId) throw new Error("Sin projectId");
    const z = zForce ?? (geometry.stories[story]?.elevation_m ?? 0);
    // Genera id único
    let id = `J-${Math.round(p.x * 100)}-${Math.round(p.y * 100)}-${Math.round(z * 100)}`;
    let n = 1;
    while (geometry.joints[id]) { id = `J-${Math.round(p.x * 100)}-${Math.round(p.y * 100)}-${Math.round(z * 100)}-${n++}`; }
    await structuralEditorApi.createJoint(projectId, {
      id, x: p.x, y: p.y, z, story,
      is_restrained: Math.abs(z) < 1e-3,   // z=0 → base restringida
      restraints: Math.abs(z) < 1e-3 ? [1,1,1,1,1,1] : null,
    });
    return id;
  }, [projectId, geometry.stories, geometry.joints, story]);

  async function createColumnAt(p: PendingPoint) {
    if (!projectId) return;
    if (!defaultSection) { setSaveError("Selecciona una sección primero"); return; }
    setSaving(true); setSaveError(null);
    try {
      const zTop = geometry.stories[story]?.elevation_m ?? 0;
      const idxOrdered = storiesOrdered.indexOf(story);
      const belowStory = idxOrdered > 0 ? storiesOrdered[idxOrdered - 1] : story;
      const zBase = geometry.stories[belowStory]?.elevation_m ?? Math.max(0, zTop - 3);
      const jTop = await ensureJoint(p, zTop);
      const jBot = await ensureJoint(p, zBase);
      const cid = `C-${Date.now().toString(36)}`;
      await structuralEditorApi.createFrame(projectId, {
        id: cid, joint_i: jBot, joint_j: jTop,
        section: defaultSection, element_type: "column", story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createFrameSpan(a: PendingPoint, b: PendingPoint, kind: "beam") {
    if (!projectId) return;
    if (!defaultSection) { setSaveError("Selecciona una sección primero"); return; }
    setSaving(true); setSaveError(null);
    try {
      const ji = await ensureJoint(a);
      const jj = await ensureJoint(b);
      const fid = `${kind === "beam" ? "V" : "F"}-${Date.now().toString(36)}`;
      await structuralEditorApi.createFrame(projectId, {
        id: fid, joint_i: ji, joint_j: jj,
        section: defaultSection, element_type: kind, story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createWallSpan(a: PendingPoint, b: PendingPoint) {
    if (!projectId) return;
    setSaving(true); setSaveError(null);
    try {
      const zTop = geometry.stories[story]?.elevation_m ?? 0;
      const idxOrdered = storiesOrdered.indexOf(story);
      const belowStory = idxOrdered > 0 ? storiesOrdered[idxOrdered - 1] : story;
      const zBase = geometry.stories[belowStory]?.elevation_m ?? Math.max(0, zTop - 3);
      const j1 = await ensureJoint(a, zBase);   // base izq
      const j2 = await ensureJoint(b, zBase);   // base der
      const j3 = await ensureJoint(b, zTop);    // top der
      const j4 = await ensureJoint(a, zTop);    // top izq
      const pier = `M-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      await structuralEditorApi.createShell(projectId, {
        id: pier,
        joints: [j1, j2, j3, j4],
        section: "",
        element_type: "wall",
        thickness_m: defaultThickness,
        pier,
        story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createSlab(points: PendingPoint[]) {
    if (!projectId) return;
    setSaving(true); setSaveError(null);
    try {
      const jids: string[] = [];
      for (const p of points) jids.push(await ensureJoint(p));
      const sid = `L-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      await structuralEditorApi.createShell(projectId, {
        id: sid,
        joints: jids,
        section: "",
        element_type: "slab",
        thickness_m: defaultThickness,
        story,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function createInfillFromBay(a: PendingPoint, b: PendingPoint) {
    if (!projectId) return;
    if (!defaultMasonry) { setSaveError("Crea un material de mampostería primero"); return; }
    setSaving(true); setSaveError(null);
    try {
      // Snap de cada clic a la columna más cercana del story actual.
      // Una columna está representada por su joint tope (joint_j) en el plano XY.
      const colsHere: { fid: string; x: number; y: number }[] = [];
      for (const [fid, fr] of Object.entries(geometry.frames ?? {})) {
        if ((fr.element_type ?? "").toLowerCase() !== "column") continue;
        if ((fr.story ?? "") !== story) continue;
        const jTop = geometry.joints?.[fr.joint_j];
        if (!jTop) continue;
        colsHere.push({ fid, x: jTop.x, y: jTop.y });
      }
      if (colsHere.length < 2) {
        setSaveError(`Se necesitan al menos 2 columnas en el story '${story}'.`);
        return;
      }
      const nearest = (p: PendingPoint) =>
        colsHere.reduce((best, c) => {
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          return d < best.d ? { fid: c.fid, d } : best;
        }, { fid: "", d: Infinity });
      const nA = nearest(a); const nB = nearest(b);
      // Tolerancia: el clic debe caer a < 1.5 m de la columna (snap razonable).
      if (nA.d > 1.5 || nB.d > 1.5) {
        setSaveError("Clickea cerca de dos columnas (snap < 1.5 m).");
        return;
      }
      if (!nA.fid || !nB.fid || nA.fid === nB.fid) {
        setSaveError("Selecciona 2 columnas distintas del vano.");
        return;
      }
      const iid = `INF-${Date.now().toString(36).slice(-5).toUpperCase()}`;
      await structuralEditorApi.createInfill(projectId, {
        id: iid,
        column_i_fid: nA.fid,
        column_j_fid: nB.fid,
        story,
        thickness_m: defaultThickness,
        masonry_material_id: defaultMasonry,
        opening_ratio: 0.0,
        width_ratio: 0.25,
      });
      await onModelChanged?.();
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  // ── Helpers geométricos ───────────────────────────────────────────────────
  const orientedRectPoints = (
    ax: number, ay: number, bx: number, by: number, widthLat: number,
  ): string => {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      const s = widthLat / 2;
      return `${ax - s},${ay - s} ${ax + s},${ay - s} ${ax + s},${ay + s} ${ax - s},${ay + s}`;
    }
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const hw = widthLat / 2;
    return [
      [ax + nx * hw, ay + ny * hw],
      [bx + nx * hw, by + ny * hw],
      [bx - nx * hw, by - ny * hw],
      [ax - nx * hw, ay - ny * hw],
    ].map((p) => `${p[0]},${p[1]}`).join(" ");
  };

  const twEmphasized = (tw: number) => {
    if (!wallEmphasis) return Math.max(tw || 0.2, 0.05);
    const factor = Math.max(rawW, rawH) / 60;
    return Math.max(tw || 0.2, 0.05, factor);
  };

  // ── Renderers ─────────────────────────────────────────────────────────────
  const renderSlab = (id: string, joints: string[], section: string) => {
    const pts = joints
      .map((jl) => geometry.joints[jl]).filter(Boolean)
      .map((j) => `${j.x},${j.y}`).join(" ");
    if (!pts) return null;
    return (
      <polygon key={`slab-${id}`} points={pts}
        fill={COLORS.slabFill} stroke={COLORS.slabLine} strokeWidth={1.2}
        strokeLinejoin="round" vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: "Losa" })}
        onMouseLeave={() => setHover(null)}
        onClick={() => tool === "select" && onElementClick?.({ id, type: "slab", label: id })}
        style={{ cursor: onElementClick && tool === "select" ? "pointer" : "default", pointerEvents: tool === "select" ? "auto" : "none" }}
      />
    );
  };

  const renderWallGroup = (g: {
    key: string; pier: string; section: string; thickness_m: number;
    shell_ids: string[]; allXY: { x: number; y: number }[];
  }) => {
    if (g.allXY.length < 2) return null;
    let a = g.allXY[0], b = g.allXY[1], maxD = 0;
    for (let i = 0; i < g.allXY.length; i++)
      for (let j = i + 1; j < g.allXY.length; j++) {
        const d = (g.allXY[i].x - g.allXY[j].x) ** 2 + (g.allXY[i].y - g.allXY[j].y) ** 2;
        if (d > maxD) { maxD = d; a = g.allXY[i]; b = g.allXY[j]; }
      }
    const lw = Math.hypot(b.x - a.x, b.y - a.y);
    const twReal = g.thickness_m || 0.2;
    const twDraw = twEmphasized(twReal);
    const points = orientedRectPoints(a.x, a.y, b.x, b.y, twDraw);
    const firstId = g.shell_ids[0] ?? g.pier;
    return (
      <polygon key={`wall-${g.key}`} points={points}
        fill={COLORS.wallFill} stroke={COLORS.wall} strokeWidth={1.5}
        strokeLinejoin="miter" vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({
          x: e.clientX, y: e.clientY, label: g.pier, section: g.section,
          extra: `Muro · lw=${lw.toFixed(2)}m tw=${twReal.toFixed(3)}m · ${g.shell_ids.length} sub-paneles`,
        })}
        onMouseLeave={() => setHover(null)}
        onClick={() => tool === "select" && onElementClick?.({ id: firstId, type: "wall", label: g.pier })}
        style={{ cursor: onElementClick && tool === "select" ? "pointer" : "default", pointerEvents: tool === "select" ? "auto" : "none" }}
      />
    );
  };

  const renderColumn = (id: string, jx: number, jy: number, section: string) => {
    const sec = sections?.[section];
    const h = sec?.h_m ?? 0.3;
    const b = sec?.b_m ?? 0.3;
    const halfH = h / 2, halfB = b / 2;
    const points =
      `${jx - halfH},${jy - halfB} ${jx + halfH},${jy - halfB} ` +
      `${jx + halfH},${jy + halfB} ${jx - halfH},${jy + halfB}`;
    return (
      <polygon key={`col-${id}`} points={points}
        fill={COLORS.columnFill} stroke={COLORS.column} strokeWidth={1.2}
        vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: `Columna · h=${h.toFixed(2)}m b=${b.toFixed(2)}m` })}
        onMouseLeave={() => setHover(null)}
        onClick={() => tool === "select" && onElementClick?.({ id, type: "column", label: id })}
        style={{ cursor: onElementClick && tool === "select" ? "pointer" : "default", pointerEvents: tool === "select" ? "auto" : "none" }}
      />
    );
  };

  const renderBeam = (id: string, ax: number, ay: number, bx: number, by: number, section: string) => {
    const sec = sections?.[section];
    const bWidth = sec?.b_m ?? 0.25;
    const length = Math.hypot(bx - ax, by - ay);
    const points = orientedRectPoints(ax, ay, bx, by, Math.max(bWidth, 0.08));
    return (
      <polygon key={`beam-${id}`} points={points}
        fill={COLORS.beamFill} stroke={COLORS.beam} strokeWidth={0.9}
        strokeLinejoin="miter" vectorEffect="non-scaling-stroke"
        onMouseEnter={(e) => setHover({ x: e.clientX, y: e.clientY, label: id, section, extra: `Viga · L=${length.toFixed(2)}m b=${bWidth.toFixed(2)}m` })}
        onMouseLeave={() => setHover(null)}
        onClick={() => tool === "select" && onElementClick?.({ id, type: "beam", label: id })}
        style={{ cursor: onElementClick && tool === "select" ? "pointer" : "default", pointerEvents: tool === "select" ? "auto" : "none" }}
      />
    );
  };

  // ── Grid + ejes ───────────────────────────────────────────────────────────
  const gridLines: React.ReactElement[] = [];
  if (showGrid) {
    const gxStart = Math.floor(vbX / gridStep) * gridStep;
    const gxEnd   = Math.ceil((vbX + vbW) / gridStep) * gridStep;
    const gyStart = Math.floor(vbY / gridStep) * gridStep;
    const gyEnd   = Math.ceil((vbY + vbH) / gridStep) * gridStep;
    for (let x = gxStart; x <= gxEnd + 1e-9; x += gridStep) {
      const bold = Math.abs(x) < 1e-6;
      gridLines.push(
        <line key={`gx-${x.toFixed(3)}`} x1={x} y1={vbY} x2={x} y2={vbY + vbH}
          stroke={bold ? COLORS.axisX : COLORS.grid} strokeWidth={bold ? 1.5 : 0.7}
          vectorEffect="non-scaling-stroke" />
      );
    }
    for (let y = gyStart; y <= gyEnd + 1e-9; y += gridStep) {
      const bold = Math.abs(y) < 1e-6;
      gridLines.push(
        <line key={`gy-${y.toFixed(3)}`} x1={vbX} y1={y} x2={vbX + vbW} y2={y}
          stroke={bold ? COLORS.axisY : COLORS.grid} strokeWidth={bold ? 1.5 : 0.7}
          vectorEffect="non-scaling-stroke" />
      );
    }
  }

  // Ejes del usuario (grid definido en /model/grid)
  const userGridLines: React.ReactElement[] = [];
  if (showGrid && grid) {
    for (const ax of grid.axes_x) {
      userGridLines.push(
        <line key={`ugx-${ax.name}`} x1={ax.coord_m} y1={vbY} x2={ax.coord_m} y2={vbY + vbH}
          stroke={COLORS.gridUser} strokeWidth={1.2} strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke" />
      );
      userGridLines.push(
        <text key={`ugxl-${ax.name}`} x={ax.coord_m} y={vbY + 0.8}
          fill={COLORS.gridUser} fontSize={Math.max(0.35, rawH / 90)}
          textAnchor="middle" style={{ fontWeight: 600, pointerEvents: "none" }}>{ax.name}</text>,
      );
    }
    for (const ay of grid.axes_y) {
      userGridLines.push(
        <line key={`ugy-${ay.name}`} x1={vbX} y1={ay.coord_m} x2={vbX + vbW} y2={ay.coord_m}
          stroke={COLORS.gridUser} strokeWidth={1.2} strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke" />
      );
      userGridLines.push(
        <text key={`ugyl-${ay.name}`} x={vbX + 0.5} y={ay.coord_m}
          fill={COLORS.gridUser} fontSize={Math.max(0.35, rawH / 90)}
          dominantBaseline="middle" style={{ fontWeight: 600, pointerEvents: "none" }}>{ay.name}</text>,
      );
    }
  }

  const wallLabels = useMemo(() => {
    if (!showLabels) return [];
    return wallsInStory.map((g) => {
      if (g.allXY.length === 0) return null;
      const cx = g.allXY.reduce((a, p) => a + p.x, 0) / g.allXY.length;
      const cy = g.allXY.reduce((a, p) => a + p.y, 0) / g.allXY.length;
      return { pier: g.pier, cx, cy };
    }).filter(Boolean) as { pier: string; cx: number; cy: number }[];
  }, [wallsInStory, showLabels]);

  const counts = {
    slabs: slabsInStory.length,
    walls: wallsInStory.length,
    subPanels: wallsInStory.reduce((a, g) => a + g.shell_ids.length, 0),
    frames: framesInStory.length,
    columns: framesInStory.filter(([, f]) => f.element_type === "column").length,
    beams: framesInStory.filter(([, f]) => f.element_type === "beam").length,
  };

  const labelFontSize = Math.max(0.25, rawH / 100);

  // ── Snap preview del pointer ──────────────────────────────────────────────
  const snapPreview = useMemo(() => {
    if (!canEdit || tool === "select" || !pointerXY) return null;
    return snapPoint(pointerXY.x, pointerXY.y);
  }, [canEdit, tool, pointerXY, snapPoint]);

  const svgCursor = dragRef.current ? "grabbing" : (tool !== "select" && canEdit ? "crosshair" : "grab");

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden">
      {/* Toolbar principal */}
      <div className="px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)] flex items-center gap-3 flex-wrap text-xs">
        <span className="font-semibold text-[var(--text)] uppercase tracking-wider">Planta 2D</span>
        <select
          value={story}
          onChange={(e) => setStory(e.target.value)}
          className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)]"
        >
          {storiesOrdered.map((s) => (
            <option key={s} value={s}>{s} · z={(geometry.stories[s]?.elevation_m ?? 0).toFixed(2)} m</option>
          ))}
        </select>

        <div className="flex items-center gap-1 ml-2">
          <ToggleChip active={showSlabs}  onClick={() => setShowSlabs((v) => !v)}  label={`Losas (${counts.slabs})`} />
          <ToggleChip active={showWalls}  onClick={() => setShowWalls((v) => !v)}  label={`Muros (${counts.walls})`} />
          <ToggleChip active={showFrames} onClick={() => setShowFrames((v) => !v)} label={`Marcos (${counts.frames})`} />
          <ToggleChip active={showGrid}   onClick={() => setShowGrid((v) => !v)}   label="Grid+Ejes" />
          <ToggleChip active={showLabels} onClick={() => setShowLabels((v) => !v)} label="Etiquetas" />
          <ToggleChip active={wallEmphasis} onClick={() => setWallEmphasis((v) => !v)} label="Amplif. muros" />
        </div>

        <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">
          {rawW.toFixed(1)}×{rawH.toFixed(1)} m · zoom {zoom.toFixed(2)}× · {counts.subPanels} sub-paneles → {counts.walls} muros
        </span>
        <button onClick={resetView} className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] px-2 py-1 rounded border border-[var(--border)]">
          Reset
        </button>
      </div>

      {/* Toolbar de DIBUJO */}
      {canEdit && (
        <div className="px-4 py-2 border-b border-[var(--border)] bg-[var(--surface)] flex items-center gap-2 flex-wrap text-xs">
          <span className="text-[var(--text-muted)] uppercase tracking-wider text-[10px]">Herramienta</span>
          <ToolButton active={tool === "select"} onClick={() => setTool("select")} label="Seleccionar" hotkey="S" />
          <ToolButton active={tool === "column"} onClick={() => setTool("column")} label="Columna" hotkey="C" />
          <ToolButton active={tool === "beam"}   onClick={() => setTool("beam")}   label="Viga"    hotkey="V" />
          <ToolButton active={tool === "wall"}   onClick={() => setTool("wall")}   label="Muro"    hotkey="M" />
          <ToolButton active={tool === "slab"}   onClick={() => setTool("slab")}   label="Losa"    hotkey="L" />
          <ToolButton active={tool === "infill"} onClick={() => setTool("infill")} label="Infill"  hotkey="I" />

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
          {(tool === "wall" || tool === "slab" || tool === "infill") && (
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
            {tool === "column" && `Clic para colocar columna · z=${(geometry.stories[story]?.elevation_m ?? 0).toFixed(2)}m`}
            {tool === "beam"   && `Clic 2 puntos para viga · ${pending.length}/2`}
            {tool === "wall"   && `Clic 2 esquinas del muro · ${pending.length}/2`}
            {tool === "slab"   && `Clic N puntos + doble-click para cerrar · ${pending.length} pt`}
            {tool === "infill" && `Clic 2 columnas del vano · ${pending.length}/2`}
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
        <div className="px-4 py-1.5 bg-red-50 border-b border-red-200 text-[11px] text-red-700 font-mono">
          {saveError}
        </div>
      )}

      <div className="relative bg-[var(--surface)]" style={{ height }}>
        <svg
          ref={svgRef}
          viewBox={viewBox}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onClick={handleSvgClick}
          onDoubleClick={handleSvgDoubleClick}
          style={{ width: "100%", height: "100%", cursor: svgCursor, background: "var(--surface)" }}
        >
          {gridLines}
          {userGridLines}

          {/* Origen (0,0) */}
          <circle cx={0} cy={0} r={0.2}
            fill="none" stroke="#f59e0b" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />

          {showSlabs && slabsInStory.map(([id, s]) => renderSlab(id, s.joints, s.section))}
          {showFrames && framesInStory.map(([id, f]) => {
            const ji = geometry.joints[f.joint_i]; const jj = geometry.joints[f.joint_j];
            if (!ji || !jj) return null;
            if (f.element_type === "column") return renderColumn(id, ji.x, ji.y, f.section);
            return renderBeam(id, ji.x, ji.y, jj.x, jj.y, f.section);
          })}
          {showWalls && wallsInStory.map((g) => renderWallGroup(g))}

          {showLabels && wallLabels.map(({ pier, cx, cy }) => (
            <text key={`lbl-${pier}`} x={cx} y={cy}
              fill={COLORS.wallLbl} fontSize={labelFontSize}
              textAnchor="middle" dominantBaseline="middle"
              style={{ pointerEvents: "none", userSelect: "none", fontWeight: 600 }}
            >
              {pier}
            </text>
          ))}

          {/* Ghost de puntos pendientes + previa de la línea/polígono */}
          {pending.map((p, i) => (
            <circle key={`pend-${i}`} cx={p.x} cy={p.y} r={0.15}
              fill={COLORS.ghost} stroke={COLORS.ghost} strokeWidth={1.5}
              vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }} />
          ))}
          {pending.length >= 1 && snapPreview && (tool === "beam" || tool === "wall" || tool === "infill") && (
            <line
              x1={pending[pending.length - 1].x} y1={pending[pending.length - 1].y}
              x2={snapPreview.x} y2={snapPreview.y}
              stroke={COLORS.ghost} strokeWidth={1.2} strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }}
            />
          )}
          {pending.length >= 1 && tool === "slab" && snapPreview && (
            <>
              <line
                x1={pending[pending.length - 1].x} y1={pending[pending.length - 1].y}
                x2={snapPreview.x} y2={snapPreview.y}
                stroke={COLORS.ghost} strokeWidth={1.2} strokeDasharray="6 4"
                vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none" }}
              />
              {pending.length >= 2 && (
                <line
                  x1={pending[0].x} y1={pending[0].y}
                  x2={snapPreview.x} y2={snapPreview.y}
                  stroke={COLORS.ghost} strokeWidth={0.8} strokeDasharray="3 3"
                  vectorEffect="non-scaling-stroke" style={{ pointerEvents: "none", opacity: 0.5 }}
                />
              )}
            </>
          )}

          {/* Snap crosshair */}
          {snapPreview && canEdit && tool !== "select" && (
            <>
              <circle cx={snapPreview.x} cy={snapPreview.y} r={0.25}
                fill="none" stroke={snapPreview.jointId ? COLORS.snap : COLORS.ghost}
                strokeWidth={1.5} vectorEffect="non-scaling-stroke"
                style={{ pointerEvents: "none" }} />
              {snapPreview.jointId && (
                <text x={snapPreview.x} y={snapPreview.y - 0.45}
                  fill={COLORS.snap} fontSize={Math.max(0.3, rawH / 110)}
                  textAnchor="middle" style={{ pointerEvents: "none", fontWeight: 600 }}
                >{snapPreview.jointId}</text>
              )}
            </>
          )}
        </svg>

        {/* Tooltip */}
        {hover && (
          <div
            className="pointer-events-none rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-[11px] shadow-lg"
            style={{ left: hover.x + 12, top: hover.y + 12, position: "fixed" }}
          >
            <div className="font-semibold text-[var(--text)]">{hover.label}</div>
            {hover.extra && <div className="text-[var(--text-muted)]">{hover.extra}</div>}
            {hover.section && <div className="text-[var(--text-muted)] font-mono">{hover.section}</div>}
          </div>
        )}

        {/* Leyenda */}
        <div className="absolute bottom-2 left-2 flex items-center gap-3 rounded-md border border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur px-3 py-1.5 text-[11px] shadow-sm">
          <LegendChip fill={COLORS.slabFill}   stroke={COLORS.slabLine} label="Losa" />
          <LegendChip fill={COLORS.wallFill}   stroke={COLORS.wall}     label="Muro" />
          <LegendChip fill={COLORS.columnFill} stroke={COLORS.column}   label="Columna" />
          <LegendChip fill={COLORS.beamFill}   stroke={COLORS.beam}     label="Viga" />
          <span className="text-[var(--text-muted)] ml-2 font-mono">grid {gridStep} m</span>
          <span className="text-[var(--axisX,#dc2626)] font-mono">— +X</span>
          <span className="text-[var(--axisY,#059669)] font-mono">| +Y</span>
        </div>
      </div>
    </div>
  );
}

// ── Helpers puros ────────────────────────────────────────────────────────────

function nearestOr(v: number, arr: number[], tol: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const c of arr) {
    const d = Math.abs(c - v);
    if (d < tol && d < bestD) { best = c; bestD = d; }
  }
  return best;
}

function ToggleChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button onClick={onClick}
      className={[
        "px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
        active
          ? "bg-[var(--accent)] text-white"
          : "bg-[var(--surface)] text-[var(--text-muted)] border border-[var(--border)] hover:text-[var(--text)]",
      ].join(" ")}>
      {label}
    </button>
  );
}

function ToolButton(
  { active, onClick, label, hotkey }: { active: boolean; onClick: () => void; label: string; hotkey?: string },
) {
  return (
    <button onClick={onClick}
      title={hotkey ? `Tecla: ${hotkey}` : undefined}
      className={[
        "px-2.5 py-1 rounded text-[11px] font-semibold transition-colors flex items-center gap-1.5",
        active
          ? "bg-blue-600 text-white shadow-sm"
          : "bg-[var(--surface-2)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface)]",
      ].join(" ")}>
      {label}
      {hotkey && <span className={active ? "text-blue-100 text-[9px]" : "text-[var(--text-muted)] text-[9px]"}>[{hotkey}]</span>}
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
