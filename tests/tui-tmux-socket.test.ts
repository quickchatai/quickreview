// The containerised TUI's companion: a tmux server in the companion
// container, a socket in a shared named volume, and a TUI container that drives
// it with `tmux -S` instead of `docker exec`. No docker.sock in either.
//
// What is pinned, with no docker, no image and no model:
//   - the lifecycle in `tmux-socket` mode: the volume and the socket env in the
//     run argv, every tmux argv on `-S`, the mount-drift check over the new
//     mount (a container from before it drifts and is recreated), and the
//     lifecycle that never calls docker (the wrapper ran the container);
//   - the runner that turns `docker exec <c> tmux …` into `tmux -S <sock> …`,
//     refuses everything else by name, and never lets a tmux client birth a
//     server in the TUI container (against a real tmux on a scratch socket);
//   - the plan the host wrapper reads (`qcr companion plan`): the companion's
//     run, the dirs the TUI shares, no ssh, no agent, no docker.sock.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { COMPANION_DEFAULTS, type CompanionConfig } from "../src/config.js";
import {
  CompanionLifecycle,
  CONTAINER,
  TMUX_SOCKET_ENV,
  tmuxSocketPath,
  tmuxVolume,
  type CompanionFs,
  type DockerResult,
  type DockerRunner,
} from "../src/tui/companion.js";
import {
  companionPlan,
  laptopCompanionConfig,
  laptopInstallEnv,
  laptopLifecycle,
  renderPlan,
} from "../src/tui/companionplan.js";
import { tmuxSocketRunner } from "../src/tui/tmuxsocket.js";

const OK: DockerResult = { ok: true, stdout: "", stderr: "", code: 0 };
const FAIL: DockerResult = { ok: false, stdout: "", stderr: "no server running", code: 1 };

const CFG: CompanionConfig = {
  ...COMPANION_DEFAULTS,
  repo_dir: "/host/ws",
  tracker_dir: "",
  tracker_docs_dir: "",
  reviewed_repo_dir: "",
  evidence_dir: "/host/evidence",
  feed_dir: "/host/feed",
  alerts_dir: "/host/alerts",
};
const HOST_ENV = { HOME: "/host/home" };
const NO_FS: CompanionFs = { exists: () => false, read: () => undefined, mode: () => undefined };
const SOCKET = tmuxSocketPath(CFG);

function socketLifecycle(answers: Array<(argv: string[]) => DockerResult | undefined> = []) {
  const calls: string[][] = [];
  const runner: DockerRunner = async (argv) => {
    calls.push(argv);
    for (const a of answers) {
      const r = a(argv);
      if (r) return r;
    }
    return FAIL;
  };
  const lc = new CompanionLifecycle(
    CFG,
    runner,
    HOST_ENV,
    () => {},
    NO_FS,
    () => "",
    "tmux-socket",
  );
  return { lc, calls };
}
const dockerLifecycle = () =>
  new CompanionLifecycle(
    CFG,
    async () => FAIL,
    HOST_ENV,
    () => {},
    NO_FS,
    () => "",
  );

const volumes = (argv: string[]): string[] => argv.filter((_, i) => argv[i - 1] === "--volume");
const envs = (argv: string[]): string[] => argv.filter((_, i) => argv[i - 1] === "--env");

