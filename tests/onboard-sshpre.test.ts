// the ssh preflight, and above all the passphrase trap.
//
// The failure this exists to prevent is specific: a passphrase-protected key
// with no agent does not fail, it PROMPTS, and a prompt inside a wizard is an
// invisible hang halfway through an Ansible deploy. Two things close it, and
// both are pinned here — every ssh carries `-o BatchMode=yes` (so a prompt
// becomes an explained failure), and the empty-agent case hands the operator
// the exact `ssh-add` line to run IN THEIR OWN SHELL.
//
// Everything faked: one routed fake ProcessRunner answers for ssh, ssh-add and
// ansible-playbook. No test opens a connection, and no test needs a VM.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OnboardingEngine,
  type OnboardAdapters,
  type ProcessResult,
} from "../src/onboard/engine.js";
import {
  SSH_BATCH_OPTS,
  SSH_PREFLIGHT_STEP_ID,
  SSH_USER_CHOICE_KEY,
  classifySshFailure,
  connectionAdvice,
  parseSshAddList,
  parseSshConfig,
  sshArgv,
  sshPreflightStep,
} from "../src/onboard/steps/ssh.js";
import { SSH_ALIAS_CHOICE_KEY, TOPOLOGY_CHOICE_KEY } from "../src/onboard/steps/topology.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-sshpre-"));
  mkdirSync(join(root, "state", "onboarding"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

interface Fakes {
  /** `ssh -G <alias>` */
  config?: ProcessResult;
  /** `ssh-add -l` */
  agent?: ProcessResult;
  /** `ssh <opts> <alias> true` */
  connect?: ProcessResult;
  /** `ssh <opts> <alias> sudo -n true` */
  sudo?: ProcessResult;
  ansible?: ProcessResult;
  sshMissing?: boolean;
}

interface Harness {
  engine: OnboardingEngine;
  calls: string[][];
}

const OK = (stdout = ""): ProcessResult => ({ code: 0, stdout, stderr: "" });

function harness(
  f: Fakes = {},
  choices: Record<string, unknown> = {
    [TOPOLOGY_CHOICE_KEY]: "vm",
    [SSH_ALIAS_CHOICE_KEY]: "review-box",
  },
): Harness {
  const calls: string[][] = [];
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      calls.push([cmd, ...args]);
      if (cmd === "ansible-playbook") return f.ansible ?? OK("ansible-playbook [core 2.17.0]");
      if (cmd === "ssh-add") return f.agent ?? OK("256 SHA256:abc you@laptop (ED25519)");
      if (cmd !== "ssh") return { code: 127, stdout: "", stderr: `unexpected ${cmd}` };
      if (f.sshMissing) return { code: 127, stdout: "", stderr: "ssh: command not found" };
      if (args[0] === "-V")
        return f.config === undefined ? OK("OpenSSH_9.6p1") : OK("OpenSSH_9.6p1");
      if (args[0] === "-G") return f.config ?? OK("hostname 10.0.0.5\nuser deploy\nport 22\n");
      if (args.join(" ").endsWith("sudo -n true")) return f.sudo ?? OK();
      return f.connect ?? OK();
    },
  };
  const adapters: OnboardAdapters = {
    fetch: (() => {
      throw new Error("no network in tests");
    }) as unknown as typeof fetch,
    runner,
    clock: () => new Date("2026-08-30T12:00:00Z"),
    host: { nodeVersion: "v22.5.1", uid: 1000 },
    paths: { stateDir: join(root, "state") },
  };
  const engine = new OnboardingEngine([sshPreflightStep()], adapters);
  (engine as unknown as { checklist: { choices: Record<string, unknown> } }).checklist.choices =
    choices;
  return { engine, calls };
}

