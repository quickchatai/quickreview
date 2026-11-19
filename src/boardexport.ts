// `qcr --schema 3 board`: the reviewer's board as one JSON object, for a host
// that runs it for its operator (the `board` family of the host contract,
// schemas/board.v1.json, packages/pi-plugin/src/contract.ts).
//
// The verb reads; it starts nothing and writes nothing. What it reads:
//
//   the daemon   whether it runs, and its board.json (src/boardfile.ts): the
//                three lists, its poll, its spend, its count of the pull
//                requests reviewed today, its own posting flag, and the
//                trigger it follows (`trigger`: labelled pull requests, or
//                all; src/triggerchoice.ts). That is the daemon's word, never
//                the config's `[github] trigger`, which is only the starting
//                value where no choice was ever stored and can say something
//                else than the running daemon follows.
//                The daemon writes that file inside its state directory, so
//                on a compose stack it is read out of the running container;
//                with the daemon off there is nothing to read and the lists
//                are absent.
//   the config   the repository, the identity, the trigger label, and
//                `dry_run` as the file says it now (read as text, never
//                through the loader: before setup there is no config, and
//                that is an answer too).
//   pi's login   whether this host holds a model login, and whether the
//                daemon's refresher says it lapsed. Readable before setup.
//   the token    `github`: what the token file says of itself, on an install
//                whose GitHub credential is that file (`githubWord`): there,
//                lapsed by its expiry note, or not there. GitHub is not asked.
//   progress     `setup`, `go_live` and `proof`: how far a host's setup and
//                go-live have got, and the practice review a go-live is
//                confirmed against. The host verbs' record and the
//                checklist's proof, read through one reader
//                (`readBoardProgress`, src/host/record.ts).
//
// Absent means unknown. A field whose source cannot be read is left out,
// never printed as a zero, an empty list or a default; an empty list is a
// read that found nothing. The object leads with `schema_version`, the number
// of the contract its caller named. A run that cannot build the object prints
// nothing on stdout and exits non-zero.
//
// No store, no second Node process: the cost is one Node start, one question
// to Docker and one file read.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { hostPayloadVersion } from "@quickchatai/pi-quickreview/src/contract.js";
import { loginSummary } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { githubTokenHealth } from "@quickchatai/pi-quickreview/src/hosttoken.js";
import {
  BOARD_FILE,
  parseBoardFile,
  type BoardFile,
  type BoardOpenRow,
  type BoardReviewedRow,
  type BoardReviewingRow,
} from "./boardfile.js";
import { sandboxRoot } from "./config.js";
import { autoReviewLabel, serviceState, type DaemonContainer } from "./home/autoreview.js";
import { readHostProgress } from "./host/record.js";
import { secretsDirAt } from "./hostmanaged.js";
import { expiredWhy } from "./home/loginowner.js";
import { known, unknown, type Known } from "./home/ports.js";
import { locateConfig, stackRoot } from "./homes.js";
import { detectInstall } from "./installkind.js";
import { STATUS_FILE } from "./loginrefresh/refresher.js";
import type { ProcessRunner } from "./onboard/engine.js";
import { CONTAINER_STATE_DIR, DAEMON_SERVICE, daemonExec } from "./onboard/steps/compose.js";
import { piAgentDir } from "./piagentdir.js";
import { requestedContract } from "./schemaflag.js";
import { readAppConfigToml } from "./shippeddefaults.js";

// ---- the export's shape ---------------------------------------------------------

export const REVIEWER_STATES = ["off", "starting", "on", "paused_login", "broken"] as const;
export type ReviewerState = (typeof REVIEWER_STATES)[number];

/** A credential as its own files say it: there and working as far as they
 * tell, lapsed, or not there. */
export const CREDENTIAL_WORDS = ["ok", "expired", "missing"] as const;
export type CredentialWord = (typeof CREDENTIAL_WORDS)[number];

/** How the reviewer posts: as a person, as a GitHub App it holds the key of,
 * or as an App installation whose token a host supplies. */
export const IDENTITY_MODES = ["user", "app", "installation"] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

/** A long step a host started, as the host verbs record it. The words are
 * closed sets (src/host/outcomes.ts): SETUP_STEPS, SETUP_PROBLEMS and
 * GO_LIVE_PROBLEMS. */
export interface BoardStep {
  state: "running" | "done" | "failed";
  /** The step it is at, or stopped at. */
  step?: string;
  /** Why it failed, in a closed word. */
  problem?: string;
}

/** The practice review the go-live is confirmed against. */
export interface BoardProof {
  pr: number;
  round_no: number;
  verdict?: string;
  completed_at?: string;
}

