#!/usr/bin/env python3
"""Recompute every published benchmark number in bench/aacr/claims.json from a
downloaded release, with no model call, and fail on any mismatch, missing
source or missing script.

    uv run --no-project --with pyarrow python bench/aacr/verify_claims.py --data <release dir> \\
        [--data <another dir>] [--martian <checkout>] [--qodo-gt <jsonl>] [--work <scratch>] \\
        [--report-md OUT.md] [--report-json OUT.json] [--partial] [--file README.md]
    python3 bench/aacr/verify_claims.py --lint          # the manifest against the repo's text; no data

--data names the downloaded release, or any part of it; the verifier finds:
  hf    the Hugging Face tables: <dir>/data/*.parquet (the dataset root), <dir>/hf-dataset/data,
        or a dir of <config>.parquet / <config>.jsonl files;
  slim  the slim re-score bundle: quickreview-bench-slim.tar.zst in <dir> or <dir>/slim, or an
        unpacked bundle (a dir holding FILES.sha256 and runs/).
Each claim names its check and key (`q`), and may name other sources for the same number
(`alt`). Every source the given data holds is computed and compared with the printed
value; a claim passes when every computed source prints as the published value and at
least one source was available. With --partial a claim none of whose sources is in --data
is reported as skipped instead of failing (to check the slim bundle or the tables alone).

--martian (withmartian/code-review-benchmark at e616e84) and --qodo-gt (Qodo
PR-Review-Bench's git_code_review_bench_100_w_open_prs.jsonl) are third-party and never in
the release; verify_slim.py needs them only to re-score the Martian and Qodo scoring dirs
from the bundle. Without them the slim check still yields every other cell, and the Martian
and Qodo claims are checked from the tables.

How a computed number is compared: it is printed the way the published value is printed —
the same number of decimals, the same sign, thousands separator and `%` — and the two strings
must be equal. The checks and their scripts are listed in claims.json under `checks`; a claim
whose check has no script in this tree, or no `q`, fails as "no script".
"""
from __future__ import annotations

import argparse
import ast
import json
import operator
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE / "recompute"))
import claim_text as CT  # noqa: E402

MANIFEST = HERE / "claims.json"


# ---------------------------------------------------------------- data

def discover(dirs: List[str]) -> Dict[str, Optional[str]]:
    found: Dict[str, Optional[str]] = {"hf": None, "slim": None, "archive": None, "repo": str(REPO)}
    for d in dirs:
        p = Path(d).resolve()
        for cand in (p, p / "archive"):
            if (cand / "MANIFEST.json").exists() and any(cand.glob("quickreview-runs-*.tar.zst")):
                found["archive"] = found["archive"] or str(cand)
        for cand in (p / "data", p / "hf-dataset" / "data", p):
            if cand.is_dir() and any((cand / f"prs.{ext}").exists() for ext in ("parquet", "jsonl")):
                found["hf"] = found["hf"] or str(cand)
                break
        for cand in (p / "quickreview-bench-slim.tar.zst", p / "slim" / "quickreview-bench-slim.tar.zst"):
            if cand.exists():
                found["slim"] = found["slim"] or str(cand)
        for cand in (p, p / "slim"):
            if (cand / "FILES.sha256").exists() and (cand / "runs").is_dir():
                found["slim"] = found["slim"] or str(cand)
        if p.is_file() and p.name.endswith(".tar.zst"):
            found["slim"] = found["slim"] or str(p)
    return found


# ---------------------------------------------------------------- formatting

def render_like(printed: str, x: float) -> str:
    """`x` printed the way `printed` is: decimals, sign, thousands separator, `%` and unit suffix."""
    p = printed.strip()
    suffix = ""
    while p and p[-1] in "%kMx":
        suffix = p[-1] + suffix
        p = p[:-1]
    sign = "+" if p.startswith("+") else ""
    core = p.lstrip("+-−")
    dec = len(core.split(".")[1]) if "." in core else 0
    comma = "," if "," in core else ""
    s = format(x, f"{sign}{comma}.{dec}f")
    if float(s.replace(",", "")) == 0:
        s = s.lstrip("-")
        if sign and not s.startswith("+"):
            s = "+" + s
    return s + suffix


