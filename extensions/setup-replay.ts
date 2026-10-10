// setup-replay — the PR replay half of the companion's setup tool belt. Not
// an extension of its own: extensions/setup.ts (the one setup & scan
// extension) registers these beside the setup_* and scan_* tools. The
// companion judges — which recent PRs show the tuning best, what the
// difference means — and these tools act: every number, refusal and record
// is ReplayRunner's.
//
//   - setup_replay_preview: one or two PRs, each side's review plan under its
//     profile (old: the profile before setup's last write, by default; new:
//     the profile as it is now) and the price — stated before anything runs;
//   - setup_replay_start: start exactly what the preview showed (its key), in
//     the background, as subagents; hard stop at the stated cap;
//   - setup_replay_status: progress, then the two reviews side by side;
//   - setup_replay_stop.
//
// Convention (setup.ts, setup-scan.ts): every tool answers a refusal as its
// result, never a throw.
import { readFileSync } from "node:fs";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { parseConfig, sandboxRoot } from "../src/config.js";
import { locateConfig, stateHome } from "../src/install.js";
import { stateHomeFs, tokenFileGitHubReader } from "../src/setup/adapters.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import type { Refusal } from "../src/setup/engine.js";
import {
  MAX_REPLAY_PRS,
  REPLAY_CAP_FACTOR,
  SIDES,
  type ReplayFinding,
  type SideName,
} from "../src/setup/replay.js";
import { replaySides } from "../src/setup/replaybuild.js";
import {
  compareRun,
  ReplayRunner,
  type ReplayComparison,
  type ReplayPlanRow,
  type ReplayPreview,
  type ReplayPrState,
  type ReplaySideView,
  type ReplayStatus,
} from "../src/setup/replayrun.js";
import { gitReplaySource } from "../src/setup/replaysource.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return details
    ? { content: [{ type: "text", text: t }], details }
    : { content: [{ type: "text", text: t }] };
}

function refused(what: string, r: Refusal): PiToolResult {
  return text(`${what} refused:\n${r.errors.map((e) => `✗ ${e}`).join("\n")}`);
}

const usd = (n: number | null): string => (n === null ? "unknown" : `$${n.toFixed(2)}`);
const pad = (s: string, n: number): string =>
  s.length >= n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);

// ---- rendering ---------------------------------------------------------------

function sidesLine(sides: Record<SideName, ReplaySideView>): string {
  return `old = ${sides.old.basis}; new = ${sides.new.basis}`;
}

/** One PR's two plans as one table: a row per lens (a sweep row per group
 * of files), the tier on each side, and the case that runs it. */
export function renderPlans(
  pr: ReplayPrState,
  priceOf: (caseId: string) => string = () => "",
): string {
  const label = (r: ReplayPlanRow): string =>
    r.focus ? `${r.lens} (${r.focus.length} file${r.focus.length === 1 ? "" : "s"})` : r.lens;
  const keyOf = (r: ReplayPlanRow): string => `${r.lens}\0${(r.focus ?? []).join(",")}`;
  const rows = new Map<string, Partial<Record<SideName, ReplayPlanRow>>>();
  for (const side of SIDES)
    for (const r of pr.plans[side])
      rows.set(keyOf(r), { ...(rows.get(keyOf(r)) ?? {}), [side]: r });
  const lines = [`  ${pad("lens", 30)} ${pad("old", 11)} ${pad("new", 11)} case`];
  for (const row of rows.values()) {
    const any = (row.old ?? row.new)!;
    const same = row.old && row.new && row.old.case === row.new.case;
    const cases = same
      ? `${row.old!.case} — the same on both, run once`
      : SIDES.filter((s) => row[s])
          .map((s) => `${s}: ${row[s]!.case}`)
          .join(", ");
    const price = [
      ...new Set(
        SIDES.filter((s) => row[s])
          .map((s) => priceOf(row[s]!.case))
          .filter(Boolean),
      ),
    ].join(" + ");
    lines.push(
      `  ${pad(label(any), 30)} ${pad(row.old?.tier ?? "—", 11)} ${pad(row.new?.tier ?? "—", 11)} ${cases}${price ? `, ${price}` : ""}`,
    );
  }
  return lines.join("\n");
}

function prTitle(pr: ReplayPrState): string {
  return `PR #${pr.number} "${pr.title}" (${pr.merged ? "merged" : pr.state}) at ${pr.sha.slice(0, 12)}, diffed against ${pr.base.slice(0, 12)}: ${pr.files} file(s), ${pr.diff_lines} diff lines`;
}

export function renderReplayPreview(p: ReplayPreview): string {
  const est = new Map(p.cases.map((c) => [c.id, `~${usd(c.estimate_usd)}`]));
  const out: string[] = [
    `REPLAY of ${p.prs.map((x) => `#${x.number}`).join(" and ")} — ${sidesLine(p.sides)}.`,
    `Estimate ${usd(p.estimate_usd)} for ${p.cases.length} case(s) (${p.shared} the same on both sides, run once). It stops HARD at ${usd(p.cap_usd)} (${REPLAY_CAP_FACTOR}× the estimate). ` +
      `Up to ${p.concurrency} case(s) at once, in the background.`,
    `Priced at: ${p.rate_bases.join("; ")}.`,
  ];
  for (const pr of p.prs) out.push(`${prTitle(pr)}\n${renderPlans(pr, (id) => est.get(id) ?? "")}`);
  out.push(
    `To run it: setup_replay_start with key ${p.key} — only after the operator agreed to the cost. Nothing is posted anywhere.`,
  );
  return out.join("\n\n");
}

