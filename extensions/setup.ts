// setup — the companion's setup & scan tool belt. The one companion
// extension that exposes the SetupEngine as pi tools: the companion judges,
// these tools act. Loaded per spawn by the companion's piArgv
// (src/tui/companion.ts), never registered globally, never on the VM (no new
// session kind — the single-shepherd invariant, CLAUDE.md rule 9).
//
// Tools:
//   - setup_repo_facts: the deterministic facts (stack, frameworks, CI,
//     linters, guides, agent files) and the stack-aware unit candidates;
//   - setup_unit_cut: the saved cut and the draft, re-checked against the
//     repo as it is now, with each unit's case split;
//   - setup_unit_cut_propose / _adjust / _save: the companion proposes, the
//     operator's corrections are applied, and save persists the cut in the
//     state home — refused until it is a complete partition of the repo;
//   - setup_review_history / _themes: read the review history
//     digest the TUI pulled into the state home, page by page, and save the
//     themes condensed from it — the only part that goes on to reviewer
//     memory (`#history`) and the portrait. A theme quoting a raw comment or
//     naming its author is refused;
//   - setup_survey_preview / _start / _status / _stop: the survey
//     over the saved cut, behind a cost preview whose key the start must
//     quote; it runs as background `pass-survey` subagents so the companion
//     keeps talking, and writes unpinned `#survey` notes into the reviewer's
//     memory, superseding the previous survey's;
//   - setup_portrait_assemble / setup_portrait / setup_portrait_narrative:
//     the repo portrait — deterministic facts assembled into the
//     state home, the companion's narrative of them stored in the config home
//     against the facts' key, each keeping the version it replaced for a diff.
//   - setup_interview / setup_profile / setup_profile_apply /
//     setup_profile_validate / setup_pin_propose: the interview's
//     fixed points, concerns and priority table; the profile the install uses
//     and whether setup is owed (the nudge); the answers applied to the repo
//     profile — previewed with a diff, written only once validated by the
//     daemon's own loaders, a commit asked of the operator's machine; the same
//     check for a direct edit; and the memory entries proposed for pinning,
//     which the operator pins in the TUI (no tool here pins).
// Registered beside them: the PR replay's (extensions/setup-replay.ts):
// setup_replay_preview / _start / _status / _stop — one or two recent PRs
// reviewed with the old and the new profile, the cost stated first, the two
// reviews side by side; the scan's (extensions/setup-scan.ts): scan_preview /
// _start / _status / _stop, scan_findings and scan_matches / scan_match;
// stage 2's scan_suggestions / scan_stage2_propose / scan_stage2_start, and
// the watcher that answers the TUI's stage-2 start click and scan stop; and
// triage's (extensions/setup-triage.ts): scan_dismiss / scan_promote /
// scan_close_fixed / scan_memory.
//
// Convention (onboarding.ts, tui-view.ts): degrade, never wedge — a pi
// without registerTool registers nothing and says so, and every tool answers
// a refusal as its result rather than throwing.
import type { Pi, PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { configHome, stateHome } from "../src/install.js";
import { SetupEngine, type CutStatus, type CutView, type Refusal } from "../src/setup/engine.js";
import type { HistoryTheme, HistoryThemesFile } from "../src/setup/history.js";
import {
  MAX_THEMES,
  THEME_SOURCES,
  THEME_SUMMARY_MAX,
  THEME_TITLE_MAX,
} from "../src/setup/history.js";
import {
  checkoutReader,
  configHomeFs,
  reviewerMemoryFromEnv,
  stateHomeFs,
  tokenFileGitHubReader,
} from "../src/setup/adapters.js";
import { piCaseRunner } from "../src/setup/caserunner.js";
import { REPO_SCOPE } from "../src/setup/survey.js";
import type { SurveyPreview, SurveyStatus } from "../src/setup/surveyrun.js";
import {
  NARRATIVE_FILE,
  NARRATIVE_MAX,
  NARRATIVE_PREVIOUS_FILE,
  PORTRAIT_FACTS_FILE,
  shapeLines,
  type FactsVersion,
  type PortraitView,
  type SectionDiff,
} from "../src/setup/portrait.js";
import { resolveMaxConcurrency } from "./subagents.js";
import type { RepoFacts } from "../src/setup/facts.js";
import { ADJUST_OPS } from "../src/setup/unitcut.js";
import {
  CONCERNS,
  FIXED_POINTS,
  PRIORITIES,
  PRIORITY_SETTINGS,
  TABLE_KEYS,
  type LensDecision,
} from "../src/setup/interview.js";
import { describeCheck, describeSummary } from "../src/setup/profile.js";
import {
  GOALS_MAX_CHARS,
  MAX_PIN_PROPOSALS,
  PIN_WHY_MAX,
  type ApplyResult,
  type ProfileStatus,
} from "../src/setup/tuning.js";
import { GUIDE_REASON, RETUNE_REASON_MAX, type RetuneResult } from "../src/setup/retune.js";
import { buildScan, scanToolDefinitions, watchTuiRequests } from "./setup-scan.js";
import { triageToolDefinitions } from "./setup-triage.js";
import type { MemoryStore } from "../src/memory/store.js";
import type { TrackerSink } from "../src/setup/engine.js";
import { scanTrackerSink } from "../src/setup/trackersink.js";
import { buildReplay, replayToolDefinitions } from "./setup-replay.js";

const NO_PARAMS = { type: "object", properties: {} } as const;

/** Where the reviewed checkout sits in the companion (CONTAINER.reviewedRepo),
 * when the spawn does not say. */
export const DEFAULT_REVIEWED_REPO = "/reviewed-repo";

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return details
    ? { content: [{ type: "text", text: t }], details }
    : { content: [{ type: "text", text: t }] };
}

function refused(what: string, r: Refusal): PiToolResult {
  return text(`${what} refused:\n${r.errors.map((e) => `✗ ${e}`).join("\n")}`);
}

// ---- rendering ---------------------------------------------------------------

