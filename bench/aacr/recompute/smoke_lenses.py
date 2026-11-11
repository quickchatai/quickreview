#!/usr/bin/env python3
"""How a DigitalOcean smoke's lens passes ended, from the open-model runs' numbers-only extracts.

    python3 bench/aacr/recompute/smoke_lenses.py --archive <release>/archive --data <hf-dataset> \\
        [--smoke glm53-smoke-7879ddc5-glm-] [--work <scratch>] [--json OUT]

docs/DIGITALOCEAN.md: the GLM smoke started 2026-10-13 15:23 UTC (17:23 local) ran into an overload
window that timed out lenses. A smoke is the set of open-model run dirs sharing a prefix
(`open-models/runs/<prefix><benchmark set>/`, one per benchmark slice). Each case's
`pi-events.pruned.jsonl` keeps every lens result's stop reason and, for a failed one, its error as a
closed class (timeout, rate-limit, overloaded, ...; never the message). Counts, over the smoke's cases:
lens results by outcome, and the timed-out ones. No model call.
"""
from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from archive import iter_jsonl, open_archive  # noqa: E402

SMOKE = "glm53-smoke-7879ddc5-glm-"
VOLUME = "openmodels-smokes"


def compute(root: Path, prefix: str) -> dict:
    dirs = sorted(d for d in glob.glob(str(root / "open-models" / "runs" / f"{prefix}*")) if os.path.isdir(d))
    if not dirs:
        raise SystemExit(f"no open-model runs named {prefix}* in the archive")
    outcome = collections.Counter()
    for d in dirs:
        for ev in glob.glob(os.path.join(d, "cases", "*", "pi-events.pruned.jsonl")):
            for e in iter_jsonl(Path(ev)):
                if e.get("type") == "tool_execution_end":
                    for r in ((e.get("result") or {}).get("details") or {}).get("results") or []:
                        outcome[r.get("errorClass") or r.get("error") or r.get("stopReason") or "unrecorded"] += 1
    return {"smoke": prefix, "runs": [os.path.basename(d) for d in dirs], "lens_results": dict(outcome),
            "timed_out": outcome["timeout"]}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--archive", required=True)
    ap.add_argument("--data", help="unused; accepted so that every archive check takes the same arguments")
    ap.add_argument("--smoke", default=SMOKE)
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "."), "smoke-lenses"))
    ap.add_argument("--json")
    a = ap.parse_args()
    root = open_archive(a.archive, a.work, [VOLUME])
    res = compute(root, a.smoke)
    print(json.dumps(res, indent=1))
    if a.json:
        Path(a.json).write_text(json.dumps(res, indent=1) + "\n")


if __name__ == "__main__":
    main()