/** A go-live a host started. */
export type BoardGoLive = Omit<BoardStep, "step">;

/** The host verbs' records the export carries. */
export interface BoardProgress {
  setup?: BoardStep;
  go_live?: BoardGoLive;
  proof?: BoardProof;
}

/** The export. Every field but `schema_version` is optional: absent means
 * unknown. */
export interface BoardExport {
  schema_version: number;
  /** When the daemon wrote the board the lists, `poll`, `spend` and
   * `posting` are read from. */
  written_at?: string;
  repo?: string;
  identity?: { mode: IdentityMode; login?: string };
  /** The running daemon's own flag. */
  posting?: "dry_run" | "live";
  /** The config says live and the running daemon is still in dry-run. */
  posting_pending?: "live";
  reviewer?: ReviewerState;
  model_login?: CredentialWord;
  github?: CredentialWord;
  trigger_label?: string;
  /** What the reviewer picks up by itself, labelled pull requests or all:
   * the trigger the running daemon follows, from its board. Absent with the
   * daemon off. */
  trigger?: "label" | "all";
  poll?: { last_at?: string; ok?: boolean; interval_s: number };
  spend?: NonNullable<BoardFile["spend"]>;
  /** The pull requests with a review round finished since midnight on the
   * install's own calendar, open or closed, posted or practice. Absent when
   * the daemon could not count them, or its count is of a day that is over. */
  reviewed_today?: number;
  setup?: BoardStep;
  go_live?: BoardGoLive;
  proof?: BoardProof;
  reviewing?: BoardReviewingRow[];
  reviewed?: BoardReviewedRow[];
  open?: BoardOpenRow[];
  listed_at?: string;
  more?: true;
}

// ---- the ports ------------------------------------------------------------------

/** Everything the export reads. The real ones are `realBoardPorts`; a test
 * builds fakes. A port may answer unknown, and may throw: both leave its
 * fields out. */
export interface BoardPorts {
  /** Milliseconds since the epoch. */
  now(): number;
  /** The daemon, as what runs it says. */
  daemon(): Promise<Known<DaemonContainer>>;
  /** board.json's text, read from the running daemon's state; null when the
   * daemon has written none. Read only while the daemon runs. */
  boardFile(): Promise<Known<string | null>>;
  /** The install's config.toml as text; null when there is none yet. */
  config(): Known<string | null>;
  /** pi's agent dir on this host: its auth.json, and the daemon's refresher
   * record beside it. */
  agentDir(): string;
  /** A file's text; throws as `readFileSync` does. */
  read(path: string): string;
  /** The `github` field: what the token file says of itself (`githubWord`).
   * Undefined: it cannot tell, or the install's credential is no such file. */
  github(): CredentialWord | undefined;
  /** The `setup`, `go_live` and `proof` records. */
  progress(): BoardProgress;
}

/**
 * The one reader of the setup, go-live and proof records for the export: what
 * the host verbs wrote (src/host/record.ts), and the checklist's practice
 * round once `host proof-result` has returned it. A record nothing wrote is
 * absent, which a host reads as unknown; a walk recorded as running whose
 * process is gone is said as failed. `stateDir` is the stack's
 * `<root>/state`, where the checklist lives.
 */
export function readBoardProgress(stateDir: string): BoardProgress {
  return readHostProgress(stateDir);
}

// ---- reading the sources ----------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
const isMissingFile = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A port's answer, or unknown when it threw. */
async function asked<T>(read: () => Promise<Known<T>> | Known<T>): Promise<Known<T>> {
  try {
    return await read();
  } catch (err) {
    return unknown(message(err));
  }
}

