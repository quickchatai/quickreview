// The write-up of a resume rehearsal run (docs/worker-resume-rehearsal.md): counts
// and timings over the rows of tests/helpers/resume-rehearsal.ts. Nothing private
// is printed: no PR number, no session id, no path of the machine that ran it,
// and no transcript text. A source is a label and a file count; a problem file is
// named by the first eight hex digits of the hash of its name.
import { createHash } from "node:crypto";
import { legacyCwdResolution, legacyPathsResolving } from "../../src/resumecheck.js";
import type { RehearsalRow } from "./resume-rehearsal.js";

export interface RunMeta {
  /** ISO date of the run. */
  date: string;
  /** Git commit of the tree it ran on. */
  commit: string;
  /** Per source: its label and what it is. */
  sources: Array<{ label: string; what: string }>;
  /** The legacy mounts the release image's container has (legacyMountDirs). */
  mountDirs: string[];
  /** Pass/fail of the canary-10 files run beside the rehearsal, as recorded. */
  canary10: Array<{ file: string; tests: number; passed: boolean }>;
}

export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const ms = (n: number): string => (n < 10 ? n.toFixed(1) : String(Math.round(n)));
const mb = (n: number): string => (n / 1_048_576).toFixed(1);
const tally = (items: Iterable<string>): Map<string, number> => {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
};
const list = (m: Map<string, number>, limit = 12): string => {
  const all = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = all.slice(0, limit).map(([k, n]) => `\`${k}\` ${n}`);
  if (all.length > limit) shown.push(`and ${all.length - limit} more`);
  return shown.join(", ") || "none";
};
const stem = (name: string): string => createHash("sha256").update(name).digest("hex").slice(0, 8);

export interface Totals {
  files: number;
  bytes: number;
  resumed: number;
  failed: RehearsalRow[];
}

export function totals(rows: readonly RehearsalRow[]): Totals {
  return {
    files: rows.length,
    bytes: rows.reduce((n, r) => n + r.facts.bytes, 0),
    resumed: rows.filter((r) => r.problems.length === 0).length,
    failed: rows.filter((r) => r.problems.length > 0),
  };
}

function timingTable(rows: readonly RehearsalRow[]): string[] {
  const line = (name: string, pick: (r: RehearsalRow) => number): string => {
    const v = rows.map(pick);
    return `| ${name} | ${ms(percentile(v, 0.5))} | ${ms(percentile(v, 0.95))} | ${ms(Math.max(0, ...v))} |`;
  };
  return [
    "| per file, ms | median | p95 | max |",
    "|---|---|---|---|",
    line("our JSON parse of every line", (r) => r.facts.parseMs),
    line("pi: SessionManager.open + buildSessionContext", (r) => r.openMs),
    line("the whole worker round on the faux (connect to exit)", (r) => r.workerMs),
  ];
}