function finding(f: ReplayFinding): string {
  const at = `${f.path}:${f.start === f.end ? f.start : `${f.start}-${f.end}`}`;
  const doubt = f.doubt
    ? ` — MAY NOT BE VALID (${f.doubt.word})`
    : f.validated
      ? ""
      : " — unvalidated";
  return `${at} (${f.lens}, ${f.kind}) ${f.claim}${doubt}`;
}

function counts(fs: readonly ReplayFinding[]): string {
  const by = new Map<string, number>();
  for (const f of fs) by.set(f.severity, (by.get(f.severity) ?? 0) + 1);
  return `${fs.length}${fs.length ? ` (${[...by.entries()].map(([s, n]) => `${s} ${n}`).join(", ")})` : ""}`;
}

/** One PR's two reviews, side by side. */
export function renderComparison(
  c: ReplayComparison,
  sides: Record<SideName, ReplaySideView>,
): string {
  const col = (s: SideName): string =>
    `${counts(c.findings[s])}${c.complete[s] ? "" : " — INCOMPLETE"}`;
  // A shared cost of null is UNKNOWN (a shared case ran unpriced): shown as
  // such, never dropped as if nothing were shared.
  const cost = (s: SideName): string =>
    `${usd(c.cost[s])}${c.cost.shared !== 0 ? ` + ${usd(c.cost.shared)} shared` : ""}`;
  const out = [
    `PR #${c.pr} "${c.title}"`,
    `  ${pad("", 12)} ${pad(`old (${sides.old.profile || "no profile"})`, 34)} new (${sides.new.profile || "no profile"})`,
    `  ${pad("findings", 12)} ${pad(col("old"), 34)} ${col("new")}`,
    `  ${pad("cost", 12)} ${pad(cost("old"), 34)} ${cost("new")}`,
  ];
  out.push(`  Both found (${c.both.length}):`);
  for (const b of c.both) {
    out.push(`    [${b.old!.severity} → ${b.new!.severity}] ${finding(b.new!)}`);
    if (b.old!.claim !== b.new!.claim) out.push(`        old said: ${b.old!.claim}`);
  }
  out.push(
    `  Only the OLD profile (${c.old_only.length}):`,
    ...c.old_only.map((f) => `    [${f.severity}] ${finding(f)}`),
  );
  out.push(
    `  Only the NEW profile (${c.new_only.length}):`,
    ...c.new_only.map((f) => `    [${f.severity}] ${finding(f)}`),
  );
  return out.join("\n");
}

export function renderReplayStatus(s: ReplayStatus): string {
  const out: string[] = [];
  for (const p of s.problems) out.push(`✗ ${p}`);
  const r = s.run;
  if (r === null) {
    out.push(
      s.problems.length > 0 ? "Latest replay: UNKNOWN — see above." : "No replay has run yet.",
    );
    return out.join("\n");
  }
  const done = r.cases.filter((c) => c.status === "done").length;
  out.push(
    `${r.id}: ${r.display.toUpperCase()} — ${done}/${r.cases.length} case(s), spent ${usd(r.spent_usd)} of the ${usd(r.cap_usd)} cap (estimate ${usd(r.estimate_usd)})` +
      (r.unpriced_cases ? `, ${r.unpriced_cases} unpriced case(s) counted at their estimate` : "") +
      `. ${sidesLine(r.sides)}.`,
  );
  if (r.display === "interrupted")
    out.push(
      "It was interrupted (the companion restarted). Preview again and start again to replay.",
    );
  if (r.display === "capped")
    out.push("It stopped at its hard cap: what finished is below; the rest did not run.");
  for (const c of r.cases.filter((x) => x.status === "failed").slice(0, 10))
    out.push(`  ✗ ${c.id} ${c.lens}: ${c.error}`);
  for (const p of r.problems.slice(-5)) out.push(`  ! ${p}`);
  if (r.display === "running") {
    for (const c of r.cases)
      out.push(
        `  - ${c.id} PR #${c.pr} ${c.lens} at ${c.tier} [${c.sides.join("+")}]: ${c.status}${c.cost_usd !== null ? `, ${usd(c.cost_usd)}` : ""}`,
      );
    return out.join("\n");
  }
  for (const c of compareRun(r)) out.push(renderComparison(c, r.sides));
  return out.join("\n\n");
}

// ---- tool belt ---------------------------------------------------------------

const PRS_PARAM = {
  type: "array",
  items: { type: "number" },
  description: `One or two PR numbers of the reviewed repo (at most ${MAX_REPLAY_PRS}) — recent ones the tuning should show on.`,
} as const;

