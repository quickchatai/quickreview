// The OpenViking runtime's config and deploy halves.
//
// The centrepiece is the triple-mirror drift test: the pinned versions live in
// config.toml, in the ansible group_vars and in the image, and this file fails
// the moment any two disagree. It is the same discipline the [pi] pin has, and
// the reason it exists is that a silently floating memory engine is a
// data-shape change nobody would notice until the vectors stopped matching.
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EMBEDDING_PROVIDERS,
  HOSTED_EMBEDDING,
  LOCAL_EMBEDDING,
  OPENVIKING_DEFAULTS,
  RETIRED_LOCAL_EMBEDDING,
  localEmbedderBaseUrl,
  openVikingBaseUrl,
  ovConfEmbedder,
  parseConfig,
  parseOpenViking,
  resolveOpenVikingPaths,
} from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The TRACKED config.example.toml — the pin spelling every tree carries —
// against group_vars/Dockerfile (rule 7). The operator's live config.toml
// lives in the config home, not the checkout, so no test reads it: its half
// of the drift tripwire is scripts/deploy.sh's preflight, which
// reads it through the install locator and REFUSES on any OpenViking pin
// drift (pinned in tests/deploy.test.ts, "OpenViking pin drift").
const configToml = readFileSync(resolve(root, "config.example.toml"), "utf8");
const groupVars = readFileSync(resolve(root, "deploy/ansible/group_vars/all.yml"), "utf8");
// The memory sidecar is the only place OpenViking runs on the VM now: the release
// image carries none. Its image, its entrypoint and the ov.conf renderer it runs.
const dockerfile = readFileSync(resolve(root, "docker/memory/Dockerfile"), "utf8");
const entrypoint = readFileSync(resolve(root, "docker/memory/entrypoint.sh"), "utf8");
const ovConfScript = readFileSync(resolve(root, "scripts/openviking-ov-conf.mjs"), "utf8");
const playbook = readFileSync(resolve(root, "deploy/ansible/playbook.yml"), "utf8");

