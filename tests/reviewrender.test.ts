// `[review] render_outputs` (src/reviewrender.ts, bench/aacr/PERF.md §6
// proposal 3): the posted review rendered from the findings record. What the
// round template's step 6 asks of a hand-written body and comment must come
// out of the renderer: the opener first, the verdict line counting ROOT
// CAUSES, the lenses line, the sections, the double-check items, overflow to
// the body (no anchor, inline: false, the 50 cap), the footer; each inline
// comment as tag line, body, trailer, in the closed tag grammar the rest of
// the system keys on. Nothing is dropped and nothing is decided.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  postedRenderOptions,
  renderPostedReview,
  renderRenderNote,
  renderReviewFromRecord,
  renderedFooter,
} from "../src/reviewrender.js";
import { renderBenchOutputs } from "../src/bench/runner.js";
import { parseFindingsRecord } from "../src/findingsrecord.js";
import { findingMarker, parseFindingMarker, stripFindingMarkers } from "../src/findingkey.js";
import { reviewFooter } from "../src/posting.js";
import { CHECK_THIS_RE } from "../src/severity.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function entry(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "f1",
    path: "src/api/orders.py",
    line: 212,
    lens: "pass-security",
    severity: "P1",
    confidence: 0.9,
    reachability: "routine",
    disposition: "posted",
    posted_as: "blocker",
    title: "Any user can read another tenant's order",
    body: "Any authenticated user can fetch another tenant's order by id.\n\norders.py:212 reads the id and never checks the tenant.",
    reason: "Cross-tenant read.",
    ...over,
  };
}

function record(findings: Array<Record<string, unknown>>, top: Record<string, unknown> = {}) {
  return {
    pr: 7,
    round_no: 1,
    head_sha: "abc",
    comments_posted: 0,
    verdict: "REQUEST_CHANGES",
    summary: "This PR routes orders by region. The round found one blocker.",
    lenses_applied: "pass-baseline, pass-security",
    findings,
    ...top,
  };
}

describe("renderReviewFromRecord — the inline comments", () => {
  it("renders `[tag] title`, the body, then the severity trailer", () => {
    const r = renderReviewFromRecord(record([entry({})]));
    expect(r.comments).toEqual([
      {
        path: "src/api/orders.py",
        line: 212,
        side: "RIGHT",
        body:
          "[blocker] Any user can read another tenant's order\n\n" +
          "Any authenticated user can fetch another tenant's order by id.\n\norders.py:212 reads the id and never checks the tenant.\n\n" +
          "_P1 · confidence 0.90 · lens pass-security_",
      },
    ]);
    expect(r.problems).toEqual([]);
  });

  it("keeps the markers of the closed grammar: [check this], [ask your human] [sev], [deferred] [sev]", () => {
    const r = renderReviewFromRecord(
      record([
        entry({ id: "c", posted_as: "check this", title: "Confirm the cron runs once" }),
        entry({
          id: "a",
          posted_as: "ask your human",
          severity: "P2",
          confidence: 0.6,
          title: "Is EU data allowed here?",
        }),
        entry({
          id: "d",
          posted_as: "deferred",
          severity: "P1",
          title: "Pre-existing retry storm",
        }),
      ]),
    );
    expect(CHECK_THIS_RE.test(r.comments[0]!.body)).toBe(true);
    expect(
      r.comments[1]!.body.startsWith("[ask your human] [question] Is EU data allowed here?"),
    ).toBe(true);
    expect(r.comments[2]!.body.startsWith("[deferred] [blocker] Pre-existing retry storm")).toBe(
      true,
    );
  });

  it("anchors a LEFT side and a multi-line range when the record claims them", () => {
    const r = renderReviewFromRecord(record([entry({ side: "LEFT", start_line: 200 })]));
    expect(r.comments[0]).toMatchObject({ side: "LEFT", start_line: 200, line: 212 });
  });

  it("ignores every entry that did not post", () => {
    const r = renderReviewFromRecord(
      record([
        entry({}),
        entry({ id: "k", disposition: "killed", word: "duplicate" }),
        entry({ id: "d", disposition: "doubted", word: "refuted" }),
      ]),
    );
    expect(r.comments).toHaveLength(1);
  });
});

