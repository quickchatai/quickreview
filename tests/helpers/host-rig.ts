// A world for the host verbs (src/host/): the ports over a scratch directory,
// a fake Docker that plays the daemon's container, a fake GitHub, and
// switch-on's step ids as fake steps that record what they were handed (the
// same shape tests/home-switchon.test.ts walks). Nothing here starts a
// process: `launch` records the walk it was asked for and hands back a pid
// the world calls alive, and a test runs the walk itself with `walker()`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepRegistry, type SetupStep } from "@quickchatai/pi-quickreview/src/setupchecklist.js";
import { SWITCH_ON_ORDER } from "../../src/home/switchon.js";
import type { HostPorts, WalkKind } from "../../src/host/ports.js";
import type { ProcessFacts } from "../../src/onboard/checklistlock.js";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
  type StepReport,
} from "../../src/onboard/engine.js";
import { composeArgs } from "../../src/onboard/steps/compose.js";
import { GO_LIVE_STEP_ID } from "../../src/onboard/steps/golive.js";
import { PROOF_STEP_ID } from "../../src/onboard/steps/proof.js";

/** The shipped template: what a fresh config is written from. */
export const TEMPLATE = readFileSync(new URL("../../config.example.toml", import.meta.url), "utf8");

/** A config holding nothing but a host's marker. */
export const MARKER_ONLY = '[github]\ntoken_source = "host"\n';

export const REPO = "acme/widgets";
// Shorter than a real token on purpose: nothing here is credential-shaped.
export const TOKEN = "ghu_hostWrittenTokenValue0123456789ab";

/** The verb's own process, and the walk it starts. */
export const VERB_PID = 1001;
export const WALK_PID = 2002;

export const T0 = Date.parse("2026-11-19T12:00:00Z");

export interface Ran {
  id: string;
  input: Record<string, unknown>;
}

export interface Round {
  round_no: number;
  status: string;
  verdict: string | null;
  summary?: string | null;
  started_at?: string;
}

/** The daemon's container, as the fake Docker plays it. */
export interface FakeDaemon {
  running: boolean;
  /** `docker compose ps` itself fails. */
  psFails: boolean;
  /** The pull request's lifecycle state, as `qcr why` says it. */
  state: string;
  rounds: Round[];
  /** `qcr why` exits non-zero. */
  whyFails: boolean;
  /** The dry-run records, in the order the gate wrote them. */
  dryrun: Record<string, unknown>[];
  /** What the daemon answers a `review-now` command with. */
  receipt: "queued" | "refused" | "pending";
  /** The command write exits non-zero. */
  writeFails: boolean;
  /** The command files written, by name. */
  written: string[];
  /** What each command file written carries, in the order written. */
  payloads: Record<string, unknown>[];
}

export interface GithubCall {
  method: string;
  url: string;
  authorization: string | null;
}

export interface HostWorld {
  root: string;
  stateDir: string;
  configPath: string;
  agentDir: string;
  secretsDir: string;
  /** Milliseconds since the epoch; a test moves it. */
  now: number;
  daemon: FakeDaemon;
  /** Every Docker command, as argv. */
  calls: string[][];
  /** Every GitHub request. */
  github: GithubCall[];
  /** What GitHub answers `GET /repos/<repo>` with. */
  repoAnswer: { status: number; body: unknown };
  /** What GitHub answers `GET /user` with: whose token the file holds. */
  userAnswer: { status: number; body: unknown };
  /** What GitHub answers GraphQL's `viewer` with: who the token itself is.
   * Status 0: GitHub cannot be reached. By default the endpoint is not there
   * (404), so a walk that should never ask it is caught asking. */
  viewerAnswer: { status: number; body: unknown };
  /** Real steps that stand in for the fake of the same id. */
  real: SetupStep<OnboardAdapters>[];
  /** The steps that ran, in order, with what each was handed. */
  ran: Ran[];
  /** A step id that fails, and the name of its failed check. */
  fail: { id: string; check: string } | null;
  /** The go-live step refuses with this check name. */
  refuseGoLive: string | null;
  launched: Array<{ kind: WalkKind; token: string }>;
  /** `launch` fails with this. */
  launchError: string | null;
  alivePids: Set<number>;
  /** This boot of the machine, as the checklist lock records it; null: the
   * machine cannot say (the lock then judges a holder by its pid alone). */
  bootId: string | null;
  /** When each process started, by pid; a pid not listed cannot be read. */
  startTimes: Map<number, string>;
  stdin: string;
  logs: string[];
  seeded: number;
  env: Record<string, string | undefined>;
  inImage: boolean;
  /** The ports of the verb's process. */
  ports: HostPorts;
  /** The ports of the walk a verb started. */
  walker(): HostPorts;
  /** What this machine says of a process, for a reader of the lock. */
  facts(): Required<ProcessFacts>;
  config(): string | null;
  writeConfig(text: string): void;
  checklist(): { choices: Record<string, unknown>; steps: Record<string, unknown> } | null;
  close(): void;
}

