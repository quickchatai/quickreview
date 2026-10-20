#!/usr/bin/env python3
"""Pairwise Elo judge for benchmark configurations.

  elo.py init PLAN.json [--dir D]   create an Elo run directory from a plan
  elo.py pack D                     pack every PR's shared context; no model call
  elo.py run D [--rounds N] [--judge gpt|opus|both] [--no-wait]
                                    judge round 0, then adaptive rounds
  elo.py report D                   ratings per judge → D/REPORT.md, D/ratings.json
  elo.py show D --x RUN --y RUN [--judge J] [--pr IID]
                                    the judge's explanations for one matchup
  elo.py --self-test

A run directory holds the plan, the packed contexts (packs/), the scheduled
judgment units (units.jsonl: PR + which run is Review A and which Review B),
every judge's answers (judgments/<judge>.jsonl, append-only, explanations
included), and the Opus batches (batches.jsonl). Everything is resumable:
`run` first collects what is in flight, then retries what failed (≤ 3
attempts), then schedules the next round. Both judges judge every unit with
the same prompt, so their tables are comparable and their agreement is
measured. See bench/aacr/elo/README.md.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import elo_data as D  # noqa: E402
import elo_judge as J  # noqa: E402
import elo_rating as R  # noqa: E402

MAX_ATTEMPTS = 3
JUDGES = ("gpt", "opus")
# Opus 5.5 at Batch API prices, $ per million tokens: half of the standard
# $4 input / $20 output / $8 one-hour cache write / $0.20 cache read.
OPUS_BATCH_USD = {"input": 2.0, "output": 10.0, "cache_write_1h": 4.0, "cache_read": 0.10}


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} elo: {msg}", flush=True)


def safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def read_jsonl(path: Path) -> List[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


_append_lock = threading.Lock()


def append_jsonl(path: Path, row: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _append_lock, path.open("a") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")


class Run:
    def __init__(self, d: Path):
        self.d = d
        self.plan = json.loads((d / "plan.json").read_text())
        self.runs: List[str] = self.plan["runs"]
        self._cases: Optional[Dict[str, D.Case]] = None

    # -- data
    @property
    def cases(self) -> Dict[str, D.Case]:
        if self._cases is None:
            self._cases = D.load_cases(self.plan)
        return self._cases

    def eligible(self) -> Dict[str, List[str]]:
        return {r: sorted(pr for pr, c in self.cases.items() if c.reviews.get(r) is not None) for r in self.runs}

    def context(self, pr: str) -> str:
        path = self.d / "packs" / f"{safe(pr)}.txt"
        if not path.exists():
            packed = D.pack_context(self.cases[pr], self.plan.get("max_prompt_tokens", 400000))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(packed["text"])
            append_jsonl(self.d / "packs.jsonl", {"pr": pr, "tokens": packed["tokens"],
                                                  "over_budget": packed["over_budget"], "files": packed["files"]})
        return path.read_text()

    def reviews(self, unit: dict) -> str:
        case = self.cases[unit["pr"]]
        return J.reviews_text(D.render_review("A", case.reviews[unit["a"]]),
                              D.render_review("B", case.reviews[unit["b"]]))

    # -- units and judgments
    def units(self) -> List[dict]:
        return read_jsonl(self.d / "units.jsonl")

    def judgments(self, judge: str) -> Dict[str, List[dict]]:
        out: Dict[str, List[dict]] = {}
        for row in read_jsonl(self.d / "judgments" / f"{judge}.jsonl"):
            out.setdefault(row["id"], []).append(row)
        return out

    def final(self, judge: str) -> Dict[str, dict]:
        """id → the ok judgment, for units that have one."""
        return {i: next(r for r in rows if r["status"] == "ok")
                for i, rows in self.judgments(judge).items() if any(r["status"] == "ok" for r in rows)}

    def pending(self, judge: str, in_flight: set) -> List[dict]:
        js = self.judgments(judge)
        out = []
        for u in self.units():
            rows = js.get(u["id"], [])
            if u["id"] in in_flight or any(r["status"] == "ok" for r in rows) or len(rows) >= MAX_ATTEMPTS:
                continue
            out.append(u)
        return out

    def add_units(self, units: List[dict], rnd: int) -> None:
        existing = self.units()
        rng = random.Random(f"{self.plan.get('seed', 1)}:{rnd}")
        n = len(existing)
        for u in units:
            n += 1
            a, b = (u["x"], u["y"]) if rng.random() < 0.5 else (u["y"], u["x"])
            append_jsonl(self.d / "units.jsonl", {"id": f"u{n:04d}", "round": rnd, "pr": u["pr"], "a": a, "b": b})

    def record(self, judge: str, unit: dict, result: dict, model: str, effort: str, prompt_sha: str) -> None:
        append_jsonl(self.d / "judgments" / f"{judge}.jsonl",
                     {"id": unit["id"], "pr": unit["pr"], "a": unit["a"], "b": unit["b"], "round": unit["round"],
                      "judge": judge, "model": model, "effort": effort, "prompt_sha256": prompt_sha,
                      "at": now(), **result})

    def prompt_sha(self, unit: dict) -> str:
        h = hashlib.sha256()
        for part in (J.SYSTEM, self.context(unit["pr"]), self.reviews(unit)):
            h.update(part.encode())
            h.update(b"\0")
        return h.hexdigest()

    # -- games
    def games(self, judge: str, category: Optional[str] = None) -> List[R.Game]:
        out = []
        for row in self.final(judge).values():
            v = row["verdict"]
            w = (v["categories"][category] if category else v["overall"])["winner"]
            out.append((row["pr"], row["a"], row["b"], {"A": 1.0, "B": 0.0, "tie": 0.5}[w]))
        return out

    def done_prs(self) -> Dict[Tuple[str, str], List[str]]:
        done: Dict[Tuple[str, str], List[str]] = {}
        for u in self.units():
            done.setdefault(R.pair_key(u["a"], u["b"]), []).append(u["pr"])
        return done


# ---- commands --------------------------------------------------------------------------

def cmd_init(a) -> None:
    plan = json.loads(Path(a.plan).read_text())
    for k in ("name", "benchmark", "set", "runs"):
        if k not in plan:
            raise SystemExit(f"{a.plan}: missing {k!r}")
    d = Path(a.dir) if a.dir else D.runs_dir().parent / "elo" / plan["name"]
    if (d / "plan.json").exists():
        if json.loads((d / "plan.json").read_text()) != plan:
            raise SystemExit(f"{d} already holds a different plan; pick another --dir")
        log(f"{d} already initialised")
        return
    d.mkdir(parents=True, exist_ok=True)
    (d / "plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    log(f"initialised {d}")


def cmd_pack(a) -> None:
    run = Run(Path(a.dir))
    elig = run.eligible()
    log(f"{len(run.cases)} PRs; reviews present per run: "
        + ", ".join(f"{r} {len(elig[r])}" for r in run.runs))
    for r in run.runs:
        missing = sorted(pr for pr in run.cases if pr not in elig[r])
        if missing:
            log(f"  {r} produced nothing on: {', '.join(missing)}")
    sizes = []
    for pr in sorted(run.cases):
        ctx = run.context(pr)
        rev = [D.tokens(D.render_review("A", rv)) for rv in run.cases[pr].reviews.values() if rv]
        sizes.append(D.tokens(J.SYSTEM) + D.tokens(ctx) + 2 * max(rev or [0]))
    packs = {row["pr"]: row for row in read_jsonl(run.d / "packs.jsonl")}
    for pr in sorted(run.cases):
        p = packs[pr]
        shapes = Counter(f["shape"] for f in p["files"])
        log(f"  {pr}: context ~{p['tokens']} tok {dict(shapes)}{' OVER BUDGET' if p['over_budget'] else ''}")
    sizes.sort()
    log(f"largest judge prompt ~{sizes[-1]} tok, median ~{sizes[len(sizes) // 2]} tok (estimate: chars/{D.CHARS_PER_TOKEN})")


def make_judges(run: Run, which: str):
    cfg = run.plan.get("judges", {})
    out = {}
    if which in ("gpt", "both"):
        g = cfg.get("gpt", {})
        out["gpt"] = J.GptJudge(g.get("url", "http://127.0.0.1:8790"), g.get("model", "gpt-6.1-sol"),
                                g.get("effort", "xhigh"))
    if which in ("opus", "both"):
        o = cfg.get("opus", {})
        env = Path(o.get("env_file") or D.AACR / "claude.env")
        out["opus"] = J.OpusJudge(env, o.get("model", "claude-opus-5-5"), o.get("effort", "xhigh"),
                                  o.get("max_tokens", 128000))
    return out


def run_gpt(run: Run, judge: J.GptJudge, workers: int) -> None:
    try:
        h = judge.health()
    except Exception as e:  # noqa: BLE001 - any failure means the judge is not up
        log(f"gpt judge not reachable at {judge.url} ({e}); start it: bench/aacr/elo/judge-gpt.sh start")
        return
    if h.get("effort") and h["effort"] != judge.effort or h.get("model") and h["model"] != judge.model:
        raise SystemExit(f"the judge container runs {h.get('model')} at {h.get('effort')}, the plan says "
                         f"{judge.model} at {judge.effort}; restart it with the plan's settings")
    todo = run.pending("gpt", set())
    if not todo:
        return
    log(f"gpt: {len(todo)} judgments, {workers} at a time")

    def one(u: dict) -> None:
        ctx, rev = run.context(u["pr"]), run.reviews(u)
        res = judge.judge(ctx, rev)
        run.record("gpt", u, res, judge.model, judge.effort, run.prompt_sha(u))
        log(f"gpt {u['id']} {u['pr']}: {res['status']}"
            + (f" → {res['verdict']['overall']['winner']}" if res["status"] == "ok" else f" ({res.get('error', '')[:160]})"))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, todo))


def run_opus(run: Run, judge: J.OpusJudge, wait: bool) -> None:
    batches = read_jsonl(run.d / "batches.jsonl")
    collected = {b["batch_id"] for b in batches if b.get("collected_at")}
    open_ = [b for b in batches if b.get("submitted_at") and b["batch_id"] not in collected]
    in_flight = {i for b in open_ for i in b["ids"]}
    todo = run.pending("opus", in_flight)
    if todo:
        units = {u["id"]: u for u in todo}
        reqs = [{"custom_id": u["id"], "params": judge.params(run.context(u["pr"]), run.reviews(u))} for u in todo]
        bid = judge.submit(reqs)
        row = {"batch_id": bid, "ids": list(units), "submitted_at": now()}
        append_jsonl(run.d / "batches.jsonl", row)
        open_.append(row)
        log(f"opus: submitted batch {bid} with {len(reqs)} judgments")
    all_units = {u["id"]: u for u in run.units()}
    for b in open_:
        if not wait and judge.status(b["batch_id"]) != "ended":
            log(f"opus batch {b['batch_id']} still running; `elo.py run` again to collect it")
            continue
        judge.wait(b["batch_id"], log=log)
        results = judge.results(b["batch_id"])
        for uid in b["ids"]:
            u = all_units[uid]
            res = results.get(uid, {"status": "error", "error": "missing from the batch results"})
            run.record("opus", u, res, judge.model, judge.effort, run.prompt_sha(u))
        append_jsonl(run.d / "batches.jsonl", {"batch_id": b["batch_id"], "collected_at": now(),
                                               "statuses": dict(Counter(r["status"] for r in results.values()))})
        log(f"opus batch {b['batch_id']} collected: {dict(Counter(r['status'] for r in results.values()))}")


def cmd_run(a) -> None:
    run = Run(Path(a.dir))
    judges = make_judges(run, a.judge)
    cap = int(run.plan.get("cap", 300))
    seed = int(run.plan.get("seed", 1))
    rounds_done = 0
    while True:
        units = run.units()
        if not units:
            new = R.round0(run.runs, run.eligible(), int(run.plan.get("round0_prs", 5)), seed)
            run.add_units(new, 0)
            log(f"round 0: {len(new)} judgments per judge")
        for attempt in range(MAX_ATTEMPTS):
            threads = []
            if "gpt" in judges:
                t = threading.Thread(target=run_gpt, args=(run, judges["gpt"], a.gpt_workers))
                t.start()
                threads.append(t)
            if "opus" in judges:
                run_opus(run, judges["opus"], wait=not a.no_wait)
            for t in threads:
                t.join()
            stuck = {j: len(run.pending(j, set())) for j in judges}
            if not any(stuck.values()) or a.no_wait:
                break
            log(f"retrying what failed: {stuck}")
        if any(stuck.values()):
            log(f"not every judgment of this round is in ({stuck}); `elo.py run` again to collect or retry")
            return
        rounds_done += 1
        if a.rounds is not None and rounds_done >= a.rounds:
            log(f"stopped after {rounds_done} round(s) as asked")
            return
        tables = [R.table(run.runs, run.games(j), reps=300, seed=seed) for j in judges]
        rnd = max(u["round"] for u in run.units()) + 1
        new, why = R.next_round(run.runs, run.eligible(), run.done_prs(), tables,
                                int(run.plan.get("per_pair_step", 3)), cap - len(run.units()), seed + rnd)
        if not new:
            log(f"done: {why}")
            return
        run.add_units(new, rnd)
        log(f"round {rnd}: {len(new)} more judgments per judge")


def usage_summary(rows: List[dict], judge: str) -> str:
    tot: Counter = Counter()
    for r in rows:
        u = r.get("usage") or {}
        if judge == "gpt":
            tot["input"] += int(u.get("prompt_tokens") or 0)
            tot["cached"] += int((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
            tot["output"] += int(u.get("completion_tokens") or 0)
            tot["reasoning"] += int((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
        else:
            tot["input"] += int(u.get("input_tokens") or 0)
            tot["cache_write"] += int(u.get("cache_creation_input_tokens") or 0)
            tot["cache_read"] += int(u.get("cache_read_input_tokens") or 0)
            tot["output"] += int(u.get("output_tokens") or 0)
    s = ", ".join(f"{k} {v:,}" for k, v in tot.items())
    if judge == "opus":
        usd = (tot["input"] * OPUS_BATCH_USD["input"] + tot["output"] * OPUS_BATCH_USD["output"]
               + tot["cache_write"] * OPUS_BATCH_USD["cache_write_1h"] + tot["cache_read"] * OPUS_BATCH_USD["cache_read"]) / 1e6
        s += f" (≈ ${usd:,.2f} at Batch API prices)"
    else:
        s += " (ChatGPT login: subscription quota, not billed per token)"
    return s


def ci(lo: float, hi: float, signed: bool = False) -> str:
    if lo != lo or hi != hi:  # NaN: too few PRs to bootstrap
        return f"n/a (< {R.MIN_BOOTSTRAP_PRS} PRs)"
    return f"{lo:+.0f} … {hi:+.0f}" if signed else f"{lo:.0f} – {hi:.0f}"


def fmt_table(t: dict, labels: Dict[str, str]) -> List[str]:
    out = [f"{t['games']} games over {t['prs']} PRs.", "",
           "| configuration | Elo | 95% CI | W-T-L |", "|---|---:|---|---|"]
    for r in t["rows"]:
        out.append(f"| {labels.get(r['player'], r['player'])} | {r['elo']:.0f} | {ci(r['lo'], r['hi'])} | "
                   f"{r['w']}-{r['t']}-{r['l']} |")
    return out


def cmd_report(a) -> None:
    run = Run(Path(a.dir))
    seed = int(run.plan.get("seed", 1))
    elig = run.eligible()
    out = [f"# Pairwise Elo — {run.plan['name']}", "",
           f"Benchmark `{run.plan['benchmark']}`, set `{run.plan['set']}`, {len(run.cases)} PRs. "
           f"Bradley-Terry fit on the Elo scale (ties = half a win), 95% intervals from a bootstrap over PRs. "
           f"Each judge is rated on its own; nothing is pooled.", "",
           "Reviews present per configuration (a PR where a configuration produced nothing drops out of its pairs): "
           + ", ".join(f"`{r}` {len(elig[r])}/{len(run.cases)}" for r in run.runs), ""]
    labels = run.plan.get("labels") or {}
    if labels:
        out += ["| configuration | run |", "|---|---|"] + [f"| {labels.get(r, r)} | `{r}` |" for r in run.runs] + [""]
    ratings: Dict[str, dict] = {}
    units = run.units()
    for j in JUDGES:
        rows = [r for rs in run.judgments(j).values() for r in rs]
        if not rows:
            continue
        final = run.final(j)
        model = rows[-1].get("model")
        effort = rows[-1].get("effort")
        statuses = Counter(r["status"] for r in rows)
        out += [f"## Judge: {model} at {effort}", "",
                f"{len(final)} of {len(units)} judgments in; attempts by status {dict(statuses)}.", "",
                f"Usage: {usage_summary(rows, j)}.", "", "### Overall", ""]
        t = R.table(run.runs, run.games(j), seed=seed)
        ratings[j] = {"overall": t, "categories": {}}
        out += fmt_table(t, labels) + [""]
        for g in t["gaps"]:
            out.append(f"- {labels.get(g['upper'], g['upper'])} over {labels.get(g['lower'], g['lower'])}: "
                       f"+{g['gap']:.0f} (95% CI {ci(g['lo'], g['hi'], signed=True)})"
                       f"{' — separated' if g['separated'] else ' — not separated'}")
        out.append("")
        for c in J.CATEGORIES:
            tc = R.table(run.runs, run.games(j, c), seed=seed)
            ratings[j]["categories"][c] = tc
            out += [f"### {c}", ""] + fmt_table(tc, labels) + [""]
    if all(j in ratings for j in JUDGES):
        fg, fo = run.final("gpt"), run.final("opus")
        both = sorted(set(fg) & set(fo))
        out += ["## Judge agreement", "", f"Units both judges answered: {len(both)}.", "",
                "| verdict | same winner | opposite winners |", "|---|---:|---:|"]
        for c in (None,) + J.CATEGORIES:
            pick = (lambda v: v["overall"]["winner"]) if c is None else (lambda v, c=c: v["categories"][c]["winner"])
            ag = R.agreement([(pick(fg[i]["verdict"]), pick(fo[i]["verdict"])) for i in both])
            if ag["n"]:
                out.append(f"| {c or 'overall'} | {ag['same_rate']:.0%} | {ag['opposite_rate']:.0%} |")
                ratings.setdefault("agreement", {})[c or "overall"] = ag
        out.append("")
    out += ["Explanations: `elo.py show <dir> --x <run> --y <run>` (every judgment is kept in `judgments/`).", ""]
    (run.d / "REPORT.md").write_text("\n".join(out))
    (run.d / "ratings.json").write_text(json.dumps(ratings, indent=2) + "\n")
    print("\n".join(out))


def cmd_show(a) -> None:
    run = Run(Path(a.dir))
    for j in ([a.judge] if a.judge else JUDGES):
        for row in sorted(run.final(j).values(), key=lambda r: r["id"]):
            if {row["a"], row["b"]} != {a.x, a.y} or (a.pr and row["pr"] != a.pr):
                continue
            v = row["verdict"]
            name = {"A": row["a"], "B": row["b"], "tie": "tie"}
            print(f"=== {j} {row['id']} {row['pr']}  A = {row['a']}  B = {row['b']}")
            print(f"overall: {name[v['overall']['winner']]}")
            print("  " + ", ".join(f"{c}: {name[v['categories'][c]['winner']]}" for c in J.CATEGORIES))
            print(v["overall"]["explanation"])
            if a.reasoning:
                for c in J.CATEGORIES:
                    print(f"\n[{c}] {v['categories'][c]['reasoning']}")
            print()


# ---- self-test -------------------------------------------------------------------------

def self_test() -> None:
    import subprocess
    import tempfile

    # Canonicalisation strips provenance and keeps content.
    f = D.canon_finding("a.py", 3, "[blocker] Title\n\nBody text.\n\n_P1 · confidence 0.95 · lens pass-security,pass-sweep_")
    assert f.severity == "blocking, P1" and f.text == "Title\n\nBody text.", f
    assert D.canon_finding("a.py", 3, "plain text").severity is None
    f = D.canon_finding("a.py", 3, "[nit] N\n\n_nit · confidence 0.80 · contrived · lens pass-sweep, pass-tests_")
    assert f.severity == "nit" and f.text == "N", f
    assert D._clean("- `x.go:3` — Name it _(nit/0.70, pass-duplication)_") == "- `x.go:3` — Name it (nit)"
    assert D._clean("Also: [nit] rename. _(P3 · confidence 0.6 · contrived · pass-a, pass-b)_") == "Also: [nit] rename. (P3)"
    assert D._clean("drift apart (nit · confidence 0.8 · pass-sweep).") == "drift apart (nit)."
    assert D._clean("unqualified? (P3, confidence 0.55, pass-sweep)") == "unqualified? (P3)"
    assert D._clean("a (see confidence below) b") == "a (see confidence below) b"
    assert D._clean("A\n\n<details><summary>Lenses that returned NONE</summary>pass-ui</details>\n\nB") == "A\n\nB"
    body = ("Summary.\n\n- `x.py:3` — thing _(P3/0.80, pass-security,pass-bounds)_\n\n"
            "_Lenses applied: pass-baseline (sol-high), pass-ui (sol-med)_\n\n"
            "_Automated review by `bot[bot]` (quickreview sandbox). Reply to discuss._<!-- qcr:f=1:k -->")
    rv = D.canon_review([{"path": "x.py", "line": 3, "body": "[nit] n"}, {"path": None, "line": None, "body": body}])
    assert rv and rv.body == "Summary.\n\n- `x.py:3` — thing (P3)", repr(rv.body)
    dump = '```json\n[\n  {"file": "x.py", "line": 3, "summary": "s"}\n]\n```\n\nVerification was cut short.'
    rv = D.canon_review([{"path": "x.py", "line": 3, "body": "s"}, {"path": None, "line": None, "body": dump}])
    assert rv and rv.body == "Verification was cut short.", repr(rv.body)
    extra = dump.replace('"line": 3', '"line": 9')
    rv = D.canon_review([{"path": "x.py", "line": 3, "body": "s"}, {"path": None, "line": None, "body": extra}])
    assert rv and '"line": 9' in rv.body  # a dump holding a finding not posted inline is kept
    assert D.canon_review([]) is None and D.canon_review([{"path": None, "line": None, "body": "  "}]) is None
    assert D.fence("a ```` b").startswith("`````")

    # Packing falls back largest-first: whole file → hunks → absent.
    with tempfile.TemporaryDirectory() as tmp:
        def git(*args: str) -> str:
            return subprocess.run(["git", "-C", tmp, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                                  capture_output=True, check=True, text=True).stdout.strip()
        git("init", "-q")
        Path(tmp, "big.py").write_text("\n".join(f"line {i}" for i in range(4000)) + "\n")
        Path(tmp, "small.py").write_text("x = 1\n")
        git("add", "-A"); git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        Path(tmp, "big.py").write_text(Path(tmp, "big.py").read_text().replace("line 2000\n", "line 2000 changed\n"))
        Path(tmp, "small.py").write_text("x = 2\n")
        Path(tmp, "img.bin").write_bytes(b"\0\1\2")
        git("add", "-A"); git("commit", "-qm", "head")
        head = git("rev-parse", "HEAD")
        case = D.Case(iid="t", title="T", body="B", git_dir=str(Path(tmp, ".git")), base=base, head=head,
                      goldens=[D.Golden(text="g", severity="High", category="bug")])
        full = D.pack_context(case, 10 ** 6)
        assert {f["path"]: f["shape"] for f in full["files"]} == {"big.py": "full", "small.py": "full", "img.bin": "absent"}, full["files"]
        assert "2001| line 2000 changed" in full["text"] and "G1. [High · bug]" in full["text"]
        tight = D.pack_context(case, full["tokens"] // 3)
        assert {f["path"]: f["shape"] for f in tight["files"]}["big.py"] == "hunks" and not tight["over_budget"], tight["files"]
        tiny = D.pack_context(case, 300)
        assert {f["path"]: f["shape"] for f in tiny["files"]}["big.py"] == "absent", tiny["files"]

    # The Martian loader: a run in its own directory, one tool picked out of
    # several, and the pool cut to the planned PRs.
    with tempfile.TemporaryDirectory() as tmp:
        sets = json.loads((D.AACR / "sets" / "martian50.json").read_text())["cases"][:2]
        iids = [c["instance_id"] for c in sets]
        def bench(path: Path, reviews_per_pr) -> None:
            data = {f"u{i}": {"golden_comments": [{"comment": "g", "severity": "High"}],
                              "reviews": reviews_per_pr(iid)} for i, iid in enumerate(iids)}
            (path / "results").mkdir(parents=True)
            (path / "results" / "benchmark_data.json").write_text(json.dumps(data))
        bench(Path(tmp, "a", "r1.martian"), lambda iid: [{"tool": "quickreview", "repo_name": iid,
                                                          "review_comments": [{"path": "x", "line": 1, "body": "f"}]}])
        bench(Path(tmp, "b", "r2.martian"), lambda iid: [
            {"tool": "quickreview", "repo_name": iid, "review_comments": [{"path": "y", "line": 2, "body": "q"}]},
            {"tool": "rejudged-other", "repo_name": "x", "review_comments": []}])
        plan = {"benchmark": "martian", "set": "sets/martian50.json", "runs": ["r1", "r2"], "runs_dir": str(Path(tmp, "a")),
                "git_cache": tmp, "run_dirs": {"r2": str(Path(tmp, "b"))}, "tools": {"r2": "quickreview"}, "prs": iids[:1]}
        cases = D.load_cases(plan)
        assert list(cases) == iids[:1] and cases[iids[0]].reviews["r2"].findings[0].text == "q", cases
        try:
            D.load_cases({**plan, "tools": {}})
            raise AssertionError("two reviews per PR were accepted without a tool")
        except SystemExit:
            pass

    # Verdicts are checked against the schema's shape.
    good = {"categories": {c: {"reasoning": "r", "winner": "A"} for c in J.CATEGORIES},
            "overall": {"explanation": "e", "winner": "tie"}}
    assert J.check_verdict(good)["overall"]["winner"] == "tie"
    for bad in ({}, {"categories": {}, "overall": {"winner": "A"}},
                {**good, "overall": {"explanation": "e", "winner": "C"}}):
        try:
            J.check_verdict(bad)
            raise AssertionError(f"accepted {bad}")
        except ValueError:
            pass
    assert set(J.SCHEMA["properties"]["categories"]["required"]) == set(J.CATEGORIES)

    # Bradley-Terry: order, ties, symmetry, finite under a clean sweep.
    sweep = [(f"p{i}", "x", "y", 1.0) for i in range(10)]
    r = R.fit(["x", "y"], sweep)
    assert r["x"] > r["y"] and all(abs(v) < 1e6 for v in r.values())
    even = [(f"p{i}", "x", "y", 0.5) for i in range(10)]
    r = R.fit(["x", "y"], even)
    assert abs(r["x"] - r["y"]) < 1e-6 and abs(r["x"] - 1500) < 1e-6
    chain = [(f"p{i}", a, b, 1.0) for i in range(6) for a, b in (("x", "y"), ("y", "z"))]
    r = R.fit(["x", "y", "z"], chain)
    assert r["x"] > r["y"] > r["z"]
    t = R.table(["x", "y"], sweep, reps=200)
    assert t["rows"][0]["player"] == "x" and t["gaps"][0]["separated"] and t["rows"][0]["w"] == 10
    one_pr = [("p0", "x", "y", 1.0)] * 3
    t = R.table(["x", "y"], one_pr, reps=200)  # one PR: nothing to resample
    assert not t["gaps"][0]["separated"] and t["gaps"][0]["lo"] != t["gaps"][0]["lo"]
    t = R.table(["x", "y"], even, reps=200)
    assert not t["gaps"][0]["separated"]

    # Scheduling: round 0 covers every pair on shared PRs; later rounds only
    # the unseparated adjacent pairs, with fresh PRs, within the cap.
    elig = {"x": ["p1", "p2", "p3", "p4"], "y": ["p1", "p2", "p3", "p4"], "z": ["p2", "p3", "p4"]}
    u0 = R.round0(["x", "y", "z"], elig, 2, seed=1)
    assert len(u0) == 6 and all(u["pr"] in elig[u["x"]] and u["pr"] in elig[u["y"]] for u in u0)
    assert {u["pr"] for u in u0 if {u["x"], u["y"]} == {"x", "y"}} == {u["pr"] for u in u0 if {u["x"], u["y"]} == {"x", "z"}}
    tables = [{"gaps": [{"upper": "x", "lower": "y", "separated": False}, {"upper": "y", "lower": "z", "separated": True}]}]
    done = {R.pair_key("x", "y"): ["p1"]}
    nxt, why = R.next_round(["x", "y", "z"], elig, done, tables, per_pair=5, budget=100, seed=2)
    assert not why and {(u["x"], u["y"]) for u in nxt} == {("x", "y")} and "p1" not in {u["pr"] for u in nxt} and len(nxt) == 3
    assert R.next_round(["x", "y"], elig, done, tables, 5, 0, 2)[0] == []
    sep = [{"gaps": [{"upper": "x", "lower": "y", "separated": True}]}]
    assert R.next_round(["x", "y"], elig, done, sep, 5, 100, 2)[1].startswith("every adjacent gap")
    ag = R.agreement([("A", "A"), ("A", "B"), ("tie", "A")])
    assert ag["same"] == 1 and ag["opposite"] == 1
    print("elo self-test: ok")


def main() -> None:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init"); p.add_argument("plan"); p.add_argument("--dir")
    p = sub.add_parser("pack"); p.add_argument("dir")
    p = sub.add_parser("run"); p.add_argument("dir")
    p.add_argument("--judge", choices=("gpt", "opus", "both"), default="both")
    p.add_argument("--rounds", type=int, default=None, help="stop after N rounds (1 = round 0 only)")
    p.add_argument("--gpt-workers", type=int, default=4)
    p.add_argument("--no-wait", action="store_true", help="submit the Opus batch and return")
    p = sub.add_parser("report"); p.add_argument("dir")
    p = sub.add_parser("show"); p.add_argument("dir"); p.add_argument("--x", required=True); p.add_argument("--y", required=True)
    p.add_argument("--judge", choices=JUDGES); p.add_argument("--pr"); p.add_argument("--reasoning", action="store_true")
    a = ap.parse_args()
    {"init": cmd_init, "pack": cmd_pack, "run": cmd_run, "report": cmd_report, "show": cmd_show}[a.cmd](a)


if __name__ == "__main__":
    main()
