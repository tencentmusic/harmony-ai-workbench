"""Validate the exact Python environment used by the cloud Agent worker."""
import argparse
import hashlib
import importlib.metadata
import json
import runpy
import sys
from pathlib import Path


def check(harness_root):
    from packaging.requirements import Requirement

    requirements = harness_root / "requirements.txt"
    pinned = {}
    for raw in requirements.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        requirement = Requirement(line)
        specs = list(requirement.specifier)
        if requirement.marker or requirement.extras or len(specs) != 1 or specs[0].operator != "==":
            raise ValueError(f"Harness dependency must have one exact version: {line}")
        installed = importlib.metadata.version(requirement.name)
        expected = specs[0].version
        if installed != expected:
            raise ValueError(f"{requirement.name}: expected {expected}, installed {installed}")
        pinned[requirement.name] = installed

    # Calling diagnose directly prevents doctor.py from switching to the package's own .venv.
    doctor = runpy.run_path(str(harness_root / "scripts" / "doctor.py"))
    diagnosis = doctor["diagnose"](root=harness_root)
    if diagnosis["status"] != "core_ready":
        raise ValueError("Harness doctor failed: " + ", ".join(diagnosis["issues"]))

    import numpy as np
    from PIL import Image
    from skimage.metrics import structural_similarity

    pixels = np.asarray(Image.new("L", (8, 8), 128))
    if structural_similarity(pixels, pixels, data_range=255) != 1.0:
        raise ValueError("Harness visual comparison smoke failed")
    return {
        "python": sys.executable,
        "requirements_sha256": hashlib.sha256(requirements.read_bytes()).hexdigest(),
        "harness_version": json.loads((harness_root / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8"))["version"],
        "locked_packages": pinned,
        "doctor": diagnosis["status"],
        "visual_smoke": "passed",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("harness_root", type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(check(args.harness_root.resolve()), ensure_ascii=False))
    except Exception as exc:
        print(f"Harness runtime check failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
