// The SDK route under the separate tool uid, in real containers: the
// repo's own entrypoint and built code in a stock node image, started with the
// flags the release e2e, the wrapper and the Action give a model-reaching call
// (--user 0:0, only SETUID/SETGID, no-new-privileges), so the kernel is the one
// the release image will meet. The model is pi-ai's faux provider: its scripted
// calls are an attacker's. No network, no model, nothing leaves the machine.
//
// Skipped where docker, the node image or the built tree is absent. The built
// tree is `npm run build` (dist/); the release image is not built here.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { nodeModulesMounts } from "./helpers/docker-node-modules.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(root, "dist", "src");
const CORE_DIST = join(root, "packages", "pi-plugin", "dist", "src");
const HARNESS = join(root, "tests", "helpers", "tool-uid-harness.mjs");
const DEBUG_HARNESS = join(root, "tests", "helpers", "debug-uid-harness.mjs");
const NODE_IMAGE = "node:26-bookworm";
const TOKEN = "ghs_TOOLUID_SECRET_0123456789";
const LOGIN_MARK = "LOGIN_SRC_REFRESH_SECRET_9876";
const LOGIN_SECRET_JSON = JSON.stringify({
  "openai-codex": { type: "oauth", access: "a", refresh: LOGIN_MARK, expires: 1 },
});
const keep = process.env["KEEP_TOOL_UID_TMP"];
const tmp = mkdtempSync(join(keep ?? tmpdir(), "tool-uid-container-"));

const hasDist = existsSync(join(CORE_DIST, "engine", "tooluid.js"));
const hasDocker = ((): boolean => {
  if (spawnSync("docker", ["image", "inspect", NODE_IMAGE], { stdio: "ignore" }).status !== 0)
    return false;
  return (
    spawnSync("docker", ["run", "--rm", "--network", "none", NODE_IMAGE, "setpriv", "--help"], {
      stdio: "ignore",
      timeout: 60_000,
    }).status === 0
  );
})();
const docker = (args: string[], timeout = 120_000): ReturnType<typeof spawnSync> =>
  spawnSync("docker", args, { encoding: "utf8", timeout });

afterAll(() => {
  if (keep) return;
  // the container's uids own some of what it made; without the image nothing ran,
  // and a cleanup run must never pull it
  if (hasDocker)
    docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--mount",
      `type=bind,src=${tmp},dst=/d`,
      NODE_IMAGE,
      "sh",
      "-c",
      "rm -rf /d/* /d/.[!.]* 2>/dev/null; true",
    ]);
  rmSync(tmp, { recursive: true, force: true });
});

const uid = process.getuid?.() ?? 1000;
const gid = process.getgid?.() ?? 1000;

/** The flags each caller gives a model-reaching call. Docker's own: the shapes
 * differ in the init process, the login group and the token mount. */
const SHAPES: Record<string, { flags: string[]; token: boolean }> = {
  // .github/workflows/release.yml: the paid e2e's docker run
  "release e2e": {
    flags: [
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--security-opt",
      "no-new-privileges",
      "-e",
      `QCR_RUN_UID=${uid}`,
      "-e",
      `QCR_RUN_GID=${gid}`,
    ],
    token: false,
  },
  // scripts/qcr-host.sh: `qcr review` (the token handed as a file)
  "host wrapper": {
    flags: [
      "--init",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--security-opt",
      "no-new-privileges",
      "-e",
      "QCR_RUN_UID=1000",
      "-e",
      "QCR_RUN_GID=1000",
      "--group-add",
      "4747",
      "-e",
      "QCR_LOGIN_GID=4747",
    ],
    token: true,
  },
  // scripts/action.sh: the Action's per-run container
  Action: {
    flags: [
      "--init",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "SETUID",
      "--cap-add",
      "SETGID",
      "--security-opt",
      "no-new-privileges",
      "-e",
      `QCR_RUN_UID=${uid}`,
      "-e",
      `QCR_RUN_GID=${gid}`,
      "--group-add",
      "4747",
      "-e",
      "QCR_LOGIN_GID=4747",
      "-e",
      "QCR_ROUTE=action",
    ],
    token: true,
  },
};

interface Run {
  status: number | null;
  stderr: string;
  out: string;
}