/** What the config file says, each fact only when it does. */
interface ConfigFacts {
  repo?: string;
  identity?: { mode: IdentityMode; login?: string };
  trigger_label?: string;
  /** Root `dry_run`, as the file says it now. */
  dry_run?: boolean;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * The export's facts from a config.toml's text. The identity is said only
 * once the file names one: its own `auth`, or a login it posts under. A file
 * that names neither is a template nobody filled, and the mode a daemon would
 * default to is not a fact about this install yet.
 */
export function configFacts(toml: string): ConfigFacts {
  let written: Obj;
  let merged: Obj;
  try {
    written = parse(toml);
    // over the shipped defaults, as the daemon reads it: a key the file
    // leaves out is the shipped value the daemon runs on
    merged = readAppConfigToml(toml);
  } catch {
    return {};
  }
  const github: Obj = isObj(merged["github"]) ? merged["github"] : {};
  const writtenGithub: Obj = isObj(written["github"]) ? written["github"] : {};
  const repo = text(github["repo"]);
  const login = text(github["bot_login"]);
  const auth = writtenGithub["auth"];
  const mode: IdentityMode | undefined =
    auth === undefined
      ? login !== undefined
        ? "app"
        : undefined
      : IDENTITY_MODES.find((m) => m === auth);
  const label = text(github["trigger_label"]);
  return {
    ...(repo !== undefined && REPO_RE.test(repo) ? { repo } : {}),
    ...(mode !== undefined
      ? { identity: { mode, ...(login !== undefined ? { login } : {}) } }
      : {}),
    ...(label !== undefined ? { trigger_label: label } : {}),
    ...(typeof merged["dry_run"] === "boolean" ? { dry_run: merged["dry_run"] } : {}),
  };
}

/**
 * The host's model login, from pi's own files:
 *
 *   missing   pi stores no credential here (no auth.json, or an empty one)
 *   expired   it stores one, and the daemon says it lapsed: its label is
 *             paused on the login, or its refresher's record says the refresh
 *             fails and the token is past its expiry (read only while the
 *             daemon runs: a stopped refresher's record is old news)
 *   ok        it stores one, and nothing says it lapsed
 *
 * Undefined when the auth file is there and cannot be read.
 */
export function modelLoginWord(o: {
  agentDir: string;
  read: (path: string) => string;
  now: number;
  /** Does the daemon run here? null: unknown. */
  daemonRuns: boolean | null;
  /** The daemon's own label says it is paused on the login. */
  pausedOnLogin: boolean;
}): CredentialWord | undefined {
  let stored: number;
  try {
    stored = Object.keys(loginSummary(o.read(join(o.agentDir, "auth.json")))).length;
  } catch (err) {
    return isMissingFile(err) ? "missing" : undefined;
  }
  if (stored === 0) return "missing";
  if (o.pausedOnLogin) return "expired";
  if (o.daemonRuns !== true) return "ok";
  try {
    const record: unknown = JSON.parse(o.read(join(o.agentDir, STATUS_FILE)));
    return expiredWhy(record, o.now) === null ? "ok" : "expired";
  } catch {
    // the refresher has written no record: nothing says the login fails
    return "ok";
  }
}

/**
 * The `github` field, from the install's config and its secrets directory:
 * what the token file and its optional expiry note say
 * (packages/pi-plugin/src/hosttoken.ts `githubTokenHealth`).
 *
 * The file is the credential under `[github] auth = "user"` and `auth =
 * "installation"` (a host-supplied installation token), and wherever a
 * host manages it (`token_source = "host"`: the marker is there before a
 * setup has written the mode beside it, and a host reads the field to see
 * whether its token has arrived). Undefined, so the field is absent, when the
 * install's credential is no file (an App mints its own), when there is no
 * config or it is not TOML, and when the file or its note cannot be read.
 */
export function githubWord(o: {
  /** The install's config.toml as text; null when there is none. */
  config: string | null;
  /** Where the install keeps its secrets (src/hostmanaged.ts `secretsDirAt`). */
  secretsDir: string;
  now: number;
  read: (path: string) => string;
}): CredentialWord | undefined {
  if (o.config === null) return undefined;
  let github: unknown;
  try {
    github = parse(o.config)["github"];
  } catch {
    return undefined;
  }
  if (!isObj(github)) return undefined;
  const auth = github["auth"];
  if (auth !== "user" && auth !== "installation" && github["token_source"] !== "host")
    return undefined;
  const health = githubTokenHealth(
    { auth: "user", secrets_dir: o.secretsDir },
    { now: () => o.now, read: o.read },
  );
  return health ?? undefined;
}

/** The UTC day of an instant, `YYYY-MM-DD`; "" for a time that is none. */
const utcDay = (ms: number): string =>
  Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";

/** The daemon's poll record as the export carries it: its cadence always, the
 * last pass and how it went once a pass has ended. No error text. */
function pollOf(health: BoardFile["health"]): BoardExport["poll"] {
  const poll: unknown = health.poll;
  if (!isObj(poll)) return undefined;
  const interval = poll["interval_s"];
  if (typeof interval !== "number" || !(interval > 0)) return undefined;
  const lastAt = text(poll["last_at"]);
  return {
    ...(lastAt !== undefined ? { last_at: lastAt } : {}),
    ...(typeof poll["ok"] === "boolean" ? { ok: poll["ok"] } : {}),
    interval_s: interval,
  };
}

// ---- the export -------------------------------------------------------------------

/**
 * Build the export from the ports, under `contract` (the number the payload
 * leads with). Total: a port that cannot answer costs its own fields and
 * nothing else.
 */
export async function boardExport(ports: BoardPorts, contract: number): Promise<BoardExport> {
  const now = ports.now();
  // Asked together: the two questions to the daemon's host are the whole
  // wall time of the export.
  const [daemon, fileText, config] = await Promise.all([
    asked(() => ports.daemon()),
    asked(() => ports.boardFile()),
    asked(() => ports.config()),
  ]);
  const running = daemon.kind === "known" && daemon.value === "running";
  // The lists are the running daemon's: a file is read only then.
  const board =
    running && fileText.kind === "known" && fileText.value !== null
      ? parseBoardFile(fileText.value)
      : null;

  // The label, by the rule the home shows it by (src/home/autoreview.ts): the
  // daemon's container, then the health its board carries.
  const label =
    daemon.kind === "unknown"
      ? daemon
      : autoReviewLabel({
          container: daemon,
          snapshot:
            daemon.value !== "running"
              ? known(null)
              : board !== null
                ? known(JSON.stringify(board.health))
                : fileText.kind === "known" && fileText.value !== null
                  ? unknown("the daemon's board is not one this qcr reads")
                  : fileText,
          now,
        });
  const state = label.kind === "known" ? label.value.state : undefined;
  const reviewer: ReviewerState | undefined =
    state === undefined
      ? undefined
      : state === "on-live" || state === "on-dry"
        ? "on"
        : state === "paused-login"
          ? "paused_login"
          : state;

  const facts =
    config.kind === "known" && config.value !== null ? configFacts(config.value) : undefined;
  // the file's own word, re-read: a board whose flag is no boolean says nothing
  const daemonDryRun: unknown = board?.health.dry_run;
  const posting: BoardExport["posting"] =
    daemonDryRun === true ? "dry_run" : daemonDryRun === false ? "live" : undefined;

  let modelLogin: CredentialWord | undefined;
  let github: CredentialWord | undefined;
  let progress: BoardProgress = {};
  try {
    modelLogin = modelLoginWord({
      agentDir: ports.agentDir(),
      read: (p) => ports.read(p),
      now,
      daemonRuns: daemon.kind === "known" ? daemon.value !== "stopped" : null,
      pausedOnLogin: state === "paused-login",
    });
  } catch {
    // unknown: the field is left out
  }
  try {
    github = ports.github();
  } catch {
    // unknown: the field is left out
  }
  try {
    progress = ports.progress();
  } catch {
    // unknown: the records are left out
  }

  const poll = board === null ? undefined : pollOf(board.health);
  // The board's spend is of the UTC day and month it was written in: once
  // that day has passed it is no longer "today", and it is left out.
  const spend =
    board !== null && utcDay(Date.parse(board.written_at)) === utcDay(now)
      ? board.spend
      : undefined;
  // The daemon's count is of one day of its own calendar, written with that
  // day's bounds: outside them it is yesterday's number, and is left out.
  const counted = board?.reviewed_today;
  const reviewedToday =
    counted !== undefined && Date.parse(counted.since) <= now && now < Date.parse(counted.until)
      ? counted.count
      : undefined;
  // What the reviewer picks up by itself: the trigger the running daemon
  // follows, as it wrote it on its board. With the daemon off there is no
  // board, and the field is absent.
  const trigger = board?.trigger;

  return {
    schema_version: contract,
    ...(board !== null ? { written_at: board.written_at } : {}),
    ...(facts?.repo !== undefined ? { repo: facts.repo } : {}),
    ...(facts?.identity !== undefined ? { identity: facts.identity } : {}),
    ...(posting !== undefined ? { posting } : {}),
    ...(posting === "dry_run" && facts?.dry_run === false
      ? { posting_pending: "live" as const }
      : {}),
    ...(reviewer !== undefined ? { reviewer } : {}),
    ...(modelLogin !== undefined ? { model_login: modelLogin } : {}),
    ...(github !== undefined ? { github } : {}),
    ...(facts?.trigger_label !== undefined ? { trigger_label: facts.trigger_label } : {}),
    ...(poll !== undefined ? { poll } : {}),
    ...(spend !== undefined ? { spend } : {}),
    ...(reviewedToday !== undefined ? { reviewed_today: reviewedToday } : {}),
    ...(trigger !== undefined ? { trigger } : {}),
    ...(progress.setup !== undefined ? { setup: progress.setup } : {}),
    ...(progress.go_live !== undefined ? { go_live: progress.go_live } : {}),
    ...(progress.proof !== undefined ? { proof: progress.proof } : {}),
    ...(board !== null
      ? {
          reviewing: board.reviewing,
          reviewed: board.reviewed,
          ...(board.open !== undefined && board.listed_at !== undefined
            ? { open: board.open, listed_at: board.listed_at }
            : {}),
          ...(board.more === true ? { more: true as const } : {}),
        }
      : {}),
  };
}

// ---- the real ports -----------------------------------------------------------------

/** The longest the export waits for Docker: a host reads the board on a
 * cadence, and a read that hangs is an unknown, never a pile of them. */
export const BOARD_READ_TIMEOUT_MS = 5_000;

const boardRunner: ProcessRunner = {
  run: (cmd, args) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        { timeout: BOARD_READ_TIMEOUT_MS, maxBuffer: 4 << 20 },
        (err, stdout, stderr) => {
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : 1;
          resolve({
            code,
            stdout: String(stdout),
            stderr: err && !stderr ? String(err.message) : String(stderr),
          });
        },
      );
    }),
};

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim() || "no output";

