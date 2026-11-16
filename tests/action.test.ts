// The composite Action (action.yml, scripts/action.sh). Running it needs
// GitHub, a registry, docker and a model, so the suite pins what can be read or
// run without any of them:
//   - action.yml: its name and branding, the inputs and outputs it declares,
//     the order of the steps (gate, preflight, login, run, cleanup), that
//     nothing runs after a gate that skipped, and that every value reaches the
//     script through env (the gate is told only whether a key was given);
//   - `scripts/action.sh gate` against a local stand-in for GitHub's API: the
//     pull request an event names, who may start a review, a merged or closed
//     pull request, a missing model credential, and the outputs, notice and
//     summary line it writes;
//   - `scripts/action.sh run` against a fake `docker` on PATH: the docker run
//     line holds no token and no memory service, the token is a 0600 file in a
//     0700 directory that is gone afterwards, the route is `action`, the
//     generated config is live with memory off, and the review's JSON result
//     becomes the outputs and the job summary;
//   - the preflight against a local stand-in for the registry: with no
//     registry input it asks anonymously (the image is public) and never sends
//     the workflow token, a refusal fails and names the private-mirror route,
//     and the credential is the registry token when one is given;
//   - the generated config, parsed by the real parser, and a review posted
//     through the mutation gate with it.
// The workflow a repository copies (docs/action/qcr-review.yml) is pinned
// with the renderer it comes from.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { parseConfig } from "../src/config.js";
import { routeFromEnv } from "../src/reviewcli.js";
import {
  assemblePostReview,
  localPostGate,
  postReviewToPr,
} from "@quickchatai/pi-quickreview/src/reviewpost.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const SCRIPT = join(root, "scripts", "action.sh");

const tmpRoot = mkdtempSync(join(tmpdir(), "action-test-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));
let n = 0;
const fresh = (): string => {
  const d = join(tmpRoot, `t${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ---------------------------------------------------------------------------
// action.yml
// ---------------------------------------------------------------------------

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface ActionYml {
  name: string;
  description: string;
  branding?: Record<string, string>;
  runs: { using: string; steps: Step[] };
  inputs: Record<string, { default?: string }>;
  outputs?: Record<string, { description?: string; value?: string }>;
}
const action = parse(read("action.yml")) as ActionYml;
/** The step that runs one verb of scripts/action.sh. */
const stepOf = (verb: string): Step =>
  action.runs.steps.find((s) => s.run === `bash "$QCR_ACTION_PATH/scripts/action.sh" ${verb}`)!;
const KEY_INPUTS = [
  "anthropic-api-key",
  "digitalocean-api-key",
  "gemini-api-key",
  "openai-api-key",
] as const;

describe("action.yml", () => {
  // MUTATION: move the gate step below the preflight in action.yml — this fails.
  it("is a composite that gates, preflights, logs in, runs and cleans up, in that order", () => {
    expect(action.runs.using).toBe("composite");
    const verbs = action.runs.steps
      .map((s) => /action\.sh" (\w+)/.exec(s.run ?? "")?.[1])
      .filter((v) => v !== undefined);
    expect(verbs).toEqual(["gate", "preflight", "login", "run", "cleanup"]);
    // the runner check comes first, the gate right after it
    expect(action.runs.steps[0]!.run).toContain("RUNNER_OS");
    expect(action.runs.steps[1]).toBe(stepOf("gate"));
    expect(stepOf("cleanup").if).toBe("always()");
  });

  // A run the gate skips must not pull the image or start a review.
  // MUTATION: drop the `if:` from the run step in action.yml — this fails.
  it("runs the preflight, the login and the review only when the gate did not skip", () => {
    expect(stepOf("gate").id).toBe("gate");
    expect(stepOf("gate").if).toBeUndefined();
    for (const verb of ["preflight", "login", "run"])
      expect(stepOf(verb).if, verb).toBe("steps.gate.outputs.skipped == 'false'");
  });

  // MUTATION: give the run step `QCR_ACTION_PR: ${{ inputs.pr ||
  // github.event.pull_request.number }}` again — this fails.
  it("reviews the pull request the gate chose; the gate gets the pr input", () => {
    expect(stepOf("gate").env!["QCR_ACTION_PR"]).toBe("${{ inputs.pr }}");
    expect(stepOf("run").id).toBe("run");
    expect(stepOf("run").env!["QCR_ACTION_PR"]).toBe("${{ steps.gate.outputs.pr }}");
  });

  // Composite outputs are declared statically, each from the step that writes it.
  // MUTATION: wire review-url to `steps.gate.outputs.review-url` — this fails.
  it("declares the gate's and the run's outputs", () => {
    const from: Record<string, string> = {
      skipped: "gate",
      "skip-reason": "gate",
      pr: "gate",
      "review-url": "run",
      verdict: "run",
      findings: "run",
      "cost-usd": "run",
      result: "run",
    };
    expect(Object.keys(action.outputs ?? {}).sort()).toEqual(Object.keys(from).sort());
    for (const [name, step] of Object.entries(from)) {
      expect(action.outputs![name]!.value, name).toBe(`\${{ steps.${step}.outputs.${name} }}`);
      expect(action.outputs![name]!.description, name).toBeTruthy();
    }
  });

  // GitHub's Marketplace refuses a name that is a user's: a user quickreview exists.
  // MUTATION: set `name: QuickReview` in action.yml — this fails.
  it("is listed as QuickReview AI Code Review, with an eye on blue", () => {
    expect(action.name).toBe("QuickReview AI Code Review");
    expect(action.branding).toEqual({ icon: "eye", color: "blue" });
  });

  // MUTATION: write `run: bash "$QCR_ACTION_PATH/scripts/action.sh" gate ${{
  // inputs.pr }}` in action.yml — this fails.
  it("never puts the token, a login or a key on a docker line of its own, and no expression in a run line", () => {
    // every step is one call of the script; docker is run there and nowhere else
    for (const s of action.runs.steps.slice(1)) {
      expect(s.run, s.name).toMatch(/^bash "\$QCR_ACTION_PATH\/scripts\/action\.sh" \w+$/);
    }
    // an input reaches a script through env only, never spliced into its text
    for (const s of action.runs.steps) expect(s.run ?? "", s.name).not.toContain("${{");
    expect(read("action.yml")).not.toMatch(/\bdry[_-]run\b\s*:/i);
  });

  // MUTATION: set the post input's default to "false" in action.yml — this fails.
  it("has no default limit, no default profile, posts by default, and lets nobody else in by default", () => {
    expect(action.inputs["limit"]!.default).toBe("");
    expect(action.inputs["profile"]!.default).toBe("");
    expect(action.inputs["post"]!.default).toBe("true");
    expect(action.inputs["allowed-users"]!.default).toBe("");
  });

  // Any provider's key is set with the workflow's own `env:`; the Action has
  // one input for the model and none per provider beyond the four it had.
  // MUTATION: add an `xai-api-key` input to action.yml — this fails.
  it("takes a model, a profile, post and allowed-users, and no key input beyond the four older ones", () => {
    expect(Object.keys(action.inputs).sort()).toEqual([
      "allowed-users",
      "anthropic-api-key",
      "digitalocean-api-key",
      "gemini-api-key",
      "github-token",
      "image",
      "limit",
      "model",
      "openai-api-key",
      "pi-auth",
      "post",
      "pr",
      "profile",
      "registry-token",
      "registry-user",
      "repo",
    ]);
    expect(action.inputs["model"]!.default).toBe("");
    const run = stepOf("run");
    expect(run.env!["QCR_ACTION_MODEL"]).toBe("${{ inputs.model }}");
    expect(run.env!["QCR_ACTION_PROFILE"]).toBe("${{ inputs.profile }}");
    expect(run.env!["QCR_ACTION_POST"]).toBe("${{ inputs.post }}");
    expect(stepOf("gate").env!["QCR_ACTION_ALLOWED_USERS"]).toBe("${{ inputs.allowed-users }}");
  });

  // An input that was not given is an empty string: under the variable's own
  // name it would blank a key the workflow set in the step's env.
  // MUTATION: map `OPENAI_API_KEY: ${{ inputs.openai-api-key }}` in the run
  // step's env — this fails.
  it("hands the key inputs over under names of their own, never the variable pi reads", () => {
    const run = stepOf("run");
    const keys = Object.keys(run.env!).filter((k) => k.endsWith("_API_KEY"));
    expect(keys.sort()).toEqual([
      "QCR_ACTION_ANTHROPIC_API_KEY",
      "QCR_ACTION_DIGITALOCEAN_API_KEY",
      "QCR_ACTION_GEMINI_API_KEY",
      "QCR_ACTION_OPENAI_API_KEY",
    ]);
  });

  // MUTATION: add `GITHUB_TOKEN: ${{ inputs.github-token }}` to the gate
  // step's env — this fails.
  it("names every env key of every action.sh step QCR_ACTION_", () => {
    for (const s of action.runs.steps.slice(1))
      for (const k of Object.keys(s.env ?? {})) expect(k, s.name).toMatch(/^QCR_ACTION_/);
  });

  // The gate decides before anything is spent and needs no secret for that:
  // it is told whether a key input or pi-auth was given, never what it holds.
  // MUTATION: give the gate step `QCR_ACTION_PI_AUTH: ${{ inputs.pi-auth }}`
  // — this fails.
  it("tells the gate whether a key input or pi-auth was given, never their values", () => {
    const env = stepOf("gate").env!;
    expect(Object.keys(env).sort()).toEqual([
      "QCR_ACTION_ALLOWED_USERS",
      "QCR_ACTION_GH_TOKEN",
      "QCR_ACTION_HAS_KEY_INPUT",
      "QCR_ACTION_HAS_PI_AUTH",
      "QCR_ACTION_PATH",
      "QCR_ACTION_PR",
      "QCR_ACTION_REPO",
    ]);
    expect(env["QCR_ACTION_HAS_PI_AUTH"]).toBe("${{ inputs.pi-auth != '' }}");
    const anyKey = env["QCR_ACTION_HAS_KEY_INPUT"]!;
    expect(anyKey).toMatch(/^\$\{\{ .* \}\}$/);
    for (const k of KEY_INPUTS) expect(anyKey, k).toContain(`inputs.${k} != ''`);
    for (const value of Object.values(env))
      expect(value).not.toMatch(/inputs\.(pi-auth|registry-token|[a-z]+-api-key) *\}\}/);
  });

  it("the docs show a provider's key in the step's env", () => {
    const doc = read("docs/action.md");
    expect(doc).toMatch(/^\s+env:\n\s+[A-Z][A-Z0-9_]*_API_KEY: \$\{\{ secrets\.\w+ \}\}$/m);
    expect(doc).toContain("QCR_MODEL_ENV");
    expect(doc).toContain("# BEGIN pi model env names");
  });

  it("scripts/action.sh parses and is committed executable", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The script, with a fake docker
// ---------------------------------------------------------------------------

const TOKEN = "ghs_ThisIsTheWorkflowToken0123456789";
const REGISTRY_SECRET = "ghp_RegistryOnlyReadPackages9876543210";

/**
 * A `docker` that records what it is given. For `run` it saves the argv, its
 * own environment, and what it can see of the token mount (modes, contents), then
 * does what the image does with the token: reads it and unlinks it. It prints
 * the file FAKE_DOCKER_STDOUT names as the review's stdout, and exits with
 * FAKE_DOCKER_RC.
 */
function fakeDocker(dir: string): string {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(dir, "docker");
  mkdirSync(log, { recursive: true });
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
LOG="${log}"
n=$(ls "$LOG" | grep -c '^call' || true)
call="$LOG/call$n"
mkdir -p "$call"
printf '%s\\n' "$1" >"$call/verb"
for a in "$@"; do printf '%s\\0' "$a"; done >"$call/argv"
env >"$call/env"
printf '%s' "\${DOCKER_CONFIG-}" >"$call/docker_config"
case "$1" in
  login)
    cat >"$call/stdin"
    ;;
  run)
    src=""
    cfg=""
    login=""
    for a in "$@"; do
      case "$a" in
        type=bind,src=*,dst=/run/qcr-in) src="\${a#type=bind,src=}"; src="\${src%,dst=*}" ;;
        type=bind,src=*,dst=/qcr-config/config.toml,readonly) cfg="\${a#type=bind,src=}"; cfg="\${cfg%,dst=*}" ;;
        type=bind,src=*,dst=/qcr-login,readonly) login="\${a#type=bind,src=}"; login="\${login%,dst=*}" ;;
      esac
    done
    if [ -n "$src" ]; then
      stat -c '%a' "$src" >"$call/tokdir_mode"
      stat -c '%a' "$src/gh-token" >"$call/tokfile_mode"
      cat "$src/gh-token" >"$call/token_seen"
      ls -A "$src" >"$call/tokdir_ls"
      rm -f "$src/gh-token"
    fi
    if [ -n "$cfg" ]; then cp "$cfg" "$call/config.toml"; fi
    if [ -n "$login" ]; then ls -A "$login" >"$call/login_ls"; stat -c '%a' "$login" >"$call/login_mode"; fi
    if [ -n "\${FAKE_DOCKER_STDOUT-}" ]; then cat "$FAKE_DOCKER_STDOUT"; fi
    exit "\${FAKE_DOCKER_RC:-0}"
    ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);
  return bin;
}

