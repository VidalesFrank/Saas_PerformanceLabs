"""
Bench runner — se invoca dentro del contenedor con:
  python bench_runner.py <variant_name>

Aplica monkey-patches a LinearOPSBuilder segun variant_name, corre build+eigen,
imprime JSON con {t_build, t_eigen, T1, T1_x, T1_y, ok, err}.
"""
import json, os, sys, time, math, traceback

MODEL_PATH = "/app/data/uploads/structural/1cea051f-de46-4d2e-a21a-e5dec7828472/work/canonical/structural_model.json"
N_MODES = 6


def _dominant(periods, mp, axis):
    key = {"MX": "partiMassRatiosMX",
           "MY": "partiMassRatiosMY",
           "RMZ": "partiMassRatiosRMZ"}[axis]
    ratios = mp.get(key, [])
    if not ratios:
        return 0.0
    idx = max(range(len(ratios)), key=lambda i: ratios[i])
    return periods[idx] if idx < len(periods) else 0.0


def run(variant):
    with open(MODEL_PATH) as f:
        model = json.load(f)

    from app.engine.building.linear import ops_builder as OB
    import openseespy.opensees as ops

    solver_args = (N_MODES,)
    pre_eigen_calls = []

    def patch_add_mass(tiny_val):
        """Replace _add_tiny_mass_to_wall_nodes with a version using tiny_val."""
        def patched(self, ops_ref):
            restraints = set(self._m.get("restraints", {}).keys())
            wall_joints = getattr(self, "_wall_joints", set())
            done = set()
            for label in wall_joints:
                tag = OB._joint_tag(label)
                if tag in done:
                    continue
                try:
                    if label in restraints:
                        ops_ref.mass(tag, 0.0, 0.0, 0.0,
                                     tiny_val, tiny_val, tiny_val)
                    else:
                        ops_ref.mass(tag, 0.0, 0.0, tiny_val,
                                     tiny_val, tiny_val, 0.0)
                    done.add(tag)
                except Exception:
                    pass
        OB.LinearOPSBuilder._add_tiny_mass_to_wall_nodes = patched

    def patch_fix_wall():
        """Fix Uz,Rx,Ry on all non-restrained wall joints."""
        def patched(self, ops_ref):
            restraints = set(self._m.get("restraints", {}).keys())
            wall_joints = getattr(self, "_wall_joints", set())
            done = set()
            for label in wall_joints:
                tag = OB._joint_tag(label)
                if tag in done:
                    continue
                try:
                    if label in restraints:
                        ops_ref.mass(tag, 0.0, 0.0, 0.0, 1e-6, 1e-6, 1e-6)
                    else:
                        ops_ref.fix(tag, 0, 0, 1, 1, 1, 0)
                    done.add(tag)
                except Exception:
                    pass
        OB.LinearOPSBuilder._add_tiny_mass_to_wall_nodes = patched

    if variant == "baseline":
        pass
    elif variant.startswith("tiny_"):
        patch_add_mass(float(variant.split("_", 1)[1]))
    elif variant == "fix_wall_uzrxry":
        patch_fix_wall()
    elif variant == "penalty":
        pre_eigen_calls.append(("constraints", ("Penalty", 1e8, 1e8)))
    elif variant == "system_sparsegen":
        pre_eigen_calls.append(("system", ("SparseGeneral",)))
    elif variant == "system_umfpack":
        pre_eigen_calls.append(("system", ("UmfPack",)))
    elif variant == "system_bandgen":
        pre_eigen_calls.append(("system", ("BandGeneral",)))
    elif variant == "system_prof":
        pre_eigen_calls.append(("system", ("ProfileSPD",)))
    elif variant == "system_sparsesym":
        pre_eigen_calls.append(("system", ("SparseSYM",)))
    elif variant == "penalty_umfpack":
        pre_eigen_calls.append(("constraints", ("Penalty", 1e8, 1e8)))
        pre_eigen_calls.append(("system", ("UmfPack",)))
    elif variant == "fix_wall_umfpack":
        patch_fix_wall()
        pre_eigen_calls.append(("system", ("UmfPack",)))
    elif variant == "fix_wall_penalty_umfpack":
        patch_fix_wall()
        pre_eigen_calls.append(("constraints", ("Penalty", 1e8, 1e8)))
        pre_eigen_calls.append(("system", ("UmfPack",)))
    elif variant == "tiny_1e-3_umfpack":
        patch_add_mass(1e-3)
        pre_eigen_calls.append(("system", ("UmfPack",)))
    elif variant == "fix_wall_bandgen":
        patch_fix_wall()
        pre_eigen_calls.append(("system", ("BandGeneral",)))
    else:
        raise ValueError(f"Unknown variant: {variant}")

    ops.wipe()
    t0 = time.time()
    b = OB.LinearOPSBuilder(model)
    b.build()
    t_build = time.time() - t0

    for fn, args in pre_eigen_calls:
        try:
            getattr(ops, fn)(*args)
        except Exception as e:
            return {"variant": variant, "t_build": t_build,
                    "err": f"pre_eigen {fn}: {e}"}

    t1 = time.time()
    try:
        lam = ops.eigen(*solver_args)
    except Exception as e:
        return {"variant": variant, "t_build": t_build,
                "t_eigen": time.time() - t1,
                "err": f"eigen: {e}"}
    t_eigen = time.time() - t1

    if not lam:
        return {"variant": variant, "t_build": t_build,
                "t_eigen": t_eigen, "err": "empty eigenvalues"}

    periods = []
    for l in lam:
        if l > 0:
            periods.append(2 * math.pi / math.sqrt(l))
        else:
            periods.append(0.0)
    try:
        mp = ops.modalProperties("-return")
    except Exception:
        mp = {}

    T1 = periods[0] if periods else 0.0
    T1x = _dominant(periods, mp, "MX")
    T1y = _dominant(periods, mp, "MY")

    return {"variant": variant,
            "t_build": round(t_build, 3),
            "t_eigen": round(t_eigen, 3),
            "T1": round(T1, 4),
            "T1_x": round(T1x, 4),
            "T1_y": round(T1y, 4),
            "n_lam": len(lam),
            "ok": True}


if __name__ == "__main__":
    v = sys.argv[1]
    try:
        out = run(v)
    except Exception as e:
        out = {"variant": v, "err": str(e), "tb": traceback.format_exc()}
    print("RESULT:" + json.dumps(out))
