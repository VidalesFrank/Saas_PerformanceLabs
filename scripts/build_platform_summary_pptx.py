"""
Genera una presentación PowerPoint con el resumen técnico de la plataforma
PerformanceLabs — módulos de evaluación forense post-sismo.

Uso:
  .venv/Scripts/python.exe scripts/build_platform_summary_pptx.py \
      --out PerformanceLabs_Resumen_Evaluacion.pptx
"""
from __future__ import annotations

import argparse
from pathlib import Path

from pptx import Presentation
from pptx.util import Inches, Pt, Emu
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR


# ─────────────────────────────────────────────────────────────────────────────
# Paleta corporativa PerformanceLabs
# ─────────────────────────────────────────────────────────────────────────────
C_PRIMARY   = RGBColor(0x0F, 0x24, 0x3E)   # azul noche
C_ACCENT    = RGBColor(0x75, 0xB7, 0x2A)   # verde PerformanceLabs
C_MUTED     = RGBColor(0x64, 0x74, 0x8B)   # slate
C_TEXT      = RGBColor(0x1E, 0x29, 0x3B)
C_BG_SOFT   = RGBColor(0xF8, 0xFA, 0xFC)
C_BORDER    = RGBColor(0xE2, 0xE8, 0xF0)
C_WARN      = RGBColor(0xF9, 0x73, 0x16)
C_DANGER    = RGBColor(0xDC, 0x26, 0x26)
C_OK        = RGBColor(0x16, 0xA3, 0x4A)

# Paleta de estados de daño (idéntica a la UI)
STATE_COLORS = {
    "fluencia":    RGBColor(0x06, 0xB6, 0xD4),
    "spalling":    RGBColor(0xF5, 0x9E, 0x0B),
    "core_crush":  RGBColor(0xDC, 0x26, 0x26),
    "pandeo":      RGBColor(0xBE, 0x18, 0x5D),
    "fractura":    RGBColor(0x7F, 0x1D, 0x1D),
}


def _slide_bg(slide, color=C_BG_SOFT) -> None:
    """Fondo plano del slide."""
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def _add_textbox(slide, left: float, top: float, width: float, height: float,
                 text: str, *, size: int = 14, bold: bool = False,
                 color=C_TEXT, align=PP_ALIGN.LEFT, font: str = "Calibri",
                 anchor=MSO_ANCHOR.TOP) -> None:
    tb = slide.shapes.add_textbox(
        Inches(left), Inches(top), Inches(width), Inches(height),
    )
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    for i, line in enumerate(text.split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        run = p.add_run()
        run.text = line
        run.font.name = font
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = color


def _add_bullets(slide, left: float, top: float, width: float, height: float,
                 bullets: list[str], *, size: int = 14,
                 color=C_TEXT, bullet_color=C_ACCENT) -> None:
    tb = slide.shapes.add_textbox(
        Inches(left), Inches(top), Inches(width), Inches(height),
    )
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = Emu(0)
    tf.margin_top = tf.margin_bottom = Emu(0)
    for i, line in enumerate(bullets):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.space_after = Pt(6)
        # Bullet
        run_b = p.add_run()
        run_b.text = "■ "
        run_b.font.name = "Calibri"
        run_b.font.size = Pt(size)
        run_b.font.color.rgb = bullet_color
        run_b.font.bold = True
        # Texto
        run_t = p.add_run()
        run_t.text = line
        run_t.font.name = "Calibri"
        run_t.font.size = Pt(size)
        run_t.font.color.rgb = color


def _add_rect(slide, left: float, top: float, width: float, height: float,
              fill_color=C_PRIMARY, line_color=None) -> None:
    shp = slide.shapes.add_shape(
        MSO_SHAPE.RECTANGLE,
        Inches(left), Inches(top), Inches(width), Inches(height),
    )
    shp.fill.solid()
    shp.fill.fore_color.rgb = fill_color
    if line_color is None:
        shp.line.fill.background()
    else:
        shp.line.color.rgb = line_color
    shp.shadow.inherit = False
    return shp


def _add_header_bar(slide, title: str, subtitle: str = "") -> None:
    _add_rect(slide, 0, 0, 13.333, 0.9, fill_color=C_PRIMARY)
    _add_textbox(slide, 0.5, 0.15, 10, 0.4, title,
                 size=22, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
    if subtitle:
        _add_textbox(slide, 0.5, 0.52, 10, 0.3, subtitle,
                     size=11, color=RGBColor(0xCB, 0xD5, 0xE1))
    # Acento verde
    _add_rect(slide, 0, 0.9, 13.333, 0.05, fill_color=C_ACCENT)


def _add_footer(slide, page_num: int, total: int) -> None:
    _add_rect(slide, 0, 7.3, 13.333, 0.2, fill_color=C_BORDER)
    _add_textbox(slide, 0.5, 7.1, 10, 0.3,
                 "PerformanceLabs · Plataforma de evaluación estructural",
                 size=9, color=C_MUTED)
    _add_textbox(slide, 12.3, 7.1, 1.0, 0.3,
                 f"{page_num:02d} / {total:02d}",
                 size=9, color=C_MUTED, align=PP_ALIGN.RIGHT)


# ─────────────────────────────────────────────────────────────────────────────
# Builders de slides
# ─────────────────────────────────────────────────────────────────────────────

def _build_title(prs: Presentation) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])   # blank
    _slide_bg(slide, C_PRIMARY)

    # Banda verde superior
    _add_rect(slide, 0, 2.2, 13.333, 0.08, fill_color=C_ACCENT)

    _add_textbox(slide, 0.8, 2.5, 12, 1.2,
                 "PerformanceLabs",
                 size=56, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
    _add_textbox(slide, 0.8, 3.7, 12, 0.6,
                 "Plataforma de evaluación estructural no lineal",
                 size=24, color=C_ACCENT)
    _add_textbox(slide, 0.8, 4.4, 12, 0.5,
                 "Resumen técnico de capacidades y trazabilidad normativa",
                 size=16, color=RGBColor(0xCB, 0xD5, 0xE1))

    _add_textbox(slide, 0.8, 6.3, 12, 0.4,
                 "Frank Vidales  ·  Ingeniería estructural + Software",
                 size=12, color=RGBColor(0x94, 0xA3, 0xB8))
    _add_textbox(slide, 0.8, 6.65, 12, 0.4,
                 "Octubre 2026",
                 size=12, color=C_ACCENT)


def _build_agenda(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "Agenda", "Contenido del resumen")

    agenda = [
        "1.  Arquitectura del modelo numérico",
        "2.  Refuerzo: diseño automático y as-built manual",
        "3.  Umbrales de daño y orígenes normativos",
        "4.  Cómo medimos las deformaciones unitarias",
        "5.  Detección de eventos locales (Bloque B)",
        "6.  Jerarquía de colapso: local vs global",
        "7.  Plan de reparación por elemento (Bloque C)",
        "8.  Trazabilidad normativa consolidada",
        "9.  Confiabilidad y validación de resultados",
        "10. Limitaciones conocidas (transparencia)",
    ]
    _add_bullets(slide, 1.0, 1.3, 11, 5.5, agenda, size=18)
    _add_footer(slide, pnum, total)


def _build_section_header(prs: Presentation, num: str, title: str,
                          subtitle: str, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide, C_PRIMARY)
    _add_rect(slide, 0, 3.0, 13.333, 0.05, fill_color=C_ACCENT)
    _add_textbox(slide, 0.8, 2.0, 2, 1.0, num,
                 size=72, bold=True, color=C_ACCENT)
    _add_textbox(slide, 2.5, 2.3, 10, 0.9, title,
                 size=36, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF))
    _add_textbox(slide, 2.5, 3.3, 10, 0.6, subtitle,
                 size=16, color=RGBColor(0xCB, 0xD5, 0xE1))
    _add_footer(slide, pnum, total)


