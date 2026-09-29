// The real ports behind SetupEngine. Assembled by the companion's
// setup extension (extensions/setup.ts) inside the companion container, where
// the reviewed checkout is mounted read-only and the state home read-write
// (root CLAUDE.md rule 8, third amendment). Tests use fakes and temp dirs;
// these are the only implementations that touch a real disk or network.
//
// Every port is total at its edge, like the engine above it: a missing
// checkout lists null, a missing token file answers a refusal, and nothing
// here throws into a tool call except the state port's "exists but cannot be
// read", which the engine turns into a reported, write-refusing problem.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type {
  CaseRunner,
  GitHubReader,
  RepoReader,
  StateFs,
  TrackerSink,
} from "./engine.js";

/** Files over this are not read for facts or counted line by line — a
 * generated dump says nothing about a repo's conventions. */
export const MAX_READ_BYTES = 1024 * 1024;

/** Directories a walk never descends (the git-less fallback only). */
const WALK_SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build"]);

function inside(root: string, rel: string): string | null {
  if (isAbsolute(rel)) return null;
  const full = normalize(join(root, rel));
  const back = relative(root, full);
  if (back === "" || back.startsWith("..") || isAbsolute(back)) return null;
  return full;
}

/**
 * The reviewed checkout. Listing is `git ls-files` — what the repo tracks,
 * so ignored build output never counts as the repo — with a plain walk as
 * the fallback for a tree git cannot read (no `.git`, or a mount git calls
 * "dubious ownership" despite the `safe.directory` override).
 */
export function checkoutReader(root: string): RepoReader {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", ["-c", `safe.directory=${root}`, "-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
  const walk = (): string[] | null => {
    const out: string[] = [];
    const visit = (dir: string): void => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (WALK_SKIP.has(name)) continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) visit(full);
        else if (st.isFile()) out.push(relative(root, full).split(sep).join("/"));
      }
    };
    try {
      if (!statSync(root).isDirectory()) return null;
    } catch {
      return null;
    }
    visit(root);
    return out;
  };
  const readText = (rel: string): string | null => {
    const full = inside(root, rel);
    if (full === null) return null;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return null;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return null; // binary
      return buf.toString("utf8");
    } catch {
      return null;
    }
  };
  return {
    location: root,
    listFiles: () => {
      const listed = git(["ls-files", "-z"]);
      if (listed !== null) return listed.split("\0").filter((p) => p !== "");
      return walk();
    },
    read: readText,
    lines: (rel) => {
      const text = readText(rel);
      if (text === null) return null;
      if (text === "") return 0;
      let n = 0;
      for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
      return text.endsWith("\n") ? n : n + 1;
    },
    head: () => git(["rev-parse", "HEAD"])?.trim() || null,
  };
}

/** The state home as a rooted filesystem: relative paths only, never out of
 * the root, every write tmp+rename atomic. */
export function stateHomeFs(root: string): StateFs {
  const resolve = (rel: string): string => {
    const full = inside(root, rel);
    if (full === null) throw new Error(`state path ${JSON.stringify(rel)} leaves the state home`);
    return full;
  };
  return {
    location: root,
    read: (rel) => {
      const full = resolve(rel);
      try {
        return readFileSync(full, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    write: (rel, text) => {
      const full = resolve(rel);
      mkdirSync(dirname(full), { recursive: true });
      const tmp = join(dirname(full), `.${full.split("/").at(-1)}.tmp`);
      writeFileSync(tmp, text);
      renameSync(tmp, full);
    },
  };
}

const TOKEN_VAR = "QCR_GITHUB_READ_TOKEN";
const EXPIRES_VAR = "QCR_GITHUB_READ_EXPIRES_AT";

/**
 * GitHub through the companion's read-only token file (,
 * `src/tui/ghread.ts` writes it host-side). GET only — the method is not a
 * parameter anywhere on this path — and only API-relative paths, so a model-
 * supplied string can neither pick a verb nor aim the token at another host.
 * The file is re-read on every call: the host re-mints it in place.
 */
export function tokenFileGitHubReader(opts: {
  envFile: string | undefined;
  fetch: typeof fetch;
  clock: () => Date;
  apiRoot?: string;
}): GitHubReader {
  const apiRoot = opts.apiRoot ?? "https://api.github.com";
  return {
    get: async (path) => {
      if (!/^\/[A-Za-z0-9_./?&=%,:+-]*$/.test(path) || path.startsWith("//") || path.includes("..") || /%2e/i.test(path)) {
        return { ok: false, reason: `not an API path: ${JSON.stringify(path)}` };
      }
      if (!opts.envFile) return { ok: false, reason: "no read-only GitHub token is configured (QCR_GITHUB_READ_ENV unset)" };
      let text: string;
      try {
        text = readFileSync(opts.envFile, "utf8");
      } catch {
        return { ok: false, reason: "the read-only GitHub token file is missing — the TUI is closed or has no App credential" };
      }
      const token = new RegExp(`^${TOKEN_VAR}=(\\S+)$`, "m").exec(text)?.[1];
      const expires = Date.parse(new RegExp(`^${EXPIRES_VAR}=(\\S+)$`, "m").exec(text)?.[1] ?? "");
      if (!token) return { ok: false, reason: "the read-only GitHub token file holds no token" };
      if (!Number.isFinite(expires) || expires <= opts.clock().getTime()) {
        return { ok: false, reason: "the read-only GitHub token has expired — the TUI re-mints it while it runs" };
      }
      try {
        const res = await opts.fetch(`${apiRoot}${path}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return { ok: false, reason: `GitHub answered ${res.status} for GET ${path}` };
        return { ok: true, data: (await res.json()) as unknown };
      } catch (err) {
        return { ok: false, reason: `GET ${path} failed: ${String(err)}` };
      }
    },
  };
}

/** A port whose slice has not landed yet: every call is an honest refusal
 * naming the ticket that wires it, never a silent no-op that reads as done. */
export function notYetCaseRunner(ticket: string): CaseRunner {
  const reason = `background cases are not wired yet (${ticket})`;
  return {
    launch: async () => ({ ok: false, reason }),
    stop: async () => ({ ok: false, reason }),
  };
}

export function notYetTrackerSink(ticket: string): TrackerSink {
  const reason = `the tracker sink is not wired yet (${ticket})`;
  return {
    file: async () => ({ ok: false, reason }),
    close: async () => ({ ok: false, reason }),
  };
}
