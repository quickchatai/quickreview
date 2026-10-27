// "Tune to this repo": the home runs Setup for the repository's profile when
// the person chooses it (CONTEXT.md: Setup is the survey, the review history
// and the interview, and its result is the repo profile). Nothing waits on
// it: a review before it, the first one included, runs on the default
// profile, and the review button never asks for it.
//
// Setup is a conversation, so it runs with the agent the person is already
// talking to: the home hands the chat the plugin's own Setup brief
// (`profileSetupBrief`, the one `/qcr-setup profile` sends), over a checkout
// of the repository on this machine. The agent surveys the checkout with its
// read tools, reads the review history when it can, interviews the person in
// the chat, and writes the profile, `.qcr/` at the checkout's root, through
// `home_tune_write`: the one write the home lends it, which writes only a
// profile file, only while a tune runs, and only on the person's yes.
//
// A profile is several files (profile.toml and one addendum per house rule),
// so the tune stays open through all of them: it ends when the agent marks a
// write as the profile's last file (`last`), or with the session. Until the
// agent writes through the tool, the home also watches the profile (the
// plugin's own detect: `.qcr/profile.toml` in the checkout) and says when one
// is written another way. A review reads the profile from the base commit,
// so it applies once the person commits it there.
//
// The checkout is untrusted: its contributors choose what is in it, links
// included. A write creates its temporary file exclusively, never through a
// link, and refuses a `.qcr/` or `addenda/` that is a link or resolves
// outside the checkout, so a yes writes only the file it names.
//
//   tune     a key (t, alt+t) and the `home_tune` tool
//   write    the `home_tune_write` tool: the agent's draft, the person's yes
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { profileSetupBrief } from "@quickchatai/pi-quickreview/src/plugin/setup.js";
import { REPO_PROFILE_DIR } from "@quickchatai/pi-quickreview/src/profileoverrides.js";
import { parse } from "smol-toml";
import type { ProcessRunner } from "../onboard/engine.js";
import { known, unknown, type Known, type Outcome } from "./ports.js";
import { parseRepoInput } from "./setup.js";
import type { Ask } from "./switches.js";

/** Where the repository's Setup stands. */
export interface TuneStatus {
  /** It has a profile of its own: Setup has run. */
  tuned: boolean;
  /** As the person reads it. */
  detail: string;
  /** When its profile was last written, ms since the epoch; null without one. */
  at: number | null;
}

/** Setup, ready to hand the agent. */
export interface TuneStart {
  /** The checkout Setup reads and writes the profile into. */
  checkout: string;
  /** The Setup brief. */
  brief: string;
}

export interface TunePort {
  status(repo: string): Promise<Known<TuneStatus>>;
  /** Find the checkout Setup runs on, and its brief. */
  start(repo: string): Promise<Outcome<TuneStart>>;
  /** Write one file of the profile, `file` relative to `.qcr/`. */
  write(checkout: string, file: string, text: string): Promise<Outcome<{ path: string }>>;
}

/** How often the home looks for the profile while a tune runs. */
export const TUNE_POLL_MS = 5000;

/** The files of a repo profile Setup may write: profile.toml, and one
 * addendum per house rule. Null: not one of them. */