def _build_model_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "1. Arquitectura del modelo numérico",
                    "forceBeamColumn con fibras · HingeRadau · MinMax wrappers")

    # Columna izquierda — elementos finitos
    _add_textbox(slide, 0.5, 1.2, 6, 0.4,
                 "Elementos finitos (pórticos)",
                 size=16, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 0.5, 1.65, 6, 2.5, [
        "forceBeamColumn (basado en fuerzas, no desplazamientos)",
        "HingeRadau: 2 Lobatto en extremos (L_p) + 2 Gauss central",
        "L_p = h/2 (Priestley) o medida en campo",
        "PDelta en columnas (efectos P-Δ) · Linear en vigas",
        "Rigidez torsional explícita: uniaxialElastic -torsion",
    ], size=12)

    # Columna derecha — materiales
    _add_textbox(slide, 7, 1.2, 6, 0.4,
                 "Materiales con falla física (MinMax wrappers)",
                 size=16, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 7, 1.65, 6, 3.0, [
        "Núcleo confinado: Concrete02 Mander, σ=0 en −2.5·εcu",
        "Recubrimiento: Concrete02 (f'c, 0.002, 0.006), σ=0 en −2.5·εcu",
        "Refuerzo: Steel02 Menegotto-Pinto, σ=0 en ±1.2·εsu",
        "Buffer generoso: permite redistribución local sin romper",
        "   convergencia global (residual 20% actúa antes de crush)",
    ], size=12)

    # Sección Fiber visual
    _add_textbox(slide, 0.5, 4.4, 12.3, 0.4,
                 "Sección Fiber rectangular — composición",
                 size=14, bold=True, color=C_PRIMARY)
    _add_rect(slide, 0.5, 4.9, 2.2, 1.8, fill_color=RGBColor(0xFE, 0xF3, 0xC7))
    _add_rect(slide, 0.85, 5.15, 1.5, 1.3, fill_color=RGBColor(0xBB, 0xF7, 0xD0))
    for (dx, dy) in [(0.1, 0.1), (1.95, 0.1), (0.1, 1.55), (1.95, 1.55),
                      (0.1, 0.825), (1.95, 0.825), (1.025, 0.1), (1.025, 1.55)]:
        _add_rect(slide, 0.5 + dx, 4.9 + dy, 0.15, 0.15,
                  fill_color=RGBColor(0x1E, 0x3A, 0x8A))
    _add_textbox(slide, 2.9, 5.1, 10, 0.35,
                 "■ Núcleo confinado (Mander) · 8×8 fibras Concrete02 con εcu real",
                 size=11, color=C_TEXT)
    _add_textbox(slide, 2.9, 5.45, 10, 0.35,
                 "■ Recubrimiento no confinado · εcu = 0.006",
                 size=11, color=C_TEXT)
    _add_textbox(slide, 2.9, 5.80, 10, 0.35,
                 "■ Barras longitudinales · fibras puntuales Steel02",
                 size=11, color=C_TEXT)
    _add_textbox(slide, 2.9, 6.15, 10, 0.35,
                 "■ MinMax wrapper → σ=0 definitivo al superar umbral material",
                 size=11, color=C_TEXT)

    # Infills
    _add_rect(slide, 0.5, 6.8, 12.3, 0.4,
              fill_color=RGBColor(0xFE, 0xF3, 0xC7),
              line_color=C_WARN)
    _add_textbox(slide, 0.7, 6.86, 12, 0.3,
                 "Infills: ConcreteCM + corotTruss (Al-Chaar). Participan en NLTHA; "
                 "daño detallado solo en pushover (pendiente post-process NLTHA).",
                 size=10, color=C_TEXT)

    _add_footer(slide, pnum, total)


