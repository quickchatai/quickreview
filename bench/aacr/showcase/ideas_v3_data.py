"""The data behind v3's idea-* figures: one builder per figure, called by refresh_v3.py.

idea_<slug>(ctx) returns a JSON-able dict that refresh_v3.py stores at
data/v3.json["ideas"]["idea-<name>"]. ctx carries runs_dir (the archived benchmark runs,
read-only), data_root (its parent: ext-cache/, ext-data/), cases (compare.cases_for(...):
pr -> (set, {defect id: severity}, ground-truth version)), judge_model, arms (tool -> runs,
from aacr-arms.txt and aacr-arms-v3.txt), aacr (bench/aacr) and here (this directory).
Unknown is never zero: a value that cannot be read is None. Standard library only.
Helpers are named _<slug>_*, constants <SLUG>_*.
"""
import collections, hashlib, importlib.util, json, math, os, re, sys

import compare
from refresh import CREDIT, read_specs


# ---------------------------------------------------------------- idea-languages
def idea_languages(ctx):
    """Where the answer key got each AACR-Bench defect, for the NUMBERS caveat on key provenance only (the
    image does not read it). Reads the `provenance` field of defects/<set>.json under ctx.aacr for every
    defect of ctx.cases and returns {"provenance": {class: sorted "<pr>|<defect id>" list}}, the classes
    being "hunt" (the blind expert hunt found it), "reference" (only AACR-Bench's own reference comments
    raised it), "comments" (only benchmarked reviewers' comments did, the later `added_in` additions
    included) and "unknown" (nothing recorded, or the defect or its file unreadable)."""
    out = {"hunt": [], "reference": [], "comments": [], "unknown": []}
    files = {}
    for iid, (s, sevs, _) in sorted(ctx.cases.items()):
        if s not in files:
            files[s] = _languages_defect_file(ctx.aacr, s)
        case = (files[s] or {}).get(iid)
        defects = case.get("defects") if isinstance(case, dict) else None
        rows = {x.get("id"): x for x in defects or [] if isinstance(x, dict)}
        for did in sevs:
            out[_languages_provenance((rows.get(did) or {}).get("provenance"))].append(f"{iid}|{did}")
    return {"provenance": {k: sorted(v) for k, v in sorted(out.items())}}