export function renderFacts(facts: RepoFacts, head: string | null): string {
  const ev = (xs: Array<{ name: string; evidence: string }>): string =>
    xs.length === 0 ? "  (none found)" : xs.map((x) => `  - ${x.name} — ${x.evidence}`).join("\n");
  const list = (xs: readonly string[]): string =>
    xs.length === 0 ? "  (none found)" : xs.map((x) => `  - ${x}`).join("\n");
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
      .map(
        (u) =>
          `  - ${u.name} [${u.kind}] ${u.roots.map((r) => r || "(repo root)").join(", ")} — ${u.reason}`,
      )
      .join("\n")}`,
  ].join("\n\n");
}

export function renderCut(title: string, v: CutView): string {
  const rows = v.units.map((u) => {
    const split =
      u.cases.length > 1
        ? ` — split into ${u.cases.length} cases (${u.cases.map((c) => `${c.id}: ${c.files}f/${c.lines}l`).join(", ")})`
        : "";
    const over = u.cases.some((c) => c.over_budget)
      ? " [a file alone exceeds one case — a scan reads it in line ranges]"
      : "";
    return `  - ${u.name} [${u.kind}] ${u.roots.map((r) => r || "(repo root)").join(", ")}: ${u.files} files, ${u.reviewable} reviewable, ${u.lines} lines${split}${over}${u.note ? ` — ${u.note}` : ""}`;
  });
  const lines = [`${title}:`, ...rows];
  if (v.ignored.length > 0)
    lines.push(`  ignored: ${v.ignored.join(", ")} (${v.ignored_files} files)`);
  for (const e of v.errors) lines.push(`  ✗ ${e}`);
  for (const b of v.blocking_save) lines.push(`  ! ${b}`);
  return lines.join("\n");
}

export function renderStatus(s: CutStatus): string {
  const out: string[] = [];
  for (const p of s.problems) out.push(`✗ ${p}`);
  if (s.saved) {
    const stale =
      s.saved.blocking_save.length > 0 ? " — STALE against the repo now, see the ! lines" : "";
    out.push(
      renderCut(
        `Saved unit cut (saved ${s.saved.saved_at}${s.saved.head ? ` at ${s.saved.head.slice(0, 12)}` : ""})${stale}`,
        s.saved,
      ),
    );
  } else if (s.cut_file_unreadable) {
    out.push(
      "Saved unit cut: UNKNOWN — the cut file could not be read (see above); nothing will overwrite it.",
    );
  } else {
    out.push("No saved unit cut yet.");
  }
  if (s.draft)
    out.push(
      renderCut(
        `Draft (${s.draft.source}, updated ${s.draft.updated_at}) — not in use until saved`,
        s.draft,
      ),
    );
  if (s.has_previous)
    out.push("The cut before the saved one is kept as `previous` in the state home.");
  return out.join("\n\n");
}

export function renderThemes(themes: readonly HistoryTheme[]): string {
  return themes.length === 0
    ? "  (none — an empty history has no themes)"
    : themes.map((t) => `  - ${t.title} [${t.source}, ${t.weight}] — ${t.summary}`).join("\n");
}

export function renderHistory(h: ReturnType<SetupEngine["history"]>): string {
  const out: string[] = [];
  const saved = (f: HistoryThemesFile | null): string =>
    h.themes_error !== null
      ? `✗ ${h.themes_error}\nSaved themes: UNKNOWN.`
      : f
        ? `Saved themes (${f.saved_at}, from the digest of ${f.digest_generated_at}):\n${renderThemes(f.themes)}`
        : "No themes saved yet.";
  if (h.digest === "absent") {
    out.push(
      "No review history digest in the state home yet. Ask the owner to run `qcr history pull` on his machine — it reads " +
        "the history on the VM through the App (minutes on a busy repo) and writes the digest here. You cannot fetch it yourself.",
    );
    out.push(saved(h.themes));
    return out.join("\n\n");
  }
  if (h.digest === "unreadable") {
    for (const p of h.problems) out.push(`✗ ${p}`);
    out.push("The digest is UNKNOWN until it is pulled again.");
    out.push(saved(h.themes));
    return out.join("\n\n");
  }
  const s = h.summary!;
  out.push(
    `Review history of ${s.repo} (digest ${s.generated_at}, since ${s.since.slice(0, 10)}, ${s.months} months):\n` +
      `  human review comments: ${s.human_comments} on ${s.prs_scanned} of ${s.prs_enumerated} merged PRs${s.truncated ? " (capped — newest kept)" : ""}\n` +
      `  own rounds: ${s.rounds}\n  [feedback] signals: ${s.feedback}`,
  );
  for (const p of s.problems) out.push(`! ${p}`);
  if (s.empty) {
    out.push(
      "EMPTY history: no merged-PR review comments, no rounds, no feedback. Save an empty theme list to record that.",
    );
  }
  if (h.page) {
    const end = h.page.offset + h.page.lines.length;
    out.push(
      `${h.page.section} ${h.page.total === 0 ? "(none)" : `${h.page.offset + 1}–${end} of ${h.page.total}`}` +
        `${end < h.page.total ? ` — next page: offset ${end}` : ""}. RAW text: condense it, never copy it onward.\n` +
        h.page.lines.map((l) => `  ${l}`).join("\n"),
    );
  }
  out.push(saved(h.themes));
  return out.join("\n\n");
}

const usd = (n: number | null): string => (n === null ? "unknown" : `$${n.toFixed(2)}`);
const scopeName = (unit: string): string =>
  unit === REPO_SCOPE ? "repo-wide read" : `unit ${unit}`;

export function renderSurveyPreview(p: SurveyPreview): string {
  const rows = p.cases.map(
    (c) =>
      `  - ${c.id} (${scopeName(c.unit)}): ${c.files.length} files, ${c.lines} lines, ~${usd(c.estimate_usd)}\n` +
      c.files.map((f) => `      ${f.path} — ${f.reason}`).join("\n"),
  );
  const out = [
    `Survey plan${p.head ? ` at ${p.head.slice(0, 12)}` : ""}: ${p.cases.length} cases, ${p.lines} lines, estimated ${usd(p.estimate_usd)} ` +
      `(${p.concurrency} at once; the repo-wide read first, then one case per unit).`,
    `Price basis: ${p.rate.basis}.`,
    ...rows,
  ];
  if (p.unsampled.length > 0)
    out.push(
      `Not surveyed (no code to sample outside tests and migrations): ${p.unsampled.join(", ")}`,
    );
  if (p.unassigned.length > 0) {
    out.push(
      `Not surveyed: ${p.unassigned.length} file(s) belong to no unit of the saved cut: ${p.unassigned.slice(0, 10).join(", ")}` +
        `${p.unassigned.length > 10 ? ", …" : ""} — adjust and save the cut to cover them.`,
    );
  }
  out.push(
    p.existing_entries === null
      ? "Existing #survey memory: UNKNOWN (memory could not be read)."
      : `Existing #survey memory: ${p.existing_entries} live entries — a completed survey supersedes them.`,
  );
  if (p.last_complete) {
    out.push(
      `A survey already completed (${p.last_complete.id}, ${p.last_complete.finished_at}, ${p.last_complete.notes} notes, ${usd(p.last_complete.cost_usd)}) — ` +
        "starting again is a RE-SURVEY: only when the operator asked for one, with resurvey: true.",
    );
  }
  for (const b of p.blockers) out.push(`✗ ${b}`);
  out.push(
    `Preview key: ${p.key} — show the operator this cost; start with this key only when he agrees.`,
  );
  return out.join("\n");
}