describe("the lifecycle in tmux-socket mode", () => {
  it("runs the companion with the tmux volume and the socket its entrypoint listens on", () => {
    const argv = socketLifecycle().lc.runArgv();
    expect(volumes(argv)).toContain(`${tmuxVolume(CFG)}:${CONTAINER.tmuxDir}:rw`);
    expect(envs(argv)).toContain(`${TMUX_SOCKET_ENV}=${SOCKET}`);
    expect(SOCKET).toBe("/run/qcr-tmux/companion.sock");
    // wrapper-run: hardened like every container the wrapper starts
    expect(argv).toEqual(expect.arrayContaining(["--init", "--cap-drop", "ALL"]));
    expect(argv.join(" ")).toContain("--security-opt no-new-privileges");
  });

  it("the docker mode is unchanged: no volume, no socket env, no extra flags", () => {
    const argv = dockerLifecycle().runArgv();
    expect(volumes(argv).join(" ")).not.toContain("tmux");
    expect(envs(argv).join(" ")).not.toContain(TMUX_SOCKET_ENV);
    expect(argv).not.toContain("--cap-drop");
  });

  it("holds no ssh, no agent and no docker.sock, whatever the host has", () => {
    const lc = new CompanionLifecycle(
      CFG,
      async () => FAIL,
      { ...HOST_ENV, SSH_AUTH_SOCK: "/tmp/agent.sock", DOCKER_HOST: "unix:///var/run/docker.sock" },
      () => {},
      NO_FS,
      () => "",
      "tmux-socket",
    );
    const flat = lc.runArgv().join(" ");
    expect(flat).not.toMatch(/ssh|agent|docker\.sock|known_hosts/i);
  });

  it("drives tmux over -S in every argv it builds; the docker mode stays on the default socket", () => {
    const { lc } = socketLifecycle();
    expect(lc.spawnArgv().slice(0, 7)).toEqual([
      "exec",
      CFG.container_name,
      "tmux",
      "-S",
      SOCKET,
      "new-session",
      "-d",
    ]);
    expect(lc.attachArgv()).toEqual([
      "exec",
      "-it",
      CFG.container_name,
      "tmux",
      "-S",
      SOCKET,
      "attach",
      "-t",
      CFG.session,
    ]);
    expect(dockerLifecycle().spawnArgv().slice(0, 4)).toEqual([
      "exec",
      CFG.container_name,
      "tmux",
      "new-session",
    ]);
  });

  describe("mount drift", () => {
    const current = (lc: CompanionLifecycle): Map<string, string> => lc.expectedMounts();

    it("expects the tmux volume, by name", () => {
      const { lc } = socketLifecycle();
      expect(lc.expectedMounts().get(CONTAINER.tmuxDir)).toBe(tmuxVolume(CFG));
      expect(lc.mountDrift(current(lc))).toEqual([]);
    });

    it("a container made before the socket volume drifts: the volume is missing", () => {
      const { lc } = socketLifecycle();
      const old = current(lc);
      old.delete(CONTAINER.tmuxDir);
      expect(lc.mountDrift(old)).toEqual([`missing ${CONTAINER.tmuxDir}`]);
    });

    it("a docker-mode container is stale against the socket mode, and the other way round", () => {
      const socket = socketLifecycle().lc;
      const docker = dockerLifecycle();
      expect(socket.mountDrift(docker.expectedMounts())).toEqual([`missing ${CONTAINER.tmuxDir}`]);
      expect(docker.mountDrift(socket.expectedMounts())).toEqual([`stale ${CONTAINER.tmuxDir}`]);
    });

    it("the volume pointing at another volume, an ssh mount or a docker.sock bind are all drift", () => {
      const { lc } = socketLifecycle();
      const m = current(lc);
      m.set(CONTAINER.tmuxDir, "someone-elses-volume");
      m.set("/home/qcr/.ssh", "/home/user/.ssh");
      m.set("/var/run/docker.sock", "/var/run/docker.sock");
      expect(lc.mountDrift(m)).toEqual([
        `${CONTAINER.tmuxDir} points at someone-elses-volume, expected ${tmuxVolume(CFG)}`,
        "stale /home/qcr/.ssh",
        "stale /var/run/docker.sock",
      ]);
    });
  });

  describe("with no docker (the TUI container)", () => {
    it("ensureUp waits for the tmux server and calls no docker verb", async () => {
      const { lc, calls } = socketLifecycle([
        (argv) => (argv.includes("show-options") ? OK : undefined),
      ]);
      const progress: string[] = [];
      expect(await lc.ensureUp((l) => progress.push(l))).toBe("adopted");
      expect(calls).toEqual([
        ["exec", CFG.container_name, "tmux", "-S", SOCKET, "show-options", "-s", "exit-empty"],
      ]);
      expect(progress[0]).toContain("run by the qcr wrapper");
    });

    it("a server that never answers is a named failure, not a hang", async () => {
      const { lc } = socketLifecycle();
      lc.wrapperStartWaitMs = 30;
      await expect(lc.ensureUp()).rejects.toThrow(/tmux server is not answering on .*qcr wrapper/);
    });

    it("never stops the container it did not run", async () => {
      const { lc, calls } = socketLifecycle();
      await lc.gracefulStop();
      expect(calls).toEqual([]);
    });

    it("spawnPi births the session only when it is not there, over -S", async () => {
      let sessions = 0;
      const { lc, calls } = socketLifecycle([
        (argv) => {
          if (argv.includes("has-session")) return sessions > 0 ? OK : FAIL;
          if (argv.includes("new-session")) {
            sessions++;
            return OK;
          }
          return undefined;
        },
      ]);
      expect(await lc.spawnPi()).toBe(true);
      expect(await lc.spawnPi()).toBe(false);
      expect(calls.filter((c) => c.includes("new-session"))).toHaveLength(1);
      expect(calls.every((c) => c.includes("-S") && c.includes(SOCKET))).toBe(true);
    });

    it("spawnPi waits out a server that is not up yet, once", async () => {
      let up = false;
      const { lc } = socketLifecycle([
        (argv) => {
          if (argv.includes("show-options")) return up ? OK : FAIL;
          if (argv.includes("has-session")) return FAIL;
          if (argv.includes("new-session")) {
            if (up) return OK;
            up = true;
            return {
              ok: false,
              stdout: "",
              stderr: "the companion's tmux server is not up on x (is not running)",
              code: null,
            };
          }
          return undefined;
        },
      ]);
      expect(await lc.spawnPi()).toBe(true);
    });
  });
});

