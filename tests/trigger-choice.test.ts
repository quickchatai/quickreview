// A host's choice of trigger (src/triggerchoice.ts): `host set-trigger`
// sends it through the sealed operator channel, and so does `host setup
// --trigger` once the reviewer is up; the daemon keeps it in its own store,
// the latest choice wins, and it wins over the config's `[github] trigger` (the
// starting value) on a host-managed install, across restarts, without
// config.toml ever being rewritten by it.
//
//   the one reading    `effectiveTrigger`, which the daemon's reconcile pass
//                      and its trigger label follow; it writes the word it
//                      follows for the board export and the home
//   the channel        the `set-trigger` operator command: the operator's
//                      alone, strict, and a forged or malformed file changes
//                      nothing
//   the fingerprint    a set-trigger while a round runs leaves the round's
//                      policy fingerprint (src/execboundary.ts) as it was
//   the restart        a daemon started again on the same store still runs
//                      on the latest choice, over the config's word
//   setup again        a `host setup --trigger` on a running reviewer takes
//                      effect with no restart, and the latest of it and
//                      `set-trigger` is followed
//
// Driven over a real store (a file where a restart is the point), fake
// GitHub and Docker, and the daemon's real command watcher.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import {
  GITHUB_TRIGGERS,
  githubTriggerOf,
  type GithubTrigger,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { boardExport } from "../src/boardexport.js";
import {
  COMMAND_WHITELIST,
  CommandWatcher,
  OPERATOR_COMMANDS,
  authorizeCommand,
  executeCommand,
  processOperatorSeal,
  validateCommand,
  type CommandDeps,
  type OperatorSeal,
} from "../src/commands.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import {
  fingerprintRoundIntegrity,
  integrityChanges,
  splitIntegrityChanges,
} from "../src/execboundary.js";
import type { PrRef } from "../src/github.js";
import { known, unknown } from "../src/home/ports.js";
import { readHostProgress } from "../src/host/record.js";
import { hostSetup } from "../src/host/setup.js";
import { hostSetTrigger } from "../src/host/trigger.js";
import { walkSetup } from "../src/host/walk.js";
import { StateStore } from "../src/state.js";
import {
  TRIGGER_CHOSEN_EVENT,
  chooseTrigger,
  effectiveTrigger,
  followedTriggerOf,
} from "../src/triggerchoice.js";
import { fakeBoardPorts } from "./helpers/board-rig.js";
import { REPO, hostWorld, setUpConfig, type HostWorld } from "./helpers/host-rig.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/** A root-owned operator directory, as the seal reads it. */
const sealed: OperatorSeal = {
  euid: 1001,
  gids: [1001],
  stat: (p) =>
    p.endsWith(".json")
      ? { uid: 0, gid: 0, mode: 0o644, kind: "file" }
      : { uid: 0, gid: 0, mode: 0o755, kind: "dir" },
};

/** The daemon's handler, as wire.ts builds it, over `store`. */
const handlerOver = (store: StateStore, hostManaged = true): CommandDeps =>
  ({
    setTrigger: (trigger: GithubTrigger, file: string) =>
      chooseTrigger({ store, hostManaged }, trigger, file),
  }) as unknown as CommandDeps;

// ---- the one reading ---------------------------------------------------------------

