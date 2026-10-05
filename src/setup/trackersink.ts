// The TRACKER SINK (FT-0463; setup & scan spec "Findings"): where a promoted
// scan finding goes, and how its ticket is closed when a re-scan finds it
// fixed. Two implementations of the engine's `TrackerSink` port:
//
//   * THE ISSUE TRACKER (`issueTrackerSink`), mounted rw at `/tracker` in the
//     companion. It writes as actor `companion` under the tracker's own
//     protocol (`/tracker-docs/issue-tracker.md`): a new id by exclusive
//     create of `.ids/<NNNN>`, the ticket file created exclusively, and every
//     rewrite of an existing ticket under the edit lock `.locks/FT-<id>`. Its
//     rights are rule 8's third amendment: FILE a ticket in any effort, CLOSE
//     only a ticket it filed (`Created: … by companion`) — never one somebody
//     has claimed, never anyone else's.
//   * MARKDOWN FILES (`markdownFindingSink`), one per finding under
//     `<state home>/scan/promoted/`, for an install with no issue tracker —
//     the operator moves them into whatever they use.
//
// NEVER FILED TWICE, twice over: the findings store's ticket record is the
// first guard (triage.ts never asks a sink to file a finding that has one);
// the fingerprint STAMP each ticket carries (`Scan-fingerprint:`, one line
// per fingerprint the finding has had) is the backstop — a crash between the
// sink's write and the store's is answered with the ticket already there,
// never a second one.
//
// Every method resolves; a refusal is `{ok:false, reason}`, never a throw.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SinkResult, StateFs, TrackerSink, TrackerTicket } from "./engine.js";

/** The stamp line — one per fingerprint the finding has carried. */
export const FINGERPRINT_LINE = "Scan-fingerprint:";

/** A tracker edit lock older than this is stale (the protocol's 10 minutes). */
export const STALE_LOCK_MS = 10 * 60 * 1000;

/** Where the markdown sink writes, inside the state home. */
export const PROMOTED_DIR = "scan/promoted";

const EFFORT_RE = /^[a-z0-9][a-z0-9._-]*$/;
const CLOSED_STATUSES = new Set(["resolved", "wontfix", "out-of-scope"]);

const clean = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function slugify(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "")
    .slice(0, 6);
  return words.join("-") || "scan-finding";
}

function stamps(t: TrackerTicket): string[] {
  return [...new Set([t.fingerprint, ...(t.aliases ?? [])])];
}

function stampLines(t: TrackerTicket): string {
  return stamps(t)
    .map((fp) => `${FINGERPRINT_LINE} ${fp}`)
    .join("\n");
}

/** The ticket body with any line that would read as a stamp defused: the
 * body quotes the scanned code and the model's words, and a quoted
 * `Scan-fingerprint:` line would otherwise make this ticket answer for
 * another finding — which would then never be filed. */
function safeBody(body: string): string {
  return body
    .trimEnd()
    .replace(new RegExp(`^(\\s*)${FINGERPRINT_LINE}`, "gm"), "$1(quoted) Scan-fingerprint:");
}

/** The fingerprints a ticket's text is stamped with. */
export function stampedFingerprints(text: string): string[] {
  return [...text.matchAll(new RegExp(`^${FINGERPRINT_LINE} ([0-9a-f]+)\\s*$`, "gm"))].map(
    (m) => m[1]!,
  );
}

/** One header field's value (`Key: value`), or null. */
function field(text: string, key: string): string | null {
  const m = new RegExp(`^${key}: (.*)$`, "m").exec(text);
  return m ? m[1]!.trim() : null;
}

