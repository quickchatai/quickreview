// setup — the companion's setup & scan tool belt (setup & scan spec
// "Setup & scan engine"). The ONE companion extension that exposes the
// SetupEngine as pi tools: the companion judges, these tools act. Loaded per
// spawn by the companion's piArgv (src/tui/companion.ts), never registered
// globally, never on the VM (rule 9 is unchanged: no new session kind).
//
// This slice's tools:
//   - setup_repo_facts: the deterministic facts (stack, frameworks, CI,
//     linters, guides, agent files) and the stack-aware unit candidates;
//   - setup_unit_cut: the saved cut and the draft, re-checked against the
//     repo as it is now, with each unit's case split;
//   - setup_unit_cut_propose / _adjust / _save: the companion proposes, the
//     operator's corrections are applied, and save persists the cut in the
//     state home — refused until it is a complete partition of the repo.
//
// Convention (onboarding.ts, tui-view.ts): degrade, never wedge — a pi
// without registerTool registers nothing and says so, and every tool answers
// a refusal as its result rather than throwing.
import type { Pi, PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { stateHome } from "../src/install.js";
import {
  SetupEngine,
  type CutStatus,
  type CutView,
  type Refusal,
} from "../src/setup/engine.js";
import {
  checkoutReader,
  notYetCaseRunner,
  notYetTrackerSink,
  stateHomeFs,
  tokenFileGitHubReader,
} from "../src/setup/adapters.js";
import type { RepoFacts } from "../src/setup/facts.js";
import { ADJUST_OPS } from "../src/setup/unitcut.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

/** Where the reviewed checkout sits in the companion (CONTAINER.reviewedRepo),
 * when the spawn does not say. */
export const DEFAULT_REVIEWED_REPO = "/reviewed-repo";

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return details ? { content: [{ type: "text", text: t }], details } : { content: [{ type: "text", text: t }] };
}

function refused(what: string, r: Refusal): PiToolResult {
  return text(`${what} refused:\n${r.errors.map((e) => `✗ ${e}`).join("\n")}`);
}

// ---- rendering ---------------------------------------------------------------

export function renderFacts(facts: RepoFacts, head: string | null): string {
  const ev = (xs: Array<{ name: string; evidence: string }>): string =>
    xs.length === 0 ? "  (none found)" : xs.map((x) => `  - ${x.name} — ${x.evidence}`).join("\n");
  const list = (xs: readonly string[]): string => (xs.length === 0 ? "  (none found)" : xs.map((x) => `  - ${x}`).join("\n"));
  return [
    `Repo facts (${facts.files} tracked files${head ? ` at ${head.slice(0, 12)}` : ""}). Deterministic: each fact names the file that shows it; "none found" means no such file, not that the practice is absent.`,
    `Languages:\n${facts.languages.length === 0 ? "  (none recognised)" : facts.languages.map((l) => `  - ${l.language}: ${l.files} files`).join("\n")}`,
    `Manifests:\n${ev(facts.manifests)}`,
    `Frameworks:\n${ev(facts.frameworks)}`,
    `CI:\n${facts.ci.length === 0 ? "  (none found)" : facts.ci.map((c) => `  - ${c.system} — ${c.path}${c.name ? ` ("${c.name}")` : ""}`).join("\n")}`,
    `Linters / formatters:\n${ev(facts.linters)}`,
    `Design docs:\n${list(facts.guides)}`,
    `Style guides:\n${list(facts.style_guides)}`,
    `Agent-directive files:\n${list(facts.agent_files)}`,
    `Unit candidates (a first guess — propose your own cut from these):\n${facts.unit_candidates
      .map((u) => `  - ${u.name} [${u.kind}] ${u.roots.map((r) => r || "(repo root)").join(", ")} — ${u.reason}`)
      .join("\n")}`,
  ].join("\n\n");
}