describe("renderReviewFromRecord — the body", () => {
  it("opens with the plain paragraph, then the verdict line, the lenses line, the sections and the footer", () => {
    const r = renderReviewFromRecord(
      record([
        entry({}),
        entry({ id: "n", posted_as: "nit", severity: "nit", title: "Name the constant" }),
      ]),
      { botLogin: "qc-bot" },
    );
    const lines = r.body.split("\n");
    expect(lines[0]).toBe("This PR routes orders by region. The round found one blocker.");
    expect(r.body).toContain("**Verdict: Changes requested** — 1 blocker, 1 nit.");
    expect(r.body).toContain("_Lenses applied: pass-baseline, pass-security._");
    expect(r.body).toContain(
      "### Blockers\n\n- `src/api/orders.py:212` — Any user can read another tenant's order _(P1/0.90, pass-security)_",
    );
    expect(r.body).toContain("### Nits");
    expect(r.body.trim().endsWith("ask for a human reviewer if you want this escalated._")).toBe(
      true,
    );
    expect(r.body).toContain("`qc-bot`");
  });

  it("counts root causes, not rows: a same_as follower posts inline but is neither counted nor bulleted", () => {
    const r = renderReviewFromRecord(
      record([
        entry({}),
        entry({
          id: "f2",
          line: 240,
          same_as: "f1",
          title: "Same root cause as src/api/orders.py:212",
        }),
      ]),
    );
    expect(r.comments).toHaveLength(2);
    expect(r.body).toContain("— 1 blocker.");
    expect(r.body).not.toContain("orders.py:240`");
  });

  it("puts check-this items under the double-check section and keeps them out of the counts", () => {
    const r = renderReviewFromRecord(
      record([entry({ id: "c", posted_as: "check this", title: "Confirm the cron runs once" })], {
        verdict: "APPROVE",
      }),
    );
    expect(r.body).toContain("**Verdict: Approved** — no findings.");
    expect(r.body).toContain(
      "### For a human to double-check\n\n- `src/api/orders.py:212` — Confirm the cron runs once",
    );
  });

  it("sends no-anchor, inline:false and over-cap findings to the body, never drops them", () => {
    const many = Array.from({ length: 51 }, (_, i) =>
      entry({ id: `m${i}`, line: 300 + i, title: `Defect ${i}` }),
    );
    const r = renderReviewFromRecord(
      record([
        ...many,
        entry({ id: "x", line: null, title: "File-level defect" }),
        entry({ id: "y", inline: false, title: "Body only" }),
      ]),
    );
    expect(r.comments).toHaveLength(50);
    expect(r.in_body).toBe(3);
    expect(r.body).toContain("### Additional findings (not posted inline)");
    expect(r.body).toContain("Defect 50");
    expect(r.body).toContain("over the 50-inline-comment cap");
    expect(r.body).toContain("File-level defect");
    expect(r.body).toContain("Body only");
  });

  it("appends the details block verbatim", () => {
    const r = renderReviewFromRecord(
      record([], { details: "<details><summary>Checked</summary>\n\nok\n</details>" }),
    );
    expect(r.body).toContain("<details><summary>Checked</summary>");
  });
});

describe("renderReviewFromRecord — a thin record still renders, and says what it lacked", () => {
  it("falls back to the reason for a missing title and body, and to the caller's verdict and summary", () => {
    const thin = {
      findings: [
        entry({ title: undefined, body: undefined, reason: "Cross-tenant read. More words." }),
      ],
    };
    const r = renderReviewFromRecord(thin, {
      verdict: "REQUEST_CHANGES",
      summary: "Opening.",
      lensesApplied: "pass-security",
    });
    expect(
      r.comments[0]!.body.startsWith(
        "[blocker] Cross-tenant read.\n\nCross-tenant read. More words.",
      ),
    ).toBe(true);
    expect(r.body.startsWith("Opening.\n")).toBe(true);
    expect(r.body).toContain("_Lenses applied: pass-security._");
    expect(r.problems.join("\n")).toMatch(/no title/);
    expect(r.problems.join("\n")).toMatch(/no body/);
  });

  it("renders an ungrammatical posted_as as a question and reports it", () => {
    const r = renderReviewFromRecord(record([entry({ posted_as: "blocker, now fixed" })]));
    expect(r.comments[0]!.body.startsWith("[question]")).toBe(true);
    expect(r.problems[0]).toMatch(/outside the grammar/);
  });

  it("never throws on garbage", () => {
    expect(() => renderReviewFromRecord(null)).not.toThrow();
    expect(renderReviewFromRecord("x").problems).toContain("the record has no findings array");
  });
});

