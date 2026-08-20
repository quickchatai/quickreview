// the OpenViking runtime's CONFIG and DEPLOY halves.
//
// The centrepiece is the triple-mirror drift test: the pinned versions live in
// config.toml, in the ansible group_vars and in the image, and this file fails
// the moment any two disagree. It is the same discipline the [pi] pin has, and
// the reason it exists is that a silently floating memory engine is a
// data-shape change nobody would notice until the vectors stopped matching.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENVIKING_DEFAULTS, openVikingBaseUrl, parseConfig, resolveOpenVikingPaths } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configToml = readFileSync(resolve(root, "config.toml"), "utf8");
const groupVars = readFileSync(resolve(root, "deploy/ansible/group_vars/all.yml"), "utf8");
const dockerfile = readFileSync(resolve(root, "deploy/ansible/templates/Dockerfile.j2"), "utf8");
const entrypoint = readFileSync(resolve(root, "deploy/ansible/templates/entrypoint.sh.j2"), "utf8");
const playbook = readFileSync(resolve(root, "deploy/ansible/playbook.yml"), "utf8");

const cfg = parseConfig(configToml);
const gv = (key: string): string | undefined => new RegExp(`^${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m").exec(groupVars)?.[1];

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
    const custom = resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS, config_file: "/etc/openviking/ov.conf", workspace: "/data/ws" });
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

describe("triple-mirror version pin (config.toml ↔ group_vars ↔ Dockerfile)", () => {
  it("config.toml and group_vars agree on both pinned versions", () => {
    expect(gv("openviking_version")).toBe(cfg.openviking.version);
    expect(gv("llama_cpp_python_version")).toBe(cfg.openviking.llama_cpp_python_version);
  });

  it("the Dockerfile pins BOTH packages through the group_vars, never a literal", () => {
    expect(dockerfile).toContain('"openviking=={{ openviking_version }}"');
    expect(dockerfile).toContain('"llama-cpp-python=={{ llama_cpp_python_version }}"');
    // A literal version in the image is exactly the drift the mirror prevents.
    expect(dockerfile).not.toMatch(/openviking==\d/);
    expect(dockerfile).not.toMatch(/llama-cpp-python==\d/);
  });

  it("the image hard-fails unless the INSTALLED versions match the pins", () => {
    expect(dockerfile).toContain("importlib.metadata");
    expect(dockerfile).toContain("import llama_cpp");
    expect(dockerfile).toMatch(/test -x \{\{ openviking_venv \}\}\/bin\/openviking-server/);
  });

  it("llama-cpp-python is installed even though openviking does not depend on it", () => {
    // Verified 2026-08-20: without it the default local dense embedder raises
    // EmbeddingConfigurationError and the server cannot boot at all.
    const llama = dockerfile.indexOf("llama-cpp-python==");
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
    expect(gv("openviking_embedding_model")).toBe(cfg.openviking.embedding_model);
    expect(gv("openviking_embedding_dimension")).toBe(String(cfg.openviking.embedding_dimension));
    expect(playbook).toContain("{{ openviking_home }}");
  });
});

describe("boot-time ov.conf (never the interactive wizard)", () => {
  it("never invokes `openviking-server init` — an interactive prompt would stall the boot", () => {
    expect(entrypoint).not.toMatch(/openviking-server\s+init/);
    expect(entrypoint).toContain("ov.conf");
  });

  it("never starts the server itself — the DAEMON supervises it", () => {
    expect(entrypoint).not.toMatch(/^\s*(nohup\s+)?[^#\n]*openviking-server(?!\s*`)[^\n]*&\s*$/m);
  });

  it("symlinks ~/.openviking onto the state volume so memory survives a rebuild", () => {
    expect(entrypoint).toContain("OV_HOME={{ openviking_home }}");
    expect(entrypoint).toMatch(/ln -sfn "\$OV_HOME" "\$HOME\/\.openviking"/);
  });

  it("renders dev auth on loopback, one worker, reduced queue workers, and NO vlm section", () => {
    const render = entrypoint.slice(entrypoint.indexOf("OV_CONF_RENDER"), entrypoint.lastIndexOf("OV_CONF_RENDER"));
    expect(render).toContain('auth_mode: "dev"');
    expect(render).toContain('host: "127.0.0.1"');
    expect(render).toContain("port: {{ openviking_port }}");
    expect(render).toContain("workers: {{ openviking_workers }}");
    expect(render).toContain("max_concurrent: {{ openviking_queue_concurrency }}");
    // The absent `vlm` is load-bearing: extraction/summaries/digest stay off,
    // and it is why `doctor` can never be the health gate.
    expect(render).not.toMatch(/\bvlm\b\s*:/);
    expect(render).toContain("extraction_enabled: false");
  });

  it("injects the OpenAI EMBEDDING credential from the secrets mount, and degrades without it", () => {
    const render = entrypoint.slice(entrypoint.indexOf("OV_CONF_RENDER"), entrypoint.lastIndexOf("OV_CONF_RENDER"));
    expect(entrypoint).toContain('QCR_SECRETS="$SECRETS"');
    expect(render).toContain('"openai_api_key"');
    expect(render).toContain('provider: "openai"');
    expect(render).toContain("conf.embedding");
    expect(render).toContain("console.warn");
    // ov.conf holds a credential: it is written 0600, never world-readable.
    expect(render).toContain("0o600");
  });

  it("a failed render never fails the boot — the daemon comes up memory-less", () => {
    expect(entrypoint).toMatch(/OV_CONF_RENDER' \|\| echo "openviking: ov\.conf render FAILED/);
  });
});

describe("container topology", () => {
  it("the OpenViking port is NEVER published out of the container", () => {
    const published = /published_ports:\n((?:\s+-\s+.*\n)+)/.exec(playbook)?.[1] ?? "";
    expect(published).toContain("webhook_port");
    expect(published).not.toContain("1933");
    expect(published).not.toContain("openviking");
  });

  it("PID 1 reaps — a second supervised process needs an init", () => {
    expect(playbook).toMatch(/^\s+init: true$/m);
  });

  it("the state volume carries OpenViking's home, at 0700 (ov.conf holds a credential)", () => {
    expect(playbook).toMatch(/path: "\{\{ openviking_home \}\}", mode: "0700"/);
  });
});