describe("BatchMode is structural, not a promise", () => {
  it("the one ssh builder always carries BatchMode and a connect timeout", () => {
    expect(SSH_BATCH_OPTS).toContain("BatchMode=yes");
    expect(sshArgv("review-box", ["true"])).toEqual([
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "review-box",
      "true",
    ]);
    // Remote argv is quoted into one command string, because ssh hands it to a
    // remote shell rather than execing it.
    expect(
      sshArgv("review-box", ["sudo", "docker", "ps", "--format", "{{.Names}} {{.State}}"]).at(-1),
    ).toBe("sudo docker ps --format '{{.Names}} {{.State}}'");
  });

  it("every ssh the step runs has it — the probe, and the sudo check", async () => {
    const h = harness();
    await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    const sshCalls = h.calls.filter((c) => c[0] === "ssh" && c[1] !== "-V" && c[1] !== "-G");
    expect(sshCalls.length).toBeGreaterThanOrEqual(2);
    for (const call of sshCalls) expect(call.join(" ")).toMatch(/-o BatchMode=yes/);
  });
});

describe("the happy path", () => {
  it("passes, and records the login user the ssh config resolves", async () => {
    const h = harness();
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name)).toEqual([
      "ssh-binary",
      "alias",
      "ssh-agent",
      "connection",
      "remote-sudo",
      "ansible",
    ]);
    expect(result.checks.find((c) => c.name === "alias")!.detail).toMatch(/deploy@10\.0\.0\.5:22/);
    expect(h.engine.choices()[SSH_USER_CHOICE_KEY]).toBe("deploy");
    expect(result.checks.find((c) => c.name === "connection")!.detail).toMatch(
      /without prompting for anything/,
    );
  });

  it("a key with no passphrase and no agent is fine — the connection decides, not the agent", async () => {
    const h = harness({ agent: { code: 1, stdout: "", stderr: "The agent has no identities." } });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "ssh-agent")!.detail).toMatch(
      /no passphrase and needs no agent/,
    );
  });
});

describe("a missing key: the passphrase trap, in the open", () => {
  it("an empty agent plus a publickey rejection hands over the exact ssh-add line, for THEIR shell", async () => {
    const h = harness({
      agent: { code: 1, stdout: "", stderr: "The agent has no identities." },
      connect: { code: 255, stdout: "", stderr: "review-box: Permission denied (publickey)." },
    });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    const said = result.checks.find((c) => c.name === "connection")!.detail;
    expect(said).toMatch(/THIS IS THE PASSPHRASE CASE/);
    expect(said).toMatch(/ssh-add ~\/\.ssh\/id_ed25519/);
    expect(said).toMatch(/IN YOUR OWN SHELL/);
    expect(said).toMatch(/BatchMode=yes, so it fails in the open instead of hanging/);
    // Nothing after a failed connection is attempted: no sudo probe on a box
    // we cannot reach.
    expect(h.calls.some((c) => c.join(" ").includes("sudo -n true"))).toBe(false);
  });

  it("no agent at all also gets the ssh-agent line", async () => {
    const h = harness({
      agent: {
        code: 2,
        stdout: "",
        stderr: "Could not open a connection to your authentication agent.",
      },
      connect: { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.failures.join(" ")).toMatch(/eval "\$\(ssh-agent -s\)"/);
  });

  it("a LOADED key that the server rejects gets a different remedy — the public half is not there", async () => {
    const h = harness({
      connect: { code: 255, stdout: "", stderr: "Permission denied (publickey)." },
    });
    const said = (await h.engine.runStep(SSH_PREFLIGHT_STEP_ID)).failures.join(" ");
    expect(said).toMatch(/authorized_keys/);
    expect(said).toMatch(/ssh-copy-id review-box/);
    expect(said).not.toMatch(/THIS IS THE PASSPHRASE CASE/);
  });
});

describe("a dead alias", () => {
  it("an unresolvable name says so and points at ssh -G", async () => {
    const h = harness({
      connect: {
        code: 255,
        stdout: "",
        stderr: "ssh: Could not resolve hostname review-box: Name or service not known",
      },
    });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/cannot resolve "review-box" at all/);
    expect(result.failures.join(" ")).toMatch(/ssh -G review-box/);
  });

  it("a broken ~/.ssh/config stops at the alias check, before anything connects", async () => {
    const h = harness({
      config: {
        code: 255,
        stdout: "",
        stderr: "/home/you/.ssh/config: line 3: Bad configuration option",
      },
    });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => c.name)).toEqual(["ssh-binary", "alias"]);
    expect(result.failures.join(" ")).toMatch(/Bad configuration option/);
  });

  it("an unreachable box is a timeout, not an auth problem", async () => {
    const h = harness({
      connect: {
        code: 255,
        stdout: "",
        stderr: "ssh: connect to host review-box port 22: Connection timed out",
      },
    });
    expect((await h.engine.runStep(SSH_PREFLIGHT_STEP_ID)).failures.join(" ")).toMatch(
      /timed out.*is the machine up/s,
    );
  });

  it("an unaccepted host key is refused deliberately, with the one-time fix", async () => {
    const h = harness({
      connect: { code: 255, stdout: "", stderr: "Host key verification failed." },
    });
    const said = (await h.engine.runStep(SSH_PREFLIGHT_STEP_ID)).failures.join(" ");
    expect(said).toMatch(/refused on the host key/);
    expect(said).toMatch(/ssh review-box true/);
  });
});

