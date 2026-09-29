// The repo portrait (setup & scan spec "Portrait", user stories
// 21–24): what the interview starts from. Two halves, kept apart on purpose
// so the operator can check the one and still see the other:
//
//   - the FACTS — deterministic, assembled by the engine from what is already
//     on disk: the stack (languages, manifests, frameworks) and the unit cut,
//     the conventions the repo writes down (design docs, style guides,
//     agent-directive files) and what it already ENFORCES (CI, linters and
//     formatters), and the review history THEMES (never the digest). Stored in
//     the STATE home, `setup/portrait-facts.json` — PC-only, never shipped.
//   - the NARRATIVE — the companion's reading of those facts, in prose,
//     stored in the CONFIG home, `portrait/narrative.md`: the operator's to
//     read and keep (a config home that is a git repo versions it), and never
//     shipped (deploy's filter admits the config file and `profiles/` only).
//
// Each half keeps the version it replaced — the facts file carries its
// `previous`, the narrative its `narrative.previous.md` — so a refresh can be
// DIFFED: what changed in the repo, and what changed in the reading of it.
//
// The facts carry a KEY over their SHAPE — which frameworks, units, linters,
// themes; never a file or line count — and a narrative is stored only against
// the key of the facts it read. A narrative whose key the facts have since
// moved past reads as STALE, so a new framework or unit shows up as "your
// reading predates this"; an ordinary commit adding a file does not.
//
// After a scan the facts gain a SCAN section — the last finished
// scan, the findings by unit and state, and the per-unit hotspots from scan
// memory (scanfacts.ts) — so re-assembling after a scan moves the key (the
// narrative reads STALE until it is rewritten from what the scan found) and
// keeps the pre-scan version as `previous`. A portrait that never saw a scan
// has no scan section at all, and its key is the one it always had.
//
// The raw review history never reaches either half: the facts take only the
// saved themes (`historyThemesState`), and a narrative that quotes a raw
// comment or names its author is refused by the history slice's own belt
// (`leakChecker`) — the narrative lives in a home that may be a git repo.
import { createHash } from "node:crypto";
import { PORTRAIT_DIR } from "../install.js";
import type { StateFs } from "./engine.js";
import type { CiFact, Evidence, LanguageCount } from "./facts.js";
import { leakChecker, readDigest, type HistoryTheme } from "./history.js";

export const PORTRAIT_FACTS_FILE = "setup/portrait-facts.json";
export const PORTRAIT_FACTS_VERSION = 1;
/** In the CONFIG home. */
export const NARRATIVE_FILE = `${PORTRAIT_DIR}/narrative.md`;
export const NARRATIVE_PREVIOUS_FILE = `${PORTRAIT_DIR}/narrative.previous.md`;
/** A narrative is a page, not a report. */
export const NARRATIVE_MAX = 16_000;

// ---- the facts ---------------------------------------------------------------

export interface PortraitUnit {
  name: string;
  kind: string;
  roots: string[];
  note: string;
  files: number;
  reviewable: number;
  lines: number;
  cases: number;
}

export interface PortraitFacts {
  /** The commit the facts were read at, when readable. */
  head: string | null;
  stack: {
    files: number;
    languages: LanguageCount[];
    manifests: Evidence[];
    frameworks: Evidence[];
  };
  units: {
    /** `saved` = the operator's saved cut; `candidates` = no cut is saved
     * yet (or its file is unreadable — `problems` says which), so these are
     * the deterministic first guess, never presented as the cut. */
    source: "saved" | "candidates";
    saved_at: string | null;
    units: PortraitUnit[];
    ignored: string[];
  };
  /** What the repo writes down about how it works. */
  conventions: { guides: string[]; style_guides: string[]; agent_files: string[] };
  /** What tooling already holds the repo to. */
  enforced: { ci: CiFact[]; linters: Evidence[] };
  /** The saved review history themes; `unreadable` is UNKNOWN, not none. */
  history: {
    state: "absent" | "unreadable" | "ok";
    saved_at: string | null;
    digest_generated_at: string | null;
    themes: HistoryTheme[];
  };
  /** The last completed survey, for provenance — its notes are in reviewer
   * memory as `#survey` entries, not here. */
  survey: { id: string; finished_at: string; head: string | null; notes: number } | null;
  /** What the scans found (scanfacts.ts); null — or absent, on facts
   * stored before it existed — when nothing was ever scanned. */
  scan?: PortraitScan | null;
  /** What could not be read while assembling — the rest is then partial. */
  problems: string[];
}