export function renderSurveyStatus(s: SurveyStatus): string {
  const out: string[] = s.problems.map((p) => `✗ ${p}`);
  const run = s.run;
  if (run === null) {
    out.push(
      s.ok
        ? "No survey has run yet."
        : "Survey record: UNKNOWN — the file could not be read (see above); nothing will overwrite it.",
    );
  } else {
    const done = run.cases.filter((c) => c.status === "done").length;
    const cost = run.cases.some((c) => c.cost_usd !== null)
      ? run.cases.reduce((n, c) => n + (c.cost_usd ?? 0), 0)
      : null;
    // A finished case the runner could not price makes the sum a floor, and
    // it says so rather than reading as the whole spend.
    const unpriced = run.cases.some((c) => c.status === "done" && c.cost_usd === null);
    const state =
      run.display === "interrupted"
        ? "INTERRUPTED — the companion restarted mid-run; notes written so far are kept, start again (after a preview) to finish"
        : run.display;
    out.push(
      `Survey ${run.id}: ${state}. ${done}/${run.cases.length} cases done; ${run.cases.reduce((n, c) => n + c.notes_written, 0)} notes written; ` +
        `${run.superseded} earlier entries superseded; spent ${cost !== null && unpriced ? "at least " : ""}${usd(cost)} of an estimated ${usd(run.estimate_usd)}.`,
    );
    for (const c of run.cases) {
      const extra = [
        c.none ? "NONE" : "",
        c.notes_failed ? `${c.notes_failed} notes refused by memory` : "",
        c.notes_dropped ? `${c.notes_dropped} over the cap` : "",
        c.error ?? "",
      ].filter(Boolean);
      out.push(
        `  - ${c.id}: ${c.status}, ${c.notes_written} notes${c.cost_usd !== null ? `, ${usd(c.cost_usd)}` : ""}${extra.length ? ` — ${extra.join("; ")}` : ""}`,
      );
    }
    for (const p of run.problems) out.push(`  ! ${p}`);
  }
  if (s.last_complete && s.last_complete.id !== run?.id) {
    out.push(`Last completed survey: ${s.last_complete.id} (${s.last_complete.finished_at}).`);
  }
  return out.join("\n");
}

const SECTION_TITLES: Record<string, string> = {
  stack: "Stack",
  units: "Units",
  conventions: "Conventions (written down)",
  enforced: "Enforced (by tooling)",
  history: "Review history themes",
  survey: "Survey",
  scan: "What the scans found",
  problems: "Problems",
};

const bullets = (xs: readonly string[], none = "  (none found)"): string =>
  xs.length === 0 ? none : xs.map((x) => `  - ${x}`).join("\n");

/** The facts, for reading: counts beside the shape lines the key is over. */
export function renderPortraitFacts(v: FactsVersion): string {
  const f = v.facts;
  const lines = shapeLines(f);
  const out = [
    `Portrait facts ${v.key} (assembled ${v.assembled_at}${f.head ? ` at ${f.head.slice(0, 12)}` : ""}; ${f.stack.files} tracked files). ` +
      "Deterministic; the key moves only when the SHAPE does (a framework, unit, doc, tool or theme), never with a count.",
  ];
  const langs = f.stack.languages.map((l) => `${l.language} ${l.files}`).join(", ");
  out.push(
    `${SECTION_TITLES.stack}:\n  languages: ${langs || "(none recognised)"}\n` +
      bullets(
        lines.stack.filter((l) => !l.startsWith("language ")),
        "  (no manifests or frameworks found)",
      ),
  );
  const units = f.units.units.map(
    (u) =>
      `${u.name} [${u.kind}] ${u.roots.map((r) => r || "(repo root)").join(", ")}: ${u.files} files, ${u.lines} lines` +
      `${u.cases > 1 ? `, ${u.cases} cases` : ""}${u.note ? ` — ${u.note}` : ""}`,
  );
  const cut =
    f.units.source === "saved"
      ? `the saved cut (${f.units.saved_at})`
      : "NO SAVED CUT — the deterministic candidates, not the cut";
  out.push(
    `${SECTION_TITLES.units}, ${cut}:\n${bullets(units)}` +
      (f.units.ignored.length > 0 ? `\n  ignored: ${f.units.ignored.join(", ")}` : ""),
  );
  for (const section of ["conventions", "enforced", "history", "survey"] as const) {
    out.push(`${SECTION_TITLES[section]}:\n${bullets(lines[section])}`);
  }
  const scan = f.scan ?? null;
  if (scan !== null) {
    const t = scan.findings;
    const sev = Object.entries(t.by_severity)
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    const units = t.units.map(
      (u) =>
        `${u.unit}: ${u.open} open (${u.promoted} promoted${u.doubted > 0 ? `, ${u.doubted} may not be valid` : ""}), ` +
        `${u.dismissed} dismissed, ${u.fixed} fixed${u.open_by.length > 0 ? ` — ${u.open_by.join(", ")}` : ""}`,
    );
    out.push(
      `${SECTION_TITLES.scan}${scan.state === "unreadable" ? " (PARTIAL — a scan record is unreadable, see Problems)" : ""}:\n` +
        `  last scan: ${scan.last ? `${scan.last.id} [${scan.last.mode}, ${scan.last.state}] at ${scan.last.sha.slice(0, 12)}${scan.last.finished_at ? `, ${scan.last.finished_at}` : ""}` : "none finished"}\n` +
        `  findings: ${t.open} open${sev ? ` (${sev})` : ""}, ${t.promoted} promoted, ${t.dismissed} dismissed, ${t.fixed} fixed\n` +
        `${bullets(units, "  (no findings by unit)")}\n` +
        `  hotspots:\n${scan.hotspots.length === 0 ? "    (none written to scan memory)" : scan.hotspots.map((h) => `    - ${h.unit} — ${h.text}`).join("\n")}`,
    );
  }
  if (f.problems.length > 0) {
    out.push(
      `${SECTION_TITLES.problems} (these parts are UNKNOWN, not empty):\n${f.problems.map((p) => `  ✗ ${p}`).join("\n")}`,
    );
  }
  return out.join("\n\n");
}

export function renderFactsDiff(diff: readonly SectionDiff[], since: string): string {
  if (diff.length === 0) return `Facts: no change in shape since ${since}.`;
  const sections = diff.map(
    (d) =>
      `  ${SECTION_TITLES[d.section] ?? d.section}:\n` +
      [...d.added.map((l) => `    + ${l}`), ...d.removed.map((l) => `    - ${l}`)].join("\n"),
  );
  return [`Facts changed since ${since}:`, ...sections].join("\n");
}