def printed_as(claim: dict, v) -> Optional[str]:
    """How a computed value reads beside the published one (a source's own string as a number when it is one)."""
    if v is None:
        return None
    if isinstance(v, str):
        try:
            v = float(CT.normalise(v).strip().rstrip("%kMx").replace(",", ""))
        except ValueError:
            return v
    if claim.get("about"):
        return f"{float(v):.2f}"
    return render_like(CT.normalise(claim["value"]), float(v))


def number_of(printed: str) -> float:
    return float(CT.normalise(printed).strip().rstrip("%kMx").replace(",", ""))


def same(printed: str, x, about: Optional[float] = None) -> bool:
    """`about`: the published number is approximate ("about $4", "~$770"); it passes
    when the computed one is within that relative tolerance of it."""
    if x is None:
        return False
    if isinstance(x, str):
        # a source that prints its own number (verify_slim's cells): compare as a number when it is one
        try:
            x = float(CT.normalise(x).strip().rstrip("%kMx").replace(",", ""))
        except ValueError:
            return CT.normalise(x.strip()) == CT.normalise(printed.strip())
    if about is not None:
        p = number_of(printed)
        return abs(float(x) - p) <= about * abs(p)
    return render_like(CT.normalise(printed), float(x)) == CT.normalise(printed.strip())


# ---------------------------------------------------------------- expressions

_REF = re.compile(r"\{([a-z_]+):([^{}]+)\}")
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv,
        ast.USub: operator.neg, ast.UAdd: operator.pos}
_FUNCS = {"min": min, "max": max, "abs": abs, "round": round}


def _eval(node, env):
    if isinstance(node, ast.Expression):
        return _eval(node.body, env)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name) and node.id in env:
        return env[node.id]
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left, env), _eval(node.right, env))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand, env))
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCS and not node.keywords:
        return _FUNCS[node.func.id](*[_eval(a, env) for a in node.args])
    raise ValueError(f"not allowed in a claim expression: {ast.dump(node)[:80]}")


def refs_of(q: str) -> List[Tuple[str, str]]:
    m = _REF.findall(q)
    if m:
        return m
    check, _, key = q.partition(":")
    return [(check, key)]


# ---------------------------------------------------------------- sources

class NoSource(Exception):
    pass


