// The composite Action (action.yml, scripts/action.sh) and the workflow template
// (docs/action/qcr-review.yml). Running them needs GitHub, a registry, docker
// and a model, so the suite pins what can be read or run without any of them:
//   - the template's triggers, its draft and fork skips, its per-PR concurrency
//     with cancel-in-progress, its request-only switch, and that it sets no cap;
//   - action.yml: the order of the steps (preflight, login, run, cleanup);
//   - `scripts/action.sh run` against a fake `docker` on PATH: the docker run
//     line holds no token and no memory service, the token is a 0600 file in a
//     0700 directory that is gone afterwards, the route is `action`, and the
//     generated config is live with memory off;
//   - the preflight against a local stand-in for the registry: with no
//     registry input it asks anonymously (the image is public) and never sends
//     the workflow token, a refusal fails and names the private-mirror route,
//     and the credential is the registry token when one is given;
//   - the generated config, parsed by the real parser, and a review posted
//     through the mutation gate with it.
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
// The template
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
interface TemplateJob {
  if: string;
  "timeout-minutes": number;
  concurrency: { group: string; "cancel-in-progress": boolean };
  steps: Step[];
}
const templateText = read("docs/action/qcr-review.yml");
const tpl = parse(templateText) as {
  on: Record<string, { types: string[] }>;
  permissions: Record<string, string>;
  concurrency?: unknown;
  jobs: Record<string, TemplateJob>;
};
const job = tpl.jobs["review"]!;

describe("the workflow template — when it runs", () => {
  it("reviews opened, synchronize and ready_for_review, and is asked by a label or a comment", () => {
    expect(Object.keys(tpl.on).sort()).toEqual(["issue_comment", "pull_request"]);
    expect(tpl.on["pull_request"]!.types).toEqual(
      expect.arrayContaining(["opened", "synchronize", "ready_for_review"]),
    );
    expect(tpl.on["pull_request"]!.types).toContain("labeled");
    expect(tpl.on["issue_comment"]!.types).toEqual(["created"]);
  });

  it("skips drafts and pull requests from forks", () => {
    expect(job.if).toContain("github.event.pull_request.draft == false");
    expect(job.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    // a comment event carries neither flag: the lookup step reads them
    const lookup = job.steps.find((s) => s.id === "pr")!;
    expect(lookup.run).toContain("isDraft");
    expect(lookup.run).toContain("isCrossRepository");
    for (const s of job.steps.filter((s) => s.uses)) {
      expect(s.if, s.uses).toContain("steps.pr.outputs.review == 'true'");
    }
  });

  it("cancels a stacked run: one concurrency group per PR, on the job", () => {
    expect(job.concurrency["cancel-in-progress"]).toBe(true);
    expect(job.concurrency.group).toContain("github.event.pull_request.number");
    expect(job.concurrency.group).toContain("github.event.issue.number");
    // on the workflow, a comment that is not /qcr would cancel a review in flight
    expect(tpl.concurrency).toBeUndefined();
  });

  it("has a request-only switch: the QCR_REQUEST_ONLY variable, then a label or /qcr", () => {
    expect(job.if).toContain("vars.QCR_REQUEST_ONLY != 'true'");
    expect(job.if).toContain("github.event.label.name == 'qcr-review'");
    expect(job.if).toContain("startsWith(github.event.comment.body, '/qcr')");
    expect(job.if).toContain("author_association");
  });

  it("sets no cap unless a limit is set, and sets no dry_run", () => {
    const action = job.steps.find((s) => s.uses?.includes("quickreview@"))!;
    expect(action.with).not.toHaveProperty("limit");
    expect(templateText).toMatch(/^\s*# limit: /m);
    expect(templateText).not.toMatch(/dry[_-]run/i);
  });

  it("uses the Action at the floating major tag, with no package permission and no registry input", () => {
    const action = job.steps.find((s) => s.uses?.includes("quickreview@"))!;
    expect(action.uses).toMatch(/^[\w-]+\/quickreview@v1$/);
    // the image is public: the template asks for nothing to pull it
    expect(tpl.permissions).toEqual({ contents: "read", "pull-requests": "write" });
    expect(action.with).not.toHaveProperty("registry-token");
    // the pull request's own code is never checked out
    const checkout = job.steps.find((s) => s.uses?.startsWith("actions/checkout@"))!;
    expect(checkout.with!["ref"]).toContain("github.event.pull_request.base.sha");
    expect(checkout.with!["persist-credentials"]).toBe(false);
  });

  it("passes actionlint", () => {
    const which = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
    if (which.error) return; // not installed here; the ticket's verify runs it
    const r = spawnSync("actionlint", [join(root, "docs/action/qcr-review.yml")], {
      encoding: "utf8",
    });
    expect(r.stdout + r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// action.yml
// ---------------------------------------------------------------------------

interface ActionYml {
  runs: { using: string; steps: Step[] };
  inputs: Record<string, { default?: string }>;
}
const action = parse(read("action.yml")) as ActionYml;

describe("action.yml", () => {
  it("is a composite that preflights, logs in, runs and cleans up, in that order", () => {
    expect(action.runs.using).toBe("composite");
    const verbs = action.runs.steps
      .map((s) => /action\.sh" (\w+)/.exec(s.run ?? "")?.[1])
      .filter((v) => v !== undefined);
    expect(verbs).toEqual(["preflight", "login", "run", "cleanup"]);
    const cleanup = action.runs.steps.find((s) => s.run?.includes("cleanup"))!;
    expect(cleanup.if).toBe("always()");
  });

  it("never puts the token, a login or a key on a docker line of its own", () => {
    // every step is one call of the script; docker is run there and nowhere else
    for (const s of action.runs.steps.slice(1)) {
      expect(s.run, s.name).toMatch(/^bash "\$QCR_ACTION_PATH\/scripts\/action\.sh" \w+$/);
    }
    expect(read("action.yml")).not.toMatch(/\bdry[_-]run\b\s*:/i);
  });

  it("has no default limit", () => {
    expect(action.inputs["limit"]!.default).toBe("");
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
 * does what the image does with the token: reads it and unlinks it.
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
      "pr,terminal",
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
    expect(existsSync(join(r.work, "docker"))).toBe(false);
    // and the review then runs with the runner's own docker config
    expect(sh("run", r.env()).status).toBe(0);
    expect(
      calls(r.dir)
        .find((c) => c.verb === "run")!
        .files("docker_config"),
    ).toBe("");
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
