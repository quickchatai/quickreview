// The TUI's route on one box: which daemon the board reads, and how,
// resolved before the first frame from [tui] plus the facts this checkout
// holds (src/tui/route.ts) — and the setup banner a half-finished onboarding
// puts on the board (src/tui/setupstate.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import type { ChecklistFile } from "../src/onboard/engine.js";
import { statusArgv } from "../src/tui/remote.js";
import {
  COMPOSE_DAEMON_CONTAINER,
  COMPOSE_MEMORY_CONTAINER,
  EMPTY_SSH_HOST,
  RELEASE_STATE_DIR,
  composeMemoryFor,
  dockerSocketPath,
  pinnedVersion,
  probeSocketAccess,
  readRouteFacts,
  resolveTuiRoute,
  type RouteFacts,
} from "../src/tui/route.js";
import { setupLine, setupStateOf } from "../src/tui/setupstate.js";
import { unknownSourceLines, unknownDetailLines } from "../src/tui/board.js";
import { stripAnsi } from "../src/tui/paint.js";
import { configFillStep } from "../src/onboard/steps/configfill.js";
import { githubAccountStep } from "../src/onboard/steps/githubaccount.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const TEMPLATE: TuiConfig = { ...TUI_DEFAULTS, ssh_host: "" }; // config.example.toml's [tui]

function facts(over: Partial<RouteFacts> = {}): RouteFacts {
  return {
    projectDir: "/srv/qcr",
    projectEnv: null,
    checklist: null,
    dockerSocketAccess: undefined,
    ...over,
  };
}

function checklist(choices: Record<string, unknown>, done: string[] = []): ChecklistFile {
  return {
    version: 1,
    created_at: "2026-10-24T00:00:00Z",
    updated_at: "2026-10-24T00:00:00Z",
    completed_at: null,
    choices,
    steps: Object.fromEntries(
      done.map((id) => [
        id,
        { status: "done", completed_at: null, verified_at: null, note: null, data: {} },
      ]),
    ),
  };
}

describe("resolveTuiRoute — the template config before onboarding has filled it", () => {
  it("reads the local compose stack when the checklist recorded the local topology, and says so once", () => {
    const r = resolveTuiRoute(TEMPLATE, facts({ checklist: checklist({ topology: "local" }) }));
    expect(r.unconfigured).toBeUndefined();
    expect(r.cfg.target).toBe("local");
    expect(r.cfg.container).toBe(COMPOSE_DAEMON_CONTAINER);
    expect(r.cfg.memory_container).toBe(COMPOSE_MEMORY_CONTAINER);
    expect(r.cfg.remote_state_dir).toBe(RELEASE_STATE_DIR);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/no ssh_host — reading the local compose stack in \/srv\/qcr/);
    // The status read is the compose daemon's own state volume, no ssh.
    expect(statusArgv(r.cfg)).toEqual([
      "sudo",
      "docker",
      "exec",
      COMPOSE_DAEMON_CONTAINER,
      "cat",
      "/opt/qcr/state/status.json",
    ]);
  });

  it("an unrecorded topology on a compose project (.env pins QCR_VERSION) is local too", () => {
    const r = resolveTuiRoute(TEMPLATE, facts({ projectEnv: "QCR_UID=1000\nQCR_VERSION=1.1.0\n" }));
    expect(r.cfg.target).toBe("local");
  });

  it("with no local evidence it is UNCONFIGURED, with the one precise remedy", () => {
    const r = resolveTuiRoute(TEMPLATE, facts());
    expect(r.cfg.target).toBe("ssh");
    expect(r.unconfigured).toBe(EMPTY_SSH_HOST);
    expect(EMPTY_SSH_HOST).toBe(
      `[tui] ssh_host is empty — set it to the VM's ssh alias, or set [tui] target = "local"`,
    );
    // A recorded VM route is told where its alias comes from.
    const vm = resolveTuiRoute(TEMPLATE, facts({ checklist: checklist({ topology: "vm" }) }));
    expect(vm.unconfigured).toMatch(/set it to the VM's ssh alias in config\.toml/);
  });

  it("never touches a configured ssh route", () => {
    const vm = { ...TUI_DEFAULTS, ssh_host: "review-vm" };
    const r = resolveTuiRoute(
      vm,
      facts({ projectEnv: "QCR_VERSION=1.1.0\n", dockerSocketAccess: true }),
    );
    expect(r.cfg).toEqual(vm);
    expect(r.notes).toEqual([]);
  });
});