export function renderPortrait(v: PortraitView): string {
  const out: string[] = [];
  if (v.facts.state === "absent")
    out.push("No portrait facts yet — setup_portrait_assemble reads them (free, deterministic).");
  else if (v.facts.state === "unreadable") out.push(`✗ ${v.facts.error}\nPortrait facts: UNKNOWN.`);
  else out.push(renderPortraitFacts(v.facts.file.current));
  const n = v.narrative;
  if (n.state === "no-config-home") out.push("Narrative: no config home in this assembly.");
  else if (n.state === "absent")
    out.push(`Narrative: none yet (${NARRATIVE_FILE} in the config home).`);
  else if (n.state === "unreadable") out.push(`✗ ${n.error}\nNarrative: UNKNOWN.`);
  else {
    const fresh =
      v.stale === null
        ? n.doc.facts_key === null
          ? "which facts it was written from is unknown (its header was edited) — check it against the facts yourself"
          : `written from facts ${n.doc.facts_key}; whether it is current is UNKNOWN — the facts cannot be read`
        : v.stale
          ? `STALE — written from facts ${n.doc.facts_key}, and the facts have moved since; re-read them and rewrite it`
          : "current with these facts";
    out.push(`Narrative (${n.doc.written_at ?? "time unknown"}; ${fresh}):\n\n${n.doc.body}`);
  }
  if (v.has_previous_narrative)
    out.push(`The narrative it replaced is kept (${NARRATIVE_PREVIOUS_FILE}).`);
  if (v.previous_narrative_error !== null)
    out.push(`✗ ${v.previous_narrative_error}\nThe kept previous narrative: UNKNOWN.`);
  if (v.facts_diff !== null && v.facts.state === "ok") {
    const prev = v.facts.file.previous;
    out.push(
      prev
        ? renderFactsDiff(v.facts_diff, `${prev.key} (${prev.assembled_at})`)
        : "Facts: no earlier version kept yet.",
    );
  }
  if (v.narrative_diff !== null && v.previous_narrative_error === null) {
    out.push(
      !v.has_previous_narrative
        ? "Narrative: no earlier version kept yet."
        : v.narrative_diff.length === 0
          ? "Narrative: the same text as the one it replaced."
          : `Narrative changes since the one it replaced:\n${v.narrative_diff.map((l) => `  ${l}`).join("\n")}`,
    );
  }
  return out.join("\n\n");
}

// ---- the interview's tuning ------------------------------------------------------

const settingsText = (s: Record<string, unknown>): string => {
  const parts = TABLE_KEYS.filter((k) => s[k] !== undefined).map(
    (k) => `${k} = ${JSON.stringify(s[k])}`,
  );
  return parts.length === 0 ? "(nothing — the shipped behaviour)" : parts.join(", ");
};

export function renderInterviewTable(): string {
  const out = [
    "The four points every setup interview covers (adaptive otherwise — ask from the portrait):",
    ...FIXED_POINTS.map((p) => `  - ${p.name}: ${p.question}`),
    "",
    "Concerns — give each a priority; the table below turns it into lens settings:",
  ];
  for (const point of ["merge-blocking", "risk", "style-tests"] as const) {
    out.push(`  ${point}:`);
    for (const c of CONCERNS.filter((x) => x.point === point))
      out.push(`    - ${c.name} — ${c.title} [${c.lenses.join(", ")}]`);
  }
  out.push(
    "",
    "The table (priority → the lens settings it writes on every lens its concern names):",
  );
  for (const p of PRIORITIES) out.push(`  - ${p}: ${settingsText(PRIORITY_SETTINGS[p])}`);
  out.push(
    "",
    "A lens two concerns share takes the HIGHER priority. `normal` clears what an earlier answer wrote. The goals point is " +
      "words: record them as `goals`, and turn what a lens should watch for into that lens's `emphasis`.",
  );
  return out.join("\n");
}

export const renderCheck = describeCheck;

export function renderProfileStatus(s: ProfileStatus): string {
  const out: string[] = [];
  out.push(
    s.target.state === "ok"
      ? `Live config ${s.target.config} names ${s.target.named === "" ? "NO repo profile" : `profile "${s.target.named}"`}.`
      : `✗ Live config: ${s.target.error}`,
  );
  if (s.needs_setup === true) {
    out.push(
      `SETUP IS OWED: ${s.why_setup}. Tell the owner, once, and offer to run setup (the \`setup\` skill) — never start it on your own.`,
    );
  } else if (s.needs_setup === null) {
    out.push(
      `Whether setup is owed is UNKNOWN: ${s.why_setup}. Do not nudge on it; say what could not be read.`,
    );
  }
  if (s.profile && s.check) out.push(renderCheck(s.profile, s.check));
  if (s.target.state === "ok" && s.profile && s.target.named !== s.profile) {
    out.push(
      `The live config does not name "${s.profile}", so PR rounds do not use it yet: the owner sets \`[review] profile = "${s.profile}"\` in ${s.target.config} (you cannot write it) and deploys.`,
    );
  }
  if (s.interview.state === "unreadable") out.push(`✗ ${s.interview.error}`);
  else if (s.interview.state === "ok") {
    const r = s.interview.record;
    out.push(
      `Interview answers (${r.updated_at}): goals ${r.goals === null ? "NOT recorded" : "recorded"}; ` +
        Object.entries(r.priorities)
          .map(([c, p]) => `${c} ${p}`)
          .join(", "),
    );
  } else out.push("No interview recorded yet.");
  if (s.unanswered === null)
    out.push("Unanswered concerns: UNKNOWN (the interview record cannot be read).");
  else if (s.unanswered.length > 0) out.push(`Unanswered concerns: ${s.unanswered.join(", ")}.`);
  for (const c of s.commits) {
    const r = c.result;
    out.push(
      `  commit ${c.id}: ${r === null ? "requested — the owner's TUI (or `qcr setup commit`) carries it out" : r === "unreadable" ? "result UNKNOWN (unreadable)" : `${r.state}${r.sha ? ` ${r.sha.slice(0, 12)}` : ""} — ${r.detail}`}`,
    );
  }
  return out.join("\n");
}

function renderDecisions(ds: readonly LensDecision[]): string {
  return ds.length === 0
    ? "  (no concern answered yet)"
    : ds
        .map(
          (d) =>
            `  - ${d.lens}: ${d.priority} (${d.because.join(", ")}) → ${settingsText(d.settings)}`,
        )
        .join("\n");
}

export function renderApply(r: ApplyResult): string {
  const out: string[] = [];
  out.push(
    r.written
      ? `Profile "${r.profile}" ${r.created ? "created" : "updated"} at ${r.dir}.`
      : r.unchanged
        ? `Profile "${r.profile}": these answers change nothing — it already says this.`
        : `PREVIEW of profile "${r.profile}" (${r.dir}) — nothing written. Show the owner the diff; write only when he agrees.`,
  );
  out.push(`What the table decides:\n${renderDecisions(r.decisions)}`);
  for (const d of r.diff) out.push(`${d.file}:\n${d.lines.map((l) => `  ${l}`).join("\n")}`);
  out.push(`Validated with the daemon's own loaders:\n${describeSummary(r.summary)}`);
  const todo = [...(r.goals_missing ? ["the goals"] : []), ...r.unanswered];
  if (todo.length > 0) out.push(`Still to ask before it can be written: ${todo.join(", ")}.`);
  if (r.config_names !== null && r.config_names !== r.profile) {
    out.push(
      `The live config names ${r.config_names === "" ? "no profile" : `"${r.config_names}"`}: until the owner sets \`[review] profile = "${r.profile}"\` there and deploys, PR rounds do not use this one.`,
    );
  }
  if (r.written) {
    out.push(
      `${r.commit ? `A commit was asked for (${r.commit.id}); it lands if the config home is a git repo. ` : ""}` +
        'PR reviews change only when the owner deploys — the deploy tab says "profile changed, not deployed" until then.',
    );
  }
  // The replay's default "old" side is this record — say when it
  // could not be kept, never leave the companion to find out at preview.
  if (r.baseline !== null) {
    out.push(
      "id" in r.baseline
        ? `The profile as it was before this write is kept for a replay (${r.baseline.id}).`
        : `✗ ${r.baseline.error} — a replay cannot default to "before this write"; pass old explicitly.`,
    );
  }
  return out.join("\n\n");
}

