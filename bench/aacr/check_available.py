#!/usr/bin/env python3
"""Can every benchmark PR still be fetched? Run before a big run, not during it.

    bench/aacr/check_available.py                       # every case of every set in sets/
    bench/aacr/check_available.py --sets full --backups # the 196-PR set and its backups
    bench/aacr/check_available.py --sets fresh10 --json out.json

For each case it asks github.com, anonymously, for the two commits a review
needs — the PR's base and its reviewed head — by sha, one commit object each
(`fetch --depth=1 --filter=tree:0` into a throwaway bare repo: no trees, no
blobs, no API call, so the anonymous 60 req/h REST limit never applies). A
commit a force-push or a deleted fork took away, a repo that was deleted or
made private, and a repo that moved all show up here instead of as a `failed`
case hours into a run. It proves the commits exist; `bench.sh prefetch` is
still what makes a case runnable (it also needs their merge-base). Standard
library and git only; exits 1 when any case is unavailable.
"""
import argparse, concurrent.futures as cf, json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null"}


def git(args, timeout=180):
    try:
        r = subprocess.run(["git", *args], env=ENV, capture_output=True, text=True, timeout=timeout)
        return r.returncode, (r.stderr or r.stdout).strip().splitlines()[-1:] or [""]
    except subprocess.TimeoutExpired:
        return 124, ["timed out"]


def check(case):
    url = f"https://github.com/{case['repo']}.git"
    out = {"instance_id": case["instance_id"], "repo": case["repo"], "sets": case["sets"]}
    code, msg = git(["ls-remote", "--exit-code", url, "HEAD"], timeout=60)
    if code != 0:
        return {**out, "status": "repo-unavailable", "detail": msg[0]}
    with tempfile.TemporaryDirectory(prefix="qcr-avail-") as d:
        git(["init", "--quiet", "--bare", d])
        missing = []
        for role in ("base_commit", "head_commit"):
            code, msg = git(["-C", d, "fetch", "--quiet", "--no-tags", "--depth=1", "--filter=tree:0", url, case[role]])
            if code != 0:
                missing.append(f"{role} {case[role][:12]}: {msg[0]}")
    if missing:
        return {**out, "status": "commit-unavailable", "detail": "; ".join(missing)}
    return {**out, "status": "ok", "detail": ""}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    names = sorted(f[:-5] for f in os.listdir(os.path.join(HERE, "sets")) if f.endswith(".json") and ".labels" not in f)
    ap.add_argument("--sets", default=",".join(names), help=f"comma-separated, of: {', '.join(names)}")
    ap.add_argument("--backups", action="store_true", help="also check each set's backup cases")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--json", help="write every result here")
    a = ap.parse_args()
    cases = {}
    for s in a.sets.split(","):
        d = json.load(open(os.path.join(HERE, "sets", f"{s}.json")))
        for c in d["cases"] + (d.get("backups", []) if a.backups else []):
            cases.setdefault(c["instance_id"], {**c, "sets": []})["sets"].append(s)
    print(f"checking {len(cases)} cases ({a.sets}{' + backups' if a.backups else ''}) against github.com …", file=sys.stderr)
    results = []
    with cf.ThreadPoolExecutor(a.concurrency) as ex:
        for r in ex.map(check, cases.values()):
            results.append(r)
            if r["status"] != "ok":
                print(f"  {r['status']}: {r['instance_id']} ({'/'.join(r['sets'])}) — {r['detail']}", file=sys.stderr)
    bad = [r for r in results if r["status"] != "ok"]
    print(f"{len(results) - len(bad)}/{len(results)} available, {len(bad)} unavailable")
    for r in bad:
        print(f"- {r['instance_id']} [{'/'.join(r['sets'])}] {r['status']}: {r['detail']}")
    if a.json:
        json.dump(results, open(a.json, "w"), indent=2)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