describe("resolveTuiRoute — the local route", () => {
  const local: TuiConfig = { ...TUI_DEFAULTS, target: "local", container: "quickreview-daemon-1" };

  it("drops sudo when this user can open the docker socket, and keeps it otherwise", () => {
    expect(resolveTuiRoute(local, facts({ dockerSocketAccess: true })).cfg.sudo_docker).toBe(false);
    expect(resolveTuiRoute(local, facts({ dockerSocketAccess: false })).cfg.sudo_docker).toBe(true);
    expect(resolveTuiRoute(local, facts()).cfg.sudo_docker).toBe(true);
  });

  it("reads the release image's state dir unless the operator set another", () => {
    expect(resolveTuiRoute(local, facts()).cfg.remote_state_dir).toBe("/opt/qcr/state");
    const own = { ...local, remote_state_dir: "/srv/state" };
    expect(resolveTuiRoute(own, facts()).cfg.remote_state_dir).toBe("/srv/state");
    // The legacy container keeps the old in-container path.
    const legacy = { ...local, container: "quickreview-sandbox" };
    expect(resolveTuiRoute(legacy, facts()).cfg.remote_state_dir).toBe("/opt/quickreview/state");
  });

  it("pairs a compose daemon with its memory sidecar, and leaves an explicit one alone", () => {
    expect(composeMemoryFor("quickreview-daemon-1")).toBe("quickreview-memory-1");
    expect(composeMemoryFor("acme-daemon-2")).toBe("acme-memory-2");
    expect(composeMemoryFor("quickreview-sandbox")).toBe("");
    expect(resolveTuiRoute(local, facts()).cfg.memory_container).toBe("quickreview-memory-1");
    const own = { ...local, memory_container: "my-ov" };
    expect(resolveTuiRoute(own, facts()).cfg.memory_container).toBe("my-ov");
  });
});

describe("the route facts — files and one access(2), nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "qcr-route-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads the project .env and the checklist; absent files are null", () => {
    expect(readRouteFacts(root, {}).projectEnv).toBeNull();
    expect(readRouteFacts(root, {}).checklist).toBeNull();
    writeFileSync(join(root, ".env"), 'QCR_VERSION="1.1.0"\n');
    mkdirSync(join(root, "state", "onboarding"), { recursive: true });
    writeFileSync(
      join(root, "state", "onboarding", "checklist.json"),
      JSON.stringify(checklist({ topology: "local" })),
    );
    const f = readRouteFacts(root, { DOCKER_HOST: "tcp://10.0.0.1:2376" });
    expect(pinnedVersion(f.projectEnv)).toBe("1.1.0");
    expect(f.checklist?.choices["topology"]).toBe("local");
    expect(f.dockerSocketAccess).toBeUndefined(); // a remote daemon: nothing to ask
  });

  it("asks the socket this process would use", () => {
    expect(dockerSocketPath({})).toBe("/var/run/docker.sock");
    expect(dockerSocketPath({ DOCKER_HOST: "unix:///run/user/1000/docker.sock" })).toBe(
      "/run/user/1000/docker.sock",
    );
    expect(dockerSocketPath({ DOCKER_HOST: "ssh://box" })).toBeUndefined();
    const err = (code: string) => () => {
      throw Object.assign(new Error(code), { code });
    };
    expect(probeSocketAccess("/s", () => {})).toBe(true);
    expect(probeSocketAccess("/s", err("EACCES"))).toBe(false);
    expect(probeSocketAccess("/s", err("ENOENT"))).toBeUndefined();
    expect(probeSocketAccess(undefined)).toBeUndefined();
  });
});

describe("the setup banner", () => {
  it("is absent with no checklist, and once onboarding is complete", async () => {
    expect(await setupStateOf(null)).toBeUndefined();
    const done = { ...checklist({}), completed_at: "2026-10-24T01:00:00Z" };
    expect(await setupStateOf(done)).toBeUndefined();
    // …but a completion reopened since is unfinished again.
    expect(await setupStateOf({ ...done, reopened_at: "2026-10-24T02:00:00Z" })).toBeDefined();
  });

  it(
    "names the wizard's next enabled step, in the wizard's own order",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const s = await setupStateOf(
        checklist({ topology: "local" }, ["preflight", "topology", "llm_auth"]),
      );
      // The GitHub step (order 33) comes before the config fill.
      expect(s?.next).toBe(githubAccountStep().title);
      expect(setupLine(s!)).toBe(
        `setup not finished — the setup wizard's checklist is not complete (next: ${githubAccountStep().title})`,
      );
      const after = await setupStateOf(
        checklist({ topology: "local" }, ["preflight", "topology", "llm_auth", "github_account"]),
      );
      expect(after?.next).toBe(configFillStep().title);
    },
  );

  it("replaces daemon and ssh troubleshooting where the PR list would be", () => {
    const conn = {
      kind: "unconfigured" as const,
      cause: EMPTY_SSH_HOST,
      remedy: "set [tui] ssh_host in config.toml",
    };
    const lines = unknownSourceLines(conn, 200, { next: "Interview" }).map(stripAnsi);
    expect(lines.join("\n")).toContain(
      "setup not finished — the setup wizard's checklist is not complete (next: Interview)",
    );
    expect(lines.join("\n")).not.toMatch(/ssh|run this:/);
    // Unknown stays unknown: the count line is still the honest one.
    expect(lines[0]).toBe("the daemon has not answered yet");
  });

  it("a local diagnosis quotes docker, never ssh", () => {
    const lines = unknownDetailLines(
      { kind: "local-docker", cause: "x", remedy: "docker info", detail: "permission denied" },
      200,
    ).map(stripAnsi);
    expect(lines.join("\n")).toContain("docker said: permission denied");
  });
});