describe("the footer", () => {
  it("is posting.ts's reviewFooter, word for word", () => {
    expect(renderedFooter("qc-bot")).toBe(reviewFooter("qc-bot"));
    expect(renderedFooter()).toBe(reviewFooter());
  });
});

describe("renderRenderNote", () => {
  it("is empty unless the order renders, so an unrendered round order is unchanged", () => {
    expect(renderRenderNote({ pr: 7, round_no: 2 })).toBe("");
  });
  it("names the record path, the script and the two files it writes", () => {
    const note = renderRenderNote({ render_outputs: true, pr: 7, round_no: 2 });
    expect(note).toContain("state/findings/pr-7-round-2.json");
    expect(note).toContain("bash scripts/render-review.sh 7 2");
    expect(note).toContain("state/pr-7-round-2-review.md");
    expect(note).toContain("state/pr-7-round-2-comments.json");
    expect(note).toContain("`same_as");
  });
  it("hands the verdict file to commit-verdict.sh --from-record and says what never renders", () => {
    const note = renderRenderNote({ render_outputs: true, pr: 7, round_no: 2 });
    expect(note).toContain("`scripts/commit-verdict.sh --from-record pr-7-round-2.json`");
    expect(note).toContain("`passes` array in the record's top level");
    expect(note).toContain("Only `posted` entries render");
    expect(note).toContain("A `head_moved` outcome is\nalways staged by hand");
  });
});