const ok = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr: string): ProcessResult => ({ code: 1, stdout: "", stderr });

/** A dry-run file's name, as the gate names it: the write time, a sequence
 * and the kind. */
function dryrunName(rec: Record<string, unknown>, i: number): string {
  const at =
    typeof rec["recorded_at"] === "string" ? rec["recorded_at"] : "2026-11-19T12:00:00.000Z";
  const kind = typeof rec["kind"] === "string" ? rec["kind"] : "rec";
  return `${at.replace(/[:.]/g, "-")}-${String(i).padStart(4, "0")}-${kind}.json`;
}

/** The fake Docker: one answer per command the verbs and the steps run. */
function dockerOver(w: HostWorld): OnboardAdapters["runner"] {
  return {
    run: async (cmd, args) => {
      w.calls.push([cmd, ...args]);
      const d = w.daemon;
      if (args.includes("ps")) {
        if (d.psFails) return no("Cannot connect to the Docker daemon");
        return ok(d.running ? JSON.stringify({ Service: "daemon", State: "running" }) : "");
      }
      const script = args[args.length - 1] ?? "";
      // the operator command, written as root
      if (args.includes("-u")) {
        if (d.writeFails) return no("daemon commands dir /opt/qcr/commands missing");
        const name =
          /'([^']+-onboard-reviewnow-\d+\.json)'/.exec(script)?.[1] ??
          /'([^']+-host-settrigger-[a-z]+\.json)'/.exec(script)?.[1];
        if (name !== undefined) d.written.push(name);
        const payload = /^printf '%s\\n' '(\{[^']*\})'/.exec(script)?.[1];
        if (payload !== undefined) d.payloads.push(JSON.parse(payload) as Record<string, unknown>);
        return ok();
      }
      if (script.includes(".result.json")) {
        if (d.receipt === "pending") return ok("pending\n");
        return ok(
          JSON.stringify(
            d.receipt === "queued"
              ? { ok: true, state: "queued" }
              : { ok: false, reason: "PR #7 is closed" },
          ),
        );
      }
      if (args.includes("why")) {
        if (d.whyFails) return no("Error: no such container");
        return ok(JSON.stringify({ known: true, state: d.state, rounds: d.rounds }));
      }
      if (args.includes("ls")) return ok(`${d.dryrun.map(dryrunName).join("\n")}\n`);
      if (args.includes("cat")) {
        const index = d.dryrun.findIndex((rec, i) => script.endsWith(dryrunName(rec, i)));
        return index >= 0 ? ok(JSON.stringify(d.dryrun[index])) : no("no such file");
      }
      return ok();
    },
  };
}

