// The private tokens a public file must never carry. The repository ships
// none of them, not even as digests: the list is read at run time from a
// file outside the repository, which only the maintainers hold.
//
// The file: the path in $QCR_PUBLISH_DENYLIST, else
// ~/.config/qcr/publish-denylist.txt. One token per line; blank lines and
// `#` comment lines are skipped. A line is `[kind:]token [label]`:
//   - `word:` (the default): a text "carries" it when one of its words (a
//     run of letters, digits and dashes, lower-cased), or a run of the word's
//     dash-separated parts, equals the token. The optional label is what a
//     hit is reported under, and what an ALLOWLIST entry grants;
//   - `user:`: the user segment of `/home/<u>/` or `-home-<u>-`;
//   - `host:`: a dotted host name (`a.b.c`), matched in its subdomains too.
//
// When the file is absent (public CI, a contributor's checkout) the
// private-token checks skip with PRIVATE_SKIP as the reason. A set
// $QCR_PUBLISH_DENYLIST naming a missing file is an error, never a skip.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DENYLIST_ENV = "QCR_PUBLISH_DENYLIST";
export const WORD_LABEL = "a private word";
export const HOME_LABEL = "the operator's home directory";
export const HOST_LABEL = "a private host name";

export interface TokenTables {
  /** Word → the label a hit is reported under. */
  words: ReadonlyMap<string, string>;
  homeUsers: ReadonlySet<string>;
  hosts: ReadonlySet<string>;
}

/** Where the denylist is read from. */
export function denylistPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[DENYLIST_ENV] || join(homedir(), ".config", "qcr", "publish-denylist.txt");
}

const SHAPES: Record<string, RegExp> = {
  word: /^[a-z0-9][a-z0-9-]*$/,
  user: /^[a-z0-9._-]+$/,
  host: /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/,
};

/** Parse a denylist's text. A malformed line throws, naming its number only. */
export function parseDenylist(text: string): TokenTables {
  const words = new Map<string, string>();
  const homeUsers = new Set<string>();
  const hosts = new Set<string>();
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const m = /^(?:(word|user|host):)?(\S+)(?:\s+(.*))?$/.exec(line);
    const kind = m?.[1] ?? "word";
    const token = m?.[2]?.toLowerCase() ?? "";
    if (!m || !SHAPES[kind]!.test(token))
      throw new Error(`publish denylist line ${i + 1}: not a well-formed ${kind} token`);
    if (kind === "word") words.set(token, m[3]?.trim() || WORD_LABEL);
    else if (kind === "user") homeUsers.add(token);
    else hosts.add(token);
  });
  return { words, homeUsers, hosts };
}

/** The denylist at `path`, or null when there is none. */
export function loadDenylist(path: string): TokenTables | null {
  if (!existsSync(path)) return null;
  return parseDenylist(readFileSync(path, "utf8"));
}

function loadDefault(): TokenTables | null {
  const path = denylistPath();
  const tables = loadDenylist(path);
  if (!tables && process.env[DENYLIST_ENV])
    throw new Error(`${DENYLIST_ENV} names a missing file: ${path}`);
  return tables;
}

/** The maintainers' tables, or null when no denylist is present. */
export const PRIVATE_TOKENS: TokenTables | null = loadDefault();

/** The skip reason of every check that needs the private list. */
export const PRIVATE_SKIP = `no publish denylist (set ${DENYLIST_ENV} or create ~/.config/qcr/publish-denylist.txt)`;

export interface TokenHit {
  /** 1-based line. */
  line: number;
  /** What kind of private token it is; the token itself is never named. */
  label: string;
}

const WORD = /[a-z0-9][a-z0-9-]*/g;
const HOME = /\/home\/([a-z0-9._-]+)|-home-([a-z0-9]+)-/g;
const DOTTED = /[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+/g;

/**
 * The private tokens a text carries, one hit per (line, label). With no
 * tables (no denylist present) it finds nothing; the caller skips.
 */
export function privateTokenHits(
  text: string,
  tables: TokenTables | null = PRIVATE_TOKENS,
): TokenHit[] {
  if (!tables) return [];
  const hits: TokenHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.toLowerCase();
    const labels = new Set<string>();
    for (const [w] of line.matchAll(WORD)) {
      // The word and every run of its dash-separated parts: `a-b-c` is
      // checked as `a-b-c`, `a-b`, `b-c`, `a`, `b` and `c`.
      const parts = w.split("-");
      for (let from = 0; from < parts.length; from++) {
        for (let to = from + 1; to <= parts.length; to++) {
          const run = parts.slice(from, to).join("-");
          const label = run ? tables.words.get(run) : undefined;
          if (label) labels.add(label);
        }
      }
    }
    for (const m of line.matchAll(HOME)) {
      if (tables.homeUsers.has((m[1] ?? m[2])!)) labels.add(HOME_LABEL);
    }
    for (const [host] of line.matchAll(DOTTED)) {
      // The host itself and every parent domain: `a.b.example.com` carries
      // `b.example.com` too.
      const parts = host.split(".");
      for (let k = 0; k < parts.length - 1; k++)
        if (tables.hosts.has(parts.slice(k).join("."))) labels.add(HOST_LABEL);
    }
    for (const label of labels) hits.push({ line: i + 1, label });
  }
  return hits;
}

/** The 1-based line numbers of `text` that carry any private token. */
export function privateHandleLines(text: string): number[] {
  return [...new Set(privateTokenHits(text).map((h) => h.line))];
}
