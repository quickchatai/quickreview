// the CI-classifier DIFFERENTIAL (audit assertion #7, MC-15).
//
// `scripts/guards.sh`'s `guard_ci_state` is a hand-rolled jq reimplementation
// of `classifyCi` in `src/cigate.ts`, and both file headers claim the two are
// behaviourally identical. Nothing checked that. They are asserted separately
// — `tests/cigate.test.ts` drives the TypeScript, `tests/guards-shell.test.ts`
// drives the script — over different inputs, with no shared fixture set and no
// agreement assertion.
//
// That matters more here than for any other pair in the tree, because guard 4
// is the ONLY guard that gates an approval. `tests/guards.test.ts` has no
// guard-4 case at all.
//
// This runs the REAL shell function against a loopback stub and the REAL
// TypeScript function over the same corpus, and requires them to agree.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyCi, type CheckSummary } from "../src/cigate.js";
import { parseConfig } from "../src/config.js";
import { MutationGate } from "../src/gate.js";
import { GitHubAdapter } from "../src/github.js";
import type { FetchFn, TokenMinter } from "../src/githubAuth.js";

const exec = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");
const cfg = parseConfig(readFileSync(join(ROOT, "tests", "fixtures", "config.toml"), "utf8"));

/**
 * The shared corpus. Each case is a set of check runs; both classifiers see
 * exactly these and must return the same word.
 *
 * The cases are chosen for the branches the audit called out: latest-run-per-
 * name (GitHub auto-cancels superseded runs, and permanent `cancelled` husks
 * withheld every approval for a day), the inert conclusions, the unfinished
 * states, and the default-to-red fall-through that makes every conclusion
 * GitHub invents next fail closed.
 */
const CORPUS: ReadonlyArray<{ name: string; runs: CheckSummary[]; statuses?: Array<{ context: string; state: string }> }> = [
  { name: "empty", runs: [] },
  { name: "one green", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "success" }] },
  { name: "one failure", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "failure" }] },
  { name: "one cancelled", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "cancelled" }] },
  { name: "one timed_out", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "timed_out" }] },
  { name: "one action_required", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "action_required" }] },
  { name: "a conclusion GitHub has not invented yet", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "quantum_flux" }] },
  { name: "queued", runs: [{ name: "unit", source: "check_run", status: "queued", conclusion: null }] },
  { name: "in_progress", runs: [{ name: "unit", source: "check_run", status: "in_progress", conclusion: null }] },
  { name: "all skipped", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "skipped" }] },
  { name: "all neutral", runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "neutral" }] },
  {
    name: "green beside skipped",
    runs: [
      { name: "unit", source: "check_run", status: "completed", conclusion: "success" },
      { name: "lint", source: "check_run", status: "completed", conclusion: "skipped" },
    ],
  },
  {
    name: "green beside a still-running check",
    runs: [
      { name: "unit", source: "check_run", status: "completed", conclusion: "success" },
      { name: "e2e", source: "check_run", status: "in_progress", conclusion: null },
    ],
  },
  {
    name: "green beside a failure",
    runs: [
      { name: "unit", source: "check_run", status: "completed", conclusion: "success" },
      { name: "e2e", source: "check_run", status: "completed", conclusion: "failure" },
    ],
  },
  {
    // THE case: GitHub cancels the superseded run of a check name.
    // Only the newest run of each name counts, or a permanent husk withholds
    // every approval forever — which it did, for a day.
    name: "a cancelled husk superseded by a green rerun",
    runs: [
      { name: "unit", source: "check_run", status: "completed", conclusion: "cancelled", started_at: "2026-08-19T09:00:00Z" },
      { name: "unit", source: "check_run", status: "completed", conclusion: "success", started_at: "2026-08-19T10:00:00Z" },
    ],
  },
  {
    name: "a green run superseded by a failing rerun",
    runs: [
      { name: "unit", source: "check_run", status: "completed", conclusion: "success", started_at: "2026-08-19T09:00:00Z" },
      { name: "unit", source: "check_run", status: "completed", conclusion: "failure", started_at: "2026-08-19T10:00:00Z" },
    ],
  },
  // and its review round 1: a commit status is a second check, never
  // a superseded run — whichever kind is timestamped, whichever is listed
  // first. These are the rows the two copies used to answer differently.
  {
    name: "a failing status under a passing check-run's name",
    runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "success", started_at: "2026-08-19T10:00:00Z" }],
    statuses: [{ context: "unit", state: "failure" }],
  },
  {
    name: "a pending status under a passing check-run's name",
    runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "success", started_at: "2026-08-19T10:00:00Z" }],
    statuses: [{ context: "unit", state: "pending" }],
  },
  {
    name: "a queued null-start check-run under a passing status's name",
    runs: [{ name: "unit", source: "check_run", status: "queued", conclusion: null, started_at: null }],
    statuses: [{ context: "unit", state: "success" }],
  },
  {
    name: "a failed null-start check-run under a passing status's name",
    runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "failure", started_at: null }],
    statuses: [{ context: "unit", state: "success" }],
  },
  {
    name: "a queued null-start check-run beside the older completed run of its name",
    runs: [
      { name: "unit", source: "check_run", status: "completed", conclusion: "success", started_at: "2026-08-19T10:00:00Z" },
      { name: "unit", source: "check_run", status: "queued", conclusion: null, started_at: null },
    ],
  },
  {
    name: "a passing status beside a passing check-run of its name",
    runs: [{ name: "unit", source: "check_run", status: "completed", conclusion: "success", started_at: "2026-08-19T10:00:00Z" }],
    statuses: [{ context: "unit", state: "success" }],
  },
];