/** The repo's entrypoint around a stand-in cli that runs the harness. `userFlags`
 * replaces the shape's flags where a test starts the call another way. */
function runHarness(
  name: string,
  flags: string[],
  token: boolean,
  harness: string = HARNESS,
  timeoutMs = 170_000,
): Run {
  const dir = mkdtempSync(join(tmp, `${name.replace(/\W/g, "-")}-`));
  chmodSync(dir, 0o755);
  const app = join(dir, "app");
  const out = join(dir, "out");
  const cfg = parseConfig(readFileSync(join(root, "config.example.toml"), "utf8"));
  const put = (rel: string, text: string): void => {
    mkdirSync(dirname(join(app, rel)), { recursive: true });
    writeFileSync(join(app, rel), text);
  };
  for (const f of [
    "docker/entrypoint.sh",
    "scripts/install-locator.sh",
    "scripts/install-wrapper.sh",
    "scripts/qcr-host.sh",
    "config.example.toml",
    "docker/vm/tmux.conf",
  ]) {
    mkdirSync(dirname(join(app, f)), { recursive: true });
    copyFileSync(join(root, f), join(app, f));
  }
  chmodSync(join(app, "docker/entrypoint.sh"), 0o755);
  put(
    join("node_modules", cfg.pi.package, "package.json"),
    JSON.stringify({ version: cfg.pi.version }),
  );
  put("package.json", JSON.stringify({ type: "module", version: "1.0.0" }));
  put("dist/src/cli.js", `await import(${JSON.stringify(harness)});\n`);
  mkdirSync(join(app, "state"), { mode: 0o777 });
  chmodSync(join(app, "state"), 0o777);
  mkdirSync(out, { mode: 0o777 });
  chmodSync(out, 0o777);
  const tokdir = join(dir, "tok");
  mkdirSync(tokdir, { mode: 0o700 });
  writeFileSync(join(tokdir, "gh-token"), TOKEN, { mode: 0o600 });
  // the owner's login source, as the wrapper and the Action mount it: read-only
  // at /qcr-login, named by PI_CODING_AGENT_DIR (the run copies it; the model's
  // file tools run as the run uid, which can read it through the login group)
  const login = join(dir, "login");
  mkdirSync(login, { mode: 0o755 });
  writeFileSync(join(login, "auth.json"), LOGIN_SECRET_JSON, { mode: 0o644 });
  // the user whose files the root start must read, as the wrapper's uid
  chmodSync(tokdir, 0o777);
  chmodSync(join(tokdir, "gh-token"), 0o666);
  const args = [
    "run",
    "--rm",
    "--network",
    "none",
    ...flags,
    "-e",
    "HOME=/tmp/qcr-home",
    "-e",
    "QCR_APP_ROOT=/opt/qcr",
    "-e",
    "QCR_CONFIG=/opt/qcr/config.example.toml",
    "-e",
    `HARNESS_DIST=${DIST}`,
    "-e",
    `HARNESS_CORE_DIST=${CORE_DIST}`,
    "-e",
    `HARNESS_ROOT=${root}`,
    "-e",
    "HARNESS_OUT=/out",
    ...(token ? ["-e", "QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token"] : []),
    "--tmpfs",
    "/tmp:mode=1777",
    "--mount",
    `type=bind,src=${app},dst=/opt/qcr`,
    "--mount",
    `type=bind,src=${root},dst=${root},readonly`,
    ...nodeModulesMounts(root),
    ...(token ? ["--mount", `type=bind,src=${tokdir},dst=/run/qcr-in`] : []),
    "--mount",
    `type=bind,src=${login},dst=/qcr-login,readonly`,
    "-e",
    "PI_CODING_AGENT_DIR=/qcr-login",
    "--mount",
    `type=bind,src=${out},dst=/out`,
    "--entrypoint",
    "/opt/qcr/docker/entrypoint.sh",
    NODE_IMAGE,
    "review",
  ];
  const r = docker(args, timeoutMs);
  return { status: r.status, stderr: String(r.stderr), out };
}

interface ToolResult {
  text: string;
  isError: boolean;
}