interface Call {
  verb: string;
  argv: string[];
  env: string;
  files: (name: string) => string;
}
const calls = (dir: string): Call[] => {
  const log = join(dir, "docker");
  if (!existsSync(log)) return [];
  return readdirSync(log)
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .map((c) => {
      const d = join(log, c);
      return {
        verb: readFileSync(join(d, "verb"), "utf8").trim(),
        argv: readFileSync(join(d, "argv"), "utf8").split("\0").slice(0, -1),
        env: readFileSync(join(d, "env"), "utf8"),
        files: (name: string) => {
          const f = join(d, name);
          return existsSync(f) ? readFileSync(f, "utf8") : "";
        },
      };
    });
};

const nodeDir = dirname(process.execPath);
interface Rig {
  dir: string;
  runnerTemp: string;
  work: string;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
}
function rig(opts: { workspace?: boolean } = {}): Rig {
  const dir = fresh();
  const bin = fakeDocker(dir);
  const runnerTemp = join(dir, "runner-temp");
  mkdirSync(runnerTemp);
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  if (opts.workspace !== false) mkdirSync(join(workspace, ".git"));
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
    PATH: [bin, nodeDir, "/usr/bin", "/bin"].join(delimiter),
    HOME: dir,
    TMPDIR: tmpRoot,
    RUNNER_TEMP: runnerTemp,
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: "acme/widgets",
    GITHUB_ACTOR: "octo",
    GITHUB_RUN_ID: "42",
    QCR_ACTION_PATH: root,
    QCR_ACTION_IMAGE: "ghcr.io/acme/qcr:1.2.3",
    QCR_ACTION_PR: "7",
    QCR_ACTION_GH_TOKEN: TOKEN,
    ...extra,
  });
  return { dir, runnerTemp, work: join(runnerTemp, "qcr-action"), env };
}
const sh = (verb: string, env: NodeJS.ProcessEnv) =>
  spawnSync("bash", [SCRIPT, verb], { env, encoding: "utf8" });

/** A verb run without blocking this process, for one that calls a stub served from here. */
interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}
const shAsync = (verb: string, env: NodeJS.ProcessEnv) =>
  new Promise<Ran>((done) => {
    const c = spawn("bash", [SCRIPT, verb], { env });
    let stdout = "";
    let stderr = "";
    c.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    c.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    c.on("close", (status) => done({ status, stdout, stderr }));
  });

/**
 * What a runner reads back from GITHUB_OUTPUT: `name=value` lines, and
 * `name<<DELIMITER` blocks that end at a line holding the delimiter alone.
 */
interface OutputEntry {
  name: string;
  value: string;
  delimiter: string | null;
}
function outputEntries(file: string): OutputEntry[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n");
  const out: OutputEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") continue;
    const block = /^([^=<]+)<<(.+)$/.exec(line);
    if (block) {
      const delimiter = block[2]!;
      const value: string[] = [];
      for (i++; i < lines.length && lines[i] !== delimiter; i++) value.push(lines[i]!);
      if (i >= lines.length) throw new Error(`${block[1]}: no line closes ${delimiter}`);
      out.push({ name: block[1]!, value: value.join("\n"), delimiter });
    } else {
      const eq = line.indexOf("=");
      if (eq < 0) throw new Error(`not an output: ${line}`);
      out.push({ name: line.slice(0, eq), value: line.slice(eq + 1), delimiter: null });
    }
  }
  return out;
}
const outputsOf = (file: string): Record<string, string> =>
  Object.fromEntries(outputEntries(file).map((e) => [e.name, e.value]));
const textOf = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

describe("scripts/action.sh run — a root runner", () => {
  // A fake `id` (root) and `chown` (logs its argv) ahead of the fake docker.
  function withFakeRoot(r: Rig, asRoot: boolean): { env: NodeJS.ProcessEnv; log: string } {
    const bin = join(r.dir, "rootbin");
    mkdirSync(bin);
    const log = join(r.dir, "chown.log");
    if (asRoot) writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n");
    if (asRoot) chmodSync(join(bin, "id"), 0o755);
    writeFileSync(join(bin, "chown"), `#!/bin/sh\nprintf '%s\\n' "$*" >>"${log}"\n`);
    chmodSync(join(bin, "chown"), 0o755);
    const env = r.env();
    env.PATH = [bin, env.PATH].join(delimiter);
    return { env, log };
  }

  it("hands the staged token and pi login to the uid the image drops to", () => {
    const r = rig();
    const { env, log } = withFakeRoot(r, true);
    const res = sh("run", { ...env, QCR_ACTION_PI_AUTH: "{}" });
    expect(res.status, res.stderr).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.some((l) => /^-R 1000:1000 .*qcr-in\./.test(l))).toBe(true);
    expect(lines.some((l) => /^-R 1000:1000 .*\/login$/.test(l))).toBe(true);
  });

  it("changes no ownership for a non-root runner", () => {
    const r = rig();
    const { env, log } = withFakeRoot(r, false);
    const res = sh("run", env);
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(log)).toBe(false);
  });
});

