// Review history, the companion's half (setup & scan spec "Review
// history"). The VM prints a digest of what past reviews said
// (`src/reviewhistory.ts`), the PC writes it into the state home
// (`src/tui/historypull.ts`), and here the companion reads it and hands back
// THEMES — the recurring things this team asks for in review, in the
// companion's own words.
//
// The boundary this module exists for: the raw comments are colleagues' names
// and words, and they never leave the state home. The companion may read them
// (that is how it condenses), but what goes onward — to reviewer memory as
// `#history` entries, and to the repo portrait through `readHistoryThemes` —
// is only the validated theme list. A theme that quotes a raw comment (eight
// words running) or names a comment's author is REFUSED, with the reason, so
// the companion rewrites it; nothing is silently trimmed into something the
// companion did not say. The quote check is a belt, not a proof: a paraphrase
// close enough to be a quote in all but word order gets through, and the
// companion's prompt carries the rule too.
//
// Persistence: `<state home>/setup/history-themes.json` — the saved themes and
// the ones they replaced. Memory: a save RETIRES the earlier unpinned
// `#history` entries and writes the new ones, so a re-run supersedes rather
// than piles up (the survey's rule); a pinned or `#manual` one is the
// operator's and is left alone.
import { refOf, type MemoryStore } from "../memory/store.js";
import { parseDigest, type ReviewHistoryDigest } from "../reviewhistory.js";
import type { StateFs } from "./engine.js";

/** The digest's place in the state home — `historypull.ts` writes it here. */
export const HISTORY_DIGEST_FILE = "setup/review-history.json";
export const HISTORY_THEMES_FILE = "setup/history-themes.json";
export const HISTORY_THEMES_VERSION = 1;
export const HISTORY_TAG = "history";

/** One save carries at most this many themes — the scan's pattern cap. */
export const MAX_THEMES = 20;
export const THEME_TITLE_MAX = 80;
export const THEME_SUMMARY_MAX = 400;
/** A theme sharing this many consecutive words with a raw comment quotes it. */
export const QUOTE_WORDS = 8;
/** A page of raw items the companion reads at a time. */
export const HISTORY_PAGE_MAX = 200;

export const THEME_SOURCES = ["human", "bot", "feedback", "mixed"] as const;
export type ThemeSource = (typeof THEME_SOURCES)[number];

export interface HistoryTheme {
  title: string;
  summary: string;
  /** Which half of the history shows it: human reviewers, the daemon's own
   * rounds, `[feedback]`, or more than one. */
  source: ThemeSource;
  /** How many items the companion counted behind it. */
  weight: number;
}

export interface HistoryThemesFile {
  version: number;
  saved_at: string;
  repo: string;
  /** Which digest the themes were condensed from. */
  digest_generated_at: string;
  themes: HistoryTheme[];
  previous: { saved_at: string; themes: HistoryTheme[] } | null;
}

export type DigestRead =
  | { state: "absent" }
  | { state: "unreadable"; error: string }
  | { state: "ok"; digest: ReviewHistoryDigest };

/** The digest in the state home, if there is one this version reads. */
export function readDigest(fs: StateFs): DigestRead {
  let text: string | null;
  try {
    text = fs.read(HISTORY_DIGEST_FILE);
  } catch (err) {
    return { state: "unreadable", error: `${HISTORY_DIGEST_FILE} cannot be read: ${String(err)}` };
  }
  if (text === null) return { state: "absent" };
  const p = parseDigest(text);
  return p.ok ? { state: "ok", digest: p.digest } : { state: "unreadable", error: `${HISTORY_DIGEST_FILE}: ${p.error}` };
}

// ---- the companion's view ------------------------------------------------------

export type HistorySection = "human" | "rounds" | "feedback";

export interface HistorySummary {
  repo: string;
  generated_at: string;
  since: string;
  months: number;
  human_comments: number;
  prs_scanned: number;
  prs_enumerated: number;
  truncated: boolean;
  rounds: number;
  feedback: number;
  problems: string[];
  /** Nothing in any half — a repo with no merged-PR reviews, rounds or feedback. */
  empty: boolean;
}

export function summarize(d: ReviewHistoryDigest): HistorySummary {
  return {
    repo: d.repo,
    generated_at: d.generated_at,
    since: d.window.since,
    months: d.window.months,
    human_comments: d.human.comments.length,
    prs_scanned: d.human.prs_scanned,
    prs_enumerated: d.human.prs_enumerated,
    truncated: d.human.truncated,
    rounds: d.rounds.length,
    feedback: d.feedback.length,
    problems: d.problems,
    empty: d.human.comments.length === 0 && d.rounds.length === 0 && d.feedback.length === 0,
  };
}

/** One page of one half, rendered as lines the companion reads in context.
 * Raw text, by design: this is the condensing step, inside the state home's
 * boundary. */
