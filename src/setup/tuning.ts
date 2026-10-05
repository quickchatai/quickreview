// Setup's tuning behaviours: the interview's answers → the repo
// profile, and the pins the companion proposes → the operator. The engine
// (engine.ts) delegates here; the rules live in interview.ts (the table) and
// profile.ts (validate, stage, surgical edit), the commit hand-off in
// configcommit.ts.
//
// What persists, and where:
//   * `<state home>/setup/interview.json` — the answers so far (priorities per
//     concern, the goals in the operator's words) and the commit requests
//     this setup made. PC-only: the profile carries the SETTINGS, this file
//     carries WHY, so a re-tune starts from the last answers.
//   * `<config home>/profiles/<name>/` — the profile itself (profile.toml, and
//     a drafted `style-guide.md` when the repo writes no guide of its own).
//   * `<state home>/setup/pin-proposals.json` (pins.ts) — the entries the
//     companion proposes to pin. It PROPOSES; the operator pins, in the TUI's
//     memory tab, where each proposal is marked with its reason. No tool here
//     pins.
//
// A write needs the whole interview: every concern answered and the goals
// said. A preview never does, and never writes anything.
import { ALL_PASSES } from "../dispatch.js";
import { EXAMPLE_PROFILES, PROFILES_DIR } from "../install.js";
import {
  PINNED_BUDGET_CHARS,
  pinnedBudget,
  type MemoryEntry,
  type MemoryStore,
} from "../memory/store.js";
import { EMPHASIS_MAX_CHARS, PROFILE_GUIDE_MAX_CHARS, STYLE_LENS } from "../lenstuning.js";
import { lineDiff } from "./portrait.js";
import {
  parsePinProposals,
  PIN_PROPOSALS_FILE,
  proposalKey,
  type PinProposal,
  type PinProposalsFile,
} from "./pins.js";
import type { Refusal, StateFs } from "./engine.js";
import { recordBaseline } from "./baselines.js";
import {
  commitId,
  requestFile,
  resultFile,
  type CommitRequest,
  type CommitResult,
} from "./configcommit.js";
import {
  CONCERN_NAMES,
  lensDecisions,
  parsePriorities,
  TABLE_KEYS,
  unansweredConcerns,
  type LensDecision,
  type Priority,
} from "./interview.js";
import {
  checkProfile,
  checkStaged,
  DEFAULT_BASE,
  DRAFTED_GUIDE_FILE,
  editLensTables,
  newProfileText,
  PROFILE_FILE,
  readProfileFile,
  readProfileTarget,
  writeProfileFiles,
  writeTarget,
  type LensChanges,
  type ProfileCheck,
  type ProfileFiles,
  type ProfileHome,
  type ProfileSummary,
  type ProfileTarget,
} from "./profile.js";

export const INTERVIEW_FILE = "setup/interview.json";
export const GOALS_MAX_CHARS = 2000;
/** A handful: pins are the head of every round, and the head is small. */
export const MAX_PIN_PROPOSALS = 8;
export const PIN_WHY_MAX = 200;
/** Commit requests the record remembers (newest kept). */
const COMMITS_KEPT = 10;

export interface TuningDeps {
  state: StateFs;
  /** Null when this assembly cannot reach the config home's profiles. */
  profiles: ProfileHome | null;
  memory: MemoryStore | null;
  clock: () => Date;
}

// ---- the interview record ----------------------------------------------------

export interface InterviewRecord {
  version: 1;
  profile: string;
  goals: string | null;
  priorities: Record<string, Priority>;
  updated_at: string;
  commits: Array<{ id: string; requested_at: string }>;
}

export type RecordRead =
  | { state: "absent" }
  | { state: "ok"; record: InterviewRecord }
  | { state: "unreadable"; error: string };