/** One unit's findings, by state. `open` = new or promoted (still standing). */
export interface ScanUnitFacts {
  unit: string;
  open: number;
  promoted: number;
  dismissed: number;
  fixed: number;
  /** Open findings the validator doubted ("may not be valid"). */
  doubted: number;
  /** The open findings' `<severity> <lens>` pairs, most severe first — the
   * shape the key is over (never the counts). */
  open_by: string[];
}

export interface PortraitScan {
  /** `unreadable`: a scan record could not be read — the counts are then
   * partial and the section reads UNKNOWN (the facts' problems say which). */
  state: "ok" | "unreadable";
  /** The last FINISHED scan run. */
  last: { id: string; mode: string; sha: string; state: string; finished_at: string | null } | null;
  findings: {
    open: number;
    promoted: number;
    dismissed: number;
    fixed: number;
    doubted: number;
    /** Open findings per severity. */
    by_severity: Record<string, number>;
    units: ScanUnitFacts[];
  };
  /** The latest hotspot per unit the companion wrote to scan memory. */
  hotspots: Array<{ unit: string; text: string; sha: string; at: string }>;
}

export interface FactsVersion {
  key: string;
  assembled_at: string;
  facts: PortraitFacts;
}

export interface PortraitFactsFile {
  version: number;
  current: FactsVersion;
  /** The version with a different key that `current` replaced. */
  previous: FactsVersion | null;
}

export const PORTRAIT_SECTIONS = ["stack", "units", "conventions", "enforced", "history", "survey", "scan", "problems"] as const;
export type PortraitSection = (typeof PORTRAIT_SECTIONS)[number];

/**
 * The facts' SHAPE, one line per fact, by section — what the key hashes and
 * the diff compares. Deliberately count-free (no file, line or case counts,
 * no timestamps, no head): those move with every commit, and a narrative is
 * not stale because a file was added.
 */
export function shapeLines(f: PortraitFacts): Record<PortraitSection, string[]> {
  const ev = (what: string, xs: readonly Evidence[]): string[] => xs.map((x) => `${what} ${x.name} — ${x.evidence}`);
  const root = (r: string): string => r || "(repo root)";
  return {
    stack: [
      // By name, not the facts' by-count ranking: one language overtaking
      // another is a count moving, not a new shape.
      ...f.stack.languages.map((l) => `language ${l.language}`).sort(),
      ...ev("manifest", f.stack.manifests),
      ...ev("framework", f.stack.frameworks),
    ],
    units: [
      `cut: ${f.units.source === "saved" ? "saved" : "none saved — candidates"}`,
      ...f.units.units.map((u) => `unit ${u.name} [${u.kind}] ${u.roots.map(root).join(", ")}`),
      ...f.units.ignored.map((r) => `ignored ${r}`),
    ],
    conventions: [
      ...f.conventions.guides.map((g) => `design doc ${g}`),
      ...f.conventions.style_guides.map((g) => `style guide ${g}`),
      ...f.conventions.agent_files.map((a) => `agent file ${a}`),
    ],
    enforced: [
      ...f.enforced.ci.map((c) => `CI ${c.system} — ${c.path}${c.name ? ` ("${c.name}")` : ""}`),
      ...ev("tool", f.enforced.linters),
    ],
    history:
      f.history.state === "ok"
        ? f.history.themes.map((t) => `theme ${t.title} [${t.source}] — ${t.summary}`)
        : [`themes: ${f.history.state === "absent" ? "none saved" : "UNKNOWN (unreadable)"}`],
    survey: f.survey ? [`survey ${f.survey.id}`] : ["survey: none completed"],
    scan: scanShape(f.scan ?? null),
    problems: [...f.problems],
  };
}

/** The scan section's shape: which scan, where open findings stand (severity
 * × lens per unit, no counts) and the hotspots. Nothing when never scanned. */
function scanShape(s: PortraitScan | null): string[] {
  if (s === null) return [];
  if (s.state === "unreadable") return ["scan: UNKNOWN (a scan record is unreadable)"];
  return [
    s.last ? `scan ${s.last.id} [${s.last.mode}, ${s.last.state}] at ${s.last.sha.slice(0, 12)}` : "scan: none finished",
    ...s.findings.units.filter((u) => u.open_by.length > 0).map((u) => `open in ${u.unit}: ${u.open_by.join(", ")}`),
    ...s.hotspots.map((h) => `hotspot ${h.unit} — ${h.text}`),
  ];
}