// ---- the runner ----------------------------------------------------------------

describe("tmuxSocketRunner: docker exec argv, run on the shared socket", () => {
  function rig(answer: (argv: string[]) => DockerResult = () => OK) {
    const ran: string[][] = [];
    const runner = tmuxSocketRunner("/run/qcr-tmux/c.sock", "qcr-companion", {
      run: async (argv) => {
        ran.push(argv);
        return answer(argv);
      },
    });
    return { runner, ran };
  }

  it("puts -S in front of a tmux command", async () => {
    const { runner, ran } = rig();
    await runner(["exec", "qcr-companion", "tmux", "send-keys", "-t", "companion", "-l", "hi"]);
    expect(ran).toEqual([
      ["-S", "/run/qcr-tmux/c.sock", "send-keys", "-t", "companion", "-l", "hi"],
    ]);
  });

  it("keeps a -S the caller already chose", async () => {
    const { runner, ran } = rig();
    await runner(["exec", "qcr-companion", "tmux", "-S", "/run/qcr-tmux/c.sock", "has-session"]);
    expect(ran).toEqual([["-S", "/run/qcr-tmux/c.sock", "has-session"]]);
  });

  // A fake tmux that behaves like a server: run-shell runs the script, which
  // loads its output into a named buffer; show-buffer and delete-buffer read it.
  function scriptRig(output: string, status: number, errText = "") {
    const buffers = new Map<string, string>();
    const r = rig((argv) => {
      const word = argv[2];
      if (word === "run-shell") {
        const name = /load-buffer -b (\S+) -/.exec(argv[3]!)?.[1];
        buffers.set(name!, `${output}x${status}\n${name}\n${errText}`);
        return OK;
      }
      if (word === "show-buffer") return { ...OK, stdout: buffers.get(argv[4]!) ?? "" };
      if (word === "delete-buffer") {
        buffers.delete(argv[4]!);
        return OK;
      }
      return FAIL;
    });
    return { ...r, buffers };
  }

  it("runs a sh -c script inside the companion's tmux server and reads its stdout from a buffer", async () => {
    const { runner, ran, buffers } = scriptRig("/home/qcr/.pi/x.jsonl\n", 0);
    const script = "ls -t /home/qcr/.pi | head -1";
    const res = await runner(["exec", "qcr-companion", "sh", "-c", script]);
    expect(ran.map((a) => a[2])).toEqual(["run-shell", "show-buffer", "delete-buffer"]);
    expect(ran.every((a) => a[0] === "-S" && a[1] === "/run/qcr-tmux/c.sock")).toBe(true);
    expect(ran[0]![3]).toContain(`sh -c '${script}'`);
    expect(res).toEqual({ ok: true, stdout: "/home/qcr/.pi/x.jsonl\n", stderr: "", code: 0 });
    expect(buffers.size).toBe(0);
  });

  it("a failing script leaves its own output and an exit code", async () => {
    const { runner } = scriptRig("partial\n", 3);
    const res = await runner(["exec", "qcr-companion", "sh", "-c", "echo partial; exit 3"]);
    expect(res).toEqual({ ok: false, stdout: "partial\n", stderr: "exit 3", code: 3 });
  });

  it("hands back the script's stderr, on success and beside the exit code on failure", async () => {
    const ok = scriptRig("out\n", 0, "warning: x\n");
    expect(await ok.runner(["exec", "qcr-companion", "sh", "-c", "true"])).toEqual({
      ok: true,
      stdout: "out\n",
      stderr: "warning: x\n",
      code: 0,
    });
    const bad = scriptRig("", 1, "cat: /x: No such file or directory\n");
    expect(await bad.runner(["exec", "qcr-companion", "sh", "-c", "cat /x"])).toEqual({
      ok: false,
      stdout: "",
      stderr: "exit 1\ncat: /x: No such file or directory",
      code: 1,
    });
  });

  it("quotes a script that holds single quotes", async () => {
    const { runner, ran } = scriptRig("", 0);
    await runner(["exec", "qcr-companion", "sh", "-c", "echo 'a b'"]);
    expect(ran[0]![3]).toContain(String.raw`sh -c 'echo '\''a b'\'''`);
  });

  it("a run-shell that fails (no server) is returned as it is", async () => {
    const { runner } = rig(() => FAIL);
    const res = await runner(["exec", "qcr-companion", "sh", "-c", "true"]);
    expect(res).toEqual(FAIL);
  });

  it.each(["new-session", "new", "start-server"])(
    "%s runs only after a server proved it is answering, so no server is born here",
    async (word) => {
      const down = rig((argv) => (argv.includes("show-options") ? FAIL : OK));
      const res = await down.runner(["exec", "qcr-companion", "tmux", word, "-d", "-s", "x", "pi"]);
      expect(res.ok).toBe(false);
      expect(res.stderr).toMatch(/tmux server is not up/);
      expect(down.ran.map((a) => a[2])).toEqual(["show-options"]);

      const up = rig();
      await up.runner(["exec", "qcr-companion", "tmux", word, "-d", "-s", "x", "pi"]);
      expect(up.ran.map((a) => a[2])).toEqual(["show-options", word]);
    },
  );

  it("does not probe for a command that cannot start a server", async () => {
    const { runner, ran } = rig();
    await runner(["exec", "qcr-companion", "tmux", "capture-pane", "-p", "-t", "companion"]);
    expect(ran).toHaveLength(1);
  });

  it.each([
    [["inspect", "qcr-companion"]],
    [["start", "qcr-companion"]],
    [["run", "--detach", "x"]],
    [["exec", "another-container", "tmux", "ls"]],
    [["exec", "qcr-companion", "cat", "/etc/passwd"]],
    [["exec", "qcr-companion", "sh", "-c", "a", "b"]],
  ])("refuses %j by name: the host wrapper owns the container", async (argv) => {
    const { runner, ran } = rig();
    const res = await runner(argv);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/not available in the tui container/);
    expect(ran).toEqual([]);
  });
});

