"""Patch opstool for headless operation and Python 3.11 compatibility.

Run once at Docker build time after opstool is installed.

Problems fixed:
  1. pre/__init__.py imports gmsh (needs X11) and tkinter — make optional.
  2. anlys/__init__.py -> _smart_analyze.py contains Python 3.12 f-string syntax
     (dict subscript with same quotes inside the expression) — make optional.
  3. vis/__init__.py imports pyvista/plotly which aren't installed — make optional.
  4. opstool/__init__.py imports all submodules unconditionally — wrap each in
     try/except so a failure in one submodule doesn't kill the whole package.
"""
import os
import re
import site

sd = site.getsitepackages()[0]
od = os.path.join(sd, "opstool")

if not os.path.isdir(od):
    print("opstool not installed, skipping patch")
    raise SystemExit(0)


def wrap_imports(path, replacements):
    """Apply string replacements to a file, print what changed."""
    c = open(path).read()
    for old, new in replacements:
        if old in c:
            c = c.replace(old, new)
            print(f"  patched: {os.path.relpath(path, od)!r}  ({old[:40]!r} ...)")
        else:
            print(f"  skip (not found): {os.path.relpath(path, od)!r}  ({old[:40]!r} ...)")
    open(path, "w").write(c)


# ── 1) opstool/__init__.py ────────────────────────────────────────────────────
# Wrap each "from . import X" so one broken submodule doesn't kill everything.
p0 = os.path.join(od, "__init__.py")
c0 = open(p0).read()

def _make_safe_import(m):
    mods = [x.strip() for x in m.group(1).split(",")]
    blocks = []
    for mod in mods:
        blocks.append(
            f"try:\n    from . import {mod}\nexcept Exception:\n    {mod} = None"
        )
    return "\n".join(blocks)

c0_patched = re.sub(r"^from \. import ([\w,\s]+)$", _make_safe_import, c0, flags=re.MULTILINE)
if c0_patched != c0:
    open(p0, "w").write(c0_patched)
    print(f"  patched: opstool/__init__.py  (submodule imports wrapped)")
else:
    print(f"  skip: opstool/__init__.py already patched or pattern not matched")

# ── 2) pre/__init__.py ────────────────────────────────────────────────────────
wrap_imports(
    os.path.join(od, "pre", "__init__.py"),
    [
        (
            "from ._read_gmsh import Gmsh2OPS",
            "try:\n    from ._read_gmsh import Gmsh2OPS\nexcept Exception:\n    Gmsh2OPS = None",
        ),
        (
            "from .tcl2py import tcl2py",
            "try:\n    from .tcl2py import tcl2py\nexcept Exception:\n    tcl2py = None",
        ),
    ],
)

# ── 3) anlys/__init__.py ─────────────────────────────────────────────────────
# _smart_analyze.py uses Python 3.12 f-string syntax (dict["key"] inside f"...")
wrap_imports(
    os.path.join(od, "anlys", "__init__.py"),
    [
        (
            "from ._smart_analyze import SmartAnalyze",
            "try:\n    from ._smart_analyze import SmartAnalyze\nexcept Exception:\n    SmartAnalyze = None",
        ),
    ],
)

# ── 4) vis/__init__.py ────────────────────────────────────────────────────────
open(os.path.join(od, "vis", "__init__.py"), "w").write(
    "try:\n    from . import pyvista\n    pv = pyvista\nexcept Exception:\n    pyvista = None; pv = None\n"
    "try:\n    from . import plotly\n    po = plotly\nexcept Exception:\n    plotly = None; po = None\n"
    '__all__ = ["pyvista", "pv", "plotly", "po"]\n'
)
print("  patched: vis/__init__.py  (pyvista/plotly optional)")

# ── Verify the package loads ─────────────────────────────────────────────────
try:
    import opstool  # noqa: F401
    print("opstool import OK")
except Exception as e:
    print(f"WARNING: opstool still fails to import: {e}")

print("opstool headless patches complete")
