"""
WallOpsGenerator — generates OpenSeesPy commands from a WallAnalyticalModel.

The preview shown in the UI is produced by the SAME generator used during
analysis, guaranteeing Preview == Real Analysis Model (point 25 of spec).

Node and element tags are resolved via the NodeTagRegistry and ElementTagRegistry
passed in at call time. If not provided, sequential integers starting at 1 are used.
"""
from __future__ import annotations

from typing import Any

from .analytical_model import (
    WallAnalyticalModel,
    MVLEM3DModel,
    SFIMVLEM3DModel,
    ESFIMVLEM3DModel,
    WallFormulation,
)
from .material_registry import MaterialRegistry
from .rc_panel_material import (
    RCPanelMaterial,
    ConcreteMaterialDef,
    SteelMaterialDef,
    FSAMParams,
)


class WallOpsGenerator:
    """
    Generates OpenSeesPy script lines for a wall analytical model.

    Usage:
        gen = WallOpsGenerator(registry, node_tag_map, element_tag_map)
        lines = gen.generate(wall_model)
        preview_text = gen.preview_text(wall_model)
    """

    def __init__(
        self,
        registry:        MaterialRegistry | None = None,
        node_tag_map:    dict[str, int] | None = None,
        element_tag_map: dict[str, int] | None = None,
        concrete_props:  dict[str, dict] | None = None,
        steel_props:     dict[str, dict] | None = None,
    ):
        self.registry        = registry or MaterialRegistry()
        self.node_tag_map    = node_tag_map or {}
        self.element_tag_map = element_tag_map or {}
        self.concrete_props  = concrete_props or {}
        self.steel_props     = steel_props or {}
        self._ele_counter    = max(self.element_tag_map.values(), default=0) + 1

    def _node_tag(self, node_id: str) -> int:
        return self.node_tag_map.get(node_id, int(node_id) if node_id.isdigit() else 0)

    def _ele_tag(self, wall_key: str) -> int:
        if wall_key not in self.element_tag_map:
            self.element_tag_map[wall_key] = self._ele_counter
            self._ele_counter += 1
        return self.element_tag_map[wall_key]

    def _make_rc_panel(self, mf_dict: dict, model: WallAnalyticalModel) -> RCPanelMaterial:
        """Build an RCPanelMaterial from a macrofiber dict using project material definitions."""
        c_name  = mf_dict.get("concrete_name", "")
        sv_name = mf_dict.get("steel_v_name", "")
        sh_name = mf_dict.get("steel_h_name", "")
        confined = mf_dict.get("region", "web") in ("boundary_left", "boundary_right")

        c_props  = self.concrete_props.get(c_name, {})
        sv_props = self.steel_props.get(sv_name, {})
        sh_props = self.steel_props.get(sh_name, {})

        return RCPanelMaterial(
            concrete_def=ConcreteMaterialDef(
                name=c_name,
                fpc_mpa=c_props.get("fpc_mpa", 28.0),
                confined=confined,
            ),
            steel_v_def=SteelMaterialDef(
                name=sv_name,
                fy_mpa=sv_props.get("fy_mpa", 420.0),
                E_mpa=sv_props.get("E_mpa", 200_000.0),
            ),
            steel_h_def=SteelMaterialDef(
                name=sh_name,
                fy_mpa=sh_props.get("fy_mpa", 420.0),
                E_mpa=sh_props.get("E_mpa", 200_000.0),
            ),
            rho_vertical=mf_dict.get("rho_vertical", 0.0),
            rho_horizontal=mf_dict.get("rho_horizontal", 0.0),
        )

    # ── Material command lines ────────────────────────────────────────────────

    def _material_lines(self, model: WallAnalyticalModel) -> list[str]:
        lines: list[str] = []
        reg = self.registry
        mat_data = reg.to_dict()

        added_tags: set[int] = set()

        def _conc_line(entry: dict) -> str:
            return (
                f"ops.uniaxialMaterial('Concrete02', {entry['tag']}, "
                f"-{entry['fpc_mpa']}, -{entry['eps_c0']}, "
                f"-{entry['fpcu_mpa']}, -{entry['eps_cu']}, "
                f"0.1, {entry['ft_mpa']}, {entry['Ets']})"
            )

        def _steel_line(entry: dict) -> str:
            return (
                f"ops.uniaxialMaterial('Steel02', {entry['tag']}, "
                f"{entry['fy_mpa']}, {entry['E_mpa']}, {entry['b']}, "
                f"{entry['R0']}, {entry['cR1']}, {entry['cR2']})"
            )

        def _fsam_line(entry: dict) -> str:
            return (
                f"ops.nDMaterial('FSAM', {entry['tag']}, "
                f"{entry['rho_vertical']:.6f}, "
                f"{entry['tag_steel_h']}, {entry['tag_steel_v']}, "
                f"{entry['tag_concrete']}, {entry['nu']}, {entry['alfadow']})"
            )

        # Emit in tag order so OpenSees sees deps before FSAM
        all_entries = (
            [(e["tag"], "concrete", e) for e in mat_data["concrete_materials"]] +
            [(e["tag"], "steel",    e) for e in mat_data["steel_materials"]] +
            [(e["tag"], "fsam",     e) for e in mat_data["fsam_materials"]]
        )
        all_entries.sort(key=lambda x: x[0])

        for tag, mtype, entry in all_entries:
            if tag in added_tags:
                continue
            added_tags.add(tag)
            if mtype == "concrete":
                lines.append(_conc_line(entry))
            elif mtype == "steel":
                lines.append(_steel_line(entry))
            elif mtype == "fsam":
                lines.append(_fsam_line(entry))

        return lines

    # ── Element command line ──────────────────────────────────────────────────

    def _element_line(
        self,
        model: WallAnalyticalModel,
        ele_tag: int,
        ni: int, nj: int, nk: int, nl: int,
        mat_tags: list[int],
    ) -> str:
        m = len(model.macrofibers)
        thicks = [round(mf.thickness_m, 4) for mf in model.macrofibers]
        widths = [round(mf.width_m, 4) for mf in model.macrofibers]

        if model.formulation == WallFormulation.MVLEM_3D:
            assert isinstance(model, MVLEM3DModel)
            rhos = [round(mf.rho_vertical, 6) for mf in model.macrofibers]
            # MVLEM_3D uses separate concrete and steel tags — mat_tags alternates
            # [conc1, steel1, conc2, steel2, ...]
            return (
                f"ops.element('MVLEM_3D', {ele_tag}, {ni}, {nj}, {nk}, {nl}, {m},\n"
                f"            '-thick', {thicks},\n"
                f"            '-width', {widths},\n"
                f"            '-rho',   {rhos},\n"
                f"            '-matConcrete', {mat_tags[::2]},\n"
                f"            '-matSteel',    {mat_tags[1::2]},\n"
                f"            '-CoR', {model.c_rot})"
            )

        if model.formulation == WallFormulation.SFI_MVLEM_3D:
            assert isinstance(model, SFIMVLEM3DModel)
            return (
                f"ops.element('SFI_MVLEM_3D', {ele_tag}, {ni}, {nj}, {nk}, {nl}, {m},\n"
                f"            '-thick', {thicks},\n"
                f"            '-width', {widths},\n"
                f"            '-mat',   {mat_tags},\n"
                f"            '-CoR', {model.c_rot},\n"
                f"            '-ThickMod', {model.thick_mod},\n"
                f"            '-Poisson',  {model.poisson})"
            )

        # E_SFI_MVLEM_3D
        assert isinstance(model, ESFIMVLEM3DModel)
        return (
            f"ops.element('E_SFI_MVLEM_3D', {ele_tag}, {ni}, {nj}, {nk}, {nl}, {m},\n"
            f"            '-thick', {thicks},\n"
            f"            '-width', {widths},\n"
            f"            '-mat',   {mat_tags},\n"
            f"            '-CoR',      {model.c_rot},\n"
            f"            '-ThickMod', {model.thick_mod},\n"
            f"            '-Poisson',  {model.poisson},\n"
            f"            '-Density',  {model.density_t_m3})"
        )

    # ── Public API ────────────────────────────────────────────────────────────

    def generate(self, model: WallAnalyticalModel, wall_key: str = "") -> dict:
        """
        Returns a dict with:
          material_lines : list[str]  — ops.uniaxialMaterial / ops.nDMaterial calls
          element_line   : str        — ops.element call
          ele_tag        : int
          mat_tags       : list[int]
        """
        # Ensure RC panel materials are registered for SFI/E-SFI
        mat_tags: list[int] = []
        if model.formulation.uses_rc_panel:
            for mf in model.macrofibers:
                panel = self._make_rc_panel(mf.to_dict(), model)
                tag = self.registry.get_or_create_fsam(panel)
                mat_tags.append(tag)
                mf.rc_panel_key = panel.cache_key
        else:
            # MVLEM_3D: concrete + steel alternating
            for mf in model.macrofibers:
                c_name = mf.concrete_name
                s_name = mf.steel_v_name
                c_props = self.concrete_props.get(c_name, {})
                s_props = self.steel_props.get(s_name, {})
                confined = mf.region.value in ("boundary_left", "boundary_right")
                c_def = ConcreteMaterialDef(
                    name=c_name,
                    fpc_mpa=c_props.get("fpc_mpa", 28.0),
                    confined=confined,
                )
                s_def = SteelMaterialDef(
                    name=s_name,
                    fy_mpa=s_props.get("fy_mpa", 420.0),
                    E_mpa=s_props.get("E_mpa", 200_000.0),
                )
                mat_tags.append(self.registry.get_or_create_concrete(c_def))
                mat_tags.append(self.registry.get_or_create_steel(s_def))

        mat_lines = self._material_lines(model)

        ni = self._node_tag(model.node_i)
        nj = self._node_tag(model.node_j)
        nk = self._node_tag(model.node_k)
        nl = self._node_tag(model.node_l)
        ele_tag = self._ele_tag(wall_key or f"{model.source_pier}_{model.source_story}")

        ele_line = self._element_line(model, ele_tag, ni, nj, nk, nl, mat_tags)

        return {
            "material_lines": mat_lines,
            "element_line":   ele_line,
            "ele_tag":        ele_tag,
            "mat_tags":       mat_tags,
        }

    def preview_text(self, model: WallAnalyticalModel, wall_key: str = "") -> str:
        """Human-readable OpenSeesPy preview for the UI."""
        result = self.generate(model, wall_key)
        parts = result["material_lines"] + ["", result["element_line"]]
        return "\n".join(parts)