export function readRecord(state: StateFs): RecordRead {
  let text: string | null;
  try {
    text = state.read(INTERVIEW_FILE);
  } catch (err) {
    return { state: "unreadable", error: `${INTERVIEW_FILE} cannot be read: ${String(err)}` };
  }
  if (text === null) return { state: "absent" };
  try {
    const raw = JSON.parse(text) as Partial<InterviewRecord>;
    if (raw.version !== 1 || typeof raw.profile !== "string")
      throw new Error("not a version-1 interview record");
    const p = parsePriorities(raw.priorities ?? {});
    if (!p.ok) throw new Error(p.errors.join("; "));
    return {
      state: "ok",
      record: {
        version: 1,
        profile: raw.profile,
        goals: typeof raw.goals === "string" ? raw.goals : null,
        priorities: p.priorities,
        updated_at: typeof raw.updated_at === "string" ? raw.updated_at : "",
        commits: Array.isArray(raw.commits)
          ? raw.commits.filter((c) => typeof c?.id === "string")
          : [],
      },
    };
  } catch (err) {
    return {
      state: "unreadable",
      error: `${INTERVIEW_FILE} in ${state.location} is not an interview record (${String(err)}) — nothing will overwrite it; move it aside to start over`,
    };
  }
}

function readResult(state: StateFs, id: string): CommitResult | null | "unreadable" {
  try {
    const text = state.read(resultFile(id));
    return text === null ? null : (JSON.parse(text) as CommitResult);
  } catch {
    return "unreadable";
  }
}

// ---- status ------------------------------------------------------------------------

export interface ProfileStatus {
  target: ProfileTarget;
  /** The profile setup works on: the recorded one, else the config's own. */
  profile: string | null;
  /** The daemon's own check of it; null when there is none to check. */
  check: ProfileCheck | null;
  /** No profile of the install's own is in use — the companion nudges.
   * Null when the live config cannot be read: whether setup is owed is then
   * UNKNOWN, never guessed either way (`why_setup` says why). */
  needs_setup: boolean | null;
  why_setup: string | null;
  interview: RecordRead;
  /** Null when the interview record cannot be read — unknown, never "all". */
  unanswered: string[] | null;
  commits: Array<{ id: string; requested_at: string; result: CommitResult | null | "unreadable" }>;
}

export function profileStatus(deps: TuningDeps): ProfileStatus | Refusal {
  if (!deps.profiles)
    return { ok: false, errors: ["this assembly has no config home to read profiles from"] };
  const target = readProfileTarget(deps.profiles);
  const interview = readRecord(deps.state);
  const record = interview.state === "ok" ? interview.record : null;
  const named = target.state === "ok" ? target.named : "";
  const profile = record?.profile ?? (named !== "" ? named : null);
  const check = profile ? checkProfile(deps.profiles, profile) : null;
  let why: string | null = null;
  let owed: boolean | null = null;
  if (target.state !== "ok") why = `the live config cannot be read (${target.error})`;
  else if (named === "")
    why = "the live config names no repo profile — PR rounds run the untuned shipped behaviour";
  else if (EXAMPLE_PROFILES.includes(named))
    why = `the live config names "${named}", a generic example — the repo has no profile of its own`;
  else {
    // The profile PR rounds actually use — which may not be the one setup is
    // working on (a fresh profile the config does not name yet).
    const inUse = profile === named ? check : checkProfile(deps.profiles, named);
    if (inUse && !inUse.ok)
      why = `the profile the live config names does not load: ${inUse.errors[0]}`;
  }
  if (target.state === "ok") owed = why !== null;
  return {
    target,
    profile,
    check,
    needs_setup: owed,
    why_setup: why,
    interview,
    unanswered:
      interview.state === "unreadable" ? null : unansweredConcerns(record?.priorities ?? {}),
    commits: (record?.commits ?? []).map((c) => ({ ...c, result: readResult(deps.state, c.id) })),
  };
}