export function factsKey(f: PortraitFacts): string {
  const lines: Partial<Record<PortraitSection, string[]>> = shapeLines(f);
  // A portrait that never saw a scan keeps the key it had before the scan
  // section existed, so the upgrade alone never stales a narrative.
  if (lines.scan!.length === 0) delete lines.scan;
  return createHash("sha256").update(JSON.stringify(lines)).digest("hex").slice(0, 12);
}

export interface SectionDiff {
  section: PortraitSection;
  added: string[];
  removed: string[];
}

/** What changed between two versions of the facts, by section (only the
 * sections that did). */
export function factsDiff(before: PortraitFacts, after: PortraitFacts): SectionDiff[] {
  const a = shapeLines(before);
  const b = shapeLines(after);
  const out: SectionDiff[] = [];
  for (const section of PORTRAIT_SECTIONS) {
    const was = new Set(a[section]);
    const now = new Set(b[section]);
    const added = b[section].filter((l) => !was.has(l));
    const removed = a[section].filter((l) => !now.has(l));
    if (added.length > 0 || removed.length > 0) out.push({ section, added, removed });
  }
  return out;
}

export type FactsRead =
  | { state: "absent" }
  | { state: "unreadable"; error: string }
  | { state: "ok"; file: PortraitFactsFile };

function factsVersionError(v: unknown, at: string): string | null {
  if (v === null && at === "previous") return null;
  const o = (v ?? null) as Partial<FactsVersion> | null;
  if (o === null || typeof o !== "object") return `\`${at}\` is not a facts version`;
  if (typeof o.key !== "string" || typeof o.assembled_at !== "string" || typeof o.facts !== "object" || o.facts === null) {
    return `\`${at}\` is not {key, assembled_at, facts}`;
  }
  const f = o.facts as Partial<PortraitFacts>;
  for (const s of ["stack", "units", "conventions", "enforced", "history"] as const) {
    if (typeof f[s] !== "object" || f[s] === null) return `\`${at}.facts\` has no \`${s}\``;
  }
  if (!Array.isArray(f.problems)) return `\`${at}.facts\` has no \`problems\``;
  return null;
}

export function readPortraitFacts(fs: StateFs): FactsRead {
  let text: string | null;
  try {
    text = fs.read(PORTRAIT_FACTS_FILE);
  } catch (err) {
    return { state: "unreadable", error: `${PORTRAIT_FACTS_FILE} cannot be read: ${String(err)}` };
  }
  if (text === null) return { state: "absent" };
  try {
    const raw = JSON.parse(text) as Partial<PortraitFactsFile>;
    if (typeof raw !== "object" || raw === null || raw.version !== PORTRAIT_FACTS_VERSION) {
      throw new Error(`unknown version ${JSON.stringify((raw as { version?: unknown } | null)?.version)}`);
    }
    const bad = factsVersionError(raw.current, "current") ?? factsVersionError(raw.previous ?? null, "previous");
    if (bad !== null) throw new Error(bad);
    return { state: "ok", file: { version: PORTRAIT_FACTS_VERSION, current: raw.current!, previous: raw.previous ?? null } };
  } catch (err) {
    return {
      state: "unreadable",
      error: `${PORTRAIT_FACTS_FILE} is not portrait facts this version reads (${String(err)}) — nothing will overwrite it; move it aside to start over`,
    };
  }
}

export type AssembleResult =
  | {
      ok: true;
      current: FactsVersion;
      previous: FactsVersion | null;
      /** The facts' shape did not move: `current` was refreshed in place (its
       * counts and head), `previous` left as it was. */
      unchanged: boolean;
      /** Against `previous` — empty when there is none. */
      diff: SectionDiff[];
    }
  | { ok: false; errors: string[] };

/**
 * Store freshly assembled facts. A new SHAPE rotates the stored current into
 * `previous`; the same shape refreshes current in place, so re-assembling
 * after a commit never throws away the version the diff is against. A facts
 * file this version cannot read refuses rather than being replaced.
 */
export function saveFacts(fs: StateFs, facts: PortraitFacts, now: Date): AssembleResult {
  const prior = readPortraitFacts(fs);
  if (prior.state === "unreadable") return { ok: false, errors: [prior.error] };
  const current: FactsVersion = { key: factsKey(facts), assembled_at: now.toISOString(), facts };
  const before = prior.state === "ok" ? prior.file : null;
  const unchanged = before !== null && before.current.key === current.key;
  const previous = before === null ? null : unchanged ? before.previous : before.current;
  const file: PortraitFactsFile = { version: PORTRAIT_FACTS_VERSION, current, previous };
  try {
    fs.write(PORTRAIT_FACTS_FILE, `${JSON.stringify(file, null, 2)}\n`);
  } catch (err) {
    return { ok: false, errors: [`${PORTRAIT_FACTS_FILE} in ${fs.location} cannot be written: ${String(err)}`] };
  }
  return { ok: true, current, previous, unchanged, diff: previous ? factsDiff(previous.facts, facts) : [] };
}

