#!/usr/bin/env python3
"""Pairwise Elo judge for benchmark configurations.

  elo.py init PLAN.json [--dir D]   create an Elo run directory from a plan
  elo.py pack D                     pack every PR's shared context; no model call
  elo.py repack D [--pr IID ...] [--dry-run]
                                    re-pack from the current packing code; says
                                    which PRs changed and what that invalidates
  elo.py run D [--rounds N] [--judge gpt|opus|both] [--no-wait]
                                    judge round 0, then adaptive rounds
  elo.py report D                   ratings per judge → D/REPORT.md, D/ratings.json
  elo.py show D --x RUN --y RUN [--judge J] [--pr IID]
                                    the judge's explanations for one matchup
  elo.py audit D [--bridge-log judge.jsonl]
                                    one call per judgment: rows, turns, and the
                                    GPT bridge's upstream requests in the window
  elo.py --self-test

A run directory holds the plan, the packed contexts (packs/), the scheduled
judgment units (units.jsonl: PR + which run is Review A and which Review B),
every judge's answers (judgments/<judge>.jsonl, append-only, explanations
included), and the Opus batches (batches.jsonl). Everything is resumable:
`run` first collects what is in flight, then retries what failed (≤ 3
attempts), then schedules the next round. Both judges judge every unit with
the same prompt, so their tables are comparable and their agreement is
measured. A judgment counts only while its recorded prompt sha256 equals the
unit's current prompt (the instructions, the packed context, the two
rendered reviews): re-packing a PR sets its old judgments aside, for every
judge, and its units are judged again. See bench/aacr/elo/README.md.
"""
from __future__ import annotations

import argparse
import calendar
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
# gpt-6.1-sol at API prices, $ per million tokens, per request: past
# GPT_LONG_INPUT input tokens the whole request is billed at the long rates.
# The judge runs on the ChatGPT login, which bills quota; this is what the
# same calls would cost on the API.
GPT_API_USD = {"input": 2.0, "output": 10.0, "cached": 0.10}
GPT_API_LONG_USD = {"input": 4.0, "output": 15.0, "cached": 0.20}
GPT_LONG_INPUT = 272_000
# How far around the GPT judge's first and last judgment `audit` looks for
# the bridge's upstream requests.
AUDIT_WINDOW_S = 300


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} elo: {msg}", flush=True)