class Sources:
    def __init__(self, a, manifest: dict, found: Dict[str, Optional[str]]):
        self.a, self.m, self.found = a, manifest, found
        self.work = Path(a.work).resolve()
        self.work.mkdir(parents=True, exist_ok=True)
        self._providers: Dict[str, object] = {}
        self._json: Dict[str, dict] = {}
        self.log: List[str] = []
        self.timings: Dict[str, float] = {}

    def needs(self, check: str) -> str:
        spec = self.m["checks"].get(check)
        if spec is None:
            raise KeyError(f"check {check!r} is not in the manifest's `checks`")
        return spec["needs"]

    def available(self, check: str) -> bool:
        return self.found.get(self.needs(check)) is not None

    def script_present(self, check: str) -> bool:
        spec = self.m["checks"][check]
        return all((REPO / s).exists() for s in spec.get("scripts", []))

    def value(self, check: str, key: str):
        if not self.available(check):
            raise NoSource(self.needs(check))
        spec = self.m["checks"][check]
        kind = spec["kind"]
        if kind == "tables":
            return self._table_provider(check, spec["provider"]).value(key)
        if kind == "json":
            return self._json_path(self._script_json(check, spec), key)
        if kind == "slim":
            return self._slim(spec, key)
        if kind == "repo":
            path, _, sub = key.partition("#")
            doc = json.loads((REPO / spec["root"] / path).read_text())
            return self._json_path(doc, sub) if sub else doc
        raise KeyError(f"check {check}: unknown kind {kind!r}")

    def _table_provider(self, check: str, provider: str):
        if provider not in self._providers:
            import claim_metrics as CM
            if not hasattr(self, "_tables"):
                self._tables = CM.Tables(self.found["hf"])
            self._providers[provider] = CM.PROVIDERS[provider](self._tables)
        return self._providers[provider]

    def _run(self, label: str, cmd: List[str]) -> None:
        t0 = time.time()
        p = subprocess.run(cmd, capture_output=True, text=True)
        self.timings[label] = round(time.time() - t0, 1)
        (self.work / f"{label}.log").write_text(p.stdout + "\n--- stderr ---\n" + p.stderr)
        if p.returncode:
            raise RuntimeError(f"{label} failed (exit {p.returncode}): {p.stderr.strip()[-800:]}")

    def _script_json(self, check: str, spec: dict) -> dict:
        if check not in self._json:
            out = self.work / f"{check}.json"
            args = [x.replace("{hf}", self.found["hf"] or "").replace("{out}", str(out)) for x in spec["args"]]
            self._run(check, [sys.executable, str(REPO / spec["scripts"][0])] + args)
            self._json[check] = json.loads(out.read_text())
        return self._json[check]

    def _slim(self, spec: dict, key: str):
        if "slim" not in self._json:
            out = self.work / "slim-verify"
            cmd = [sys.executable, str(HERE / "verify_slim.py"), "--bundle", self.found["slim"], "--work", str(out),
                   "--skip-charts", "--cells-json", str(self.work / "slim-cells.json")]
            if self.a.martian:
                cmd += ["--martian", self.a.martian]
            if self.a.qodo_gt:
                cmd += ["--qodo-gt", self.a.qodo_gt]
            self._run("verify_slim", cmd)
            cells = json.loads((self.work / "slim-cells.json").read_text())
            files = {}
            for name in ("open_models.slim.json", "do_speed.slim.json", "elo.slim.json", "elo-chart.json"):
                f = out / "out" / name
                files[name] = json.loads(f.read_text()) if f.exists() else None
            self._json["slim"] = {"cells": {f"{r[0]}|{r[1]}|{r[2]}": r[4] for r in cells["rows"]}, "files": files}
        s = self._json["slim"]
        part = spec["part"]
        if part == "cells":
            if key not in s["cells"]:
                raise KeyError(f"verify_slim produced no cell {key!r}")
            return s["cells"][key]
        doc = s["files"].get(part)
        if doc is None:
            raise KeyError(f"verify_slim wrote no {part}")
        return self._json_path(doc, key)

    @staticmethod
    def _json_path(doc, key: str):
        cur = doc
        for part in key.split("/"):
            if isinstance(cur, list):
                if part.startswith("[") and "=" in part:  # [field=value]: the list item whose field is value
                    f, _, v = part[1:-1].partition("=")
                    hits = [x for x in cur if isinstance(x, dict) and str(x.get(f)) == v]
                    if len(hits) != 1:
                        raise KeyError(f"json path {key!r}: {len(hits)} items with {f}={v}")
                    cur = hits[0]
                    continue
                if part == "#len":
                    return len(cur)
                cur = cur[int(part)]
            elif isinstance(cur, dict):
                if part == "#len":
                    return len(cur)
                if part not in cur:
                    raise KeyError(f"json path {key!r}: no {part!r}")
                cur = cur[part]
            else:
                raise KeyError(f"json path {key!r}: {part!r} under a scalar")
        return cur


def evaluate(src: Sources, q: str):
    """The number a `q` gives: one `check:key`, or an expression over `{check:key}` refs."""
    refs = refs_of(q)
    vals = {}
    for i, (check, key) in enumerate(refs):
        vals[f"_r{i}"] = src.value(check, key)
    if not _REF.search(q):
        return vals["_r0"]
    if any(v is None or isinstance(v, str) for v in vals.values()):
        return None
    expr = q
    for i, (check, key) in enumerate(refs):
        expr = expr.replace("{" + f"{check}:{key}" + "}", f"_r{i}", 1)
    return _eval(ast.parse(expr, mode="eval"), vals)


def checks_of(q: str) -> List[str]:
    return sorted({c for c, _ in refs_of(q)})


# ---------------------------------------------------------------- verify