function sourceSection(
  label: string,
  what: string,
  rows: readonly RehearsalRow[],
  meta: RunMeta,
): string[] {
  const t = totals(rows);
  const out: string[] = [];
  out.push(`### ${label}`, "", what, "");
  const biggest = [...rows].sort((a, b) => b.facts.bytes - a.facts.bytes)[0];
  out.push(
    `${t.files} JSONL file(s), ${mb(t.bytes)} MB; ${t.resumed} resumed with every check green, ${t.failed.length} not.` +
      (biggest
        ? ` Largest ${mb(biggest.facts.bytes)} MB (${biggest.facts.lines} entries): our parse ${ms(biggest.facts.parseMs)} ms, pi ${ms(biggest.openMs)} ms, worker round ${ms(biggest.workerMs)} ms.`
        : ""),
    "",
    ...timingTable(rows),
    "",
  );
  const sizeBuckets = new Map<string, number[]>();
  for (const r of rows) {
    const b =
      r.facts.bytes < 1 << 20 ? "< 1 MB" : r.facts.bytes < 10 << 20 ? "1-10 MB" : ">= 10 MB";
    sizeBuckets.set(b, [...(sizeBuckets.get(b) ?? []), r.openMs]);
  }
  out.push(
    "pi's open time by file size: " +
      ["< 1 MB", "1-10 MB", ">= 10 MB"]
        .filter((b) => sizeBuckets.has(b))
        .map(
          (b) =>
            `${b}: ${sizeBuckets.get(b)!.length} file(s), median ${ms(percentile(sizeBuckets.get(b)!, 0.5))} ms, max ${ms(Math.max(...sizeBuckets.get(b)!))} ms`,
        )
        .join("; ") +
      ".",
    "",
  );

  const check = (name: string, ok: number): string => `| ${name} | ${ok} / ${t.files} |`;
  out.push(
    "| check | files passing |",
    "|---|---|",
    check(
      "worker exits 0 and resumes the file (not a new session)",
      rows.filter((r) => r.exit === 0 && r.resumed).length,
    ),
    check("the session id is kept (the header's id)", rows.filter((r) => r.idKept).length),
    check("the provider cache key is that id", rows.filter((r) => r.cacheKeyIsId).length),
    check(
      "same file, no JSONL beside it, every earlier line byte-identical",
      rows.filter((r) => r.fileKept && r.appendOnly && r.newFiles.length === 0).length,
    ),
    check("the request replays the file's history", rows.filter((r) => r.historyKept).length),
    check(
      "exactly one provider request (the faux's)",
      rows.filter((r) => r.providerRequests === 1).length,
    ),
    check(
      "every line is JSON and the header is a v3 session",
      rows.filter((r) => r.facts.badLines === 0 && r.facts.header?.version === 3).length,
    ),
    "",
  );

  // Cache prefix.
  const withSystem = rows.filter((r) => r.facts.system !== null);
  const sectionsKept = withSystem.filter((r) =>
    Object.values(r.sectionsVsStored).every((v) => v === "same"),
  );
  out.push(
    "**Cache prefix.** pi stores the system message (prompt sections and tool schemas) as the first entry and replays it as it is.",
    withSystem.length === 0
      ? `None of the ${t.files} files carries one (written before pi stored it): the worker builds the prompt fresh for them, so their prefix is the new build's and not the old session's.`
      : `${withSystem.length} of ${t.files} files carry one; ${sectionsKept.length} of those are sent with every section byte-equal to the stored one, so the prefix the old session cached against is unchanged. Against a session born in the same world, ${rows.filter((r) => r.systemVsBorn === "differs").length} send another system message and ${rows.filter((r) => r.toolsVsBorn === "differs").length} other tool schemas: they keep the old build's, which is what keeps the prefix.`,
    `The worker's tools that the file did not record are announced after the replayed history, in a system message of their own (the whole list, for a file with no stored one): ${list(tally(rows.flatMap((r) => r.addedTools)))}.`,
    `Tools the file records that the worker's session does not register (the model may still try them): ${list(tally(rows.flatMap((r) => r.staleTools)))}.`,
    `The stored preamble (standing instructions, frozen at the session's birth) still names tools the worker does not register: ${list(tally(rows.flatMap((r) => (r.facts.system?.preambleTools ?? []).filter((t) => r.staleTools.includes(t)))))}. The round order's engine section is what redirects the model to \`lens\` and \`lens_wave\`.`,
    `The stored context file against the current reviewer stub: ${list(tally(rows.map((r) => r.facts.system?.stub ?? "no system message")))}.`,
    `The \`cwd\` section the old session was shown: ${list(tally(withSystem.map((r) => r.facts.system?.cwd ?? "(none)")))}.`,
    "",
  );

  // Entries.
  const entryTypes = new Map<string, number>();
  const customTypes = new Map<string, number>();
  const markers = new Map<string, number>();
  for (const r of rows) {
    for (const [k, n] of Object.entries(r.facts.entryTypes))
      entryTypes.set(k, (entryTypes.get(k) ?? 0) + n);
    for (const [k, n] of Object.entries(r.facts.customTypes))
      customTypes.set(k, (customTypes.get(k) ?? 0) + n);
    for (const [k, n] of Object.entries(r.facts.markers)) markers.set(k, (markers.get(k) ?? 0) + n);
  }
  const filesWith = (marker: string): number =>
    rows.filter((r) => (r.facts.markers[marker] ?? 0) > 0).length;
  out.push(
    "**Entries the worker had to tolerate** (all resumed):",
    "",
    `- entry types: ${list(entryTypes)}`,
    `- custom entries: ${list(customTypes)}`,
    `- markers in user turns: ${list(markers)}. The session-command ledger's \`qcr-command\` turns are in ${filesWith("qcr-command")} file(s) and the inject bridge's \`qcr-inject\` turns in ${filesWith("qcr-inject")}; their writers are deleted and the old turns stay in the history.`,
    "",
  );

  // Legacy paths.
  const cwdRes = tally(
    rows.map((r) =>
      r.facts.header?.cwd
        ? `${r.facts.header.cwd} -> ${legacyCwdResolution(r.facts.header.cwd, meta.mountDirs)}`
        : "no cwd",
    ),
  );
  const refs = new Map<string, number>();
  const gone = new Map<string, number>();
  for (const r of rows) {
    const split = legacyPathsResolving(r.facts.legacyPaths, meta.mountDirs);
    for (const [k, n] of Object.entries(split.resolving)) refs.set(k, (refs.get(k) ?? 0) + n);
    for (const [k, n] of Object.entries(split.gone)) gone.set(k, (gone.get(k) ?? 0) + n);
  }
  out.push(
    "**Legacy paths.** Header cwd against the release image's legacy mounts " +
      `(${meta.mountDirs.map((d) => `\`/opt/quickreview/sandbox/${d}\``).join(", ")}): ${list(cwdRes)}.`,
    `Paths under \`/opt/quickreview/sandbox/\` that the history mentions, by first component: still mounted ${list(refs)}; not in the release image ${list(gone)}.`,
    "",
  );

  if (t.failed.length > 0) {
    out.push("Files with a problem:", "");
    for (const r of t.failed)
      out.push(`- \`${stem(r.file)}\` (${mb(r.facts.bytes)} MB): ${r.problems.join("; ")}`);
    out.push("");
  }
  return out;
}

