// A host's choice of trigger (src/triggerchoice.ts): `host set-trigger`
// sends it through the sealed operator channel, the daemon keeps it in its own
// store, and it wins over the config's `[github] trigger` on a host-managed
// install, across restarts, without config.toml ever being rewritten.
//
//   the one reading    `effectiveTrigger`, which the reconcile pass, the
//                      board export and the home all ask
//   the channel        the `set-trigger` operator command: the operator's
//                      alone, strict, and a forged or malformed file changes
//                      nothing
//   the fingerprint    a set-trigger while a round runs leaves the round's
//                      policy fingerprint (src/execboundary.ts) as it was
//   the restart        a daemon started again on the same store still runs
//                      on the host's choice, over the config's word
//
// Driven over a real store (a file where a restart is the point), fake
// GitHub and Docker, and the daemon's real command watcher.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { hostSetup } from "../src/host/setup.js";
import { hostSetTrigger } from "../src/host/trigger.js";
import { StateStore } from "../src/state.js";
import {
  TRIGGER_CHOICE_DROPPED_EVENT,
  TRIGGER_CHOSEN_EVENT,
  chooseTrigger,
  effectiveTrigger,
  settleTriggerChoice,
  triggerChoiceOf,
  triggerLineOf,
} from "../src/triggerchoice.js";
import { fakeBoardPorts } from "./helpers/board-rig.js";
import { REPO, hostWorld, setUpConfig } from "./helpers/host-rig.js";
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

/** A config's trigger line, where the text says one way or the other. */
const lineOf = (text: string): GithubTrigger | null => {
  const line = triggerLineOf(text);
  if (line === undefined) throw new Error("the config's trigger line cannot be read");
  return line;
};

/** The daemon's handler, as wire.ts builds it, over `store`. */
const handlerOver = (
  store: StateStore,
  hostManaged = true,
  configured: GithubTrigger | null = "label",
): CommandDeps =>
  ({
    setTrigger: (trigger: GithubTrigger, file: string) =>
      chooseTrigger({ store, hostManaged, configured }, trigger, file),
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

  it("a reported choice is re-read: a word, null for none, and nothing else", () => {
    expect(triggerChoiceOf("all")).toBe("all");
    expect(triggerChoiceOf("label")).toBe("label");
    expect(triggerChoiceOf(null)).toBeNull();
    for (const v of [undefined, "ALL", "every", "", true, 1, ["all"], {}])
      expect(triggerChoiceOf(v), JSON.stringify(v)).toBeUndefined();
  });

  // MUTATION: answer "label" for a config with no line in triggerLineOf (as
  // the parsed config does) — a setup that writes `trigger = "label"` over a
  // config that had none cannot be told from it, and this fails (and so does
  // the restart case below).
  it("what a config's text writes on its trigger line: the word, null for none, and undefined where it cannot say", () => {
    expect([...GITHUB_TRIGGERS]).toEqual(["label", "all"]);
    expect(triggerLineOf('[github]\ntrigger = "all"\n')).toBe("all");
    expect(triggerLineOf('[github]\ntrigger = "label"\n')).toBe("label");
    expect(triggerLineOf('[github]\nrepo = "acme/widgets"\n')).toBeNull();
    expect(triggerLineOf("dry_run = true\n")).toBeNull();
    // the trigger label's name is another key
    expect(triggerLineOf('[github]\ntrigger_label = "all"\n')).toBeNull();
    // the shipped template documents the key and leaves it out
    expect(triggerLineOf(readFileSync(join(ROOT, "config.example.toml"), "utf8"))).toBeNull();
    for (const text of [
      "= not toml",
      '[github]\ntrigger = "every"\n',
      '[github]\ntrigger = "ALL"\n',
      "[github]\ntrigger = true\n",
      'github = "a string"\n',
    ])
      expect(triggerLineOf(text), text).toBeUndefined();
    // the reviewer itself reads no line as label
    expect(githubTriggerOf(undefined)).toBe("label");
  });
});

// ---- the store and the handler ----------------------------------------------------------