def _build_reinforcement_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "2. Refuerzo: diseño automático y as-built manual",
                    "Jerarquía first-match-wins · Mander activo")

    # Jerarquía
    _add_textbox(slide, 0.5, 1.2, 12, 0.4,
                 "Jerarquía de prioridad",
                 size=16, bold=True, color=C_PRIMARY)

    box_w = 2.6
    labels = ["user_override", "section_pattern", "col_detail", "defaults"]
    sublabels = ["manual UI", "as-built UI", "diseño NSR-10", "fallback"]
    colors = [C_DANGER, C_WARN, C_ACCENT, C_MUTED]
    for i, (lbl, sub, col) in enumerate(zip(labels, sublabels, colors)):
        x = 0.5 + i * (box_w + 0.1)
        _add_rect(slide, x, 1.7, box_w, 0.8, fill_color=col)
        _add_textbox(slide, x, 1.78, box_w, 0.35, lbl,
                     size=13, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF),
                     align=PP_ALIGN.CENTER)
        _add_textbox(slide, x, 2.13, box_w, 0.3, sub,
                     size=10, color=RGBColor(0xE2, 0xE8, 0xF0),
                     align=PP_ALIGN.CENTER)
        if i < 3:
            arrow_x = x + box_w + 0.01
            _add_textbox(slide, arrow_x, 1.85, 0.1, 0.4, "→",
                         size=18, bold=True, color=C_PRIMARY)

    # Modo automático
    _add_textbox(slide, 0.5, 2.9, 6, 0.4,
                 "Diseño automático (NSR-10 C.21)",
                 size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 0.5, 3.3, 6, 2.5, [
        "Flexión: Mu ≥ φ·Mn (NSR-10 C.9.3)",
        "Cortante: Vn ACI 318-19 §22.5 + Sezen-Moehle 2004",
        "Cuantías: ρ_g ∈ [1%, 6%] (C.10, C.21.4)",
        "Confinamiento: s ≤ min(h/4, 6·db, 150 mm) para DMO",
        "Resultado: design_columns_detail.json + beam_design",
    ], size=12)

    # Modo manual
    _add_textbox(slide, 7, 2.9, 6, 0.4,
                 "As-built manual (UI Definir → Secciones)",
                 size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 7, 3.3, 6, 2.5, [
        "Granular: 4 esquinas con db_corner + 4 caras independientes",
        "Ejemplo: 4·#6 esquinas + 8·#5 caras (edificios reales)",
        "Validador NSR-10 soft (no bloqueante)",
        "Persistido como section_pattern aplicado globalmente",
        "Si se midió L_p en campo → prioridad absoluta",
    ], size=12)

    # Mander
    _add_textbox(slide, 0.5, 5.9, 12, 0.4,
                 "Confinamiento Mander 1988 (calculado desde refuerzo real)",
                 size=14, bold=True, color=C_PRIMARY)
    _add_textbox(slide, 0.5, 6.3, 12, 0.9,
                 "fcc / f'c = 1 + K  (factor efectivo)   ·   εcc = εco · (1 + 5·K)   ·   "
                 "εcu = εco · (1 + f(ρ_sh, fy_tie, εs_u_tie))\n"
                 "K depende de ρ_sh (cuantía volumétrica estribos), geometría "
                 "n_legs_b/n_legs_h y hooks 90° vs 135°.",
                 size=11, color=C_TEXT)

    _add_footer(slide, pnum, total)


