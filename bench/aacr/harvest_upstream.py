#!/usr/bin/env python3
"""Turn review-bot reviews HARVESTED from the original upstream PRs into a run
dir the scorers read — an anecdote, never a controlled arm.

    bench/aacr/harvest_upstream.py --api DIR --out RUNS_DIR --prefix upstream-copilot2025 \
        [--bot copilot] [--raw-cache DIR] [--fetch]

--api holds the public GitHub API answers per case, `<iid>.reviews.json`
(GET pulls/{n}/reviews) and `<iid>.comments.json` (GET pulls/{n}/comments),
fetched anonymously. One run dir per set is written,
`<prefix>-<set>/`, holding only the cases the bot reviewed:

  results/all/<iid>.json   the OCR-shaped view every scorer reads
                           (`review.comments[{path,start_line,end_line,content}]`)
  cases/<iid>/review.md    the bot's review body/bodies, as posted (minus the
                           low-confidence block, whose items are comments here)
  cases/<iid>/case-summary.json   what was harvested, per review and comment
  run.json                 provenance: bot, dates, commits reviewed, line mapping

What counts as a finding: every inline comment the bot posted (its span as
GitHub shows it: original_start_line..original_line on the reviewed commit),
plus every item of Copilot's "Comments suppressed due to low confidence" block
in the review body (`**path:line**` + text), which the author saw collapsed.
The overview paragraph and per-file summary table are review body, not
findings.

Line drift: a comment made on a commit OTHER than the AACR head keeps its line
only when that is trivially safe — the file is byte-identical at both commits,
or the commented lines and 3 lines of context either side are identical at the
same line numbers. Otherwise it keeps its path and loses its line (a body
comment). Checking needs the file at both commits: --raw-cache DIR holds
`<sha>/<path>` copies; --fetch fills missing ones anonymously from
raw.githubusercontent.com (no token, ever). A file that cannot be read is
treated as not identical. Standard library only.
"""
import argparse, json, os, re, sys, urllib.error, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SETS = ("smoke10", "dev10", "holdout10", "fresh10", "rest145")
BOTS = {
    "copilot": {
        "logins": ("copilot-pull-request-reviewer[bot]", "Copilot"),
        "name": "GitHub Copilot code review",
        "reviewer": "copilot-pull-request-reviewer (harvested upstream review)",
    },
}
CONTEXT = 3
SUPPRESSED_RE = re.compile(r"<details>\s*<summary>Comments suppressed due to low confidence \(\d+\)</summary>(.*?)</details>", re.S)
ITEM_RE = re.compile(r"^\*\*(?P<path>[^*\n]+?):(?P<line>\d+)\*\*\s*$", re.M)


def load(path):
    with open(path) as f:
        return json.load(f)


def suppressed_items(body):
    """(path, line, text) for each low-confidence item in a review body, and
    the body with that block removed."""
    items = []
    m = SUPPRESSED_RE.search(body or "")
    if not m:
        return items, body or ""
    block = m.group(1)
    heads = list(ITEM_RE.finditer(block))
    for k, h in enumerate(heads):
        end = heads[k + 1].start() if k + 1 < len(heads) else len(block)
        text = block[h.end():end].strip()
        text = re.sub(r"^\*\s+", "", text)
        items.append((h.group("path").strip(), int(h.group("line")), text))
    return items, (body[: m.start()] + body[m.end():]).strip()


def raw_file(cache, repo, sha, path, fetch):
    """The file at `sha`, or None. Cached under cache/<sha>/<path>."""
    if not cache:
        return None
    f = os.path.join(cache, sha, path)
    if os.path.exists(f):
        return open(f, "rb").read()
    if os.path.exists(f + ".missing") or not fetch:
        return None
    url = f"https://raw.githubusercontent.com/{repo}/{sha}/{path}"
    os.makedirs(os.path.dirname(f), exist_ok=True)
    try:
        # Anonymous: no Authorization header, no token from anywhere.
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "qcr-bench-harvest"}), timeout=30) as r:
            data = r.read()
    except urllib.error.HTTPError as e:
        open(f + ".missing", "w").write(f"HTTP {e.code}\n")
        return None
    open(f, "wb").write(data)
    return data