/** The tool results of an events file, in order. */
function toolResults(file: string): ToolResult[] {
  const results: ToolResult[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as {
      type?: string;
      message?: { role?: string; isError?: boolean; content?: { type?: string; text?: string }[] };
    };
    if (e.type === "message_end" && e.message?.role === "toolResult")
      results.push({
        isError: e.message.isError === true,
        text: (e.message.content ?? []).map((c) => c.text ?? "").join("\n"),
      });
  }
  return results;
}

// The containers below run the shipped config, which names no [engine]
// key: the SDK, engine lenses and the planned wave are what that config selects
// on the review route, so the root start is checked on the default route.
describe("the shipped config selects the SDK route the containers run", () => {
  it("has no [engine] key and defaults to sdk, engine lenses and the planned wave", () => {
    const text = readFileSync(join(root, "config.example.toml"), "utf8");
    expect(text).not.toMatch(/^\[engine\]/m);
    const cfg = parseConfig(text);
    expect(cfg.engine.runtime).toBe("sdk");
    expect(cfg.pi.lens_runtime).toBe("engine");
    expect(cfg.pi.engine_wave).toBe(true);
  });
});

describe.skipIf(!hasDocker || !hasDist)(
  "the SDK route under the separate tool uid (docker, no network, a faux model)",
  () => {
    for (const [shape, { flags, token }] of Object.entries(SHAPES)) {
      it(`${shape}: the model's tools run as the tool uid and cannot reach the token holder`, () => {
        const r = runHarness(shape, flags, token);
        expect(r.stderr).not.toMatch(/FATAL|refused/i);
        expect(r.status, r.stderr).toBe(0);
        const read = (f: string): string => readFileSync(join(r.out, f), "utf8");
        expect(existsSync(join(r.out, "done"))).toBe(true);

        // the engine's process: the run uid, not root, holding the token if one came
        const holder = JSON.parse(read("holder.json")) as {
          pid: number;
          uid: number;
          holdsToken: boolean;
        };
        expect(holder.uid).not.toBe(0);
        expect(holder.holdsToken).toBe(token);

        // QCR_ALLOW_SHARED_TOOL_UID is nowhere: not in the engine's env, not in the model's
        const names = JSON.parse(read("node-env-names.json")) as string[];
        expect(names).not.toContain("QCR_ALLOW_SHARED_TOOL_UID");
        expect(names).toContain("QCR_TOOL_UID");
        expect(names).not.toContain("QCR_GH_TOKEN_FILE");

        const labels = JSON.parse(read("labels.json")) as string[];
        const results = toolResults(join(r.out, "main-events.jsonl"));
        expect(results).toHaveLength(labels.length);
        const by = (label: string): ToolResult => results[labels.indexOf(label)]!;

        // the model's bash reports the tool uid, in the run's gid, with no other group
        expect(by("id").text).toMatch(/uid=65534 gid=\d+ groups=\d+\s*$/);
        expect(by("id").text).not.toContain(`uid=${holder.uid}`);
        // and the kernel refuses it the holder's environ and memory: EACCES (the
        // cmdline is world-readable, and holds no secret: the token is never in argv)
        for (const label of ["environ", "mem"])
          expect(by(label).text, label).toMatch(/Permission denied/);
        expect(by("cmdline").text).not.toContain(TOKEN);
        expect(by("environ").text).not.toContain("QCR_TOOL_UID");
        // no token and no secret name in the model's env, nothing in the handoff dir
        const env = by("env").text;
        expect(env).not.toContain(TOKEN);
        expect(env).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|QCR_GH_TOKEN_FILE|QCR_ALLOW_SHARED/);
        // the run's login is closed to it (0700 for the run uid)
        expect(by("agentdir").text).toMatch(/Permission denied/);
        expect(by("agentdir").text).not.toContain("refresh");
        if (token) expect(by("mount").text.trim()).toBe("");
        else expect(by("mount").text).toMatch(/No such file/);
        expect(by("plant").text).toContain("planted");

        // the file tools refuse the fenced paths, as given and through planted links
        const refusals = labels.filter(
          (l) => /^(read|grep|ls|find|edit|write)-/.test(l) && !l.endsWith("-ok"),
        );
        expect(refusals.length).toBeGreaterThan(25);
        for (const label of refusals) {
          expect(by(label).isError, label).toBe(true);
          expect(by(label).text, label).toContain("access refused");
        }
        // nothing the links pointed at was written, and the login was not read out
        for (const l of labels) expect(by(l).text, l).not.toContain('"refresh"');
        expect(results.map((x) => x.text).join("\n")).not.toContain(TOKEN);
        // the login source (/qcr-login, readable by the run uid) is fenced like the round's copy
        for (const l of labels.filter((x) => /login/.test(x))) {
          expect(by(l).isError, l).toBe(true);
          expect(by(l).text, l).toContain("access refused");
        }
        expect(results.map((x) => x.text).join("\n")).not.toContain(LOGIN_MARK);

        // the ordinary work goes through, across the two uids, in both directions
        expect(by("bash-writes").text).toContain("wrote");
        expect(by("read-ok").text).toContain("from-bash");
        expect(by("edit-ok").isError).toBe(false);
        expect(by("write-ok").isError).toBe(false);
        expect(by("bash-reads").text).toContain("edited");
        expect(by("bash-reads").text).toContain("from-write");

        // a command past its timeout is ended (the run uid cannot signal the tool uid:
        // the engine ends it as the tool uid), and nothing of it is left running
        expect(by("timeout").isError).toBe(true);
        expect(by("timeout").text).toMatch(/timed out after 1 seconds/);
        expect(by("after-timeout").text).toMatch(/^ended \d+/);
        const turn = JSON.parse(read("turn.json")) as { code: number; ms: number };
        expect(turn.code).toBe(0);
        expect(turn.ms).toBeLessThan(60_000);

        // a second session of the same host is split too
        const second = toolResults(join(r.out, "second-events.jsonl"));
        expect(second[0]!.text).toMatch(/uid=65534/);
      }, 200_000);
    }

    it("a start that is not root refuses (QCR_TOOL_UID_REQUIRED), before any model call", () => {
      const r = runHarness(
        "non-root",
        ["--user", `${uid}:${gid}`, "--cap-drop", "ALL", "--security-opt", "no-new-privileges"],
        false,
      );
      expect(r.status, r.stderr).toBe(0);
      const refused = readFileSync(join(r.out, "refused.txt"), "utf8");
      expect(refused).toMatch(/SDK runtime: .*start the container as root/);
      expect(refused).toContain("QCR_ALLOW_SHARED_TOOL_UID=1");
      expect(existsSync(join(r.out, "done"))).toBe(false);
    }, 120_000);
  },
);

