// `cluster_findings` — the duplicate merge's deterministic grouping step
// (docs/duplicate-merge.md, `[review] dedup_merge`).
//
// A PR round's main session calls it once, after its lenses return and before
// it dispatches pass-validate, with every surviving candidate; it answers the
// candidate GROUPS (packages/pi-plugin/src/dedup.ts clusterFindings) the validator then judges
// as units. Loaded on the argv of BOTH routes — the daemon's PR sessions
// (SessionManager.extensionPaths) and the benchmark session
// (src/bench/runner.ts) — so a bench round groups exactly as a live round 1
// does. It reads nothing and writes nothing: pure in, pure out. A subagent
// child loads no argv extension, so a lens can never call it (rule 9).
//
// The same extension registers `coverage_gaps` (packages/pi-plugin/src/coverage.ts): after the
// lenses return, the eligible changed files nothing addressed or swept,
// packed into pass-sweep rows.
//
// `CLUSTER_TOOL` / `COVERAGE_TOOL` are the QcrTool literals; the two tools pi
// sees are their `defineTool` ToolDefinitions (FINDING_CLUSTERS_TOOLS), so a
// tmux pi (the default export, which registers them) and an SDK session
// (`createFindingClusters()` as an extension factory, or the same list as
// customTools) carry identical objects. The extension reads no config and no env.
//
// VERIFY-ON-PIN: defineTool's and registerTool's definition shape and execute's
// positional signature, as pi's ToolDefinition declares them.
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { textResult as text, toPiTool, type QcrTool } from "./pi-tool.js";
import { CLOSE_LINES, clusterFindings, renderGroups, type ClusterCandidate } from "../src/dedup.js";
import { coverageGaps, coverageReason, type CoverageFile } from "../src/coverage.js";

/** Read the tool's `candidates` argument into ClusterCandidates; anything
 * malformed is reported, never thrown. */
export function readCandidates(raw: unknown): {
  candidates: ClusterCandidate[];
  problems: string[];
} {
  const problems: string[] = [];
  const arr = typeof raw === "string" ? safeParse(raw, problems) : raw;
  if (!Array.isArray(arr))
    return { candidates: [], problems: [...problems, "candidates must be an array"] };
  const candidates: ClusterCandidate[] = [];
  const seen = new Set<string>();
  arr.forEach((c, i) => {
    if (typeof c !== "object" || c === null) return void problems.push(`#${i + 1}: not an object`);
    const o = c as Record<string, unknown>;
    let id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `#${i + 1}`;
    if (seen.has(id)) {
      const base = id;
      id = `${base}#${i + 1}`;
      problems.push(`#${i + 1}: duplicate id ${base}, renamed ${id}`);
    }
    seen.add(id);
    const line =
      typeof o.line === "number"
        ? o.line
        : typeof o.line === "string" && /^\d+$/.test(o.line)
          ? Number(o.line)
          : null;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    candidates.push({
      id,
      path: str(o.path),
      line,
      title: str(o.title),
      body: str(o.body),
      lens: str(o.lens),
      severity: str(o.severity),
      fix_target: str(o.fix_target),
    });
  });
  return { candidates, problems };
}

function safeParse(s: string, problems: string[]): unknown {
  try {
    return JSON.parse(s);
  } catch (err) {
    problems.push(`candidates is not valid JSON: ${String(err).slice(0, 120)}`);
    return null;
  }
}

export const CLUSTER_TOOL: QcrTool = {
  name: "cluster_findings",
  label: "Cluster findings",
  description: `Group this round's candidate findings before pass-validate: candidates in the same file within ${CLOSE_LINES} lines, naming a shared identifier, or with the same fix target form one group. Returns the groups to paste verbatim into the validate task string under CANDIDATE GROUPS.`,
  parameters: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        description: "Every surviving candidate from every lens.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            path: { type: "string" },
            line: { type: "number" },
            title: { type: "string" },
            body: { type: "string" },
            lens: { type: "string" },
            severity: { type: "string" },
            fix_target: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    required: ["candidates"],
  },
  execute(_id, params) {
    const { candidates, problems } = readCandidates(params.candidates);
    const result = clusterFindings(candidates);
    const byId = new Map(candidates.map((c) => [c.id, c]));
    const head = `${candidates.length} candidate(s) → ${result.groups.length} group(s), ${result.singletons.length} alone.`;
    const warn = problems.length ? `\nProblems: ${problems.join("; ")}` : "";
    return text(`${head}${warn}\n\nCANDIDATE GROUPS\n${renderGroups(result, byId)}`, {
      groups: result.groups,
      singletons: result.singletons,
    });
  },
};