def _languages_defect_file(aacr, s):
    """The cases of defects/<s>.json, or None when the file is absent or unreadable (unknown, never empty)."""
    try:
        with open(os.path.join(aacr, "defects", f"{s}.json")) as fh:
            cases = json.load(fh)["cases"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return cases if isinstance(cases, dict) else None


def _languages_provenance(p):
    if not isinstance(p, dict):
        return "unknown"
    return ("hunt" if p.get("hunt") else "reference" if p.get("dataset_refs")
            else "comments" if p.get("reviewer_comments") else "unknown")


# ---------------------------------------------------------------- idea-commercial-misses
# Martian's published grading key -> the showcase's tool id (data/tools.json): the top 14 of Martian's
# 50-PR leaderboard (OPUS50 in martian_figs.py), i.e. the 14 "published" rows of data/martian.json.
COMMERCIAL_MISSES_TOOLS = {
    "augment": "augment", "bugbot": "cursor-bugbot", "claude-code": "claude-code", "coderabbit": "coderabbit",
    "copilot-v2": "github-copilot", "cubic-v2": "cubic", "devin": "devin", "gemini-v2": "gemini",
    "gitlab": "gitlab", "greptile-v4-1": "greptile", "macroscope": "macroscope",
    "qodo-extended-v2": "qodo-extended", "qodo-v2": "qodo", "sourcery": "sourcery",
}
# The three tools our judge re-graded from Martian's stored reviews (the same judge as QuickReview).
COMMERCIAL_MISSES_REJUDGED = {"rejudged-claude-code": "claude-code", "rejudged-cubic-v2": "cubic",
                              "rejudged-qodo-extended-v2": "qodo-extended"}
COMMERCIAL_MISSES_QR = "quickreview"
COMMERCIAL_MISSES_QR_LABEL = "QuickReview (latest)"  # QuickReview's row in martian-data.json real_same_judge
COMMERCIAL_MISSES_RUN = "final1-martian50.martian"   # Martian's scoring of QuickReview's frozen build, all 50 PRs
COMMERCIAL_MISSES_REVIEW_RUN = "final1-martian50"    # that build's review run; its .arm.json says when it started
COMMERCIAL_MISSES_JUDGE = "gpt-6.1-sol"
COMMERCIAL_MISSES_OPUS = ("ext-data", "martian-e616e84", "offline", "results",
                          "anthropic_claude-opus-4-5-20251101", "evaluations.json")
# The full golden audit, whose investigators read the code and never any reviewer's output
# (ext/martian-tuning/GOLDEN-AUDIT-FULL.md); a golden it does not hold was audited some other way.
COMMERCIAL_MISSES_BLIND_AUDIT = ("ext", "martian-tuning", "golden-audit-full.json")


def _commercial_misses_martian_real(aacr):
    """bench/aacr/ext/martian_real.py (definitions only), loaded without writing bytecode into the repo."""
    spec = importlib.util.spec_from_file_location("commercial_misses_martian_real",
                                                  os.path.join(aacr, "ext", "martian_real.py"))
    mod = importlib.util.module_from_spec(spec)
    keep = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = keep
    return mod


def _commercial_misses_usable(evals, url, tool):
    """A grading counts only when it is there, was not skipped and logged no error; else it is unknown."""
    e = (evals.get(url) or {}).get(tool)
    return bool(e) and not e.get("skipped") and not (e.get("errors_count") or e.get("errors"))


def _commercial_misses_pr(url):
    m = re.search(r"github\.com/([^/]+/[^/]+)/pull/(\d+)", url)
    return f"{m.group(1)}#{m.group(2)}" if m else url


def _commercial_misses_credits(mr, evals, graders, published, goldens):
    """{(url, i): {tool ids the judge credited}} and {(url, i): {tool ids with no usable grading}}."""
    found, unknown = {}, {}
    for key, sid in graders:
        for u in sorted(published):
            if not _commercial_misses_usable(evals, u, key):
                for i in range(len(published[u]["golden_comments"])):
                    unknown.setdefault((u, i), set()).add(sid)
                continue
            for i in mr.found(evals, key, u, goldens):  # exits if a true positive names no golden
                found.setdefault((u, i), set()).add(sid)
    return found, unknown


def _commercial_misses_started(ctx):
    """The day QuickReview's review run started (its .arm.json), or None when that is not readable."""
    try:
        s = json.load(open(os.path.join(ctx.runs_dir, COMMERCIAL_MISSES_REVIEW_RUN + ".arm.json"))).get("started")
    except (OSError, ValueError):
        return None
    return s[:10] if isinstance(s, str) and re.match(r"\d{4}-\d{2}-\d{2}", s) else None


def _commercial_misses_blind(ctx, published):
    """{(url, i): True} for every golden the full audit judged with its text unchanged, False for the rest;
    None when the audit file is not readable."""
    try:
        audit = json.load(open(os.path.join(ctx.aacr, *COMMERCIAL_MISSES_BLIND_AUDIT)))
    except (OSError, ValueError):
        return None
    held = {(e.get("url"), e.get("idx")): e.get("golden") for e in audit}
    return {(u, i): held.get((u, i)) == g["comment"]
            for u in published for i, g in enumerate(published[u]["golden_comments"])}


def _commercial_misses_fill(ctx, files, out):
    mr = _commercial_misses_martian_real(ctx.aacr)
    published = json.load(open(files["published"]))
    ours = json.load(open(files["ours"]))
    opus = json.load(open(files["opus"]))
    audit = json.load(open(files["audit"]))
    goldens = mr.buckets(published)  # exits if the audit's labels do not line up with the published lists
    order = [(u, i) for u in sorted(published) for i in range(len(published[u]["golden_comments"]))]
    labels = audit["goldens"]
    if set(goldens) != set(order) or len(labels) != len(order) or any(
            goldens[k]["bucket"] != lab["bucket"] or goldens[k]["sev"] != lab["sev"] for k, lab in zip(order, labels)):
        raise ValueError("charts/martian-data.json and martian_real.buckets disagree")
    split = {k: lab.get("split") for k, lab in zip(order, labels)}
    by_pr = {}
    for (u, _), sp in split.items():
        by_pr.setdefault(u, set()).add(sp)
    if set(by_pr) != set(published) or any(len(s) != 1 or None in s for s in by_pr.values()):
        raise ValueError("a Martian PR without exactly one tune20/test30 split")
    prs = {u: next(iter(s)) for u, s in by_pr.items()}

    graded = [(COMMERCIAL_MISSES_QR, COMMERCIAL_MISSES_QR)]
    found, unknown = _commercial_misses_credits(mr, ours, graded, published, goldens)
    f2, u2 = _commercial_misses_credits(mr, opus, sorted(COMMERCIAL_MISSES_TOOLS.items()), published, goldens)
    for src, dst in ((f2, found), (u2, unknown)):
        for k, v in src.items():
            dst.setdefault(k, set()).update(v)
    same, same_unknown = _commercial_misses_credits(mr, ours, sorted(COMMERCIAL_MISSES_REJUDGED.items()),
                                                    published, goldens)

    # the real-golden counts the showcase's Martian chart already prints (martian-data.json) must not move
    real = [k for k in order if goldens[k]["bucket"] == "real"]
    pub, sj = audit.get("real_published_opus", {}), audit.get("real_same_judge", {})
    checks = [(sid, found, pub[key]["real"]) for key, sid in COMMERCIAL_MISSES_TOOLS.items() if key in pub]
    checks += [(sid, same, sj[key[len("rejudged-"):]]["real"]) for key, sid in COMMERCIAL_MISSES_REJUDGED.items()
               if key[len("rejudged-"):] in sj]
    if COMMERCIAL_MISSES_QR_LABEL in sj:
        checks.append((COMMERCIAL_MISSES_QR, found, sj[COMMERCIAL_MISSES_QR_LABEL]["real"]))
    bad = [(sid, sum(sid in credits.get(k, ()) for k in real), want) for sid, credits, want in checks
           if sum(sid in credits.get(k, ()) for k in real) != want]
    if bad:
        raise ValueError(f"real goldens found differ from charts/martian-data.json (tool, got, want): {bad}")

    blind = _commercial_misses_blind(ctx, published)
    rows = []
    for k in order:  # every golden of the 50 PRs, in every bucket: the figure draws 'real', NUMBERS.md the rest
        u, i = k
        g = {"id": f"{_commercial_misses_pr(u)}.{i}", "pr": _commercial_misses_pr(u), "split": split[k],
             "severity": goldens[k]["sev"], "category": published[u]["golden_comments"][i].get("category"),
             "bucket": goldens[k]["bucket"], "blind": None if blind is None else blind[k],
             "found_by": sorted(found.get(k, ())),
             "same_judge": None if same_unknown.get(k) else sorted(same.get(k, ()))}
        if unknown.get(k):
            g["unknown"] = sorted(unknown[k])
        rows.append(g)

    issues = {}  # Martian's step-2 extracted issues per reviewer and split (None when any PR is unknown)
    for key, sid, ev in [(COMMERCIAL_MISSES_QR, COMMERCIAL_MISSES_QR, ours)] + [
            (key, sid, opus) for key, sid in sorted(COMMERCIAL_MISSES_TOOLS.items())]:
        issues[sid] = {}
        for sp in sorted(set(prs.values())):
            us = [u for u in sorted(prs) if prs[u] == sp]
            ok = all(_commercial_misses_usable(ev, u, key) and ev[u][key].get("total_candidates") is not None
                     for u in us)
            issues[sid][sp] = sum(ev[u][key]["total_candidates"] for u in us) if ok else None

    dates = {}  # the date suffix of the repository Martian made for each vendor's reviews
    for u in sorted(published):
        for r in published[u].get("reviews") or []:
            if r.get("tool") in COMMERCIAL_MISSES_TOOLS:
                m = re.search(r"__(\d{4})(\d{2})(\d{2})$", r.get("repo_name") or "")
                if m:
                    dates.setdefault(COMMERCIAL_MISSES_TOOLS[r["tool"]], set()).add("-".join(m.groups()))
    out.update(goldens=rows, prs={_commercial_misses_pr(u): sp for u, sp in sorted(prs.items())}, issues=issues,
               review_dates={sid: [min(d), max(d)] for sid, d in sorted(dates.items())},
               qr_review_started=_commercial_misses_started(ctx))


def idea_commercial_misses(ctx):
    """Martian's 50 PRs: every one of the 173 golden comments with its audit bucket (real / notreal /
    disputed, charts/martian-data.json), its PR, the PR's tune20/test30 split, Martian's severity and
    category, whether the full blind audit judged it, and which reviewers the judge credited with it: the
    14 commercial tools by Martian's published Opus 4.5 grading, QuickReview (frozen build,
    final1-martian50) by our gpt-6.1-sol judge, and (same_judge) the three tools that judge re-graded —
    all through martian_real.py's buckets()/found(). Also every PR's split, each reviewer's extracted
    issues per split, the dates of the vendors' reviews and the day QuickReview's run started. A grading
    that is missing, skipped or errored is listed under `unknown`, never read as "not found". Missing
    inputs, a failed join or a count that no longer matches martian-data.json give goldens = None and
    say why (`missing` / `error`): this figure then draws its "not available" page, and the rest of the
    showcase still builds."""
    run = os.path.join(ctx.runs_dir, COMMERCIAL_MISSES_RUN)
    files = {"published": os.path.join(run, "published-benchmark_data.json"),
             "ours": os.path.join(run, "results", COMMERCIAL_MISSES_JUDGE, "evaluations.json"),
             "opus": os.path.join(ctx.data_root, *COMMERCIAL_MISSES_OPUS),
             "audit": os.path.join(ctx.aacr, "charts", "martian-data.json"),
             "martian_real": os.path.join(ctx.aacr, "ext", "martian_real.py")}
    out = {"tools": {sid: key for key, sid in sorted(COMMERCIAL_MISSES_TOOLS.items())},
           "same_judge_tools": sorted(COMMERCIAL_MISSES_REJUDGED.values()),
           "run": COMMERCIAL_MISSES_RUN, "judge": COMMERCIAL_MISSES_JUDGE,
           "goldens": None, "prs": None, "issues": None, "review_dates": None, "qr_review_started": None}
    missing = sorted(k for k, p in files.items() if not os.path.exists(p))
    if missing:
        out["missing"] = missing
        return out
    try:
        _commercial_misses_fill(ctx, files, out)
    except (SystemExit, ValueError) as e:  # martian_real sys.exit()s on a failed join; the cross-checks raise
        out.update(goldens=None, prs=None, issues=None, review_dates=None, qr_review_started=None,
                   error=str(e) or type(e).__name__)
        print(f"idea-commercial-misses: not available: {out['error']}", file=sys.stderr)
    return out


# ---------------------------------------------------------------- idea-robust
ROBUST_SOURCES = ("hunt", "dataset_refs", "reviewer_comments")


def _robust_sources(p):
    """The sources that put one defect in the key, by the paper's reading of `provenance`
    (charts.py, 'The independence check'): `hunt` truthy (True, or a non-empty list of hunt
    ids in fresh10), `dataset_refs` non-empty, `reviewer_comments` non-empty. A defect with
    no provenance record is unknown (None), never "no sources"."""
    if not isinstance(p, dict):
        return None
    return sorted(k for k in ROBUST_SOURCES if p.get(k))


def idea_robust(ctx):
    """Where each scored AACR defect came from. Reads bench/aacr/defects/<set>.json for every
    set in ctx.cases and returns, keyed "<pr>|<defect id>" for the defects ctx.cases scores:
    `provenance` -> the sources that raised it (a sorted subset of dataset_refs / hunt /
    reviewer_comments; None when the defect carries no provenance record, or is missing from
    its set's file), and `benchmark_limitation` -> the sorted keys of the defects the key itself
    flags as CI-gate defects a read-only review can only find by knowing the repo's CI.
    The figure takes credits and severities from data/aacr.json and set membership from
    data/v3.json; this is the one thing neither holds."""
    files = {}
    for s in sorted({s for s, _, _ in ctx.cases.values()}):
        files[s] = json.load(open(os.path.join(ctx.aacr, "defects", f"{s}.json")))["cases"]
    prov, limited = {}, []
    for iid in sorted(ctx.cases):
        s, sevs, _ = ctx.cases[iid]
        listed = {x["id"]: x for x in (files[s].get(iid) or {}).get("defects", [])}
        for did in sorted(sevs):
            x = listed.get(did)
            key = f"{iid}|{did}"
            prov[key] = None if x is None else _robust_sources(x.get("provenance"))
            if x is not None and x.get("benchmark_limitation"):
                limited.append(key)
    return {"provenance": prov, "benchmark_limitation": sorted(limited)}


# ---------------------------------------------------------------- idea-skip-nits
# QuickReview tags every comment [blocker], [question] or [nit]; a defect's "best tag" is the
# strongest tag among the comments the judge credited for it, in this order.
SKIP_NITS_TAGS = ("blocker", "question", "nit")
SKIP_NITS_CATS = SKIP_NITS_TAGS + ("other", "body")  # other: any other tag or none; body: no comment listed
SKIP_NITS_HELDOUT = ("holdout10", "fresh10")  # never used for tuning
# JavaScript's \s, which is also String.prototype.trim's set: src/bench/defects.ts runs in Node.
SKIP_NITS_WS = "\t\n\x0b\x0c\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
SKIP_NITS_TAG_RE = re.compile(r"^[" + SKIP_NITS_WS + r"]*\[([a-zA-Z][a-zA-Z ]*)\][" + SKIP_NITS_WS + r"]*")
SKIP_NITS_FOOTER_RE = re.compile(r"\n*_P[0-9][^\n]*_[" + SKIP_NITS_WS + r"]*\Z")
SKIP_NITS_TRIM_RE = re.compile(r"^[" + SKIP_NITS_WS + r"]+|[" + SKIP_NITS_WS + r"]+\Z")
SKIP_NITS_SURROGATE_RE = re.compile("[\ud800-\udfff]")
SKIP_NITS_MAX_BODY = 12000
SKIP_NITS_LEFT = " (deleted line)"


def _skip_nits_text(path):
    """A file's text as Node reads it (invalid UTF-8 replaced), or None when it is absent."""
    try:
        with open(path, "rb") as f:
            return f.read().decode("utf-8", errors="replace")
    except OSError:
        return None


def _skip_nits_json(path):
    try:
        return json.loads(_skip_nits_text(path))
    except (TypeError, ValueError):
        return None


def _skip_nits_trim(s):
    return SKIP_NITS_TRIM_RE.sub("", s)


def _skip_nits_num(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return int(v) if isinstance(v, float) and v.is_integer() else v


def _skip_nits_comment(n, raw, path, line, end):
    m = SKIP_NITS_TAG_RE.match(raw)
    text = _skip_nits_trim(SKIP_NITS_FOOTER_RE.sub("", SKIP_NITS_TAG_RE.sub("", raw, count=1), count=1))
    return {"id": f"C{n}", "path": path, "line": line, "end_line": end,
            "tag": m.group(1).lower() if m else None, "text": text}


def _skip_nits_claude_rows(result):
    """src/bench/claudeshape.ts claudeRowsForJudge: a Claude Code result written before the
    OCR-shaped view, read the way the harness's scorer reads it (every finding whose summary +
    failure_scenario is not blank, at its one line). None for a file that is not one."""
    if not isinstance(result, dict) or "review_output" not in result:
        return None
    found = result["review_output"]
    rows = []
    for f in found if isinstance(found, list) else []:
        if not isinstance(f, dict):
            continue
        parts = [_skip_nits_trim(f[k]) if isinstance(f.get(k), str) else "" for k in ("summary", "failure_scenario")]
        note = _skip_nits_trim("\n".join(s for s in parts if s))
        if not note:
            continue
        line = _skip_nits_num(f.get("line"))
        line = line if line is not None and math.isfinite(line) else None
        rows.append({"path": f["file"] if isinstance(f.get("file"), str) else "", "start_line": line,
                     "end_line": line, "content": note})
    return rows


def _skip_nits_review(run_dir, iid):
    """The review exactly as src/bench/defects.ts reviewForJudge hands it to the judge: the rows of
    results/all/<iid>.json (claudeshape.ts's rows for an older Claude Code file), then the
    deleted-line rows of cases/<iid>/comments.json, numbered C1..Cn. Returns (review, repeats,
    inline): repeats are the ids of deleted-line rows that repeat a results/all row (same file, tag
    and text); inline are the ids of the other comments posted inline, i.e. matched one to one to a
    row of cases/<iid>/comments.json (the rest of results/all is findings posted in the review
    body), or None when that file cannot be read."""
    scored = _skip_nits_json(os.path.join(run_dir, "results", "all", f"{iid}.json"))
    review = scored.get("review") if isinstance(scored, dict) else None
    rows = review.get("comments") if isinstance(review, dict) else None
    if rows is None:
        rows = _skip_nits_claude_rows(scored)
    comments = []
    for row in rows if isinstance(rows, list) else []:
        r = row if isinstance(row, dict) else {}
        raw = r["content"] if isinstance(r.get("content"), str) else ""
        if not _skip_nits_trim(raw):
            continue
        line = _skip_nits_num(r.get("start_line"))
        end = _skip_nits_num(r.get("end_line"))
        comments.append(_skip_nits_comment(len(comments) + 1, raw, r["path"] if isinstance(r.get("path"), str) else None,
                                           line, line if end is None else end))
    posted = _skip_nits_json(os.path.join(run_dir, "cases", iid, "comments.json"))
    posted = [r if isinstance(r, dict) else {} for r in posted] if isinstance(posted, list) else None
    unmatched = collections.Counter()  # comments.json rows by (file, tag, text), as the judge's text reads
    for r in posted or []:
        c = _skip_nits_comment(0, r["body"] if isinstance(r.get("body"), str) else "",
                               r["path"] if isinstance(r.get("path"), str) else None, None, None)
        unmatched[(c["path"], c["tag"], c["text"])] += 1
    inline = set()
    for c in comments:
        k = (c["path"], c["tag"], c["text"])
        if unmatched[k] > 0:
            unmatched[k] -= 1
            inline.add(c["id"])
    main = {(c["path"], c["tag"], c["text"]) for c in comments}
    repeats = set()
    for r in posted or []:
        if not isinstance(r.get("side"), str) or r["side"].upper() != "LEFT":
            continue
        raw = r["body"] if isinstance(r.get("body"), str) else ""
        if not _skip_nits_trim(raw):
            continue
        line = _skip_nits_num(r.get("line"))
        path = r["path"] if isinstance(r.get("path"), str) else None
        c = _skip_nits_comment(len(comments) + 1, raw, None if path is None else path + SKIP_NITS_LEFT, line, line)
        if path is not None and (path, c["tag"], c["text"]) in main:
            repeats.add(c["id"])  # the harness re-anchored it into results/all AND appended it here
        else:
            inline.add(c["id"])  # taken from comments.json itself
        comments.append(c)
    summary = _skip_nits_json(os.path.join(run_dir, "cases", iid, "case-summary.json"))
    body = _skip_nits_text(os.path.join(run_dir, "cases", iid, "review.md"))
    body = None if body is None else _skip_nits_trim(body)
    if body:
        u16 = body.encode("utf-16-le", "surrogatepass")
        if len(u16) // 2 > SKIP_NITS_MAX_BODY:
            body = u16[:2 * SKIP_NITS_MAX_BODY].decode("utf-16-le", "surrogatepass") + "\n[\u2026 body truncated]"
    verdict = summary.get("verdict") if isinstance(summary, dict) else None
    return ({"verdict": verdict if isinstance(verdict, str) else None, "body": body or None, "comments": comments},
            repeats, inline if posted is not None else None)


def _skip_nits_hash(review):
    """defects.ts reviewHash: sha256 of JSON.stringify(review) (lone surrogates escaped, as JS does)."""
    s = json.dumps(review, ensure_ascii=False, separators=(",", ":"))
    s = SKIP_NITS_SURROGATE_RE.sub(lambda m: "\\u%04x" % ord(m.group()), s)
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def _skip_nits_arm(ctx, runs):
    """One reviewer over every PR: whole-review credit and comment counts, and (for a reviewer that
    tags its comments) the same split by tag. Unknown stays None, never 0."""
    credit = collections.Counter()
    prs = rows = posted = repeats = words = 0
    tag_rows, tag_posted, tag_repeats, tag_words, tag_inline = (collections.Counter() for _ in range(5))
    by_cat = {g: {s: collections.Counter() for s in ("high", "medium", "low")} for g in ("all", "heldout")}
    nit_also = collections.Counter()  # credited defects listing a nit beside a stronger tag
    hash_checked = hash_match = 0
    unaligned, no_inline = [], []
    for iid, (set_name, sevs, version) in sorted(ctx.cases.items()):
        j = run = None
        for run in runs:
            j = compare.judgement(ctx.runs_dir, run, iid, version, ctx.judge_model)
            if j is not None:
                break
        if j is None:
            continue
        prs += 1
        review, rep, inline = _skip_nits_review(os.path.join(ctx.runs_dir, run), iid)
        if inline is None:
            no_inline.append(iid)
        judged = [c.get("id") if isinstance(c, dict) else None for c in j.get("comments") or []]
        rows += len(judged)
        if sorted(map(str, judged)) != sorted(c["id"] for c in review["comments"]):
            unaligned.append(iid)
        elif "review_hash" in j:
            hash_checked += 1
            hash_match += j["review_hash"] == _skip_nits_hash(review)
        tag = {c["id"]: (c["tag"] if c["tag"] in SKIP_NITS_TAGS else "other") for c in review["comments"]}
        for c in review["comments"]:
            if c["id"] in rep:
                repeats += 1
                tag_repeats[tag[c["id"]]] += 1
            else:
                posted += 1
                words += len(c["text"].split())
                tag_posted[tag[c["id"]]] += 1
                tag_words[tag[c["id"]]] += len(c["text"].split())
                if inline is not None and c["id"] in inline:
                    tag_inline[tag[c["id"]]] += 1
        for cid in judged:
            tag_rows[tag.get(cid, "other")] += 1
        verdict = {d.get("id"): d for d in j.get("defects") or [] if isinstance(d, dict)}
        for did, sev in sevs.items():
            d = verdict.get(did) or {}
            cr = CREDIT.get(d.get("verdict", "missed"), 0.0)
            credit[sev] += cr
            if not cr:
                continue
            ids = d.get("comments") or []
            tags = {tag.get(cid, "other") for cid in ids}
            best = next((t for t in SKIP_NITS_TAGS if t in tags), "other" if ids else "body")
            for g in ("all", "heldout") if set_name in SKIP_NITS_HELDOUT else ("all",):
                by_cat[g][sev][best] += cr
            if "nit" in tags and best in ("blocker", "question"):
                nit_also[sev] += 1
    out = {"prs_judged": prs, "rows": rows, "posted": posted if not unaligned else None,
           "repeats": repeats if not unaligned else None, "words": words if not unaligned else None,
           "credit": {s: credit[s] for s in ("high", "medium", "low")}}
    if any(tag_rows[t] for t in SKIP_NITS_TAGS):  # a reviewer that tags its comments
        ok = not unaligned
        out["tags"] = {
            "unaligned": unaligned, "hash_checked": hash_checked, "hash_match": hash_match,
            "rows": {t: tag_rows[t] for t in SKIP_NITS_CATS[:4]} if ok else None,
            "posted": {t: tag_posted[t] for t in SKIP_NITS_CATS[:4]} if ok else None,
            "repeats": {t: tag_repeats[t] for t in SKIP_NITS_CATS[:4]} if ok else None,
            "words": {t: tag_words[t] for t in SKIP_NITS_CATS[:4]} if ok else None,
            # posted inline (cases/<iid>/comments.json); the rest of "posted" is in the review body
            "inline": {t: tag_inline[t] for t in SKIP_NITS_CATS[:4]} if ok and not no_inline else None,
            "credit": {s: {c: by_cat["all"][s][c] for c in SKIP_NITS_CATS} for s in by_cat["all"]} if ok else None,
            "credit_heldout": {s: {c: by_cat["heldout"][s][c] for c in SKIP_NITS_CATS} for s in by_cat["heldout"]}
            if ok else None,
            "nit_also": {s: nit_also[s] for s in ("high", "medium", "low")} if ok else None,
        }
    return out


def idea_skip_nits(ctx):
    """QuickReview's comments by tag, and what each tag carries. For every AACR arm in ctx.arms and
    every PR, reads the first judged round-1 judgement (compare.judgement) and rebuilds the review it
    judged exactly as src/bench/defects.ts reviewForJudge does (results/all rows, then the
    deleted-line rows of cases/<iid>/comments.json), proving the rebuild against the judge's
    review_hash. Returns per arm: judged comment rows, posted comments (rows minus deleted-line rows
    the harness also re-anchored into results/all, which the judge saw twice), words, and
    whole-review credit by severity; and for a reviewer that tags its comments the same by tag, how
    many of its posted comments are inline (the rest are findings in the review body), and each
    credited defect's credit under the strongest tag among its credited comments (blocker >
    question > nit > other; body when no comment is listed), over all PRs and the held-out sets."""
    sev_n = collections.Counter(s for _, sevs, _ in ctx.cases.values() for s in sevs.values())
    return {"judge": ctx.judge_model, "prs": len(ctx.cases),
            "defects": {s: sev_n[s] for s in ("high", "medium", "low")},
            "heldout_sets": list(SKIP_NITS_HELDOUT),
            "heldout_prs": sum(1 for st, _, _ in ctx.cases.values() if st in SKIP_NITS_HELDOUT),
            "heldout_defects": dict(sorted(collections.Counter(
                s for _, (st, sevs, _) in ctx.cases.items() if st in SKIP_NITS_HELDOUT for s in sevs.values()).items())),
            "reviewers": {tool: _skip_nits_arm(ctx, runs) for tool, runs in sorted(ctx.arms.items())}}


# ---------------------------------------------------------------- idea-funnel
FUNNEL_TOOL = "quickreview"
# src/findingsrecord.ts: the closed disposition set, the spellings folded onto it, and the
# kill words that are a doubt about the claim (a 'killed' entry carrying one is 'doubted').
FUNNEL_CLOSED = ("posted", "killed", "doubted", "downgraded", "merged", "folded", "withheld", "conceded")
FUNNEL_ALIASES = {"post": "posted", "survive": "posted", "survived": "posted", "kill": "killed",
                  "vetoed": "killed", "doubt": "doubted", "may-not-be-valid": "doubted",
                  "downgrade": "downgraded", "demoted": "downgraded", "capped": "downgraded",
                  "merge": "merged", "fold": "folded", "withhold": "withheld", "dropped": "withheld",
                  "concede": "conceded", "refuted-and-conceded": "conceded", "refuted_and_conceded": "conceded"}
FUNNEL_DOUBT_WORDS = ("refuted", "unverifiable", "bad-anchor")
# A 'downgraded' entry that says it was posted (or sits by a posted entry of a shared lens) is the
# pre-downgrade copy of that posted entry, not a candidate of its own; 'omitted' / 'not posted' wins.
FUNNEL_COPY_TEXT = re.compile(r"\bposted as\b|\bretained as\b|\bsurvives as\b|\bsurvives in\b", re.I)
FUNNEL_NOT_POSTED_TEXT = re.compile(r"\bnot posted\b|\bomitted\b", re.I)
FUNNEL_COPY_LINES = 3
FUNNEL_VALIDATOR = "pass-validate"
FUNNEL_TAGS = ("blocker", "question", "nit")
FUNNEL_GRADES = ("correct-valuable", "correct-minor", "partly-correct", "incorrect", "unverifiable")
FUNNEL_RECORD_KEYS = ("raised", "copies", "merged", "folded", "distinct", "killed", "doubted", "withheld",
                      "held_downgraded", "other", "posted", "posted_blocker", "posted_question", "posted_nit",
                      "posted_other", "synth")


def _funnel_load(path):
    """A JSON file, or None when it is absent or unreadable (unknown, never empty)."""
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _funnel_disposition(f):
    v = re.sub(r"\s+", "-", str(f.get("disposition") or "").strip().lower())
    d = v if v in FUNNEL_CLOSED else FUNNEL_ALIASES.get(v, "unknown")
    word = f.get("word") or f.get("reason_word")
    if d == "killed" and isinstance(word, str) and word.strip().lower() in FUNNEL_DOUBT_WORDS:
        return "doubted"
    return d


def _funnel_lenses(f, sep=r","):
    return {x.strip() for x in re.split(sep, str(f.get("lens") or "")) if x.strip()}


def _funnel_line(f):
    try:
        return int(f.get("line"))
    except (TypeError, ValueError):
        return None


def _funnel_is_copy(entry, posted):
    reason = str(entry.get("reason") or "")
    if FUNNEL_NOT_POSTED_TEXT.search(reason):
        return False
    if FUNNEL_COPY_TEXT.search(reason):
        return True
    line, lenses = _funnel_line(entry), _funnel_lenses(entry)
    return line is not None and any(
        p.get("path") == entry.get("path") and _funnel_line(p) is not None
        and abs(_funnel_line(p) - line) <= FUNNEL_COPY_LINES and lenses & _funnel_lenses(p) for p in posted)


def _funnel_record(case_dir):
    """One PR's findings-record.json counted as the funnel counts it, or None when unreadable.
    raised = every candidate entry (pre-downgrade copies left out); distinct = raised less the
    entries merged or folded into another lens's finding; posted = disposition 'posted'. Between
    distinct and posted: validator vetoes (killed, doubted), held back (withheld, or downgraded
    with no posted twin), and any other disposition. 'synth' counts counted entries whose every
    lens already has a merged raise pointing into them (likely synthesized copies; a caveat).
    Returns (counts, raising): raising = the lens ids, validator excluded, that raised at least
    one counted entry, or None when a counted entry names no lens (unknown, not fewer)."""
    rec = _funnel_load(os.path.join(case_dir, "findings-record.json"))
    fs = rec.get("findings") if isinstance(rec, dict) else None
    if not isinstance(fs, list):
        return None
    disp = [(f, _funnel_disposition(f)) for f in fs if isinstance(f, dict)]
    posted = [f for f, d in disp if d == "posted"]
    inbound = collections.defaultdict(list)
    for f, d in disp:
        if d == "merged":
            inbound[f.get("merged_into")].append(f)
    c = collections.Counter({k: 0 for k in FUNNEL_RECORD_KEYS})
    c["other"] += len(fs) - len(disp)  # an entry that is not an object: a candidate of unknown fate
    c["raised"] += len(fs) - len(disp)
    raising = set() if len(fs) == len(disp) else None
    for f, d in disp:
        if d == "downgraded" and _funnel_is_copy(f, posted):
            c["copies"] += 1
            continue
        c["raised"] += 1
        named = {x.split("--")[0] for x in _funnel_lenses(f, r"[,+/]")}
        if raising is not None:
            raising = (raising | (named - {FUNNEL_VALIDATOR})) if named else None
        if d in ("merged", "folded", "killed", "doubted", "withheld", "posted"):
            c[d] += 1
        elif d == "downgraded":
            c["held_downgraded"] += 1
        else:  # conceded, unknown: removed before posting, of unknown kind
            c["other"] += 1
        if d == "posted":
            tag = str(f.get("posted_as") or "").strip().strip("[]").strip().lower()
            c["posted_" + (tag if tag in FUNNEL_TAGS else "other")] += 1
        if d not in ("merged", "folded"):
            own = _funnel_lenses(f, r"[,+/]") - {FUNNEL_VALIDATOR}
            into = inbound.get(f.get("id"), [])
            seen = set().union(*(_funnel_lenses(g, r"[,+/]") for g in into)) if into else set()
            if own and own <= seen and len(into) >= len(own):
                c["synth"] += 1
    c["distinct"] = c["raised"] - c["merged"] - c["folded"]
    return dict(c), raising


def _funnel_judge(j):
    grades = collections.Counter(str(cm.get("verdict")) for cm in j.get("comments") or [] if isinstance(cm, dict))
    out = {g: grades.get(g, 0) for g in FUNNEL_GRADES}
    out["other_grade"] = sum(v for g, v in grades.items() if g not in FUNNEL_GRADES)
    out["judged"] = sum(grades.values())
    return out


def idea_funnel(ctx):
    """The frozen QuickReview build's findings funnel on the AACR PRs (ctx.cases). For each PR it
    reads, from the first run of the arm's runs (aacr-arms.txt) that has the PR judged, the case's
    findings-record.json (one entry per lens candidate, with its final disposition), the executed
    lenses from case-summary.json, and the judge's grade of every posted comment; outcome.json and
    case-summary.json's tags only as cross-checks. Returns per-PR rows (raised, distinct, posted,
    judged, correct, lenses run, lenses that raised a finding, lens runs), totals over the PRs that
    have both a record and a judgement, the PRs
    left out and why, and the cross-checks. The validator ledger in outcome.json is summed over
    EVERY validator run: five PRs ran a follow-up validation and list the validator twice."""
    runs = list(ctx.arms[FUNNEL_TOOL])
    prs, missing = {}, {}
    totals = collections.Counter({k: 0 for k in FUNNEL_RECORD_KEYS + FUNNEL_GRADES + ("other_grade", "judged")})
    checks = collections.Counter({k: 0 for k in ("outcome_lens_findings", "validator_runs") + tuple(
        "validator_ledger_" + k for k in ("survived", "killed", "downgraded", "merged", "folded"))})
    tags = collections.Counter()
    unread = collections.Counter({"outcome": 0, "case_summary_tags": 0})
    followup = []
    for iid, (set_name, _sevs, version) in sorted(ctx.cases.items()):
        run, judged = None, None
        for r in runs:
            j = compare.judgement(ctx.runs_dir, r, iid, version, ctx.judge_model)
            if j is not None:
                run, judged = r, _funnel_judge(j)
                break
        if run is None:
            missing[iid] = "no judgement"
            continue
        case_dir = os.path.join(ctx.runs_dir, run, "cases", iid)
        got = _funnel_record(case_dir)
        if got is None:
            missing[iid] = "no readable findings record"
            continue
        rec, raising = got
        cs = _funnel_load(os.path.join(case_dir, "case-summary.json"))
        ex = cs.get("executed_passes") if isinstance(cs, dict) else None
        lens_runs = [str(p).split("--")[0] for p in ex if not str(p).startswith(FUNNEL_VALIDATOR)] if isinstance(ex, list) else None
        prs[iid] = {"set": set_name, "run": run, "raised": rec["raised"], "distinct": rec["distinct"],
                    "posted": rec["posted"], "judged": judged["judged"],
                    "correct": judged["correct-valuable"] + judged["correct-minor"],
                    "lenses": None if lens_runs is None else len(set(lens_runs)),
                    "lenses_raising": None if raising is None else len(raising),
                    "lens_runs": None if lens_runs is None else len(lens_runs)}
        totals.update(rec)
        totals.update(judged)
        by_tag = ((cs.get("comments") or {}).get("by_tag")) if isinstance(cs, dict) else None
        if isinstance(by_tag, dict):
            tags.update({str(k): int(v) for k, v in by_tag.items() if isinstance(v, int)})
        else:
            unread["case_summary_tags"] += 1
        o = _funnel_load(os.path.join(case_dir, "outcome.json"))
        passes = o.get("passes") if isinstance(o, dict) else None
        if not isinstance(passes, list):
            unread["outcome"] += 1
            continue
        passes = [p for p in passes if isinstance(p, dict)]
        val = [p for p in passes if p.get("name") == FUNNEL_VALIDATOR]
        checks["outcome_lens_findings"] += sum(int(p.get("findings") or 0) for p in passes
                                               if p.get("name") != FUNNEL_VALIDATOR)
        for k in ("survived", "killed", "downgraded", "merged", "folded"):
            checks["validator_ledger_" + k] += sum(int(p.get(k) or 0) for p in val)
        checks["validator_runs"] += len(val)
        if len(val) > 1:  # a follow-up validation: the ledger is per run, the record per candidate
            followup.append(iid)
    # a sum over files some of which could not be read is unknown, never a smaller number
    cross = {k: (None if unread["outcome"] else v) for k, v in checks.items()}
    cross["case_summary_tags"] = None if unread["case_summary_tags"] else dict(sorted(tags.items()))
    cross["prs_with_followup_validation"] = sorted(followup)
    cross["unread"] = dict(unread)
    return {"tool": FUNNEL_TOOL, "runs": runs, "judge_model": ctx.judge_model, "cases": len(ctx.cases),
            "missing": dict(sorted(missing.items())), "prs": prs, "totals": dict(sorted(totals.items())),
            "cross_checks": cross}


# ---------------------------------------------------------------- idea-price-per-bug
# Each reviewer that tags its comments by priority, and its lowest tag (the one a reader can skip).
PRICE_PER_BUG_LOWEST = {"quickreview": "nit", "codex-cli": "P3", "open-code-review": "P3"}
PRICE_PER_BUG_TAG = re.compile(r"^\s*\[([a-z0-9][a-z0-9 ]*)\]", re.I)  # [nit], [blocker], [P3], ...
PRICE_PER_BUG_SERIOUS = ("high", "medium")


def idea_price_per_bug(ctx):
    """What the price-per-extra-bug figure needs beyond data/: `provenance` — where the answer key got
    each AACR defect, from defects/<set>.json: "independent" (the expert hunt or an AACR reference raised
    it), "comments_only" (only benchmarked reviewers' comments did) or "unknown" (neither recorded), as
    sorted "<pr>|<defect id>" lists; and `lowest_label` — for the three reviewers that tag comments by
    priority, how many judged comments carry the lowest tag ([nit]; [P3]), the serious (high or medium)
    credit that rests on those comments alone, and how many credited serious defects cite one (compare.py's
    run rule; the judge's comment numbering). A count with any PR unread is None, never zero."""
    return {"provenance": _price_per_bug_provenance(ctx),
            "lowest_label": {t: _price_per_bug_lowest(ctx, t, tag)
                             for t, tag in sorted(PRICE_PER_BUG_LOWEST.items())}}


def _price_per_bug_provenance(ctx):
    files, out = {}, {"independent": [], "comments_only": [], "unknown": []}
    for iid, (s, sevs, _) in sorted(ctx.cases.items()):
        if s not in files:
            files[s] = json.load(open(os.path.join(ctx.aacr, "defects", f"{s}.json")))["cases"]
        rows = {x["id"]: x for x in files[s][iid]["defects"]}
        for did in sorted(sevs):
            p = rows[did].get("provenance") or {}
            kind = ("independent" if p.get("hunt") or p.get("dataset_refs")
                    else "comments_only" if p.get("reviewer_comments") else "unknown")
            out[kind].append(f"{iid}|{did}")
    return out


def _price_per_bug_read(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _price_per_bug_tags(run_dir, iid):
    """Judge comment id -> the comment's leading [tag] (lower case) or None, numbered as the judge numbered
    them (hf_export.review_for_judge): the scored review's non-empty rows, then the posted comments on deleted
    lines (side LEFT). None when the scored file holds no review rows."""
    res = _price_per_bug_read(os.path.join(run_dir, "results", "all", f"{iid}.json"))
    review = res.get("review") if isinstance(res, dict) else None
    rows = review.get("comments") if isinstance(review, dict) else None
    if not isinstance(rows, list):
        return None
    texts = [r.get("content") for r in rows if isinstance(r, dict)]
    posted = _price_per_bug_read(os.path.join(run_dir, "cases", iid, "comments.json"))
    texts += [r.get("body") for r in (posted if isinstance(posted, list) else [])
              if isinstance(r, dict) and isinstance(r.get("side"), str) and r["side"].upper() == "LEFT"]
    tags = []
    for raw in texts:
        if isinstance(raw, str) and raw.strip():
            m = PRICE_PER_BUG_TAG.match(raw)
            tags.append(m.group(1).lower() if m else None)
    return {f"C{k + 1}": t for k, t in enumerate(tags)}


def _price_per_bug_lowest(ctx, tool, lowest):
    n = lost = cited = 0
    unread = 0
    for iid, (_, sevs, version) in sorted(ctx.cases.items()):
        run = j = None
        for r in ctx.arms[tool]:
            j = compare.judgement(ctx.runs_dir, r, iid, version, ctx.judge_model)
            if j is not None:
                run = r
                break
        tags = None if run is None else _price_per_bug_tags(os.path.join(ctx.runs_dir, run), iid)
        if tags is None or len(tags) != len(j["comments"]) or any(c["id"] not in tags for c in j["comments"]):
            unread += 1
            continue
        skip = {c["id"] for c in j["comments"] if tags[c["id"]] == lowest.lower()}
        n += len(skip)
        for x in j["defects"]:
            credit = CREDIT.get(x.get("verdict"), 0.0)
            if credit and sevs.get(x["id"]) in PRICE_PER_BUG_SERIOUS:
                cites = set(x.get("comments") or [])
                cited += bool(cites & skip)
                lost += credit if cites and cites <= skip else 0.0
    known = unread == 0
    return {"tag": lowest, "comments": n if known else None, "serious_credit_lost": lost if known else None,
            "serious_defects_citing": cited if known else None, "prs_unread": unread}


# ---------------------------------------------------------------- idea-uncredited
UNCREDITED_CLASSES = ("real", "listed", "dup", "minor", "wrong")
# The runs the two checks labelled: QuickReview's round-1 default on Martian, r6 on Qodo's 10 smoke PRs.
UNCREDITED_MARTIAN_RUN, UNCREDITED_QODO_RUN = "mv-r1-asposted.martian", "ext-r6-qodo-smoke10.qodo"
UNCREDITED_MARTIAN_JUDGE = "gpt-6.1-sol"  # every Martian run's results/<judge>/ directory
UNCREDITED_UNMATCHED = "\u2013"  # the appendix's Judge column for a candidate matched to no golden: an en dash
UNCREDITED_CREDITED = "\u2713"  # ... and the start of it for a candidate the judge matched to a golden: a check mark
UNCREDITED_MARTIAN_CLASS = {"REAL": "real", "KEY-GOLDEN": "listed", "GOLDEN-TRIVIAL": "listed",
                            "GOLDEN-DOUBTFUL": "listed", "MINOR": "minor", "WRONG": "wrong", "GOLDEN-WRONG": "wrong"}
# The appendix's tool names -> data/tools.json ids (an unknown one is kept as it is).
UNCREDITED_MARTIAN_TOOLS = {"QR": "quickreview", "cc": "claude-code", "qodo-ext": "qodo-extended", "qodo-v2": "qodo",
                            "macro": "macroscope", "augment": "augment", "cubic": "cubic", "devin": "devin"}
UNCREDITED_QODO_CLASS = {"REAL": "real", "LISTED-judge-miss": "listed", "LISTED-location": "listed", "DUP": "dup",
                         "MINOR": "minor", "WRONG": "wrong"}
UNCREDITED_QODO_ROWS = (("real defect", "real"), ("states a listed", "listed"), ("duplicate", "dup"),
                        ("true but minor", "minor"), ("wrong", "wrong"))
# A low-confidence MINOR call whose annotator reason says the flagged behaviour is intended: borderline WRONG.
UNCREDITED_INTENDED = re.compile(r"\bintend|\bintentional|\bmeant\b", re.I)


def _uncredited_check(what, got, want):
    if got != want:
        raise ValueError(f"idea-uncredited: {what}: parsed {got}, the source states {want}")


def _uncredited_table(md, heading):
    """The first markdown table after `heading`, as rows of cells (header first, bold marks dropped)."""
    out = []
    for ln in md[md.index(heading):].splitlines()[1:]:
        if ln.startswith("|"):
            cells = [c.strip().replace("**", "") for c in ln.strip().strip("|").split("|")]
            if not set("".join(cells)) <= set("-: "):
                out.append(cells)
        elif out:
            break
    return out


def _uncredited_row(table, first):
    """{header: cell} of the one row whose first cell starts with `first`."""
    rows = [r for r in table[1:] if r[0].startswith(first)]
    if len(rows) != 1:
        raise ValueError(f"idea-uncredited: {len(rows)} table rows start with {first!r}")
    return dict(zip(table[0], rows[0]))


def _uncredited_counts(classes):
    c = collections.Counter(classes)
    return {k: c.get(k, 0) for k in UNCREDITED_CLASSES}


def _uncredited_appendix(md):
    """Every row of FAIR-COMPARISON's 'every classification' appendix: 580 candidates of 8 tools."""
    rows, pr = [], None
    for ln in md[md.index("## Appendix: every classification"):].splitlines():
        m = re.match(r"#### \S+ \((\S+)\)", ln)
        if m:
            pr = m.group(1)
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if pr and re.fullmatch(r"C\d{4}", cells[0]):
            if len(cells) != 7:
                raise ValueError(f"idea-uncredited: appendix row {cells[0]} has {len(cells)} cells, not 7")
            rows.append({"pr": pr, "tool": cells[1], "judge": cells[2], "low": "(low)" in cells[3],
                         "label": re.sub(r"\s*(\(low\)|\[credit[^\]]*\])", "", cells[3]).strip(),
                         "entry": cells[4].split()[0], "reason": cells[6]})
    return rows


def _uncredited_martian(ctx):
    """QuickReview's Martian tune20 candidates the judge matched to no golden, classed from the appendix.

    One rule on both bars, the Qodo check's ('duplicate of a credited comment'): a repeat (DUP) is 'the same
    issue at another site' only when the judge credited the candidate it repeats; any other repeat counts as
    what it repeats (a repeated real defect is real, a repeated minor note minor). `as_labelled` keeps every
    DUP in that class, as the appendix labels it."""
    md = open(os.path.join(ctx.aacr, "ext", "martian-tuning", "FAIR-COMPARISON.md"), encoding="utf-8").read()
    rows = _uncredited_appendix(md)
    slots = collections.defaultdict(list)  # (tool, PR, issue id) -> its non-DUP candidates: the first slot
    for r in rows:
        if r["label"] != "DUP":
            if r["label"] not in UNCREDITED_MARTIAN_CLASS:
                raise ValueError(f"idea-uncredited: unknown appendix class {r['label']!r}")
            slots[(r["tool"], r["pr"], r["entry"])].append(r)
    for r in rows:
        if r["label"] == "DUP" and len(slots[(r["tool"], r["pr"], r["entry"])]) != 1:
            raise ValueError(f"idea-uncredited: a DUP of {r['entry']} ({r['tool']}) has no single first slot")

    def first(r):
        return slots[(r["tool"], r["pr"], r["entry"])][0]

    def plotted(r):
        if r["label"] != "DUP":
            return UNCREDITED_MARTIAN_CLASS[r["label"]]
        f = first(r)
        return "dup" if f["judge"].startswith(UNCREDITED_CREDITED) else UNCREDITED_MARTIAN_CLASS[f["label"]]

    unmatched = [r for r in rows if r["judge"] == UNCREDITED_UNMATCHED]
    qr = [r for r in rows if r["tool"] == "QR"]
    um = [r for r in unmatched if r["tool"] == "QR"]
    table_a = _uncredited_table(md, "### A. Martian as scored")
    a = _uncredited_row(table_a, "QuickReview")
    _uncredited_check("appendix candidates, all tools (table A)", len(rows),
                      sum(int(dict(zip(table_a[0], r))["Candidates"]) for r in table_a[1:]))
    _uncredited_check("QuickReview candidates (table A)", len(qr), int(a["Candidates"]))
    _uncredited_check("QuickReview unmatched candidates (table A, FP)", len(um), int(a["FP"]))
    c2 = _uncredited_row(_uncredited_table(md, "### C2. Fine classes per tool"), "QuickReview")
    labels = collections.Counter(r["label"] for r in qr)
    for k in list(UNCREDITED_MARTIAN_CLASS) + ["DUP"]:
        _uncredited_check(f"QuickReview {k} candidates (table C2)", labels.get(k, 0), int(c2[k]))
    prs = sorted({r["pr"] for r in rows})
    ev = _uncredited_evaluations(ctx, UNCREDITED_MARTIAN_RUN)
    for pr in prs:
        q = ev[pr]["quickreview"]
        _uncredited_check(f"QuickReview false positives on {pr} (run)", sum(r["pr"] == pr for r in um), q["fp"])
        _uncredited_check(f"QuickReview candidates on {pr} (run)", sum(r["pr"] == pr for r in qr),
                          q["total_candidates"])
    sev = {r[0]: r[1] for r in _uncredited_table(md, "### E. REAL key entries")[1:]}
    dups = [r for r in um if r["label"] == "DUP"]
    real = {(r["pr"], r["entry"]) for r in um if plotted(r) == "real"}  # distinct defects: a repeat adds none
    # Borderline WRONG: low-confidence MINOR calls whose reason says the flagged behaviour is intended, and
    # the repeats that take their class from them (they would turn wrong with them under the rule above).
    borderline = {(r["tool"], r["pr"], r["entry"]) for r in um if r["label"] == "MINOR" and r["low"]
                  and UNCREDITED_INTENDED.search(r["reason"])}
    by_tool = collections.defaultdict(list)  # every tool's unmatched candidates, as classed for the chart
    for r in unmatched:
        by_tool[UNCREDITED_MARTIAN_TOOLS.get(r["tool"], r["tool"])].append(plotted(r))
    return {
        "prs": len(prs),
        "findings": len(qr),
        "uncredited": len(um),
        "classes": _uncredited_counts(plotted(r) for r in um),
        "as_labelled": _uncredited_counts("dup" if r["label"] == "DUP" else plotted(r) for r in um),
        "repeats": dict(sorted(collections.Counter(plotted(r) for r in dups).items())),
        "low_confidence": _uncredited_counts(plotted(r) for r in um if r["low"]),
        "real_defects": len(real),
        "real_severity": dict(sorted(collections.Counter(sev[e] for _, e in real).items())),
        "borderline_wrong": len(borderline),
        "borderline_repeats": sum(1 for r in dups if (r["tool"], r["pr"], r["entry"]) in borderline
                                  and plotted(r) == "minor"),
        "wrong_by_tool": {t: [v.count("wrong"), len(v)] for t, v in sorted(by_tool.items())},
    }, prs


def _uncredited_qodo(ctx):
    """Every QuickReview r6 inline comment on Qodo's 10 smoke PRs with no N=5 hit, as hand-labelled."""
    labels = json.load(open(os.path.join(ctx.data_root, "ext-cache", "qodo", "unlisted-check.json")))
    by_tool = collections.defaultdict(list)
    for v in labels.values():
        if v["class"] not in UNCREDITED_QODO_CLASS:
            raise ValueError(f"idea-uncredited: unknown Qodo hand label {v['class']!r}")
        by_tool[v["tool"]].append(UNCREDITED_QODO_CLASS[v["class"]])
    md = open(os.path.join(ctx.aacr, "ext", "QODO-BENCH.md"), encoding="utf-8").read()
    table = _uncredited_table(md, "### What QuickReview's unmatched comments are")
    for head in table[0][1:]:
        tool = "quickreview" if head.startswith("QuickReview") else head.split()[0]
        _uncredited_check(f"{tool} hand labels (QODO-BENCH.md table header)", len(by_tool[tool]),
                          int(re.search(r"\((\d+)\)", head).group(1)))
        _uncredited_check(f"{tool} hand labels by class (QODO-BENCH.md table)", _uncredited_counts(by_tool[tool]),
                          {k: int(_uncredited_row(table, p)[head]) for p, k in UNCREDITED_QODO_ROWS})
    run = json.load(open(os.path.join(ctx.runs_dir, UNCREDITED_QODO_RUN, "scores.json")))
    n5 = run["scores"]["quickreview"]["N=5"]
    _uncredited_check("QuickReview comments with no N=5 hit (run)", len(by_tool["quickreview"]),
                      n5["comments"] - n5["tp"])
    qr = _uncredited_counts(by_tool["quickreview"])
    return {
        "prs": run["prs"],
        "comments": n5["comments"],
        "uncredited": len(by_tool["quickreview"]),
        "classes": qr,
        "as_labelled": qr,
        "others": {t: {"uncredited": len(v), "classes": _uncredited_counts(v)}
                   for t, v in sorted(by_tool.items()) if t != "quickreview"},
    }


def _uncredited_evaluations(ctx, run):
    return json.load(open(os.path.join(ctx.runs_dir, run, "results", UNCREDITED_MARTIAN_JUDGE, "evaluations.json")))


def _uncredited_located(c, x, n=5):
    """qodo_judge.py's location rule: the issue's file, lines overlapping its range widened by n."""
    norm = lambda p: (p or "").lstrip("./").lstrip("/")  # noqa: E731
    s = c["start"] if c["start"] is not None else c["end"]
    e = c["end"] if c["end"] is not None else s
    return norm(c["path"]) == norm(x["file_path"]) and s is not None and \
        max(s, e) >= x["start_line"] - n and min(s, e) <= x["end_line"] + n


def _uncredited_frozen(ctx, martian_prs):
    """The frozen build the other charts show (QuickReview's runs in aacr-arms.txt and the source lists),
    sized on the same PRs as the checks: none of its comments was checked by hand. Its AACR judge grades
    of the comments linked to no credited defect are the closest evidence. None where a run is missing."""
    out, grades, judged = {}, collections.Counter(), 0
    for iid, (_, _, version) in sorted(ctx.cases.items()):
        j = next((j for j in (compare.judgement(ctx.runs_dir, run, iid, version, ctx.judge_model)
                              for run in ctx.arms["quickreview"]) if j is not None), None)
        if j is not None:
            linked = {c for x in j["defects"] if x["verdict"] in CREDIT for c in x.get("comments") or []}
            grades.update(c["verdict"] for c in j["comments"] if c["id"] not in linked)
            judged += 1
    out["aacr"] = {"prs": judged, "unlinked": sum(grades.values()), "grades": dict(sorted(grades.items()))} \
        if judged else None
    run = {f: dict(read_specs(os.path.join(ctx.here, f)))["quickreview"][0].partition(":")[0]
           for f in ("martian-sources.txt", "qodo-sources.txt")}
    try:
        q = [_uncredited_evaluations(ctx, run["martian-sources.txt"])[pr]["quickreview"] for pr in martian_prs]
        out["martian"] = {"findings": sum(x["total_candidates"] for x in q), "uncredited": sum(x["fp"] for x in q)}
    except (OSError, KeyError):  # the run, or one of these PRs in it, is not in the archive: unknown
        out["martian"] = None
    try:
        smoke = [c["pr_url"] for c in json.load(open(os.path.join(ctx.aacr, "sets", "qodo-smoke10.json")))["cases"]]
        issues = {}
        for ln in open(os.path.join(ctx.data_root, "ext-cache", "qodo", "git_code_review_bench_100_w_open_prs.jsonl")):
            if ln.strip():
                r = json.loads(ln)
                issues[r["pr_url_to_review"]] = r["issues"]
        js = {}
        for ln in open(os.path.join(ctx.runs_dir, run["qodo-sources.txt"], "judgements.jsonl")):
            j = json.loads(ln)
            if j["tool"] == "quickreview" and j["pass"] == 1 and "error" not in j["meta"]:
                js[j["pr"]] = j  # the last good judgement stands, as in qodo_judge.py
        comments = sum(js[u]["n_comments"] for u in smoke)
        hits = sum(len({m["comment"] for m in js[u]["matches"]
                        if _uncredited_located(js[u]["comments"][m["comment"]], issues[u][m["issue"]])}) for u in smoke)
        out["qodo"] = {"comments": comments, "uncredited": comments - hits}
    except (OSError, KeyError):
        out["qodo"] = None
    return out


def idea_uncredited(ctx):
    """QuickReview's benchmark 'false positives' (comments no answer key credited), as two checks against
    the code by Claude-model annotators classed them: Martian tune20 (FAIR-COMPARISON.md's appendix, every candidate the
    judge matched to no golden; QuickReview's round-1 default build) and Qodo's 10 smoke PRs
    (ext-cache/qodo/unlisted-check.json, every inline comment with no N=5 hit; build r6). Each is checked
    against its write-up's own tables and its scoring run, and raises on any difference. Returns per
    benchmark the counts in five classes (real defect the key lacks, listed issue the scoring missed, same
    issue at another site, true but minor, wrong), the numbers the caveats rest on, and the frozen build's
    unchecked comments on the same PRs."""
    martian, prs = _uncredited_martian(ctx)
    return {"martian": martian, "qodo": _uncredited_qodo(ctx), "frozen": _uncredited_frozen(ctx, prs)}


IDEAS = {
    "idea-languages": idea_languages,
    "idea-commercial-misses": idea_commercial_misses,
    "idea-robust": idea_robust,
    "idea-skip-nits": idea_skip_nits,
    "idea-funnel": idea_funnel,
    "idea-price-per-bug": idea_price_per_bug,
    "idea-uncredited": idea_uncredited,
}