describe("the trigger the reviewer runs on", () => {
  // MUTATION: answer the config's word when the choice cannot be read
  // (`chosen ?? configured` without the undefined check) — a daemon that is
  // off would be reported on the config's `label` while the host chose
  // `all`, and this fails.
  it("on a host-managed install: the host's choice, else the config's word, and unknown when the choice cannot be read", () => {
    for (const configured of [...GITHUB_TRIGGERS, undefined]) {
      for (const chosen of GITHUB_TRIGGERS)
        expect(effectiveTrigger({ hostManaged: true, chosen, configured })).toBe(chosen);
      expect(effectiveTrigger({ hostManaged: true, chosen: null, configured })).toBe(configured);
      expect(
        effectiveTrigger({ hostManaged: true, chosen: undefined, configured }),
      ).toBeUndefined();
    }
  });

  // MUTATION: drop the `hostManaged` check — a choice left in the store of
  // an install its owner took back would outrank the owner's own line, and
  // this fails.
  it("anywhere else: the config's word, whatever the store holds", () => {
    for (const configured of [...GITHUB_TRIGGERS, undefined])
      for (const chosen of [...GITHUB_TRIGGERS, null, undefined])
        expect(effectiveTrigger({ hostManaged: false, chosen, configured })).toBe(configured);
  });

  // MUTATION: default a missing word to "label" in followedTriggerOf — an
  // older daemon's status, which says nothing, reads as `label`, and this
  // fails.
  it("the trigger a daemon wrote it follows is re-read: one of the two words, and nothing else", () => {
    expect(followedTriggerOf("all")).toBe("all");
    expect(followedTriggerOf("label")).toBe("label");
    for (const v of [undefined, null, "ALL", "every", "", true, 1, ["all"], {}])
      expect(followedTriggerOf(v), JSON.stringify(v)).toBeUndefined();
    // the reviewer itself reads a config with no line as label: the starting value
    expect(githubTriggerOf(undefined)).toBe("label");
  });
});

// ---- the store and the handler ----------------------------------------------------------