describe.skipIf(!hasDocker || !hasDist)(
  "a debug round under the separate tool uid (docker, the real pi in a pty, a local endpoint)",
  () => {
    it("starts pi through setpriv as the tool uid, runs the wave, and keeps every JSONL", () => {
      const r = runHarness(
        "debug-round",
        SHAPES["host wrapper"]!.flags,
        false,
        DEBUG_HARNESS,
        200_000,
      );
      expect(r.stderr).not.toMatch(/refused/i);
      expect(r.status, r.stderr).toBe(0);
      const read = (f: string): string => readFileSync(join(r.out, f), "utf8");
      expect(existsSync(join(r.out, "done")), r.stderr).toBe(true);
      const launch = JSON.parse(read("launch.json")) as { bin: string; args: string[] };
      expect(launch.bin).toBe("setpriv");
      expect(launch.args.slice(0, 7)).toEqual([
        "--reuid=65534",
        "--regid=1000",
        "--clear-groups",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--no-new-privs",
        "--",
      ]);
      const res = JSON.parse(read("result.json")) as {
        code: number;
        error: string | null;
        requests: number;
        status: { state: string; wave_settled: number; dispatcher: string };
        mainOwner: number;
        lensOwners: number[];
        lenses: number;
        selfUid: number;
      };
      // the round ran in that pi: the wave settled, the endpoint heard the main session and both passes
      expect(res.error).toBeNull();
      expect(res.code).toBe(0);
      expect(res.status).toMatchObject({ state: "started", wave_settled: 2 });
      expect(res.requests).toBe(3);
      // and the files pi kept are the tool uid's: it was that uid that wrote them
      expect(res.selfUid).not.toBe(65534);
      expect(res.mainOwner).toBe(65534);
      expect(res.lenses).toBe(2);
      expect(res.lensOwners).toEqual([65534, 65534]);
    }, 240_000);
  },
);