const cfg = parseConfig(configToml);
const gv = (key: string): string | undefined =>
  new RegExp(`^${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m").exec(groupVars)?.[1];

describe("[openviking] config block", () => {
  it("ships the pinned server on loopback 1933 with state on the state volume", () => {
    expect(cfg.openviking.enabled).toBe(true);
    expect(cfg.openviking.version).toBe("0.4.15");
    expect(cfg.openviking.host).toBe("127.0.0.1");
    expect(cfg.openviking.port).toBe(1933);
    expect(cfg.openviking.home).toBe("/opt/quickreview/state/openviking");
    expect(openVikingBaseUrl(cfg.openviking)).toBe("http://127.0.0.1:1933");
  });

  it("derives config_file and workspace off home, so the three cannot drift", () => {
    expect(cfg.openviking.config_file).toBe("/opt/quickreview/state/openviking/ov.conf");
    expect(cfg.openviking.workspace).toBe("/opt/quickreview/state/openviking/workspace");
    const moved = resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, home: "/srv/ov" });
    expect(moved.config_file).toBe("/srv/ov/ov.conf");
    expect(moved.workspace).toBe("/srv/ov/workspace");
  });

  it("keeps explicit path overrides", () => {
    const custom = resolveOpenVikingPaths({
      ...OPENVIKING_DEFAULTS,
      config_file: "/etc/openviking/ov.conf",
      workspace: "/data/ws",
    });
    expect(custom.config_file).toBe("/etc/openviking/ov.conf");
    expect(custom.workspace).toBe("/data/ws");
  });

  it("cuts workers and queue concurrency for the 2-CPU cap", () => {
    expect(cfg.openviking.workers).toBe(1);
    // The shipped server defaults are 4 / 4 / 8; anything at or above those
    // would put the memory engine in competition with the review rounds.
    expect(cfg.openviking.queue_concurrency).toBeLessThan(4);
  });

  it("defaults the whole block, so an older config.toml keeps parsing", () => {
    const without = configToml.replace(/\n\[openviking\][\s\S]*?(?=\n\[companion\])/, "\n");
    expect(without).not.toContain("[openviking]");
    const parsed = parseConfig(without);
    expect(parsed.openviking).toEqual(cfg.openviking);
  });

  it("a disabled block parses — the daemon then runs memory-less", () => {
    const off = configToml.replace(/^enabled = true$/m, "enabled = false");
    expect(parseConfig(off).openviking.enabled).toBe(false);
  });
});

describe("triple-mirror version pin (config.toml ↔ group_vars ↔ the memory image)", () => {
  it("config.toml and group_vars agree on both pinned versions", () => {
    expect(gv("openviking_version")).toBe(cfg.openviking.version);
    expect(gv("llama_cpp_python_version")).toBe(cfg.openviking.llama_cpp_python_version);
  });

  it("the memory image pins BOTH packages through ARGs the playbook feeds from the group_vars, never a literal", () => {
    expect(dockerfile).toContain('"openviking==${OPENVIKING_VERSION}"');
    expect(dockerfile).toContain('"llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}"');
    expect(playbook).toContain('"OPENVIKING_VERSION={{ openviking_version }}"');
    expect(playbook).toContain('"LLAMA_CPP_PYTHON_VERSION={{ llama_cpp_python_version }}"');
    // A literal version in the image is exactly the drift the mirror prevents.
    expect(dockerfile).not.toMatch(/openviking==\d/);
    expect(dockerfile).not.toMatch(/llama-cpp-python==\d/);
  });

  it("the image hard-fails unless the INSTALLED versions match the pins", () => {
    expect(dockerfile).toContain("importlib.metadata");
    expect(dockerfile).toContain("import llama_cpp");
    expect(dockerfile).toMatch(/test -x "\$\{OPENVIKING_VENV\}\/bin\/openviking-server"/);
  });

  it("llama-cpp-python is installed even though openviking does not depend on it", () => {
    // Verified live: without it the default local dense embedder raises
    // EmbeddingConfigurationError and the server cannot boot at all.
    const llama = dockerfile.indexOf('"llama-cpp-python==');
    const ov = dockerfile.indexOf('"openviking==');
    expect(llama).toBeGreaterThan(0);
    expect(llama).toBeLessThan(ov);
  });

  it("config.toml's binary path lives inside the group_vars venv", () => {
    const venv = gv("openviking_venv");
    expect(venv).toBeTruthy();
    expect(cfg.openviking.bin).toBe(`${venv}/bin/openviking-server`);
  });

  it("config.toml, group_vars and the playbook agree on home and port", () => {
    expect(gv("openviking_home")).toBe(cfg.openviking.home);
    expect(gv("openviking_port")).toBe(String(cfg.openviking.port));
    expect(gv("openviking_workers")).toBe(String(cfg.openviking.workers));
    expect(gv("openviking_queue_concurrency")).toBe(String(cfg.openviking.queue_concurrency));
    expect(playbook).toContain("{{ openviking_home }}");
  });

  // The embedder is an operator knob, so the live config may differ
  // from the tracked group_vars (an opt-in rides inventory host vars, never an
  // edit to the tracked file). What is pinned is the SHIPPED default — local,
  // in every mirror — and that the live value is one the server can run.
  it("the SHIPPED embedder is local in every mirror: nothing but the model call leaves", () => {
    expect(OPENVIKING_DEFAULTS.embedding_provider).toBe("local");
    expect(OPENVIKING_DEFAULTS.embedding_model).toBe(LOCAL_EMBEDDING.model);
    expect(OPENVIKING_DEFAULTS.embedding_dimension).toBe(LOCAL_EMBEDDING.dimension);
    expect(gv("openviking_embedding_provider")).toBe("local");
    expect(gv("openviking_embedding_model")).toBe(OPENVIKING_DEFAULTS.embedding_model);
    expect(gv("openviking_embedding_dimension")).toBe(
      String(OPENVIKING_DEFAULTS.embedding_dimension),
    );
    expect(gv("openviking_embedding_key_file")).toBe(OPENVIKING_DEFAULTS.embedding_key_file);
    expect(
      parseConfig(readFileSync(resolve(root, "config.example.toml"), "utf8")).openviking
        .embedding_provider,
    ).toBe("local");
    expect(EMBEDDING_PROVIDERS).toContain(cfg.openviking.embedding_provider);
  });

  it("the hosted credential is its OWN file — never pi's openai_api_key", () => {
    expect(OPENVIKING_DEFAULTS.embedding_key_file).not.toBe("openai_api_key");
    // The playbook ships it copied-if-present, like the other optional secrets.
    expect(playbook).toContain("{{ openviking_embedding_key_file }}");
  });

  it("refuses a config the server would refuse to boot", () => {
    const set = (key: string, value: string) =>
      configToml.replace(new RegExp(`^${key} = .*$`, "m"), `${key} = ${value}`);
    expect(() => parseConfig(set("embedding_provider", '"cohere"'))).toThrow(/embedding_provider/);
    expect(() => parseConfig(set("embedding_dimension", "0"))).toThrow(/positive integer/);
    // local runs the ONE model the server ships a spec for, at its fixed size.
    expect(() =>
      parseConfig(
        set("embedding_provider", '"local"').replace(
          /^embedding_dimension = .*$/m,
          "embedding_dimension = 1536",
        ),
      ),
    ).toThrow(/only local model/);
    expect(() => parseConfig(set("embedding_key_file", '"../etc/passwd"'))).toThrow(
      /bare file name/,
    );
    // The opt-in shape loads.
    const hosted = set("embedding_provider", '"openai"')
      .replace(/^embedding_model = .*$/m, 'embedding_model = "text-embedding-3-small"')
      .replace(/^embedding_dimension = .*$/m, "embedding_dimension = 1536");
    expect(parseConfig(hosted).openviking.embedding_provider).toBe("openai");
  });
});

describe("a hosted opt-in never inherits the local embedder (selfscan)", () => {
  it("provider alone resolves to the hosted model at its dimension", () => {
    const c = parseOpenViking({ embedding_provider: "openai" });
    expect(c.embedding_model).toBe(HOSTED_EMBEDDING.model);
    expect(c.embedding_dimension).toBe(HOSTED_EMBEDDING.dimension);
  });

  it("a named hosted model with no dimension is refused, not given 512 or 1536", () => {
    expect(() =>
      parseOpenViking({ embedding_provider: "openai", embedding_model: "text-embedding-3-large" }),
    ).toThrow(/embedding_dimension/);
    expect(
      parseOpenViking({
        embedding_provider: "openai",
        embedding_model: "text-embedding-3-large",
        embedding_dimension: 3072,
      }).embedding_dimension,
    ).toBe(3072);
  });
});

describe("boot-time ov.conf (never the interactive wizard)", () => {
  it("never invokes `openviking-server init` — an interactive prompt would stall the boot", () => {
    const code = entrypoint
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code).not.toMatch(/openviking-server\s+init/);
    expect(entrypoint).toContain("ov.conf");
  });

  it("never starts the server itself — the sidecar's supervisor does", () => {
    expect(entrypoint).not.toMatch(/^\s*(nohup\s+)?[^#\n]*openviking-server(?!\s*`)[^\n]*&\s*$/m);
  });

  it("symlinks ~/.openviking onto the state volume so memory survives a rebuild", () => {
    expect(entrypoint).toContain(
      'OV_HOME="${QCR_OPENVIKING_HOME:-/opt/quickreview/state/openviking}"',
    );
    expect(entrypoint).toMatch(/ln -sfn "\$OV_HOME" "\$HOME\/\.openviking"/);
  });

  it("renders the CONFIGURED auth mode, one worker, reduced queue workers, and NO vlm section", () => {
    const render = ovConfScript.slice(ovConfScript.indexOf("export function renderOvConf"));
    // The mode is configuration, never a literal. `dev` bypasses
    // authentication, which makes the two-user confinement nominal.
    expect(render).toContain("auth_mode: env.QCR_OV_AUTH_MODE");
    expect(render).not.toContain('auth_mode: "dev",');
    expect(render).toContain('host: env.QCR_OV_HOST || "127.0.0.1"');
    expect(render).toContain("port: Number(env.QCR_OV_PORT)");
    expect(render).toContain("workers: Number(env.QCR_OV_WORKERS)");
    expect(render).toContain("max_concurrent: Number(env.QCR_OV_QUEUE_CONCURRENCY)");
    // The absent `vlm` is load-bearing: extraction/summaries/digest stay off,
    // and it is why `doctor` can never be the health gate.
    expect(render).not.toMatch(/\bvlm\b\s*:/);
    expect(render).toContain("extraction_enabled: false");
  });

  it("the embedding PROVIDER is configuration, never a literal, and pi's key is never its credential", () => {
    const render = ovConfScript.slice(ovConfScript.indexOf("export function renderOvConf"));
    expect(render).toContain("provider: env.QCR_OV_EMBEDDING_PROVIDER");
    // The one literal "openai" is the local embedder's WIRE
    // provider, inside the `local` branch, beside the loopback api_base — never
    // the operator's provider.
    expect(render.match(/provider: "openai"/g)).toHaveLength(1);
    expect(render).toMatch(
      /if \(conf\.embedding\.dense\.provider === "local"\) \{[\s\S]*provider: "openai",[\s\S]*api_base: "http:\/\/127\.0\.0\.1:" \+ Number\(env\.QCR_OV_LOCAL_EMBEDDER_PORT\)/,
    );
    // The render never reads pi's model credential: the two are independent.
    expect(render).not.toContain("openai_api_key");
    expect(render).toContain("env.QCR_OV_EMBEDDING_KEY_FILE");
    // ov.conf holds a credential: it is written 0600, never world-readable.
    expect(ovConfScript).toContain("0o600");
  });

  it("runs the embedder migration check BEFORE provisioning starts a server", () => {
    const reembed = entrypoint.indexOf('scripts/openviking-reembed.mjs" prepare');
    const provision = entrypoint.indexOf('scripts/openviking-provision.mjs"');
    expect(reembed).toBeGreaterThan(0);
    expect(reembed).toBeLessThan(provision);
    expect(entrypoint).toContain('--home "$OV_HOME" --config "$OV_HOME/ov.conf"');
    expect(entrypoint).toMatch(/\|\| echo "openviking: embedder migration check did not complete/);
  });

  it("a failed render never fails the boot — the sidecar comes up and memory degrades", () => {
    expect(entrypoint).toMatch(/\|\| echo "openviking: ov\.conf render FAILED/);
  });
});

// The sovereignty claim, checked by execution: the sidecar's renderer
// (scripts/openviking-ov-conf.mjs, what docker/memory/entrypoint.sh runs) is
// fed the SAME values the playbook hands the sidecar from group_vars, and run
// with node against a temp secrets dir. Reading the guard would only prove what
// the text says; this proves what the boot does.
describe("the rendered ov.conf (executed)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function render(
    overrides: Record<string, string>,
    secrets: Record<string, string>,
  ): { conf: Record<string, any> } {
    return { conf: renderWithOutput(overrides, secrets).conf };
  }

  function renderWithOutput(
    overrides: Record<string, string>,
    secrets: Record<string, string>,
  ): { conf: Record<string, any>; stderr: string } {
    dir = mkdtempSync(join(tmpdir(), "qcr-ovconf-"));
    const home = join(dir, "openviking");
    const secretsDir = join(dir, "secrets");
    mkdirSync(home, { recursive: true });
    mkdirSync(secretsDir, { recursive: true });
    for (const [name, value] of Object.entries(secrets))
      writeFileSync(join(secretsDir, name), value);
    // group_vars name -> the renderer's environment variable.
    const ENV_OF: Record<string, string> = {
      openviking_port: "QCR_OV_PORT",
      openviking_workers: "QCR_OV_WORKERS",
      openviking_queue_concurrency: "QCR_OV_QUEUE_CONCURRENCY",
      openviking_auth_mode: "QCR_OV_AUTH_MODE",
      openviking_embedding_provider: "QCR_OV_EMBEDDING_PROVIDER",
      openviking_embedding_model: "QCR_OV_EMBEDDING_MODEL",
      openviking_embedding_dimension: "QCR_OV_EMBEDDING_DIMENSION",
      openviking_embedding_key_file: "QCR_OV_EMBEDDING_KEY_FILE",
      openviking_local_embedder_model: "QCR_OV_LOCAL_EMBEDDER_MODEL",
      openviking_local_embedder_dimension: "QCR_OV_LOCAL_EMBEDDER_DIMENSION",
      openviking_local_embedder_port: "QCR_OV_LOCAL_EMBEDDER_PORT",
      openviking_root_key_file: "QCR_OV_ROOT_KEY_FILE",
    };
    const fed: Record<string, string> = {};
    for (const [name, variable] of Object.entries(ENV_OF)) {
      const value = overrides[name] ?? gv(name);
      if (value === undefined) throw new Error(`no group_var ${name}`);
      fed[variable] = value;
    }
    const result = spawnSync(process.execPath, [resolve(root, "scripts/openviking-ov-conf.mjs")], {
      env: {
        PATH: process.env.PATH,
        ...fed,
        OPENVIKING_CONF: join(home, "ov.conf"),
        QCR_SECRETS: secretsDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`render failed: ${result.stderr}`);
    return {
      conf: JSON.parse(readFileSync(join(home, "ov.conf"), "utf8")),
      stderr: result.stderr,
    };
  }

  it("SHIPPED DEFAULT: embeds locally, with no key present and no key required — even with pi's key in the mount", () => {
    const { conf } = render(
      {},
      { openai_api_key: "sk-pi-model-credential", openviking_root_key: "root-key-value" },
    );
    // The local English embedder, reached through the engine's
    // OpenAI-COMPATIBLE async client at the loopback service.
    expect(conf.embedding.dense).toEqual({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
      api_base: localEmbedderBaseUrl(cfg.openviking),
      query_param: "query",
      document_param: "passage",
      input: "text",
    });
    expect(conf.embedding.dense.api_base).toBe("http://127.0.0.1:1934/v1");
    expect(conf.embedding.dense.api_key).toBeUndefined();
    // Nothing hosted anywhere in the memory engine's config: no key, and every
    // URL in it is loopback.
    const text = JSON.stringify(conf);
    expect(text).not.toContain("sk-pi-model-credential");
    // The only credential KEY in it is the server's own root key.
    expect([...text.matchAll(/"([a-z_]*api_key)":/g)].map((m) => m[1])).toEqual(["root_api_key"]);
    expect([...text.matchAll(/https?:\/\/([^/:"]+)/g)].map((m) => m[1])).toEqual(["127.0.0.1"]);
    expect(conf.server.root_api_key).toBe("root-key-value");
    expect(conf.vlm).toBeUndefined();
    // …and it is exactly what the daemon's drift check expects config.toml's
    // `local` to render.
    const dense = conf.embedding.dense as Record<string, unknown>;
    expect({
      provider: dense.provider,
      model: dense.model,
      dimension: dense.dimension,
      api_base: dense.api_base,
    }).toEqual(ovConfEmbedder(cfg.openviking));
  });

  it("under local the PIN decides the model: a stale model/dimension knob (the retired built-in) is ignored, and said aloud", () => {
    const { conf, stderr } = renderWithOutput(
      {
        openviking_embedding_model: RETIRED_LOCAL_EMBEDDING.model,
        openviking_embedding_dimension: String(RETIRED_LOCAL_EMBEDDING.dimension),
      },
      { openviking_root_key: "r" },
    );
    expect(conf.embedding.dense).toMatchObject({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
    });
    expect(stderr).toMatch(
      /ignored under provider local — the local embedder runs bge-small-en-v1\.5-f16 at 384 dims/,
    );
  });

  it("OPT-IN: a hosted provider reads ITS OWN credential file, never pi's", () => {
    const { conf } = render(
      {
        openviking_embedding_provider: "openai",
        openviking_embedding_model: "text-embedding-3-small",
        openviking_embedding_dimension: "1536",
      },
      {
        openai_api_key: "sk-pi-model-credential",
        openai_embeddings_api_key: "sk-embeddings-credential",
        openviking_root_key: "r",
      },
    );
    expect(conf.embedding.dense).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      dimension: 1536,
      api_key: "sk-embeddings-credential",
    });
  });

  // Two server knobs that shed load, verified against the pinned
  // 0.4.15's own config models (both `extra: "forbid"` — a misspelt key would
  // stop the server booting, so the executed render is the proof).
  it("turns model-based query planning OFF and bounds embedding concurrency on the 2-CPU knob", () => {
    const { conf } = render({}, { openviking_root_key: "r" });
    expect(conf.retrieval).toEqual({ enable_intent: false });
    expect(conf.embedding.max_concurrent).toBe(Number(gv("openviking_queue_concurrency")));
    expect(conf.embedding.max_concurrent).toBe(cfg.openviking.queue_concurrency);
    // Bounded well under the server's default of 10.
    expect(conf.embedding.max_concurrent).toBeLessThan(4);
    // The knob, never a literal.
    expect(ovConfScript).toMatch(
      /conf\.embedding = \{\s*max_concurrent: Number\(env\.QCR_OV_QUEUE_CONCURRENCY\),/,
    );
  });

  it("OPT-IN with no embeddings key renders NO key — never a silent fallback to another embedder", () => {
    const { conf } = render(
      {
        openviking_embedding_provider: "openai",
        openviking_embedding_model: "text-embedding-3-small",
        openviking_embedding_dimension: "1536",
      },
      { openai_api_key: "sk-pi-model-credential", openviking_root_key: "r" },
    );
    expect(conf.embedding.dense.provider).toBe("openai");
    expect(conf.embedding.dense.api_key).toBeUndefined();
    expect(JSON.stringify(conf)).not.toContain("sk-pi-model-credential");
  });
});

// The per-user confinement rule 8 rests on needs a non-dev auth mode. These
// pin it: the posture is
// configuration (mirrored, preflight-checked), the root key comes from the
// secrets mount, and boot provisioning is idempotent and non-rotating.
describe("api_key confinement", () => {
  it("config.toml ships api_key — never dev, which enforces nothing", () => {
    expect(cfg.openviking.auth_mode).toBe("api_key");
    expect(cfg.openviking.root_key_file).toBe("openviking_root_key");
    expect(cfg.openviking.reviewer_key_file).toBe("openviking_reviewer_key");
    expect(cfg.openviking.provision_users).toEqual(["reviewer", "companion"]);
  });

  it("the auth mirror holds: config.toml == group_vars", () => {
    expect(gv("openviking_auth_mode")).toBe(cfg.openviking.auth_mode);
    expect(gv("openviking_root_key_file")).toBe(cfg.openviking.root_key_file);
    expect(gv("openviking_reviewer_key_file")).toBe(cfg.openviking.reviewer_key_file);
    expect(gv("openviking_provision_users")).toBe(cfg.openviking.provision_users.join(","));
  });

  it("defaults api_key too — an older config.toml never silently downgrades", () => {
    const without = configToml.replace(/\n\[openviking\][\s\S]*?(?=\n\[companion\])/, "\n");
    expect(parseConfig(without).openviking.auth_mode).toBe("api_key");
  });

  it("the root key is read from the SECRETS MOUNT, never a literal in the renderer", () => {
    const render = ovConfScript.slice(ovConfScript.indexOf("export function renderOvConf"));
    expect(render).toContain("env.QCR_OV_ROOT_KEY_FILE");
    expect(render).toContain("conf.server.root_api_key");
    // The value only ever comes off disk.
    expect(render).toMatch(/root_api_key = readFileSync\(rootFile/);
    expect(render).not.toMatch(/root_api_key\s*[:=]\s*"[A-Za-z0-9_-]{8,}"/);
  });

  it("a missing root key DEGRADES loudly to dev instead of wedging the server", () => {
    const render = ovConfScript.slice(ovConfScript.indexOf("export function renderOvConf"));
    expect(render).toContain('conf.server.auth_mode = "dev"');
    expect(render).toContain("Per-user confinement is NOT enforced");
  });

  it("boot provisioning runs, from the image's script, and never fails the boot", () => {
    expect(entrypoint).toContain("scripts/openviking-provision.mjs");
    expect(entrypoint).toContain('--users "$OV_PROVISION_USERS"');
    expect(entrypoint).toContain('--root-key-file "$SECRETS/$OV_ROOT_KEY_FILE"');
    expect(entrypoint).toContain('--reviewer-key-file "$SECRETS/$OV_REVIEWER_KEY_FILE"');
    expect(entrypoint).toMatch(/\|\| echo "openviking: boot provisioning did not complete/);
  });

  it("provisioning starts a server in the FOREGROUND and leaves none running", () => {
    // The sidecar's supervisor is still the only owner of the long-lived server:
    // the provisioning step needs one to talk to (admin routes are HTTP), starts
    // it itself, and stops it before the entrypoint execs the supervisor.
    expect(entrypoint).toContain("--start-server");
    expect(entrypoint).not.toMatch(/openviking-provision\.mjs[^\n]*&\s*$/m);
    expect(entrypoint).toMatch(/exec node "\$APP\/dist\/src\/openviking\/sidecar-main\.js"/);
  });

  it("the COMPANION key is never provisioned into this container", () => {
    // A review session runs INSIDE this container. A companion key it could
    // read would defeat the confinement outright (root CLAUDE.md rule 8).
    expect(entrypoint).not.toContain("openviking_companion_key");
    expect(groupVars).not.toContain("openviking_companion_key");
    expect(configToml).not.toContain("companion_key_file");
  });

  it("no ADMIN or ROOT key is ever handed to a client surface", () => {
    // The root key appears in exactly one shape here: read from the secrets
    // mount into ov.conf. Nothing exports it, nothing puts it on an argv.
    expect(entrypoint).not.toMatch(/export\s+\w*ROOT\w*KEY/i);
    expect(entrypoint).not.toMatch(/--root-key(?!-file)\b/);
  });
});

describe("container topology", () => {
  it("the OpenViking port is NEVER published out of the container", () => {
    const published = /published_ports:\n((?:\s+-\s+.*\n)+)/.exec(playbook)?.[1] ?? "";
    expect(published).toContain("webhook_port");
    expect(published).not.toContain("1933");
    expect(published).not.toContain("openviking");
    // The only published_ports in the playbook is the daemon's: the sidecar has none.
    expect(playbook.match(/^\s+published_ports:/gm)).toHaveLength(1);
  });

  it("PID 1 reaps — a second supervised process needs an init", () => {
    expect(playbook).toMatch(/^\s+init: true$/m);
  });

  it("the state volume carries OpenViking's home, at 0700 (ov.conf holds a credential)", () => {
    expect(playbook).toMatch(/path: "\{\{ openviking_home \}\}", mode: "0700"/);
  });
});

// The local English embedder. A model
// file is a new pin, so it gets rule 7's discipline: config.toml ==
// group_vars == the image layer, by URL and sha256, never a literal in the
// layer, and the deploy preflight refuses on drift (tests/deploy.test.ts).
describe("the local English embedder pin (config.toml ↔ group_vars ↔ the memory image)", () => {
  const ov = cfg.openviking;
  const gvFile = `${gv("openviking_local_embedder_dir")}/${gv("openviking_local_embedder_model")}.gguf`;

  it("config.toml and group_vars agree on the model file, its URL, its sha256, the port and the threads", () => {
    expect(ov.local_embedder_file).toBe(gvFile);
    expect(gv("openviking_local_embedder_url")).toBe(ov.local_embedder_url);
    expect(gv("openviking_local_embedder_sha256")).toBe(ov.local_embedder_sha256);
    expect(gv("openviking_local_embedder_port")).toBe(String(ov.local_embedder_port));
    expect(gv("openviking_local_embedder_threads")).toBe(String(ov.local_embedder_threads));
    // The code defaults ARE the pin: a config.toml that predates the block
    // runs exactly what group_vars bakes into the image.
    expect(OPENVIKING_DEFAULTS.local_embedder_file).toBe(gvFile);
    expect(OPENVIKING_DEFAULTS.local_embedder_url).toBe(gv("openviking_local_embedder_url"));
    expect(OPENVIKING_DEFAULTS.local_embedder_sha256).toBe(gv("openviking_local_embedder_sha256"));
  });

  it("the pin names the local model the code knows, at its dimension — in every mirror", () => {
    expect(gv("openviking_local_embedder_model")).toBe(LOCAL_EMBEDDING.model);
    expect(gv("openviking_local_embedder_dimension")).toBe(String(LOCAL_EMBEDDING.dimension));
    expect(ov.local_embedder_file.endsWith(`/${LOCAL_EMBEDDING.model}.gguf`)).toBe(true);
    expect(ov.local_embedder_url.endsWith(`/${LOCAL_EMBEDDING.model}.gguf`)).toBe(true);
    // Pinned to a COMMIT, not a moving branch.
    expect(ov.local_embedder_url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    expect(ov.local_embedder_sha256).toMatch(/^[0-9a-f]{64}$/);
    // And the generic knobs' shipped default is that same model.
    expect(gv("openviking_embedding_model")).toBe(LOCAL_EMBEDDING.model);
    expect(gv("openviking_embedding_dimension")).toBe(String(LOCAL_EMBEDDING.dimension));
  });

  it("the image downloads the model at BUILD time through the ARGs and hard-fails unless its sha256 matches", () => {
    const layer = dockerfile.slice(dockerfile.indexOf('RUN mkdir -p "${LOCAL_EMBEDDER_DIR}"'));
    expect(layer).toContain('"${LOCAL_EMBEDDER_URL}"');
    expect(layer).toContain(
      'echo "${LOCAL_EMBEDDER_SHA256}  ${LOCAL_EMBEDDER_DIR}/${LOCAL_EMBEDDER_MODEL}.gguf" | sha256sum -c -',
    );
    expect(layer).toMatch(/\|\| \{ echo "FATAL: the local embedder model/);
    // The playbook feeds those ARGs from the group_vars.
    for (const [arg, key] of [
      ["LOCAL_EMBEDDER_URL", "openviking_local_embedder_url"],
      ["LOCAL_EMBEDDER_SHA256", "openviking_local_embedder_sha256"],
      ["LOCAL_EMBEDDER_MODEL", "openviking_local_embedder_model"],
      ["LOCAL_EMBEDDER_DIR", "openviking_local_embedder_dir"],
    ] as const) {
      expect(playbook).toContain(`"${arg}={{ ${key} }}"`);
    }
    // The ARG defaults are the pin itself (tests/memory-image.test.ts holds them
    // to config.toml); a literal in a RUN line would be the drift it prevents.
    expect(layer).not.toContain(ov.local_embedder_sha256);
    expect(layer).not.toContain("huggingface.co");
    // After the venv layer, whose llama-cpp-python is its runtime.
    expect(dockerfile.indexOf('RUN mkdir -p "${LOCAL_EMBEDDER_DIR}"')).toBeGreaterThan(
      dockerfile.indexOf('"llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}"'),
    );
  });

  it("the boot's provisioning step runs the embedder beside its temporary server — only under local, from the pin", () => {
    const block = entrypoint.slice(
      entrypoint.indexOf("OV_EMBEDDER_ARGS=()"),
      entrypoint.indexOf('scripts/openviking-provision.mjs" \\'),
    );
    expect(block).toContain('if [[ "$OV_EMBEDDING_PROVIDER" == "local" ]]; then');
    expect(block).toContain('--embedder-python "$OV_VENV/bin/python"');
    expect(block).toContain('--embedder-script "$APP/scripts/openviking-embedder.py"');
    expect(block).toContain(
      '--embedder-file "$OV_LOCAL_EMBEDDER_DIR/$OV_LOCAL_EMBEDDER_MODEL.gguf"',
    );
    expect(block).toContain('--embedder-sha256 "$OV_LOCAL_EMBEDDER_SHA256"');
    expect(block).toContain('--embedder-port "$OV_LOCAL_EMBEDDER_PORT"');
    expect(entrypoint).toContain('"${OV_EMBEDDER_ARGS[@]}" \\');
    // Never backgrounded: still one foreground step.
    expect(entrypoint).not.toMatch(/openviking-embedder\.py[^\n]*&\s*$/m);
  });

  it("its port is never published — loopback inside the container, like the server's", () => {
    const published = /published_ports:\n((?:\s+-\s+.*\n)+)/.exec(playbook)?.[1] ?? "";
    expect(published).not.toContain(String(ov.local_embedder_port));
    expect(published).not.toContain("local_embedder");
    expect(localEmbedderBaseUrl(ov)).toBe(`http://127.0.0.1:${ov.local_embedder_port}/v1`);
  });

  it("refuses a pin the image and the service could not honour", () => {
    const base = { embedding_provider: "local" };
    expect(() => parseOpenViking({ ...base, local_embedder_file: "/opt/m/other.gguf" })).toThrow(
      /local_embedder_file/,
    );
    expect(() =>
      parseOpenViking({ ...base, local_embedder_file: `models/${LOCAL_EMBEDDING.model}.gguf` }),
    ).toThrow(/absolute/);
    expect(() =>
      parseOpenViking({
        ...base,
        local_embedder_url: `http://example.invalid/${LOCAL_EMBEDDING.model}.gguf`,
      }),
    ).toThrow(/https/);
    expect(() =>
      parseOpenViking({ ...base, local_embedder_url: "https://example.invalid/other.gguf" }),
    ).toThrow(/local_embedder_url/);
    expect(() => parseOpenViking({ ...base, local_embedder_sha256: "ABC" })).toThrow(/sha256/);
    expect(() => parseOpenViking({ ...base, local_embedder_port: 1933 })).toThrow(
      /other than the server's own 1933/,
    );
    expect(() => parseOpenViking({ ...base, local_embedder_port: 70000 })).toThrow(
      /local_embedder_port/,
    );
    expect(() => parseOpenViking({ ...base, local_embedder_threads: 0 })).toThrow(
      /local_embedder_threads/,
    );
    expect(() => parseOpenViking({ ...base, local_embedder_threads: 1.5 })).toThrow(
      /local_embedder_threads/,
    );
    // The service's own range is 1..16; the config refuses past it too.
    expect(() => parseOpenViking({ ...base, local_embedder_threads: 17 })).toThrow(
      /local_embedder_threads must be an integer in 1\.\.16/,
    );
    expect(parseOpenViking({ ...base, local_embedder_threads: 16 }).local_embedder_threads).toBe(
      16,
    );
  });

  it("local runs only the local English embedder — another model is refused, naming it", () => {
    expect(() =>
      parseOpenViking({ embedding_provider: "local", embedding_model: "nomic-embed-text-v1.5" }),
    ).toThrow(/local English embedder, bge-small-en-v1\.5-f16 at 384 dims/);
    expect(() =>
      parseOpenViking({
        embedding_provider: "local",
        embedding_model: LOCAL_EMBEDDING.model,
        embedding_dimension: 768,
      }),
    ).toThrow(/local English embedder/);
  });

  // A config written for the built-in model still carries its spelling under
  // `local`: a daemon must not refuse to boot over it. It is read as the
  // current local embedder (the boot renders that whatever the knob says, and
  // the re-embed migration moves the store).
  it("a config that still spells the retired built-in model under local loads as the local English embedder", () => {
    for (const raw of [
      {
        embedding_provider: "local",
        embedding_model: RETIRED_LOCAL_EMBEDDING.model,
        embedding_dimension: RETIRED_LOCAL_EMBEDDING.dimension,
      },
      { embedding_provider: "local", embedding_model: RETIRED_LOCAL_EMBEDDING.model },
    ]) {
      const c = parseOpenViking(raw);
      expect(c.embedding_model).toBe(LOCAL_EMBEDDING.model);
      expect(c.embedding_dimension).toBe(LOCAL_EMBEDDING.dimension);
    }
    // Only that exact pair: the retired model at another dimension is no
    // spelling any release wrote, and is refused.
    expect(() =>
      parseOpenViking({
        embedding_provider: "local",
        embedding_model: RETIRED_LOCAL_EMBEDDING.model,
        embedding_dimension: 384,
      }),
    ).toThrow(/local English embedder/);
    // A hosted opt-in never folds.
    expect(() =>
      parseOpenViking({
        embedding_provider: "openai",
        embedding_model: RETIRED_LOCAL_EMBEDDING.model,
      }),
    ).toThrow(/needs its embedding_dimension/);
  });

  it("ovConfEmbedder: local is the loopback wire provider; hosted is itself, with no api_base", () => {
    expect(ovConfEmbedder(OPENVIKING_DEFAULTS)).toEqual({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
      api_base: "http://127.0.0.1:1934/v1",
    });
    expect(ovConfEmbedder(parseOpenViking({ embedding_provider: "openai" }))).toEqual({
      provider: "openai",
      model: HOSTED_EMBEDDING.model,
      dimension: HOSTED_EMBEDDING.dimension,
    });
  });
});