/** The document, from the rows of each source (label -> rows). */
export function renderReport(bySource: ReadonlyMap<string, RehearsalRow[]>, meta: RunMeta): string {
  const all = [...bySource.values()].flat();
  const t = totals(all);
  const out: string[] = [
    "# Worker resume rehearsal",
    "",
    "At the cutover every open PR resumes in a per-round worker for the first time. This records the same resume done offline first: the real worker (`src/botworker.ts`) resumes a copy of each PR JSONL on pi-ai's faux provider, in the worker rig (a fake daemon on a real unix socket, a production-shaped root). No model, no network: the offline guard of `tests/worker-resume-rehearsal.test.ts` fails the run on any connection attempt, and the JSONLs themselves are only read (every one is copied into a scratch world that is deleted afterwards). Cost: $0.",
    "",
    `Run ${meta.date} on ${meta.commit}. ${t.files} JSONL file(s), ${mb(t.bytes)} MB: **${t.resumed} resumed with every check green, ${t.failed.length} not.**`,
    "",
    "Re-run it: `scripts/worker-resume-rehearsal.sh <label>=<dir> ...` (see the script's header). The same resume check runs on the day inside the cutover preflight, on the library half of this rehearsal (`src/resumecheck.ts`).",
    "",
    "## What is checked, per file",
    "",
    "1. **Parse time**: our own pass over every line (`inspectSessionJsonl`), and pi's `SessionManager.open` + `buildSessionContext`, which is what a worker pays before its first request.",
    "2. **The id is kept**: the resumed session's id is the header's id, the provider's cache key (`options.sessionId` of the request) is that id, and the file is the same file.",
    "3. **Append-only**: no second JSONL appears beside it and every earlier line is byte-for-byte what it was.",
    "4. **Cache prefix** (canary 10's concern, on real history): the request's system message is compared section by section (`preamble`, `project_context`, `cwd`) with the stored one, its tool schemas with the stored `toolsAdded`, and both with a session born in the same world. The reviewer stub is looked for in the stored context file.",
    "5. **Custom entries are tolerated**: the file's entry types, custom entries and the session-command / inject-bridge markers are counted, and the file resumed anyway.",
    "6. **Legacy cwd headers** resolve under the release image's legacy mounts (read from `deploy/ansible/playbook.yml`), and the legacy paths the history mentions are split into those the image still has and those it does not.",
    "",
    "**What an offline run cannot show.** The faux has no cache: it shows the bytes the prompt prefix is made of (the stored system message and tool schemas, replayed as they were, the provider session id unchanged), not a provider's cache hit. The tail the worker appends (the engine's tool announcement and the round order) is new text and is not cached on the first round.",
    "",
    "Compaction is not run in the rehearsal (`compact: false`): it is one more provider call, and `tests/botworker.test.ts` holds it.",
    "",
    "## Results",
    "",
  ];
  for (const s of meta.sources) {
    const rows = bySource.get(s.label);
    if (rows) out.push(...sourceSection(s.label, s.what, rows, meta));
  }
  out.push(
    "## What the cutover should know",
    "",
    "- Every PR JSONL resumes in the worker under its own id, in its own file, append-only, with the provider's cache key unchanged. Parse time is a few milliseconds for most files and under a second for the largest.",
    "- pi 1.3 stores the system message and the tool schemas in the file and replays them verbatim, so the resumed prefix is the old session's, not the worker's. What the worker adds (the engine's tools, `lens` and `lens_wave`) arrives after the replayed history, in a system message of its own: the first resumed round pays for that tail and the round order only.",
    "- The stored system message and tool list also freeze what the old session was told. The file still advertises `subagent` and `launch_plan` (the native lens pair), which the worker does not register, and its preamble still says to launch passes as subagents. A call to either is a tool-not-found; the round order's engine section is what points the model at `lens` and `lens_wave`.",
    "- Every header cwd is `/opt/quickreview/sandbox`, which the release image's container has only as the parent of the legacy mounts (`wt` and the base clone). It resolves, but the old production tree is not in it. Absolute `/opt/quickreview/sandbox/state/...` (and `verdict`, `archive`, `commands`, ...) paths that the history mentions do not exist in the image: those directories are under the app root there. `wt/...` paths still resolve through the legacy mounts. Relative paths resolve against the worker's cwd, which must be the app root.",
    "- The `qcr-command` and `qcr-inject` turns of the session-command ledger and the inject bridge, and the custom ledger entries, are inert text and entries to the worker; deleting their writers does not touch the old turns.",
    "",
    "## Canary 10 (cache-prefix parity with the interactive build, stub included)",
    "",
    "Run beside the rehearsal, on the same tree. These start the real interactive `pi` in a pty over a loopback endpoint and compare the raw request bodies with the SDK build's.",
    "",
    "| file | tests | result |",
    "|---|---|---|",
    ...meta.canary10.map((c) => `| \`${c.file}\` | ${c.tests} | ${c.passed ? "pass" : "FAIL"} |`),
    "",
  );
  return out.join("\n");
}