def verify(a, manifest: dict, found) -> List[dict]:
    src = Sources(a, manifest, found)
    results = []
    claims = [c for c in manifest["claims"] if not a.file or c["file"] in a.file]
    for c in claims:
        r = {"id": c["id"], "file": c["file"], "anchor": c["anchor"], "value": c["value"], "sources": []}
        qs = ([c["q"]] if c.get("q") else []) + list(c.get("alt") or [])
        if not qs:
            r["status"] = "no-script"
            r["why"] = c.get("no_script") or "no recompute script yet"
            results.append(r)
            continue
        for q in qs:
            s = {"q": q}
            try:
                missing = [ch for ch in checks_of(q) if ch not in manifest["checks"] or not src.script_present(ch)]
                if missing:
                    s["status"], s["why"] = "no-script", f"check(s) {missing} have no script in this tree"
                elif not all(src.available(ch) for ch in checks_of(q)):
                    s["status"], s["why"] = "no-source", "needs " + "+".join(sorted({src.needs(ch) for ch in checks_of(q)}))
                else:
                    v = evaluate(src, q)
                    s["computed"] = v if v is None or isinstance(v, str) else float(v)
                    s["printed_as"] = printed_as(c, v)
                    about = manifest.get("about_tolerance") if c.get("about") else None
                    s["status"] = "ok" if same(c["value"], v, about) else "mismatch"
            except (KeyError, ValueError, RuntimeError, ZeroDivisionError, TypeError) as e:
                s["status"], s["why"] = "error", str(e)[:400]
            except Exception as e:  # a provider's own fault (claim_metrics.KeyError_)
                s["status"], s["why"] = "error", f"{type(e).__name__}: {str(e)[:400]}"
            r["sources"].append(s)
        st = [s["status"] for s in r["sources"]]
        computed = {s["printed_as"] for s in r["sources"] if s.get("status") in ("ok", "mismatch")}
        if "error" in st:
            r["status"] = "error"
        elif "mismatch" in st:
            r["status"] = "mismatch"
            n_src = sum(1 for s in r["sources"] if s.get("status") in ("ok", "mismatch"))
            r["class"] = ("data bug: the sources disagree with each other" if len(computed) > 1
                          else "stale published number: every source gives the same other value" if n_src > 1
                          else "stale published number: the data gives another value")
        elif "ok" in st:
            r["status"] = "pass"
        elif "no-script" in st:
            r["status"] = "no-script"
        else:
            r["status"] = "skipped" if a.partial else "no-source"
        if c.get("note"):
            r["note"] = c["note"]
        vols = (manifest.get("groups") or {}).get(c.get("group") or "", {}).get("archive") or []
        if found.get("archive") and vols:
            gone = [v for v in vols if not (Path(found["archive"]) / v).exists()]
            if gone:
                r["status"], r["why"] = "no-source", f"archive volume(s) missing: {gone}"
        results.append(r)
    a._timings = src.timings
    a._consistency = consistency(a, found, src)
    return results


FAIL = ("mismatch", "error", "no-source", "no-script")


def consistency(a, found, src: "Sources") -> List[dict]:
    """The release's own checks, re-run on the downloaded data: hf_export.py's validation (every count and
    headline number recomputed from the tables, the checks validation.json records) and verify_slim.py's
    bundle checks (file hashes, no transcript text, every Martian and Qodo scoring dir re-scored, the Elo
    refit equal to the run's ratings.json)."""
    out = []
    if found.get("hf") and not a.no_validation:
        sys.path.insert(0, str(HERE))
        import hf_export as H
        from tables import load_table
        try:
            t = {n: load_table(found["hf"], n) for n in H.CONFIGS}
        except SystemExit as e:  # a config the release should hold is missing
            return out + [{"source": "hf_export.validate", "check": "every config's table is present", "ok": False,
                           "got": str(e), "want": "all of " + ", ".join(H.CONFIGS)}]
        for c in H.validate(t) + H.validate_release(t, None, {}, None):
            out.append({"source": "hf_export.validate", "check": c["check"], "ok": bool(c["ok"]),
                        "got": c["got"], "want": c["want"]})
    if found.get("slim") and "slim" in src._json:
        summ = json.loads((src.work / "slim-verify" / "out" / "summary.json").read_text())
        out.append({"source": "verify_slim", "check": "every bundle file matches FILES.sha256", "ok": summ["hash_mismatches"] == 0,
                    "got": summ["hash_mismatches"], "want": 0})
        out.append({"source": "verify_slim", "check": "no transcript text (pi-events.jsonl) in the bundle",
                    "ok": summ["pi_events_in_bundle"] == 0, "got": summ["pi_events_in_bundle"], "want": 0})
        for name in ("martian", "qodo"):
            st = summ.get(name) or {}
            if st:
                out.append({"source": "verify_slim", "check": f"every {name} scoring dir re-scores to its stored scores",
                            "ok": set(st) <= {"identical", "numbers identical, scores.md text differs"}, "got": st, "want": "identical"})
        if "elo_refit_equals_ratings_json" in summ:
            out.append({"source": "verify_slim", "check": "the Elo refit from the judgments equals the run's ratings.json",
                        "ok": bool(summ["elo_refit_equals_ratings_json"]), "got": summ["elo_refit_equals_ratings_json"], "want": True})
    return out


