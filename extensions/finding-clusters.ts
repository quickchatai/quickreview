// `cluster_findings` — the duplicate merge's deterministic grouping step
// (docs/duplicate-merge.md, `[review] dedup_merge`).
//
// A PR round's main session calls it once, after its lenses return and before
// it dispatches pass-validate, with every surviving candidate; it answers the
// candidate GROUPS (src/dedup.ts clusterFindings) the validator then judges
// as units. Loaded on the argv of BOTH routes — the daemon's PR sessions
// (SessionManager.extensionPaths) and the benchmark session
// (src/bench/runner.ts) — so a bench round groups exactly as a live round 1
// does. It reads nothing and writes nothing: pure in, pure out. A subagent
// child loads no argv extension, so a lens can never call it (rule 9).
//
// VERIFY-ON-PIN: registerTool's definition shape and execute's positional
// signature, as extensions/pi-api.d.ts records them.
import type { Pi, PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { clusterFindings, renderGroups, type ClusterCandidate } from "../src/dedup.js";

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return { content: [{ type: "text", text: t }], ...(details ? { details } : {}) };
}

/** Read the tool's `candidates` argument into ClusterCandidates; anything
 * malformed is reported, never thrown. */
export function readCandidates(raw: unknown): { candidates: ClusterCandidate[]; problems: string[] } {
  const problems: string[] = [];
  const arr = typeof raw === "string" ? safeParse(raw, problems) : raw;
  if (!Array.isArray(arr)) return { candidates: [], problems: [...problems, "candidates must be an array"] };
  const candidates: ClusterCandidate[] = [];
  arr.forEach((c, i) => {
    if (typeof c !== "object" || c === null) return void problems.push(`#${i + 1}: not an object`);
    const o = c as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `#${i + 1}`;
    const line = typeof o.line === "number" ? o.line : typeof o.line === "string" && /^\d+$/.test(o.line) ? Number(o.line) : null;
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

export const CLUSTER_TOOL: PiToolDefinition = {
  name: "cluster_findings",
  label: "Cluster findings",
  description:
    "Group this round's candidate findings before pass-validate: candidates in the same file within 10 lines, naming a shared identifier, or with the same fix target form one group. Returns the groups to paste verbatim into the validate task string under CANDIDATE GROUPS.",
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

const activate = (pi: Pi): void => {
  if (typeof pi.registerTool !== "function") {
    console.error("finding-clusters: pi.registerTool unavailable — cluster_findings not registered.");
    return;
  }
  pi.registerTool(CLUSTER_TOOL);
};

export default activate;