export function profileFile(file: string): string | null {
  const f = file.trim().replace(/^\.qcr\//, "");
  if (f === "profile.toml") return f;
  return /^addenda\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(f) && !f.includes("..") ? f : null;
}

/** What the home adds to the plugin's brief: the write it lends, and what
 * the reviewer-only home's agent cannot do. */
export function homeBriefNote(checkout: string): string {
  return [
    "",
    `In this home, the checkout is ${checkout}: read it with your read tools. Write each file of the profile with the \`home_tune_write\` tool (\`file\` is relative to ${REPO_PROFILE_DIR}/: \`profile.toml\` or \`addenda/<nn>-<rule-id>.md\`); it shows me the file and writes it only on my yes. Pass \`last: true\` with the profile's final file: the tune ends with it. If you cannot reach \`gh\` from here, skip the review history and say so.`,
  ].join("\n");
}

export const WRITE_NO = "No, don't write it";
export const WRITE_YES = "Yes, write it";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface HomeTuneOptions {
  port?: TunePort;
  /** The repository the home reviews, or null. */
  repo: () => string | null;
  say: (text: string, kind?: "info" | "ok" | "warn") => void;
  /** Run `fn` once after `ms`; the returned function cancels it. */
  after: (ms: number, fn: () => void) => () => void;
  onChange?: () => void;
}

interface Tuning {
  repo: string;
  checkout: string;
  before: TuneStatus | null;
  /** The files written through the tool; once there is one, only `last` ends it. */
  wrote: string[];
}

/** The tune: one at a time, from the person's choice to the profile's last file. */
export class HomeTune {
  private tuning: Tuning | null = null;
  private cancel: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly o: HomeTuneOptions) {}

  /** Is Setup under way? */
  running(): boolean {
    return this.tuning !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel?.();
    this.cancel = null;
  }

  /** Run Setup for the repository: hand `tellAgent` the brief, then watch for
   * the profile. Without an agent to tell (outside a session), nothing starts. */
  async tune(tellAgent: ((text: string) => void) | undefined): Promise<string> {
    const port = this.o.port;
    if (!port) return "Setup can't be run from this home";
    const repo = this.o.repo();
    if (repo === null) return "no repository is chosen, so there is nothing to tune to";
    if (this.tuning)
      return `Setup of ${this.tuning.repo} is under way with your agent in the chat (${this.tuning.checkout}); it ends when your agent writes the profile's last file`;
    if (!tellAgent) return "Setup is a conversation with the chat's agent, and there is none here";
    let started: Outcome<TuneStart>;
    try {
      started = await port.start(repo);
    } catch (err) {
      started = { ok: false, why: message(err) };
    }
    if (!started.ok) {
      this.o.say(`Can't tune to ${repo} yet: ${started.why}`, "warn");
      return `Setup did not start: ${started.why}`;
    }
    const before = await this.read(repo);
    this.tuning = {
      repo,
      checkout: started.checkout,
      before: before.kind === "known" ? before.value : null,
      wrote: [],
    };
    tellAgent(`${started.brief}\n${homeBriefNote(started.checkout)}`);
    this.o.say(
      `Tuning to ${repo}: your agent surveys ${started.checkout}, reads its review history and asks you about it, here in the chat. Reviews run on the default profile until it is done.`,
    );
    this.o.onChange?.();
    this.watch();
    return `Setup of ${repo} started with the chat's agent, over ${started.checkout}; the home says when the profile is written`;
  }

  /** The agent's draft of one profile file, written on the person's yes.
   * `last`: it is the profile's final file, and the tune ends with it. */
  async write(file: string, text: string, ask: Ask | undefined, last = false): Promise<string> {
    const t = this.tuning;
    const port = this.o.port;
    if (!t || !port) return "no tune is running: start one first (home_tune)";
    const f = profileFile(file);
    if (f === null)
      return `${JSON.stringify(file)} is not a profile file: write profile.toml or addenda/<nn>-<rule-id>.md`;
    if (!ask) return "the person answers whether to write it, and no one can answer here";
    const where = join(t.checkout, REPO_PROFILE_DIR, f);
    let yes: string | undefined;
    try {
      const lines = text.split("\n").filter((l) => l.trim() !== "").length;
      yes = await ask.select(`Write ${where} (${lines} lines, as your agent showed it)?`, [
        WRITE_NO,
        WRITE_YES,
      ]);
    } catch {
      yes = undefined;
    }
    if (yes !== WRITE_YES) return `the person said no: ${REPO_PROFILE_DIR}/${f} was not written`;
    let r: Outcome<{ path: string }>;
    try {
      r = await port.write(t.checkout, f, text);
    } catch (err) {
      r = { ok: false, why: message(err) };
    }
    if (!r.ok) return `${REPO_PROFILE_DIR}/${f} was not written: ${r.why}`;
    if (this.tuning !== t) return `wrote ${r.path}`;
    t.wrote.push(f);
    if (!last)
      return `wrote ${r.path}; the tune stays open: write the profile's other files, and pass last: true with the final one`;
    const n = t.wrote.length === 1 ? "1 file" : `${t.wrote.length} files`;
    this.finish(t, `${n} of ${REPO_PROFILE_DIR}/ in ${t.checkout}`);
    return `wrote ${r.path}; Setup is done`;
  }

  private async read(repo: string): Promise<Known<TuneStatus>> {
    try {
      return await this.o.port!.status(repo);
    } catch (err) {
      return unknown(message(err));
    }
  }

  private watch(): void {
    if (this.disposed || !this.tuning) return;
    this.cancel = this.o.after(TUNE_POLL_MS, () => {
      this.cancel = null;
      void this.check().then((done) => {
        if (!done) this.watch();
      });
    });
  }

  /** Has the profile been written another way since the tune started? Says
   * so once. Once the agent writes through the tool, only `last` ends it: a
   * profile.toml is the first file of several, not the end. */
  private async check(): Promise<boolean> {
    const t = this.tuning;
    if (!t || t.wrote.length > 0) return true;
    const s = await this.read(t.repo);
    if (this.tuning !== t || t.wrote.length > 0) return true;
    if (s.kind === "unknown" || !s.value.tuned) return false;
    const b = t.before;
    const fresh = !b?.tuned || (s.value.at ?? 0) > (b.at ?? 0);
    if (!fresh) return false;
    this.finish(t, s.value.detail);
    return true;
  }

  private finish(t: Tuning, detail: string): void {
    this.tuning = null;
    this.cancel?.();
    this.cancel = null;
    this.o.say(
      `Tuned to ${t.repo}: ${detail}. Reviews use it once it is committed to the base branch.`,
      "ok",
    );
    this.o.onChange?.();
  }
}