export function historyPage(
  d: ReviewHistoryDigest,
  section: HistorySection,
  offset: number,
  limit: number,
): { total: number; offset: number; lines: string[] } {
  const lim = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(limit)));
  const off = Math.max(0, Math.floor(offset));
  const one = (s: string | null): string => (s ?? "").replace(/\s+/g, " ").trim();
  let all: string[];
  if (section === "human") {
    all = d.human.comments.map(
      (c) => `#${c.pr} ${c.kind}${c.path ? ` ${c.path}` : ""} [${c.state}] @${c.author}: ${one(c.body)}`,
    );
  } else if (section === "rounds") {
    all = d.rounds.map(
      (r) => `#${r.pr} round ${r.round_no}${r.backfilled ? " (imported)" : ""} ${r.verdict ?? "—"} ${r.finished_at ?? ""}: ${one(r.summary) || "(no summary)"}`,
    );
  } else {
    all = d.feedback.map((f) => `#${f.pr} ${f.kind} ${f.created_at}${f.author ? ` @${f.author}` : ""}: ${one(f.body) || "(no text)"}`);
  }
  return { total: all.length, offset: off, lines: all.slice(off, off + lim) };
}

// ---- themes: validation and the leak belt ------------------------------------

export type ThemeRefusal = { ok: false; errors: string[] };

const words = (t: string): string[] =>
  t
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((w) => w !== "");

/** The raw human text of a digest — what must not travel. Round summaries are
 * the daemon's own prose, not a colleague's, and are not in here. */
function rawTexts(d: ReviewHistoryDigest): string[] {
  return [...d.human.comments.map((c) => c.body), ...d.feedback.map((f) => f.body ?? "")];
}

function authorsOf(d: ReviewHistoryDigest): Set<string> {
  const out = new Set<string>();
  for (const c of d.human.comments) out.add(c.author.toLowerCase());
  for (const f of d.feedback) if (f.author) out.add(f.author.toLowerCase());
  out.delete("");
  return out;
}

/**
 * What a theme's text gives away, or [] when it gives nothing: a run of
 * QUOTE_WORDS words out of any raw comment, or a comment author's login —
 * `@login` always, and the bare login when it cannot pass for an ordinary word
 * (four characters or more, or carrying a digit or a hyphen).
 */
export function leakChecker(d: ReviewHistoryDigest): (text: string) => string[] {
  const shingles = new Set<string>();
  for (const raw of rawTexts(d)) {
    const w = words(raw);
    for (let i = 0; i + QUOTE_WORDS <= w.length; i++) shingles.add(w.slice(i, i + QUOTE_WORDS).join(" "));
  }
  const authors = authorsOf(d);
  return (text) => {
    const out: string[] = [];
    const tw = words(text);
    for (let i = 0; i + QUOTE_WORDS <= tw.length; i++) {
      const s = tw.slice(i, i + QUOTE_WORDS).join(" ");
      if (shingles.has(s)) {
        out.push(`quotes a raw review comment ("${s}…") — say it in your own words`);
        break;
      }
    }
    const lower = text.toLowerCase();
    const tokens = new Set(lower.split(/[^a-z0-9_-]+/).filter(Boolean));
    for (const login of authors) {
      const distinctive = login.length >= 4 || /[\d-]/.test(login);
      if (lower.includes(`@${login}`) || (distinctive && tokens.has(login))) {
        out.push(`names a comment author (${login}) — themes are about the code, not who said it`);
      }
    }
    return out;
  };
}

/** One-shot form of `leakChecker`. */
export function leaksIn(text: string, d: ReviewHistoryDigest): string[] {
  return leakChecker(d)(text);
}

/** Strict: the companion's list, or every reason it is not one. */
export function normalizeThemes(raw: unknown): { ok: true; themes: HistoryTheme[] } | ThemeRefusal {
  if (!Array.isArray(raw)) return { ok: false, errors: ["`themes` must be an array (empty is allowed: an empty history has none)"] };
  const errors: string[] = [];
  if (raw.length > MAX_THEMES) errors.push(`at most ${MAX_THEMES} themes per save (got ${raw.length}) — merge the smaller ones`);
  const themes: HistoryTheme[] = [];
  for (const [i, t] of raw.entries()) {
    const o = (t ?? {}) as Record<string, unknown>;
    const title = typeof o.title === "string" ? o.title.trim() : "";
    const summary = typeof o.summary === "string" ? o.summary.trim() : "";
    const source = o.source;
    const weight = typeof o.weight === "string" && /^\d+$/.test(o.weight) ? Number(o.weight) : o.weight;
    const at = `themes[${i}]`;
    if (title === "" || title.length > THEME_TITLE_MAX) errors.push(`${at}.title must be 1..${THEME_TITLE_MAX} characters`);
    if (summary === "" || summary.length > THEME_SUMMARY_MAX) errors.push(`${at}.summary must be 1..${THEME_SUMMARY_MAX} characters`);
    if (/[\r\n]/.test(title) || /[\r\n]/.test(summary)) errors.push(`${at}: one line each — no newlines`);
    if (title.startsWith("#") || summary.startsWith("#")) errors.push(`${at}: must not start with '#' (tags are the tool's to write)`);
    if (typeof source !== "string" || !(THEME_SOURCES as readonly string[]).includes(source)) {
      errors.push(`${at}.source must be one of ${THEME_SOURCES.join(" | ")}`);
    }
    if (typeof weight !== "number" || !Number.isInteger(weight) || weight < 1) errors.push(`${at}.weight must be a positive integer (items behind it)`);
    themes.push({ title, summary, source: source as ThemeSource, weight: weight as number });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, themes };
}