/** Read `eligible` (the order's coverage files), `addressed` (paths) and
 * the optional `swept` (paths a returned sweep row had in focus; absent reads
 * as none). */
export function readCoverageArgs(params: Record<string, unknown>): {
  eligible: CoverageFile[];
  addressed: string[];
  swept: string[];
  problems: string[];
} {
  const problems: string[] = [];
  const parse = (raw: unknown, name: string): unknown =>
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw);
          } catch {
            problems.push(`${name} is not valid JSON`);
            return null;
          }
        })()
      : raw;
  const el = parse(params.eligible, "eligible");
  const ad = parse(params.addressed, "addressed");
  const eligible: CoverageFile[] = Array.isArray(el)
    ? el.flatMap((x) =>
        typeof x === "object" &&
        x !== null &&
        typeof (x as Record<string, unknown>).path === "string"
          ? [
              {
                path: (x as { path: string }).path,
                lines: Number((x as { lines?: unknown }).lines) || 0,
              },
            ]
          : [],
      )
    : (problems.push("eligible must be an array"), []);
  const addressed: string[] = Array.isArray(ad)
    ? ad.filter((x): x is string => typeof x === "string")
    : (problems.push("addressed must be an array"), []);
  const sw = params.swept === undefined ? [] : parse(params.swept, "swept");
  const swept: string[] = Array.isArray(sw)
    ? sw.filter((x): x is string => typeof x === "string")
    : (problems.push("swept must be an array"), []);
  return { eligible, addressed, swept, problems };
}

export const COVERAGE_TOOL: QcrTool = {
  name: "coverage_gaps",
  label: "Coverage gaps",
  description:
    "After the planned lenses return: the coverage-eligible changed source files no lens raised a finding on and no RETURNED pass-sweep row had in its focus, packed into at most two pass-sweep rows, each with the reason line to put at the top of its task string.",
  parameters: {
    type: "object",
    properties: {
      eligible: {
        type: "array",
        description: "The round order's coverage-eligible files, verbatim.",
        items: {
          type: "object",
          properties: { path: { type: "string" }, lines: { type: "number" } },
          required: ["path"],
        },
      },
      addressed: {
        type: "array",
        description: "Every file path any lens raised a finding on (any disposition).",
        items: { type: "string" },
      },
      swept: {
        type: "array",
        description:
          "Every file in the focus list of a pass-sweep row that RETURNED (findings or NONE). A pass-behaviour-delta row does not count (it skips pure additions). A row that failed, errored or was cut short contributes nothing.",
        items: { type: "string" },
      },
    },
    required: ["eligible", "addressed"],
  },
  execute(_id, params) {
    const { eligible, addressed, swept, problems } = readCoverageArgs(params);
    const gaps = coverageGaps(eligible, addressed, undefined, undefined, swept);
    const warn = problems.length ? `\nProblems: ${problems.join("; ")}` : "";
    const rows = gaps.groups.map(
      (g, i) => `ROW ${i + 1}: focus ${JSON.stringify(g)}\n  reason: ${coverageReason(g)}`,
    );
    const body = gaps.groups.length
      ? `${gaps.uncovered.length} of ${eligible.length} eligible file(s) unaddressed and unswept → ${gaps.groups.length} pass-sweep row(s).\n${rows.join("\n")}${gaps.unchecked.length ? `\nUNCHECKED (past the row cap): ${gaps.unchecked.join(", ")}` : ""}`
      : `All ${eligible.length} eligible file(s) addressed or swept — no coverage row.`;
    return text(`${body}${warn}`, {
      groups: gaps.groups,
      uncovered: gaps.uncovered,
      unchecked: gaps.unchecked,
    });
  },
};

/** The two tools as pi ToolDefinitions: registered by the extension, or handed
 * to an SDK session as `customTools`. */
export const FINDING_CLUSTERS_TOOLS: ToolDefinition[] = [CLUSTER_TOOL, COVERAGE_TOOL].map((t) =>
  defineTool(toPiTool(t)),
);

/** The extension has nothing to configure: both tools are pure. */
export type FindingClustersConfig = Record<string, never>;

/** The factory an SDK session loads. The default export below is its env shim. */
export function createFindingClusters(
  _config: FindingClustersConfig = {},
): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    for (const tool of FINDING_CLUSTERS_TOOLS) pi.registerTool(tool);
  };
}

/** The pi that loads this file by path is the host: a pi without
 * `registerTool` gets no tools (the core prints nothing of its own). */
const activate = (pi: ExtensionAPI): void => {
  if (typeof pi.registerTool !== "function") return;
  createFindingClusters()(pi);
};

export default activate;