def map_lines(reviewed, head, start, end):
    """'identical-file' | 'identical-context' | None (line dropped)."""
    if reviewed is None or head is None:
        return None
    if reviewed == head:
        return "identical-file"
    a, b = reviewed.split(b"\n"), head.split(b"\n")
    lo, hi = max(start - 1 - CONTEXT, 0), end + CONTEXT
    if hi > len(a) or hi > len(b):
        return None
    return "identical-context" if a[lo:hi] == b[lo:hi] else None


def convert_case(case, reviews, comments, bot, cache, fetch):
    head, repo = case["head_commit"], case["repo"]
    mine = [r for r in reviews if (r.get("user") or {}).get("login") in bot["logins"]]
    findings, bodies, drift = [], [], []

    def add(source, path, start, end, text, commit, review_id, extra=None):
        row = {"source": source, "path": path, "reviewed_commit": commit, "review_id": review_id,
               "reviewed_start_line": start, "reviewed_end_line": end}
        if commit == head:
            row["mapping"] = "at-head"
        else:
            how = map_lines(raw_file(cache, repo, commit, path, fetch), raw_file(cache, repo, head, path, fetch), start, end)
            row["mapping"] = how or "dropped-line"
            drift.append({"path": path, "reviewed_commit": commit, "lines": [start, end], "mapping": row["mapping"]})
        keep = row["mapping"] != "dropped-line"
        findings.append((row, {"path": path, "start_line": start if keep else None,
                               "end_line": end if keep else None, "content": text.strip()}, extra or {}))

    for r in mine:
        items, rest = suppressed_items(r.get("body") or "")
        bodies.append(f"<!-- {r['user']['login']} · review {r['id']} · {r.get('state')} · {r.get('submitted_at')} · commit {r.get('commit_id')} -->\n\n{rest}")
        for path, line, text in items:
            add("body-low-confidence", path, line, line, text, r["commit_id"], r["id"])
    for c in comments:
        if (c.get("user") or {}).get("login") not in bot["logins"] or c.get("in_reply_to_id"):
            continue
        if (c.get("side") or "RIGHT").upper() != "RIGHT":
            continue
        end = c.get("original_line") or c.get("line")
        start = c.get("original_start_line") or end
        add("inline", c["path"], start, end, c.get("body") or "", c.get("original_commit_id") or c.get("commit_id"),
            c.get("pull_request_review_id"), {"created_at": c.get("created_at")})
    summary = {
        "instance_id": case["instance_id"], "arm": "upstream-harvest", "status": "ok",
        "bot": bot["name"], "logins": sorted({r["user"]["login"] for r in mine}),
        "reviews": [{"id": r["id"], "login": r["user"]["login"], "state": r.get("state"),
                     "submitted_at": r.get("submitted_at"), "commit_id": r.get("commit_id"),
                     "at_aacr_head": r.get("commit_id") == head} for r in mine],
        "reviewed_aacr_head": any(r.get("commit_id") == head for r in mine),
        "verdict": "COMMENT" if mine and all(r.get("state") == "COMMENTED" for r in mine) else None,
        "comments": len(findings),
        "by_source": {s: sum(1 for f in findings if f[0]["source"] == s) for s in ("inline", "body-low-confidence")},
        "line_drift": drift,
        "findings": [dict(f[0], **f[2]) for f in findings],
    }
    result = {
        "instance_id": case["instance_id"], "repo": repo, "base_commit": case["base_commit"], "head_commit": head,
        "reviewer": bot["reviewer"],
        "review": {"comments": [f[1] for f in findings]},
        "bench": {"harvest": {"bot": bot["name"], "reviews": summary["reviews"], "by_source": summary["by_source"]}},
    }
    return result, summary, "\n\n---\n\n".join(bodies) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--api", required=True)
    ap.add_argument("--out", required=True, help="the runs dir")
    ap.add_argument("--prefix", required=True)
    ap.add_argument("--bot", default="copilot", choices=sorted(BOTS))
    ap.add_argument("--sets-dir", default=os.path.join(HERE, "sets"))
    ap.add_argument("--raw-cache")
    ap.add_argument("--fetch", action="store_true")
    ap.add_argument("--harvested-at", default=None, help="when the API answers were fetched (provenance)")
    a = ap.parse_args()
    bot = BOTS[a.bot]
    report = {}
    for s in SETS:
        f = os.path.join(a.sets_dir, f"{s}.json")
        if not os.path.exists(f):
            continue
        sj = load(f)
        done = []
        for case in sj["cases"]:
            iid = case["instance_id"]
            rv = os.path.join(a.api, f"{iid}.reviews.json")
            if not os.path.exists(rv):
                continue
            reviews = load(rv)
            if not any((r.get("user") or {}).get("login") in bot["logins"] for r in reviews):
                continue
            cm = os.path.join(a.api, f"{iid}.comments.json")
            if not os.path.exists(cm):
                sys.exit(f"{iid}: the bot reviewed it but {cm} is missing — fetch pulls/{{n}}/comments first")
            result, summary, body = convert_case(case, reviews, load(cm), bot, a.raw_cache, a.fetch)
            done.append((iid, result, summary, body))
        if not done:
            continue
        run = os.path.join(a.out, f"{a.prefix}-{s}")
        os.makedirs(os.path.join(run, "results", "all"), exist_ok=True)
        for iid, result, summary, body in done:
            cd = os.path.join(run, "cases", iid)
            os.makedirs(cd, exist_ok=True)
            json.dump(result, open(os.path.join(run, "results", "all", f"{iid}.json"), "w"), indent=1)
            json.dump(summary, open(os.path.join(cd, "case-summary.json"), "w"), indent=1)
            open(os.path.join(cd, "review.md"), "w").write(body)
        earlier = [iid for iid, _, sm, _ in done if not sm["reviewed_aacr_head"]]
        dates = sorted(r["submitted_at"] for _, _, sm, _ in done for r in sm["reviews"] if r["submitted_at"])
        run_json = {
            "reviewer": None,
            "kind": "harvested-upstream-reviews",
            "note": ("NOT a controlled arm: the bot's own public reviews on the ORIGINAL upstream PRs, "
                     "harvested read-only with anonymous GitHub access. Only PRs whose repo had the bot "
                     "enabled appear; the product version is whatever ran on the review date. Several "
                     "AACR reference comments are LLM rewrites of these very comments, so the "
                     "AACR metric is contaminated in the bot's favour."),
            "bot": bot["name"], "logins": list(bot["logins"]),
            "set": s, "dataset": sj.get("dataset"),
            "cases": [iid for iid, *_ in done],
            "review_dates": [dates[0], dates[-1]] if dates else [],
            "reviewed_earlier_commit": {iid: [r["commit_id"] for r in sm["reviews"]] for iid, _, sm, _ in done if iid in earlier},
            "findings": {"inline": sum(sm["by_source"]["inline"] for _, _, sm, _ in done),
                         "body_low_confidence": sum(sm["by_source"]["body-low-confidence"] for _, _, sm, _ in done)},
            "line_drift_rule": (f"a comment on a commit other than the AACR head keeps its line only if the file is "
                                f"byte-identical at both commits or lines [start-{CONTEXT}, end+{CONTEXT}] are identical "
                                f"at the same numbers; otherwise it is kept as a path-only (body) comment"),
            "line_drift": {iid: sm["line_drift"] for iid, _, sm, _ in done if sm["line_drift"]},
            "harvested_at": a.harvested_at,
            "converter": "bench/aacr/harvest_upstream.py",
            "qcr_commit": None,
        }
        json.dump(run_json, open(os.path.join(run, "run.json"), "w"), indent=1)
        report[s] = run_json["cases"]
    print(json.dumps({s: len(v) for s, v in report.items()}))
    for s, v in report.items():
        print(f"{s}:{','.join(v)}")


if __name__ == "__main__":
    main()