/** The one memory entry text a theme becomes. The header is ours (`#history`
 * then `k=v`), and the fixed word `Theme:` ends it, so nothing the companion
 * wrote can extend the header into a tag (`src/memory/eventtags.ts`). */
export function themeEntryText(t: HistoryTheme): string {
  return `#${HISTORY_TAG} source=${t.source} weight=${t.weight} Theme: ${t.title} — ${t.summary}`;
}

// ---- save & read -----------------------------------------------------------------

export interface MemoryOutcome {
  written: number;
  retired: number;
  /** Why memory was not (fully) written — the themes are saved regardless. */
  problems: string[];
}

export interface SaveThemesDeps {
  state: StateFs;
  memory: MemoryStore | null;
  clock: () => Date;
}

export type SaveThemesResult = { ok: true; themes: HistoryTheme[]; memory: MemoryOutcome } | ThemeRefusal;

function readThemesFile(fs: StateFs): { file: HistoryThemesFile | null; error: string | null } {
  let text: string | null;
  try {
    text = fs.read(HISTORY_THEMES_FILE);
  } catch (err) {
    return { file: null, error: `${HISTORY_THEMES_FILE} cannot be read: ${String(err)}` };
  }
  if (text === null) return { file: null, error: null };
  try {
    const f = JSON.parse(text) as HistoryThemesFile;
    if (f.version !== HISTORY_THEMES_VERSION || !Array.isArray(f.themes)) throw new Error("not a themes file this version reads");
    const n = normalizeThemes(f.themes);
    if (!n.ok) throw new Error(n.errors.join("; "));
    return { file: { ...f, themes: n.themes }, error: null };
  } catch (err) {
    return { file: null, error: `${HISTORY_THEMES_FILE}: ${String(err)} — nothing will overwrite it; move it aside to start over` };
  }
}

/**
 * Save the companion's themes: validated, checked against the digest they came
 * from for anything raw, then written to the state home and — when this
 * assembly has memory — to reviewer memory as `#history` entries, replacing
 * the earlier unpinned ones. Refused outright when there is no digest to have
 * condensed from, or a themes file this version cannot read is in the way.
 */
export async function saveHistoryThemes(deps: SaveThemesDeps, raw: unknown): Promise<SaveThemesResult> {
  const read = readDigest(deps.state);
  if (read.state === "absent") {
    return { ok: false, errors: ["no review history digest in the state home yet — the owner runs `qcr history pull` to fetch one"] };
  }
  if (read.state === "unreadable") return { ok: false, errors: [read.error] };
  const n = normalizeThemes(raw);
  if (!n.ok) return n;
  const leaksOf = leakChecker(read.digest);
  const leaks = n.themes.flatMap((t, i) => leaksOf(`${t.title} ${t.summary}`).map((l) => `themes[${i}] ${l}`));
  if (leaks.length > 0) return { ok: false, errors: leaks };
  const prior = readThemesFile(deps.state);
  if (prior.error !== null) return { ok: false, errors: [prior.error] };

  const file: HistoryThemesFile = {
    version: HISTORY_THEMES_VERSION,
    saved_at: deps.clock().toISOString(),
    repo: read.digest.repo,
    digest_generated_at: read.digest.generated_at,
    themes: n.themes,
    previous: prior.file ? { saved_at: prior.file.saved_at, themes: prior.file.themes } : null,
  };
  deps.state.write(HISTORY_THEMES_FILE, `${JSON.stringify(file, null, 2)}\n`);

  const memory: MemoryOutcome = { written: 0, retired: 0, problems: [] };
  if (deps.memory === null) {
    memory.problems.push("no reviewer memory in this assembly — themes saved to the state home only");
    return { ok: true, themes: n.themes, memory };
  }
  try {
    const old = await deps.memory.search("", { tag: HISTORY_TAG });
    for (const e of old) {
      if (e.pinned || e.tags.some((t) => t.toLowerCase() === "manual")) continue;
      const r = await deps.memory.apply({ op: "retire", ...refOf(e) });
      if (r.ok) memory.retired++;
      else memory.problems.push(`could not retire an earlier #${HISTORY_TAG} entry: ${r.message}`);
    }
    for (const t of n.themes) {
      const r = await deps.memory.apply({ op: "note", text: themeEntryText(t) });
      if (r.ok) memory.written++;
      else memory.problems.push(`could not write "${t.title}": ${r.message}`);
    }
  } catch (err) {
    memory.problems.push(`memory unreachable: ${String(err)}`);
  }
  return { ok: true, themes: n.themes, memory };
}

/**
 * The saved themes — the ONLY thing about review history the repo portrait
 * reads, never the digest. Null when none are saved or the file
 * cannot be read.
 */
export function readHistoryThemes(fs: StateFs): HistoryThemesFile | null {
  return readThemesFile(fs).file;
}
