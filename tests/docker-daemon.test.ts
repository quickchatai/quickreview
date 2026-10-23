// The compose stack's images (docker/Dockerfile = the release image,
// docker/memory/Dockerfile = the memory image) and docker-compose.yml, and
// their decoupling from Ansible. The per-image pins live in
// tests/release-image.test.ts and tests/memory-image.test.ts; this file holds
// what spans the two (one Node major, no third-party clone layer, the release
// entrypoint's no-stall and guard invariants) and the compose topology
// (webhook published, OpenViking port never).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPENVIKING_DEFAULTS, SLACK_DEFAULTS, parseConfig } from "../src/config.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The tracked config.example.toml (the rule-7 pin spelling every tree
// carries). The operator's live config.toml lives in the install's config
// home, not the checkout; its pins are held by scripts/deploy.sh's
// preflight, which reads it through the install locator and refuses on drift.
const configToml = readFileSync(resolve(root, "config.example.toml"), "utf8");
const groupVars = readFileSync(resolve(root, "deploy/ansible/group_vars/all.yml"), "utf8");
const releaseFile = readFileSync(resolve(root, "docker/Dockerfile"), "utf8");
const memoryFile = readFileSync(resolve(root, "docker/memory/Dockerfile"), "utf8");
const compose = readFileSync(resolve(root, "docker-compose.yml"), "utf8");
const playbook = readFileSync(resolve(root, "deploy/ansible/playbook.yml"), "utf8");

const cfg = parseConfig(configToml);
const gv = (key: string): string | undefined =>
  new RegExp(`^${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m").exec(groupVars)?.[1];
/** An `ARG NAME=default` out of a Dockerfile. */
const arg = (text: string, name: string): string | undefined =>
  new RegExp(`^ARG ${name}=(.+)$`, "m").exec(text)?.[1];

describe("the two images agree where they overlap", () => {
  it("one Node major, equal to group_vars", () => {
    expect(arg(releaseFile, "NODE_MAJOR")).toBe(gv("node_major"));
    expect(arg(memoryFile, "NODE_MAJOR")).toBe(arg(releaseFile, "NODE_MAJOR"));
  });

  it("the release image carries no OpenViking layer; the memory image no pi", () => {
    expect(releaseFile).not.toMatch(/openviking==|llama-cpp-python==/);
    expect(memoryFile).not.toMatch(/pi-coding-agent|PI_VERSION/);
  });

  // Lenses are our own lens tool: the images no longer depend on pi's
  // shipped subagent example, and must never carry a third-party clone (an
  // unlicensed dependency).
  it("neither depends on pi's subagent example nor carries a third-party clone layer", () => {
    for (const file of [releaseFile, memoryFile]) {
      expect(file).not.toContain("examples/extensions/subagent");
      expect(file).not.toContain("pi_subagents");
      expect(file).not.toContain("PI_SUBAGENTS");
      expect(file).not.toContain("amosblomqvist");
    }
    expect(gv("pi_subagents_commit")).toBeUndefined();
    expect(gv("pi_subagents_repo")).toBeUndefined();
  });

  it("the webhook port default is group_vars' and config.toml's", () => {
    expect(gv("webhook_port")).toBe(String(cfg.server.port));
  });

  it("carries no baked lens concurrency file: the cap rides config.toml [engine]", () => {
    expect(releaseFile).not.toContain("maxConcurrency");
    expect(playbook).not.toContain("maxConcurrency");
    expect(cfg.engine.lens_max_concurrency).toBe(4);
  });
});

// The release image's entrypoint (docker/entrypoint.sh, daemon mode); the executed
// per-mode checks are tests/entrypoint.test.ts.
describe("release entrypoint (daemon mode) — same invariants as the plain boot", () => {
  const release = readFileSync(resolve(root, "docker/entrypoint.sh"), "utf8");

  it("keeps the no-stall trust layers: defaultProjectTrust=always + a pre-seeded trust.json", () => {
    expect(release).toContain('settings.defaultProjectTrust = "always"');
    expect(release).toContain("trust[trustDir] = true");
    expect(release).toContain('QCR_PI_TRUST_DIR="$APP"');
  });

  it("registers no extension globally and prunes the retired bash-guard entry", () => {
    expect(release).not.toContain("FATAL: pi extension missing");
    expect(release).not.toContain("QCR_PI_REQUIRE_EXT");
    expect(release).toContain("bash-guard is no longer global");
  });

  it("links the pi user agents dir at the built state/agents, never clobbering a real directory", () => {
    expect(release).toContain('QCR_PI_AGENTS_TARGET="$STATE/agents"');
    expect(release).toContain("is not a symlink — NOT touching it");
  });

  it("names the secrets mount to the install locator and links <config home>/secrets to it", () => {
    expect(release).toMatch(/^\s+export QCR_SECRETS_MOUNT="\$secrets"$/m);
    expect(release).toContain('ln -sfn "$secrets" "$secrets_home"');
  });

  it("has no examples/subagent FATAL: the lens tool replaced pi's example", () => {
    expect(release).not.toContain("examples/extensions/subagent");
    expect(release).not.toContain("assert_subagent_example");
  });

  it("has none of the checkout dance: no state symlink, no boot-time npm build", () => {
    expect(release).not.toMatch(/npm (ci|run build)/);
    expect(release).not.toMatch(/ln -sfn [^\n]*state/);
    expect(release).not.toContain(".build-lock-hash");
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

  it("there is no sandbox_src: nothing is synced from a working copy to the VM any more", () => {
    expect(groupVars).not.toMatch(/^\s*#?\s*sandbox_src:/m);
    expect(playbook).not.toContain("sandbox_src");
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
    expect(block).toContain('loop: ["{{ slack_bot_token_file }}", "{{ slack_app_token_file }}"]');
    expect(gv("slack_bot_token_file")).toBe(SLACK_DEFAULTS.bot_token_file);
    expect(gv("slack_app_token_file")).toBe(SLACK_DEFAULTS.app_token_file);
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

describe("entrypoint secrets link", () => {
  it("docker-compose.yml names the mount on the container, for `docker exec` processes too", () => {
    expect(compose).toMatch(/^\s+QCR_SECRETS_MOUNT: \/opt\/quickreview\/secrets$/m);
    expect(compose).toContain(":/opt/quickreview/secrets:ro");
  });
});
