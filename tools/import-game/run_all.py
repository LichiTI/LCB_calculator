"""Run the full phase-A import pipeline in order and print output hashes."""
from __future__ import annotations

import hashlib
import runpy
import sys
from pathlib import Path

from common import NORMALIZED_DIR, REPORTS_DIR

HERE = Path(__file__).parent
STEPS = ["snapshot.py", "extract_static.py", "normalize.py", "build_egos.py", "validate.py", "build_text.py", "report_identities.py"]


def digest(paths) -> str:
    h = hashlib.sha256()
    for p in sorted(paths):
        h.update(p.relative_to(NORMALIZED_DIR.parent).as_posix().encode())
        h.update(p.read_bytes())
    return h.hexdigest()[:16]


def main() -> int:
    for step in STEPS:
        print(f"\n=== {step}")
        sys.argv = [step]
        try:
            runpy.run_path(str(HERE / step), run_name="__main__")
        except SystemExit as exc:
            if exc.code not in (0, None):
                print(f"step {step} failed with {exc.code}")
                return int(exc.code)
    sys.argv = ["trace_identity.py", "10105"]
    runpy.run_path(str(HERE / "trace_identity.py"), run_name="__main__")
    print("\nnormalized digest:", digest(NORMALIZED_DIR.rglob("*.json")))
    print("reports digest:   ", digest(p for p in REPORTS_DIR.glob("*.json") if p.name != "snapshot.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