def _build_thresholds_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "3. Umbrales de daño — orígenes normativos",
                    "Deformación de fibra + rotación plástica")

    # Tabla de umbrales fibra
    _add_textbox(slide, 0.5, 1.1, 12, 0.4,
                 "Umbrales de deformación de fibra (Bloque B)",
                 size=14, bold=True, color=C_PRIMARY)

    headers = ["Umbral", "Valor", "%", "Fuente normativa"]
    rows = [
        ("εsy (fluencia acero)",       "fy/Es = 420/200,000",   "0.21 %", "NSR-10 C.3.5.3.2 + C.8.5.2"),
        ("εcu_cover (spalling)",       "0.006",                  "0.60 %", "Mander 1988, ACI 318 §22.2"),
        ("εcu_core (aplastamiento)",   "f(ρ_sh) Mander",         "1.5–2.0 %", "Mander-Priestley-Park 1988"),
        ("εs_bk (pandeo refuerzo)",    "(55 − 2.3·s/db) scaled", "2.5 % / 1.5 %", "Dhakal-Maekawa 2002"),
        ("εsu (fractura acero)",       "0.10",                   "10 %",   "ASTM A615 Grado 60"),
    ]
    _draw_table(slide, 0.5, 1.55, [3.0, 2.5, 1.5, 5.0], headers, rows, header_color=C_PRIMARY)

    # Rotación plástica
    _add_textbox(slide, 0.5, 4.3, 12, 0.4,
                 "Rotación plástica (ASCE 41-17 Tabla 10-8, columnas DMO)",
                 size=14, bold=True, color=C_PRIMARY)
    hdr = ["Nivel", "θ_p (rad)", "Interpretación"]
    rows2 = [
        ("IO", "0.005", "Immediate Occupancy — operativo tras sismo"),
        ("LS", "0.012", "Life Safety — seguridad de vida garantizada"),
        ("CP", "0.020", "Collapse Prevention — cerca del colapso local"),
        ("Post-CP", "1.5 · θ_CP = 0.030", "Rótula fuera de los criterios ASCE (LOCAL)"),
    ]
    _draw_table(slide, 0.5, 4.75, [1.5, 2.5, 8], hdr, rows2, header_color=C_PRIMARY)

    # Fase 7 — por elemento
    _add_rect(slide, 0.5, 6.5, 12.3, 0.7,
              fill_color=RGBColor(0xDE, 0xF5, 0xE9),
              line_color=C_ACCENT)
    _add_textbox(slide, 0.7, 6.57, 12, 0.3,
                 "Fase 7 — Capacidades calculadas por elemento (no tabla genérica):",
                 size=11, bold=True, color=C_PRIMARY)
    _add_textbox(slide, 0.7, 6.87, 12, 0.3,
                 "Mander + Haselton 2008 (PEER 2007/03) + EC8-3 Anexo A + Paulay-Priestley · "
                 "Benchmarks PEER verificados",
                 size=10, color=C_TEXT)

    _add_footer(slide, pnum, total)


def _build_measurement_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "4. Cómo medimos las deformaciones",
                    "sectionDeformation → fibra via plane sections")

    _add_textbox(slide, 0.5, 1.1, 12, 0.4,
                 "Captura por paso (código OpenSees)",
                 size=14, bold=True, color=C_PRIMARY)
    _add_rect(slide, 0.5, 1.5, 12.3, 1.0,
              fill_color=RGBColor(0x1E, 0x29, 0x3B))
    _add_textbox(slide, 0.7, 1.6, 12, 0.3,
                 "d = ops.sectionDeformation(ele_tag, ip)",
                 size=14, bold=True, color=C_ACCENT, font="Consolas")
    _add_textbox(slide, 0.7, 1.95, 12, 0.3,
                 "# ip = 1 (extremo i)  o  ip = 6 (extremo j)  — HingeRadau",
                 size=12, color=RGBColor(0x94, 0xA3, 0xB8), font="Consolas")
    _add_textbox(slide, 0.7, 2.2, 12, 0.3,
                 "# d = [ ε_axial, κ_z, κ_y, torsion_rate ]",
                 size=12, color=RGBColor(0x94, 0xA3, 0xB8), font="Consolas")

    # Fórmula
    _add_textbox(slide, 0.5, 2.75, 12, 0.4,
                 "Deformación en cualquier fibra (convención OpenSees FiberSection3d)",
                 size=14, bold=True, color=C_PRIMARY)
    _add_rect(slide, 0.5, 3.15, 12.3, 0.9,
              fill_color=RGBColor(0xF1, 0xF5, 0xF9),
              line_color=C_BORDER)
    _add_textbox(slide, 0.5, 3.3, 12.3, 0.6,
                 "ε(y, z) = ε_axial + κ_z · y − κ_y · z",
                 size=24, bold=True, color=C_PRIMARY,
                 align=PP_ALIGN.CENTER, font="Cambria Math")
    _add_textbox(slide, 0.5, 3.75, 12.3, 0.3,
                 "Para una barra en (y_bar, z_bar) → strain directo",
                 size=11, color=C_MUTED, align=PP_ALIGN.CENTER)

    # Estrategia de captura
    _add_textbox(slide, 0.5, 4.35, 12, 0.4,
                 "Estrategia de captura por análisis",
                 size=14, bold=True, color=C_PRIMARY)
    hdr = ["Análisis", "Frecuencia", "Volumen típico"]
    rows = [
        ("Pushover",  "Cada paso convergido (stride=1)",  "~400 pasos × 200 el × 8 floats ≈ 2.5 MB"),
        ("NLTHA",     "Cada 10 pasos (0.05 s)",            "~20 k muestras × 200 el × 8 floats ≈ 50 MB"),
    ]
    _draw_table(slide, 0.5, 4.80, [2, 5, 5.3], hdr, rows, header_color=C_PRIMARY)

    _add_rect(slide, 0.5, 6.5, 12.3, 0.7,
              fill_color=RGBColor(0xDE, 0xF5, 0xE9),
              line_color=C_ACCENT)
    _add_textbox(slide, 0.7, 6.57, 12, 0.3,
                 "Validez: forceBeamColumn con sección fiber mantiene plane sections remain plane.",
                 size=11, bold=True, color=C_PRIMARY)
    _add_textbox(slide, 0.7, 6.87, 12, 0.3,
                 "La strain computada en (y_bar, z_bar) ES exactamente la strain de la barra en OpenSees.",
                 size=10, color=C_TEXT)

    _add_footer(slide, pnum, total)


