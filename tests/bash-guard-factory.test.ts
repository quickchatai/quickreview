// P3.3: createBashGuard, the bash-guard factory. Its config is the three things
// a host decides (the sandbox root, replay, the secrets dirs); the policy is
// code and is never an input. The exec boundary's chains and the P1.9 /proc
// denies are replayed through an in-process SDK session on pi-ai's faux
// provider with the factory attached, so what is proven is that the veto fires
// where an SDK route runs the model's bash, not only in the pure checker.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import {
  CONTAINER_SECRETS_DIR,
  bashGuardConfigFromEnv,
  checkBashCommand,
  createBashGuard,
  type BashGuardConfig,
} from "../extensions/bash-guard.js";
import { PiHost } from "../src/engine/pisdk.js";
import { sdkRuntime } from "../src/engine/sdkruntime.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard();

/** Chains from tests/exec-boundary.test.ts's corpus, one per boundary family. */
const EXEC_BOUNDARY = [
  "gh pr review 5249 --approve",
  `GH_TOKEN="$(scripts/mint-token.sh)" gh api repos/o/n/pulls/5/reviews --input body.json`,
  `git -c "alias.probe=!touch /tmp/pwned" probe`,
  "git --git-dir=/tmp/evil diff --no-index a b",
  "HOME=/tmp/evil git diff --no-index a b",
  `awk 'BEGIN{c="sh"; print "id" | c}'`,
  "sed -n 'w .git/config' payload",
  `find . -maxdepth 0 -fprintf .git/config "x"`,
  "sort -o .git/config payload",
  "cat /opt/quickreview/secrets/app.pem",
];

/** The P1.9 rule: a process's environment, memory and command line. */
const PROC_DENIES = [
  "cat /proc/self/environ",
  "cat /proc/1/environ",
  "tr '\\0' '\\n' < /proc/$PPID/environ",
  "head -c 100 /proc/self/mem",
  "cat /proc/*/cmdline",
  "cd /proc/self && cat environ",
];

/** Reads that are the job, and must stay open. */
const ALLOWED = ["git status", "cat note.txt", "grep -n needle note.txt", "cat /proc/cpuinfo"];

