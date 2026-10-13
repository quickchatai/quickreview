#!/usr/bin/env python3
"""Live view of an open-model benchmark arm. Ctrl-C quits; it only reads.

  watch.py --out DIR [--prefix P] [--every 5]

DIR is bench/aacr/artifacts/open-models; P defaults to the newest run prefix.
Per PR: state, minutes, lenses running right now (pi processes in its
container), model replies, provider errors in the last 5 minutes, idle time and
cost (live from the main session's usage; the final figure once it finishes).
"""
import argparse, json, os, re, subprocess, sys, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from models import MODELS  # noqa: E402

PRICE = {}   # set from the run's model (models.py)
SETS = Path(__file__).resolve().parents[1] / "sets"
DIM, RED, GRN, YEL, BOLD, RST = "\033[2m", "\033[31m", "\033[32m", "\033[33m", "\033[1m", "\033[0m"


class Tail:
    """Incremental reader of one pi-events.jsonl."""

    def __init__(self, path: Path):
        self.path, self.off, self.first = path, 0, None
        self.replies, self.errors, self.usage = 0, [], {k: 0 for k in PRICE}

    def read(self):
        try:
            with self.path.open("rb") as f:
                f.seek(self.off)
                chunk = f.read()
        except FileNotFoundError:
            return
        end = chunk.rfind(b"\n") + 1
        self.off += end
        for line in chunk[:end].splitlines():
            if b'"timestamp"' not in line and b'"errorMessage"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") if isinstance(e.get("message"), dict) else None
            if m and m.get("timestamp") and self.first is None:
                self.first = m["timestamp"] / 1000
            if e.get("type") == "message_end" and m and m.get("role") == "assistant":
                self.replies += 1
                u = m.get("usage") or {}
                for k in PRICE:
                    self.usage[k] += u.get(k, 0) or 0
                if m.get("errorMessage"):
                    self.errors.append((m.get("timestamp", 0) / 1000, m["errorMessage"]))


def containers(image: str):
    """case id → lens processes running in its container."""
    out = {}
    ids = subprocess.run(["docker", "ps", "-q", "--filter", f"ancestor={image}"],
                         capture_output=True, text=True).stdout.split()
    for c in ids:
        cmd = subprocess.run(["docker", "inspect", c, "--format", "{{json .Config.Cmd}}"],
                             capture_output=True, text=True).stdout
        m = re.search(r'"--only","([^"]+)"', cmd)
        top = subprocess.run(["docker", "top", c], capture_output=True, text=True).stdout.splitlines()[1:]
        pis = sum(1 for l in top if l.split()[-1:] == ["pi"])
        if m:
            out[m.group(1)] = max(pis - 1, 0)   # minus the PR's main session
    return out