def _build_events_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "5. Detección de eventos locales",
                    "Primera aparición por elemento · 5 tipos")

    # 5 eventos
    events = [
        ("◇ Fluencia",       "max |ε_barra| > 0.21 %",      "cyan",     STATE_COLORS["fluencia"],   1),
        ("■ Spalling cover", "ε_c cover < −0.60 %",          "ámbar",    STATE_COLORS["spalling"],   2),
        ("◆ Core crush",     "ε_c core < −εcu_mander",       "rojo",     STATE_COLORS["core_crush"], 3),
        ("⬣ Pandeo",         "ε_barra < −ε_bk(s/db)",         "magenta",  STATE_COLORS["pandeo"],     4),
        ("✕ Fractura",       "ε_barra > +10 %",              "rojo-dark",STATE_COLORS["fractura"],   5),
    ]
    y0 = 1.3
    for i, (label, crit, _col_name, rgb, sev) in enumerate(events):
        y = y0 + i * 0.7
        _add_rect(slide, 0.5, y, 0.6, 0.5, fill_color=rgb)
        _add_textbox(slide, 0.5, y + 0.05, 0.6, 0.4, str(sev),
                     size=22, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF),
                     align=PP_ALIGN.CENTER)
        _add_textbox(slide, 1.3, y + 0.07, 3.5, 0.4, label,
                     size=15, bold=True, color=C_TEXT)
        _add_textbox(slide, 5.0, y + 0.1, 8, 0.35, "Criterio: " + crit,
                     size=12, color=C_MUTED)

    # Pipeline
    _add_textbox(slide, 0.5, 5.0, 12, 0.4,
                 "Pipeline por paso",
                 size=14, bold=True, color=C_PRIMARY)
    _add_rect(slide, 0.5, 5.4, 12.3, 1.6,
              fill_color=RGBColor(0xF1, 0xF5, 0xF9),
              line_color=C_BORDER)
    _add_textbox(slide, 0.7, 5.5, 12, 0.3,
                 "sectionDeformation(ele, ip)   →   ε_fibra(y, z)   →   compara vs umbral",
                 size=12, bold=True, color=C_PRIMARY, font="Consolas")
    _add_textbox(slide, 0.7, 5.85, 12, 0.3,
                 "¿primera vez que cruza? ",
                 size=12, color=C_TEXT, font="Consolas")
    _add_textbox(slide, 3.5, 5.85, 12, 0.3,
                 "SÍ  → persiste Event {fid, step, time_s, type, location, strain}",
                 size=12, bold=True, color=C_OK, font="Consolas")
    _add_textbox(slide, 3.5, 6.15, 12, 0.3,
                 "NO  → ignora (ya está capturado)",
                 size=12, color=C_MUTED, font="Consolas")
    _add_textbox(slide, 0.7, 6.55, 12, 0.4,
                 "Resultado: lista única de eventos por elemento, cada uno con su "
                 "tiempo de primera aparición → marcadores en curvas Vb-δ (pushover) "
                 "y Vb(t) / d(t) (NLTHA).",
                 size=11, color=C_TEXT)

    _add_footer(slide, pnum, total)