let dir: string;
let host: PiHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bash-guard-factory-"));
  mkdirSync(join(dir, "work"));
  writeFileSync(join(dir, "work", "note.txt"), "needle in a haystack\n");
});
afterEach(() => {
  host?.dispose();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const configFor = (over: Partial<BashGuardConfig> = {}): BashGuardConfig => ({
  sandboxRoot: join(dir, "work"),
  replay: false,
  secretDirs: [],
  ...over,
});

interface Outcome {
  command: string;
  blocked: boolean;
  text: string;
}

/** The commands as the model's bash calls, through an sdkRuntime session with the
 * factory attached; what each call answered, read off the session's own events. */
async function replayThroughSdk(
  commands: readonly string[],
  config: BashGuardConfig,
): Promise<Outcome[]> {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  faux.setResponses([
    ...commands.map((command) =>
      fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
    ),
    fauxAssistantMessage("done"),
  ]);
  host = await PiHost.create({
    agentDir: join(dir, "agent"),
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
    configureModels: (r) => {
      r.registerNativeProvider(faux.provider);
    },
  });
  const eventsFile = join(dir, "events.jsonl");
  const session = await sdkRuntime(host, {
    extras: () => ({ extensions: [createBashGuard(config)] }),
  }).create({
    cwd: join(dir, "work"),
    env: { PATH: process.env["PATH"] },
    model: "faux/m",
    eventsFile,
    stderrFile: join(dir, "stderr.log"),
    limits: { timeoutMs: 20_000 },
  });
  await session.prompt("go");
  await session.dispose();
  const ends = readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>)
    .filter((e) => e["type"] === "tool_execution_end");
  expect(ends).toHaveLength(commands.length);
  return ends.map((e, i) => ({
    command: commands[i]!,
    blocked: e["isError"] === true && /exec policy/.test(JSON.stringify(e["result"])),
    text: JSON.stringify(e["result"]),
  }));
}

describe("[createBashGuard] on an sdkRuntime faux session", () => {
  it("refuses every exec-boundary chain before it runs", async () => {
    const out = await replayThroughSdk(EXEC_BOUNDARY, configFor());
    for (const o of out) expect(o.blocked, o.command).toBe(true);
  });

  it("refuses the /proc environ, mem and cmdline reads (P1.9)", async () => {
    const out = await replayThroughSdk(PROC_DENIES, configFor());
    for (const o of out) {
      expect(o.blocked, o.command).toBe(true);
      expect(o.text, o.command).toMatch(/environment, memory or command line/);
    }
  });

  it("leaves the reads that are the job open", async () => {
    const out = await replayThroughSdk(ALLOWED, configFor());
    for (const o of out) expect(o.blocked, o.command).toBe(false);
    expect(out[1]!.text).toContain("needle in a haystack");
  });

  it("a sanctioned script runs only from the configured sandbox root", async () => {
    const root = join(dir, "work");
    const other = join(dir, "other");
    mkdirSync(join(other), { recursive: true });
    // Nothing is installed at scripts/pr-context.sh, so a script the guard lets
    // through fails on its own ("No such file"), not with an exec policy.
    const inRoot = await replayThroughSdk(
      ["scripts/pr-context.sh 1"],
      configFor({ sandboxRoot: root }),
    );
    expect(inRoot[0]!.blocked).toBe(false);
    host?.dispose();
    rmSync(join(dir, "events.jsonl"));
    const elsewhere = await replayThroughSdk(
      ["scripts/pr-context.sh 1"],
      configFor({ sandboxRoot: other }),
    );
    expect(elsewhere[0]!.blocked).toBe(true);
  });

  it("a replay session sanctions no sandbox script at all", async () => {
    const out = await replayThroughSdk(["scripts/pr-context.sh 1"], configFor({ replay: true }));
    expect(out[0]!.blocked).toBe(true);
    expect(out[0]!.text).toMatch(/regression replay session runs no sandbox script/);
  });
});

describe("[createBashGuard] the config", () => {
  type Handler = (e: unknown, ctx: unknown) => unknown;
  const handlerOf = (config: BashGuardConfig): Handler => {
    let h: Handler | undefined;
    void createBashGuard(config)({
      on: (name: string, fn: Handler) => {
        if (name === "tool_call") h = fn;
      },
    } as never);
    return h!;
  };
  const bash = (h: Handler, command: string, cwd = "/work"): unknown =>
    h({ toolName: "bash", input: { command } }, { cwd });

  it("takes its secrets dirs from the config, and keeps the container mount as a floor", () => {
    const h = handlerOf(configFor({ secretDirs: ["/srv/custom/secrets"] }));
    expect(bash(h, "cat /srv/custom/secrets/token")).toMatchObject({ block: true });
    expect(bash(h, `cat ${CONTAINER_SECRETS_DIR}/app.pem`)).toMatchObject({ block: true });
    expect(bash(h, "cat /srv/custom/public/readme")).toBeUndefined();
    // An empty list cannot open the container's own mount.
    expect(
      bash(handlerOf(configFor({ secretDirs: [] })), "ls /opt/quickreview/secrets/"),
    ).toMatchObject({
      block: true,
    });
  });

  it("expands HOME, XDG_CONFIG_HOME and QCR_INSTALL from pathEnv only", () => {
    const h = handlerOf(
      configFor({
        secretDirs: ["/home/u/.config/qcr/acme/secrets"],
        pathEnv: { HOME: "/home/u", QCR_INSTALL: "acme" },
      }),
    );
    expect(bash(h, "cat $HOME/.config/qcr/acme/secrets/app_id")).toMatchObject({ block: true });
    expect(bash(h, "cat ~/.config/qcr/$QCR_INSTALL/secrets/app_id")).toMatchObject({ block: true });
  });

  it("reads no env past construction", () => {
    const h = handlerOf(configFor({ replay: false }));
    const before = process.env["QCR_REPLAY"];
    process.env["QCR_REPLAY"] = "1";
    try {
      // The root's script is sanctioned from the root; a replay flag set in the
      // process afterwards changes nothing for a factory built without it.
      expect(bash(h, "scripts/pr-context.sh 1", join(dir, "work"))).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env["QCR_REPLAY"];
      else process.env["QCR_REPLAY"] = before;
    }
  });

  it("the env shim's config is what the env describes", () => {
    const cfg = bashGuardConfigFromEnv(
      { QCR_SANDBOX_ROOT: "/sb", QCR_REPLAY: "1", HOME: "/home/u", QCR_INSTALL: "acme" },
      "/cwd",
    );
    expect(cfg).toMatchObject({ sandboxRoot: "/sb", replay: true });
    expect(cfg.secretDirs).toContain(CONTAINER_SECRETS_DIR);
    expect(cfg.secretDirs).toContain("/home/u/.config/qcr/acme/secrets");
    expect(bashGuardConfigFromEnv({}, "/cwd")).toMatchObject({
      sandboxRoot: "/cwd",
      replay: false,
    });
  });

  it("built from the process's env, answers exactly as the pure checker does", () => {
    const h = handlerOf(bashGuardConfigFromEnv(process.env, process.cwd()));
    for (const command of [...EXEC_BOUNDARY, ...PROC_DENIES, ...ALLOWED]) {
      const viaFactory = (bash(h, command, process.cwd()) as { block?: boolean } | undefined)
        ?.block;
      expect(viaFactory === true, command).toBe(!checkBashCommand(command).allowed);
    }
  });
});

describe("[createBashGuard] the policy is not an input", () => {
  it("BashGuardConfig carries no policy field, only the host's three facts", () => {
    const src = readFileSync(
      join(import.meta.dirname, "..", "extensions", "bash-guard.ts"),
      "utf8",
    );
    const body = /export interface BashGuardConfig \{([\s\S]*?)\n\}/.exec(src)![1]!;
    const fields = [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
    expect(fields).toEqual(["sandboxRoot", "replay", "secretDirs", "pathEnv"]);
  });

  it("no profile layer imports the guard", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "profileoverrides.ts"), "utf8");
    expect(src).not.toMatch(/from ["'][^"']*bash-guard/);
  });
});