def as_read(text: str) -> str:
    """Text as Path.read_text returns it after Path.write_text (universal
    newlines)."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


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
        # Per process: a PR's packed context and a unit's current prompt hash.
        # `repack` drops a PR's entries when it rewrites the pack.
        self._ctx: Dict[str, str] = {}
        self._sha: Dict[str, Optional[str]] = {}
        self._lock = threading.Lock()

    # -- data
    @property
    def cases(self) -> Dict[str, D.Case]:
        if self._cases is None:
            self._cases = D.load_cases(self.plan)
        return self._cases

    def eligible(self) -> Dict[str, List[str]]:
        return {r: sorted(pr for pr, c in self.cases.items() if c.reviews.get(r) is not None) for r in self.runs}

    def pack_path(self, pr: str) -> Path:
        return self.d / "packs" / f"{safe(pr)}.txt"

    def write_pack(self, pr: str, packed: dict, **extra) -> None:
        path = self.pack_path(pr)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(packed["text"])
        append_jsonl(self.d / "packs.jsonl", {"pr": pr, "tokens": packed["tokens"],
                                              "over_budget": packed["over_budget"], "files": packed["files"],
                                              **extra})
        self.forget(pr)

    def forget(self, pr: str) -> None:
        """Drop the cached context and prompt hashes of one PR."""
        with self._lock:
            self._ctx.pop(pr, None)
            self._sha.clear()

    def context(self, pr: str) -> str:
        with self._lock:
            if pr in self._ctx:
                return self._ctx[pr]
            path = self.pack_path(pr)
            if not path.exists():
                packed = D.pack_context(self.cases[pr], self.plan.get("max_prompt_tokens", 400000))
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(packed["text"])
                append_jsonl(self.d / "packs.jsonl", {"pr": pr, "tokens": packed["tokens"],
                                                      "over_budget": packed["over_budget"], "files": packed["files"]})
            self._ctx[pr] = path.read_text()
            return self._ctx[pr]

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

    def current(self, judge: str, rows_by_id: Optional[Dict[str, List[dict]]] = None) -> Dict[str, List[dict]]:
        """id → the attempts made at the unit's CURRENT prompt. An attempt at
        another prompt (the PR re-packed, a review rendered differently) is
        stale: it neither counts as a judgment nor as an attempt."""
        units = {u["id"]: u for u in self.units()}
        out: Dict[str, List[dict]] = {}
        for i, rows in (self.judgments(judge) if rows_by_id is None else rows_by_id).items():
            u = units.get(i)
            sha = self.prompt_sha(u) if u else None
            keep = [r for r in rows if sha is not None and r.get("prompt_sha256") == sha]
            if keep:
                out[i] = keep
        return out

    def stale(self, judge: str) -> List[dict]:
        """The ok judgments set aside because their prompt is no longer the
        unit's current one."""
        js = self.judgments(judge)
        kept = {id(r) for rows in self.current(judge, js).values() for r in rows}
        return [r for rows in js.values() for r in rows if r["status"] == "ok" and id(r) not in kept]

    def final(self, judge: str) -> Dict[str, dict]:
        """id → the ok judgment at the current prompt, for units that have one."""
        return {i: next(r for r in rows if r["status"] == "ok")
                for i, rows in self.current(judge).items() if any(r["status"] == "ok" for r in rows)}

    def pending(self, judge: str, in_flight: set) -> List[dict]:
        js = self.current(judge)
        out = []
        for u in self.units():
            rows = js.get(u["id"], [])
            if u["id"] in in_flight or any(r["status"] == "ok" for r in rows) or len(rows) >= MAX_ATTEMPTS:
                continue
            if self.prompt_sha(u) is None:
                continue  # a review no longer loads: nothing can be judged
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

    def prompt_sha(self, unit: dict) -> Optional[str]:
        """The unit's current prompt hash (cached per process); None when a
        review of the unit no longer loads."""
        uid = unit["id"]
        if uid in self._sha:
            return self._sha[uid]
        case = self.cases.get(unit["pr"])
        if case is None or case.reviews.get(unit["a"]) is None or case.reviews.get(unit["b"]) is None:
            sha = None
        else:
            sha = J.prompt_sha(self.context(unit["pr"]), self.reviews(unit))
        with self._lock:
            self._sha[uid] = sha
        return sha

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
    log(f"largest judge prompt ~{sizes[-1]} tok, median ~{sizes[len(sizes) // 2]} tok (estimate: {D.ESTIMATE_RULE}, an upper bound)")


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
    if which == "deepseek":
        d = cfg.get("deepseek", {})
        out["deepseek"] = J.OpenAICompatJudge(
            "deepseek", d.get("base_url", "https://inference.do-ai.run/v1"), d.get("model", "deepseek-v4.1-flash"),
            d.get("effort", "xhigh"), Path(d.get("env_file") or D.AACR / "digitalocean.env"),
            # Its reasoning can run away (20+ minutes at the 65k output cap
            # on a 170k-token prompt); an answer worth having comes inside
            # two minutes and 16k tokens, so both are hard limits.
            d.get("key_var", "DIGITALOCEAN_API_KEY"), d.get("max_tokens", 16000), timeout_s=d.get("timeout_s", 150))
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
        # The hash of what was SENT, so a pack rewritten mid-call is caught.
        run.record("gpt", u, res, judge.model, judge.effort, J.prompt_sha(ctx, rev))
        log(f"gpt {u['id']} {u['pr']}: {res['status']}"
            + (f" → {res['verdict']['overall']['winner']}" if res["status"] == "ok" else f" ({res.get('error', '')[:160]})"))

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(one, todo))


def run_opus(run: Run, judge: J.OpusJudge, wait: bool, collect_only: bool = False) -> None:
    batches = read_jsonl(run.d / "batches.jsonl")
    collected = {b["batch_id"] for b in batches if b.get("collected_at")}
    open_ = [b for b in batches if b.get("submitted_at") and b["batch_id"] not in collected]
    in_flight = {i for b in open_ for i in b["ids"]}
    todo = [] if collect_only else run.pending("opus", in_flight)
    if todo:
        units = {u["id"]: u for u in todo}
        reqs, shas = [], {}
        for u in todo:
            ctx, rev = run.context(u["pr"]), run.reviews(u)
            reqs.append({"custom_id": u["id"], "params": judge.params(ctx, rev)})
            shas[u["id"]] = J.prompt_sha(ctx, rev)
        bid = judge.submit(reqs)
        row = {"batch_id": bid, "ids": list(units), "shas": shas, "submitted_at": now()}
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
            # The hash of what was submitted; a batch row from before hashes
            # were stored falls back to the current prompt.
            sha = (b.get("shas") or {}).get(uid) or run.prompt_sha(u)
            run.record("opus", u, res, judge.model, judge.effort, sha)
        append_jsonl(run.d / "batches.jsonl", {"batch_id": b["batch_id"], "collected_at": now(),
                                               "statuses": dict(Counter(r["status"] for r in results.values()))})
        log(f"opus batch {b['batch_id']} collected: {dict(Counter(r['status'] for r in results.values()))}")