def _build_collapse_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "6. Jerarquía de colapso",
                    "Local ≠ Global · 3 criterios independientes")

    # Tabla
    hdr = ["Nivel", "Criterio", "Significado"]
    rows = [
        ("Rótula Post-CP (local)",
         "θ_p ≥ 1.5 · θ_CP en un extremo",
         "ASCE 41 por rotación — 1 extremo pasó.  NO colapso del edificio."),
        ("Mecanismo de piso",
         "≥ 80 % cols del piso en Post-CP",
         "Piso blando → colapso lateral GLOBAL."),
        ("Caída de Vb",
         "Vb / Vb_pico < 0.80 post-pico",
         "Softening severo (ATC-40 / FEMA 356)."),
        ("Veredicto edificio",
         "Mecanismo  O  caída Vb",
         "Si alguno dispara → colapso global probable."),
    ]
    _draw_table(slide, 0.5, 1.25, [3.5, 4.0, 5.3], hdr, rows,
                header_color=C_PRIMARY, row_height=0.75)

    # Explicación clarificadora
    _add_rect(slide, 0.5, 4.9, 12.3, 2.0,
              fill_color=RGBColor(0xFE, 0xF3, 0xC7),
              line_color=C_WARN)
    _add_textbox(slide, 0.7, 5.0, 12, 0.4,
                 "Por qué puede haber rótulas Post-CP sin colapso del edificio",
                 size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 0.7, 5.4, 12, 1.5, [
        "Edificios son redundantes: una columna fuera no causa colapso global",
        "MinMax wrapper permite al solver atravesar fallos locales (ε > εcu con residual 20%)",
        "Pushover es desplazamiento-controlado: sigue hasta drift objetivo aunque elementos pierdan capacidad",
        "Colapso vertical NO modelado: pushover es solo lateral",
    ], size=11)

    _add_footer(slide, pnum, total)


def _build_repair_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "7. Plan de reparación por elemento",
                    "Clasificador first-match-wins · FEMA + ACI + NSR-10")

    hdr = ["Severidad", "Dispara con...", "Acción", "Referencias"]
    rows = [
        ("Reemplazo",
         "Fractura refuerzo o rótula collapse",
         "Demolición + reconstrucción; verificar nudos adyacentes",
         "FEMA 547 §6, ACI 369.1 §4.5.5, NSR-10 C.21.1.4"),
        ("Refuerzo",
         "Pandeo o core crush o rótula CP",
         "Encamisado FRP/concreto + inyección epóxica",
         "FEMA 547 §5.3, ACI 369.1 §5, NSR-10 C.21.11"),
        ("Reparación",
         "Spalling cover o rótula LS",
         "Resane + anti-corrosión + inyección fisuras >0.3mm",
         "FEMA 306 §C.3, ACI 546R-14 §4"),
        ("Inspección",
         "Fluencia o rótula IO",
         "Grietómetro, documentar fisuras >0.3mm, monitoreo",
         "FEMA 306 §3, ACI 224.1R"),
        ("Sin intervención",
         "Ningún evento ni rótula activa",
         "—",
         "—"),
    ]
    # Colores de severidad en primera columna
    sev_colors = [C_DANGER, C_WARN,
                  RGBColor(0xEA, 0xB3, 0x08),
                  RGBColor(0x06, 0xB6, 0xD4),
                  C_MUTED]
    _draw_table(slide, 0.3, 1.3, [1.8, 3.0, 4.5, 3.5], hdr, rows,
                header_color=C_PRIMARY, row_colors_first_col=sev_colors,
                row_height=0.95, font_size=10)

    _add_textbox(slide, 0.3, 6.9, 12.7, 0.3,
                 "Export CSV disponible · Priorización automática por severidad",
                 size=10, color=C_MUTED, align=PP_ALIGN.CENTER)
    _add_footer(slide, pnum, total)


def _build_normative_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "8. Trazabilidad normativa",
                    "Códigos + investigación citados")

    # 3 columnas: Colombia / Internacional / Investigación
    _add_textbox(slide, 0.3, 1.2, 4.3, 0.4,
                 "Códigos colombianos", size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 0.3, 1.65, 4.3, 3.0, [
        "NSR-10 Título A — Diseño sismo-resistente",
        "NSR-10 Título B — Cargas (B.2.4 combos)",
        "NSR-10 Título C — Concreto reforzado",
        "   C.3 materiales · C.9 φ · C.10 cuantías",
        "   C.11 cortante · C.14 muros · C.21 sismo",
        "NSR-10 A.6 — Derivas (A.6.4.2.1 límites)",
    ], size=10)

    _add_textbox(slide, 4.7, 1.2, 4.5, 0.4,
                 "Códigos internacionales", size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 4.7, 1.65, 4.5, 3.0, [
        "ACI 318-19 · ACI 369.1-17 · ACI 546R-14",
        "ACI 440.2R-17 (FRP) · ACI 224.1R (grietas)",
        "ASCE 41-17 Tabla 10-8",
        "FEMA 356 · FEMA 547 · FEMA 306",
        "ATC-40 (CSM)",
        "Eurocódigo 8 Parte 3 (EC8-3) Anexo A",
    ], size=10)

    _add_textbox(slide, 9.3, 1.2, 3.8, 0.4,
                 "Investigación citada", size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 9.3, 1.65, 3.8, 3.0, [
        "Mander-Priestley-Park 1988",
        "Priestley-Seible-Calvi 1996",
        "Paulay-Priestley 1992",
        "Dhakal-Maekawa 2002",
        "Elwood 2004",
        "Haselton 2008 / PEER 2007/03",
        "Sezen-Moehle 2004",
    ], size=10)

    # Benchmarks
    _add_textbox(slide, 0.3, 5.0, 12, 0.4,
                 "Benchmarks de validación numérica",
                 size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 0.3, 5.4, 12, 2, [
        "Haselton 2008 verificado paso a paso contra PEER 2007/03",
        "Columnas test: Saatcioglu-Ozcebe B1 · Sezen 2CLH18 · Lynn 3SLH18",
        "Sección NSR-10: columna 400×400 con 8-#8 → P≈5424 kN, M≈379 kN·m",
        "Modal: calibrado contra ETABS (×1.3 por secciones fisuradas NSR-10)",
    ], size=12)

    _add_footer(slide, pnum, total)