// ---- the narrative -----------------------------------------------------------

export interface NarrativeDoc {
  /** The key of the facts it was written against; null for a file whose
   * header was edited away (the operator's hand) — its freshness is unknown. */
  facts_key: string | null;
  written_at: string | null;
  body: string;
}

const HEADER_RE = /^<!-- qcr repo portrait narrative · facts ([0-9a-f]{12}) at (\S+) · written (\S+) -->\n\n?/;

/** The file's text: one header line the engine writes, then the prose. */
export function renderNarrative(body: string, factsKey: string, head: string | null, writtenAt: string): string {
  return `<!-- qcr repo portrait narrative · facts ${factsKey} at ${head ? head.slice(0, 12) : "unknown-head"} · written ${writtenAt} -->\n\n${body}\n`;
}

export function parseNarrative(text: string): NarrativeDoc {
  const m = HEADER_RE.exec(text);
  if (!m) return { facts_key: null, written_at: null, body: text.trim() };
  return { facts_key: m[1]!, written_at: m[3]!, body: text.slice(m[0].length).trim() };
}

export type NarrativeRead =
  | { state: "absent" }
  | { state: "unreadable"; error: string }
  | { state: "ok"; doc: NarrativeDoc };

export function readNarrative(fs: StateFs, rel: string = NARRATIVE_FILE): NarrativeRead {
  try {
    const text = fs.read(rel);
    return text === null ? { state: "absent" } : { state: "ok", doc: parseNarrative(text) };
  } catch (err) {
    return { state: "unreadable", error: `${rel} in ${fs.location} cannot be read: ${String(err)}` };
  }
}

/**
 * A line diff, changed lines only (`+ ` added, `- ` removed), in order — an
 * LCS over lines. Past `maxCells` of work it says the text was replaced
 * rather than spending unbounded time on a page that was rewritten.
 */
