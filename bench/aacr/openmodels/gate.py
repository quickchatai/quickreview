#!/usr/bin/env python3
"""Gate an open-model benchmark arm before GPT-6.1 Sol scores it.

  gate.py --runs-dir DIR --model ID --prefix P --sets s1,s2,... [--strict] [--out FILE]

For every run <P>-<set>: run.json finished, every PR of the set present,
status ok, zero model_errors, every planned pass executed, the fingerprint and
every recorded assistant message naming digitalocean/<ID> (ID from models.py).

--strict (the smoke): any failure exits 1, so nothing is scored.
Without it (the full run): failures are LISTED and written to --out, and the
exit is 1 only on a wrong reviewer model (that run must never be scored) —
failed PRs stay visible as failures; the set is never shrunk to what passed.
Also prints the cost and time at the model's DigitalOcean list price.
"""
import argparse, json, sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from models import MODELS  # noqa: E402

SETS = Path(__file__).resolve().parents[1] / "sets"


def models_in(events: Path) -> Counter:
    seen, ids = set(), Counter()

    def visit(x):
        if isinstance(x, list):
            for v in x:
                visit(v)
        elif isinstance(x, dict):
            if x.get("role") == "assistant" and "model" in x:
                key = (x.get("timestamp"), x.get("provider"), x["model"])
                if key not in seen:
                    seen.add(key)
                    ids[f"{x.get('provider')}/{x['model']}"] += 1
            for v in x.values():
                visit(v)

    if events.is_file():
        for line in events.open():
            try:
                visit(json.loads(line))
            except ValueError:
                pass
    return ids


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", required=True, type=Path)
    ap.add_argument("--model", required=True, choices=sorted(MODELS))
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--sets", required=True)
    ap.add_argument("--strict", action="store_true")
    ap.add_argument("--out")
    a = ap.parse_args()
    MODEL, PRICE = f"digitalocean/{a.model}", MODELS[a.model]["price"]

    report, wrong_model, failed = {"prefix": a.prefix, "sets": {}}, False, 0
    for s in a.sets.split(","):
        want = [c["instance_id"] for c in json.loads((SETS / f"{s}.json").read_text())["cases"]]
        run = a.runs_dir / f"{a.prefix}-{s}"
        rj = run / "run.json"
        rec = json.loads(rj.read_text()) if rj.is_file() else {}
        row = {"run": run.name, "finished": bool(rec.get("finished_at")), "cases": len(want),
               "ok": 0, "failures": [], "models": Counter(), "usage": Counter(), "minutes": []}
        conv = (rec.get("models") or {}).get("conversation")
        if conv not in (None, MODEL):
            wrong_model = True
            row["failures"].append({"case": "*", "why": f"run conversation model {conv}"})
        for cid in want:
            cs = run / "cases" / cid / "case-summary.json"
            if not cs.is_file():
                row["failures"].append({"case": cid, "why": "no case-summary (not reviewed)"})
                continue
            d = json.loads(cs.read_text())
            why = []
            if d.get("status") != "ok":
                why.append(f"status {d.get('status')}")
            errs = {k: v for k, v in (d.get("model_errors") or {}).items() if v}
            if errs:
                why.append(f"model_errors {errs}")
            # A session sometimes launches a lens with its tier suffix doubled
            # (pass-x--sol-high--sol-high, seen with GLM); the lens still ran, so count it, but say so.
            ran = set()
            for p in d.get("executed_passes") or []:
                parts = p.split("--")
                if len(parts) == 3 and parts[1] == parts[2]:
                    row.setdefault("doubled_suffix", []).append(cid)
                    p = "--".join(parts[:2])
                ran.add(p)
            missing = sorted(set(d.get("planned_lenses") or []) - ran)
            if missing:
                why.append(f"missing passes {missing}")
            fp = d.get("fingerprint") or {}
            if fp.get("conversation") != MODEL or any(not m.startswith(MODEL + ":") for m in (fp.get("tiers") or {}).values()):
                why.append("fingerprint names another reviewer model")
                wrong_model = True
            ids = models_in(run / "cases" / cid / "pi-events.jsonl")
            row["models"].update(ids)
            if any(k != MODEL for k in ids):
                why.append(f"assistant messages from {sorted(k for k in ids if k != MODEL)}")
                wrong_model = True
            u = d.get("usage") or {}
            for k in PRICE:
                row["usage"][k] += u.get(k, 0) or 0
            if d.get("duration_seconds"):
                row["minutes"].append(round(d["duration_seconds"] / 60, 1))
            if why:
                row["failures"].append({"case": cid, "why": "; ".join(why)})
            else:
                row["ok"] += 1
        row["usd"] = round(sum(row["usage"][k] / 1e6 * p for k, p in PRICE.items()), 2)
        row["models"], row["usage"] = dict(row["models"]), dict(row["usage"])
        m = sorted(row["minutes"])
        row["minutes"] = {"n": len(m), "median": m[len(m) // 2] if m else None, "max": m[-1] if m else None}
        failed += len(row["failures"]) + (0 if row["finished"] else 1)
        report["sets"][s] = row
        print(f"{s:>20}: {row['ok']}/{row['cases']} ok, ${row['usd']}, "
              f"median {row['minutes']['median']} min, max {row['minutes']['max']} min"
              + ("" if row["finished"] else "  [run not finished]"))
        if row.get("doubled_suffix"):
            row["doubled_suffix"] = sorted(set(row["doubled_suffix"]))
            print(f"{'':>22}note: doubled tier suffix on lens launches in {row['doubled_suffix']}")
        for f in row["failures"]:
            print(f"{'':>22}FAIL {f['case']}: {f['why']}")
    report["usd_total"] = round(sum(r["usd"] for r in report["sets"].values()), 2)
    print(f"{'total':>20}: ${report['usd_total']} at list price "
          f"(input {PRICE['input']}, output {PRICE['output']}, cache read {PRICE['cacheRead']} $/1M)")
    if a.out:
        Path(a.out).write_text(json.dumps(report, indent=2) + "\n")
    if wrong_model:
        print(f"gate: a reviewer call used a model other than {MODEL} — do NOT score", file=sys.stderr)
        return 1
    if a.strict and failed:
        print("gate: smoke not clean — do NOT score", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