let server: Server;
let apiBase = "";
/** The check-runs payload. `source` is the adapter's stamp, not a GitHub
 * field; it is stripped here so the shell sees exactly what GitHub sends. */
let checkRuns: CheckSummary[] = [];
let statuses: Array<{ context: string; state: string }> = [];

beforeEach(async () => {
  statuses = [];
  server = createServer((req, res) => {
    if (req.method === "GET" && req.url?.includes("/check-runs")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ check_runs: checkRuns.map(({ source: _source, ...run }) => run) }));
      return;
    }
    if (req.method === "GET" && req.url?.includes("/status")) {
      // The combined-status endpoint — the corpus's statuses, so the two
      // classifiers see the same mixed input through their own real readers.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "success", statuses }));
      return;
    }
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const addr = server.address();
  apiBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

/** The REAL `GitHubAdapter.listChecks` over the same stub — the TypeScript
 * half reads its input through the same two endpoints the shell half does,
 * so the kind stamp (`source`) is the adapter's, never the corpus's. */
async function adapterClassifyInput(): Promise<CheckSummary[]> {
  const minter = { appJwt: () => "jwt", installationToken: async () => "tok", invalidate: () => {} } as unknown as TokenMinter;
  const gate = new MutationGate(true, join(tmpdir(), "qcr-fences-cigate-unused"), async () => ({}));
  return new GitHubAdapter(cfg, minter, gate, fetch as unknown as FetchFn, apiBase).listChecks("deadbeefcafe");
}

/** The REAL `guard_ci_state`, sourced out of the real guards.sh. */
async function shellClassify(): Promise<string> {
  const script = [
    `ROOT=${JSON.stringify(ROOT)}`,
    `API=${JSON.stringify(apiBase)} CONFIG=/dev/null REPO=o/r PR=5180 LIVE=0`,
    'die() { echo "$*" >&2; exit 1; }',
    "cfg() { :; }",
    "guard_token() { :; }",
    `. ${JSON.stringify(join(ROOT, "scripts", "guards.sh"))}`,
    'guard_ci_state "deadbeefcafe"',
  ].join("\n");
  const { stdout } = await exec("bash", ["-c", script]);
  return stdout.trim();
}

describe("the shell CI classifier agrees with classifyCi", () => {
  /**
   * MUTATION: change `elif any($finished[]; .[1] == "success") then "green"`
   * to `then "red"` in scripts/guards.sh — every green case fails here.
   * Or delete `latestRunPerName` from src/cigate.ts — the two superseded-run
   * cases fail.
   */
  for (const c of CORPUS) {
    it(`agrees on: ${c.name}`, async () => {
      checkRuns = c.runs;
      statuses = c.statuses ?? [];
      const shell = await shellClassify();
      const ts = classifyCi(await adapterClassifyInput());
      expect(
        shell,
        `guard 4 is the only guard that gates an approval, and its two implementations disagree on "${c.name}": `
          + `scripts/guards.sh says "${shell}", src/cigate.ts says "${ts}". Change both, or the shell route — which is `
          + "the LIVE posting route — enforces a different rule from the one the tests pin.",
      ).toBe(ts);
    });
  }

  /**
   * THE ONE CASE WHERE THEY DO NOT AGREE, asserted as the disagreement it is.
   *
   * MC-15: when the check list cannot be read at all, `guard_ci_state` ends
   * `2>/dev/null || echo unknown`, and `guard_require_green_ci`'s `case`
   * treats `unknown` like `green` — "the guard blocks only what it can see".
   * That is a silent FAIL-OPEN on the only guard that gates approvals, and it
   * is asymmetric with guard 3 three functions above, which fails CLOSED and
   * loudly on an unreadable PR state.
   *
   * `classifyCi` has no such state: it takes a list, and an empty list is
   * `none`.
   *
   * This is NOT repaired here. Making guard 4 fail closed would withhold
   * approvals during a GitHub API blip — a live behaviour change on the
   * approval path, which is the owner's call and not a fence's. What the
   * fence owes is that the asymmetry is written down and cannot change
   * unnoticed in either direction.
   *
   * MUTATION: change the `*) ;;` arm of `guard_require_green_ci` to include
   * `unknown)` in the `die` branch — this fails, and the record should then
   * be deleted.
   */
  it("records the unreadable-checks asymmetry: guard 4 fails OPEN, guard 3 fails CLOSED (MC-15)", async () => {
    const guards = (await import("node:fs")).readFileSync(join(ROOT, "scripts", "guards.sh"), "utf8");

    // Guard 4's classifier still swallows its own failure into "unknown"…
    expect(guards).toMatch(/2>\/dev\/null \|\| echo unknown/);

    const requireGreen = /guard_require_green_ci\(\)[\s\S]*?\n\}/.exec(guards)?.[0] ?? "";
    expect(requireGreen, "guard_require_green_ci not found — this record is now vacuous").toContain("case ");

    // …and `unknown` is still NOT among the states that refuse. This is the
    // assertion the record turns on, and the first version did not have it:
    // it asserted only that a `*)` catch-all exists, which survives the fix,
    // because `green` needs that arm too. Applying this record's own named
    // repair left all seventeen tests passing — a self-retiring record that
    // does not retire, still reading "still broken" after the repair.
    const refusing = /case "\$state" in([\s\S]*?)esac/.exec(requireGreen)?.[1] ?? "";
    expect(refusing, "the `case` over the CI state moved — say what happens on an unreadable check list").toContain("red|pending");
    const dieArm = /^\s*(red\|pending[^)]*)\)/m.exec(refusing)?.[1] ?? "";
    if (dieArm.includes("unknown")) {
      throw new Error(
        "guard 4 now REFUSES on an unreadable check list — the MC-15 fail-open is fixed. Delete this record and "
          + "assert the closed behaviour directly; `tests/guards-shell.test.ts` is where the live case belongs.",
      );
    }

    // …while guard 3, three functions above, fails closed and says so.
    const requireOpen = /guard_require_open\(\)[\s\S]*?\n\}/.exec(guards)?.[0] ?? "";
    expect(requireOpen, "guard 3 must still fail CLOSED on an unreadable PR state").toContain("fail closed");
  });
});