def cmd_run(a) -> None:
    run = Run(Path(a.dir))
    judges = make_judges(run, a.judge)
    if a.collect_only:
        # Collect the Opus batches already submitted and stop: never submit,
        # never schedule — safe beside a GPT run that adds units.
        if "opus" not in judges:
            raise SystemExit("--collect-only collects Opus batches: use --judge opus")
        run_opus(run, judges["opus"], wait=not a.no_wait, collect_only=True)
        return
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


def cmd_live(a) -> None:
    """Live judgments of hand-picked units — a spot check beside the batch
    (Opus) or a third judge (DeepSeek), recorded as judge `<judge>-live` so
    they never mix with the rated judges."""
    run = Run(Path(a.dir))
    judge = make_judges(run, a.judge)[a.judge]
    name = f"{a.judge}-live"
    units = {u["id"]: u for u in run.units()}
    wanted = [i.strip() for i in a.units.split(",") if i.strip()]
    missing = [i for i in wanted if i not in units]
    if missing:
        raise SystemExit(f"no such unit(s): {', '.join(missing)}")
    done = run.final(name)
    todo = [units[i] for i in wanted if i not in done]
    log(f"{name}: {len(todo)} judgments, {a.workers} at a time ({len(wanted) - len(todo)} already in)")

    def one(u: dict) -> None:
        ctx, rev = run.context(u["pr"]), run.reviews(u)
        res = judge.live(ctx, rev) if a.judge == "opus" else judge.judge(ctx, rev)
        run.record(name, u, res, judge.model, judge.effort, J.prompt_sha(ctx, rev))
        log(f"{name} {u['id']} {u['pr']}: {res['status']}"
            + (f" → {res['verdict']['overall']['winner']}" if res["status"] == "ok" else f" ({res.get('error', '')[:160]})"))

    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        list(pool.map(one, todo))