describe("the daemon keeps the choice in its own store", () => {
  it("none until a host chooses; the last choice stands, and each is logged", () => {
    const store = new StateStore(":memory:");
    expect(store.triggerChoice()).toBeNull();
    expect(
      chooseTrigger({ store, hostManaged: true, configured: "label" }, "all", "a.json"),
    ).toEqual({
      ok: true,
      trigger: "all",
    });
    expect(store.triggerChoice()).toBe("all");
    expect(
      chooseTrigger({ store, hostManaged: true, configured: "label" }, "label", "b.json"),
    ).toMatchObject({
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
    const out = chooseTrigger({ store, hostManaged: false, configured: "label" }, "all", "a.json");
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

  // MUTATION: store a config with no line as `label` in setTriggerChoice
  // (`configured ?? "label"`) — a setup that writes `trigger = "label"` over
  // a config that had no line leaves an earlier `all` standing, and this
  // fails. Or drop the `config_trigger === null` keep: an older build's row
  // is dropped at the first start, and this fails.
  it("is dropped at a start whose config says another trigger than when it was chosen", () => {
    const logs: string[] = [];
    const store = new StateStore(":memory:");
    const settle = (configured: GithubTrigger | null) =>
      settleTriggerChoice({ store, hostManaged: true, configured, log: (l) => logs.push(l) });
    // none made: nothing to drop
    expect(settle("label")).toBeNull();
    // made over a config with no line
    store.setTriggerChoice("all", "a.json", null);
    expect(settle(null)).toBeNull();
    expect(store.triggerChoice()).toBe("all");
    // an install no host manages is not asked
    expect(settleTriggerChoice({ store, hostManaged: false, configured: "label" })).toBeNull();
    expect(store.triggerChoice()).toBe("all");
    // the config now states label: set after the choice
    expect(settle("label")).toBe("all");
    expect(store.triggerChoice()).toBeNull();
    const dropped = store.db
      .prepare("SELECT payload FROM events WHERE kind = ?")
      .all(TRIGGER_CHOICE_DROPPED_EVENT) as Array<{ payload: string }>;
    expect(dropped.map((r) => JSON.parse(r.payload) as unknown)).toEqual([
      { trigger: "all", config_was: null, config_is: "label" },
    ]);
    expect(logs.join("\n")).toMatch(/dropped/);
    // made over `label`, restated `label`: it stands
    store.setTriggerChoice("all", "b.json", "label");
    expect(settle("label")).toBeNull();
    expect(store.triggerChoice()).toBe("all");
    // a row an older build wrote says nothing of the config, and stands
    store.db.prepare("UPDATE trigger_choice SET config_trigger = NULL").run();
    expect(settle("all")).toBeNull();
    expect(store.triggerChoice()).toBe("all");
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
  // restarted daemon has none, and this fails the same way. Or keep no line
  // with the choice (`setTriggerChoice(trigger, file, null)` in
  // chooseTrigger): the restart reads the unchanged `label` line as a later
  // setup, drops the choice, and this fails.
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
        expect(status["trigger_choice"]).toBe("all");
        const board = readFileSync(join(root, "state", "board.json"), "utf8");
        const read = (over: Parameters<typeof fakeBoardPorts>[0]) =>
          boardExport(fakeBoardPorts({ boardFile: async () => known(board), ...over }), 3);
        expect((await read({ config: () => known(HOSTED) })).trigger).toBe("all");
        // the daemon off: the choice cannot be read, so the trigger is unknown
        const off = await read({
          config: () => known(HOSTED),
          daemon: async () => known("stopped" as const),
        });
        expect(off).not.toHaveProperty("trigger");
        expect(
          await read({ config: () => known(HOSTED), daemon: async () => unknown("no docker") }),
        ).not.toHaveProperty("trigger");
        // an install no host manages: the config's own word, whatever the board says
        const own = HOSTED.replace('token_source = "host"\n', "");
        expect((await read({ config: () => known(own) })).trigger).toBe("label");
      } finally {
        store.close();
      }
    },
  );

  // MUTATION: drop the settleTriggerChoice call from createDaemon — the
  // restarted daemon still follows the host's earlier `all` while the config
  // setup wrote says `label`, and this fails.
  it(
    "a later `host setup --trigger` wins at the next start, and the export says what setup wrote",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const w = hostWorld();
      try {
        // the install as its first setup left it: no trigger line
        w.writeConfig(setUpConfig());
        for (const d of ["state/dryrun", "verdict", "inject"])
          mkdirSync(join(w.root, d), { recursive: true });
        const dbPath = join(w.stateDir, "state.db");
        const first = new StateStore(dbPath);
        // the daemon's own reader, over the config as the walk's ingress step
        // leaves it (polling, which a person's login needs)
        const daemonReads = (): Config => {
          const walked = join(w.root, "walked.toml");
          writeFileSync(
            walked,
            w.config()!.replace(/^#\[ingress\]\n#shape = .*$/m, '[ingress]\nshape = "polling"'),
          );
          return loadConfig(walked);
        };
        const running = daemonReads();
        // the parsed config reads no line as label; the line itself is none
        expect(running.github.trigger).toBe("label");
        expect(triggerLineOf(w.config()!)).toBeNull();
        // the host's set-trigger all, as the daemon on that config takes it
        expect(await hostSetTrigger(w.ports, ["all"])).toEqual({ state: "done", trigger: "all" });
        const v = validateCommand(w.daemon.payloads[0], { issuer: "operator" });
        expect(v.ok).toBe(true);
        if (v.ok)
          await executeCommand(v.command, handlerOver(first, true, lineOf(w.config()!)), {
            file: w.daemon.written[0]!,
            issuer: "operator",
          });
        expect(first.triggerChoice()).toBe("all");
        first.close();

        // then setup again, with --trigger label: it rewrites the config's line
        expect(
          await hostSetup(w.ports, ["--repo", REPO, "--auth", "user", "--trigger", "label"]),
        ).toEqual({ state: "started" });
        const cfg = daemonReads();
        expect(cfg.github.trigger).toBe("label");
        expect(triggerLineOf(w.config()!)).toBe("label");

        // the daemon starts again on the same store
        const store = new StateStore(dbPath);
        try {
          const daemon = createDaemon({
            cfg,
            root: w.root,
            store,
            adapter: fakeAdapter(() => [pr(101)]),
            // as the production boot reads it (src/wire.ts)
            triggerLine: lineOf(w.config()!),
            listen: false,
            log: () => {},
            hooks: { async inject() {}, async dispatchRound() {}, async archiveAndClose() {} },
          });
          expect(store.triggerChoice()).toBeNull();
          expect(
            effectiveTrigger({
              hostManaged: true,
              chosen: store.triggerChoice(),
              configured: cfg.github.trigger,
            }),
          ).toBe("label");
          await daemon.reconcile();
          expect(store.getPr(101)).toBeUndefined();
          const board = readFileSync(join(w.stateDir, "board.json"), "utf8");
          const exported = await boardExport(
            fakeBoardPorts({
              boardFile: async () => known(board),
              config: () => known(w.config()!),
            }),
            3,
          );
          expect(exported.trigger).toBe("label");
        } finally {
          store.close();
        }
      } finally {
        w.close();
      }
    },
  );
});