export function renderCut(title: string, v: CutView): string {
  const rows = v.units.map((u) => {
    const split =
      u.cases.length > 1
        ? ` — split into ${u.cases.length} cases (${u.cases.map((c) => `${c.id}: ${c.files}f/${c.lines}l`).join(", ")})`
        : "";
    const over = u.cases.some((c) => c.over_budget) ? " [a file alone exceeds one case]" : "";
    return `  - ${u.name} [${u.kind}] ${u.roots.map((r) => r || "(repo root)").join(", ")}: ${u.files} files, ${u.reviewable} reviewable, ${u.lines} lines${split}${over}${u.note ? ` — ${u.note}` : ""}`;
  });
  const lines = [`${title}:`, ...rows];
  if (v.ignored.length > 0) lines.push(`  ignored: ${v.ignored.join(", ")} (${v.ignored_files} files)`);
  for (const e of v.errors) lines.push(`  ✗ ${e}`);
  for (const b of v.blocking_save) lines.push(`  ! ${b}`);
  return lines.join("\n");
}

export function renderStatus(s: CutStatus): string {
  const out: string[] = [];
  for (const p of s.problems) out.push(`✗ ${p}`);
  if (s.saved) {
    const stale = s.saved.blocking_save.length > 0 ? " — STALE against the repo now, see the ! lines" : "";
    out.push(renderCut(`Saved unit cut (saved ${s.saved.saved_at}${s.saved.head ? ` at ${s.saved.head.slice(0, 12)}` : ""})${stale}`, s.saved));
  } else if (s.cut_file_unreadable) {
    out.push("Saved unit cut: UNKNOWN — the cut file could not be read (see above); nothing will overwrite it.");
  } else {
    out.push("No saved unit cut yet.");
  }
  if (s.draft) out.push(renderCut(`Draft (${s.draft.source}, updated ${s.draft.updated_at}) — not in use until saved`, s.draft));
  if (s.has_previous) out.push("The cut before the saved one is kept as `previous` in the state home.");
  return out.join("\n\n");
}

// ---- tool belt ---------------------------------------------------------------

const UNIT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string", description: "Plain name: letters, digits, '.', '_', '-' (it keys every report)." },
    roots: {
      type: "array",
      items: { type: "string" },
      description: 'Repo-relative directory or file prefixes the unit owns; "" is the repo root (a catch-all).',
    },
    kind: { type: "string", description: "django-app | js-package | python-package | go-module | rust-crate | directory | rest | custom" },
    note: { type: "string", description: "Why this unit — shown beside it." },
  },
  required: ["name", "roots"],
} as const;