function setField(text: string, key: string, value: string): string {
  return text.replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${value}`);
}

// ---- the issue tracker ------------------------------------------------------------

export interface IssueTrackerOptions {
  /** The tracker root (`QCR_TRACKER_DIR`, `/tracker` in the companion). */
  root: string;
  clock: () => Date;
  /** The actor written on tickets and lock lines. */
  actor?: string;
  /** The session discriminator on lock lines (`<actor>@<session>`). */
  session?: string;
}

/** Does `root` look like an issue tracker (`.ids/` and `efforts/`)? */
export function isIssueTracker(root: string | undefined): boolean {
  if (!root) return false;
  try {
    return (
      statSync(join(root, ".ids")).isDirectory() && statSync(join(root, "efforts")).isDirectory()
    );
  } catch {
    return false;
  }
}

export function issueTrackerSink(opts: IssueTrackerOptions): TrackerSink {
  const root = opts.root;
  const actor = opts.actor ?? "companion";
  const who = `${actor}@${opts.session ?? `scan-${process.pid}`}`;
  const now = (): string =>
    opts
      .clock()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z");

  const efforts = (): string[] => {
    try {
      return readdirSync(join(root, "efforts"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  };

  /** Every ticket file, live and archived: `[path, text]`. */
  const tickets = function* (): Generator<[string, string]> {
    for (const e of efforts()) {
      for (const dir of [
        join(root, "efforts", e, "tickets"),
        join(root, "efforts", e, "tickets", "archive"),
      ]) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        for (const n of names) {
          if (!n.endsWith(".md")) continue;
          const p = join(dir, n);
          try {
            yield [p, readFileSync(p, "utf8")];
          } catch {
            /* mid-rename or unreadable: not a stamp we can see */
          }
        }
      }
    }
  };

  /** The effort's map id — a ticket's `Parent:` (the placement lint wants
   * one everywhere but the `inbox` effort). */
  const mapId = (effort: string): string | null => {
    try {
      return field(readFileSync(join(root, "efforts", effort, "map.md"), "utf8"), "Id");
    } catch {
      return null;
    }
  };

  /** Claim the next free id by exclusive create of `.ids/<NNNN>` (the
   * tracker's one allocation mechanism, as `tui/autofile.ts` claims one). */
  const claimId = (relPath: (n: string) => string): string => {
    const idsDir = join(root, ".ids");
    const taken = readdirSync(idsDir)
      .filter((f) => /^\d{4,}$/.test(f))
      .map(Number);
    let candidate = (taken.length > 0 ? Math.max(...taken) : 0) + 1;
    for (let tries = 0; tries < 50; tries++, candidate++) {
      const n = String(candidate).padStart(4, "0");
      try {
        const fd = openSync(join(idsDir, n), "wx");
        writeFileSync(fd, `${relPath(n)}\n`);
        closeSync(fd);
        return n;
      } catch {
        /* raced by another claimer — the next number */
      }
    }
    throw new Error("could not claim a tracker id (50 collisions)");
  };

  const findTicket = (ref: string): string | null => {
    const m = /^FT-(\d{4,})$/.exec(ref);
    if (!m) return null;
    for (const e of efforts()) {
      for (const dir of [
        join(root, "efforts", e, "tickets"),
        join(root, "efforts", e, "tickets", "archive"),
      ]) {
        let names: string[];
        try {
          names = readdirSync(dir);
        } catch {
          continue;
        }
        const hit = names.find((n) => n.startsWith(`${ref}-`) && n.endsWith(".md"));
        if (hit) return join(dir, hit);
      }
    }
    return null;
  };

  /** Take the edit lock (stale ones broken), run `fn`, release. */
  const withLock = (id: string, fn: () => SinkResult): SinkResult => {
    const lock = join(root, ".locks", `FT-${id}`);
    mkdirSync(join(root, ".locks"), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, "wx");
        writeFileSync(fd, `${who} ${now()}\n`);
        closeSync(fd);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST")
          return { ok: false, reason: `cannot take the edit lock for FT-${id}: ${clean(err)}` };
        let age = 0;
        try {
          age = Date.now() - statSync(lock).mtimeMs; // mtime is wall time, never the injected clock
        } catch {
          continue; // released between the two calls — try again
        }
        if (age > STALE_LOCK_MS && attempt === 0) {
          rmSync(lock, { force: true });
          continue;
        }
        return {
          ok: false,
          reason: `FT-${id} is being edited by someone else (its edit lock is held) — the next close retries`,
        };
      }
      try {
        return fn();
      } finally {
        rmSync(lock, { force: true });
      }
    }
    return { ok: false, reason: `could not take the edit lock for FT-${id}` };
  };

  return {
    kind: "tracker",
    file: async (t) => {
      try {
        if (!isIssueTracker(root)) return { ok: false, reason: `no issue tracker at ${root}` };
        const known = efforts();
        if (!EFFORT_RE.test(t.effort) || !known.includes(t.effort)) {
          return {
            ok: false,
            reason: `effort ${JSON.stringify(t.effort)} does not exist on the tracker — pick the one that fits: ${known.join(", ")}`,
          };
        }
        const parent = mapId(t.effort);
        if (parent === null && t.effort !== "inbox") {
          return {
            ok: false,
            reason: `effort ${t.effort} has no map to parent the ticket under — pick an effort with a map, or \`inbox\``,
          };
        }
        // The backstop: a ticket already stamped with any of the finding's
        // fingerprints is this finding's.
        const want = new Set(stamps(t));
        for (const [, text] of tickets()) {
          if (stampedFingerprints(text).some((fp) => want.has(fp))) {
            const id = field(text, "Id");
            if (id) return { ok: true, ref: id, existing: true };
          }
        }
        const slug = slugify(t.title);
        const rel = (n: string): string => `efforts/${t.effort}/tickets/FT-${n}-${slug}.md`;
        const n = claimId(rel);
        const ts = now();
        const title = t.title.replace(/[\r\n]+/g, " ").trim();
        const content = [
          `# ${title}`,
          "",
          `Id: FT-${n}`,
          `Effort: ${t.effort}`,
          "Type: impl",
          "Status: open",
          "Role: —",
          `Category: ${t.category ?? "bug"}`,
          "Labels: scan-finding",
          "Assignee: —",
          "Blocked-by: —",
          `Parent: ${parent ?? "—"}`,
          "Spec: —",
          "Dispatch: —",
          "Branch: —",
          "PR: —",
          `Created: ${ts} by ${actor}`,
          `Updated: ${ts}`,
          "Claimed: —",
          "Closed: —",
          "",
          safeBody(t.body),
          "",
          stampLines(t),
          "",
          "## Comments",
          "",
        ].join("\n");
        // An effort may have a map and no ticket yet: its tickets/ is made
        // here, or the claimed id would point at a file never written.
        mkdirSync(join(root, "efforts", t.effort, "tickets"), { recursive: true });
        const fd = openSync(join(root, rel(n)), "wx");
        writeFileSync(fd, content);
        closeSync(fd);
        return { ok: true, ref: `FT-${n}` };
      } catch (err) {
        return { ok: false, reason: `the tracker refused the ticket: ${clean(err)}` };
      }
    },
    close: async (ref, note) => {
      try {
        const path = findTicket(ref);
        if (path === null)
          return { ok: false, reason: `no ticket ${ref} on the tracker at ${root}` };
        const id = ref.slice(3);
        return withLock(id, () => {
          const text = readFileSync(path, "utf8");
          const created = field(text, "Created") ?? "";
          if (!new RegExp(`\\bby ${actor}$`).test(created)) {
            return {
              ok: false,
              reason: `${ref} was not filed by ${actor} — only the ones it filed are closed`,
            };
          }
          const status = field(text, "Status") ?? "";
          if (CLOSED_STATUSES.has(status)) return { ok: true, ref, existing: true };
          if (existsSync(join(root, ".claims", `FT-${id}`))) {
            return {
              ok: false,
              reason: `${ref} is claimed — someone is working on it; it is left open for them`,
            };
          }
          const ts = now();
          let out = setField(
            setField(setField(text, "Status", "resolved"), "Closed", `${ts} resolved by ${actor}`),
            "Updated",
            ts,
          );
          if (!/^## Comments\s*$/m.test(out)) out = `${out.trimEnd()}\n\n## Comments\n`;
          out = `${out.trimEnd()}\n\n### ${ts} — ${actor} [resolution]\n\n${note.trim()}\n`;
          const tmp = `${path}.tmp-${process.pid}`;
          writeFileSync(tmp, out);
          renameSync(tmp, path);
          return { ok: true, ref };
        });
      } catch (err) {
        return { ok: false, reason: `the tracker refused the close: ${clean(err)}` };
      }
    },
  };
}