// ---- the real port: a checkout on this machine ---------------------------

type Env = Readonly<Record<string, string | undefined>>;

export interface CheckoutTuneOptions {
  env: Env;
  /** The asset root: the shipped profiles and lenses the brief points at. */
  root: () => string;
  /** The app config, for `[companion] reviewed_repo_dir`. */
  configPath: () => string;
  runner: ProcessRunner;
  read?: (p: string) => string;
}

/** The checkout of `repo` on this machine: QCR_REVIEWED_REPO, the config's
 * `[companion] reviewed_repo_dir`, then the directory the home was opened
 * from, each only when git says its origin is `repo`. */
export async function findCheckout(
  repo: string,
  o: Pick<CheckoutTuneOptions, "env" | "configPath" | "runner" | "read">,
): Promise<string | null> {
  const candidates: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === "string" && v.trim() !== "") candidates.push(v.trim());
  };
  add(o.env["QCR_REVIEWED_REPO"]);
  try {
    const read = o.read ?? ((p: string) => readFileSync(p, "utf8"));
    const cfg = parse(read(o.configPath())) as Record<string, unknown>;
    const companion = cfg["companion"];
    if (typeof companion === "object" && companion !== null)
      add((companion as Record<string, unknown>)["reviewed_repo_dir"]);
  } catch {
    // no config to read: the other places still count
  }
  add(o.env["PWD"]);
  for (const dir of candidates) {
    const top = await o.runner.run("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
    if (top.code !== 0) continue;
    const root = top.stdout.trim();
    const origin = await o.runner.run("git", ["-C", root, "remote", "get-url", "origin"]);
    const named = origin.code === 0 ? parseRepoInput(origin.stdout.trim()) : null;
    if (named !== null && named.toLowerCase() === repo.toLowerCase()) return root;
  }
  return null;
}

/** The tune over a checkout of the repository on this machine. */
export function checkoutTune(o: CheckoutTuneOptions): TunePort {
  const profileAt = (top: string): string => join(top, REPO_PROFILE_DIR, "profile.toml");
  const missing = (repo: string): string =>
    `Setup reads a checkout of ${repo}, and there is none here: open the home from inside one (cd into it, then run qcr), or set QCR_REVIEWED_REPO to it`;
  return {
    status: async (repo) => {
      const top = await findCheckout(repo, o);
      if (top === null) return unknown(`no checkout of ${repo} on this machine`);
      const file = profileAt(top);
      if (!existsSync(file))
        return known({ tuned: false, detail: "reviews run on the default profile", at: null });
      let at: number | null = null;
      try {
        at = statSync(file).mtimeMs;
      } catch {
        // it is there: when it was written is all that is not known
      }
      return known({ tuned: true, detail: `${REPO_PROFILE_DIR}/profile.toml in ${top}`, at });
    },
    start: async (repo) => {
      const top = await findCheckout(repo, o);
      if (top === null) return { ok: false, why: missing(repo) };
      return { ok: true, checkout: top, brief: profileSetupBrief({ top, root: o.root() }) };
    },
    write: async (checkout, file, text) => {
      const f = profileFile(file);
      if (f === null) return { ok: false, why: `${file} is not a profile file` };
      const path = join(checkout, REPO_PROFILE_DIR, f);
      try {
        const body = text.endsWith("\n") ? text : `${text}\n`;
        writeInCheckout(checkout, `${REPO_PROFILE_DIR}/${f}`, body);
      } catch (err) {
        return { ok: false, why: message(err) };
      }
      return { ok: true, path };
    },
  };
}

/** Write `rel` (slash-separated, below `checkout`) into an untrusted checkout.
 * Every directory on the way is a real directory, made here when missing,
 * never a link, and resolves inside the checkout; the file itself, when there,
 * is a regular file. The text goes to a fresh temporary file, created
 * exclusively and never through a link, then renamed over the target, so no
 * name a contributor planted is opened for writing. */
export function writeInCheckout(checkout: string, rel: string, text: string): void {
  const top = realpathSync(checkout);
  const parts = rel.split("/");
  const name = parts.pop()!;
  let dir = top;
  for (const part of parts) {
    dir = join(dir, part);
    let st: Stats;
    try {
      st = lstatSync(dir);
    } catch {
      mkdirSync(dir);
      st = lstatSync(dir);
    }
    if (st.isSymbolicLink()) throw new Error(`${relative(top, dir)} is a link, not a directory`);
    if (!st.isDirectory()) throw new Error(`${relative(top, dir)} is not a directory`);
  }
  const real = realpathSync(dir);
  if (real !== top && !real.startsWith(top + sep))
    throw new Error(`${relative(top, dir)} resolves outside the checkout`);
  const path = join(real, name);
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`${rel} is there and is not a plain file`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o644,
  );
  try {
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already renamed, or never there: nothing to clean up
    }
    throw err;
  }
}