def gpt_row_usd(u: dict) -> float:
    """One GPT judgment's API-equivalent cost (Chat Completions usage)."""
    inp = int(u.get("prompt_tokens") or 0)
    cached = min(inp, int((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0))
    out = int(u.get("completion_tokens") or 0)
    p = GPT_API_LONG_USD if inp > GPT_LONG_INPUT else GPT_API_USD
    return ((inp - cached) * p["input"] + cached * p["cached"] + out * p["output"]) / 1e6


def opus_row_usd(u: dict) -> float:
    """One Opus judgment's cost at Batch API prices (Messages usage)."""
    return (int(u.get("input_tokens") or 0) * OPUS_BATCH_USD["input"]
            + int(u.get("output_tokens") or 0) * OPUS_BATCH_USD["output"]
            + int(u.get("cache_creation_input_tokens") or 0) * OPUS_BATCH_USD["cache_write_1h"]
            + int(u.get("cache_read_input_tokens") or 0) * OPUS_BATCH_USD["cache_read"]) / 1e6


def usage_summary(rows: List[dict], judge: str) -> str:
    tot: Counter = Counter()
    usd = 0.0
    long_ = 0
    for r in rows:
        u = r.get("usage") or {}
        if judge == "gpt":
            tot["input"] += int(u.get("prompt_tokens") or 0)
            tot["cached"] += int((u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
            tot["output"] += int(u.get("completion_tokens") or 0)
            tot["reasoning"] += int((u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0)
            usd += gpt_row_usd(u)
            long_ += int(u.get("prompt_tokens") or 0) > GPT_LONG_INPUT
        else:
            tot["input"] += int(u.get("input_tokens") or 0)
            tot["cache_write"] += int(u.get("cache_creation_input_tokens") or 0)
            tot["cache_read"] += int(u.get("cache_read_input_tokens") or 0)
            tot["output"] += int(u.get("output_tokens") or 0)
            usd += opus_row_usd(u)
    s = ", ".join(f"{k} {v:,}" for k, v in tot.items())
    if judge == "opus":
        s += f" (≈ ${usd:,.2f} at Batch API prices, per call)"
    else:
        s += (f" (≈ ${usd:,.2f} API-equivalent at gpt-6.1-sol API prices"
              f"{f', {long_} call(s) past {GPT_LONG_INPUT:,} input tokens at the long-context rate' if long_ else ''}; "
              f"the ChatGPT login route bills quota, not dollars)")
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
        statuses = Counter(r["status"] for rs in run.current(j).values() for r in rs)
        stale = run.stale(j)
        out += [f"## Judge: {model} at {effort}", "",
                f"{len(final)} of {len(units)} judgments in; attempts at the current prompts by status "
                f"{dict(statuses)}.", "",
                f"Set aside as stale (the prompt changed since they were made: re-packed context or "
                f"re-rendered reviews): {len(stale)} judgment(s) over {len({r['id'] for r in stale})} unit(s).", "",
                f"Usage (every attempt, stale ones included): {usage_summary(rows, j)}.", "", "### Overall", ""]
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


def cmd_repack(a) -> None:
    """Rewrite packs/<pr>.txt from the current packing code. A PR whose
    context changes loses its judgments (for every judge): they stop
    counting, and its units are judged again by the next `run`."""
    run = Run(Path(a.dir))
    prs = a.pr or sorted(run.cases)
    unknown = [pr for pr in prs if pr not in run.cases]
    if unknown:
        raise SystemExit(f"not in this run: {', '.join(unknown)}")
    units = run.units()
    changed = []
    lost: Counter = Counter()
    for pr in prs:
        packed = D.pack_context(run.cases[pr], run.plan.get("max_prompt_tokens", 400000))
        path = run.pack_path(pr)
        old = path.read_text() if path.exists() else None
        # The judges are sent the pack as read back, and reading a text file
        # turns \r\n and a lone \r into \n: compare in that form.
        if old == as_read(packed["text"]):
            continue
        # A new context changes the prompt of every unit on this PR, so every
        # judgment counting on one of them stops counting.
        on_pr = {u["id"] for u in units if u["pr"] == pr}
        n = {j: len(on_pr & set(run.final(j))) for j in JUDGES}
        lost.update(n)
        changed.append(pr)
        if not a.dry_run:
            run.write_pack(pr, packed, repacked_at=now())
        size = f"new pack, ~{packed['tokens']} tok" if old is None else f"~{D.tokens(old)} → ~{packed['tokens']} tok"
        log(f"{'would re-pack' if a.dry_run else 're-packed'} {pr} ({size}); judgments no longer counting: "
            + ", ".join(f"{j} {n[j]}" for j in JUDGES))
    log(f"{len(changed)} of {len(prs)} PR(s) {'would change' if a.dry_run else 'changed'}; judgments set aside: "
        + ", ".join(f"{j} {lost[j]}" for j in JUDGES))


def _ts(text: str) -> float:
    return float(calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ")))


def cmd_audit(a) -> None:
    """One judgment = one call, checked from the records: per judge, rows vs
    units, rows not marked as a single turn; with the GPT bridge's log, the
    upstream requests in the judge's time window vs its judgments."""
    run = Run(Path(a.dir))
    units = run.units()
    log(f"{len(units)} units")
    for j in JUDGES:
        js = run.judgments(j)
        rows = [r for rs in js.values() for r in rs]
        if not rows:
            log(f"{j}: no judgments recorded")
            continue
        cur = run.current(j)
        answered = [r for r in rows if r.get("status") != "error" or "turns" in r]
        turns = Counter("missing" if r.get("turns") is None else ("1" if r.get("turns") == 1 else "other")
                        for r in answered)
        reasons = Counter(str(r.get("finish_reason") or r.get("stop_reason") or "not recorded") for r in answered)
        retried = sum(1 for r in rows if int(r.get("http_attempts") or 1) > 1)
        log(f"{j}: {len(rows)} rows over {len(js)} of {len(units)} units; statuses {dict(Counter(r['status'] for r in rows))}; "
            f"final at the current prompt {len(run.final(j))}, stale ok {len(run.stale(j))}, "
            f"attempts at the current prompt {sum(len(v) for v in cur.values())}")
        log(f"{j}: answered rows by turns: 1 {turns['1']}, other {turns['other']}, missing {turns['missing']}"
            f"{' (recorded before turns were stored)' if turns['missing'] else ''}; finish/stop reasons {dict(reasons)}; "
            f"rows whose call was retried upstream {retried}")
    if not a.bridge_log:
        return
    gpt = [r for rs in run.judgments("gpt").values() for r in rs if r.get("at")]
    if not gpt:
        log("bridge log: no gpt judgments to compare with")
        return
    t0 = min(_ts(r["at"]) for r in gpt) - AUDIT_WINDOW_S
    t1 = max(_ts(r["at"]) for r in gpt) + AUDIT_WINDOW_S
    reqs = [r for r in read_jsonl(Path(a.bridge_log)) if r.get("ts") and t0 <= _ts(r["ts"]) <= t1]
    with_tools = [r for r in reqs if int(r.get("tools") or 0) > 0 or r.get("calls")]
    ok = [r for r in reqs if r.get("status") == 200]
    attempts = sum(int(r.get("http_attempts") or 1) for r in gpt)
    stamp = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))  # noqa: E731
    log(f"bridge log, {stamp(t0)} … {stamp(t1)} (first/last gpt judgment ± {AUDIT_WINDOW_S // 60} min): "
        f"{len(reqs)} upstream requests ({len(ok)} answered 200, statuses {dict(Counter(str(r.get('status')) for r in reqs))}), "
        f"routes {dict(Counter(str(r.get('route')) for r in reqs))}, items per request {dict(Counter(r.get('items') for r in reqs))}")
    log(f"bridge log: requests carrying tools or answering with a call: {len(with_tools)}")
    log(f"bridge log: {len(reqs)} requests vs {len(gpt)} gpt judgment rows in the window "
        f"(difference {len(reqs) - len(gpt):+d}; extra requests are retries or aborted calls; "
        f"HTTP attempts the rows record: {attempts})")


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
        hashes = lambda salt: "".join(f"example.com/m{i} v1.{i}.0 h1:{salt}{i:04d}Zq8xK2pLm9VbN3cRt7YwE5uHs1Ga=\n"
                                      for i in range(300))
        Path(tmp, "go.sum").write_text(hashes("AAAA"))
        Path(tmp, "web").mkdir()
        Path(tmp, "web", "package-lock.json").write_text('{"lockfileVersion": 3, "packages": {}}\n')
        git("add", "-A"); git("commit", "-qm", "base")
        base = git("rev-parse", "HEAD")
        Path(tmp, "big.py").write_text(Path(tmp, "big.py").read_text().replace("line 2000\n", "line 2000 changed\n"))
        Path(tmp, "small.py").write_text("x = 2\n")
        Path(tmp, "img.bin").write_bytes(b"\0\1\2")
        Path(tmp, "go.sum").write_text(hashes("BBBB"))
        Path(tmp, "web", "package-lock.json").write_text(
            '{"lockfileVersion": 3, "packages": {"node_modules/x": {"integrity": "sha512-QmF0aGVyZWQ1MjM0NTY3ODkw"}}}\n')
        git("add", "-A"); git("commit", "-qm", "head")
        head = git("rev-parse", "HEAD")
        case = D.Case(iid="t", title="T", body="B", git_dir=str(Path(tmp, ".git")), base=base, head=head,
                      goldens=[D.Golden(text="g", severity="High", category="bug")])
        full = D.pack_context(case, 10 ** 6)
        assert {f["path"]: f["shape"] for f in full["files"]} == {
            "big.py": "full", "small.py": "full", "img.bin": "absent",
            "go.sum": "lockfile", "web/package-lock.json": "lockfile"}, full["files"]
        assert "2001| line 2000 changed" in full["text"] and "G1. [High · bug]" in full["text"]
        # Lockfiles: never whole, and their hunks are one summary line each.
        assert "h1:" not in full["text"] and "integrity" not in full["text"], "a lockfile's contents reached the prompt"
        assert "- go.sum: +300 −300 lines (lockfile, hunks omitted)" in full["text"], full["text"][:3000]
        assert "- web/package-lock.json: +1 −1 lines (lockfile, hunks omitted)" in full["text"]
        assert "## go.sum (lockfile: never shown whole" in full["text"] and "diff --git a/small.py" in full["text"]
        assert D.machine_kind("vendor/app.min.js") == "generated" and D.machine_kind("Gemfile_rails4.lock") == "lockfile"
        assert D.machine_kind("tests/__snapshots__/a.snap") is None and D.machine_kind("go.mod") is None
        # The estimate: hash-like runs cost more tokens per character than code.
        code = "def handler(request):\n    return render(request, 'index.html', {'items': items})\n" * 50
        hexy = "".join(f"sha256:{i:04x}9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08\n" for i in range(50))
        assert D.tokens(hexy) / len(hexy) > 2 * D.tokens(code) / len(code), (D.tokens(hexy), D.tokens(code))
        assert D.tokens(code) == int(len(code) / D.CHARS_PER_TOKEN) + 1  # long plain identifiers are not hash-like
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

    _self_test_single_turn_and_validity()
    print("elo self-test: ok")


# ---- self-test: one call per judgment, and prompt-hash validity -------------------------
# (kept apart from self_test()'s other checks, which cover the data layer)

def _self_test_single_turn_and_validity() -> None:
    import contextlib
    import io
    import tempfile
    from types import SimpleNamespace as NS

    verdict = {"categories": {c: {"reasoning": "r", "winner": "A"} for c in J.CATEGORIES},
               "overall": {"explanation": "e", "winner": "B"}}
    vtext = json.dumps(verdict)

    # Both request builders: one turn, no tool key, the json_schema format,
    # and the same three texts for both judges.
    body = J.chat_body("m", "CTX", "REV")
    params = J.opus_params("m", 1000, "xhigh", "CTX", "REV")
    assert not set(J.TOOL_KEYS) & set(body) and not set(J.TOOL_KEYS) & set(params)
    assert [m["content"] for m in body["messages"]] == [params["system"]] + [b["text"] for b in params["messages"][0]["content"]]
    assert len(params["messages"]) == 1 and params["output_config"]["format"]["type"] == "json_schema"
    for bad in ({**body, "tools": []}, {**body, "messages": body["messages"] + [{"role": "assistant", "content": "x"}]},
                {**body, "response_format": {"type": "text"}}):
        try:
            J.check_chat_body(bad)
            raise AssertionError(f"accepted {sorted(bad)}")
        except ValueError:
            pass
    for bad in ({**params, "tool_choice": {"type": "auto"}}, {**params, "messages": params["messages"] * 2},
                {**params, "output_config": {"effort": "xhigh"}}):
        try:
            J.check_opus_params(bad)
            raise AssertionError(f"accepted {sorted(bad)}")
        except ValueError:
            pass

    # GPT answers: only one plain final message counts.
    def chat(finish="stop", content=vtext, n=1, **msg):
        return {"choices": [{"index": i, "finish_reason": finish, "message": {"role": "assistant", "content": content, **msg}}
                            for i in range(n)], "usage": {"prompt_tokens": 10}}
    r = J.parse_chat_response(chat())
    assert r["status"] == "ok" and r["turns"] == 1 and r["finish_reason"] == "stop" and r["verdict"]["overall"]["winner"] == "B", r
    assert J.parse_chat_response(chat(n=2))["status"] == "invalid"
    assert J.parse_chat_response(chat(n=0))["status"] == "invalid"
    r = J.parse_chat_response(chat(finish="tool_calls", content=None, tool_calls=[{"id": "c", "type": "function"}]))
    assert r["status"] == "invalid" and "tool call" in r["error"], r
    assert J.parse_chat_response(chat(tool_calls=[{"id": "c"}]))["status"] == "invalid"
    r = J.parse_chat_response(chat(finish="length", content=vtext[:20]))
    assert r["status"] == "error" and "cut off" in r["error"] and r["finish_reason"] == "length", r
    r = J.parse_chat_response(chat(finish="content_filter"))
    assert r["status"] == "invalid" and "content_filter" in r["error"], r
    assert J.parse_chat_response(chat(content="not json"))["status"] == "invalid"
    assert J.parse_chat_response("nope")["status"] == "invalid"

    # Opus answers, SDK-shaped: end_turn, one text block, no tool block.
    def msg(stop="end_turn", blocks=None, **kw):
        if blocks is None:
            blocks = [NS(type="thinking", thinking="t"), NS(type="text", text=vtext)]
        return NS(stop_reason=stop, content=blocks, usage=NS(input_tokens=5, output_tokens=7), **kw)
    r = J.parse_opus_message(msg())
    assert r["status"] == "ok" and r["turns"] == 1 and r["stop_reason"] == "end_turn" and r["usage"]["output_tokens"] == 7, r
    r = J.parse_opus_message(msg("refusal", [], stop_details=NS(type="refusal", category="cyber")))
    assert r["status"] == "refused" and "cyber" in r["error"], r
    for stop in ("max_tokens", "model_context_window_exceeded"):
        r = J.parse_opus_message(msg(stop))
        assert r["status"] == "error" and "cut off" in r["error"] and r["stop_reason"] == stop, r
    for stop in ("tool_use", "pause_turn", "stop_sequence"):
        assert J.parse_opus_message(msg(stop))["status"] == "invalid", stop
    tool = NS(type="tool_use", id="t", name="x", input={})
    assert J.parse_opus_message(msg(blocks=[NS(type="text", text=vtext), tool]))["status"] == "invalid"
    assert J.parse_opus_message(msg(blocks=[NS(type="server_tool_use"), NS(type="text", text=vtext)]))["status"] == "invalid"
    assert J.parse_opus_message(msg(blocks=[NS(type="text", text=vtext)] * 2))["status"] == "invalid"
    assert J.parse_opus_message(msg(blocks=[]))["status"] == "invalid"

    # Prices, per call.
    assert abs(gpt_row_usd({"prompt_tokens": 200_000, "prompt_tokens_details": {"cached_tokens": 100_000},
                            "completion_tokens": 100_000}) - (0.2 + 0.01 + 1.0)) < 1e-9
    long_ = {"prompt_tokens": 300_000, "prompt_tokens_details": {"cached_tokens": 100_000}, "completion_tokens": 10_000}
    assert abs(gpt_row_usd(long_) - (200_000 * 4 + 100_000 * 0.2 + 10_000 * 15) / 1e6) < 1e-9
    assert "1 call(s) past 272,000" in usage_summary([{"usage": long_}], "gpt")
    assert abs(opus_row_usd({"input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_creation_input_tokens": 1_000_000,
                             "cache_read_input_tokens": 1_000_000}) - 16.10) < 1e-9

    # Prompt-hash validity: a judgment counts only at its unit's current prompt.
    def review(text: str) -> D.Review:
        return D.Review(findings=[D.Finding(path="a.py", line=1, text=text)], body="")
    cases = {pr: D.Case(iid=pr, title=pr, body="", git_dir="", base="b", head="h", goldens=[],
                        reviews={"x": review(f"{pr} x"), "y": review(f"{pr} y")}) for pr in ("p1", "p2")}
    D.LOADERS["_selftest"] = lambda plan: cases
    real_pack = D.pack_context
    packs_made: List[str] = []

    def fake_pack(case, budget, wide_context=60):
        packs_made.append(case.iid)
        text = f"context of {case.iid}, packing v2"
        return {"text": text, "tokens": D.tokens(text), "over_budget": False, "files": []}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "plan.json").write_text(json.dumps({"name": "t", "benchmark": "_selftest", "set": "-", "runs": ["x", "y"]}))
            (d / "packs").mkdir()
            for pr in cases:
                (d / "packs" / f"{pr}.txt").write_text(f"context of {pr}, packing v1")
            u1 = {"id": "u0001", "round": 0, "pr": "p1", "a": "x", "b": "y"}
            u2 = {"id": "u0002", "round": 0, "pr": "p2", "a": "y", "b": "x"}
            for u in (u1, u2):
                append_jsonl(d / "units.jsonl", u)
            run = Run(d)
            sha1, sha2 = run.prompt_sha(u1), run.prompt_sha(u2)
            assert sha1 == J.prompt_sha(run.context("p1"), run.reviews(u1)) and sha1 != sha2
            ok = {"status": "ok", "verdict": verdict, "turns": 1}
            run.record("gpt", u1, ok, "m", "e", sha1)
            run.record("opus", u1, ok, "m", "e", sha1)
            run.record("gpt", u2, ok, "m", "e", "0" * 64)  # made at a prompt that is not the current one
            assert set(run.final("gpt")) == {"u0001"} and set(run.final("opus")) == {"u0001"}
            assert [u["id"] for u in run.pending("gpt", set())] == ["u0002"] and len(run.stale("gpt")) == 1
            assert len(run.games("gpt")) == 1
            # Attempts count only at the current prompt.
            for _ in range(MAX_ATTEMPTS):
                run.record("gpt", u2, {"status": "error", "error": "x"}, "m", "e", "1" * 64)
            assert [u["id"] for u in run.pending("gpt", set())] == ["u0002"]
            for _ in range(MAX_ATTEMPTS):
                run.record("opus", u2, {"status": "error", "error": "x"}, "m", "e", sha2)
            assert run.pending("opus", set()) == []
            # Re-packing p1 sets its judgments aside for both judges.
            D.pack_context = fake_pack
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cmd_repack(argparse.Namespace(dir=str(d), pr=["p1"], dry_run=True))
            assert "would re-pack p1" in out.getvalue() and "gpt 1, opus 1" in out.getvalue(), out.getvalue()
            assert (d / "packs" / "p1.txt").read_text().endswith("v1") and set(Run(d).final("gpt")) == {"u0001"}
            with contextlib.redirect_stdout(io.StringIO()):
                cmd_repack(argparse.Namespace(dir=str(d), pr=["p1"], dry_run=False))
            assert (d / "packs" / "p1.txt").read_text().endswith("v2") and read_jsonl(d / "packs.jsonl")[-1]["pr"] == "p1"
            run = Run(d)
            assert run.final("gpt") == {} and run.final("opus") == {} and run.games("gpt") == []
            assert [u["id"] for u in run.pending("gpt", set())] == ["u0001", "u0002"]
            assert [u["id"] for u in run.pending("opus", set())] == ["u0001"] and len(run.stale("opus")) == 1
            # Re-packing again changes nothing; the cache follows the rewrite in-process.
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cmd_repack(argparse.Namespace(dir=str(d), pr=["p1"], dry_run=False))
            assert "0 of 1 PR(s) changed" in out.getvalue(), out.getvalue()
            # A pack holding \r\n reads back with \n (what the judges are sent):
            # re-packing the same text is no change.
            crlf = {"text": "a\r\nb\rc", "tokens": 1, "over_budget": False, "files": []}
            run.write_pack("p1", crlf)
            assert run.context("p1") == "a\nb\nc" == as_read(crlf["text"])
            D.pack_context = lambda case, budget, wide_context=60: crlf
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cmd_repack(argparse.Namespace(dir=str(d), pr=["p1"], dry_run=False))
            assert "0 of 1 PR(s) changed" in out.getvalue(), out.getvalue()
            D.pack_context = fake_pack
            run.write_pack("p2", fake_pack(cases["p2"], 0))
            assert run.prompt_sha(u2) != sha2 and run.pending("opus", set()) == [u1, u2]

            # Audit: rows by turns, and the bridge log's requests in the window.
            run.record("gpt", u1, {**ok, "finish_reason": "stop", "http_attempts": 2}, "m", "e", run.prompt_sha(u1))
            at = [r["at"] for r in read_jsonl(d / "judgments" / "gpt.jsonl")]
            blog = d / "judge.jsonl"
            for row in ({"ts": at[0], "route": "chat", "tools": 0, "calls": [], "items": 2, "status": 200},
                        {"ts": at[0], "route": "chat", "tools": 0, "calls": [], "items": 2, "status": 502},
                        {"ts": at[-1], "route": "chat", "tools": 1, "calls": ["f"], "items": 2, "status": 200},
                        {"ts": "2001-01-01T00:00:00Z", "route": "chat", "tools": 0, "calls": [], "items": 2, "status": 200}):
                append_jsonl(blog, row)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                cmd_audit(argparse.Namespace(dir=str(d), bridge_log=str(blog)))
            text = out.getvalue()
            assert "3 upstream requests" in text and "answering with a call: 1" in text, text
            assert f"3 requests vs {len(at)} gpt judgment rows" in text and "HTTP attempts the rows record: 7" in text, text
            assert "answered rows by turns: 1 3, other 0, missing 0" in text, text
    finally:
        D.pack_context = real_pack
        D.LOADERS.pop("_selftest", None)


def main() -> None:
    if sys.argv[1:] == ["--self-test"]:
        self_test()
        return
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("init"); p.add_argument("plan"); p.add_argument("--dir")
    p = sub.add_parser("pack"); p.add_argument("dir")
    p = sub.add_parser("repack"); p.add_argument("dir")
    p.add_argument("--pr", action="append", help="re-pack only this PR (repeatable); default every PR")
    p.add_argument("--dry-run", action="store_true", help="say what would change; write nothing")
    p = sub.add_parser("audit"); p.add_argument("dir")
    p.add_argument("--bridge-log", help="the GPT judge bridge's judge.jsonl")
    p = sub.add_parser("run"); p.add_argument("dir")
    p.add_argument("--judge", choices=("gpt", "opus", "both"), default="both")
    p.add_argument("--rounds", type=int, default=None, help="stop after N rounds (1 = round 0 only)")
    p.add_argument("--gpt-workers", type=int, default=4)
    p.add_argument("--no-wait", action="store_true", help="submit the Opus batch and return")
    p.add_argument("--collect-only", action="store_true", help="only collect submitted Opus batches")
    p = sub.add_parser("live", help="judge chosen units live (opus or deepseek), recorded as judge <judge>-live")
    p.add_argument("dir"); p.add_argument("--units", required=True, help="comma-separated unit ids")
    p.add_argument("--judge", choices=("opus", "deepseek"), default="opus")
    p.add_argument("--workers", type=int, default=4)
    p = sub.add_parser("report"); p.add_argument("dir")
    p = sub.add_parser("show"); p.add_argument("dir"); p.add_argument("--x", required=True); p.add_argument("--y", required=True)
    p.add_argument("--judge", choices=JUDGES); p.add_argument("--pr"); p.add_argument("--reasoning", action="store_true")
    a = ap.parse_args()
    {"init": cmd_init, "pack": cmd_pack, "repack": cmd_repack, "run": cmd_run, "report": cmd_report,
     "show": cmd_show, "audit": cmd_audit, "live": cmd_live}[a.cmd](a)


if __name__ == "__main__":
    main()