describe.skipIf(spawnSync("tmux", ["-V"]).status !== 0)(
  "against a real tmux on a scratch socket",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-tmux-sock-"));
    const socket = join(dir, "c.sock");
    const runner = tmuxSocketRunner(socket, "qcr-companion");
    const exec = (...rest: string[]) => runner(["exec", "qcr-companion", ...rest]);
    afterAll(() => {
      spawnSync("tmux", ["-S", socket, "kill-server"]);
      rmSync(dir, { recursive: true, force: true });
    });

    it("refuses to start a session while no server listens, and leaves no server behind", async () => {
      const res = await exec("tmux", "new-session", "-d", "-s", "companion", "sleep", "30");
      expect(res.ok).toBe(false);
      expect(res.stderr).toMatch(/tmux server is not up/);
      expect(spawnSync("tmux", ["-S", socket, "list-sessions"]).status).not.toBe(0);
    });

    it("drives the companion's server: spawn, find, send keys, capture, run a script, kill", async () => {
      // what the companion's entrypoint does (docker/entrypoint.sh)
      const start = spawnSync("tmux", [
        "-S",
        socket,
        "start-server",
        ";",
        "set",
        "-s",
        "exit-empty",
        "off",
      ]);
      expect(start.status).toBe(0);
      expect((await exec("tmux", "has-session", "-t", "companion")).ok).toBe(false);
      const born = await exec("tmux", "new-session", "-d", "-s", "companion", "cat");
      expect(born.ok, born.stderr).toBe(true);
      expect((await exec("tmux", "has-session", "-t", "companion")).ok).toBe(true);
      await exec("tmux", "send-keys", "-t", "companion", "-l", "hello from the tui");
      await exec("tmux", "send-keys", "-t", "companion", "Enter");
      await new Promise((r) => setTimeout(r, 200));
      const shot = await exec("tmux", "capture-pane", "-p", "-t", "companion");
      expect(shot.stdout).toContain("hello from the tui");

      const ok = await exec("sh", "-c", "printf 'one\\ntwo\\n'");
      expect(ok).toMatchObject({ ok: true, stdout: "one\ntwo\n" });
      const bad = await exec("sh", "-c", "echo before; exit 3");
      expect(bad.ok).toBe(false);
      expect(bad.stdout).toBe("before\n");
      expect(bad.stderr).toBe("exit 3");
      const noisy = await exec("sh", "-c", "echo oops >&2; echo fine; exit 2");
      expect(noisy).toMatchObject({ ok: false, stdout: "fine\n", stderr: "exit 2\noops" });

      const killed = await exec("tmux", "kill-session", "-t", "companion");
      expect(killed.ok).toBe(true);
      // the server stays up with no session (exit-empty off): the TUI can still find it
      expect((await exec("tmux", "show-options", "-s", "exit-empty")).ok).toBe(true);
    });
  },
);