/** A re-tune's report: what changed, why, what it moved, and that it waits on a deploy. */
export function renderRetune(r: RetuneResult): string {
  const out: string[] = [];
  out.push(
    r.written
      ? `Re-tuned profile "${r.profile}" after scan ${r.scan.run} (${r.scan.mode} at ${r.scan.sha.slice(0, 12)}).`
      : r.record
        ? `Re-tune recorded after scan ${r.scan.run}, but no profile file changed — nothing to deploy.`
        : `PREVIEW of a re-tune of "${r.profile}" after scan ${r.scan.run} — nothing written. Tell the owner what you will change and why; then write it.`,
  );
  out.push(
    "What changed, and why:\n" +
      r.changes
        .map(
          (c) =>
            `  - ${c.input}: ${c.from} → ${c.to}\n    why: ${c.why}\n` +
            (c.effects.length > 0
              ? c.effects.map((e) => `    moves ${e}`).join("\n")
              : "    moves no resolved lens setting"),
        )
        .join("\n"),
  );
  for (const d of r.diff) out.push(`${d.file}:\n${d.lines.map((l) => `  ${l}`).join("\n")}`);
  if (r.config_names !== null && r.config_names !== r.profile) {
    out.push(
      `The live config names ${r.config_names === "" ? "no profile" : `"${r.config_names}"`} — PR rounds do not use "${r.profile}" even once deployed.`,
    );
  }
  if (r.record) {
    const portrait =
      "key" in r.record.portrait
        ? `Portrait facts refreshed (key ${r.record.portrait.key}) — if your narrative is now STALE, rewrite it from them.`
        : `The portrait facts could NOT be refreshed: ${r.record.portrait.error}.`;
    out.push(portrait);
  }
  if (r.written) {
    out.push(
      `${r.commit ? `A commit was asked for (${r.commit.id}). ` : ""}` +
        'Report this to the owner: what changed and why. It reaches PR reviews ONLY when he deploys — the deploy tab shows this re-tune as "profile changed, not deployed" until then. You never deploy.',
    );
  }
  return out.join("\n\n");
}

// ---- tool belt ---------------------------------------------------------------