/** The daemon's check of a profile as it is on disk — for a direct edit. */
export function profileValidate(
  deps: TuningDeps,
  name?: unknown,
): { profile: string; check: ProfileCheck } | Refusal {
  if (!deps.profiles)
    return { ok: false, errors: ["this assembly has no config home to read profiles from"] };
  let profile = typeof name === "string" ? name.trim() : "";
  if (profile === "") {
    const r = readRecord(deps.state);
    const t = readProfileTarget(deps.profiles);
    profile = (r.state === "ok" ? r.record.profile : "") || (t.state === "ok" ? t.named : "");
  }
  if (profile === "")
    return {
      ok: false,
      errors: ["no profile to validate — the live config names none; pass `profile`"],
    };
  return { profile, check: checkProfile(deps.profiles, profile) };
}

// ---- apply ---------------------------------------------------------------------------

export interface ApplyInput {
  profile?: unknown;
  goals?: unknown;
  priorities?: unknown;
  /** lens → the words for it, or null to remove them. */
  emphasis?: unknown;
  /** A drafted style guide (markdown), or null to stop pointing at one. */
  style_guide?: unknown;
  /** true: the same as `style_guide: null` (a tool schema has no null). */
  drop_style_guide?: unknown;
  /** false (the default) previews; true writes. */
  write?: unknown;
}

export interface ApplyResult {
  ok: true;
  written: boolean;
  unchanged: boolean;
  profile: string;
  dir: string;
  created: boolean;
  decisions: LensDecision[];
  diff: Array<{ file: string; lines: string[] }>;
  unanswered: string[];
  goals_missing: boolean;
  summary: ProfileSummary;
  /** The profile the live config names ("" = none), for the "not in use" note. */
  config_names: string | null;
  commit: { id: string } | null;
  /**: the profile as it was before this write, recorded for the PR
   * replay under the commit id — or why it could not be (the write still
   * landed; only the replay's default "old" side is missing). Null when
   * nothing was written. */
  baseline: { id: string } | { error: string } | null;
}

export function parseEmphasis(
  raw: unknown,
): { ok: true; emphasis: Record<string, string | null> } | Refusal {
  if (raw === undefined || raw === null) return { ok: true, emphasis: {} };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, errors: ["`emphasis` must be an object of {lens: text | null}"] };
  const errors: string[] = [];
  const out: Record<string, string | null> = {};
  for (const [lens, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!ALL_PASSES.includes(lens)) errors.push(`emphasis: "${lens}" is not a lens`);
    else if (v === null) out[lens] = null;
    else if (typeof v !== "string" || v.trim() === "")
      errors.push(`emphasis for ${lens} must be text, or null to remove it`);
    else if (v.length > EMPHASIS_MAX_CHARS)
      errors.push(`emphasis for ${lens} is over ${EMPHASIS_MAX_CHARS} characters`);
    else out[lens] = v.trim();
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, emphasis: out };
}

/**
 * The interview's answers applied to the profile: the table's settings on
 * every lens a concern names, the companion's emphasis, a drafted guide.
 * Staged and checked with the daemon's loaders before anything is written;
 * with `write` the files land, the answers are recorded and — when a file
 * changed — a commit is requested for the operator's machine to carry out.
 * `opts.message` is the commit message a caller other than the interview
 * asks for (a post-scan re-tune, retune.ts) — never a tool parameter.
 * `opts.decide`, when given, limits the table's settings to those lenses: a
 * re-tune re-decides only what its changed priorities name, so an operator's
 * direct edit of any other lens survives it (also never a tool parameter).
 */
