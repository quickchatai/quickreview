// The memory sidecar image (docker/memory/): the OpenViking venv, llama-cpp,
// the GGUF layer and the boot provisioning, split out of the daemon's
// container. It is the only image that carries the OpenViking pins (the
// release image has no memory engine), so this file holds them.
//
// What is pinned:
//   * the four rule-7 OpenViking pins (server, llama-cpp-python, model file,
//     and the repo-side extension commit) in docker/memory/Dockerfile ==
//     config.toml == group_vars, with the layer discipline below;
//   * the build context admits exactly what the image copies, and the one
//     runtime package the sidecar's import closure reaches is the one it ships;
//   * the entrypoint's knobs and invariants (no interactive wizard, no vlm,
//     root key from the secrets mount, degrade-never-block), and the ov.conf
//     scripts/openviking-ov-conf.mjs renders from them, executed;
//   * the sidecar's process tree is the daemon's supervisors with three
//     settings changed, and a re-embed against a COPY of a store moves the
//     copy's vectors aside, rebuilds them, and leaves the original untouched.
// The image itself is not built here (it needs docker and the network).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCAL_EMBEDDING,
  OPENVIKING_DEFAULTS,
  RETIRED_LOCAL_EMBEDDING,
  ovConfEmbedder,
  parseConfig,
  resolveOpenVikingPaths,
  type OpenVikingConfig,
} from "../src/config.js";
import { sidecarConfig, startSidecar } from "../src/openviking/sidecar.js";
import type { SupervisedChild } from "../src/openviking/index.js";
import { PROCESS_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const configToml = read("config.example.toml");
const groupVars = read("deploy/ansible/group_vars/all.yml");
const dockerfile = read("docker/memory/Dockerfile");
const dockerignore = read("docker/memory/Dockerfile.dockerignore");
const entrypoint = read("docker/memory/entrypoint.sh");

const cfg = parseConfig(configToml);
const gv = (key: string): string | undefined =>
  new RegExp(`^${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m").exec(groupVars)?.[1];
/** An `ARG NAME=default` out of the sidecar Dockerfile. */
const arg = (name: string, text = dockerfile): string | undefined =>
  new RegExp(`^ARG ${name}=(.+)$`, "m").exec(text)?.[1];

describe("memory Dockerfile — ARG defaults mirror the pinned sources of truth", () => {
  it("openviking + llama-cpp-python: the triple mirror gains this spelling", () => {
    expect(arg("OPENVIKING_VERSION")).toBe(cfg.openviking.version);
    expect(arg("OPENVIKING_VERSION")).toBe(gv("openviking_version"));
    expect(arg("LLAMA_CPP_PYTHON_VERSION")).toBe(cfg.openviking.llama_cpp_python_version);
    expect(arg("LLAMA_CPP_PYTHON_VERSION")).toBe(gv("llama_cpp_python_version"));
  });

  it("the venv path matches group_vars and config.toml's binary path", () => {
    expect(arg("OPENVIKING_VENV")).toBe(gv("openviking_venv"));
    expect(cfg.openviking.bin).toBe(`${arg("OPENVIKING_VENV")}/bin/openviking-server`);
  });

  it("the server port default is config.toml's", () => {
    expect(arg("OPENVIKING_PORT")).toBe(String(cfg.openviking.port));
  });

  it("node major == group_vars", () => {
    expect(arg("NODE_MAJOR")).toBe(gv("node_major"));
  });

  it("install lines reference the ARGs, never a literal version", () => {
    expect(dockerfile).toContain('"llama-cpp-python==${LLAMA_CPP_PYTHON_VERSION}"');
    expect(dockerfile).toContain('"openviking==${OPENVIKING_VERSION}"');
    expect(dockerfile).not.toMatch(/openviking==\d/);
    expect(dockerfile).not.toMatch(/llama-cpp-python==\d/);
  });

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
    const nonArg = dockerfile
      .split("\n")
      .filter((l) => !l.startsWith("ARG "))
      .join("\n");
    expect(nonArg).not.toContain(cfg.openviking.local_embedder_sha256);
    expect(nonArg).not.toContain("huggingface.co");
  });

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

  it("llama.cpp is built for the target platform, never the build host's CPU, and AVX-512/VNNI/AMX are refused (the 1.0.2 SIGILL)", () => {
    expect(dockerfile).toMatch(/^ARG TARGETARCH$/m);
    expect(dockerfile).toContain('CMAKE_ARGS="$llama_cmake"');
    expect(dockerfile).toContain("--no-binary llama-cpp-python");
    const amd64 = /amd64\) llama_cmake="([^"]*)"/.exec(dockerfile)?.[1] ?? "";
    for (const on of ["GGML_AVX", "GGML_AVX2", "GGML_FMA", "GGML_F16C"])
      expect(amd64).toContain(`-D${on}=ON`);
    for (const off of ["GGML_NATIVE", "GGML_AVX512", "GGML_AVX_VNNI", "GGML_AMX_TILE"])
      expect(amd64).toContain(`-D${off}=OFF`);
    expect(/\*\) llama_cmake="([^"]*)"/.exec(dockerfile)?.[1]).toBe("-DGGML_NATIVE=OFF");
    // the build-time check: objdump over every llama library, refusing zmm / VNNI / AMX
    expect(dockerfile).toContain("objdump -d");
    expect(dockerfile).toContain("%zmm|vpdpbusd|vpdpwssd|tdpb|tileloadd");
  });

  it("llama-cpp-python installs BEFORE openviking - without it the server cannot boot", () => {
    expect(dockerfile.indexOf("llama-cpp-python==${")).toBeGreaterThan(-1);
    expect(dockerfile.indexOf("llama-cpp-python==${")).toBeLessThan(
      dockerfile.indexOf("openviking==${"),
    );
  });

  it("carries no pi, tmux, gh or claude: a memory server runs no model and posts nothing", () => {
    const code = dockerfile
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toMatch(/pi-coding-agent|PI_VERSION|tmux|githubcli|\bgh\b|\bclaude\b/i);
  });

  it("the vendored extension's commit pin rides the repo, not this image", () => {
    expect(dockerfile).not.toContain(cfg.openviking.extension_commit);
  });

  it("runs as a non-root user with a numeric uid", () => {
    expect(arg("REVIEW_UID")).toMatch(/^\d+$/);
    expect(dockerfile).toMatch(/^USER review$/m);
  });

  it("has a health check on the server's /health", () => {
    expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*\/health/);
  });
});

describe("memory image — build context", () => {
  // Resolve the files the image's COPY lines read from the context.
  const copies = dockerfile
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("COPY ") && !l.includes("--from="))
    .map((l) => l.split(/\s+/).slice(1, -1))
    .flat();
  const admitted = dockerignore
    .split("\n")
    .filter((l) => l.startsWith("!"))
    .map((l) => l.slice(1));

  it("admits everything the COPY lines read, and starts from nothing", () => {
    expect(dockerignore).toMatch(/^\*$/m);
    expect(copies.length).toBeGreaterThan(5);
    for (const src of copies) {
      const ok = admitted.some((a) => src === a || src.startsWith(`${a}/`));
      expect(ok, `${src} is not admitted by docker/memory/Dockerfile.dockerignore`).toBe(true);
      expect(existsSync(join(root, src)), `${src} exists`).toBe(true);
    }
  });

  it("admits nothing that no COPY reads", () => {
    for (const a of admitted) {
      const used = copies.some((src) => src === a || src.startsWith(`${a}/`));
      expect(used, `${a} is admitted but never copied`).toBe(true);
    }
  });

  it("ships exactly the runtime packages the sidecar's import closure reaches", () => {
    const seen = new Set<string>();
    const externals = new Set<string>();
    const walk = (rel: string): void => {
      if (seen.has(rel)) return;
      seen.add(rel);
      // Runtime imports only: type-only imports are erased from dist/.
      const text = read(rel);
      const specs = [
        ...text.matchAll(
          /^(?:import|export)\s+(?!type\b)(?:\*(?:\s+as\s+\w+)?|\{[^}]*\}|[\w$]+)(?:\s*,\s*\{[^}]*\})?\s+from\s+["']([^"']+)["']/gm,
        ),
        ...text.matchAll(/^import\s+["']([^"']+)["']/gm),
        ...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ];
      for (const m of specs) {
        const spec = m[1]!;
        if (spec.startsWith(".")) {
          walk(relative(root, resolve(root, dirname(rel), spec.replace(/\.js$/, ".ts"))));
        } else if (!spec.startsWith("node:")) {
          externals.add(spec);
        }
      }
    };
    walk("src/openviking/sidecar-main.ts");
    const shipped = [...dockerfile.matchAll(/--from=build \/src\/node_modules\/(\S+)/g)].map(
      (m) => m[1],
    );
    expect([...externals].sort()).toEqual(shipped.sort());
  });
});

describe("memory entrypoint — the boot of a container that only runs OpenViking", () => {
  it("is valid bash", () => {
    const r = spawnSync("bash", ["-n", join(root, "docker/memory/entrypoint.sh")], {
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
  });

  const knobs = (text: string): Map<string, string> =>
    new Map(
      [...text.matchAll(/^(OV_[A-Z0-9_]+)="\$\{(QCR_OPENVIKING_[A-Z0-9_]+):-([^}]*)\}"/gm)].map(
        (m) => [m[2]!, m[3]!],
      ),
    );

  it("every knob default mirrors group_vars / config.toml", () => {
    const mine = knobs(entrypoint);
    expect(mine.size).toBeGreaterThanOrEqual(15);
    const def = (name: string): string | undefined => mine.get(`QCR_OPENVIKING_${name}`);
    expect(def("HOME")).toBe(cfg.openviking.home);
    expect(def("QUEUE_CONCURRENCY")).toBe(String(cfg.openviking.queue_concurrency));
    expect(def("AUTH_MODE")).toBe("api_key");
    // The shipped default is the local embedder; the live config may opt into
    // a hosted provider.
    expect(def("EMBEDDING_PROVIDER")).toBe("local");
    expect(def("EMBEDDING_PROVIDER")).toBe(OPENVIKING_DEFAULTS.embedding_provider);
    expect(def("EMBEDDING_MODEL")).toBe(OPENVIKING_DEFAULTS.embedding_model);
    expect(def("EMBEDDING_DIMENSION")).toBe(String(OPENVIKING_DEFAULTS.embedding_dimension));
    expect(def("EMBEDDING_KEY_FILE")).toBe(OPENVIKING_DEFAULTS.embedding_key_file);
    expect(def("EMBEDDING_KEY_FILE")).toBe(gv("openviking_embedding_key_file"));
    expect(def("LOCAL_EMBEDDER_MODEL")).toBe(LOCAL_EMBEDDING.model);
    expect(def("LOCAL_EMBEDDER_DIMENSION")).toBe(String(LOCAL_EMBEDDING.dimension));
    expect(`${def("LOCAL_EMBEDDER_DIR")}/${def("LOCAL_EMBEDDER_MODEL")}.gguf`).toBe(
      cfg.openviking.local_embedder_file,
    );
    expect(def("LOCAL_EMBEDDER_SHA256")).toBe(cfg.openviking.local_embedder_sha256);
    expect(def("LOCAL_EMBEDDER_THREADS")).toBe(String(cfg.openviking.local_embedder_threads));
    expect(def("ROOT_KEY_FILE")).toBe(cfg.openviking.root_key_file);
    expect(def("REVIEWER_KEY_FILE")).toBe(cfg.openviking.reviewer_key_file);
  });

  it("the knob defaults are config.toml's: port, workers, auth mode, embedder", () => {
    const mine = knobs(entrypoint);
    expect(mine.get("QCR_OPENVIKING_PORT")).toBe(String(cfg.openviking.port));
    expect(mine.get("QCR_OPENVIKING_WORKERS")).toBe(String(cfg.openviking.workers));
    expect(mine.get("QCR_OPENVIKING_AUTH_MODE")).toBe(cfg.openviking.auth_mode);
    expect(mine.get("QCR_OPENVIKING_EMBEDDING_PROVIDER")).toBe(cfg.openviking.embedding_provider);
    expect(mine.get("QCR_OPENVIKING_LOCAL_EMBEDDER_PORT")).toBe(
      String(cfg.openviking.local_embedder_port),
    );
    expect(mine.get("QCR_OPENVIKING_PROVISION_USERS")).toBe(
      cfg.openviking.provision_users.join(","),
    );
  });

  it("holds the boot invariants", () => {
    const code = entrypoint
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    // No interactive wizard, no vlm section, no hand-written root key.
    expect(code).not.toMatch(/openviking-server\s+init/);
    expect(code).not.toContain("vlm");
    // The COMPANION key is never provisioned into this container.
    expect(code).not.toContain("openviking_companion_key");
    expect(code).toContain('--root-key-file "$SECRETS/$OV_ROOT_KEY_FILE"');
    // Degrade, never block: every boot step carries its `||`.
    for (const step of [
      "openviking-ov-conf.mjs",
      'openviking-reembed.mjs" prepare',
      "openviking-provision.mjs",
    ]) {
      const at = entrypoint.indexOf(step);
      expect(at, step).toBeGreaterThan(-1);
      const rest = entrypoint.slice(at, entrypoint.indexOf("\n\n", at));
      expect(rest, step).toMatch(/\|\| echo "openviking:/);
    }
    // Never wipe a store: the one deletion is the old ~/.openviking directory,
    // and only after `cp -a` folded its contents onto the volume.
    const removals = code.split("\n").filter((l) => /\brm\b/.test(l));
    expect(removals).toEqual([
      '  if cp -a "$HOME/.openviking/." "$OV_HOME/" && rm -rf "$HOME/.openviking"; then',
    ]);
  });

  it("orders the boot: render, then the migration check, then provisioning, then exec", () => {
    const at = (s: string) => entrypoint.indexOf(s);
    expect(at("openviking-ov-conf.mjs")).toBeGreaterThan(-1);
    expect(at("openviking-ov-conf.mjs")).toBeLessThan(at('openviking-reembed.mjs" prepare'));
    expect(at('openviking-reembed.mjs" prepare')).toBeLessThan(at("openviking-provision.mjs"));
    expect(at("openviking-provision.mjs")).toBeLessThan(at("exec node"));
    expect(entrypoint.trimEnd().split("\n").at(-1)).toBe(
      'exec node "$APP/dist/src/openviking/sidecar-main.js"',
    );
  });

  it("provisioning starts the pair in the foreground, on loopback", () => {
    expect(entrypoint).toContain("--start-server");
    expect(entrypoint).toContain("--host 127.0.0.1");
    expect(entrypoint).toContain(
      '--embedder-file "$OV_LOCAL_EMBEDDER_DIR/$OV_LOCAL_EMBEDDER_MODEL.gguf"',
    );
  });

  it("the server binds the container network, never published: the Dockerfile EXPOSEs, nothing maps a host port", () => {
    expect(dockerfile).toMatch(/^EXPOSE /m);
    expect(entrypoint).toContain('OV_BIND_HOST="${QCR_OPENVIKING_BIND_HOST:-0.0.0.0}"');
  });
});

// ---- the ov.conf document --------------------------------------------------

describe("ov.conf — the sidecar renders the document, executed", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-ovconf-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const baseEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    QCR_SECRETS: join(dir, "secrets"),
    QCR_OV_PORT: "1933",
    QCR_OV_WORKERS: "1",
    QCR_OV_QUEUE_CONCURRENCY: "2",
    QCR_OV_AUTH_MODE: "api_key",
    QCR_OV_EMBEDDING_PROVIDER: "local",
    QCR_OV_EMBEDDING_MODEL: "bge-small-en-v1.5-f16",
    QCR_OV_EMBEDDING_DIMENSION: "384",
    QCR_OV_EMBEDDING_KEY_FILE: "openai_embeddings_api_key",
    QCR_OV_LOCAL_EMBEDDER_MODEL: "bge-small-en-v1.5-f16",
    QCR_OV_LOCAL_EMBEDDER_DIMENSION: "384",
    QCR_OV_LOCAL_EMBEDDER_PORT: "1934",
    QCR_OV_ROOT_KEY_FILE: "openviking_root_key",
  });

  /** Run the renderer into `<dir>/home/ov.conf`; the file and the warnings. */
  function run(env: NodeJS.ProcessEnv) {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    const conf = join(home, "ov.conf");
    const r = spawnSync(process.execPath, [join(root, "scripts/openviking-ov-conf.mjs")], {
      env: { ...env, OPENVIKING_CONF: conf },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    return {
      conf: JSON.parse(readFileSync(conf, "utf8")) as Record<string, any>,
      mode: statSync(conf).mode & 0o777,
      warnings: r.stderr,
    };
  }

  const scenarios: Array<[string, (env: NodeJS.ProcessEnv) => void]> = [
    [
      "local embedder, root key present",
      () => {
        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "openviking_root_key"), "root-secret\n");
      },
    ],
    ["local embedder, root key missing (dev fallback, said aloud)", () => undefined],
    [
      "a project .env from an older release names the retired model under local",
      (env) => {
        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "openviking_root_key"), "root-secret\n");
        env.QCR_OV_EMBEDDING_MODEL = "bge-small-zh-v1.5-f16";
        env.QCR_OV_EMBEDDING_DIMENSION = "512";
      },
    ],
    [
      "hosted opt-in with its own key file",
      (env) => {
        mkdirSync(join(dir, "secrets"), { recursive: true });
        writeFileSync(join(dir, "secrets", "openviking_root_key"), "root-secret\n");
        writeFileSync(join(dir, "secrets", "openai_embeddings_api_key"), "sk-embed\n");
        env.QCR_OV_EMBEDDING_PROVIDER = "openai";
        env.QCR_OV_EMBEDDING_MODEL = "text-embedding-3-small";
        env.QCR_OV_EMBEDDING_DIMENSION = "1536";
      },
    ],
    [
      "hosted opt-in with no key file (rendered without one, never switched)",
      (env) => {
        env.QCR_OV_EMBEDDING_PROVIDER = "openai";
        env.QCR_OV_EMBEDDING_MODEL = "text-embedding-3-small";
        env.QCR_OV_EMBEDDING_DIMENSION = "1536";
      },
    ],
    [
      "dev auth mode",
      (env) => {
        env.QCR_OV_AUTH_MODE = "dev";
      },
    ],
  ];

  for (const [name, setup] of scenarios) {
    it(`${name}: 0600, an explicit embedder, no vlm`, { timeout: PROCESS_TIMEOUT_MS }, () => {
      const env = baseEnv();
      setup(env);
      const a = run(env);
      expect(a.mode).toBe(0o600);
      expect(a.conf.embedding.dense).toBeDefined();
      expect(a.conf.vlm).toBeUndefined();
      expect(a.conf.storage.workspace).toBeDefined();
    });
  }

  it("SHIPPED DEFAULT: embeds locally with no key required; pi's key in the mount changes nothing", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "openai_api_key"), "sk-pi-model-credential\n");
    writeFileSync(join(dir, "secrets", "openviking_root_key"), "root-key-value\n");
    const { conf } = run(baseEnv());
    expect(conf.embedding.dense).toEqual({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
      api_base: "http://127.0.0.1:1934/v1",
      query_param: "query",
      document_param: "passage",
      input: "text",
    });
    const dense = conf.embedding.dense as Record<string, unknown>;
    expect({
      provider: dense.provider,
      model: dense.model,
      dimension: dense.dimension,
      api_base: dense.api_base,
    }).toEqual(ovConfEmbedder(cfg.openviking));
    const text = JSON.stringify(conf);
    expect(text).not.toContain("sk-pi-model-credential");
    expect([...text.matchAll(/"([a-z_]*api_key)":/g)].map((m) => m[1])).toEqual(["root_api_key"]);
    expect([...text.matchAll(/https?:\/\/([^/:"]+)/g)].map((m) => m[1])).toEqual(["127.0.0.1"]);
    expect(conf.server.auth_mode).toBe("api_key");
    expect(conf.extraction_enabled ?? conf.storage?.extraction_enabled).toBeUndefined();
  });

  it("a missing root key degrades to dev mode, said aloud, never wedging", () => {
    const { conf, warnings } = run(baseEnv());
    expect(conf.server.auth_mode).toBe("dev");
    expect(warnings).toContain("Per-user confinement is NOT enforced");
  });

  it("a stale .env model under local is ignored: the pinned model renders, and it says so", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "openviking_root_key"), "r\n");
    const { conf, warnings } = run({
      ...baseEnv(),
      QCR_OV_EMBEDDING_MODEL: RETIRED_LOCAL_EMBEDDING.model,
      QCR_OV_EMBEDDING_DIMENSION: String(RETIRED_LOCAL_EMBEDDING.dimension),
    });
    expect(conf.embedding.dense).toMatchObject({
      provider: "openai",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
    });
    expect(warnings).toMatch(/ignored under provider local/);
  });

  it("turns model-based query planning OFF and bounds embedding concurrency on the knob", () => {
    const { conf } = run(baseEnv());
    expect(conf.retrieval).toEqual({ enable_intent: false });
    expect(conf.embedding.max_concurrent).toBe(2);
    expect(run({ ...baseEnv(), QCR_OV_QUEUE_CONCURRENCY: "1" }).conf.embedding.max_concurrent).toBe(
      1,
    );
  });

  it("OPT-IN: the hosted provider reads its OWN key file; without one it renders no key", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "secrets", "openviking_root_key"), "r\n");
    writeFileSync(join(dir, "secrets", "openai_api_key"), "sk-pi\n");
    const hosted = {
      ...baseEnv(),
      QCR_OV_EMBEDDING_PROVIDER: "openai",
      QCR_OV_EMBEDDING_MODEL: "text-embedding-3-small",
      QCR_OV_EMBEDDING_DIMENSION: "1536",
    };
    const without = run(hosted);
    expect(without.conf.embedding.dense.provider).toBe("openai");
    expect(without.conf.embedding.dense.api_key).toBeUndefined();
    writeFileSync(join(dir, "secrets", "openai_embeddings_api_key"), "sk-embeddings\n");
    const withKey = run(hosted);
    expect(withKey.conf.embedding.dense).toMatchObject({
      dimension: 1536,
      api_key: "sk-embeddings",
    });
  });

  it(
    "the server listens where QCR_OV_HOST says; the embedder stays on loopback",
    { timeout: PROCESS_TIMEOUT_MS },
    () => {
      mkdirSync(join(dir, "secrets"), { recursive: true });
      writeFileSync(join(dir, "secrets", "openviking_root_key"), "root-secret\n");
      const env = baseEnv();
      const a = run(env);
      const b = run({ ...env, QCR_OV_HOST: "0.0.0.0" });
      expect(a.conf.server.host).toBe("127.0.0.1");
      expect(b.conf.server.host).toBe("0.0.0.0");
      expect(b.conf.embedding.dense.api_base).toBe("http://127.0.0.1:1934/v1");
    },
  );
});

// ---- the sidecar's process tree ---------------------------------------------

class FakeChild extends EventEmitter implements SupervisedChild {
  readonly pid: number;
  stdout = new EventEmitter() as unknown as SupervisedChild["stdout"];
  stderr = new EventEmitter() as unknown as SupervisedChild["stderr"];
  killed: NodeJS.Signals[] = [];
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    this.emit("exit", 0, signal);
    return true;
  }
}

class FakeClock {
  pending: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  schedule = (fn: () => void, ms: number): (() => void) => {
    const entry = { fn, ms, cancelled: false };
    this.pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  live(): Array<{ fn: () => void; ms: number; cancelled: boolean }> {
    return this.pending.filter((p) => !p.cancelled);
  }
  /** Fire the oldest live timer with this delay. */
  async fire(ms: number): Promise<void> {
    const entry = this.live().find((p) => p.ms === ms);
    if (!entry)
      throw new Error(
        `no live timer at ${ms}ms (have ${this.live()
          .map((p) => p.ms)
          .join(",")})`,
      );
    entry.cancelled = true;
    entry.fn();
    await flush();
  }
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const RENDERED_LOCAL = JSON.stringify({
  embedding: {
    dense: {
      provider: "openai",
      model: "bge-small-en-v1.5-f16",
      dimension: 384,
      api_base: "http://127.0.0.1:1934/v1",
    },
  },
});

describe("the sidecar's process tree", () => {
  it("forces the config local and probes itself on loopback, whatever the daemon's config says", () => {
    const daemonSide = resolveOpenVikingPaths({
      ...OPENVIKING_DEFAULTS,
      endpoint: "remote",
      host: "qcr-memory",
    });
    const mine = sidecarConfig(daemonSide);
    expect(mine.endpoint).toBe("local");
    expect(mine.host).toBe("127.0.0.1");
    expect({ ...mine, endpoint: "", host: "" }).toEqual({ ...daemonSide, endpoint: "", host: "" });
  });

  it("starts the embedder, then the server on the bind address once it serves; stops both on SIGTERM", async () => {
    const clock = new FakeClock();
    const lines: string[] = [];
    const spawns: Array<{ cmd: string; args: string[] }> = [];
    const children: FakeChild[] = [];
    const probed: string[] = [];
    const sidecar = startSidecar({
      cfg: resolveOpenVikingPaths({
        ...OPENVIKING_DEFAULTS,
        endpoint: "remote",
        host: "qcr-memory",
      }),
      repoRoot: root,
      secretsDir: "/nonexistent",
      bindHost: "0.0.0.0",
      log: (m) => lines.push(m),
      spawn: (cmd, args) => {
        spawns.push({ cmd, args });
        const c = new FakeChild(3000 + children.length);
        children.push(c);
        return c;
      },
      fetchFn: async (url) => {
        probed.push(url);
        return { ok: true, status: 200, json: async () => ({ version: cfg.openviking.version }) };
      },
      exists: () => true,
      schedule: clock.schedule,
      readOvConf: () => RENDERED_LOCAL,
      reembedLoad: async () => {
        throw new Error("no re-embed in this case");
      },
    });
    // The embedder first; the server is held by the gate.
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.cmd).toBe("/opt/openviking/venv/bin/python");
    expect(sidecar.status().waiting_for).toMatch(/the local embedder/);
    await clock.fire(500); // the embedder's probe
    await clock.fire(500); // the server's gate poll
    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.cmd).toBe(cfg.openviking.bin);
    // --host is the bind address; the config file is the state home's ov.conf.
    const a = spawns[1]!.args;
    expect(a[a.indexOf("--host") + 1]).toBe("0.0.0.0");
    expect(a[a.indexOf("--port") + 1]).toBe("1933");
    expect(a[a.indexOf("--config") + 1]).toBe(cfg.openviking.config_file);
    // Its own health probe is loopback, never the daemon's remote name.
    // Both children now probe at the health cadence; fire each.
    await clock.fire(cfg.openviking.health_interval_s * 1000);
    await clock.fire(cfg.openviking.health_interval_s * 1000);
    expect(probed.some((u) => u === "http://127.0.0.1:1933/ready")).toBe(true);
    expect(probed.some((u) => u.includes("qcr-memory"))).toBe(false);
    const status = sidecar.status();
    expect(status).toMatchObject({ running: true, reachable: true, ready: true });
    expect(status.endpoint).toBeUndefined();
    await sidecar.stop();
    expect(children.map((c) => c.killed)).toEqual([["SIGTERM"], ["SIGTERM"]]);
  });
});

// ---- the sidecar-side boot re-embed, against a COPY of a store --------------

describe("boot re-embed on the sidecar, against a copy of a store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-sidecar-store-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A store built under the hosted embedder: the vectors a local-English
   * boot cannot read, and one memory text that must survive every step. */
  function seedStore(home: string): void {
    const coll = join(home, "workspace", "vectordb", "context");
    mkdirSync(join(coll, "store"), { recursive: true });
    const payload = JSON.stringify({
      dimension: 1536,
      model: "text-embedding-3-small",
      model_identity: "text-embedding-3-small",
      provider: "openai",
    });
    writeFileSync(
      join(coll, "collection_meta.json"),
      JSON.stringify({
        CollectionName: "context",
        Description: `Unified context collection\n\n[openviking.embedding]\n${payload}`,
        Fields: [],
      }),
    );
    writeFileSync(join(coll, "store", "CURRENT"), "MANIFEST-000002");
    const mem = join(home, "workspace", "viking", "default", "user", "reviewer", "memories");
    mkdirSync(join(mem, "experiences"), { recursive: true });
    writeFileSync(join(mem, "experiences", "20260901T100000-aaaa0000.md"), "#calibration x\n");
  }

  /** Every file under `dir` -> sha256, for a byte-level before/after. */
  function snapshot(base: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else out[relative(base, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
      }
    };
    walk(base);
    return out;
  }

  it(
    "prepare moves the copy's vectors aside, the driver rebuilds them once /ready passes, and the original store is untouched",
    { timeout: PROCESS_TIMEOUT_MS },
    async () => {
      const original = join(dir, "original");
      seedStore(original);
      const before = snapshot(original);
      const copy = join(dir, "copy");
      cpSync(original, copy, { recursive: true });
      const secrets = join(dir, "secrets");
      mkdirSync(secrets);
      writeFileSync(join(secrets, "openviking_root_key"), "root-secret\n");
      writeFileSync(join(secrets, "openviking_reviewer_key"), "reviewer-secret\n");

      // The boot steps, exactly as entrypoint.sh runs them, on the copy.
      const env = {
        PATH: process.env.PATH,
        OPENVIKING_CONF: join(copy, "ov.conf"),
        QCR_SECRETS: secrets,
        QCR_OV_HOST: "0.0.0.0",
        QCR_OV_PORT: "19333",
        QCR_OV_WORKERS: "1",
        QCR_OV_QUEUE_CONCURRENCY: "2",
        QCR_OV_AUTH_MODE: "api_key",
        QCR_OV_EMBEDDING_PROVIDER: "local",
        QCR_OV_EMBEDDING_MODEL: LOCAL_EMBEDDING.model,
        QCR_OV_EMBEDDING_DIMENSION: String(LOCAL_EMBEDDING.dimension),
        QCR_OV_EMBEDDING_KEY_FILE: "openai_embeddings_api_key",
        QCR_OV_LOCAL_EMBEDDER_MODEL: LOCAL_EMBEDDING.model,
        QCR_OV_LOCAL_EMBEDDER_DIMENSION: String(LOCAL_EMBEDDING.dimension),
        QCR_OV_LOCAL_EMBEDDER_PORT: String(OPENVIKING_DEFAULTS.local_embedder_port),
        QCR_OV_ROOT_KEY_FILE: "openviking_root_key",
      };
      const render = spawnSync(process.execPath, [join(root, "scripts/openviking-ov-conf.mjs")], {
        env,
        encoding: "utf8",
      });
      expect(render.status, render.stderr).toBe(0);
      const prepare = spawnSync(
        process.execPath,
        [
          join(root, "scripts/openviking-reembed.mjs"),
          "prepare",
          "--home",
          copy,
          "--config",
          join(copy, "ov.conf"),
          "--users",
          "reviewer,companion",
          "--user",
          "reviewer",
        ],
        { env: { PATH: process.env.PATH }, encoding: "utf8" },
      );
      expect(prepare.status, prepare.stderr).toBe(0);

      // The copy: vectors moved ASIDE (not deleted), memory text kept, the
      // journal says reviewer is pending and companion is the operator's.
      const coll = join(copy, "workspace", "vectordb");
      expect(existsSync(join(coll, "context"))).toBe(false);
      const aside = readdirSync(coll).filter((n) => n !== "context");
      expect(aside).toHaveLength(1);
      expect(existsSync(join(coll, aside[0]!, "store", "CURRENT"))).toBe(true);
      const memText = join(
        "workspace/viking/default/user/reviewer/memories/experiences/20260901T100000-aaaa0000.md",
      );
      expect(readFileSync(join(copy, memText), "utf8")).toBe("#calibration x\n");
      const journal = JSON.parse(readFileSync(join(copy, "reembed.json"), "utf8"));
      expect(journal.namespaces.reviewer.state).toBe("pending");
      expect(journal.namespaces.companion.state).toBe("operator");

      // The ORIGINAL store is byte-for-byte what it was: nothing above ever
      // touched it, and nothing wiped anything.
      expect(snapshot(original)).toEqual(before);

      // The sidecar's driver: waits for /ready, then rebuilds reviewer's
      // vectors through the server's reindex API with the reviewer key.
      const clock = new FakeClock();
      const lines: string[] = [];
      const reindexed: Array<{ url: string; auth: string | undefined }> = [];
      const fetchFn = async (
        url: string,
        init?: { headers?: Record<string, string>; method?: string; signal?: AbortSignal },
      ) => {
        if (/\/content\/reindex|\/reindex/.test(url)) {
          reindexed.push({ url, auth: init?.headers?.["Authorization"] });
          return {
            status: 200,
            ok: true,
            json: async () => ({ status: "ok", result: { task_id: "t1", status: "accepted" } }),
          };
        }
        if (/\/tasks\//.test(url))
          return {
            status: 200,
            ok: true,
            json: async () => ({
              status: "ok",
              result: {
                task_id: "t1",
                status: "completed",
                result: {
                  scanned_records: 1,
                  rebuilt_records: 1,
                  failed_records: 0,
                  unsupported_records: 0,
                },
              },
            }),
          };
        return { status: 200, ok: true, json: async () => ({ version: cfg.openviking.version }) };
      };
      const sidecar = startSidecar({
        cfg: resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, home: copy, port: 19333 }),
        repoRoot: root,
        secretsDir: secrets,
        bindHost: "0.0.0.0",
        log: (m) => lines.push(m),
        spawn: () => new FakeChild(4000),
        fetchFn,
        reembedFetch: fetchFn,
        exists: () => true,
        schedule: clock.schedule,
        readOvConf: () => readFileSync(join(copy, "ov.conf"), "utf8"),
      });
      // The driver loads the real script by dynamic import.
      for (let i = 0; i < 200 && sidecar.status().reembed?.state === "unknown"; i++)
        await new Promise<void>((r) => setTimeout(r, 10));
      expect(lines.filter((l) => /reembed/.test(l))).toEqual([
        expect.stringMatching(/outstanding \(pending\)/),
      ]);
      expect(sidecar.status().reembed?.state).toBe("pending");
      await clock.fire(500); // the embedder's probe: it serves
      await clock.fire(500); // the server's gate poll: spawned
      await clock.fire(cfg.openviking.health_interval_s * 1000); // the embedder's cadence probe
      await clock.fire(cfg.openviking.health_interval_s * 1000); // the server's: /ready passes
      await clock.fire(0); // the driver's tick
      // The script polls its task on its own (real) cadence.
      for (let i = 0; i < 300 && sidecar.status().reembed?.state === "pending"; i++)
        await new Promise<void>((r) => setTimeout(r, 50));
      expect(reindexed).toHaveLength(1);
      expect(reindexed[0]!.auth).toBe("Bearer reviewer-secret");
      expect(sidecar.status().reembed?.state).toBe("completed");
      const after = JSON.parse(readFileSync(join(copy, "reembed.json"), "utf8"));
      expect(after.namespaces.reviewer.state).toBe("completed");
      expect(after.namespaces.companion.state).toBe("operator");
      // Still nothing wiped: the old vectors remain as the rollback.
      expect(existsSync(join(coll, aside[0]!, "store", "CURRENT"))).toBe(true);
      expect(snapshot(original)).toEqual(before);
      await sidecar.stop();
    },
  );
});

// Keep the type import honest: the sidecar takes the daemon's config shape.
const _typeCheck: OpenVikingConfig = OPENVIKING_DEFAULTS;
void _typeCheck;

describe("memory entrypoint — executed against a stub app root", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "memory-entrypoint-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // A stub app root: every boot script records its name, the config module
  // answers `enabled`, and sidecar-main records the secrets mount it was given.
  function boot(enabled: boolean): { calls: string[]; mount: string } {
    const app = join(dir, "app");
    mkdirSync(join(app, "scripts"), { recursive: true });
    mkdirSync(join(app, "dist/src/openviking"), { recursive: true });
    const log = join(dir, "calls.log");
    for (const s of ["openviking-ov-conf", "openviking-reembed", "openviking-provision"]) {
      writeFileSync(
        join(app, "scripts", `${s}.mjs`),
        `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "${s}\\n");\n`,
      );
    }
    writeFileSync(
      join(app, "dist/src/config.js"),
      `export const loadConfig = () => ({ openviking: { enabled: ${enabled} } });\n`,
    );
    writeFileSync(
      join(app, "dist/src/openviking/sidecar-main.js"),
      `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(log)}, "main:" + process.env.QCR_SECRETS_MOUNT + "\\n");\n`,
    );
    writeFileSync(join(app, "package.json"), '{"type":"module"}\n');
    const home = join(dir, "home");
    mkdirSync(home);
    const r = spawnSync("bash", [join(root, "docker/memory/entrypoint.sh")], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        QCR_APP_ROOT: app,
        QCR_SECRETS: join(dir, "secrets"),
        QCR_OPENVIKING_HOME: join(dir, "ovhome"),
      },
      encoding: "utf8",
    });
    expect(r.status, r.stderr).toBe(0);
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    const main = calls.find((c) => c.startsWith("main:")) ?? "";
    return { calls: calls.filter((c) => !c.startsWith("main:")), mount: main.slice(5) };
  }

  it(
    "runs the boot steps when memory is enabled and names the secrets mount to the supervisor",
    { timeout: PROCESS_TIMEOUT_MS },
    () => {
      const r = boot(true);
      expect(r.calls).toEqual([
        "openviking-ov-conf",
        "openviking-reembed",
        "openviking-provision",
      ]);
      expect(r.mount).toBe(join(dir, "secrets"));
    },
  );

  it(
    "skips render, migration check and provisioning when memory is disabled",
    { timeout: PROCESS_TIMEOUT_MS },
    () => {
      const r = boot(false);
      expect(r.calls).toEqual([]);
      expect(r.mount).toBe(join(dir, "secrets"));
    },
  );
});