const OLD_PARAM = {
  type: "string",
  description:
    "The OLD side. Default: the profile as it stood before setup's last write to it. Or a recorded write's id (the profile before that " +
    'write), "profile:<name>" for another profile as it is now, or "none" for the reviewer as shipped (no profile).',
} as const;

const NEW_PARAM = {
  type: "string",
  description:
    "The NEW side's profile. Default: the one setup works on (the interview's, else the live config's).",
} as const;

export function replayToolDefinitions(replay: ReplayRunner): PiToolDefinition[] {
  const preview: PiToolDefinition = {
    name: "setup_replay_preview",
    label: "Replay preview",
    description:
      "Preview a replay of one or two recent PRs with the OLD and the NEW repo profile: each side's review plan (the lenses and tiers a " +
      "PR round would run under that profile) and the price — cases the two sides share run once. Free: nothing runs, nothing is posted. " +
      "Tell the operator the cost before starting.",
    promptSnippet: "Preview an old-vs-new profile replay and its cost",
    parameters: {
      type: "object",
      properties: { prs: PRS_PARAM, old: OLD_PARAM, new_profile: NEW_PARAM },
      required: ["prs"],
    },
    execute: async (_id, params) => {
      const r = await replay.preview({
        prs: params?.prs,
        old: params?.old,
        new_profile: params?.new_profile,
      });
      if (!r.ok) return refused("Replay preview", r);
      return text(renderReplayPreview(r.preview), {
        preview: {
          key: r.preview.key,
          estimate_usd: r.preview.estimate_usd,
          cap_usd: r.preview.cap_usd,
          cases: r.preview.cases.length,
          shared: r.preview.shared,
        },
      });
    },
  };
  const start: PiToolDefinition = {
    name: "setup_replay_start",
    label: "Start the replay",
    description:
      "Start exactly the replay the last setup_replay_preview showed — pass its key. It runs in the background as subagents (read-only, " +
      "posting nothing) and stops HARD at the stated cap. Refused if a profile, a PR or a price moved since the preview. Only after the " +
      "operator agreed to the cost.",
    promptSnippet: "Start the previewed replay",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    execute: async (_id, params) => {
      const r = await replay.start({ key: params?.key });
      if (!r.ok) return refused("Replay start", r);
      return text(
        `Replay ${r.run.id} started: ${r.run.cases.length} case(s), hard stop ${usd(r.run.cap_usd)}. It runs in the background — ` +
          "setup_replay_status shows progress, then the two reviews side by side; setup_replay_stop stops it.",
        { run: { id: r.run.id, cases: r.run.cases.length, cap_usd: r.run.cap_usd } },
      );
    },
  };
  const status: PiToolDefinition = {
    name: "setup_replay_status",
    label: "Replay status",
    description:
      "The latest replay: progress and spend while it runs; once its cases are in, each PR's old and new review side by side — what both " +
      "found (severity on each side), what only the old profile found, what only the new one did, and what each side cost.",
    promptSnippet: "Show the replay and the old-vs-new comparison",
    parameters: NO_PARAMS,
    execute: async () => {
      const s = replay.status();
      return text(renderReplayStatus(s), { state: s.run?.display ?? null });
    },
  };
  const stop: PiToolDefinition = {
    name: "setup_replay_stop",
    label: "Stop the replay",
    description:
      "Stop the running replay: in-flight cases are aborted, no more start. What finished stays, shown by setup_replay_status.",
    promptSnippet: "Stop the running replay",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = replay.stop();
      if (!r.ok) return refused("Replay stop", r);
      return text(`Stopping replay ${r.id}. What finished is kept.`);
    },
  };
  return [preview, start, status, stop];
}

// ---- assembly ------------------------------------------------------------------

/** The replay runner the companion's belt drives: the PR through the
 * read-only GitHub token, its code from the reviewed checkout, both sides
 * resolved and built in the state home, each case a background pi leaf over
 * that side's build. */
export function buildReplay(
  reviewedRepo: string,
  env: NodeJS.ProcessEnv = process.env,
  concurrency?: number,
): ReplayRunner {
  const root = env.QCR_ROOT?.trim() || sandboxRoot();
  const home = stateHome(env);
  const state = stateHomeFs(home);
  const clock = (): Date => new Date();
  // The repo the PRs belong to: the live config's `[github] repo`, read when
  // a PR is (a config edited since is picked up; an unreadable one refuses).
  const repo = (): string => {
    try {
      return parseConfig(readFileSync(locateConfig({ env }).path, "utf8")).github.repo;
    } catch {
      return "";
    }
  };
  const github = tokenFileGitHubReader({
    envFile: env.QCR_GITHUB_READ_ENV,
    fetch: (input, init) => fetch(input, init),
    clock,
  });
  return new ReplayRunner({
    state,
    clock,
    source: gitReplaySource({ github, repo, repoRoot: reviewedRepo, stateRoot: home }),
    sides: (req) => replaySides({ root, env, stateRoot: home, state, clock }, req),
    cases: (agentsDir) => piCaseRunner({ agentsDir, cwd: root }),
    ...(concurrency !== undefined ? { concurrency } : {}),
    log: (line) => console.error(line),
  });
}
