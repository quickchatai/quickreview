// The plain Docker path (docker/daemon/ + docker-compose.yml) and its
// decoupling from Ansible.
//
// The plain Dockerfile carries the pins as ARG defaults instead of Jinja
// variables, which makes it a mirror surface of its own: this file holds those
// defaults against config.toml and the ansible group_vars the same way
// tests/openviking.test.ts holds the templated image, so a bump that misses
// one spelling refuses here. It also pins the entrypoint invariants shared
// with the templated boot (no interactive wizard, no vlm, root key from the
// secrets mount, degrade-never-block, the no-stall trust layers) and the
// compose topology (webhook published, OpenViking port never).
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_EMBEDDING,
  OPENVIKING_DEFAULTS,
  RETIRED_LOCAL_EMBEDDING,
  SLACK_DEFAULTS,
  ovConfEmbedder,
  parseConfig,
} from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The tracked config.example.toml (the rule-7 pin spelling every tree
// carries). The operator's live config.toml lives in the install's config
// home, not the checkout; its pins are held by scripts/deploy.sh's
// preflight, which reads it through the install locator and refuses on drift.
const configToml = readFileSync(resolve(root, "config.example.toml"), "utf8");
const groupVars = readFileSync(resolve(root, "deploy/ansible/group_vars/all.yml"), "utf8");
const dockerfile = readFileSync(resolve(root, "docker/daemon/Dockerfile"), "utf8");
const entrypoint = readFileSync(resolve(root, "docker/daemon/entrypoint.sh"), "utf8");
const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const playbook = readFileSync(resolve(root, "deploy/ansible/playbook.yml"), "utf8");

const cfg = parseConfig(configToml);
const gv = (key: string): string | undefined =>
  new RegExp(`^${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m").exec(groupVars)?.[1];
/** An `ARG NAME=default` out of the plain Dockerfile. */
const arg = (name: string): string | undefined =>
  new RegExp(`^ARG ${name}=(.+)$`, "m").exec(dockerfile)?.[1];

describe("plain Dockerfile — ARG defaults mirror the pinned sources of truth", () => {
  it("pi: package and version == config.toml [pi] == group_vars", () => {
    expect(arg("PI_VERSION")).toBe(cfg.pi.version);
    expect(arg("PI_VERSION")).toBe(gv("pi_version"));
    expect(arg("PI_NPM_PACKAGE")).toBe(cfg.pi.package);
    expect(arg("PI_NPM_PACKAGE")).toBe(gv("pi_npm_package"));
  });

  it("openviking + llama-cpp-python: the triple mirror gains this fourth spelling", () => {
    expect(arg("OPENVIKING_VERSION")).toBe(cfg.openviking.version);
    expect(arg("OPENVIKING_VERSION")).toBe(gv("openviking_version"));
    expect(arg("LLAMA_CPP_PYTHON_VERSION")).toBe(cfg.openviking.llama_cpp_python_version);
    expect(arg("LLAMA_CPP_PYTHON_VERSION")).toBe(gv("llama_cpp_python_version"));
  });

  it("the venv path matches group_vars and config.toml's binary path", () => {
    expect(arg("OPENVIKING_VENV")).toBe(gv("openviking_venv"));
    expect(cfg.openviking.bin).toBe(`${arg("OPENVIKING_VENV")}/bin/openviking-server`);
  });

  // Subagents are pi's own first-party extension inside the pinned pi
  // package, not a third-party clone layer. The image must verify the shipped
  // example exists (a pi release that dropped it would otherwise fail
  // silently at session time) and must never carry a third-party clone (an
  // unlicensed dependency).
  it("verifies pi ships the native subagent example; no third-party clone layer", () => {
    expect(dockerfile).toContain("examples/extensions/subagent/index.ts");
    expect(dockerfile).not.toContain("pi_subagents");
    expect(dockerfile).not.toContain("PI_SUBAGENTS");
    expect(dockerfile).not.toContain("amosblomqvist");
    expect(gv("pi_subagents_commit")).toBeUndefined();
    expect(gv("pi_subagents_repo")).toBeUndefined();
  });

  it("tmux/node/webhook-port defaults == group_vars", () => {
    expect(arg("TMUX_VERSION")).toBe(gv("tmux_version"));
    expect(arg("NODE_MAJOR")).toBe(gv("node_major"));
    expect(arg("WEBHOOK_PORT")).toBe(gv("webhook_port"));
    expect(arg("WEBHOOK_PORT")).toBe(String(cfg.server.port));
  });

  it("install lines reference the ARGs, never a literal version", () => {
    expect(dockerfile).toContain('"llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}"');
    expect(dockerfile).toContain('"openviking==${OPENVIKING_VERSION}"');
    expect(dockerfile).toContain('"${PI_NPM_PACKAGE}@${PI_VERSION}"');
    // A literal version in an install line is exactly the drift the mirror
    // prevents (ARG default lines are the sanctioned spelling).
    expect(dockerfile).not.toMatch(/openviking==\d/);
    expect(dockerfile).not.toMatch(/llama-cpp-python==\d/);
    expect(dockerfile).not.toMatch(/pi-coding-agent@\d/);
  });

  // The local English embedder's model file — a fourth spelling of
  // the pin config.toml and group_vars carry.
  it("the local embedder's model pin: ARG defaults == config.toml == group_vars", () => {
    const ov = cfg.openviking;
    expect(arg("LOCAL_EMBEDDER_MODEL")).toBe(LOCAL_EMBEDDING.model);
    expect(arg("LOCAL_EMBEDDER_MODEL")).toBe(gv("openviking_local_embedder_model"));
    expect(arg("LOCAL_EMBEDDER_DIR")).toBe(gv("openviking_local_embedder_dir"));
    expect(`${arg("LOCAL_EMBEDDER_DIR")}/${arg("LOCAL_EMBEDDER_MODEL")}.gguf`).toBe(
      ov.local_embedder_file,
    );
    expect(arg("LOCAL_EMBEDDER_URL")).toBe(ov.local_embedder_url);
    expect(arg("LOCAL_EMBEDDER_URL")).toBe(gv("openviking_local_embedder_url"));
    expect(arg("LOCAL_EMBEDDER_SHA256")).toBe(ov.local_embedder_sha256);
    expect(arg("LOCAL_EMBEDDER_SHA256")).toBe(gv("openviking_local_embedder_sha256"));
  });

  it("the model layer downloads through the ARGs and hard-fails unless the sha256 matches", () => {
    const layer = dockerfile.slice(dockerfile.indexOf('RUN mkdir -p "${LOCAL_EMBEDDER_DIR}"'));
    expect(layer).toContain('"${LOCAL_EMBEDDER_URL}"');
    expect(layer).toContain(
      'echo "${LOCAL_EMBEDDER_SHA256}  ${LOCAL_EMBEDDER_DIR}/${LOCAL_EMBEDDER_MODEL}.gguf" | sha256sum -c -',
    );
    expect(layer).toMatch(/\|\| \{ echo "FATAL: the local embedder model/);
    // The literal pin lives on the ARG lines only.
    const nonArg = dockerfile
      .split("\n")
      .filter((l) => !l.startsWith("ARG "))
      .join("\n");
    expect(nonArg).not.toContain(cfg.openviking.local_embedder_sha256);
    expect(nonArg).not.toContain("huggingface.co");
  });

  // The compose boot renders from the image's pin, not from the
  // entrypoint's literal defaults — the image exports its ARGs to it.
  it("the image tells its entrypoint which model file it carries", () => {
    for (const [env, argName] of [
      ["QCR_OPENVIKING_LOCAL_EMBEDDER_MODEL", "LOCAL_EMBEDDER_MODEL"],
      ["QCR_OPENVIKING_LOCAL_EMBEDDER_DIR", "LOCAL_EMBEDDER_DIR"],
      ["QCR_OPENVIKING_LOCAL_EMBEDDER_SHA256", "LOCAL_EMBEDDER_SHA256"],
    ] as const) {
      expect(dockerfile).toMatch(new RegExp(`^(ENV |\\s+)${env}=\\$\\{${argName}\\}`, "m"));
      expect(entrypoint).toContain(`\${${env}:-`);
    }
  });

  it("the image hard-fails unless the INSTALLED versions match the pins", () => {
    expect(dockerfile).toContain("importlib.metadata");
    expect(dockerfile).toContain("import llama_cpp");
    expect(dockerfile).toMatch(/test -x "\$\{OPENVIKING_VENV\}\/bin\/openviking-server"/);
    expect(dockerfile).toContain("failed verification");
  });

  it("llama-cpp-python installs BEFORE openviking — without it the server cannot boot", () => {
    const llama = dockerfile.indexOf('"llama-cpp-python==${');
    const ov = dockerfile.indexOf('"openviking==${');
    expect(llama).toBeGreaterThan(0);
    expect(llama).toBeLessThan(ov);
  });

  it("carries no baked subagent concurrency file — the cap rides config.toml", () => {
    expect(dockerfile).not.toContain("maxConcurrency");
    expect(playbook).not.toContain("maxConcurrency");
    // The config knob that carries the cap, mirrored here so it cannot silently vanish.
    expect(cfg.pi.subagent_max_concurrency).toBe(12);
  });

  it("sets HOME explicitly beside the uid-parameterized user (the lesson)", () => {
    expect(dockerfile).toMatch(/^ARG REVIEW_UID=1001$/m);
    expect(dockerfile).toContain("--non-unique");
    expect(dockerfile).toMatch(/^ENV HOME=\/home\/review$/m);
  });

  // A fresh named volume takes its owner from the image directory it mounts
  // over; a mount point the image lacks is root-owned and the non-root boot
  // cannot write it.
  it("creates the pihome and state volume mount points owned by the container user, before USER", () => {
    const prep = /^RUN install -d -o review -g review (.+)$/m.exec(dockerfile);
    expect(prep).not.toBeNull();
    const dirs = prep![1].split(/\s+/);
    expect(dirs).toContain("/home/review/.pi");
    expect(dirs).toContain("/opt/quickreview/state");
    expect(compose).toContain("qcr-pihome:/home/review/.pi");
    expect(compose).toContain("qcr-state:/opt/quickreview/state");
    expect(dockerfile.indexOf(prep![0])).toBeGreaterThan(dockerfile.indexOf("RUN useradd"));
    expect(dockerfile.indexOf(prep![0])).toBeLessThan(dockerfile.indexOf("USER review"));
  });
});

describe("plain entrypoint — same invariants as the templated boot", () => {
  it("never invokes `openviking-server init` — an interactive prompt would stall the boot", () => {
    expect(entrypoint).not.toMatch(/openviking-server\s+init/);
    expect(entrypoint).toContain("ov.conf");
  });

  it("never backgrounds a server itself — the DAEMON supervises it", () => {
    expect(entrypoint).not.toMatch(/^\s*(nohup\s+)?[^#\n]*openviking-server(?!\s*`)[^\n]*&\s*$/m);
    expect(entrypoint).toContain("--start-server");
    expect(entrypoint).not.toMatch(/openviking-provision\.mjs[^\n]*&\s*$/m);
    expect(entrypoint).toMatch(/exec node "\$SANDBOX\/dist\/src\/wire\.js"/);
  });

  it("runtime knob defaults mirror group_vars / config.toml", () => {
    const def = (name: string): string | undefined =>
      new RegExp(`\\$\\{QCR_OPENVIKING_${name}:-([^}]+)\\}`).exec(entrypoint)?.[1];
    expect(def("HOME")).toBe(cfg.openviking.home);
    expect(def("PORT")).toBe(String(cfg.openviking.port));
    expect(def("WORKERS")).toBe(String(cfg.openviking.workers));
    expect(def("QUEUE_CONCURRENCY")).toBe(String(cfg.openviking.queue_concurrency));
    expect(def("AUTH_MODE")).toBe(cfg.openviking.auth_mode);
    expect(def("AUTH_MODE")).toBe("api_key");
    // The embedder defaults are the shipped default (local), which
    // every mirror carries; the live config may opt into a hosted provider.
    expect(def("EMBEDDING_PROVIDER")).toBe("local");
    expect(def("EMBEDDING_PROVIDER")).toBe(OPENVIKING_DEFAULTS.embedding_provider);
    expect(def("EMBEDDING_MODEL")).toBe(OPENVIKING_DEFAULTS.embedding_model);
    expect(def("EMBEDDING_DIMENSION")).toBe(String(OPENVIKING_DEFAULTS.embedding_dimension));
    expect(def("EMBEDDING_KEY_FILE")).toBe(OPENVIKING_DEFAULTS.embedding_key_file);
    expect(def("EMBEDDING_KEY_FILE")).toBe(gv("openviking_embedding_key_file"));
    // The local embedder's knobs default to the pin.
    expect(def("LOCAL_EMBEDDER_MODEL")).toBe(LOCAL_EMBEDDING.model);
    expect(def("LOCAL_EMBEDDER_DIMENSION")).toBe(String(LOCAL_EMBEDDING.dimension));
    expect(`${def("LOCAL_EMBEDDER_DIR")}/${def("LOCAL_EMBEDDER_MODEL")}.gguf`).toBe(
      cfg.openviking.local_embedder_file,
    );
    expect(def("LOCAL_EMBEDDER_SHA256")).toBe(cfg.openviking.local_embedder_sha256);
    expect(def("LOCAL_EMBEDDER_PORT")).toBe(String(cfg.openviking.local_embedder_port));
    expect(def("LOCAL_EMBEDDER_THREADS")).toBe(String(cfg.openviking.local_embedder_threads));
    expect(def("ROOT_KEY_FILE")).toBe(cfg.openviking.root_key_file);
    expect(def("REVIEWER_KEY_FILE")).toBe(cfg.openviking.reviewer_key_file);
    expect(def("PROVISION_USERS")).toBe(cfg.openviking.provision_users.join(","));
  });

  it("renders ov.conf on loopback with NO vlm section and extraction off", () => {
    const render = entrypoint.slice(
      entrypoint.indexOf("OV_CONF_RENDER"),
      entrypoint.lastIndexOf("OV_CONF_RENDER"),
    );
    expect(render).toContain('host: "127.0.0.1"');
    expect(render).not.toMatch(/\bvlm\b\s*:/);
    expect(render).toContain("extraction_enabled: false");
    // The mode comes from the env knob — a literal "dev" in the config line
    // would ship a server with no per-user confinement.
    expect(render).toContain("auth_mode: process.env.QCR_OV_AUTH_MODE");
    expect(render).not.toContain('auth_mode: "dev",');
  });

  it("the root key comes from the SECRETS MOUNT, never a literal, and ov.conf is 0600", () => {
    const render = entrypoint.slice(
      entrypoint.indexOf("OV_CONF_RENDER"),
      entrypoint.lastIndexOf("OV_CONF_RENDER"),
    );
    expect(render).toMatch(/root_api_key = fs\.readFileSync\(rootFile/);
    expect(render).not.toMatch(/root_api_key\s*[:=]\s*"[A-Za-z0-9_-]{8,}"/);
    expect(render).toContain("0o600");
    // Degrade loudly, never wedge.
    expect(render).toContain('conf.server.auth_mode = "dev"');
    expect(render).toContain("Per-user confinement is NOT enforced");
  });

  it("a failed render or provisioning never fails the boot — memory degrades, the reviewer comes up", () => {
    expect(entrypoint).toMatch(/OV_CONF_RENDER' \|\| echo "openviking: ov\.conf render FAILED/);
    expect(entrypoint).toMatch(/\|\| echo "openviking: boot provisioning did not complete/);
    expect(entrypoint).toMatch(/\|\| echo "openviking: embedder migration check did not complete/);
  });

  it("the embedding provider is an env knob, pi's key is never its credential, and the migration check runs before provisioning", () => {
    const render = entrypoint.slice(
      entrypoint.indexOf("OV_CONF_RENDER"),
      entrypoint.lastIndexOf("OV_CONF_RENDER"),
    );
    expect(render).toContain("provider: process.env.QCR_OV_EMBEDDING_PROVIDER");
    // The one literal "openai" is the local embedder's wire
    // provider, inside the `local` branch, beside the loopback api_base.
    expect(render.match(/provider: "openai"/g)).toHaveLength(1);
    expect(render).toMatch(
      /if \(conf\.embedding\.dense\.provider === "local"\) \{[\s\S]*provider: "openai",[\s\S]*api_base: "http:\/\/127\.0\.0\.1:" \+ Number\(process\.env\.QCR_OV_LOCAL_EMBEDDER_PORT\)/,
    );
    expect(render).not.toContain("openai_api_key");
    expect(render).toContain("process.env.QCR_OV_EMBEDDING_KEY_FILE");
    const reembed = entrypoint.indexOf('scripts/openviking-reembed.mjs" prepare');
    const provision = entrypoint.indexOf('scripts/openviking-provision.mjs" \\');
    expect(reembed).toBeGreaterThan(0);
    expect(reembed).toBeLessThan(provision);
  });

  it("the COMPANION key is never provisioned into this container", () => {
    expect(entrypoint).not.toContain("openviking_companion_key");
    expect(compose).not.toContain("companion_key");
  });

  it("keeps the no-stall trust layers: defaultProjectTrust=always + pre-seeded trust.json", () => {
    expect(entrypoint).toContain('settings.defaultProjectTrust = "always"');
    expect(entrypoint).toContain('trust["/opt/quickreview"] = true');
  });

  it("registers ONLY bash-guard globally, hard-failing when it is missing", () => {
    expect(entrypoint).toContain("/opt/quickreview/sandbox/extensions/bash-guard.ts");
    expect(entrypoint).toContain("FATAL: pi extension missing");
    // No global memory extension, and no global subagents entry either —
    // subagent children load
    // exactly this list, so a globally-registered subagents glue would hand
    // every LEAF the subagent tool (nested fan-out, rule 9 broken). The
    // `wanted` registration list carries exactly the one path above.
    const wanted = /const wanted = \[([\s\S]*?)\];/.exec(entrypoint)?.[1] ?? "";
    const paths = [...wanted.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(paths).toEqual(["/opt/quickreview/sandbox/extensions/bash-guard.ts"]);
  });

  // The native "user" discovery scope reads ~/.pi/agent/agents; the
  // boot links it at the daemon-built lens passes — symlink-or-absent only,
  // never clobbering a real directory.
  it("links the pi user agents dir at the built state/agents", () => {
    expect(entrypoint).toContain('"/opt/quickreview/sandbox/state/agents"');
    expect(entrypoint).toContain("fs.symlinkSync(builtAgents, agentsLink)");
    expect(entrypoint).toContain("is not a symlink — NOT touching it");
  });
});

// The sovereignty claim, checked by execution: the render heredoc is
// lifted out of the plain entrypoint and run with node, driven by the same env
// knobs the shell sets, against a temp secrets dir.
describe("the rendered ov.conf (executed)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** The shell's `${QCR_OPENVIKING_X:-default}` defaults, as the render's env. */
  function shellDefaults(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const m of entrypoint.matchAll(/^OV_(\w+)="\$\{QCR_OPENVIKING_\1:-([^}]*)\}"$/gm))
      env[`QCR_OV_${m[1]}`] = m[2]!;
    return env;
  }

  function render(
    overrides: Record<string, string>,
    secrets: Record<string, string>,
  ): Record<string, any> {
    dir = mkdtempSync(join(tmpdir(), "qcr-ovconf-plain-"));
    const home = join(dir, "openviking");
    const secretsDir = join(dir, "secrets");
    mkdirSync(home, { recursive: true });
    mkdirSync(secretsDir, { recursive: true });
    for (const [name, value] of Object.entries(secrets))
      writeFileSync(join(secretsDir, name), value);
    const start = entrypoint.indexOf("<<'OV_CONF_RENDER'");
    const script = join(dir, "render.cjs");
    writeFileSync(
      script,
      entrypoint.slice(
        entrypoint.indexOf("\n", start) + 1,
        entrypoint.lastIndexOf("\nOV_CONF_RENDER"),
      ),
    );
    const result = spawnSync(process.execPath, [script], {
      env: {
        ...process.env,
        ...shellDefaults(),
        ...overrides,
        OPENVIKING_CONF: join(home, "ov.conf"),
        QCR_SECRETS: secretsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`render failed: ${result.stderr}`);
    lastStderr = result.stderr;
    return JSON.parse(readFileSync(join(home, "ov.conf"), "utf8"));
  }
  let lastStderr = "";

  it("SHIPPED DEFAULT: embeds locally with no key present and no key required — pi's key in the mount changes nothing", () => {
    const conf = render(
      {},
      { openai_api_key: "sk-pi-model-credential", openviking_root_key: "root-key-value" },
    );
    expect(conf.embedding.dense).toEqual({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
      api_base: "http://127.0.0.1:1934/v1",
      query_param: "query",
      document_param: "passage",
      input: "text",
    });
    const text = JSON.stringify(conf);
    expect(text).not.toContain("sk-pi-model-credential");
    expect([...text.matchAll(/"([a-z_]*api_key)":/g)].map((m) => m[1])).toEqual(["root_api_key"]);
    expect([...text.matchAll(/https?:\/\/([^/:"]+)/g)].map((m) => m[1])).toEqual(["127.0.0.1"]);
    expect(conf.server.auth_mode).toBe("api_key");
    const dense = conf.embedding.dense as Record<string, unknown>;
    expect({
      provider: dense.provider,
      model: dense.model,
      dimension: dense.dimension,
      api_base: dense.api_base,
    }).toEqual(ovConfEmbedder(cfg.openviking));
  });

  // A project .env the bring-up step wrote earlier may carry the retired
  // built-in model. Under local the pin decides.
  it("a stale .env model under local is ignored — the pinned model renders, and it says so", () => {
    const conf = render(
      {
        QCR_OV_EMBEDDING_MODEL: RETIRED_LOCAL_EMBEDDING.model,
        QCR_OV_EMBEDDING_DIMENSION: String(RETIRED_LOCAL_EMBEDDING.dimension),
      },
      { openviking_root_key: "r" },
    );
    expect(conf.embedding.dense).toMatchObject({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
    });
    expect(lastStderr).toMatch(/ignored under provider local/);
  });

  it("the boot's provisioning step runs the embedder beside its temporary server — only under local", () => {
    const block = entrypoint.slice(
      entrypoint.indexOf("OV_EMBEDDER_ARGS=()"),
      entrypoint.indexOf('scripts/openviking-provision.mjs" \\'),
    );
    expect(block).toContain('if [[ "$OV_EMBEDDING_PROVIDER" == "local" ]]; then');
    expect(block).toContain('--embedder-python "$OV_VENV/bin/python"');
    expect(block).toContain(
      '--embedder-file "$OV_LOCAL_EMBEDDER_DIR/$OV_LOCAL_EMBEDDER_MODEL.gguf"',
    );
    expect(block).toContain('--embedder-sha256 "$OV_LOCAL_EMBEDDER_SHA256"');
    expect(entrypoint).toContain('"${OV_EMBEDDER_ARGS[@]}" \\');
  });

  it("turns model-based query planning OFF and bounds embedding concurrency on the 2-CPU knob (S3)", () => {
    const conf = render({}, { openviking_root_key: "r" });
    expect(conf.retrieval).toEqual({ enable_intent: false });
    expect(conf.embedding.max_concurrent).toBe(cfg.openviking.queue_concurrency);
    expect(
      render({ QCR_OV_QUEUE_CONCURRENCY: "1" }, { openviking_root_key: "r" }).embedding
        .max_concurrent,
    ).toBe(1);
  });

  it("OPT-IN: the hosted provider reads its OWN key file; without one it renders no key rather than switching embedder", () => {
    const hosted = {
      QCR_OV_EMBEDDING_PROVIDER: "openai",
      QCR_OV_EMBEDDING_MODEL: "text-embedding-3-small",
      QCR_OV_EMBEDDING_DIMENSION: "1536",
    };
    const withKey = render(hosted, {
      openai_api_key: "sk-pi",
      openai_embeddings_api_key: "sk-embeddings",
      openviking_root_key: "r",
    });
    expect(withKey.embedding.dense).toMatchObject({
      provider: "openai",
      dimension: 1536,
      api_key: "sk-embeddings",
    });
    const without = render(hosted, { openai_api_key: "sk-pi", openviking_root_key: "r" });
    expect(without.embedding.dense.provider).toBe("openai");
    expect(without.embedding.dense.api_key).toBeUndefined();
  });
});

describe("docker-compose topology", () => {
  it("passes the embedder knobs through from the project .env, defaulting to local", () => {
    expect(compose).toContain(
      "QCR_OPENVIKING_EMBEDDING_PROVIDER: ${QCR_OPENVIKING_EMBEDDING_PROVIDER:-local}",
    );
    expect(compose).toContain(
      `QCR_OPENVIKING_EMBEDDING_MODEL: \${QCR_OPENVIKING_EMBEDDING_MODEL:-${OPENVIKING_DEFAULTS.embedding_model}}`,
    );
    expect(compose).toContain(
      `QCR_OPENVIKING_EMBEDDING_DIMENSION: \${QCR_OPENVIKING_EMBEDDING_DIMENSION:-${OPENVIKING_DEFAULTS.embedding_dimension}}`,
    );
  });

  // The daemon reads the local embedder's port and
  // threads from config.toml; the boot renders ov.conf's api_base from these.
  // The bring-up step mirrors the one into the other — compose must pass them.
  it("passes the local embedder's port and threads through, defaulting to config.toml's", () => {
    expect(compose).toContain(
      `QCR_OPENVIKING_LOCAL_EMBEDDER_PORT: \${QCR_OPENVIKING_LOCAL_EMBEDDER_PORT:-${OPENVIKING_DEFAULTS.local_embedder_port}}`,
    );
    expect(compose).toContain(
      `QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS: \${QCR_OPENVIKING_LOCAL_EMBEDDER_THREADS:-${OPENVIKING_DEFAULTS.local_embedder_threads}}`,
    );
    // Model, dimension and file are the IMAGE's, never the .env's.
    expect(compose).not.toMatch(/QCR_OPENVIKING_LOCAL_EMBEDDER_(MODEL|DIR|SHA256|DIMENSION):/);
  });

  it("publishes ONLY the webhook port, loopback by default", () => {
    expect(compose).toMatch(/QCR_WEBHOOK_BIND:-127\.0\.0\.1/);
    expect(compose).toContain(":8787");
    // OpenViking is loopback-INSIDE-the-container; publishing it would hand
    // every host process the memory store. Exactly ONE ports entry, and it
    // is the webhook mapping.
    const published = /ports:\n((?:\s+(?:#.*|- .*)\n)+)/.exec(compose)?.[1] ?? "";
    const mappings = published.split("\n").filter((l) => l.trim().startsWith("- "));
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toContain(":8787");
    expect(mappings[0]).not.toContain("1933");
  });

  it("state on a volume, secrets read-only, pihome persistent, repo as the sandbox", () => {
    expect(compose).toContain("qcr-state:/opt/quickreview/state");
    expect(compose).toContain(
      "${QCR_SECRETS_DIR:-~/.config/qcr/default/secrets}:/opt/quickreview/secrets:ro",
    );
    expect(compose).not.toContain("quickreview-bot"); // the legacy dir is never mounted
    expect(compose).toContain("qcr-pihome:/home/review/.pi");
    expect(compose).toContain("./:/opt/quickreview/sandbox");
  });

  // The config the install locator found on the host reaches the container
  // read-only, and the entrypoint always names the config in it: a checkout
  // config is never a fallback, so an empty mount fails the boot.
  it("mounts the install's config home read-only and ALWAYS names the config in it", () => {
    expect(compose).toContain(
      "${QCR_CONFIG_HOME:-./docker/daemon/no-config-home}:/opt/quickreview/config-home:ro",
    );
    // The unset default is a tracked dir holding NO config.toml — never a
    // path under the operator's home that Docker would create owned by root.
    const fallback = join(root, "docker/daemon/no-config-home");
    expect(existsSync(fallback)).toBe(true);
    expect(existsSync(join(fallback, "config.toml"))).toBe(false);
    expect(compose).toMatch(/QCR_CONFIG_NAME: \$\{QCR_CONFIG_NAME:-config\.toml\}/);
    // No "only when present": there is no sandbox config to fall back to, so
    // an empty mount fails the boot naming this file.
    expect(entrypoint).toContain(
      'export QCR_CONFIG="${QCR_CONFIG:-/opt/quickreview/config-home/${QCR_CONFIG_NAME:-config.toml}}"',
    );
    // Before the daemon starts, which inherits it and hands it to sessions.
    expect(entrypoint.indexOf("export QCR_CONFIG=")).toBeLessThan(
      entrypoint.indexOf('exec node "$SANDBOX/dist/src/wire.js"'),
    );
  });

  // The sandbox is a bind mount of the operator's checkout, and <root>/state
  // holds host-side files the TUI and the onboarding wizard read directly
  // (the checklist, the companion's rollover/alert state, the first-run
  // marker). Replacing that directory with a symlink to a container-only path
  // would break them, so both volumes are mounted at both spellings, and the
  // entrypoint detects the double mount by inode instead of running its
  // destructive migration.
  it("the state and ingress volumes are mounted at both the absolute and the sandbox path", () => {
    expect(compose).toContain("qcr-state:/opt/quickreview/state");
    expect(compose).toContain("qcr-state:/opt/quickreview/sandbox/state");
    expect(compose).toContain("qcr-ingress:/opt/quickreview/state/ingress");
    expect(compose).toContain("qcr-ingress:/opt/quickreview/sandbox/state/ingress");
  });

  it("the entrypoint never rm -rf's the operator's state dir when the volume is already mounted there", () => {
    expect(entrypoint).toContain(
      'STATE_ID="$(stat -c %d:%i "$SANDBOX/state" 2>/dev/null || echo sandbox)"',
    );
    expect(entrypoint).toContain(
      'VOLUME_ID="$(stat -c %d:%i /opt/quickreview/state 2>/dev/null || echo volume)"',
    );
    // The destructive legacy branch survives, but only behind the inode guard.
    const guarded = entrypoint.slice(
      entrypoint.indexOf("STATE_ID="),
      entrypoint.indexOf("# The code resolves secrets"),
    );
    expect(guarded).toContain('if [[ "$STATE_ID" == "$VOLUME_ID" ]]; then');
    expect(guarded.indexOf('if [[ "$STATE_ID" == "$VOLUME_ID" ]]; then')).toBeLessThan(
      guarded.indexOf('rm -rf "$SANDBOX/state"'),
    );
  });

  it("PID 1 reaps (init: true) — the daemon supervises a second process", () => {
    expect(compose).toMatch(/^\s+init: true$/m);
  });

  it("binds 0.0.0.0 inside the container (the published port targets eth0)", () => {
    expect(compose).toContain('QC_BIND_HOST: "0.0.0.0"');
  });
});

describe("ansible decoupling", () => {
  it("the private-checkout seed-copy tasks are gone — seeds ride the repo rsync", () => {
    expect(playbook).not.toContain("seed_src");
    expect(playbook).not.toContain("Seed prompts");
    expect(playbook).not.toContain("Seed pass agents");
    expect(groupVars).not.toContain("seed_src");
    // The rsync must not exclude the seed dirs it now solely ships.
    const rsync = playbook.slice(playbook.indexOf("Sync the local sandbox working copy"));
    expect(rsync).not.toContain("--exclude=/prompts");
    expect(rsync).not.toContain("--exclude=/agents");
  });

  it("sandbox_src is an ACTIVE variable with a repo-relative default, not a hardcoded home path", () => {
    // deploy.sh's preflight greps for an active (uncommented) sandbox_src.
    expect(groupVars).toMatch(/^sandbox_src:\s*"\{\{ playbook_dir/m);
    expect(groupVars).not.toMatch(/^sandbox_src:.*src/m);
  });

  it("every cloudflared task is behind cloudflared_enabled (default true — the live tunnel stays)", () => {
    expect(gv("cloudflared_enabled")).toBe("true");
    const tasks = [
      "Cloudflare package signing key",
      "Cloudflared apt repository",
      "Install cloudflared",
      "Register cloudflared as a systemd service",
      "Cloudflared service running",
      "Check for a pre-existing cloudflared service",
    ];
    for (const name of tasks) {
      const at = playbook.indexOf(name);
      expect(at, name).toBeGreaterThan(0);
      // The guard appears within the task's block (before the next task name).
      const next = playbook.indexOf("- name:", at);
      const block = playbook.slice(at, next === -1 ? undefined : next);
      expect(block, name).toContain("cloudflared_enabled | bool");
    }
    // The tunnel token is only read where it is used, so a tunnel-less run
    // never needs the tunnel_token secret to exist.
    expect(playbook).not.toMatch(/^\s+vars:\n\s+cloudflared_tunnel_token/m);
  });

  it("ships the Slack tokens into the container's secrets, copied-if-present", () => {
    // An enabled [slack] with a missing token refuses to start, so the token
    // files the Slack wizard saves must reach the VM under the names the
    // config reads by default.
    const at = playbook.indexOf("- name: Slack tokens");
    expect(at).toBeGreaterThan(0);
    const next = playbook.indexOf("- name:", at + 1);
    const block = playbook.slice(at, next === -1 ? undefined : next);
    expect(block).toContain(
      `loop: [${SLACK_DEFAULTS.bot_token_file}, ${SLACK_DEFAULTS.app_token_file}]`,
    );
    expect(block).toContain('dest: "{{ sandbox_root }}/secrets/{{ item }}"');
    expect(block).toContain('mode: "0400"');
    expect(block).toContain("no_log: true");
    expect(block).toContain("fileglob");
  });

  it("the live inventory is untracked; the example stays and documents what to fill", () => {
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
    expect(gitignore).toContain("deploy/ansible/inventory.ini");
    const example = readFileSync(resolve(root, "deploy/ansible/inventory.example.ini"), "utf8");
    expect(example).toContain("Copy to inventory.ini");
    expect(example).toContain("ansible_user");
  });
});

// Both entrypoints point the install locator's secrets home at the
// read-only secrets mount, so the in-container loader (an empty or
// legacy-default `secrets_dir`) resolves to the mount through the HOME rule,
// not the legacy fallback. The real lines, run in a real bash, temp HOME only.
describe("entrypoint secrets link", () => {
  // A configured [github] secrets_dir names a HOST path; the container sees
  // the secrets only at the mount. The entrypoint names the mount to the
  // locator, which the daemon, its sessions and mint-token.sh all inherit.
  for (const rel of ["docker/daemon/entrypoint.sh", "deploy/ansible/templates/entrypoint.sh.j2"]) {
    it(`${rel} names the secrets mount to the install locator`, () => {
      const text = readFileSync(resolve(root, rel), "utf8");
      expect(text).toMatch(/^export QCR_SECRETS_MOUNT="\$SECRETS"$/m);
    });
  }
  it("docker-compose.yml names the mount on the container, for `docker exec` processes too", () => {
    const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/^\s+QCR_SECRETS_MOUNT: \/opt\/quickreview\/secrets$/m);
    expect(compose).toContain(":/opt/quickreview/secrets:ro");
  });
  for (const rel of ["docker/daemon/entrypoint.sh", "deploy/ansible/templates/entrypoint.sh.j2"]) {
    it(`${rel} links <config home>/secrets to the mount, where the locator looks`, async () => {
      const { locateSecrets } = await import("../src/install.js");
      const text = readFileSync(resolve(root, rel), "utf8");
      const start = text.indexOf('XDG_BASE="${XDG_CONFIG_HOME:-}"');
      const end = text.indexOf('[[ -L "$SECRETS_HOME" ]] || ln -sfn "$SECRETS" "$SECRETS_HOME"');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = text.slice(start, text.indexOf("\n", end));
      const dir = mkdtempSync(join(tmpdir(), "qcr-ep-secrets-"));
      try {
        const home = join(dir, "home");
        const mount = join(dir, "secrets");
        mkdirSync(home);
        mkdirSync(mount);
        writeFileSync(join(mount, "app_id"), "1\n");
        execFileSync(
          "bash",
          ["-c", `set -euo pipefail\nSECRETS=${JSON.stringify(mount)}\n${block}`],
          {
            env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
          },
        );
        const located = locateSecrets({
          configured: "~/.config/quickreview-bot",
          env: { HOME: home },
        });
        expect(located.source).toBe("home");
        expect(readFileSync(join(located.path, "app_id"), "utf8")).toBe("1\n");
        // No compatibility link to the legacy dir — nothing reads it.
        expect(existsSync(join(home, ".config", "quickreview-bot"))).toBe(false);
        expect(text).not.toContain('quickreview-bot"');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