const UNIT_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "Plain name: letters, digits, '.', '_', '-' (it keys every report).",
    },
    roots: {
      type: "array",
      items: { type: "string" },
      description:
        'Repo-relative directory or file prefixes the unit owns; "" is the repo root (a catch-all).',
    },
    kind: {
      type: "string",
      description:
        "django-app | js-package | python-package | go-module | rust-crate | directory | rest | custom",
    },
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
        ignored: {
          type: "array",
          items: { type: "string" },
          description: "Prefixes nobody reviews (vendored, generated).",
        },
      },
    },
    execute: async (_id, params) => {
      const r = engine.propose(params && "units" in params ? params : undefined);
      if (!r.ok) return refused("Proposal", r);
      return text(
        `${renderCut("Draft stored", r.draft)}\n\nNot in use until setup_unit_cut_save.`,
        { draft: r.draft },
      );
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
      return text(
        `${renderCut("Draft adjusted", r.draft)}\n\nNot in use until setup_unit_cut_save.`,
        { draft: r.draft },
      );
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

  const history: PiToolDefinition = {
    name: "setup_review_history",
    label: "Review history",
    description:
      "The review history digest in the install's state home: human review comments on merged PRs of the last six months, the " +
      "reviewer's own rounds, and [feedback]. Without `section` it summarises; with one it returns a page of RAW items " +
      "(human | rounds | feedback) to read and condense. Raw comments stay in the state home: never quote them, and never name " +
      "who wrote them, in anything you write elsewhere.",
    promptSnippet: "Read the review history digest",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", enum: ["human", "rounds", "feedback"] },
        offset: { type: "number", description: "First item of the page (0-based)." },
        limit: { type: "number", description: "Items per page (at most 200; default 50)." },
      },
    },
    execute: async (_id, params) => {
      const p = (params ?? {}) as { section?: unknown; offset?: unknown; limit?: unknown };
      const section =
        p.section === "human" || p.section === "rounds" || p.section === "feedback"
          ? p.section
          : null;
      const num = (v: unknown): number | undefined =>
        typeof v === "number" && Number.isFinite(v) ? v : undefined;
      const offset = num(p.offset);
      const limit = num(p.limit);
      const h = engine.history(
        section
          ? {
              section,
              ...(offset !== undefined ? { offset } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }
          : null,
      );
      return text(renderHistory(h), { digest: h.digest, summary: h.summary });
    },
  };

  const themes: PiToolDefinition = {
    name: "setup_review_history_themes",
    label: "Save review history themes",
    description:
      `Save the THEMES you condensed from the review history — at most ${MAX_THEMES}, each {title (≤${THEME_TITLE_MAX}), summary ` +
      `(≤${THEME_SUMMARY_MAX}), source: ${THEME_SOURCES.join("|")}, weight: items behind it}. Your own words about the code and ` +
      "what reviewers ask for; a theme that quotes a raw comment (eight words running) or names a comment's author is refused. " +
      "Saved to the state home (the portrait reads them) and written to reviewer memory as #history entries, replacing the " +
      "earlier unpinned ones. An empty list is valid for an empty history.",
    promptSnippet: "Save the review history themes",
    parameters: {
      type: "object",
      properties: {
        themes: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              summary: { type: "string" },
              source: { type: "string", enum: [...THEME_SOURCES] },
              weight: { type: "number" },
            },
            required: ["title", "summary", "source", "weight"],
          },
        },
      },
      required: ["themes"],
    },
    execute: async (_id, params) => {
      const r = await engine.saveHistoryThemes(
        (params as { themes?: unknown } | undefined)?.themes,
      );
      if (!r.ok) return refused("Themes", r);
      const mem = r.memory;
      const memLine =
        `Memory: ${mem.written} #history entr${mem.written === 1 ? "y" : "ies"} written, ${mem.retired} earlier retired.` +
        (mem.problems.length > 0 ? `\n${mem.problems.map((p) => `! ${p}`).join("\n")}` : "");
      return text(`Themes saved:\n${renderThemes(r.themes)}\n\n${memLine}`, {
        themes: r.themes,
        memory: mem,
      });
    },
  };

  const surveyPreview: PiToolDefinition = {
    name: "setup_survey_preview",
    label: "Survey preview",
    description:
      "What the setup survey would read and cost, over the SAVED unit cut: first a repo-wide read of every agent-directive file and " +
      "design doc in full, then one `pass-survey` case (at `low`) per unit over a small code sample — entry points, models/schemas, " +
      "the most-changed and the largest files. Returns the price and a preview key. Show the operator the price before starting.",
    promptSnippet: "Preview the setup survey and its cost",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = await engine.surveyPreview();
      if (!r.ok) return refused("Survey preview", r);
      return text(renderSurveyPreview(r.preview), { preview: r.preview });
    },
  };

  const surveyStart: PiToolDefinition = {
    name: "setup_survey_start",
    label: "Start the survey",
    description:
      "Start the previewed survey in the BACKGROUND and return at once — keep talking to the operator; setup_survey_status shows " +
      "progress. `key` is the preview's key: a plan or price that changed since is refused. A survey writes unpinned `#survey` notes " +
      "into reviewer memory; once one has completed, starting again is a re-survey that supersedes them — only when the operator " +
      "asks, with `resurvey: true`. Never start one on your own initiative.",
    promptSnippet: "Start the previewed survey in the background",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "The key setup_survey_preview returned." },
        resurvey: {
          type: "boolean",
          description: "The operator asked to survey again, superseding the last survey's notes.",
        },
      },
      required: ["key"],
    },
    execute: async (_id, params) => {
      const p = (params ?? {}) as { key?: unknown; resurvey?: unknown };
      const r = await engine.surveyStart({ key: p.key, resurvey: p.resurvey });
      if (!r.ok) return refused("Survey start", r);
      return text(
        `Survey ${r.run.id} started in the background: ${r.run.cases.length} cases, estimated ${usd(r.run.estimate_usd)}. ` +
          "It needs nothing from you; check setup_survey_status when the operator asks, or in a while.",
        { run: r.run },
      );
    },
  };

  const surveyStatus: PiToolDefinition = {
    name: "setup_survey_status",
    label: "Survey status",
    description:
      "The latest survey: each case's state, notes written, cost so far against the estimate, earlier entries superseded, and " +
      "anything that went wrong. A run the companion restarted in the middle of shows as INTERRUPTED.",
    promptSnippet: "Show the survey's progress",
    parameters: NO_PARAMS,
    execute: async () => {
      const s = engine.surveyStatus();
      return text(renderSurveyStatus(s), { status: s });
    },
  };

  const surveyStop: PiToolDefinition = {
    name: "setup_survey_stop",
    label: "Stop the survey",
    description:
      "Stop the running survey: running cases are killed, pending ones never start; notes already written stay.",
    promptSnippet: "Stop the running survey",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = engine.surveyStop();
      if (!r.ok) return refused("Survey stop", r);
      return text(`Stopping survey ${r.id}; setup_survey_status shows what it finished.`);
    },
  };

  const portraitAssemble: PiToolDefinition = {
    name: "setup_portrait_assemble",
    label: "Assemble the portrait facts",
    description:
      "Assemble the repo portrait's FACTS from what is on disk now — the stack, the saved unit cut (the candidates, flagged, before " +
      "one is saved), the conventions the repo writes down and what its CI and linters already enforce, and the saved review " +
      `history themes — and store them in the state home (${PORTRAIT_FACTS_FILE}). Free and deterministic. When their shape changed, ` +
      "the version they replace is kept and the answer says what changed. Returns the facts key a narrative is stored against.",
    promptSnippet: "Assemble the repo portrait facts",
    parameters: NO_PARAMS,
    execute: async () => {
      const r = engine.portraitAssemble();
      if (!r.ok) return refused("Portrait facts", r);
      const out = [renderPortraitFacts(r.current)];
      out.push(
        r.unchanged
          ? "Facts: no change in shape since they were last assembled (counts refreshed)."
          : r.previous
            ? renderFactsDiff(r.diff, `${r.previous.key} (${r.previous.assembled_at})`)
            : "The first facts for this repo — nothing earlier to compare.",
      );
      const v = engine.portrait();
      if (v.narrative.state === "ok") {
        out.push(
          v.stale === false
            ? "Your stored narrative is current with these facts."
            : v.stale === true
              ? "Your stored narrative was not written from these facts — read it (setup_portrait) and rewrite it from them."
              : "Which facts your stored narrative was written from is unknown (its header was edited) — read it (setup_portrait) and check it against these facts.",
        );
      } else if (v.narrative.state === "absent") {
        out.push(
          `No narrative stored yet: write the operator a reading of these facts and store it with setup_portrait_narrative, facts_key ${r.current.key}.`,
        );
      }
      return text(out.join("\n\n"), { key: r.current.key, unchanged: r.unchanged, diff: r.diff });
    },
  };

  const portrait: PiToolDefinition = {
    name: "setup_portrait",
    label: "Repo portrait",
    description:
      "The stored repo portrait as it is, nothing reassembled: the facts, your narrative and whether it is STALE (written from " +
      "other facts), and — with `diff: true` — what changed in the facts and in the narrative since the versions they replaced.",
    promptSnippet: "Read the stored repo portrait",
    parameters: {
      type: "object",
      properties: {
        diff: {
          type: "boolean",
          description: "Also show what changed since the kept previous versions.",
        },
      },
    },
    execute: async (_id, params) => {
      const v = engine.portrait({
        diff: (params as { diff?: unknown } | undefined)?.diff === true,
      });
      return text(renderPortrait(v), {
        facts: v.facts.state,
        narrative: v.narrative.state,
        stale: v.stale,
      });
    },
  };

  const narrative: PiToolDefinition = {
    name: "setup_portrait_narrative",
    label: "Store the portrait narrative",
    description:
      `Store YOUR narrative of the portrait facts — prose for the operator, at most ${NARRATIVE_MAX} characters — in the install's ` +
      `config home (${NARRATIVE_FILE}). \`facts_key\` is the key of the facts you read: facts assembled since refuse it (read ` +
      "them again). A narrative that quotes a raw review comment or names its author is refused. The narrative it replaces is " +
      `kept (${NARRATIVE_PREVIOUS_FILE}) and the answer shows what changed.`,
    promptSnippet: "Store the repo portrait narrative",
    parameters: {
      type: "object",
      properties: {
        facts_key: {
          type: "string",
          description: "The key setup_portrait_assemble (or setup_portrait) showed.",
        },
        narrative: {
          type: "string",
          description:
            "Markdown prose: what the facts say about this repo, and what they leave open.",
        },
      },
      required: ["facts_key", "narrative"],
    },
    execute: async (_id, params) => {
      const p = (params ?? {}) as { facts_key?: unknown; narrative?: unknown };
      const r = engine.storePortraitNarrative({ facts_key: p.facts_key, narrative: p.narrative });
      if (!r.ok) return refused("Narrative", r);
      if (r.unchanged) {
        return text(
          `Narrative unchanged — the stored one is the same text, from facts ${r.facts_key}.`,
          { unchanged: true },
        );
      }
      const out = [
        `Narrative stored from facts ${r.facts_key} (${NARRATIVE_FILE} in the config home).`,
      ];
      if (r.replaced) {
        out.push(
          `The previous one is kept (${NARRATIVE_PREVIOUS_FILE}); changes:\n${r.diff.map((l) => `  ${l}`).join("\n")}`,
        );
      }
      return text(out.join("\n\n"), { facts_key: r.facts_key, replaced: r.replaced });
    },
  };

  const interview: PiToolDefinition = {
    name: "setup_interview",
    label: "Setup interview",
    description:
      "The setup interview's fixed frame: the four points every interview covers (goals, merge-blocking concerns, risk areas, " +
      "style & tests), the concerns you give a priority each (critical | important | normal | ignore), and the table in code " +
      "that turns a priority into lens settings. Read it before the interview; ask adaptively from the portrait.",
    promptSnippet: "Show the setup interview's points, concerns and priority table",
    parameters: NO_PARAMS,
    execute: async () => text(renderInterviewTable()),
  };

  const profileState: PiToolDefinition = {
    name: "setup_profile",
    label: "Repo profile",
    description:
      "The repo profile this install uses: what the live config names, whether it loads (the daemon's own check), whether " +
      "setup is OWED (no profile of the repo's own — nudge the owner once), the interview answers recorded so far, the " +
      "concerns still unanswered, and each commit asked for with what became of it.",
    promptSnippet: "Show the repo profile, whether setup is owed, and the interview so far",
    parameters: NO_PARAMS,
    execute: async () => {
      const s = engine.profileStatus();
      if (!("target" in s)) return refused("Profile status", s);
      return text(renderProfileStatus(s), {
        needs_setup: s.needs_setup,
        profile: s.profile,
        unanswered: s.unanswered,
      });
    },
  };

  const profileApply: PiToolDefinition = {
    name: "setup_profile_apply",
    label: "Apply the interview to the profile",
    description:
      "Turn the interview's answers into the repo profile. `priorities` {concern: critical|important|normal|ignore} map through " +
      "the table (setup_interview) onto each concern's lenses; `emphasis` {lens: words | null} is what that lens should watch " +
      "for here; `style_guide` is a guide you drafted (markdown) for a repo that writes none — a guide the repo writes always " +
      "wins; `goals` is the project's goals in the owner's words. A WRITE records the answers, so a later call (a re-tune) " +
      "sends only what changed; a preview uses the recorded answers plus its own and records nothing. Without `write` it " +
      "PREVIEWS: the diff and what the table decided, nothing written. `write: true` needs every concern answered and the " +
      "goals, validates the result with the daemon's own loaders (refused, unchanged, if it would not load), writes it into " +
      "the config home and asks for a commit there. Write only after the owner saw the diff and agreed.",
    promptSnippet: "Preview or write the repo profile from the interview's answers",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "The profile's name — needed only when the live config names none (the repo's name is a good one).",
        },
        goals: {
          type: "string",
          description: `The project's goals, in the owner's words (at most ${GOALS_MAX_CHARS} characters).`,
        },
        priorities: {
          type: "object",
          description: `{concern: priority}; concerns: ${CONCERNS.map((c) => c.name).join(", ")}; priorities: ${PRIORITIES.join(", ")}.`,
        },
        emphasis: {
          type: "object",
          description: "{lens: the words for it, or null to remove them}.",
        },
        style_guide: {
          type: "string",
          description: "A style guide you drafted (markdown), for a repo that writes none.",
        },
        drop_style_guide: {
          type: "boolean",
          description: "true stops the style lens reading the drafted guide.",
        },
        write: { type: "boolean", description: "true writes; omitted or false previews." },
      },
    },
    execute: async (_id, params) => {
      const r = engine.profileApply(params ?? {});
      if (!r.ok) return refused("Profile", r);
      return text(renderApply(r), {
        written: r.written,
        unchanged: r.unchanged,
        profile: r.profile,
        commit: r.commit,
      });
    },
  };

  const retune: PiToolDefinition = {
    name: "setup_retune",
    label: "Re-tune the profile after a scan",
    description:
      "After a scan, change the repo profile from what the scan found — through the same path as setup_profile_apply " +
      "(`priorities` through the table, `emphasis`, a drafted `style_guide`) — and REPORT it. Needs a finished scan run (the " +
      "latest, or `scan`) and a finished setup interview. Every change needs its reason in `reasons` — keyed by the concern " +
      `(a priority), the lens (an emphasis) or "${GUIDE_REASON}" — at most ${RETUNE_REASON_MAX} characters, citing what the scan ` +
      "found; a reason for something that does not change is refused. Without `write` it PREVIEWS. `write: true` writes the " +
      "profile (validated with the daemon's own loaders), logs the report, refreshes the portrait facts and asks for a " +
      "commit. You apply it yourself — then tell the owner what changed and why. It reaches PR reviews only when HE deploys.",
    promptSnippet: "Preview or apply a post-scan re-tune of the repo profile, with its reasons",
    parameters: {
      type: "object",
      properties: {
        scan: {
          type: "string",
          description: "The finished scan run it follows (scan_status); the latest when omitted.",
        },
        priorities: {
          type: "object",
          description: `{concern: priority} to change; concerns: ${CONCERNS.map((c) => c.name).join(", ")}; priorities: ${PRIORITIES.join(", ")}.`,
        },
        emphasis: {
          type: "object",
          description: "{lens: the words for it, or null to remove them}.",
        },
        style_guide: { type: "string", description: "A revised drafted style guide (markdown)." },
        drop_style_guide: {
          type: "boolean",
          description: "true stops the style lens reading the drafted guide.",
        },
        reasons: {
          type: "object",
          description: `{concern | lens | "${GUIDE_REASON}": why, from what the scan found} — one per change.`,
        },
        write: { type: "boolean", description: "true writes; omitted or false previews." },
      },
      required: ["reasons"],
    },
    execute: async (_id, params) => {
      const r = engine.retune(params ?? {});
      if (!r.ok) return refused("Re-tune", r);
      return text(renderRetune(r), {
        written: r.written,
        profile: r.profile,
        scan: r.scan.run,
        changes: r.changes.length,
        commit: r.commit,
      });
    },
  };

  const profileValidate: PiToolDefinition = {
    name: "setup_profile_validate",
    label: "Validate the repo profile",
    description:
      "Check a repo profile AS IT IS ON DISK with the daemon's own loaders — for a direct edit (the owner's editor, or yours): " +
      "whether the daemon would boot with it and what it resolves to (the extends chain, addenda, tuned lenses, heuristics, " +
      "[scan]). Defaults to the profile setup works on.",
    promptSnippet: "Validate the repo profile on disk",
    parameters: { type: "object", properties: { profile: { type: "string" } } },
    execute: async (_id, params) => {
      const r = engine.profileValidate((params as { profile?: unknown } | undefined)?.profile);
      if (!("check" in r)) return refused("Validate", r);
      return text(renderCheck(r.profile, r.check), { ok: r.check.ok });
    },
  };

  const pins: PiToolDefinition = {
    name: "setup_pin_propose",
    label: "Propose memory pins",
    description:
      `Propose up to ${MAX_PIN_PROPOSALS} reviewer-memory entries (the survey's and history's most important conventions) for ` +
      "PINNING — pinned entries head every PR round, and the head is small. Each is {id, ts, block, why}: a live, unpinned " +
      `entry as memory lists it, and one line (≤${PIN_WHY_MAX}) of why. It REPLACES earlier proposals and pins NOTHING: the ` +
      "owner pins in the TUI's memory tab, where each proposal is marked with your reason. The answer prices the pinned head.",
    promptSnippet: "Propose memory entries for the owner to pin",
    parameters: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              ts: { type: "string" },
              block: { type: "number" },
              why: { type: "string" },
            },
            required: ["id", "ts", "block", "why"],
          },
        },
      },
      required: ["entries"],
    },
    execute: async (_id, params) => {
      const r = await engine.proposePins((params as { entries?: unknown } | undefined)?.entries);
      if (!r.ok) return refused("Pin proposals", r);
      const over = r.projected_chars > r.budget_chars;
      return text(
        [
          `Proposed ${r.proposed.length} entr${r.proposed.length === 1 ? "y" : "ies"} for the owner to pin${r.replaced > 0 ? ` (replacing ${r.replaced} earlier proposals)` : ""}:`,
          ...r.proposed.map((p) => `  ☆ ${p.ts} [${p.id}#${p.block}] ${p.excerpt} — ${p.why}`),
          `Pinned head: ${r.pinned_chars} characters now, ${r.projected_chars} if he pins them all (budget ~${r.budget_chars})${over ? " — OVER: propose fewer, or shorter entries" : ""}.`,
          "Tell him they are marked ☆ on the TUI's memory tab ([2]); he pins with p. You do not pin them.",
        ].join("\n"),
        { proposed: r.proposed.length, projected_chars: r.projected_chars },
      );
    },
  };

  return [
    facts,
    status,
    propose,
    adjust,
    save,
    history,
    themes,
    surveyPreview,
    surveyStart,
    surveyStatus,
    surveyStop,
    portraitAssemble,
    portrait,
    narrative,
    interview,
    profileState,
    profileApply,
    retune,
    profileValidate,
    pins,
  ];
}