function githubOver(w: HostWorld): typeof fetch {
  const answer = (status: number, body: unknown): Response =>
    new Response(body === null ? null : JSON.stringify(body), { status });
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    w.github.push({ method, url, authorization: headers.get("authorization") });
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) {
      // status 0: GitHub cannot be reached at all
      if (w.repoAnswer.status === 0) throw new Error("getaddrinfo ENOTFOUND api.github.test");
      return answer(w.repoAnswer.status, w.repoAnswer.body);
    }
    if (/\/user$/.test(url)) return answer(w.userAnswer.status, w.userAnswer.body);
    if (/\/graphql$/.test(url) && method === "POST") {
      if (w.viewerAnswer.status === 0) throw new Error("getaddrinfo ENOTFOUND api.github.test");
      return answer(w.viewerAnswer.status, w.viewerAnswer.body);
    }
    return answer(404, { message: "Not Found" });
  }) as typeof fetch;
}

/** Switch-on's step ids as steps that record what they were handed; a step
 * in `w.real` stands in for the fake of its id. */
function fakeSteps(w: HostWorld): SetupStep<OnboardAdapters>[] {
  return SWITCH_ON_ORDER.map((id, i) => w.real.find((s) => s.id === id) ?? fakeStep(w, id, i));
}

function fakeStep(w: HostWorld, id: string, i: number): SetupStep<OnboardAdapters> {
  return {
    id,
    title: `step ${id}`,
    explain: "",
    order: (i + 1) * 10,
    ...(id === PROOF_STEP_ID || id === GO_LIVE_STEP_ID ? { optional: true } : {}),
    run: async (ctx): Promise<StepReport> => {
      w.ran.push({ id, input: { ...ctx.input } });
      if (w.fail?.id === id)
        return { ok: false, checks: [{ name: w.fail.check, ok: false, detail: "it broke" }] };
      if (id === GO_LIVE_STEP_ID && w.refuseGoLive !== null)
        return {
          ok: false,
          checks: [{ name: w.refuseGoLive, ok: false, detail: "the step said no" }],
        };
      return { ok: true, checks: [{ name: id, ok: true, detail: `${id} ok` }] };
    },
    verify: async () => ({ ok: true, checks: [] }),
  };
}

/** A machine with a model login, a token its host wrote, a daemon that runs,
 * and no config yet. */
export function hostWorld(): HostWorld {
  const root = mkdtempSync(join(tmpdir(), "qcr-host-"));
  const stateDir = join(root, "state");
  const configPath = join(root, "config", "config.toml");
  const agentDir = join(root, "pi");
  const secretsDir = join(root, "secrets");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(
    join(agentDir, "auth.json"),
    JSON.stringify({ provider: { type: "oauth", expires: T0 + 3_600_000 } }),
  );
  writeFileSync(join(secretsDir, "github_token"), `${TOKEN}\n`, { mode: 0o600 });

  const w = {
    root,
    stateDir,
    configPath,
    agentDir,
    secretsDir,
    now: T0,
    daemon: {
      running: true,
      psFails: false,
      state: "tracked",
      rounds: [],
      whyFails: false,
      dryrun: [],
      receipt: "queued",
      writeFails: false,
      written: [],
      payloads: [],
    },
    calls: [],
    github: [],
    repoAnswer: {
      status: 200,
      body: { full_name: REPO, default_branch: "trunk", archived: false },
    },
    userAnswer: { status: 200, body: { login: "octo-dev" } },
    viewerAnswer: { status: 404, body: { message: "Not Found" } },
    real: [],
    ran: [],
    fail: null,
    refuseGoLive: null,
    launched: [],
    launchError: null,
    alivePids: new Set([VERB_PID, WALK_PID]),
    bootId: null,
    startTimes: new Map<number, string>(),
    stdin: "",
    logs: [],
    seeded: 0,
    env: {},
    inImage: false,
  } as unknown as HostWorld;

  const runner = dockerOver(w);
  const fetchFn = githubOver(w);
  const adapters = (log?: (line: string) => void): OnboardAdapters => ({
    fetch: fetchFn,
    runner,
    clock: () => new Date(w.now),
    host: { nodeVersion: "v26.1.0", uid: 1000 },
    paths: { stateDir, configPath },
    ...(log ? { log } : {}),
  });
  const portsFor = (pid: number): HostPorts => ({
    now: () => new Date(w.now),
    get env() {
      return w.env;
    },
    pid,
    get inImage() {
      return w.inImage;
    },
    stateDir,
    configPath,
    agentDir,
    secretsDir: () => secretsDir,
    template: () => TEMPLATE,
    read: (path) => readFileSync(path, "utf8"),
    write: (path, text) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, text);
    },
    fetch: fetchFn,
    apiBase: "https://api.github.test",
    timezone: () => "Europe/Warsaw",
    seedStack: () => {
      w.seeded += 1;
    },
    registry: () => new StepRegistry(fakeSteps(w)),
    adapters,
    checklist: (registry, log) => new OnboardingEngine(registry, adapters(log)),
    compose: (args) => runner.run("docker", composeArgs(root, args)),
    launch: (kind, token) => {
      if (w.launchError !== null) return { ok: false, error: w.launchError };
      w.launched.push({ kind, token });
      return { ok: true, pid: WALK_PID };
    },
    stdin: async () => w.stdin,
    alive: (p) => w.alivePids.has(p),
    bootId: () => w.bootId,
    startTime: (p) => w.startTimes.get(p) ?? null,
    sleep: async () => {},
    log: (line) => {
      w.logs.push(line);
    },
  });

  w.ports = portsFor(VERB_PID);
  w.walker = () => portsFor(WALK_PID);
  w.facts = () => ({
    alive: (p) => w.alivePids.has(p),
    bootId: () => w.bootId,
    startTime: (p) => w.startTimes.get(p) ?? null,
  });
  w.config = () => {
    try {
      return readFileSync(configPath, "utf8");
    } catch {
      return null;
    }
  };
  w.writeConfig = (text) => {
    mkdirSync(join(configPath, ".."), { recursive: true });
    writeFileSync(configPath, text);
  };
  w.checklist = () => {
    try {
      return JSON.parse(
        readFileSync(join(stateDir, "onboarding", "checklist.json"), "utf8"),
      ) as ReturnType<HostWorld["checklist"]>;
    } catch {
      return null;
    }
  };
  w.close = () => rmSync(root, { recursive: true, force: true });
  return w;
}