describe("the render-review CLI (what scripts/render-review.sh execs)", () => {
  it("reads the pinned record and writes the two pinned scratch files", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-render-"));
    try {
      mkdirSync(join(root, "state", "findings"), { recursive: true });
      writeFileSync(
        join(root, "state", "findings", "pr-7-round-2.json"),
        JSON.stringify(record([entry({})])),
      );
      const out = execFileSync(
        process.execPath,
        [join(ROOT, "dist", "src", "reviewrendercli.js"), root, "7", "2", "qc-bot"],
        { encoding: "utf8" },
      );
      expect(out).toContain("1 inline comment(s), 0 in the body");
      const comments = JSON.parse(
        readFileSync(join(root, "state", "pr-7-round-2-comments.json"), "utf8"),
      );
      expect(comments[0].body.startsWith("[blocker]")).toBe(true);
      // the live route stamps the finding's marker.
      expect(comments[0].body.endsWith("\n\n<!-- qcr:f=2:f1 -->")).toBe(true);
      expect(readFileSync(join(root, "state", "pr-7-round-2-review.md"), "utf8")).toContain(
        "**Verdict: Changes requested**",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// S6 (outcome capture): the live render route stamps every inline
// comment with a hidden marker naming its finding, so the daemon can link the
// posted comment back to its `round_findings` row. Only on request — the bench
// never asks, and its outputs must stay byte-identical.
describe("the finding marker (S6)", () => {
  const rec = () =>
    record([
      entry({ id: "F1" }),
      entry({ id: "F2", path: "src/b.py", line: 9, posted_as: "nit", severity: "P3" }),
      entry({ id: "F3", path: null, line: null, title: "No anchor" }),
      entry({ id: "F4", disposition: "killed", word: "duplicate" }),
    ]);

  it("is absent unless asked for: the default render is byte-for-byte the pinned format", () => {
    const plain = renderReviewFromRecord(rec());
    for (const c of plain.comments) expect(c.body).not.toContain("qcr:f=");
    expect(plain.body).not.toContain("qcr:f=");
    expect(plain.comments[0]!.body).toBe(
      "[blocker] Any user can read another tenant's order\n\n" +
        "Any authenticated user can fetch another tenant's order by id.\n\norders.py:212 reads the id and never checks the tenant.\n\n" +
        "_P1 · confidence 0.90 · lens pass-security_",
    );
  });

  it("asked for, it is appended to every inline comment and nothing else changes", () => {
    const plain = renderReviewFromRecord(rec());
    const marked = renderReviewFromRecord(rec(), { findingMarkers: { roundNo: 3 } });
    expect(marked.body).toBe(plain.body); // the in-body finding gets none
    expect(marked.comments.map((c) => c.body)).toEqual(
      plain.comments.map((c, i) => `${c.body}\n\n${findingMarker(3, ["F1", "F2"][i]!)}`),
    );
    expect(marked.comments.map((c) => ({ ...c, body: stripFindingMarkers(c.body) }))).toEqual(
      plain.comments,
    );
    expect(marked.comments.map((c) => parseFindingMarker(c.body))).toEqual([
      { round_no: 3, key: "F1" },
      { round_no: 3, key: "F2" },
    ]);
  });

  it("names the key the record parser stores, for an entry with no id too", () => {
    const r = record([
      entry({ id: undefined, lens: "pass-ui", path: "a.tsx", line: 4 }),
      entry({ id: undefined, disposition: "killed", path: "b.ts", line: 1 }),
      entry({ id: undefined, lens: "pass-baseline", path: "c.ts", line: 8 }),
    ]);
    const marked = renderReviewFromRecord(r, { findingMarkers: { roundNo: 1 } });
    const parsed = parseFindingsRecord(r, 7, 1).record!.findings.filter(
      (f) => f.disposition === "posted",
    );
    expect(marked.comments.map((c) => parseFindingMarker(c.body)?.key)).toEqual(
      parsed.map((f) => f.key),
    );
    expect(parsed.map((f) => f.key)).toEqual(["pass-ui@a.tsx:4#0", "pass-baseline@c.ts:8#2"]);
  });

  it("encodes a hostile key so it can neither close the comment nor break the line", () => {
    const key = "x --> <b>\nboom";
    const m = findingMarker(2, key);
    expect(m).toMatch(/^<!-- qcr:f=2:[A-Za-z0-9%._~]+ -->$/);
    expect(parseFindingMarker(`body\n\n${m}`)).toEqual({ round_no: 2, key });
  });

  it("the LAST marker wins: a marker-shaped string the finding quotes cannot take the link", () => {
    // The finding text is the reviewer's and may quote PR content verbatim;
    // the real marker is appended after it (integration review).
    const quoted = `quoted \`${findingMarker(9, "evil")}\` in code`;
    expect(parseFindingMarker(`${quoted}\n\n${findingMarker(2, "real")}`)).toEqual({
      round_no: 2,
      key: "real",
    });
    const r = record([entry({ id: "F1", title: `see ${findingMarker(9, "evil")}` })]);
    const marked = renderReviewFromRecord(r, { findingMarkers: { roundNo: 3 } });
    expect(marked.comments.map((c) => parseFindingMarker(c.body))).toEqual([
      { round_no: 3, key: "F1" },
    ]);
  });

  it("never throws on a key with a lone surrogate — it names the key the state database stores", () => {
    // `JSON.parse` accepts "\ud800"; encodeURIComponent throws URIError on it,
    // and the render route has no catch around the marker.
    const key = JSON.parse('"F\\ud800x"') as string;
    expect(() => encodeURIComponent(key)).toThrow(URIError);
    const m = findingMarker(4, key);
    expect(m).toMatch(/^<!-- qcr:f=4:[A-Za-z0-9%._~]+ -->$/);
    // SQLite stores the lone surrogate as U+FFFD; the marker names that key.
    expect(parseFindingMarker(m)).toEqual({ round_no: 4, key: "F�x" });
    const r = record([entry({ id: key })]);
    const marked = renderReviewFromRecord(r, { findingMarkers: { roundNo: 4 } });
    expect(marked.comments.map((c) => parseFindingMarker(c.body))).toEqual([
      { round_no: 4, key: "F�x" },
    ]);
  });

  it("the bench route never carries it, and renders exactly what renderPostedReview renders", () => {
    const cfg = { review: { dedup_merge: true }, github: { bot_login: "qc-bot" } };
    const bench = renderBenchOutputs(structuredClone(rec()), undefined, cfg);
    const plain = renderPostedReview(structuredClone(rec()), postedRenderOptions(cfg));
    expect(JSON.stringify(bench.rendered)).toBe(JSON.stringify(plain.rendered));
    expect(JSON.stringify(bench.rendered)).not.toContain("qcr:f=");
    expect(postedRenderOptions(cfg)).not.toHaveProperty("findingMarkers");
  });
});