export function lineDiff(before: string, after: string, maxCells = 4_000_000): string[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length * b.length > maxCells) return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)];
  // lcs[i][j] = LCS length of a[i..] and b[j..].
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i++]}`);
    } else {
      out.push(`+ ${b[j++]}`);
    }
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out;
}

export interface NarrativeDeps {
  state: StateFs;
  /** The config home; null when this assembly has none. */
  config: StateFs | null;
  clock: () => Date;
}

export type StoreNarrativeResult =
  | {
      ok: true;
      facts_key: string;
      written_at: string;
      /** A different narrative was there and is now `narrative.previous.md`. */
      replaced: boolean;
      /** Byte-for-byte the stored one, against the same facts: nothing written. */
      unchanged: boolean;
      /** Against the narrative it replaced (empty when none, or unchanged). */
      diff: string[];
    }
  | { ok: false; errors: string[] };

/**
 * Store the companion's narrative against the facts it read. Refused when:
 * there is no config home, no facts have been assembled, `facts_key` is not
 * the current facts' key (they moved since it read them — read again), the
 * text is empty or over NARRATIVE_MAX, it quotes a raw review comment or
 * names its author, or a narrative file is in the way that cannot be read.
 * The narrative it replaces becomes `narrative.previous.md`.
 */
export function storeNarrative(deps: NarrativeDeps, raw: { facts_key?: unknown; narrative?: unknown }): StoreNarrativeResult {
  if (deps.config === null) {
    return { ok: false, errors: ["no config home in this assembly — the narrative has nowhere to live"] };
  }
  const facts = readPortraitFacts(deps.state);
  if (facts.state === "absent") return { ok: false, errors: ["no portrait facts yet — assemble them first, then write the narrative from them"] };
  if (facts.state === "unreadable") return { ok: false, errors: [facts.error] };
  const errors: string[] = [];
  const key = facts.file.current.key;
  if (typeof raw.facts_key !== "string" || raw.facts_key.trim() === "") {
    errors.push("no `facts_key` — quote the key of the facts the narrative was written from");
  } else if (raw.facts_key.trim() !== key) {
    errors.push(`the facts changed since that key (now ${key}) — read the portrait again and write from what it says now`);
  }
  const body = typeof raw.narrative === "string" ? raw.narrative.replace(/\r\n?/g, "\n").trim() : "";
  if (body === "") errors.push("`narrative` must be non-empty prose");
  else if (body.length > NARRATIVE_MAX) errors.push(`the narrative is ${body.length} characters — at most ${NARRATIVE_MAX}; it is a page, not a report`);
  if (body.startsWith("<!--")) errors.push("start with prose, not a comment — the header line is the tool's to write");
  if (errors.length > 0) return { ok: false, errors };

  const digest = readDigest(deps.state);
  if (digest.state === "unreadable") {
    return { ok: false, errors: [`${digest.error} — the narrative cannot be checked for raw review comments until it is pulled again`] };
  }
  if (digest.state === "ok") {
    const leaks = leakChecker(digest.digest)(body);
    if (leaks.length > 0) return { ok: false, errors: leaks.map((l) => `the narrative ${l}`) };
  }

  const prior = readNarrative(deps.config);
  if (prior.state === "unreadable") return { ok: false, errors: [`${prior.error} — nothing will overwrite it`] };
  const writtenAt = deps.clock().toISOString();
  if (prior.state === "ok" && prior.doc.body === body && prior.doc.facts_key === key) {
    return { ok: true, facts_key: key, written_at: prior.doc.written_at ?? writtenAt, replaced: false, unchanged: true, diff: [] };
  }
  const text = renderNarrative(body, key, facts.file.current.facts.head, writtenAt);
  let replaced = false;
  let diff: string[] = [];
  try {
    if (prior.state === "ok") {
      // Only a DIFFERENT reading displaces the kept one: re-storing the same
      // prose against moved facts must not overwrite the version a diff needs.
      if (prior.doc.body !== body) {
        deps.config.write(NARRATIVE_PREVIOUS_FILE, deps.config.read(NARRATIVE_FILE) ?? "");
        replaced = true;
        diff = lineDiff(prior.doc.body, body);
      }
    }
    deps.config.write(NARRATIVE_FILE, text);
  } catch (err) {
    // The config home is only partly mounted in the companion: a missing or
    // read-only `portrait/` is a refusal naming the cause, never a throw.
    return {
      ok: false,
      errors: [
        `${replaced ? NARRATIVE_FILE : `${NARRATIVE_PREVIOUS_FILE} or ${NARRATIVE_FILE}`} in ${deps.config.location} cannot be written: ${String(err)}` +
          (replaced ? ` — the narrative it would replace is already kept as ${NARRATIVE_PREVIOUS_FILE}` : ""),
      ],
    };
  }
  return { ok: true, facts_key: key, written_at: writtenAt, replaced, unchanged: false, diff };
}

// ---- the portrait, read back -------------------------------------------------

export interface PortraitView {
  facts: FactsRead;
  narrative: NarrativeRead | { state: "no-config-home" };
  /** The narrative was written against other facts than the current ones
   * (null when there is no narrative, or its freshness is unknown). */
  stale: boolean | null;
  has_previous_narrative: boolean;
  /** The kept previous narrative exists but cannot be read — UNKNOWN, never
   * "none kept". */
  previous_narrative_error: string | null;
  /** Only when asked for. */
  facts_diff: SectionDiff[] | null;
  narrative_diff: string[] | null;
}

/** The stored portrait as it is — nothing reassembled. */
export function readPortrait(deps: NarrativeDeps, opts: { diff?: boolean } = {}): PortraitView {
  const facts = readPortraitFacts(deps.state);
  const narrative = deps.config === null ? ({ state: "no-config-home" } as const) : readNarrative(deps.config);
  const previous = deps.config === null ? ({ state: "absent" } as const) : readNarrative(deps.config, NARRATIVE_PREVIOUS_FILE);
  const stale =
    narrative.state === "ok" && facts.state === "ok" && narrative.doc.facts_key !== null
      ? narrative.doc.facts_key !== facts.file.current.key
      : null;
  let factsDiffOut: SectionDiff[] | null = null;
  let narrativeDiff: string[] | null = null;
  if (opts.diff) {
    factsDiffOut = facts.state === "ok" && facts.file.previous ? factsDiff(facts.file.previous.facts, facts.file.current.facts) : [];
    narrativeDiff = narrative.state === "ok" && previous.state === "ok" ? lineDiff(previous.doc.body, narrative.doc.body) : [];
  }
  return {
    facts,
    narrative,
    stale,
    has_previous_narrative: previous.state === "ok",
    previous_narrative_error: previous.state === "unreadable" ? previous.error : null,
    facts_diff: factsDiffOut,
    narrative_diff: narrativeDiff,
  };
}