def usd(u):
    return sum(u.get(k, 0) / 1e6 * p for k, p in PRICE.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--prefix")
    ap.add_argument("--every", type=float, default=5)
    ap.add_argument("--once", action="store_true", help="print one frame and exit")
    a = ap.parse_args()
    runs = a.out / "runs"
    image = (a.out / "image.txt").read_text().strip()
    prefix = a.prefix
    if not prefix:
        newest = max(runs.glob("*.arm.json"), key=lambda p: p.stat().st_mtime)
        prefix = re.sub(r"-(glm-[a-z0-9-]+|smoke10|dev10|holdout10|fresh10|rest145|martian50|qodo-pr100)\.arm\.json$", "", newest.name)
    sets = sorted({p.name[len(prefix) + 1:-len(".arm.json")] for p in runs.glob(f"{prefix}-*.arm.json")})
    model = ""
    for rj in runs.glob(f"{prefix}-*/run.json"):
        model = (json.loads(rj.read_text()).get("models") or {}).get("conversation", "").split("/")[-1]
        break
    PRICE.update(MODELS.get(model, {"price": {}})["price"])
    tails = {}
    while True:
        live = containers(image)
        now = time.time()
        rows, totals = [], {"ok": 0, "degraded": 0, "fail": 0, "running": 0, "queued": 0}
        cost_done = cost_live = 0.0
        err5 = 0
        for s in sets:
            try:
                want = [c["instance_id"] for c in json.loads((SETS / f"{s}.json").read_text())["cases"]]
            except FileNotFoundError:
                continue
            for cid in want:
                d = runs / f"{prefix}-{s}" / "cases" / cid
                t = tails.setdefault(cid, Tail(d / "pi-events.jsonl"))
                t.read()
                recent = [e for e in t.errors if e[0] > now - 300]
                err5 += len(recent)
                summ = d / "case-summary.json"
                lenses, mins, cost = "", "", ""
                if summ.is_file():
                    j = json.loads(summ.read_text())
                    ran = {"--".join(p.split("--")[:2]) for p in j.get("executed_passes") or []}
                    missing = len(set(j.get("planned_lenses") or []) - ran)
                    if j.get("status") != "ok":
                        state, key = f"{RED}{j.get('status')}{RST}", "fail"
                    elif missing:
                        state, key = f"{RED}degraded -{missing}{RST}", "degraded"
                    else:
                        state, key = f"{GRN}ok{RST}", "ok"
                    totals[key] += 1
                    mins = f"{(j.get('duration_seconds') or 0) / 60:.0f}"
                    c = usd(j.get("usage") or {})
                    cost_done += c
                    cost = f"${c:.2f}"
                elif cid in live:
                    state = f"{YEL}running{RST}"
                    totals["running"] += 1
                    lenses = str(live[cid])
                    mins = f"{(now - t.first) / 60:.0f}" if t.first else "?"
                    c = usd(t.usage)
                    cost_live += c
                    cost = f"{DIM}${c:.2f}+{RST}"
                else:
                    state = f"{DIM}queued{RST}" if not t.first else f"{DIM}ended?{RST}"
                    totals["queued"] += 1
                idle = ""
                if t.path.is_file() and not summ.is_file():
                    idle = f"{now - t.path.stat().st_mtime:.0f}s"
                er = f"{RED}{len(recent)}{RST}" if recent else "0"
                rows.append((s, cid, state, mins, lenses, t.replies, er, idle, cost))
        out = [f"{BOLD}{model or '?'} — {prefix}{RST}   image {image}   {time.strftime('%H:%M:%S')}",
               f"ok {GRN}{totals['ok']}{RST}   degraded (lenses lost) {RED if totals['degraded'] else ''}{totals['degraded']}{RST}   failed {RED if totals['fail'] else ''}{totals['fail']}{RST}   "
               f"running {YEL}{totals['running']}{RST}   queued {totals['queued']}   "
               f"of {sum(totals.values())}      PR containers {len(live)}   lenses running {sum(live.values())}",
               f"provider errors, last 5 min: {RED if err5 else ''}{err5}{RST}      "
               f"cost: ${cost_done:.2f} finished + ${cost_live:.2f} so far in running PRs (main session only)", "",
               f"{'set':<20}{'PR':<44}{'state':<18}{'min':>5}{'lenses':>8}{'replies':>9}{'err5m':>7}{'idle':>7}{'cost':>9}"]
        for r in rows:
            out.append(f"{r[0]:<20}{r[1][:43]:<44}{r[2]:<27}{r[3]:>5}{r[4]:>8}{r[5]:>9}{r[6]:>{7 + (9 if r[6] != '0' else 0)}}{r[7]:>7}  {r[8]}")
        log = a.out / f"reviews-{prefix}.log"
        if log.is_file():
            out += [""] + [f"{DIM}{l}{RST}" for l in log.read_text(errors="replace").splitlines()[-3:]]
        sys.stdout.write("\033[H\033[2J" + "\n".join(out) + "\n")
        sys.stdout.flush()
        if a.once:
            return
        time.sleep(a.every)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