/** A config a setup has written: the template with the repository, in the
 * posture given. */
export function setUpConfig(o: { dryRun?: boolean; hosted?: boolean } = {}): string {
  let text = TEMPLATE.replace(/^repo = ""/m, `repo = "${REPO}"`).replace(
    /^#auth = "app"$/m,
    'auth = "user"',
  );
  if (o.hosted !== false) text = text.replace(/^#token_source = "self"$/m, 'token_source = "host"');
  if (o.dryRun === false) text = text.replace(/^dry_run = true$/m, "dry_run = false");
  return text;
}

/** A finished round and the review the gate recorded for it instead of
 * posting it. */
export function finishedRound(
  pr: number,
  roundNo: number,
  o: { verdict?: string; comments?: number; body?: string; startedAt?: string } = {},
): { round: Round; records: Record<string, unknown>[] } {
  const startedAt = o.startedAt ?? "2026-11-19T12:01:00.000Z";
  const recordedAt = new Date(Date.parse(startedAt) + 120_000).toISOString();
  return {
    round: {
      round_no: roundNo,
      status: "done",
      verdict: o.verdict ?? "REQUEST_CHANGES",
      summary: "two blockers",
      started_at: startedAt,
    },
    records: [
      {
        recorded_at: recordedAt,
        kind: "add_label",
        method: "POST",
        path: `/repos/${REPO}/issues/${pr}/labels`,
        pr,
      },
      {
        recorded_at: recordedAt,
        kind: "create_review",
        method: "POST",
        path: `/repos/${REPO}/pulls/${pr}/reviews`,
        pr,
        body: {
          event: "COMMENT",
          body: o.body ?? "Two blockers.",
          commit_id: "abc123",
          comments: Array.from({ length: o.comments ?? 1 }, (_, i) => ({
            path: `src/file${i}.ts`,
            line: i + 1,
            body: `[blocker] finding ${i}`,
          })),
        },
      },
    ],
  };
}