describe("the daemon keeps the choice in its own store", () => {
  it("none until a host chooses; the last choice stands, and each is logged", () => {
    const store = new StateStore(":memory:");
    expect(store.triggerChoice()).toBeNull();
    expect(chooseTrigger({ store, hostManaged: true }, "all", "a.json")).toEqual({
      ok: true,
      trigger: "all",
    });
    expect(store.triggerChoice()).toBe("all");
    expect(chooseTrigger({ store, hostManaged: true }, "label", "b.json")).toMatchObject({
      ok: true,
    });
    expect(store.triggerChoice()).toBe("label");
    const logged = (
      store.db
        .prepare("SELECT payload FROM events WHERE kind = ? ORDER BY id")
        .all(TRIGGER_CHOSEN_EVENT) as Array<{ payload: string }>
    ).map((r) => JSON.parse(r.payload) as unknown);
    expect(logged).toEqual([
      { trigger: "all", was: null, file: "a.json" },
      { trigger: "label", was: "all", file: "b.json" },
    ]);
    store.close();
  });

  // MUTATION: drop the `hostManaged` refusal from chooseTrigger — a choice
  // nobody can see is kept on an install whose trigger is its owner's line,
  // and this fails.
  it("refuses on an install no host manages, and keeps nothing", () => {
    const store = new StateStore(":memory:");
    const out = chooseTrigger({ store, hostManaged: false }, "all", "a.json");
    expect(out).toMatchObject({ ok: false });
    expect(String(out.reason)).toMatch(/token_source = "host"/);
    expect(store.triggerChoice()).toBeNull();
    store.close();
  });

  // MUTATION: drop the CHECK on trigger_choice.trigger, or the word check in
  // triggerChoice — a row holding another word is read as a choice, and
  // this fails.
  it("holds one of the two words and nothing else", () => {
    const store = new StateStore(":memory:");
    expect(() =>
      store.db
        .prepare(
          "INSERT INTO trigger_choice (id, trigger, chosen_at, file) VALUES (1, 'every', 'x', 'f')",
        )
        .run(),
    ).toThrow(/CHECK/);
    expect(store.triggerChoice()).toBeNull();
    store.close();
  });

  // MUTATION: drop `setTrigger` from the daemon's command deps in wire.ts —
  // the daemon answers every host's set-trigger with "not wired", and this
  // fails.
  it("the production daemon wires the handler, with the install's own marker", () => {
    const wire = readFileSync(join(ROOT, "src", "wire.ts"), "utf8");
    expect(wire).toMatch(
      /setTrigger\(trigger, file\)\s*\{\s*return chooseTrigger\(\s*\{\s*store: d\.store,\s*hostManaged: cfg\.github\.token_source === "host"/,
    );
  });
});

// ---- the channel ------------------------------------------------------------------

describe("the set-trigger command is the operator's alone, and strict", () => {
  it("is an operator command, never in a session's vocabulary", () => {
    expect(OPERATOR_COMMANDS).toContain("set-trigger");
    expect(COMMAND_WHITELIST as readonly string[]).not.toContain("set-trigger");
    for (const trigger of GITHUB_TRIGGERS)
      expect(validateCommand({ command: "set-trigger", trigger }, { issuer: "operator" })).toEqual({
        ok: true,
        command: { command: "set-trigger", trigger },
      });
    for (const v of [
      validateCommand({ command: "set-trigger", trigger: "all" }),
      validateCommand({ command: "set-trigger", trigger: "all" }, { issuer: "session" }),
    ]) {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/OPERATOR's alone/);
    }
    expect(authorizeCommand({ command: "set-trigger", trigger: "all" }, null)).toMatchObject({
      ok: false,
    });
  });

  // MUTATION: take `obj.trigger` as given in validateOperatorCommand (no
  // word check), or drop its fieldError — a forged word or a smuggled key
  // validates, and this fails.
  it("takes one of the two words and no other field", () => {
    const op = { issuer: "operator" as const };
    for (const bad of [
      {},
      { trigger: "every" },
      { trigger: "ALL" },
      { trigger: "" },
      { trigger: true },
      { trigger: ["all"] },
      { trigger: null },
      { trigger: "all", pr: 3 },
      { trigger: "all", dry_run: false },
    ])
      expect(validateCommand({ command: "set-trigger", ...bad }, op).ok, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it("the executor's belt refuses any issuer but the operator", async () => {
    const store = new StateStore(":memory:");
    const deps = handlerOver(store);
    expect(await executeCommand({ command: "set-trigger", trigger: "all" }, deps)).toMatchObject({
      ok: false,
    });
    expect(store.triggerChoice()).toBeNull();
    expect(
      await executeCommand({ command: "set-trigger", trigger: "all" }, {} as CommandDeps, {
        file: "f",
        issuer: "operator",
      }),
    ).toEqual({ ok: false, reason: "set-trigger is not wired on this daemon" });
    expect(
      await executeCommand({ command: "set-trigger", trigger: "all" }, deps, {
        file: "f",
        issuer: "operator",
      }),
    ).toEqual({ ok: true, trigger: "all" });
    expect(store.triggerChoice()).toBe("all");
    store.close();
  });
});

describe("a forged or malformed set-trigger on the channel is ignored", () => {
  let dir: string;
  let store: StateStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-set-trigger-"));
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const resultOf = (name: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dir, "results", `${name}.result.json`), "utf8")) as Record<
      string,
      unknown
    >;
  /** Serve `<dir>/operator` once, under `seal`, with `files` written into it. */
  const serveOperator = async (seal: OperatorSeal, files: Record<string, string>) => {
    const op = join(dir, "operator");
    mkdirSync(op, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(op, `${name}.json`), text);
    const watcher = new CommandWatcher({
      dir: op,
      operator: seal,
      deps: handlerOver(store),
      store,
      sweepIntervalMs: 0,
      parseAttempts: 1,
      parseRetryMs: 1,
      log: () => {},
    });
    await watcher.sweep();
    watcher.stop();
  };

  // MUTATION: serve `set-trigger` from a session's directory (validate it
  // without the operator's issuer), or loosen its schema — a choice lands in
  // the store from a file no host wrote, and this fails.
  it("on the sealed channel, in a session's directory, and in an unsealed one", async () => {
    await serveOperator(sealed, {
      f1: JSON.stringify({ command: "set-trigger", trigger: "every" }),
      f2: JSON.stringify({ command: "set-trigger", trigger: "all", dry_run: false }),
      f3: JSON.stringify({ command: "set-trigger" }),
      f4: '{"command": "set-trigger", "trigger": "all"',
    });
    for (const f of ["f1", "f2", "f3"])
      expect(resultOf(f), f).toMatchObject({ ok: false, issuer: "operator" });
    expect(store.triggerChoice()).toBeNull();

    // a session's command file
    writeFileSync(join(dir, "s1.json"), JSON.stringify({ command: "set-trigger", trigger: "all" }));
    const session = new CommandWatcher({
      dir,
      deps: handlerOver(store),
      store,
      parseAttempts: 1,
      parseRetryMs: 1,
      log: () => {},
    });
    await session.sweep();
    session.stop();
    expect(resultOf("s1")).toMatchObject({ ok: false, issuer: "session" });

    // an operator directory this process owns: no seal, served as a session's
    await serveOperator(processOperatorSeal(), {
      u1: JSON.stringify({ command: "set-trigger", trigger: "all" }),
    });
    expect(resultOf("u1")).toMatchObject({ ok: false, issuer: "session" });
    expect(store.triggerChoice()).toBeNull();

    // and the sealed channel's well-formed command is taken
    await serveOperator(sealed, {
      t1: JSON.stringify({ command: "set-trigger", trigger: "all" }),
    });
    expect(resultOf("t1")).toMatchObject({
      ok: true,
      issuer: "operator",
      command: "set-trigger",
      trigger: "all",
    });
    expect(store.triggerChoice()).toBe("all");
  });
});

// ---- the round fingerprint ----------------------------------------------------------

describe("a set-trigger while a round is in flight", () => {
  // MUTATION: write the trigger into config.toml again, from hostSetTrigger
  // or from chooseTrigger (the old one-key edit) — the located config's hash
  // moves between the round's baseline and its re-hash, the round ends with
  // policy_surface_modified, and this fails.
  it("leaves the round's policy fingerprint as it was", async () => {
    const w = hostWorld();
    try {
      w.writeConfig(setUpConfig());
      const env = { HOME: w.root, QCR_CONFIG: w.configPath };
      const opts = { clonePath: join(w.root, "clone"), sandboxRoot: w.root, installEnv: env };
      // the baseline dispatch takes as the round starts
      const baseline = await fingerprintRoundIntegrity(opts);
      expect(Object.keys(baseline.files)).toContain(w.configPath);

      // the host's verb, then the daemon's side of the command it wrote, on
      // the store under the sandbox's own state directory
      expect(await hostSetTrigger(w.ports, ["all"])).toEqual({ state: "done", trigger: "all" });
      expect(w.daemon.payloads).toEqual([{ command: "set-trigger", trigger: "all" }]);
      const store = new StateStore(join(w.stateDir, "state.db"));
      try {
        const v = validateCommand(w.daemon.payloads[0], { issuer: "operator" });
        expect(v.ok).toBe(true);
        if (v.ok)
          expect(
            await executeCommand(v.command, handlerOver(store), {
              file: w.daemon.written[0]!,
              issuer: "operator",
            }),
          ).toMatchObject({ ok: true });
        expect(store.triggerChoice()).toBe("all");
      } finally {
        store.close();
      }

      // the round's end re-hash: nothing on the policy surface moved
      const after = await fingerprintRoundIntegrity(opts);
      const changes = integrityChanges(baseline, after);
      expect(splitIntegrityChanges(changes, w.root, env).policy).toEqual([]);
      expect(after.digest).toBe(baseline.digest);

      // the control: the same choice written into the config is the alarm
      w.writeConfig(w.config()!.replace(/^#trigger = "label"$/m, 'trigger = "all"'));
      const edited = integrityChanges(baseline, await fingerprintRoundIntegrity(opts));
      expect(splitIntegrityChanges(edited, w.root, env).policy.map((c) => c.path)).toEqual([
        w.configPath,
      ]);
    } finally {
      w.close();
    }
  });
});

// ---- the restart ---------------------------------------------------------------------

const pr = (number: number, over: Partial<PrRef> = {}): PrRef => ({
  number,
  title: `PR ${number}`,
  author: "someone",
  head_sha: `head${number}`,
  base_ref: "main",
  body: "",
  updated_at: "2026-11-19T09:00:00Z",
  state: "open",
  draft: false,
  merged: false,
  labels: [],
  ...over,
});

/** GitHub as the daemon reads it: the open list, and no label on anything.
 * Every write answers as the dry-run gate does. */
function fakeAdapter(open: () => PrRef[]): DaemonAdapter {
  const dry = async (): Promise<GateResult> => ({ executed: false });
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => open(),
    getPr: async (n: number) => {
      const found = open().find((p) => p.number === n);
      if (!found) throw new Error(`no such PR ${n}`);
      return found;
    },
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [
      { filename: "src/app.ts", additions: 5, deletions: 1, status: "modified" },
    ],
    addLabel: dry,
    removeLabel: dry,
    deleteTeamReviewRequest: dry,
    requestEscalationReview: async () => ({ skipped: null, result: await dry() }),
    createReview: dry,
  } as unknown as DaemonAdapter;
}

/** A host-managed config that says `label`, as the board export reads it. */
const HOSTED = [
  "dry_run = false",
  "",
  "[github]",
  'repo = "acme/webapp"',
  'token_source = "host"',
  'auth = "user"',
  'bot_login = "octo-dev"',
  'trigger_label = "AI review requested"',
  "",
].join("\n");

describe("after a daemon restart the stored trigger still wins", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-trigger-restart-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // MUTATION: read `cfg.github.trigger` alone in reconcileOnce (ignore the
  // store's choice) — the restarted daemon runs on the config's `label` and
  // takes nothing, and this fails. Or keep the choice in memory only: the
  // restarted daemon has none, and this fails the same way. Or write the
  // config's word into the snapshot's `trigger` — the export says `label`
  // while the daemon follows `all`, and this fails.
  it(
    "over the config's word, with no file rewritten, in the reconcile pass and the board",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const loaded = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
      const cfg: Config = {
        ...loaded,
        dry_run: false,
        github: { ...loaded.github, token_source: "host", trigger: "label" },
      };
      const dbPath = join(root, "state", "state.db");

      // the first run: the host's choice arrives on the sealed channel
      const first = new StateStore(dbPath);
      const op = join(root, "commands", "operator");
      mkdirSync(op, { recursive: true });
      writeFileSync(
        join(op, "t1.json"),
        JSON.stringify({ command: "set-trigger", trigger: "all" }),
      );
      const watcher = new CommandWatcher({
        dir: op,
        operator: sealed,
        deps: handlerOver(first),
        store: first,
        sweepIntervalMs: 0,
        log: () => {},
      });
      await watcher.sweep();
      watcher.stop();
      expect(first.triggerChoice()).toBe("all");
      first.close();

      // the daemon starts again, on the same store and a config that says label
      const store = new StateStore(dbPath);
      try {
        expect(store.triggerChoice()).toBe("all");
        const daemon = createDaemon({
          cfg,
          root,
          store,
          adapter: fakeAdapter(() => [pr(101), pr(102, { draft: true })]),
          listen: false,
          log: () => {},
          hooks: { async inject() {}, async dispatchRound() {}, async archiveAndClose() {} },
        });
        await daemon.reconcile();
        const taken = (
          store.db
            .prepare("SELECT pr FROM events WHERE kind = 'trigger_all_taken' ORDER BY id")
            .all() as Array<{ pr: number }>
        ).map((r) => r.pr);
        expect(taken).toEqual([101]);
        expect(["queued", "reviewing"]).toContain(store.getPr(101)?.state);
        expect(store.getPr(102)).toBeUndefined();

        // what the daemon reports, and what a host reads of it
        const status = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as Record<string, unknown>;
        expect(status["trigger"]).toBe("all");
        const board = readFileSync(join(root, "state", "board.json"), "utf8");
        const read = (over: Parameters<typeof fakeBoardPorts>[0]) =>
          boardExport(fakeBoardPorts({ boardFile: async () => known(board), ...over }), 3);
        expect((await read({ config: () => known(HOSTED) })).trigger).toBe("all");
        // the daemon off: nothing it follows can be read, so the trigger is unknown
        const off = await read({
          config: () => known(HOSTED),
          daemon: async () => known("stopped" as const),
        });
        expect(off).not.toHaveProperty("trigger");
        expect(
          await read({ config: () => known(HOSTED), daemon: async () => unknown("no docker") }),
        ).not.toHaveProperty("trigger");
      } finally {
        store.close();
      }
    },
  );
});

// ---- setup again ----------------------------------------------------------------------

describe("the latest of setup's --trigger and set-trigger is followed, on a running reviewer", () => {
  let w: HostWorld;
  let store: StateStore;
  let dbPath: string;
  /** The open pull requests GitHub lists. */
  let open: PrRef[];
  const ARGS = ["--repo", REPO, "--auth", "user"];
  beforeEach(() => {
    w = hostWorld();
    for (const d of ["state/dryrun", "verdict", "inject"])
      mkdirSync(join(w.root, d), { recursive: true });
    dbPath = join(w.stateDir, "state.db");
    store = new StateStore(dbPath);
    open = [pr(101)];
    // the daemon reads its sealed channel as each file lands, with the
    // handler wire.ts builds, over whichever store it has open now
    w.daemon.serve = async (payload, name) => {
      const v = validateCommand(payload, { issuer: "operator" });
      if (!v.ok) return { ok: false, reason: v.reason };
      return (await executeCommand(v.command, handlerOver(store), {
        file: name,
        issuer: "operator",
      })) as unknown as Record<string, unknown>;
    };
  });
  afterEach(() => {
    store.close();
    w.close();
  });

  /** The daemon's own reader over the config as it is now, as the walk's
   * ingress step leaves it (polling, which a person's login needs). */
  const daemonReads = (): Config => {
    const walked = join(w.root, "walked.toml");
    writeFileSync(
      walked,
      w.config()!.replace(/^#\[ingress\]\n#shape = .*$/m, '[ingress]\nshape = "polling"'),
    );
    return loadConfig(walked);
  };
  /** The daemon, started on the config as it is now and the store as it is. */
  const start = () =>
    createDaemon({
      cfg: daemonReads(),
      root: w.root,
      store,
      adapter: fakeAdapter(() => open),
      listen: false,
      log: () => {},
      hooks: { async inject() {}, async dispatchRound() {}, async archiveAndClose() {} },
    });
  /** What a host reads: the export over the daemon's own board. */
  const exported = async (daemon: "running" | "stopped" = "running") =>
    boardExport(
      fakeBoardPorts({
        boardFile: async () => known(readFileSync(join(w.stateDir, "board.json"), "utf8")),
        config: () => known(w.config()!),
        daemon: async () => known(daemon),
      }),
      3,
    );
  /** `host setup` and the walk it starts, to its end. */
  const setUp = async (trigger: GithubTrigger): Promise<void> => {
    expect(await hostSetup(w.ports, [...ARGS, "--trigger", trigger])).toEqual({
      state: "started",
    });
    expect(await walkSetup(w.walker(), w.launched.at(-1)!.token)).toBe(0);
    expect(readHostProgress(w.stateDir, w.facts())).toEqual({ setup: { state: "done" } });
  };
  const sent = () =>
    w.daemon.payloads.filter((p) => p["command"] === "set-trigger").map((p) => p["trigger"]);
  const lineOf = (): unknown =>
    ((parse(w.config()!) as Record<string, Record<string, unknown>>)["github"] ?? {})["trigger"];

  // MUTATION: drop the `set_trigger` step from walkSetup (hand nothing) —
  // the running daemon goes on following `label` after setup said `all`, and
  // this fails at the first pass after setup. Or prefer the config's word
  // over the stored choice in effectiveTrigger (`configured ?? chosen`) — the
  // restarted daemon follows the file's `all` over the later `label`, and
  // this fails after the restart.
  it(
    "setup --trigger all, then set-trigger label, then a restart: label",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      // a reviewer that runs, set up without a trigger line: label
      w.writeConfig(setUpConfig({ dryRun: false }));
      let daemon = start();
      await daemon.reconcile();
      expect(store.getPr(101)).toBeUndefined();
      expect((await exported()).trigger).toBe("label");

      // setup again, with --trigger all: the config's starting value, and the
      // same word handed to the running daemon, which follows it at once
      await setUp("all");
      expect(lineOf()).toBe("all");
      expect(sent()).toEqual(["all"]);
      expect(store.triggerChoice()).toBe("all");
      await daemon.reconcile();
      expect(["queued", "reviewing"]).toContain(store.getPr(101)?.state);
      expect((await exported()).trigger).toBe("all");

      // then set-trigger label: the file still says all, the daemon follows label
      expect(await hostSetTrigger(w.ports, ["label"])).toEqual({ state: "done", trigger: "label" });
      await daemon.reconcile();
      expect(lineOf()).toBe("all");
      expect((await exported()).trigger).toBe("label");

      // the daemon starts again, on the same store and the config that says all
      store.close();
      store = new StateStore(dbPath);
      expect(daemonReads().github.trigger).toBe("all");
      daemon = start();
      open = [pr(101), pr(102)];
      await daemon.reconcile();
      expect(store.triggerChoice()).toBe("label");
      expect(store.getPr(102)).toBeUndefined();
      expect((await exported()).trigger).toBe("label");
      // with the daemon off, nothing it follows can be read
      expect(await exported("stopped")).not.toHaveProperty("trigger");
    },
  );

  // The case a comparison of the config's line could not tell: setup restates
  // the very line a later set-trigger was made over.
  // MUTATION: keep setup's `--trigger` out of the host record in hostSetup
  // (or drop the `set_trigger` step) — the walk hands nothing, the daemon
  // keeps following the earlier `label`, and this fails.
  it(
    "setup --trigger all after set-trigger label, on a running reviewer: all, with no restart",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      w.writeConfig(setUpConfig({ dryRun: false }));
      const daemon = start();
      // a first setup with --trigger all, then the host's set-trigger label
      await setUp("all");
      expect(lineOf()).toBe("all");
      expect(await hostSetTrigger(w.ports, ["label"])).toEqual({ state: "done", trigger: "label" });
      await daemon.reconcile();
      expect(store.getPr(101)).toBeUndefined();
      expect((await exported()).trigger).toBe("label");

      // setup again with the line the config already says: the file does not
      // change, and the word is handed all the same
      const before = w.config();
      await setUp("all");
      expect(w.config()).toBe(before);
      expect(sent()).toEqual(["all", "label", "all"]);
      expect(store.triggerChoice()).toBe("all");
      // the same daemon, no restart
      await daemon.reconcile();
      expect(["queued", "reviewing"]).toContain(store.getPr(101)?.state);
      expect((await exported()).trigger).toBe("all");
    },
  );

  // MUTATION: hand setup's word when none was given (the config's line, say)
  // — a re-run of setup with no --trigger undoes the host's later choice,
  // and this fails.
  it("setup with no --trigger hands nothing, and the daemon's choice stands", async () => {
    w.writeConfig(setUpConfig());
    expect(await hostSetTrigger(w.ports, ["all"])).toEqual({ state: "done", trigger: "all" });
    expect(await hostSetup(w.ports, ARGS)).toEqual({ state: "started" });
    expect(await walkSetup(w.walker(), w.launched.at(-1)!.token)).toBe(0);
    expect(sent()).toEqual(["all"]);
    expect(store.triggerChoice()).toBe("all");
  });
});