export function profileApply(
  deps: TuningDeps,
  input: ApplyInput,
  opts: { message?: string; decide?: ReadonlySet<string> } = {},
): ApplyResult | Refusal {
  if (!deps.profiles)
    return { ok: false, errors: ["this assembly has no config home to write profiles to"] };
  const home = deps.profiles;
  const write = input.write === true;
  const rec = readRecord(deps.state);
  if (rec.state === "unreadable") return { ok: false, errors: [rec.error] };
  const record = rec.state === "ok" ? rec.record : null;
  const target = readProfileTarget(home);
  const named = target.state === "ok" ? target.named : null;

  const asked = typeof input.profile === "string" ? input.profile.trim() : "";
  const profile = asked || record?.profile || (named ?? "");
  if (profile === "") {
    return {
      ok: false,
      errors: [
        "the live config names no repo profile yet — pass `profile`: a plain name for this repo's own (the repo's name is a good one)",
      ],
    };
  }
  const where = writeTarget(home, profile);
  if (!where.ok) return { ok: false, errors: [where.error] };

  const pr = parsePriorities(input.priorities);
  if (!pr.ok) return pr;
  const em = parseEmphasis(input.emphasis);
  if (!em.ok) return em;
  if (
    input.goals !== undefined &&
    (typeof input.goals !== "string" ||
      input.goals.trim() === "" ||
      input.goals.length > GOALS_MAX_CHARS)
  ) {
    return {
      ok: false,
      errors: [
        `\`goals\` must be the project's goals in the operator's words, at most ${GOALS_MAX_CHARS} characters`,
      ],
    };
  }
  const guide = input.drop_style_guide === true ? null : input.style_guide;
  if (
    guide !== undefined &&
    guide !== null &&
    (typeof guide !== "string" || guide.trim() === "" || guide.length > PROFILE_GUIDE_MAX_CHARS)
  ) {
    return {
      ok: false,
      errors: [
        `\`style_guide\` must be markdown text of at most ${PROFILE_GUIDE_MAX_CHARS} characters, or null`,
      ],
    };
  }

  // The answers so far: the record's (same profile only), then this call's.
  const priorities = {
    ...(record && record.profile === profile ? record.priorities : {}),
    ...pr.priorities,
  };
  const goals =
    typeof input.goals === "string"
      ? input.goals.trim()
      : record && record.profile === profile
        ? record.goals
        : null;
  const unanswered = unansweredConcerns(priorities);
  if (write && (unanswered.length > 0 || goals === null)) {
    const missing = [
      ...(goals === null ? ["the project's goals (`goals`)"] : []),
      ...(unanswered.length > 0 ? [`a priority for: ${unanswered.join(", ")}`] : []),
    ];
    return {
      ok: false,
      errors: [
        `the interview is not finished — still to ask: ${missing.join("; ")}. Preview (write: false) shows what the answers so far would do.`,
      ],
    };
  }

  // What the answers change.
  const decisions = lensDecisions(priorities);
  const changes: LensChanges = {};
  for (const d of decisions) {
    if (opts.decide && !opts.decide.has(d.lens)) continue;
    const keys: Record<string, string | boolean | null> = {};
    for (const k of TABLE_KEYS) keys[k] = d.settings[k] ?? null;
    changes[d.lens] = keys;
  }
  for (const [lens, text] of Object.entries(em.emphasis)) (changes[lens] ??= {}).emphasis = text;
  const files: ProfileFiles = {};
  if (typeof guide === "string") {
    (changes[STYLE_LENS] ??= {}).guide = DRAFTED_GUIDE_FILE;
    files[DRAFTED_GUIDE_FILE] = guide.replace(/\n*$/, "\n");
  } else if (guide === null) {
    (changes[STYLE_LENS] ??= {}).guide = null;
  }

  let before: string;
  let guideBefore: string;
  try {
    before = readProfileFile(where.dir, PROFILE_FILE);
    guideBefore = readProfileFile(where.dir, DRAFTED_GUIDE_FILE);
  } catch (err) {
    return {
      ok: false,
      errors: [`${where.dir} cannot be read: ${String(err)} — nothing was changed`],
    };
  }
  const edited = editLensTables(before === "" ? newProfileText(DEFAULT_BASE) : before, changes);
  if (!edited.ok) return { ok: false, errors: [`${where.dir}/${PROFILE_FILE}: ${edited.error}`] };
  if (edited.text !== before) files[PROFILE_FILE] = edited.text;
  if (files[DRAFTED_GUIDE_FILE] === guideBefore) delete files[DRAFTED_GUIDE_FILE];

  const check = checkStaged(home, profile, files);
  if (!check.ok) {
    return {
      ok: false,
      errors: [
        `the profile these answers produce would not load — nothing was written:`,
        ...check.errors,
      ],
    };
  }
  const diff: ApplyResult["diff"] = [];
  if (files[PROFILE_FILE] !== undefined)
    diff.push({ file: PROFILE_FILE, lines: lineDiff(before, files[PROFILE_FILE]) });
  if (files[DRAFTED_GUIDE_FILE] !== undefined)
    diff.push({
      file: DRAFTED_GUIDE_FILE,
      lines: lineDiff(guideBefore, files[DRAFTED_GUIDE_FILE]),
    });
  const unchanged = Object.keys(files).length === 0;

  let commit: { id: string } | null = null;
  let baseline: ApplyResult["baseline"] = null;
  if (write) {
    const now = deps.clock();
    if (!unchanged) {
      // what the write is about to replace, kept for the replay's
      // "old" side — BEFORE the files change, so a crash in between leaves a
      // baseline of the profile still on disk, never a missing one.
      const id = commitId(now, profile, (candidate) => {
        try {
          return (
            deps.state.read(requestFile(candidate)) !== null ||
            deps.state.read(resultFile(candidate)) !== null
          );
        } catch {
          return true; // unreadable: it exists, so it is taken
        }
      });
      try {
        recordBaseline(deps.state, {
          id,
          taken_at: now.toISOString(),
          profile,
          existed: where.exists,
          files: Object.fromEntries(
            Object.keys(files).map((f) => {
              const was = f === PROFILE_FILE ? before : f === DRAFTED_GUIDE_FILE ? guideBefore : "";
              return [f, was === "" ? null : was];
            }),
          ),
          config_named: named,
        });
        baseline = { id };
      } catch (err) {
        baseline = {
          error: `the profile before this write was not recorded for a replay: ${String(err)}`,
        };
      }
      try {
        writeProfileFiles(where.dir, files);
      } catch (err) {
        return { ok: false, errors: [`writing ${where.dir} failed: ${String(err)}`] };
      }
      const req: CommitRequest = {
        id,
        requested_at: now.toISOString(),
        profile,
        paths: Object.keys(files).map((f) => `${PROFILES_DIR}/${profile}/${f}`),
        message: opts.message ?? commitMessage(profile, priorities),
      };
      deps.state.write(requestFile(id), `${JSON.stringify(req, null, 2)}\n`);
      commit = { id };
    }
    const next: InterviewRecord = {
      version: 1,
      profile,
      goals,
      priorities,
      updated_at: now.toISOString(),
      commits: [
        ...(record?.commits ?? []),
        ...(commit ? [{ id: commit.id, requested_at: now.toISOString() }] : []),
      ].slice(-COMMITS_KEPT),
    };
    deps.state.write(INTERVIEW_FILE, `${JSON.stringify(next, null, 2)}\n`);
  }
  return {
    ok: true,
    written: write && !unchanged,
    unchanged,
    profile,
    dir: where.dir,
    created: !where.exists,
    decisions,
    diff,
    unanswered,
    goals_missing: goals === null,
    summary: check.summary,
    config_names: named,
    commit,
    baseline,
  };
}