// ---- the plan the wrapper reads --------------------------------------------------

describe("qcr companion plan", () => {
  const ENV = {
    QCR_HOST_HOME: "/h",
    QCR_HOST_XDG_CONFIG_HOME: "/h/.config",
    QCR_HOST_XDG_STATE_HOME: "/h/.local/state",
    QCR_IMAGE: "ghcr.io/o/n:1.2.3",
  };
  const parse = (text: string): Record<string, string[]> => {
    const by: Record<string, string[]> = {};
    for (const line of text.trimEnd().split("\n")) {
      const i = line.indexOf(" ");
      (by[line.slice(0, i)] ??= []).push(line.slice(i + 1));
    }
    return by;
  };

  it("is the companion's own run: the wrapper's image, a label with the plan's hash, detached", () => {
    const plan = companionPlan(ENV);
    expect(plan.run.slice(0, 2)).toEqual(["run", "--detach"]);
    expect(plan.run.slice(2, 4)).toEqual(["--label", `qcr.plan=${plan.hash}`]);
    expect(plan.run.slice(-2)).toEqual(["ghcr.io/o/n:1.2.3", "companion"]);
    expect(plan.name).toBe("qcr-tui-companion");
    // a name and a pi home of its own: never the clone-route companion's
    expect(plan.run).toContain("qcr-tui-companion");
    expect(plan.run.join(" ")).toContain("qcr-companion-pihome:/home/qcr/.pi");
  });

  it("the hash follows the run argv: another image or another mount source is another plan", () => {
    const a = companionPlan(ENV).hash;
    expect(companionPlan(ENV).hash).toBe(a);
    expect(companionPlan({ ...ENV, QCR_IMAGE: "ghcr.io/o/n:1.2.4" }).hash).not.toBe(a);
    expect(companionPlan({ ...ENV, QCR_HOST_XDG_STATE_HOME: "/other/state" }).hash).not.toBe(a);
  });

  it("mounts the config home's profiles at the ruled ~/.config/qcr/profiles, and no secrets", () => {
    const flat = companionPlan(ENV).run.join("\n");
    expect(flat).toContain("/h/.config/qcr/profiles:/qcr-config/profiles:rw");
    expect(flat).toContain("/h/.config/qcr/portrait:/qcr-config/portrait:rw");
    expect(flat).not.toMatch(/secrets|\.ssh|docker\.sock|agent|known_hosts/);
    // the channel dirs are the operator state home's, which no container mounts whole
    expect(flat).toContain("/h/.local/state/qcr-operator/default/companion/feed:/feed:rw");
  });

  it("names the dirs to create, the ones the TUI shares at their own paths, and its env", () => {
    const plan = companionPlan(ENV);
    const ops = "/h/.local/state/qcr-operator/default/companion";
    expect(plan.mkdirs).toEqual(
      expect.arrayContaining([
        `${ops}/workspace`,
        `${ops}/workspace/inject`,
        `${ops}/feed`,
        `${ops}/alerts`,
        `${ops}/evidence`,
        "/h/.config/qcr/profiles",
        "/h/.local/state/qcr/home",
      ]),
    );
    expect(plan.tuiMounts).toEqual(
      expect.arrayContaining([
        `${ops}/feed`,
        `${ops}/alerts`,
        `${ops}/evidence`,
        `${ops}/workspace/inject`,
        "/h/.local/state/qcr/home",
        "/h/.local/state/qcr-operator/default/companion-config",
        "/h/.local/state/qcr-operator/default/companion-github",
      ]),
    );
    // not the profiles dir (the wrapper mounts that read-only itself), not the repo
    expect(plan.tuiMounts).not.toContain("/h/.config/qcr/profiles");
    expect(plan.tuiVolumes).toEqual(["qcr-tui-companion-tmux:/run/qcr-tmux"]);
    expect(plan.tuiEnv).toEqual(
      expect.arrayContaining([
        "QCR_HOST_HOME=/h",
        "QCR_STATE_HOME=/h/.local/state/qcr/home",
        "QCR_IMAGE=ghcr.io/o/n:1.2.3",
      ]),
    );
  });

  it("hands the TUI the install name its channel paths derive from", () => {
    expect(companionPlan({ ...ENV, QCR_INSTALL: "foo" }).tuiEnv).toContain("QCR_INSTALL=foo");
    expect(companionPlan(ENV).tuiEnv.some((l) => l.startsWith("QCR_INSTALL="))).toBe(false);
  });

  it("lets the TUI's lifecycle see the config file it was handed, so the mirror is filled", () => {
    const seen: string[] = [];
    const fs = {
      exists: (p: string) => (seen.push(p), true),
      read: () => undefined,
      mode: () => undefined,
    };
    const env = { ...ENV, QCR_CONFIG: "/qcr-config/config.toml" };
    const lc = laptopLifecycle(env, async () => FAIL, undefined, fs);
    expect(lc.hostHomes().configFile).toBe("/qcr-config/config.toml");
    expect(laptopLifecycle(env, async () => FAIL).hostHomes().configFile).toBeUndefined();
  });

  it("renders one tagged line per fact, and refuses a value with a newline", () => {
    const by = parse(renderPlan(companionPlan(ENV)));
    expect(Object.keys(by).sort()).toEqual(
      ["mkdir", "name", "plan", "run", "tui-env", "tui-mount", "tui-volume"].sort(),
    );
    expect(by["name"]).toEqual(["qcr-tui-companion"]);
    expect(by["run"]!.at(-1)).toBe("companion");
    expect(() => renderPlan({ ...companionPlan(ENV), mkdirs: ["/a\n/b"] })).toThrow(/newline/);
  });

  it("needs the host's own absolute paths, never the container's HOME", () => {
    expect(() => laptopInstallEnv({})).toThrow(/QCR_HOST_HOME/);
    expect(() => laptopInstallEnv({ QCR_HOST_HOME: "relative" })).toThrow(/absolute/);
    expect(() => laptopInstallEnv({ ...ENV, QCR_HOST_XDG_STATE_HOME: "rel" })).toThrow(/absolute/);
    // XDG defaults come from the host home
    expect(laptopInstallEnv({ QCR_HOST_HOME: "/h" })).toMatchObject({
      XDG_CONFIG_HOME: "/h/.config",
      QCR_CONFIG_HOME: "/h/.config/qcr",
      QCR_STATE_HOME: "/h/.local/state/qcr/home",
    });
  });

  it("the TUI and the planner derive the same config from the same env", () => {
    const planned = companionPlan(ENV);
    const lc = laptopLifecycle(ENV, async () => FAIL);
    expect(lc.cfg).toEqual(laptopCompanionConfig(ENV));
    expect(lc.runArgv().slice(1)).toEqual(
      planned.run.filter((_, i) => i !== 2 && i !== 3).slice(1),
    );
  });

  it("`qcr companion plan` prints the plan and runs nothing", async () => {
    const { cmdCompanion } = await import("../src/cli.js");
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await cmdCompanion("plan");
      expect(write.mock.calls.map((c) => String(c[0])).join("")).toBe(
        renderPlan(companionPlan(ENV)),
      );
    } finally {
      write.mockRestore();
      for (const k of Object.keys(ENV)) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