def _build_reliability_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "9. Confiabilidad y validación",
                    "Tests · Benchmarks · Software comercial")

    # KPIs grandes
    kpis = [
        ("355", "tests pasando", "engine Python", C_OK),
        ("103", "tests nuevos", "fases 1-8 (Bloques A/B/C)", C_ACCENT),
        ("4", "benchmarks PEER", "verificados numéricamente", C_PRIMARY),
        ("Mander", "aplicado real", "no K=1.3 genérico", C_WARN),
    ]
    for i, (val, lbl, sub, col) in enumerate(kpis):
        x = 0.5 + i * 3.15
        _add_rect(slide, x, 1.3, 3.0, 1.8,
                  fill_color=RGBColor(0xFF, 0xFF, 0xFF),
                  line_color=col)
        _add_textbox(slide, x, 1.45, 3.0, 0.9, val,
                     size=48, bold=True, color=col,
                     align=PP_ALIGN.CENTER)
        _add_textbox(slide, x, 2.3, 3.0, 0.35, lbl,
                     size=14, bold=True, color=C_TEXT,
                     align=PP_ALIGN.CENTER)
        _add_textbox(slide, x, 2.65, 3.0, 0.35, sub,
                     size=11, color=C_MUTED,
                     align=PP_ALIGN.CENTER)

    _add_textbox(slide, 0.5, 3.4, 12, 0.4,
                 "Metodologías implementadas",
                 size=14, bold=True, color=C_PRIMARY)
    _add_bullets(slide, 0.5, 3.85, 12, 3, [
        "ElementData → failure_mode → M-φ analítico → rotation_capacity",
        "Mander (confinamiento) → Haselton 2008 (IMK) → EC8-3 (θum) → Priestley (mecánico)",
        "Elwood 2004: reducción si cortante domina (Vp > 0.7·Vn)",
        "Fragilidades DS1-DS4 lognormal (β=0.40 / 0.60)",
        "Field observations CSV (L_p medida, hooks, empalmes) → override prioritario",
    ], size=12)

    _add_footer(slide, pnum, total)


def _build_limitations_slide(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide)
    _add_header_bar(slide, "10. Limitaciones conocidas",
                    "Transparencia · Gaps técnicos declarados")

    limitations = [
        ("Pandeo del refuerzo",
         "Criterio por threshold de deformación (Dhakal-Maekawa simplificado), "
         "no modelo mecánico de inestabilidad con soporte lateral explícito."),
        ("Carga vertical en NLTHA",
         "No se evalúa pérdida de capacidad gravitacional — solo lateral. "
         "No detecta colapso vertical por progresivo."),
        ("Infills en NLTHA",
         "Participan en la respuesta dinámica (rigidez + resistencia + damping) "
         "pero el daño por panel NO se post-procesa aún. Gap pendiente."),
        ("Interacción con nudos",
         "Nudos modelados como rígidos (sin degradación por falla de nudo). "
         "ASCE 41-17 §10.4 no implementado."),
        ("Interacción suelo-estructura",
         "Base rígida — no se modela SSI. Para edificios en suelo blando el "
         "amortiguamiento efectivo real sería mayor."),
    ]

    y = 1.3
    for i, (title, desc) in enumerate(limitations):
        _add_rect(slide, 0.5, y, 0.1, 1.0, fill_color=C_WARN)
        _add_textbox(slide, 0.75, y + 0.05, 12, 0.35, title,
                     size=13, bold=True, color=C_PRIMARY)
        _add_textbox(slide, 0.75, y + 0.45, 12, 0.6, desc,
                     size=11, color=C_TEXT)
        y += 1.1

    _add_footer(slide, pnum, total)


def _build_closing(prs: Presentation, pnum: int, total: int) -> None:
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    _slide_bg(slide, C_PRIMARY)
    _add_rect(slide, 0, 3.0, 13.333, 0.05, fill_color=C_ACCENT)
    _add_textbox(slide, 0.5, 2.3, 12, 0.9,
                 "Gracias",
                 size=56, bold=True, color=RGBColor(0xFF, 0xFF, 0xFF),
                 align=PP_ALIGN.CENTER)
    _add_textbox(slide, 0.5, 3.3, 12, 0.6,
                 "PerformanceLabs · Plataforma de evaluación estructural no lineal",
                 size=18, color=C_ACCENT,
                 align=PP_ALIGN.CENTER)
    _add_textbox(slide, 0.5, 4.1, 12, 0.4,
                 "Frank Vidales — Ingeniero estructural + Software",
                 size=14, color=RGBColor(0xCB, 0xD5, 0xE1),
                 align=PP_ALIGN.CENTER)
    _add_footer(slide, pnum, total)