describe("the rest of the route's prerequisites", () => {
  it("a sudo password prompt on the server is the same hang, and is caught here", async () => {
    const h = harness({ sudo: { code: 1, stdout: "", stderr: "sudo: a password is required" } });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    const said = result.checks.find((c) => c.name === "remote-sudo")!.detail;
    expect(said).toMatch(/PASSWORD PROMPT would hang/);
    expect(said).toMatch(/passwordless sudo/);
  });

  it("no ansible-playbook on this machine is a plain red check — the deploy IS an Ansible run", async () => {
    const h = harness({ ansible: { code: 127, stdout: "", stderr: "not found" } });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "ansible")!.detail).toMatch(/pipx install ansible/);
  });

  it("no ssh client at all stops immediately", async () => {
    const h = harness({ sshMissing: true });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.checks.map((c) => c.name)).toEqual(["ssh-binary"]);
  });

  it("without a recorded alias it refuses and names the step that records one", async () => {
    // The VM route is chosen but the alias was lost (a hand-edited checklist).
    const h = harness({}, { [TOPOLOGY_CHOICE_KEY]: "vm" });
    const result = await h.engine.runStep(SSH_PREFLIGHT_STEP_ID);
    expect(result.ok).toBe(false);
    expect(result.failures.join(" ")).toMatch(/no ssh alias is recorded/);
    expect(h.calls).toEqual([]);
  });

  it("the step does not exist at all on the laptop route", () => {
    const h = harness({}, { [TOPOLOGY_CHOICE_KEY]: "local" });
    expect(h.engine.list()[0]!.status).toBe("disabled");
  });
});

describe("the pure helpers", () => {
  it("parseSshAddList reads all three of ssh-add's answers", () => {
    expect(
      parseSshAddList(0, "256 SHA256:a you@x (ED25519)\n256 SHA256:b you@y (RSA)\n", ""),
    ).toMatchObject({ kind: "keys", count: 2 });
    expect(parseSshAddList(1, "", "The agent has no identities.").kind).toBe("empty");
    expect(
      parseSshAddList(2, "", "Could not open a connection to your authentication agent.").kind,
    ).toBe("no-agent");
    expect(parseSshAddList(9, "", "something else").kind).toBe("unknown");
  });

  it("classifySshFailure reads ssh's own words", () => {
    expect(classifySshFailure("ssh: Could not resolve hostname box")).toBe("no-such-host");
    expect(classifySshFailure("Host key verification failed.")).toBe("host-key");
    expect(classifySshFailure("Permission denied (publickey).")).toBe("auth");
    expect(classifySshFailure("Connection timed out")).toBe("timeout");
    expect(classifySshFailure("connect to host x port 22: Connection refused")).toBe("refused");
    expect(classifySshFailure("")).toBe("unknown");
  });

  it("connectionAdvice never tells the operator the wizard will type their passphrase", () => {
    const advice = connectionAdvice(
      "auth",
      { kind: "empty", count: 0, detail: "the agent is running but holds no keys" },
      "review-box",
    );
    expect(advice).toMatch(/must never try to type into it/);
  });

  it("parseSshConfig takes the FIRST value of each key, the way ssh does", () => {
    expect(parseSshConfig("hostname 10.0.0.5\nhostname ignored\nuser deploy\nport 2222\n")).toEqual(
      {
        hostname: "10.0.0.5",
        user: "deploy",
        port: "2222",
      },
    );
    expect(parseSshConfig("")).toEqual({ hostname: "", user: "", port: "" });
  });
});