def report_md(manifest: dict, lint: dict, results: List[dict], found, timings, consist=()) -> str:
    from collections import Counter
    out = ["# Claims verification", "",
           f"Manifest: `bench/aacr/claims.json` ({len(manifest['claims'])} claims, "
           f"{sum(len(n.get('tokens') or []) for n in manifest.get('not_claims', []))} listed not-claims). "
           f"Data: hf = `{found.get('hf')}`, slim = `{found.get('slim')}`.", ""]
    tot = Counter(r["status"] for r in results)
    out += ["## Result", "", "| Status | Claims |", "|---|---|"] + [f"| {k} | {v} |" for k, v in sorted(tot.items())] + [""]
    out += ["## By file", "", "| File | Number tokens | Claims | Not-claims | Unaccounted | pass | fail |", "|---|---|---|---|---|---|---|"]
    for f, s in sorted(lint["files"].items()):
        rs = [r for r in results if r["file"] == f]
        out.append(f"| {f} | {s['tokens']} | {s['claims']} | {s['not_claims']} | {s['unaccounted']} | "
                   f"{sum(r['status'] == 'pass' for r in rs)} | {sum(r['status'] in FAIL for r in rs)} |")
    out.append("")
    bad = [r for r in results if r["status"] in FAIL and r["status"] != "no-script"]
    gaps = [r for r in results if r["status"] == "no-script"]
    if gaps:
        by = {}
        for r in gaps:
            by.setdefault(r.get("why") or "", []).append(r)
        out += ["## No recompute script yet", "",
                f"{len(gaps)} claims are listed with the data behind them but no check computes them. By reason:", "",
                "| Claims | Reason | Where (first few) |", "|---|---|---|"]
        for why, rs in sorted(by.items(), key=lambda kv: -len(kv[1])):
            where = ", ".join(f"{r['file'].split('/')[-1]}:{lint['files'].get(r['file'], {}).get('lines', {}).get(r['id'], '?')}"
                              for r in rs[:4])
            out.append(f"| {len(rs)} | {why.replace('|', '/')} | {where}{' …' if len(rs) > 4 else ''} |")
        out.append("")
    if bad:
        out += ["## Not passing", "", "| Claim | File:line | Published | Computed | Status | Why |", "|---|---|---|---|---|---|"]
        for r in bad:
            line = lint["files"].get(r["file"], {}).get("lines", {}).get(r["id"], "?")
            comp = "; ".join(f"{s['printed_as']}" for s in r["sources"] if "printed_as" in s) or "–"
            why = r.get("class") or r.get("why") or "; ".join(s.get("why", "") for s in r["sources"] if s.get("why"))
            if r.get("note"):
                why = f"{why} — {r['note']}"
            out.append(f"| {r['id']} | {r['file']}:{line} | {r['value']} | {comp} | {r['status']} | {why.replace('|', '/')} |")
        out.append("")
    if consist:
        bad_c = [c for c in consist if not c["ok"]]
        out += ["## The release's own checks, re-run", "",
                f"{len(consist) - len(bad_c)} of {len(consist)} pass (hf_export.py's validation over the tables, "
                f"verify_slim.py's bundle checks).", ""]
        for c in bad_c:
            out.append(f"- FAILED ({c['source']}): {c['check']}: got {c['got']}, want {c['want']}")
        out.append("")
    if timings:
        out += ["Script run times (s): " + ", ".join(f"{k} {v}" for k, v in timings.items()), ""]
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--manifest", default=str(MANIFEST))
    ap.add_argument("--repo", default=str(REPO), help="the tree whose published files the anchors are read from")
    ap.add_argument("--data", action="append", default=[], help="the downloaded release, or a part of it (repeatable)")
    ap.add_argument("--work", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "verify-claims"))
    ap.add_argument("--martian", help="withmartian/code-review-benchmark checkout (third-party; optional)")
    ap.add_argument("--qodo-gt", help="Qodo PR-Review-Bench ground-truth jsonl (third-party; optional)")
    ap.add_argument("--partial", action="store_true", help="skip, do not fail, claims with no source in --data")
    ap.add_argument("--file", action="append", help="verify only the claims of this published file (repeatable)")
    ap.add_argument("--lint", action="store_true", help="check the manifest against the published text only; no data")
    ap.add_argument("--no-validation", action="store_true", help="skip re-running hf_export.py's table validation")
    ap.add_argument("--report-md")
    ap.add_argument("--report-json")
    a = ap.parse_args()
    manifest = json.loads(Path(a.manifest).read_text())
    repo = Path(a.repo)

    def read(path):
        p = repo / path
        return p.read_text() if p.exists() else None

    lint = CT.lint(manifest, read)
    for c in manifest["claims"]:
        for q in ([c["q"]] if c.get("q") else []) + list(c.get("alt") or []):
            for ch in checks_of(q):
                if ch not in manifest["checks"]:
                    lint["errors"].append(f"claim {c['id']}: check {ch!r} is not in `checks`")
    for ch, spec in manifest["checks"].items():
        for s in spec.get("scripts", []):
            if not (repo / s).exists():
                lint["errors"].append(f"check {ch}: script {s} is missing")
    for e in lint["errors"]:
        print("MANIFEST:", e, file=sys.stderr)
    for f, s in sorted(lint["files"].items()):
        print(f"{f}: {s['tokens']} number tokens, {s['claims']} claims, {s['not_claims']} not-claims, "
              f"{s['unaccounted']} unaccounted ({s['lint']})")
    if a.lint:
        if a.report_json:
            Path(a.report_json).write_text(json.dumps({"lint": lint}, indent=1) + "\n")
        return 1 if lint["errors"] else 0
    found = discover(a.data)
    print(f"data: hf={found['hf']} slim={found['slim']} archive={found['archive']}")
    if not any(found[k] for k in ("hf", "slim", "archive")):
        print("no release data found under --data", file=sys.stderr)
        return 2
    a._timings, a._consistency = {}, []
    results = verify(a, manifest, found)
    from collections import Counter
    tot = Counter(r["status"] for r in results)
    print("claims:", dict(sorted(tot.items())))
    gaps = Counter(r.get("why") for r in results if r["status"] == "no-script")
    for r in results:
        if r["status"] in FAIL and r["status"] != "no-script":
            comp = ", ".join(str(s.get("printed_as", s.get("why", ""))) for s in r["sources"]) or r.get("why", "")
            print(f"  {r['status'].upper()} {r['id']} ({r['file']}): published {r['value']!r}, computed {comp}")
    for why, n in gaps.most_common():
        print(f"  NO-SCRIPT x{n}: {why}")
    bad_c = [c for c in a._consistency if not c["ok"]]
    print(f"release checks: {len(a._consistency) - len(bad_c)} of {len(a._consistency)} pass")
    for c in bad_c:
        print(f"  CHECK FAILED ({c['source']}): {c['check']}: got {c['got']}, want {c['want']}")
    if a.report_md:
        Path(a.report_md).write_text(report_md(manifest, lint, results, found, a._timings, a._consistency))
    if a.report_json:
        Path(a.report_json).write_text(json.dumps({"found": found, "lint": lint, "results": results,
                                                   "consistency": a._consistency, "timings": a._timings},
                                                  indent=1, default=str) + "\n")
    return 1 if lint["errors"] or any(r["status"] in FAIL for r in results) or bad_c else 0


if __name__ == "__main__":
    sys.exit(main())