# ─────────────────────────────────────────────────────────────────────────────
# Tabla helper
# ─────────────────────────────────────────────────────────────────────────────

def _draw_table(slide, x: float, y: float, col_widths: list[float],
                headers: list[str], rows: list[tuple],
                header_color=C_PRIMARY, row_height: float = 0.5,
                font_size: int = 11,
                row_colors_first_col: list | None = None) -> None:
    """Dibuja una tabla simple con cajas rectangulares (más control que
    `shapes.add_table` para estilizar bordes y colores por celda)."""
    # Header
    cx = x
    for i, h in enumerate(headers):
        w = col_widths[i]
        _add_rect(slide, cx, y, w, 0.4, fill_color=header_color)
        _add_textbox(slide, cx + 0.05, y + 0.03, w - 0.1, 0.35, h,
                     size=font_size, bold=True,
                     color=RGBColor(0xFF, 0xFF, 0xFF),
                     anchor=MSO_ANCHOR.MIDDLE)
        cx += w

    # Rows
    yr = y + 0.4
    for r_idx, row in enumerate(rows):
        row_bg = C_BG_SOFT if r_idx % 2 == 0 else RGBColor(0xFF, 0xFF, 0xFF)
        cx = x
        for c_idx, cell in enumerate(row):
            w = col_widths[c_idx]
            if row_colors_first_col and c_idx == 0:
                fill = row_colors_first_col[r_idx] if r_idx < len(row_colors_first_col) else row_bg
                text_color = RGBColor(0xFF, 0xFF, 0xFF)
            else:
                fill = row_bg
                text_color = C_TEXT
            _add_rect(slide, cx, yr, w, row_height,
                      fill_color=fill, line_color=C_BORDER)
            _add_textbox(slide, cx + 0.08, yr + 0.08, w - 0.16, row_height - 0.16,
                         str(cell),
                         size=font_size, color=text_color,
                         bold=(c_idx == 0 and row_colors_first_col is not None),
                         anchor=MSO_ANCHOR.MIDDLE)
            cx += w
        yr += row_height


# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

def build_pptx(out_path: str) -> None:
    prs = Presentation()
    # 16:9 widescreen
    prs.slide_width  = Inches(13.333)
    prs.slide_height = Inches(7.5)

    # Secuencia (orden de los slides)
    sequence = [
        ("title",            None),
        ("agenda",           None),
        ("section",          ("1", "Modelo", "forceBeamColumn con fibras · HingeRadau")),
        ("model",            None),
        ("section",          ("2", "Refuerzo", "Diseño automático y as-built manual")),
        ("reinforcement",    None),
        ("section",          ("3", "Umbrales", "Deformación + rotación · origen normativo")),
        ("thresholds",       None),
        ("section",          ("4", "Medición", "Cómo obtenemos las deformaciones")),
        ("measurement",      None),
        ("section",          ("5", "Eventos", "Fluencia · Spalling · Crush · Pandeo · Fractura")),
        ("events",           None),
        ("section",          ("6", "Colapso", "Jerarquía local vs global")),
        ("collapse",         None),
        ("section",          ("7", "Reparación", "Clasificador por severidad")),
        ("repair",           None),
        ("section",          ("8", "Normativa", "Trazabilidad consolidada")),
        ("normative",        None),
        ("section",          ("9", "Confiabilidad", "Tests · Benchmarks · Validación")),
        ("reliability",      None),
        ("section",          ("10", "Limitaciones", "Transparencia técnica")),
        ("limitations",      None),
        ("closing",          None),
    ]
    total = len(sequence)

    builders = {
        "title":         lambda p, t: _build_title(prs),
        "agenda":        lambda p, t: _build_agenda(prs, p, t),
        "model":         lambda p, t: _build_model_slide(prs, p, t),
        "reinforcement": lambda p, t: _build_reinforcement_slide(prs, p, t),
        "thresholds":    lambda p, t: _build_thresholds_slide(prs, p, t),
        "measurement":   lambda p, t: _build_measurement_slide(prs, p, t),
        "events":        lambda p, t: _build_events_slide(prs, p, t),
        "collapse":      lambda p, t: _build_collapse_slide(prs, p, t),
        "repair":        lambda p, t: _build_repair_slide(prs, p, t),
        "normative":     lambda p, t: _build_normative_slide(prs, p, t),
        "reliability":   lambda p, t: _build_reliability_slide(prs, p, t),
        "limitations":   lambda p, t: _build_limitations_slide(prs, p, t),
        "closing":       lambda p, t: _build_closing(prs, p, t),
    }

    for idx, (kind, args) in enumerate(sequence, start=1):
        if kind == "section":
            _build_section_header(prs, args[0], args[1], args[2], idx, total)
        else:
            builders[kind](idx, total)

    prs.save(out_path)
    print(f"OK: Generado {out_path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="PerformanceLabs_Resumen_Evaluacion.pptx")
    args = ap.parse_args()
    build_pptx(args.out)