describe("scripts/action.sh run — the docker run line", () => {
  it("starts the pinned image as the review verb for the PR, in the action route", () => {
    const r = rig();
    const res = sh("run", r.env());
    expect(res.status, res.stderr).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    const a = run.argv;
    const image = a.indexOf("ghcr.io/acme/qcr:1.2.3");
    expect(image).toBeGreaterThan(0);
    expect(a.slice(image)).toEqual([
      "ghcr.io/acme/qcr:1.2.3",
      "cli",
      "review",
      "7",
      "--repo",
      "acme/widgets",
      "--to",
      "pr,terminal,json",
    ]);
    expect(a).toContain("QCR_ROUTE=action");
    // the throwaway container of the wrapper: no socket, nothing kept
    expect(a).toEqual(expect.arrayContaining(["--rm", "--init", "--cap-drop", "ALL"]));
    expect(a).toEqual(expect.arrayContaining(["--security-opt", "no-new-privileges"]));
    expect(a.join(" ")).not.toContain("docker.sock");
    expect(a.join(" ")).not.toContain("--privileged");
    // the model's tools get another uid: root start, ids named
    expect(a).toEqual(expect.arrayContaining(["--user", "0:0", "--cap-add", "SETUID"]));
    expect(a.some((x) => x.startsWith("QCR_RUN_UID="))).toBe(true);
    // the repo read-only
    expect(a).toContain(`type=bind,src=${join(r.dir, "workspace")},dst=/repo,readonly`);
    // The state lives in the container's /tmp, never under the image's /opt/qcr:
    // the review host refuses a run directory inside the qcr tree.
    // MUTATION: put the state back at QCR_STATE_HOME=/opt/qcr/state/home and this fails.
    expect(a).toContain("QCR_STATE_HOME=/tmp/qcr/home");
    expect(a.filter((x) => /^QCR_STATE_HOME=\/opt\/qcr(\/|$)/.test(x) || /dst=\/opt\/qcr(\/|,|$)/.test(x))).toEqual([]);
  });

  it("sets no cost cap by default, and --limit only when one is given", () => {
    const none = rig();
    expect(sh("run", none.env()).status).toBe(0);
    expect(calls(none.dir).find((c) => c.verb === "run")!.argv).not.toContain("--limit");

    const some = rig();
    expect(sh("run", some.env({ QCR_ACTION_LIMIT: "5.5" })).status).toBe(0);
    const a = calls(some.dir).find((c) => c.verb === "run")!.argv;
    expect(a.slice(a.indexOf("--limit"))).toEqual(["--limit", "5.5"]);

    for (const bad of ["0", "-1", "abc", "5; rm -rf /", "0.0"]) {
      const b = rig();
      expect(sh("run", b.env({ QCR_ACTION_LIMIT: bad })).status, bad).toBe(1);
      expect(
        calls(b.dir).find((c) => c.verb === "run"),
        bad,
      ).toBeUndefined();
    }
  });

  it("passes --model only when the model input is given, and refuses what is not a model spec", () => {
    const none = rig();
    expect(sh("run", none.env()).status).toBe(0);
    expect(calls(none.dir).find((c) => c.verb === "run")!.argv).not.toContain("--model");

    const some = rig();
    const res = sh("run", some.env({ QCR_ACTION_MODEL: "made-up/large-3:high" }));
    expect(res.status, res.stderr).toBe(0);
    const a = calls(some.dir).find((c) => c.verb === "run")!.argv;
    // An argument of the review, after the image: never an option of docker.
    expect(a.indexOf("--model")).toBeGreaterThan(a.indexOf("ghcr.io/acme/qcr:1.2.3"));
    expect(a.slice(a.indexOf("--model"))).toEqual(["--model", "made-up/large-3:high"]);

    for (const bad of ["--rm", "a b", "x; id", "$(id)", "-e"]) {
      const b = rig();
      expect(sh("run", b.env({ QCR_ACTION_MODEL: bad })).status, bad).toBe(1);
      expect(
        calls(b.dir).find((c) => c.verb === "run"),
        bad,
      ).toBeUndefined();
    }
  });

  const envNamesOf = (argv: string[]): string[] =>
    argv.flatMap((x, i) => (argv[i - 1] === "-e" ? [x] : []));

  // MUTATION: forward `-e "$key=${!key}"` in run_review — the value is in the
  // docker command line and this fails.
  it("forwards any provider's credential the step's env holds, by name only", () => {
    const r = rig();
    const res = sh(
      "run",
      r.env({
        XAI_API_KEY: "value-of-x",
        HF_TOKEN: "value-of-h",
        AWS_ACCESS_KEY_ID: "value-of-id",
        AWS_SECRET_ACCESS_KEY: "value-of-secret",
        DIGITALOCEAN_API_KEY: "value-of-d",
        QCR_DEBUG: "1",
        NOT_A_MODEL_NAME: "value-of-n",
      }),
    );
    expect(res.status, res.stderr).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    const names = envNamesOf(run.argv);
    expect(names).toEqual(
      expect.arrayContaining([
        "XAI_API_KEY",
        "HF_TOKEN",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "DIGITALOCEAN_API_KEY",
        "QCR_DEBUG",
      ]),
    );
    // A name pi does not read is not forwarded, and a name that is unset is not either.
    expect(names).not.toContain("NOT_A_MODEL_NAME");
    expect(names).not.toContain("OPENAI_API_KEY");
    for (const v of ["value-of-x", "value-of-h", "value-of-id", "value-of-secret", "value-of-d"])
      expect(run.argv.join("\n")).not.toContain(v);
    // The GitHub token is still in no name and no argument.
    expect(run.argv.join("\n")).not.toContain(TOKEN);
    expect(names.filter((n) => /^(GH|GITHUB)_/.test(n))).toEqual([]);
  });

  // Temporary AWS credentials are three values: pi reads the session token
  // when it makes a request, so the generated block does not hold the name.
  // MUTATION: drop $MODEL_ENV_COMPANIONS from the loop in forward_names — the
  // key pair travels without its session token and this fails.
  it("forwards the session token of temporary AWS credentials beside the key pair", () => {
    const r = rig();
    const res = sh(
      "run",
      r.env({
        AWS_ACCESS_KEY_ID: "value-of-id",
        AWS_SECRET_ACCESS_KEY: "value-of-secret",
        AWS_SESSION_TOKEN: "value-of-session",
      }),
    );
    expect(res.status, res.stderr).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    expect(envNamesOf(run.argv)).toEqual(
      expect.arrayContaining(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]),
    );
    expect(run.argv.join("\n")).not.toContain("value-of-session");
    // Named in QCR_MODEL_ENV it is no refusal either.
    const named = rig();
    expect(
      sh("run", named.env({ QCR_MODEL_ENV: "AWS_SESSION_TOKEN", AWS_SESSION_TOKEN: "x" })).status,
    ).toBe(0);
  });

  // A name that points at a profile or a file on the runner is set in the
  // container and names nothing there: pi would count the provider as
  // credentialed on the name alone and fail at its first call.
  // MUTATION: drop the host_only test from the loop in forward_names — the
  // names below reach the container and this fails.
  it("never forwards a name that points at a profile or a file on the runner", () => {
    const r = rig();
    const file = join(r.dir, "adc.json");
    writeFileSync(file, "{}");
    const res = sh(
      "run",
      r.env({
        AWS_PROFILE: "work",
        AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/token",
        ANTHROPIC_IDENTITY_TOKEN_FILE: "/var/run/other",
        GOOGLE_APPLICATION_CREDENTIALS: file,
        QCR_MODEL_ENV: "MY_CA_BUNDLE",
        MY_CA_BUNDLE: file,
        XAI_API_KEY: "value-of-x",
      }),
    );
    expect(res.status, res.stderr).toBe(0);
    const names = envNamesOf(calls(r.dir).find((c) => c.verb === "run")!.argv);
    for (const n of [
      "AWS_PROFILE",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "MY_CA_BUNDLE",
    ])
      expect(names, n).not.toContain(n);
    expect(names).toContain("XAI_API_KEY");
  });

  it("QCR_MODEL_ENV adds names; this program's own, a token-shaped one and a malformed one are refused", () => {
    const r = rig();
    const res = sh(
      "run",
      r.env({
        QCR_MODEL_ENV: "MY_GATEWAY_URL, MY_GATEWAY_KEY UNSET_ONE",
        MY_GATEWAY_URL: "value-of-url",
        MY_GATEWAY_KEY: "value-of-key",
      }),
    );
    expect(res.status, res.stderr).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    expect(envNamesOf(run.argv)).toEqual(
      expect.arrayContaining(["MY_GATEWAY_URL", "MY_GATEWAY_KEY"]),
    );
    expect(envNamesOf(run.argv)).not.toContain("UNSET_ONE");
    expect(run.argv.join("\n")).not.toContain("value-of-url");

    const refused: Array<[string, RegExp]> = [
      ["GH_TOKEN", /GH_TOKEN is not a model setting/],
      ["GITHUB_TOKEN", /not a model setting/],
      ["QCR_ACTION_GH_TOKEN", /not a model setting/],
      ["PI_CODING_AGENT_DIR", /not a model setting/],
      ["GIT_CONFIG_GLOBAL", /not a model setting/],
      ["OPENVIKING_ROOT_KEY", /not a model setting/],
      ["MY_SECRET", /MY_SECRET is not forwarded/],
      ["SOME_TOKEN", /SOME_TOKEN is not forwarded/],
      ["lower_case", /names of environment variables/],
      ["A=b", /names of environment variables/],
      ["9LIVES", /not the name of an environment variable/],
    ];
    for (const [value, why] of refused) {
      const b = rig();
      const out = sh("run", b.env({ QCR_MODEL_ENV: value }));
      expect(out.status, value).toBe(1);
      expect(out.stderr, value).toMatch(why);
      // The refusal ends the step: an annotation, and no container.
      expect(out.stdout, value).toContain("::error::qcr action:");
      expect(
        calls(b.dir).find((c) => c.verb === "run"),
        value,
      ).toBeUndefined();
    }
    // One of pi's own names may be repeated there, whatever it is called.
    const own = rig();
    expect(sh("run", own.env({ QCR_MODEL_ENV: "HF_TOKEN", HF_TOKEN: "x" })).status).toBe(0);
  });

  // MUTATION: map the inputs straight onto the variables in action.yml and
  // drop the loop in run_review — the workflow's own key is blanked by an
  // empty input and this fails (with the action.yml case above).
  it("a key input becomes the variable pi reads; an empty input leaves the step's own key alone", () => {
    const given = rig();
    const res = sh("run", given.env({ QCR_ACTION_ANTHROPIC_API_KEY: "value-from-input" }));
    expect(res.status, res.stderr).toBe(0);
    const a = calls(given.dir).find((c) => c.verb === "run")!;
    expect(envNamesOf(a.argv)).toContain("ANTHROPIC_API_KEY");
    // docker reads the value from its own environment, under the variable's name.
    expect(a.env).toContain("ANTHROPIC_API_KEY=value-from-input");
    expect(a.env).not.toContain("QCR_ACTION_ANTHROPIC_API_KEY");
    expect(a.argv.join("\n")).not.toContain("value-from-input");

    const own = rig();
    expect(
      sh("run", own.env({ QCR_ACTION_OPENAI_API_KEY: "", OPENAI_API_KEY: "value-from-env" }))
        .status,
    ).toBe(0);
    const b = calls(own.dir).find((c) => c.verb === "run")!;
    expect(envNamesOf(b.argv)).toContain("OPENAI_API_KEY");
    expect(b.env).toContain("OPENAI_API_KEY=value-from-env");
  });

  it("holds no token: not in the argv, not in -e, not in an env file, not in docker's environment", () => {
    const r = rig();
    const res = sh("run", r.env({ OPENAI_API_KEY: "sk-test-key-value" }));
    expect(res.status, res.stderr).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    expect(run.argv.join("\n")).not.toContain(TOKEN);
    expect(run.env).not.toContain(TOKEN);
    expect(res.stdout + res.stderr).not.toContain(TOKEN);
    const envNames = run.argv.flatMap((x, i) => (run.argv[i - 1] === "-e" ? [x] : []));
    for (const e of envNames.filter((x) => !x.startsWith("QCR_GH_TOKEN_FILE=")))
      expect(e).not.toMatch(/TOKEN|SECRET|PASSWORD|QCR_ACTION/);
    expect(envNames).toContain("QCR_GH_TOKEN_FILE=/run/qcr-in/gh-token");
    expect(run.argv.some((x) => x.startsWith("--env-file"))).toBe(false);
    // a model key goes by name, its value is never in the line
    expect(envNames).toContain("OPENAI_API_KEY");
    expect(run.argv.join("\n")).not.toContain("sk-test-key-value");
  });

  it("hands the token over as a 0600 file in a 0700 directory under RUNNER_TEMP, gone afterwards", () => {
    const r = rig();
    expect(sh("run", r.env()).status).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    expect(run.files("tokdir_mode").trim()).toBe("700");
    expect(run.files("tokfile_mode").trim()).toBe("600");
    expect(run.files("token_seen")).toBe(TOKEN);
    expect(run.files("tokdir_ls").trim()).toBe("gh-token");
    const mount = run.argv.find((x) => x.endsWith(",dst=/run/qcr-in"))!;
    expect(mount.startsWith(`type=bind,src=${r.work}${"/"}qcr-in.`)).toBe(true);
    // the run removes the directory itself once the container has ended
    const left = existsSync(r.work)
      ? readdirSync(r.work).filter((f) => f.startsWith("qcr-in"))
      : [];
    expect(left).toEqual([]);
  });

  it("removes the token directory when the container fails", () => {
    const r = rig();
    const res = sh("run", r.env({ FAKE_DOCKER_RC: "125" }));
    expect(res.status).toBe(125);
    expect(res.stderr).toContain("docker could not start the container");
    expect(readdirSync(r.work).filter((f) => f.startsWith("qcr-in"))).toEqual([]);
  });

  it("starts no memory service: no sidecar, link, network or memory env on the line, memory off in the config", () => {
    const r = rig();
    expect(sh("run", r.env()).status).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    const options = run.argv.slice(0, run.argv.indexOf("ghcr.io/acme/qcr:1.2.3"));
    const text = options.filter((x) => !x.startsWith("type=bind")).join("\n");
    expect(text).not.toMatch(/openviking|memory|--link|--network|--net\b/i);
    // one docker run, nothing else started beside it
    expect(calls(r.dir).map((c) => c.verb)).toEqual(["run"]);
    const cfg = parseConfig(run.files("config.toml"));
    expect(cfg.openviking.enabled).toBe(false);
  });

  it("refuses a command line that would carry the token or a memory service", () => {
    // assert_argv, driven directly
    const probe = (argv: string[]) =>
      spawnSync(
        "bash",
        [
          "-c",
          `set -euo pipefail; source <(sed '/^case "\${1:-}" in$/,$d' "${SCRIPT}"); assert_argv "$@"`,
          "x",
          TOKEN,
          "IMG:1",
          ...argv,
        ],
        { encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" } },
      );
    expect(probe(["docker", "run", "-e", "QCR_ROUTE=action", "IMG:1", "cli"]).status).toBe(0);
    expect(probe(["docker", "run", "-e", `GH_TOKEN=${TOKEN}`, "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "-e", "GH_TOKEN", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "-e", "GITHUB_TOKEN", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "--env-file", "/x", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "IMG:1", "cli", "review", TOKEN]).status).toBe(1);
    expect(probe(["docker", "run", "--link", "quickreview-memory", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "--network", "memory_net", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "-e", "QCR_MEMORY=on", "IMG:1"]).status).toBe(1);
    // One of pi's own model names passes by name, and by name only; a name
    // of the same shape that is not pi's does not.
    // MUTATION: let any `*_TOKEN` through assert_argv ahead of the refusal —
    // MY_TOKEN passes and this fails.
    expect(probe(["docker", "run", "-e", "HF_TOKEN", "IMG:1"]).status).toBe(0);
    expect(probe(["docker", "run", "-e", "AWS_SECRET_ACCESS_KEY", "IMG:1"]).status).toBe(0);
    expect(probe(["docker", "run", "-e", "HF_TOKEN=abc", "IMG:1"]).status).toBe(1);
    // the session token of temporary AWS credentials is pi's own too
    expect(probe(["docker", "run", "-e", "AWS_SESSION_TOKEN", "IMG:1"]).status).toBe(0);
    expect(probe(["docker", "run", "-e", "AWS_SESSION_TOKEN=abc", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "-e", "MY_TOKEN", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "-e", "DB_PASSWORD", "IMG:1"]).status).toBe(1);
    expect(probe(["docker", "run", "--env", "COPILOT_GITHUB_TOKEN", "IMG:1"]).status).toBe(0);
    // a mount path or a repository named after a memory engine is no service
    expect(
      probe([
        "docker",
        "run",
        "--mount",
        "type=bind,src=/w/openviking,dst=/repo",
        "IMG:1",
        "cli",
        "--repo",
        "a/openviking",
      ]).status,
    ).toBe(0);
  });

  it("stages the pi login read-only, empty without one", () => {
    const none = rig();
    expect(sh("run", none.env()).status).toBe(0);
    const a = calls(none.dir).find((c) => c.verb === "run")!;
    expect(a.files("login_ls").trim()).toBe("");
    expect(a.argv).toContain("PI_CODING_AGENT_DIR=/qcr-login");

    const withAuth = rig();
    expect(sh("run", withAuth.env({ QCR_ACTION_PI_AUTH: '{"openai-codex":{}}' })).status).toBe(0);
    const b = calls(withAuth.dir).find((c) => c.verb === "run")!;
    expect(b.files("login_ls").trim()).toBe("auth.json");
    expect(b.files("login_mode").trim()).toBe("700");
    expect(b.argv.join("\n")).not.toContain("openai-codex");
    expect(b.env).not.toContain("openai-codex");
  });

  it("runs in an empty git repository when the job checked nothing out", () => {
    const r = rig({ workspace: false });
    expect(sh("run", r.env()).status).toBe(0);
    const a = calls(r.dir).find((c) => c.verb === "run")!.argv;
    expect(a).toContain(`type=bind,src=${join(r.work, "repo")},dst=/repo,readonly`);
    expect(existsSync(join(r.work, "repo", ".git"))).toBe(true);
  });

  it("refuses a missing or odd PR number, repository and token", () => {
    const cases: Record<string, string>[] = [
      { QCR_ACTION_PR: "" },
      { QCR_ACTION_PR: "7; id" },
      { QCR_ACTION_PR: "0" },
      { QCR_ACTION_REPO: "not a repo" },
      { QCR_ACTION_GH_TOKEN: "" },
    ];
    for (const env of cases) {
      const r = rig();
      const res = sh("run", r.env(env));
      expect(res.status, JSON.stringify(env)).toBe(1);
      expect(calls(r.dir)).toEqual([]);
    }
  });

  it("derives the image from package.json's repository url and version by default", () => {
    const pkg = JSON.parse(read("package.json")) as {
      version: string;
      repository: { url: string };
    };
    const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(pkg.repository.url)!;
    const r = rig();
    const res = sh("image", r.env({ QCR_ACTION_IMAGE: "" }));
    expect(res.stdout.trim()).toBe(
      `ghcr.io/${m[1]!.toLowerCase()}/${m[2]!.toLowerCase()}:${pkg.version}`,
    );
    expect(sh("image", r.env({ QCR_ACTION_IMAGE: "x y" })).status).toBe(1);
    expect(sh("image", r.env({ QCR_ACTION_IMAGE: "--privileged" })).status).toBe(1);
  });
});

describe("scripts/action.sh run — post and profile", () => {
  const reviewArgs = (r: Rig): string[] => {
    const a = calls(r.dir).find((c) => c.verb === "run")!.argv;
    return a.slice(a.indexOf("ghcr.io/acme/qcr:1.2.3"));
  };

  // MUTATION: always pass `--to pr,terminal,json` in run_review — the
  // post: false case fails.
  it("posts per the post input, always with the JSON result, and refuses any other value", () => {
    const cases: Array<[Record<string, string>, string]> = [
      [{}, "pr,terminal,json"],
      [{ QCR_ACTION_POST: "true" }, "pr,terminal,json"],
      [{ QCR_ACTION_POST: "false" }, "terminal,json"],
    ];
    for (const [env, to] of cases) {
      const r = rig();
      const res = sh("run", r.env(env));
      expect(res.status, res.stderr).toBe(0);
      const a = reviewArgs(r);
      // an argument of the review, after the image
      expect(a.slice(a.indexOf("--to"), a.indexOf("--to") + 2), to).toEqual(["--to", to]);
    }
    for (const bad of ["yes", "False", "1", "pr"]) {
      const b = rig();
      const res = sh("run", b.env({ QCR_ACTION_POST: bad }));
      expect(res.status, bad).toBe(1);
      expect(res.stdout, bad).toContain("::error::qcr action: post must be true or false");
      expect(
        calls(b.dir).find((c) => c.verb === "run"),
        bad,
      ).toBeUndefined();
    }
  });

  // MUTATION: add `--profile "$profile"` to the docker options ahead of the
  // image in run_review — this fails.
  it("passes --profile after the image only when a profile is given, and refuses what is not a profile name", () => {
    const none = rig();
    expect(sh("run", none.env()).status).toBe(0);
    expect(calls(none.dir).find((c) => c.verb === "run")!.argv).not.toContain("--profile");

    const some = rig();
    const res = sh("run", some.env({ QCR_ACTION_PROFILE: "state-machines" }));
    expect(res.status, res.stderr).toBe(0);
    const a = reviewArgs(some);
    expect(a.slice(a.indexOf("--profile"), a.indexOf("--profile") + 2)).toEqual([
      "--profile",
      "state-machines",
    ]);
    const all = calls(some.dir).find((c) => c.verb === "run")!.argv;
    expect(all.indexOf("--profile")).toBeGreaterThan(all.indexOf("ghcr.io/acme/qcr:1.2.3"));

    for (const bad of ["Security", "../x", "-x", "a b", "x;id", "x".repeat(65), ".hidden"]) {
      const b = rig();
      expect(sh("run", b.env({ QCR_ACTION_PROFILE: bad })).status, bad).toBe(1);
      expect(
        calls(b.dir).find((c) => c.verb === "run"),
        bad,
      ).toBeUndefined();
    }
  });
});

// The review's JSON result: what `--to …,json` prints as its last stdout line
// (schemas/review-result.v2.json).
const REVIEW_URL = "https://github.com/acme/widgets/pull/7#pullrequestreview-11";
const RESULT = {
  schema_version: 2,
  ok: true,
  partial: false,
  findings: {
    P1: [{ path: "src/a.ts", line: 2, severity: "P1", title: "b is wrong", lens: "correctness" }],
    P2: [
      { path: "src/b.ts", line: 9, severity: "P2", title: "c leaks", lens: "resources" },
      { path: null, line: null, severity: "P2", title: "the doc is stale", lens: null },
    ],
  },
  doubted: [],
  verdict: "REQUEST_CHANGES",
  cost_usd: 1.234,
  post: { ok: true, posted: 3, skipped: 0, url: REVIEW_URL },
};
const TEXT = ["repo: acme/widgets", "Review done: REQUEST_CHANGES ($1.23)", "Findings (3)"];

describe("scripts/action.sh run — the result", () => {
  /** A run whose fake docker prints these lines (FAKE_DOCKER_RC in extra is its exit code). */
  function review(lines: string[], extra: Record<string, string> = {}) {
    const r = rig();
    const stdout = join(r.dir, "docker-stdout");
    writeFileSync(stdout, lines.map((l) => `${l}\n`).join(""));
    const outFile = join(r.dir, "github-output");
    const sumFile = join(r.dir, "step-summary");
    const res = sh(
      "run",
      r.env({
        FAKE_DOCKER_STDOUT: stdout,
        GITHUB_OUTPUT: outFile,
        GITHUB_STEP_SUMMARY: sumFile,
        ...extra,
      }),
    );
    return {
      r,
      res,
      outputs: outputsOf(outFile),
      entries: outputEntries(outFile),
      summary: textOf(sumFile),
    };
  }
  /** The table rows of a summary. */
  const rows = (summary: string): string[] => summary.split("\n").filter((l) => l.startsWith("| "));

  // MUTATION: pick the first stdout line that parses as a result in
  // RESULT_JS — an earlier JSON line wins and this fails.
  it("sets the outputs from the last stdout line that is a JSON result", () => {
    const earlier = JSON.stringify({ schema_version: 2, ok: false, errors: ["not this one"] });
    const { res, outputs } = review([
      ...TEXT,
      earlier,
      "Posted 3 comments",
      JSON.stringify(RESULT),
    ]);
    expect(res.status, res.stderr).toBe(0);
    expect(outputs).toEqual({
      "review-url": REVIEW_URL,
      verdict: "REQUEST_CHANGES",
      findings: "3",
      "cost-usd": "1.234",
      result: JSON.stringify(RESULT),
    });
    expect(JSON.parse(outputs["result"]!)).toEqual(RESULT);
  });

  // MUTATION: write `name<<EOF` in put_output — every entry shares one
  // delimiter and this fails.
  it("writes each output under a delimiter of its own", () => {
    const { entries } = review([...TEXT, JSON.stringify(RESULT)]);
    expect(entries).toHaveLength(5);
    for (const e of entries) expect(e.delimiter, e.name).toMatch(/^ghadelimiter_[0-9a-f]{32}$/);
    expect(new Set(entries.map((e) => e.delimiter)).size).toBe(entries.length);
  });

  // MUTATION: leave the Where cell (path:line) out of RESULT_JS's rows — this
  // fails.
  it("writes a job summary: the pull request, the verdict, the link, the cost and the findings", () => {
    const { summary } = review([...TEXT, JSON.stringify(RESULT)]);
    expect(summary).toContain("### QuickReview");
    expect(summary).toContain("acme/widgets#7");
    expect(summary).toContain("- Verdict: Changes requested");
    expect(summary).toContain(`- Review: <${REVIEW_URL}>`);
    expect(summary).toContain("- Cost: $1.23");
    expect(rows(summary)).toEqual([
      "| Severity | Where | Finding | Lens |",
      "| P1 | src/a.ts:2 | b is wrong | correctness |",
      "| P2 | src/b.ts:9 | c leaks | resources |",
      "| P2 |  | the doc is stale |  |",
    ]);
  });

  // An unknown cost is no zero (AGENTS.md, honest-unknown rendering).
  // MUTATION: write cost-usd as "0" when cost_usd is null in RESULT_JS —
  // this fails.
  it("says not posted, no verdict and an unknown cost when the result has none", () => {
    const { outputs, summary } = review([
      JSON.stringify({ ...RESULT, verdict: null, cost_usd: null, post: undefined, findings: {} }),
    ]);
    expect(outputs["review-url"]).toBe("");
    expect(outputs["verdict"]).toBe("");
    expect(outputs["cost-usd"]).toBe("");
    expect(outputs["findings"]).toBe("0");
    expect(summary).toContain("- Review: not posted");
    expect(summary).toContain("- Verdict: none");
    expect(summary).toContain("- Cost: unknown");
    expect(summary).toContain("No findings.");
  });

  // A title is the model's text: it must stay inside its cell and render as text.
  // MUTATION: drop the `|` escape from cell() in RESULT_JS — the title's
  // pipe splits its row and this fails.
  it("escapes the review's text in the table: pipes, newlines, backticks and HTML", () => {
    const finding = {
      path: "src/a|b.ts",
      line: 3,
      severity: "P1",
      title: "a | b\nc `d` <img src=x>",
      lens: "x|y",
    };
    const { summary } = review([JSON.stringify({ ...RESULT, findings: { P1: [finding] } })]);
    expect(rows(summary)[1]).toBe(
      "| P1 | src/a\\|b.ts:3 | a \\| b c \\`d\\` &lt;img src=x&gt; | x\\|y |",
    );
    // every row keeps its four cells: five pipes that no backslash escapes
    for (const row of rows(summary)) expect(row.match(/(?<!\\)\|/g), row).toHaveLength(5);
    expect(summary).not.toContain("<img");
  });

  // MUTATION: drop `.slice(0, 50)` from RESULT_JS — this fails.
  it("lists at most 50 findings, and says how many more there are", () => {
    const many = Array.from({ length: 53 }, (_, i) => ({
      path: `src/f${i}.ts`,
      line: i + 1,
      severity: "P2",
      title: `finding ${i}`,
      lens: "correctness",
    }));
    const { outputs, summary } = review([JSON.stringify({ ...RESULT, findings: { P2: many } })]);
    expect(outputs["findings"]).toBe("53");
    expect(rows(summary).filter((r) => r.startsWith("| P2 "))).toHaveLength(50);
    expect(summary).toContain("… 3 more");
  });

  // MUTATION: return from run_review before report_result when docker
  // exits non-zero — the summary is missing and this fails.
  it("says the review did not finish when it printed no result, and keeps docker's exit code", () => {
    const { res, outputs, summary } = review(TEXT, { FAKE_DOCKER_RC: "1" });
    expect(res.status).toBe(1);
    expect(outputs).toEqual({});
    expect(summary).toContain("acme/widgets#7");
    expect(summary).toContain("The review did not finish (exit code 1) and printed no result.");
    expect(summary).toContain("log");
  });

  // MUTATION: end run_review with `return 0` — this fails.
  it("keeps docker's exit code when the review printed a result, and says it did not finish", () => {
    const capped = { ...RESULT, ok: false, partial: true, post: undefined, verdict: null };
    const { res, outputs, summary } = review([...TEXT, JSON.stringify(capped)], {
      FAKE_DOCKER_RC: "1",
    });
    expect(res.status).toBe(1);
    expect(outputs["findings"]).toBe("3");
    expect(outputs["review-url"]).toBe("");
    expect(summary).toContain("The review did not finish: it stopped at the cost limit");
    // a failed run's errors are said, escaped like a cell
    const failed = review(
      [JSON.stringify({ schema_version: 2, ok: false, errors: ["no <key>"] })],
      {
        FAKE_DOCKER_RC: "1",
      },
    );
    expect(failed.res.status).toBe(1);
    expect(failed.outputs["findings"]).toBe("");
    expect(failed.summary).toContain("The review did not finish: no &lt;key&gt;");
  });

  // MUTATION: print every line in the awk filter of run_review — the JSON
  // line reaches the log and this fails.
  it("streams the review's text to the log and holds the JSON line back from it", () => {
    const { r, res } = review([...TEXT, JSON.stringify(RESULT)]);
    expect(res.status, res.stderr).toBe(0);
    for (const line of TEXT) expect(res.stdout).toContain(line);
    expect(res.stdout).not.toContain('"schema_version"');
    expect(res.stderr).toContain("not in the log");
    // the whole stdout is kept under the staging directory
    expect(readFileSync(join(r.work, "review-stdout.txt"), "utf8")).toBe(
      [...TEXT, JSON.stringify(RESULT)].map((l) => `${l}\n`).join(""),
    );
  });

  // MUTATION: drop the line of RESULT_JS that writes a held line that is no
  // result back to stdout — this fails.
  it("gives a last line back to the log when it is not a result", () => {
    const { res, outputs } = review([...TEXT, "{not json"]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("{not json");
    expect(outputs).toEqual({});
  });

  // MUTATION: return 1 from report_result when a write fails — the step's
  // exit code changes and this fails.
  it("warns when it cannot write the outputs or the summary, and keeps the exit code", () => {
    const r = rig();
    const stdout = join(r.dir, "docker-stdout");
    writeFileSync(stdout, `${JSON.stringify(RESULT)}\n`);
    const res = sh(
      "run",
      r.env({
        FAKE_DOCKER_STDOUT: stdout,
        // a directory: no file can be appended to it
        GITHUB_OUTPUT: r.dir,
        GITHUB_STEP_SUMMARY: r.dir,
      }),
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("::warning::qcr action: could not write the step outputs");
    expect(res.stdout).toContain("::warning::qcr action: could not write the job summary");
  });

  // Every tool the run uses, linked into one directory, and node left out.
  const TOOLS = [
    "bash",
    "cat",
    "chmod",
    "cp",
    "dirname",
    "env",
    "grep",
    "head",
    "id",
    "ls",
    "mkdir",
    "mktemp",
    "od",
    "rm",
    "sed",
    "stat",
    "tail",
    "tr",
    "awk",
  ];
  function toolsWithoutNode(dir: string): string | null {
    const tools = join(dir, "tools");
    mkdirSync(tools);
    for (const t of TOOLS) {
      const found = spawnSync("bash", ["-c", `command -v ${t}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (!found.startsWith("/")) return null;
      symlinkSync(found, join(tools, t));
    }
    return tools;
  }

  // MUTATION: drop the `command -v node` branch from report_result — the JSON
  // line is lost from the log and this fails.
  it("without node, warns and sets no outputs and no summary, and the log keeps the JSON line", () => {
    const r = rig();
    const tools = toolsWithoutNode(r.dir);
    if (tools === null) return; // a tool is missing here; the runner has them all
    const stdout = join(r.dir, "docker-stdout");
    writeFileSync(stdout, [...TEXT, JSON.stringify(RESULT)].map((l) => `${l}\n`).join(""));
    const outFile = join(r.dir, "github-output");
    const sumFile = join(r.dir, "step-summary");
    const env = r.env({
      FAKE_DOCKER_STDOUT: stdout,
      GITHUB_OUTPUT: outFile,
      GITHUB_STEP_SUMMARY: sumFile,
    });
    env.PATH = [join(r.dir, "bin"), tools].join(delimiter);
    const res = spawnSync(join(tools, "bash"), [SCRIPT, "run"], { env, encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain("::warning::qcr action: node is not on this runner");
    expect(res.stdout).toContain(JSON.stringify(RESULT));
    expect(existsSync(outFile)).toBe(false);
    expect(existsSync(sumFile)).toBe(false);
  });
});

describe("scripts/action.sh cleanup", () => {
  it("removes the staging directory, the docker login included", () => {
    const r = rig();
    expect(sh("login", r.env({ QCR_ACTION_REGISTRY_TOKEN: REGISTRY_SECRET })).status).toBe(0);
    expect(existsSync(join(r.work, "docker"))).toBe(true);
    expect(sh("cleanup", r.env()).status).toBe(0);
    expect(existsSync(r.work)).toBe(false);
  });
});

describe("scripts/action.sh login", () => {
  // MUTATION: drop the early return on an empty QCR_ACTION_REGISTRY_TOKEN in
  // `login`, with registry_credential falling back to QCR_ACTION_GH_TOKEN —
  // this fails.
  it("logs in nowhere without a registry token: the public image pulls anonymously", () => {
    const r = rig();
    const res = sh("login", r.env());
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).toContain("pulled anonymously");
    expect(calls(r.dir)).toEqual([]);
  });

  // MUTATION: move the `mkdir -p "$w/docker"` in `login` below the no-token
  // return — this fails.
  it("pulls anonymously from an empty docker config of its own, never the runner's logins", () => {
    const r = rig();
    expect(sh("login", r.env()).status).toBe(0);
    expect(readdirSync(join(r.work, "docker"))).toEqual([]);
    expect(sh("run", r.env()).status).toBe(0);
    expect(
      calls(r.dir)
        .find((c) => c.verb === "run")!
        .files("docker_config"),
    ).toBe(join(r.work, "docker"));
  });

  it("logs in with the registry token on stdin, to a docker config of its own", () => {
    const r = rig();
    const res = sh("login", r.env({ QCR_ACTION_REGISTRY_TOKEN: REGISTRY_SECRET }));
    expect(res.status, res.stderr).toBe(0);
    const login = calls(r.dir)[0]!;
    expect(login.argv).toEqual(["login", "ghcr.io", "-u", "octo", "--password-stdin"]);
    expect(login.files("stdin")).toBe(REGISTRY_SECRET);
    expect(login.argv.join("\n")).not.toContain(REGISTRY_SECRET);
    expect(login.files("docker_config")).toBe(join(r.work, "docker"));
  });

  it("run uses that docker config, and the registry secret never reaches the review", () => {
    const r = rig();
    const env = r.env({ QCR_ACTION_REGISTRY_TOKEN: REGISTRY_SECRET });
    expect(sh("login", env).status).toBe(0);
    expect(sh("run", env).status).toBe(0);
    const run = calls(r.dir).find((c) => c.verb === "run")!;
    expect(run.files("docker_config")).toBe(join(r.work, "docker"));
    expect(run.argv.join("\n")).not.toContain(REGISTRY_SECRET);
    expect(run.env).not.toContain(REGISTRY_SECRET);
    expect(run.files("token_seen")).toBe(TOKEN);
  });
});

// ---------------------------------------------------------------------------
// The preflight, against a stand-in registry
// ---------------------------------------------------------------------------

describe("scripts/action.sh preflight", () => {
  let server: Server;
  let base: string;
  const seen: Array<{ url: string; authorization: string | undefined }> = [];
  let answer: (url: string, auth: string | undefined) => [number, string] = () => [200, "{}"];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization });
      const [code, body] = answer(req.url ?? "", req.headers.authorization);
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  afterEach(() => {
    seen.length = 0;
    answer = () => [200, "{}"];
  });

  const preflight = (env: NodeJS.ProcessEnv) =>
    new Promise<{ status: number | null; out: string }>((done) => {
      const c = spawn("bash", [SCRIPT, "preflight"], { env });
      let out = "";
      c.stdout.on("data", (d: Buffer) => (out += d.toString()));
      c.stderr.on("data", (d: Buffer) => (out += d.toString()));
      c.on("close", (status) => done({ status, out }));
    });
  const basic = (user: string, token: string): string =>
    `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;

  // A registry that serves the public image to anyone, and refuses every
  // credential: what a repository the package grants nothing to looks like,
  // so a preflight that sent the workflow token would fail here.
  const publicOnly = (url: string, auth: string | undefined): [number, string] =>
    url.startsWith("/token")
      ? auth === undefined
        ? [200, '{"token":"anonpull"}']
        : [403, '{"errors":[{"code":"DENIED"}]}']
      : url === "/v2/acme/qcr/manifests/1.2.3" && auth === "Bearer anonpull"
        ? [200, "{}"]
        : [404, "{}"];

  // MUTATION: send the workflow token (QCR_ACTION_GH_TOKEN) as the preflight's
  // credential when no registry token is given — this fails.
  it("passes with no registry input on a repository the package grants nothing to", async () => {
    answer = publicOnly;
    const r = rig();
    const res = await preflight(r.env({ QCR_REGISTRY_API: base }));
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("ok: this repository can pull ghcr.io/acme/qcr:1.2.3");
    expect(seen[0]!.url).toContain("scope=repository:acme/qcr:pull");
    expect(seen[0]!.authorization).toBeUndefined();
    expect(seen[1]!.authorization).toBe("Bearer anonpull");
    expect(JSON.stringify(seen)).not.toContain(Buffer.from(`octo:${TOKEN}`).toString("base64"));
  });

  it("fails an anonymous refusal: the tag may be unpublished, and names the private-mirror route", async () => {
    answer = (url) =>
      url.startsWith("/token") ? [200, '{"token":"pulltoken"}'] : [403, '{"errors":[]}'];
    const r = rig();
    const res = await preflight(r.env({ QCR_REGISTRY_API: base }));
    expect(res.status).toBe(1);
    expect(res.out).toContain(
      "the qcr image ghcr.io/acme/qcr:1.2.3 cannot be pulled anonymously (HTTP 403)",
    );
    expect(res.out).toContain("release 1.2.3 is published");
    expect(res.out).toContain("registry-token");
    expect(res.out).toContain("read:packages");
    expect(res.out).toContain("Manage Actions access");
    expect(res.out).toContain("https://github.com/orgs/acme/packages/container/qcr/settings");
    expect(res.out).toContain("::error::");
    expect(res.out).not.toContain(TOKEN);
  });

  it("fails the same way when the token endpoint itself refuses", async () => {
    answer = () => [401, "{}"];
    const res = await preflight(rig().env({ QCR_REGISTRY_API: base }));
    expect(res.status).toBe(1);
    expect(res.out).toContain("cannot be pulled anonymously (HTTP 401)");
  });

  it("fails a refused registry token, saying the public image needs none", async () => {
    answer = (url) => (url.startsWith("/token") ? [200, '{"token":"t"}'] : [404, "{}"]);
    const res = await preflight(
      rig().env({ QCR_REGISTRY_API: base, QCR_ACTION_REGISTRY_TOKEN: REGISTRY_SECRET }),
    );
    expect(res.status).toBe(1);
    expect(res.out).toContain("the registry-token cannot pull the qcr image");
    expect(res.out).toContain("(HTTP 404)");
    expect(res.out).toContain("does not exist");
    expect(res.out).toContain("without registry-token it is pulled anonymously");
    expect(res.out).not.toContain(REGISTRY_SECRET);
  });

  it("checks with the registry token when one is given", async () => {
    answer = (url) => (url.startsWith("/token") ? [200, '{"token":"t"}'] : [200, "{}"]);
    const r = rig();
    const res = await preflight(
      r.env({
        QCR_REGISTRY_API: base,
        QCR_ACTION_REGISTRY_TOKEN: REGISTRY_SECRET,
        QCR_ACTION_REGISTRY_USER: "bot",
      }),
    );
    expect(res.status, res.out).toBe(0);
    expect(seen[0]!.authorization).toBe(basic("bot", REGISTRY_SECRET));
  });

  it("only warns when the registry errors, leaving the pull to say", async () => {
    answer = () => [503, "{}"];
    const res = await preflight(rig().env({ QCR_REGISTRY_API: base }));
    expect(res.status).toBe(0);
    expect(res.out).toContain("::warning::");
  });

  it("is skipped for a registry other than ghcr.io", async () => {
    const res = await preflight(rig().env({ QCR_ACTION_IMAGE: "registry.example.com/a/b:1" }));
    expect(res.status, res.out).toBe(0);
    expect(res.out).toContain("preflight skipped");
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate, against a stand-in for GitHub's API
// ---------------------------------------------------------------------------

/** What the stand-in answers: an open pull request #7 of acme/widgets, from a branch of it. */
interface World {
  /** The permission GitHub says the actor has, or an HTTP status to fail with. */
  permission?: string | number;
  /** Fields over the open pull request, an HTTP status to fail with, or a
   * 200 body of its own (text that is not JSON). */
  pull?: Record<string, unknown> | number | string;
}
const PERMISSION_URL = /^\/repos\/acme\/widgets\/collaborators\/([^/]+)\/permission$/;
function github(w: World, url: string): [number, string] {
  if (PERMISSION_URL.test(url)) {
    const p = w.permission ?? "write";
    if (typeof p === "number") return [p, '{"message":"x"}'];
    // the user object carries a permissions map of its own: the gate reads the top-level field
    return [
      200,
      JSON.stringify({
        permission: p,
        role_name: p,
        user: { login: "x", permissions: { admin: true } },
      }),
    ];
  }
  if (url === "/repos/acme/widgets/pulls/7") {
    const p = w.pull ?? {};
    if (typeof p === "number") return [p, '{"message":"Not Found"}'];
    if (typeof p === "string") return [200, p];
    return [
      200,
      JSON.stringify({
        number: 7,
        state: "open",
        merged: false,
        draft: false,
        head: { sha: "abc", repo: { full_name: "acme/widgets" } },
        base: { ref: "main", repo: { full_name: "acme/widgets" } },
        ...p,
      }),
    ];
  }
  return [404, '{"message":"Not Found"}'];
}

const PR_EVENT = { action: "opened", pull_request: { number: 7 } };
const ON_PR = { action: "created", issue: { number: 7, pull_request: { url: "u" } }, comment: {} };
const ON_ISSUE = { action: "created", issue: { number: 7 }, comment: { body: "/qcr" } };
const FROM_FORK = { head: { sha: "abc", repo: { full_name: "stranger/widgets" } } };
const NO_KEY = { XAI_API_KEY: "" };
const NO_WRITE =
  "`octo` has no write access to `acme/widgets`: name them in allowed-users to let them start reviews";
const FORK_SKIP =
  "a pull request from a fork: GitHub gives this event no secrets. Ask for the review with a comment instead (docs/action.md)";
const NO_CREDENTIAL =
  "no model credential: set a provider's API key in this step's env (docs/action.md#any-providers-key), or a key input";

describe("scripts/action.sh gate", () => {
  let server: Server;
  let base: string;
  const seen: Array<{ method: string; url: string; authorization: string | undefined }> = [];
  let world: World = {};
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
      });
      const [code, body] = github(world, req.url ?? "");
      res.writeHead(code, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());
  afterEach(() => {
    seen.length = 0;
    world = {};
  });

  interface GateRun extends Ran {
    outputs: Record<string, string>;
    entries: OutputEntry[];
    summary: string;
    requests: Array<{ method: string; url: string; authorization: string | undefined }>;
    docker: Call[];
  }
  /**
   * One gate run: a pull_request event for #7 started by octo, a model key in
   * the step's env, and GitHub answering from `world`.
   */
  async function gate(
    opts: {
      event?: string;
      payload?: unknown;
      /** The event file's text as it is, in place of a JSON payload. */
      rawPayload?: string;
      world?: World;
      env?: Record<string, string>;
      pathFirst?: string;
    } = {},
  ): Promise<GateRun> {
    world = opts.world ?? {};
    seen.length = 0;
    const r = rig();
    const eventFile = join(r.dir, "event.json");
    writeFileSync(eventFile, opts.rawPayload ?? JSON.stringify(opts.payload ?? PR_EVENT));
    const outFile = join(r.dir, "github-output");
    const sumFile = join(r.dir, "step-summary");
    const env = r.env({
      QCR_ACTION_PR: "",
      GITHUB_API_URL: base,
      GITHUB_EVENT_NAME: opts.event ?? "pull_request",
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_OUTPUT: outFile,
      GITHUB_STEP_SUMMARY: sumFile,
      QCR_ACTION_HAS_KEY_INPUT: "false",
      QCR_ACTION_HAS_PI_AUTH: "false",
      XAI_API_KEY: "value-of-x",
      ...opts.env,
    });
    if (opts.pathFirst) env.PATH = [opts.pathFirst, env.PATH].join(delimiter);
    const res = await shAsync("gate", env);
    return {
      ...res,
      outputs: outputsOf(outFile),
      entries: outputEntries(outFile),
      summary: textOf(sumFile),
      requests: [...seen],
      docker: calls(r.dir),
    };
  }
  const reviewed = (g: GateRun, pr = "7"): void => {
    expect(g.status, g.stdout + g.stderr).toBe(0);
    expect(g.outputs).toEqual({ skipped: "false", "skip-reason": "", pr });
    expect(g.stdout).not.toContain("::notice::");
    expect(g.summary).toBe("");
    expect(g.docker).toEqual([]);
  };
  const skipped = (g: GateRun, reason: string): void => {
    expect(g.status, g.stdout + g.stderr).toBe(0);
    expect(g.outputs).toEqual({ skipped: "true", "skip-reason": reason, pr: "" });
    expect(g.stdout).toContain(`::notice::qcr action: ${reason}`);
    expect(g.summary.trimEnd().split("\n")).toEqual([
      `QuickReview did not review this run: ${reason}`,
    ]);
    expect(g.docker).toEqual([]);
  };
  const refused = (g: GateRun, message: string): void => {
    expect(g.status, g.stdout + g.stderr).toBe(1);
    expect(g.stdout).toContain(`::error::qcr action: ${message}`);
    expect(g.outputs).toEqual({});
    expect(g.docker).toEqual([]);
  };
  const urls = (g: GateRun): string[] => g.requests.map((q) => q.url);

  describe("which pull request", () => {
    // MUTATION: write `pr=` empty in the gate's last gate_outputs call — this fails.
    it("reviews the pull request a pull_request event names", async () => {
      reviewed(await gate());
    });

    // MUTATION: read issue.number in event_pr whether or not the issue has a
    // pull_request — the comment on an issue is reviewed and this fails.
    it("reviews a comment on a pull request, and skips a comment on an issue before any GitHub read", async () => {
      reviewed(await gate({ event: "issue_comment", payload: ON_PR }));
      const g = await gate({ event: "issue_comment", payload: ON_ISSUE });
      skipped(g, "the comment is on an issue, not a pull request");
      expect(g.requests).toEqual([]);
    });

    // MUTATION: read the event ahead of the pr input in gate — the pr 8 run
    // reads pull request 7 and this fails.
    it("takes the pr input; an event that names no pull request needs it", async () => {
      const dispatch = { inputs: { pr: "" }, ref: "refs/heads/main" };
      reviewed(
        await gate({ event: "workflow_dispatch", payload: dispatch, env: { QCR_ACTION_PR: "7" } }),
      );
      const g = await gate({ event: "workflow_dispatch", payload: dispatch });
      refused(g, "this event (`workflow_dispatch`) names no pull request: pass the pr input");
      expect(g.requests).toEqual([]);
      // the input wins over the event
      const other = await gate({ env: { QCR_ACTION_PR: "8" } });
      expect(other.status).toBe(1);
      expect(urls(other)).toContain("/repos/acme/widgets/pulls/8");
    });

    // MUTATION: read workflow_run.pull_requests[0].number in event_pr — the
    // workflow_run case is reviewed and this fails.
    it("never guesses a pull request from a commit or another run", async () => {
      const events: Array<[string, unknown]> = [
        ["schedule", { schedule: "0 * * * *" }],
        ["push", { after: "abc", head_commit: { id: "abc" } }],
        ["workflow_run", { workflow_run: { pull_requests: [{ number: 7 }], head_sha: "abc" } }],
        ["merge_group", { merge_group: { head_ref: "gh-readonly-queue/main/pr-7-abc" } }],
      ];
      for (const [event, payload] of events) {
        const g = await gate({ event, payload });
        refused(g, `this event (\`${event}\`) names no pull request: pass the pr input`);
        expect(g.requests, event).toEqual([]);
      }
    });

    // MUTATION: drop the pr input's check in gate — "7; id" goes into a URL
    // and this fails.
    it("refuses a pr input that is not a pull request number", async () => {
      for (const bad of ["7; id", "0", "-1", "1e3", "07"]) {
        refused(
          await gate({ env: { QCR_ACTION_PR: bad } }),
          "the pr input is not a pull request number",
        );
      }
    });

    // MUTATION: drop `|| die "could not read the event payload …"` from
    // event_pr. The empty answer reads as an event that names no pull
    // request, the error names the wrong cause, and this fails.
    it("fails on an event payload that is not JSON, before any GitHub read", async () => {
      const g = await gate({ rawPayload: "{ not json" });
      refused(g, "could not read the event payload (");
      expect(g.requests).toEqual([]);
    });
  });

  describe("the repository", () => {
    // MUTATION: drop the OWNER/NAME check on the repository from gate. "not
    // a repo" goes into a URL, curl fails, and this fails.
    it("refuses a repository that is not OWNER/NAME, before any GitHub read", async () => {
      for (const bad of ["not a repo", "acme", "acme/widgets/x", "acme/wid;gets"]) {
        const g = await gate({ env: { QCR_ACTION_REPO: bad } });
        refused(g, `the repository "${bad}" is not OWNER/NAME`);
        expect(g.requests, bad).toEqual([]);
      }
    });
  });

  describe("who started it", () => {
    // MUTATION: accept `read` beside admin and write in gate — this fails.
    it("reviews for write access and skips without it", async () => {
      for (const permission of ["admin", "write"]) {
        const g = await gate({ world: { permission } });
        reviewed(g);
        expect(urls(g)[0], permission).toBe("/repos/acme/widgets/collaborators/octo/permission");
      }
      for (const permission of ["read", "none", 404]) {
        skipped(await gate({ world: { permission } }), NO_WRITE);
      }
    });

    // The check fails closed: an answer it cannot read is no permission to
    // skip on and no permission to review on.
    // MUTATION: skip in gate when the permission check answers anything but
    // 200 — the 500 case passes as a skip and this fails.
    it("fails when it cannot check the actor's access", async () => {
      for (const status of [500, 401, 403]) {
        refused(
          await gate({ world: { permission: status } }),
          `could not check \`octo\`'s access to \`acme/widgets\` (HTTP ${status})`,
        );
      }
      // nothing listens there
      refused(
        await gate({ env: { GITHUB_API_URL: "http://127.0.0.1:1" } }),
        "could not check `octo`'s access to `acme/widgets` (HTTP 000)",
      );
      refused(
        await gate({ world: { permission: "" } }),
        "could not check `octo`'s access to `acme/widgets` (HTTP 200",
      );
    });

    // MUTATION: ask GitHub for the permission before reading allowed-users in
    // gate — the stub answers none and this fails.
    it("lets anyone allowed-users names start a review, whatever their access, without asking GitHub", async () => {
      for (const allowed of ["alice, OCTO", "alice\nocto", "*"]) {
        const g = await gate({
          world: { permission: "none" },
          env: { QCR_ACTION_ALLOWED_USERS: allowed },
        });
        reviewed(g);
        expect(urls(g), allowed).toEqual(["/repos/acme/widgets/pulls/7"]);
      }
      skipped(
        await gate({ world: { permission: "none" }, env: { QCR_ACTION_ALLOWED_USERS: "alice" } }),
        NO_WRITE,
      );
    });

    // MUTATION: drop the `*'[bot]'` case from gate — the stub's write answer
    // lets the bot in and this fails.
    it("skips a bot that allowed-users does not name, before any GitHub read", async () => {
      const bot = { GITHUB_ACTOR: "dependabot[bot]" };
      const g = await gate({ env: bot });
      skipped(
        g,
        "started by `dependabot[bot]`: a bot starts a review only when allowed-users names it",
      );
      expect(g.requests).toEqual([]);
      reviewed(await gate({ env: { ...bot, QCR_ACTION_ALLOWED_USERS: "Dependabot[bot]" } }));
    });

    // A re-run is started by the person who re-ran it.
    // MUTATION: read GITHUB_ACTOR ahead of GITHUB_TRIGGERING_ACTOR in gate —
    // this fails.
    it("checks the person who started this run, the triggering actor of a re-run", async () => {
      const g = await gate({
        world: { permission: "none" },
        env: { GITHUB_TRIGGERING_ACTOR: "mallory" },
      });
      skipped(
        g,
        "`mallory` has no write access to `acme/widgets`: name them in allowed-users to let them start reviews",
      );
      expect(urls(g)).toEqual(["/repos/acme/widgets/collaborators/mallory/permission"]);
    });

    // An Enterprise Managed User's login is handle_shortcode.
    // MUTATION: drop `_` from the class in LOGIN_RE. The gate cannot name
    // the actor, fails, and this fails.
    it("takes a managed user's login, by write access and when allowed-users names it", async () => {
      const emu = { GITHUB_ACTOR: "octocat_acme" };
      const g = await gate({ env: emu });
      reviewed(g);
      expect(urls(g)).toEqual([
        "/repos/acme/widgets/collaborators/octocat_acme/permission",
        "/repos/acme/widgets/pulls/7",
      ]);
      const named = await gate({
        world: { permission: "none" },
        env: { ...emu, QCR_ACTION_ALLOWED_USERS: "alice, Octocat_Acme" },
      });
      reviewed(named);
      expect(urls(named)).toEqual(["/repos/acme/widgets/pulls/7"]);
    });

    // MUTATION: drop the login check from allowed_users — this fails.
    it("refuses an allowed-users entry that is not a login, and an actor it cannot name", async () => {
      const g = await gate({ env: { QCR_ACTION_ALLOWED_USERS: "alice, bad/user" } });
      expect(g.status).toBe(1);
      expect(g.stdout).toContain(
        '::error::qcr action: allowed-users: "bad/user" is not a GitHub login',
      );
      const h = await gate({ env: { GITHUB_ACTOR: "" } });
      expect(h.status).toBe(1);
      expect(h.stdout).toContain("::error::qcr action: cannot tell who started this run");
    });
  });

  describe("the token", () => {
    // MUTATION: send the token with `-H "Authorization: Bearer $token"` on
    // curl's command line in gate — this fails.
    it("goes to GitHub in a header of every read, never on a command line, and never into the outputs or the log", async () => {
      const real = spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
      const spy = join(fresh(), "spy");
      mkdirSync(spy);
      const log = join(spy, "argv");
      writeFileSync(
        join(spy, "curl"),
        `#!/bin/bash\nprintf '%s\\n' "$@" >>"${log}"\nexec "${real}" "$@"\n`,
      );
      chmodSync(join(spy, "curl"), 0o755);
      const g = await gate({ pathFirst: spy });
      reviewed(g);
      expect(g.requests).toHaveLength(2);
      for (const q of g.requests) {
        expect(q.method).toBe("GET");
        expect(q.authorization).toBe(`Bearer ${TOKEN}`);
      }
      expect(readFileSync(log, "utf8")).toContain("-K");
      expect(readFileSync(log, "utf8")).not.toContain(TOKEN);
      expect(g.stdout + g.stderr + JSON.stringify(g.outputs)).not.toContain(TOKEN);
    });

    // MUTATION: drop the empty-token check from gate — the stub lets the
    // tokenless reads through and this fails.
    it("is needed: no token is an error, before any GitHub read", async () => {
      const g = await gate({ env: { QCR_ACTION_GH_TOKEN: "" } });
      refused(g, "no GitHub token");
      expect(g.requests).toEqual([]);
    });

    // A quote or a newline would end the header line in curl's config and
    // start a directive of the token's own.
    // MUTATION: drop the case that refuses a quote or a control character in
    // the token from gate. The reads go out and this fails.
    it("refuses a token that holds a quote, a backslash or a control character, before any GitHub read", async () => {
      for (const bad of [`${TOKEN}"`, `${TOKEN}\\`, `${TOKEN}\nurl = "http://x"`, `a\tb`]) {
        const g = await gate({ env: { QCR_ACTION_GH_TOKEN: bad } });
        refused(g, "the GitHub token holds a character the gate cannot send");
        expect(g.requests, JSON.stringify(bad)).toEqual([]);
        expect(g.stdout + g.stderr).not.toContain(TOKEN);
      }
    });
  });

  describe("the pull request's state", () => {
    // MUTATION: drop the merged check from gate — the closed case's skip
    // reason is said instead and this fails.
    it("skips a merged or a closed pull request, and reviews a draft", async () => {
      skipped(
        await gate({ world: { pull: { merged: true, state: "closed" } } }),
        "pull request #7 is already merged",
      );
      skipped(await gate({ world: { pull: { state: "closed" } } }), "pull request #7 is closed");
      reviewed(await gate({ world: { pull: { draft: true } } }));
    });

    // MUTATION: skip (exit 0) on the pull request's 404 in gate — this fails.
    it("fails when the pull request cannot be read", async () => {
      refused(
        await gate({ world: { pull: 404 } }),
        "pull request #7 was not found in `acme/widgets`, or the token cannot see it",
      );
      refused(
        await gate({ world: { pull: 500 } }),
        "could not read pull request #7 of `acme/widgets` (HTTP 500)",
      );
    });

    // MUTATION: replace `|| die "could not read GitHub's answer …"` with
    // `|| got=''` in gate. The answer reads as an open pull request from
    // nowhere, it is reviewed, and this fails.
    it("fails when GitHub's answer for the pull request is not JSON", async () => {
      refused(
        await gate({ world: { pull: "<html>a proxy's error page</html>" } }),
        "could not read GitHub's answer for pull request #7",
      );
    });

    // MUTATION: read the pull request before the permission in gate — this fails.
    it("asks who started the run before it reads the pull request", async () => {
      const g = await gate();
      reviewed(g);
      expect(urls(g)).toEqual([
        "/repos/acme/widgets/collaborators/octo/permission",
        "/repos/acme/widgets/pulls/7",
      ]);
    });
  });

  describe("a model credential", () => {
    // GitHub gives the pull_request family no secrets on a fork's pull
    // request; a comment runs in the repository and has them.
    // MUTATION: skip a missing credential on every event in gate — the
    // issue_comment case below is skipped and this fails.
    it("skips a fork's pull request without one on the pull_request family only", async () => {
      for (const event of ["pull_request", "pull_request_review", "pull_request_review_comment"]) {
        skipped(await gate({ event, world: { pull: FROM_FORK }, env: NO_KEY }), FORK_SKIP);
      }
      // a fork that was deleted since
      skipped(
        await gate({ world: { pull: { head: { sha: "abc", repo: null } } }, env: NO_KEY }),
        FORK_SKIP,
      );
      refused(
        await gate({
          event: "issue_comment",
          payload: ON_PR,
          world: { pull: FROM_FORK },
          env: NO_KEY,
        }),
        NO_CREDENTIAL,
      );
      refused(
        await gate({ event: "pull_request_target", world: { pull: FROM_FORK }, env: NO_KEY }),
        NO_CREDENTIAL,
      );
      // a branch of the repository itself has the secrets: none there is a mistake
      refused(await gate({ env: NO_KEY }), NO_CREDENTIAL);
    });

    // The same names the run forwards decide it.
    // MUTATION: drop the QCR_DEBUG exclusion from has_model_credential — the
    // QCR_DEBUG case is reviewed and this fails.
    it("counts what the run would forward, a key input and pi-auth, and nothing else", async () => {
      const counts: Array<Record<string, string>> = [
        { HF_TOKEN: "x" },
        { DIGITALOCEAN_API_KEY: "x" },
        { AWS_SESSION_TOKEN: "x" },
        { QCR_MODEL_ENV: "MY_GATEWAY_KEY", MY_GATEWAY_KEY: "x" },
        { QCR_ACTION_HAS_KEY_INPUT: "true" },
        { QCR_ACTION_HAS_PI_AUTH: "true" },
      ];
      for (const env of counts) reviewed(await gate({ env: { ...NO_KEY, ...env } }));
      const none: Array<Record<string, string>> = [
        { QCR_DEBUG: "1" },
        // a profile on the runner names nothing the container has (host_only)
        { AWS_PROFILE: "work" },
        { QCR_MODEL_ENV: "MY_GATEWAY_KEY" },
        { NOT_A_MODEL_NAME: "x" },
        { QCR_ACTION_HAS_KEY_INPUT: "false", QCR_ACTION_HAS_PI_AUTH: "" },
      ];
      for (const env of none) refused(await gate({ env: { ...NO_KEY, ...env } }), NO_CREDENTIAL);
    });

    // MUTATION: drop the model_env_extra call from gate — the step's own key
    // lets it through and this fails.
    it("refuses a QCR_MODEL_ENV the run would refuse", async () => {
      const g = await gate({ env: { QCR_MODEL_ENV: "GITHUB_TOKEN" } });
      expect(g.status).toBe(1);
      expect(g.stdout).toContain(
        "::error::qcr action: QCR_MODEL_ENV: GITHUB_TOKEN is not a model setting",
      );
    });
  });

  describe("the outputs", () => {
    // MUTATION: write `name<<EOF` in put_output — two runs share a delimiter
    // and this fails.
    it("writes each output under a random delimiter", async () => {
      const entries = [...(await gate()).entries, ...(await gate()).entries];
      expect(entries).toHaveLength(6);
      for (const e of entries) expect(e.delimiter, e.name).toMatch(/^ghadelimiter_[0-9a-f]{32}$/);
      expect(new Set(entries.map((e) => e.delimiter)).size).toBe(6);
    });

    // A gate whose outputs are lost would leave the later steps skipped, and
    // the run green, with nothing said.
    // MUTATION: ignore put_output's failure in gate_outputs — this fails.
    it("fails when it cannot write the outputs, and writes none outside a runner", async () => {
      // a directory: no file can be appended to it
      const g = await gate({ env: { GITHUB_OUTPUT: fresh() } });
      expect(g.status).toBe(1);
      expect(g.stdout).toContain("::error::qcr action: could not write the step outputs");
      const bare = await gate({ env: { GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" } });
      expect(bare.status, bare.stderr).toBe(0);
      expect(bare.outputs).toEqual({});
      const skip = await gate({
        event: "issue_comment",
        payload: ON_ISSUE,
        env: { GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "" },
      });
      expect(skip.status, skip.stderr).toBe(0);
      expect(skip.summary).toBe("");
    });
  });
});

// ---------------------------------------------------------------------------
// The generated config, and posting into the gate
// ---------------------------------------------------------------------------

describe("the generated config", () => {
  const example = read("config.example.toml");
  const generated = (): string => {
    const r = rig();
    expect(sh("run", r.env()).status).toBe(0);
    return readFileSync(join(r.work, "config.toml"), "utf8");
  };

  it("is the example with dry_run = false and memory off, and nothing else changed", () => {
    const g = generated();
    const was = example.split("\n");
    const now = g.split("\n");
    expect(now).toHaveLength(was.length);
    const changed = was.flatMap((l, i) => (l === now[i] ? [] : [[l, now[i]!]]));
    expect(changed).toEqual([
      ["dry_run = true", "dry_run = false"],
      ["enabled = true", "enabled = false"],
    ]);
    const cfg = parseConfig(g);
    expect(cfg.dry_run).toBe(false);
    expect(cfg.openviking.enabled).toBe(false);
    expect(parseConfig(example).dry_run).toBe(true);
  });

  it("fails loudly when the example no longer has the two lines", () => {
    for (const edit of [
      (t: string) => t.replace(/^dry_run = true/m, "dry_run_mode = true"),
      (t: string) => t.replace(/^enabled = true/m, "on = true"),
    ]) {
      const r = rig();
      const app = join(r.dir, "app");
      mkdirSync(app);
      writeFileSync(join(app, "config.example.toml"), edit(example));
      const res = sh("run", r.env({ QCR_ACTION_PATH: app }));
      expect(res.status).toBe(1);
      expect(res.stdout).toContain("::error::");
      expect(calls(r.dir)).toEqual([]);
    }
  });

  it("runs the route without a default cap", () => {
    expect(routeFromEnv({ QCR_ROUTE: "action" })).toBe("action");
    expect(routeFromEnv({})).toBe("laptop");
  });
});

describe("posting through the gate with the Action's config", () => {
  const record = {
    verdict: "COMMENT",
    summary: "s",
    findings: [
      {
        id: "f1",
        path: "src/a.ts",
        line: 2,
        severity: "P1",
        title: "b is wrong",
        body: "b should not be 2.",
        lens: "correctness",
        disposition: "posted",
        posted_as: "[blocker]",
      },
    ],
  };
  const review = () =>
    assemblePostReview(record, {
      cfg: { review: {}, github: { bot_login: "b" } },
      roundNo: 1,
      lenses: [],
    });
  const stub = () => {
    const posts: string[] = [];
    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "POST")
        posts.push(typeof u === "string" ? u : u instanceof URL ? u.href : u.url);
      if (method === "GET") return new Response("[]", { status: 200 });
      return new Response(JSON.stringify({ html_url: "https://x/review/1" }), { status: 200 });
    }) as typeof fetch;
    return { posts, fetchFn };
  };
  const post = async (dryRun: boolean, dryrunDir: string) => {
    const gh = stub();
    const res = await postReviewToPr({
      repo: "acme/widgets",
      number: 7,
      headSha: "abc",
      token: "tok",
      review: review(),
      gate: localPostGate({
        dryRun,
        dryrunDir,
        token: "tok",
        fetchFn: gh.fetchFn,
        apiBase: "https://api.test",
      }),
      fetchFn: gh.fetchFn,
      apiBase: "https://api.test",
    });
    return { res, gh };
  };

  it("the generated config posts for real, as one comment-only review, through the gate", async () => {
    const r = rig();
    expect(sh("run", r.env()).status).toBe(0);
    const cfg = parseConfig(readFileSync(join(r.work, "config.toml"), "utf8"));
    const dir = join(fresh(), "dryrun");
    const { res, gh } = await post(cfg.dry_run, dir);
    expect(res).toMatchObject({ ok: true, posted: 1 });
    expect(gh.posts).toEqual(["https://api.test/repos/acme/widgets/pulls/7/reviews"]);
    expect(existsSync(dir)).toBe(false);
  });

  it("the image's own example (dry_run = true) records the review under state/dryrun and sends nothing", async () => {
    const cfg = parseConfig(read("config.example.toml"));
    const dir = join(fresh(), "dryrun");
    const { res, gh } = await post(cfg.dry_run, dir);
    expect(res).toMatchObject({ ok: true, posted: 0, wouldPost: 1 });
    expect(gh.posts).toEqual([]);
    expect(readdirSync(dir).length).toBeGreaterThan(0);
  });
});