export function toolDefinitions(engine: SetupEngine): PiToolDefinition[] {
  const facts: PiToolDefinition = {
    name: "setup_repo_facts",
    label: "Repo facts",
    description:
      "Deterministic facts about the reviewed repo, read from its files without a model: languages, manifests, frameworks, CI, " +
      "linters and formatters, design docs, style guides, agent-directive files, and stack-aware unit candidates. " +
      "Free — call it before judging anything about the repo's shape.",
    promptSnippet: "Read the reviewed repo's deterministic facts",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = engine.facts();
      if (!r.ok) return refused("Repo facts", r);
      return text(renderFacts(r.facts, r.head), { facts: r.facts, head: r.head });
    },
  };

  const status: PiToolDefinition = {
    name: "setup_unit_cut",
    label: "Unit cut",
    description:
      "The saved unit cut (the one survey and scan reuse) and any draft, each re-checked against the repo as it is now: files and " +
      "lines per unit, how an oversized unit splits into cases (the unit's name kept), ignored trees, and anything save would refuse.",
    promptSnippet: "Show the saved unit cut and the draft",
    parameters: NO_PARAMS,
    execute: async () => {
      const s = engine.status();
      return text(renderStatus(s), { status: s });
    },
  };

  const propose: PiToolDefinition = {
    name: "setup_unit_cut_propose",
    label: "Propose a unit cut",
    description:
      "Store YOUR proposed unit cut as the draft (replacing an earlier draft, never the saved cut). A unit owns path prefixes; a file " +
      "belongs to the unit with the longest matching root, so units may nest; `ignored` prefixes are reviewed by nobody. Omit `units` " +
      "to start from the deterministic candidates. Show the operator the result and let them adjust before saving.",
    promptSnippet: "Propose a unit cut as the draft",
    parameters: {
      type: "object",
      properties: {
        units: { type: "array", items: UNIT_SCHEMA },
        ignored: { type: "array", items: { type: "string" }, description: "Prefixes nobody reviews (vendored, generated)." },
      },
    },
    execute: async (_id, params) => {
      const r = engine.propose(params && "units" in params ? params : undefined);
      if (!r.ok) return refused("Proposal", r);
      return text(`${renderCut("Draft stored", r.draft)}\n\nNot in use until setup_unit_cut_save.`, { draft: r.draft });
    },
  };

  const adjust: PiToolDefinition = {
    name: "setup_unit_cut_adjust",
    label: "Adjust the unit cut",
    description:
      "Apply the operator's corrections to the draft (a draft is started from the saved cut when there is none). All-or-nothing: " +
      `one bad op changes nothing. Ops: ${ADJUST_OPS.join(", ")} — {op:"rename",unit,to}, {op:"add",name,roots,kind?,note?}, ` +
      '{op:"remove",unit}, {op:"merge",units:[…],into}, {op:"move",root,to}, {op:"set_roots",unit,roots}, {op:"ignore",roots}, ' +
      '{op:"unignore",roots}, {op:"note",unit,note}. A root given to add/move/set_roots/ignore is taken from whoever held it.',
    promptSnippet: "Adjust the draft unit cut",
    parameters: {
      type: "object",
      properties: { ops: { type: "array", items: { type: "object" } } },
      required: ["ops"],
    },
    execute: async (_id, params) => {
      const r = engine.adjust((params as { ops?: unknown } | undefined)?.ops);
      if (!r.ok) return refused("Adjustment", r);
      return text(`${renderCut("Draft adjusted", r.draft)}\n\nNot in use until setup_unit_cut_save.`, { draft: r.draft });
    },
  };

  const save: PiToolDefinition = {
    name: "setup_unit_cut_save",
    label: "Save the unit cut",
    description:
      "Make the draft THE unit cut, persisted in the install's state home and reused by every survey and scan. Refused unless every " +
      "file is in exactly one unit or ignored and no unit is empty. The cut it replaces is kept. Save only when the operator agreed.",
    promptSnippet: "Save the draft as the unit cut",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = engine.save();
      if (!r.ok) return refused("Save", r);
      return text(renderCut("Unit cut saved", r.saved), { saved: r.saved });
    },
  };

  return [facts, status, propose, adjust, save];
}

// ---- activation ----------------------------------------------------------------

export function buildEngine(env: NodeJS.ProcessEnv = process.env): SetupEngine {
  return new SetupEngine({
    repo: checkoutReader(env.QCR_REVIEWED_REPO?.trim() || DEFAULT_REVIEWED_REPO),
    state: stateHomeFs(stateHome(env)),
    clock: () => new Date(),
    // Memory writes (survey, scan memory) land with; until
    // then this belt writes none, and says so if asked.
    memory: null,
    cases: notYetCaseRunner(""),
    tracker: notYetTrackerSink(""),
    github: tokenFileGitHubReader({
      envFile: env.QCR_GITHUB_READ_ENV,
      fetch: (input, init) => fetch(input, init),
      clock: () => new Date(),
    }),
    log: (line) => console.error(line),
  });
}

const activate = (pi: Pi): void => {
  if (typeof pi.registerTool !== "function") {
    console.error("setup: pi.registerTool unavailable — no setup tools registered.");
    return;
  }
  let engine: SetupEngine;
  try {
    engine = buildEngine();
  } catch (err) {
    // A bad QCR_INSTALL is the only throw on this path: say so, start without
    // the belt rather than failing the companion's start.
    console.error(`setup: not registered — ${String(err)}`);
    return;
  }
  for (const def of toolDefinitions(engine)) pi.registerTool(def);
};

export default activate;