// ---- activation ----------------------------------------------------------------

/** The companion agent set (docker/companion/agents), beside this file in
 * the /workspace checkout — where `pass-survey` lives. Resolved from this
 * SOURCE file: pi loads the extension's .ts through jiti, never dist/. */
export const COMPANION_AGENTS_DIR = fileURLToPath(
  new URL("../docker/companion/agents", import.meta.url),
);

/** The app checkout this extension runs from (`/workspace` in the
 * companion) — where the generic profiles a repo profile extends live. */
export const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The ports the engine and the scan triage share: the reviewer's memory
 * and the tracker sink — the issue tracker mounted at QCR_TRACKER_DIR
 * (`/tracker`), or one markdown file per promoted finding in the state home
 * when there is none. */
export function sharedPorts(env: NodeJS.ProcessEnv = process.env): {
  memory: MemoryStore | null;
  tracker: TrackerSink;
} {
  return {
    memory: reviewerMemoryFromEnv(env),
    tracker: scanTrackerSink({
      trackerDir: env.QCR_TRACKER_DIR?.trim(),
      state: stateHomeFs(stateHome(env)),
      clock: () => new Date(),
    }),
  };
}

export function buildEngine(
  env: NodeJS.ProcessEnv = process.env,
  shared: { memory: MemoryStore | null; tracker: TrackerSink } = sharedPorts(env),
): SetupEngine {
  return new SetupEngine(
    {
      repo: checkoutReader(env.QCR_REVIEWED_REPO?.trim() || DEFAULT_REVIEWED_REPO),
      state: stateHomeFs(stateHome(env)),
      // The config home, for the portrait narrative. In the
      // companion only `profiles/` and `portrait/` of it are mounted
      // read-write, and the narrative is written under `portrait/` alone.
      config: configHomeFs(configHome(env)),
      // The repo profile: read, checked with the daemon's own
      // loaders against the app's generic examples, and written under the
      // config home's `profiles/` — the one part of it mounted read-write.
      profiles: { root: env.QCR_ROOT?.trim() || APP_ROOT, env },
      clock: () => new Date(),
      // The reviewer's memory (survey notes and review-history themes are
      // for PR rounds), or null — the survey then refuses to start
      // and a themes save says memory was not written.
      memory: shared.memory,
      // Background pi subagents, run from the companion's own cwd (first-party
      // ground), never from the reviewed checkout.
      cases: piCaseRunner({
        agentsDir: COMPANION_AGENTS_DIR,
        cwd: env.QCR_ROOT?.trim() || process.cwd(),
      }),
      tracker: shared.tracker,
      github: tokenFileGitHubReader({
        envFile: env.QCR_GITHUB_READ_ENV,
        fetch: (input, init) => fetch(input, init),
        clock: () => new Date(),
      }),
      log: (line) => console.error(line),
    },
    // The companion's subagent cap (QCR_SUBAGENT_MAX_CONCURRENCY).
    { surveyConcurrency: resolveMaxConcurrency(env) },
  );
}