/**
 * The ports over this machine: the compose stack the home's switches drive
 * (src/homes.ts `stackRoot`), the install's config and pi's agent dir.
 * Inside the release image there is no Docker and the state directory is the
 * daemon's own, so the board is read where the daemon writes it.
 */
export function realBoardPorts(
  env: Readonly<Record<string, string | undefined>> = process.env,
  runner: ProcessRunner = boardRunner,
): BoardPorts {
  const pkgRoot = sandboxRoot();
  const root = stackRoot(env, pkgRoot);
  const read = (p: string): string => readFileSync(p, "utf8");
  const inImage = detectInstall(pkgRoot, env).kind === "image";
  const ownBoard = join(pkgRoot, "state", BOARD_FILE);
  const readOwnBoard = (): Known<string | null> => {
    try {
      return known(read(ownBoard));
    } catch (err) {
      return isMissingFile(err) ? known(null) : unknown(`can't read ${ownBoard}: ${message(err)}`);
    }
  };
  const configPath = (): string => locateConfig({ env }).path;
  return {
    now: () => Date.now(),
    daemon: async () => {
      if (!inImage) return serviceState(runner, root, DAEMON_SERVICE);
      const own = readOwnBoard();
      return own.kind === "known" && own.value !== null
        ? known<DaemonContainer>("running")
        : unknown("no daemon has written a board in this container's state");
    },
    boardFile: async () => {
      if (inImage) return readOwnBoard();
      const r = await daemonExec(runner, root, ["cat", `${CONTAINER_STATE_DIR}/${BOARD_FILE}`]);
      if (r.code === 0) return known(r.stdout);
      if (/no such file/i.test(r.stderr)) return known(null);
      return unknown(`can't read the daemon's board: ${firstLine(r.stderr || r.stdout)}`);
    },
    config: () => {
      const path = configPath();
      try {
        return known(read(path));
      } catch (err) {
        return isMissingFile(err) ? known(null) : unknown(`can't read ${path}: ${message(err)}`);
      }
    },
    agentDir: () => piAgentDir(env),
    read,
    github: () => {
      let config: string;
      try {
        config = read(configPath());
      } catch {
        // no config, or one that cannot be read: nothing names the credential
        return undefined;
      }
      return githubWord({
        config,
        secretsDir: secretsDirAt(configPath, env, read)(),
        now: Date.now(),
        read,
      });
    },
    progress: () => readBoardProgress(join(root, "state")),
  };
}

// ---- the verb -------------------------------------------------------------------------

export interface BoardIo {
  /** The contract the caller named; default: the process's `--schema N`. */
  contract?: number;
  ports?: BoardPorts;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/**
 * `qcr --schema N board`: one line of JSON on stdout and exit 0, or nothing
 * on stdout and a non-zero exit (2 for usage, 3 when no contract this build
 * prints carries the board, 1 when the object could not be built). Run with
 * no `--schema`, it prints the newest contract's.
 */
export async function cmdBoard(args: readonly string[], io: BoardIo = {}): Promise<number> {
  const out = io.out ?? ((line: string) => console.log(line));
  const err = io.err ?? ((line: string) => console.error(line));
  if (args.length > 0) {
    err("usage: qcr --schema N board");
    return 2;
  }
  const contract = hostPayloadVersion("board", io.contract ?? requestedContract());
  if (contract === undefined) {
    err("qcr board: no contract this qcr prints carries the board");
    return 3;
  }
  let line: string;
  try {
    line = JSON.stringify(await boardExport(io.ports ?? realBoardPorts(), contract));
  } catch (e) {
    err(`qcr board: the board could not be read: ${message(e)}`);
    return 1;
  }
  out(line);
  return 0;
}