// ---- markdown files ----------------------------------------------------------------

/** One markdown file per promoted finding, in the state home. The file name
 * is the fingerprint's head, so a second promote of the same finding (or of
 * one it was matched to) finds the file already there. */
export function markdownFindingSink(state: StateFs, clock: () => Date): TrackerSink {
  const pathOf = (fp: string): string => `${PROMOTED_DIR}/finding-${fp.slice(0, 16)}.md`;
  return {
    kind: "markdown",
    file: async (t) => {
      try {
        for (const fp of stamps(t)) {
          if (state.read(pathOf(fp)) !== null) return { ok: true, ref: pathOf(fp), existing: true };
        }
        const ts = clock().toISOString();
        const content = [
          `# ${t.title.replace(/[\r\n]+/g, " ").trim()}`,
          "",
          "Status: open",
          `Effort: ${t.effort}`,
          `Created: ${ts}`,
          "",
          safeBody(t.body),
          "",
          stampLines(t),
          "",
        ].join("\n");
        state.write(pathOf(t.fingerprint), content);
        return { ok: true, ref: pathOf(t.fingerprint) };
      } catch (err) {
        return { ok: false, reason: `could not write the finding's file: ${clean(err)}` };
      }
    },
    close: async (ref, note) => {
      try {
        if (!ref.startsWith(`${PROMOTED_DIR}/finding-`) || ref.includes(".."))
          return { ok: false, reason: `${ref} is not a promoted-finding file` };
        const text = state.read(ref);
        if (text === null)
          return {
            ok: false,
            reason: `${ref} is gone from the state home (moved elsewhere?) — nothing to close`,
          };
        if (field(text, "Status") === "fixed") return { ok: true, ref, existing: true };
        const out = `${setField(text, "Status", "fixed").trimEnd()}\n\n## Fixed\n\n${clock().toISOString()} — ${note.trim()}\n`;
        state.write(ref, out);
        return { ok: true, ref };
      } catch (err) {
        return { ok: false, reason: `could not close ${ref}: ${clean(err)}` };
      }
    },
  };
}

/** The sink this companion files into: the issue tracker when one is mounted
 * at `trackerDir`, otherwise markdown files in the state home. */
export function scanTrackerSink(opts: {
  trackerDir: string | undefined;
  state: StateFs;
  clock: () => Date;
}): TrackerSink {
  if (isIssueTracker(opts.trackerDir))
    return issueTrackerSink({ root: opts.trackerDir!, clock: opts.clock });
  return markdownFindingSink(opts.state, opts.clock);
}