const activate = (pi: Pi): void => {
  if (typeof pi.registerTool !== "function") {
    console.error("setup: pi.registerTool unavailable — no setup tools registered.");
    return;
  }
  let engine: SetupEngine;
  let shared: ReturnType<typeof sharedPorts>;
  try {
    shared = sharedPorts();
    engine = buildEngine(process.env, shared);
  } catch (err) {
    // A bad QCR_INSTALL is the only throw on this path: say so, start without
    // the belt rather than failing the companion's start.
    console.error(`setup: not registered — ${String(err)}`);
    return;
  }
  for (const def of toolDefinitions(engine)) pi.registerTool(def);
  // The scan tools, over the same engine's saved unit cut.
  const { scan, findings, settingsOf, triage } = buildScan(
    engine,
    process.env.QCR_REVIEWED_REPO?.trim() || DEFAULT_REVIEWED_REPO,
    process.env,
    shared,
  );
  for (const def of scanToolDefinitions(
    scan,
    findings,
    settingsOf,
    triage ? () => triage.closeFixed() : null,
  ))
    pi.registerTool(def);
  // Triage — dismiss, promote, close fixed, scan memory.
  if (triage) for (const def of triageToolDefinitions(triage)) pi.registerTool(def);
  // The PR replay — old vs new profile, cost first.
  const replay = buildReplay(
    process.env.QCR_REVIEWED_REPO?.trim() || DEFAULT_REVIEWED_REPO,
    process.env,
    resolveMaxConcurrency(),
  );
  for (const def of replayToolDefinitions(replay)) pi.registerTool(def);
  // The TUI's stage-2 start click and its scan stop, answered while the
  // companion's session runs (the inject-bridge's lifecycle: start on
  // session_start, stop on session_shutdown).
  let unwatch: (() => void) | null = null;
  // VERIFY-ON-PIN: "session_start" / "session_shutdown" event names (as inject-bridge).
  pi.on("session_start", () => {
    unwatch?.();
    unwatch = watchTuiRequests(scan);
  });
  pi.on("session_shutdown", () => {
    unwatch?.();
    unwatch = null;
  });
};

export default activate;