/** The commit message: which profile, and the answers that shaped it. */
export function commitMessage(profile: string, priorities: Record<string, Priority>): string {
  const notable = CONCERN_NAMES.filter(
    (c) => priorities[c] !== undefined && priorities[c] !== "normal",
  ).map((c) => `${c} ${priorities[c]}`);
  return `qcr setup: tune profile ${profile}${notable.length > 0 ? ` (${notable.join(", ")})` : ""}`;
}

// ---- pin proposals -----------------------------------------------------------------

export interface PinProposeResult {
  ok: true;
  proposed: PinProposal[];
  replaced: number;
  /** Pinned-head characters now, and with every proposal pinned. */
  pinned_chars: number;
  projected_chars: number;
  budget_chars: number;
}

/**
 * Record the entries the companion proposes to pin — REPLACING the previous
 * proposals. Each must be a live, unpinned entry of the reviewer's memory as
 * it reads now, with one line of why. Nothing is pinned: the operator pins
 * in the TUI's memory tab, where these are marked.
 */
export async function proposePins(
  deps: TuningDeps,
  raw: unknown,
): Promise<PinProposeResult | Refusal> {
  if (!deps.memory)
    return {
      ok: false,
      errors: ["reviewer memory is not reachable from here — nothing to propose against"],
    };
  if (!Array.isArray(raw) || raw.length === 0)
    return { ok: false, errors: ["`entries` must be a non-empty array of {id, ts, block, why}"] };
  if (raw.length > MAX_PIN_PROPOSALS) {
    return {
      ok: false,
      errors: [
        `at most ${MAX_PIN_PROPOSALS} proposals — pins are the head of every round; choose the few that matter most`,
      ],
    };
  }
  let entries: MemoryEntry[];
  try {
    entries = await deps.memory.read();
  } catch (err) {
    return { ok: false, errors: [`reviewer memory could not be read: ${String(err)}`] };
  }
  const errors: string[] = [];
  const proposed: PinProposal[] = [];
  for (const [i, item] of raw.entries()) {
    const r = (item ?? {}) as { id?: unknown; ts?: unknown; block?: unknown; why?: unknown };
    const block = typeof r.block === "string" && /^\d+$/.test(r.block) ? Number(r.block) : r.block;
    const e = entries.find((x) => x.id === r.id && x.ts === r.ts && x.block === block);
    const why = typeof r.why === "string" ? r.why.trim() : "";
    const oneLine = !/[\r\n]/.test(why);
    if (!e)
      errors.push(
        `entries[${i}]: no memory entry ${JSON.stringify({ id: r.id, ts: r.ts, block: r.block })} — read memory again`,
      );
    else if (e.pinned) errors.push(`entries[${i}]: ${e.id} is already pinned`);
    else if (why === "" || !oneLine || why.length > PIN_WHY_MAX)
      errors.push(`entries[${i}]: \`why\` must be one line of at most ${PIN_WHY_MAX} characters`);
    else if (proposed.some((p) => proposalKey(p) === proposalKey(e)))
      errors.push(`entries[${i}]: proposed twice`);
    else
      proposed.push({
        id: e.id,
        ts: e.ts,
        block: e.block,
        hash: e.hash,
        excerpt: e.text.replace(/\s+/g, " ").slice(0, 160),
        why,
      });
  }
  if (errors.length > 0) return { ok: false, errors };
  const prior = (() => {
    try {
      return parsePinProposals(deps.state.read(PIN_PROPOSALS_FILE));
    } catch (err) {
      return { state: "unreadable" as const, error: String(err) };
    }
  })();
  const file: PinProposalsFile = { proposed_at: deps.clock().toISOString(), entries: proposed };
  deps.state.write(PIN_PROPOSALS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  const now = pinnedBudget(entries).chars;
  const keys = new Set(proposed.map(proposalKey));
  const projected = pinnedBudget(
    entries.map((e) => (keys.has(proposalKey(e)) ? { ...e, pinned: true } : e)),
  ).chars;
  return {
    ok: true,
    proposed,
    replaced: prior.state === "ok" ? prior.file.entries.length : 0,
    pinned_chars: now,
    projected_chars: projected,
    budget_chars: PINNED_BUDGET_CHARS,
  };
}
