// the shape-aware secrets wizard, run for real (guards-shell style:
// the actual bash script, a temp secrets dir, piped stdin, nothing touched
// outside the temp dir). The contract under test:
//
//   * an up-front deployment-shape choice (tunnel vs plain-docker), persisted
//     in <secrets dir>/deploy_shape and overridable via QC_DEPLOY_SHAPE;
//   * tunnel_token is REQUIRED only under the tunnel shape — the docker shape
//     passes the completeness check without it and never even prompts for it;
//   * the wizard's existing UX conventions hold: values land 0600, validators
//     reject junk and re-prompt, existing files are kept.
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "deploy/collect-secrets.sh");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-secrets-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runWizard(
  stdin: string,
  opts: { env?: Record<string, string>; args?: string[] } = {},
): Promise<{ code: number; out: string }> {
  return new Promise((done, reject) => {
    const child = spawn("bash", [script, ...(opts.args ?? [])], {
      env: { ...process.env, QC_SECRETS_DIR: dir, ...(opts.env ?? {}) },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    // A wizard that refuses before reading stdin (bad shape, missing dir)
    // exits first; the late write then EPIPEs. That is the child's answer,
    // not a test failure — the exit code and output below carry it.
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") reject(err);
    });
    child.stdin.write(stdin);
    child.stdin.end();
    child.on("close", (code) => done({ code: code ?? -1, out }));
  });
}

/** Pre-seed the always-required trio so a test exercises only its own prompt. */
function seedRequired(): void {
  writeFileSync(join(dir, "app_id"), "123456");
  writeFileSync(join(dir, "app.pem"), "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n");
  writeFileSync(join(dir, "webhook_secret"), "a".repeat(32));
}

describe("the hosted-embeddings key is its OWN file", () => {
  it("is prompted separately from pi's key, lands 0600, and skipping it leaves memory local with nothing else changed", async () => {
    seedRequired();
    // stdin: skip openai_api_key, paste the embeddings key, skip both openviking keys.
    const { code, out } = await runWizard("\nsk-embeddings-only-0123456789\n\n\n", { env: { QC_DEPLOY_SHAPE: "docker" } });
    expect(code).toBe(0);
    expect(out).toContain("openai_embeddings_api_key saved");
    expect(out).toContain("skipped openai_api_key");
    expect(readFileSync(join(dir, "openai_embeddings_api_key"), "utf8")).toBe("sk-embeddings-only-0123456789");
    expect(statSync(join(dir, "openai_embeddings_api_key")).mode & 0o777).toBe(0o600);
    expect(() => readFileSync(join(dir, "openai_api_key"))).toThrow();
    // The overview says what the file is for, and that the default needs none.
    expect(out).toMatch(/embeds LOCALLY by default/);
    expect(out).toMatch(/pi's key is never used for embeddings/);
  });

  it("rejects a value that is not an OpenAI key and re-prompts", async () => {
    seedRequired();
    const { code, out } = await runWizard("\nnot-a-key\nsk-embeddings-second-try-0123\n\n\n", { env: { QC_DEPLOY_SHAPE: "docker" } });
    expect(code).toBe(0);
    expect(out).toContain("OpenAI keys start with sk-");
    expect(readFileSync(join(dir, "openai_embeddings_api_key"), "utf8")).toBe("sk-embeddings-second-try-0123");
  });
});

describe("deployment-shape choice", () => {
  it("docker shape passes with no tunnel token, and never prompts for one", async () => {
    seedRequired();
    // stdin: shape "2", then Enter-skips for openai, the embeddings key and
    // both openviking keys.
    const { code, out } = await runWizard("2\n\n\n\n\n");
    expect(code).toBe(0);
    expect(out).toContain("deployment shape: docker");
    expect(out).toContain("all required secrets in place for the 'docker' shape");
    expect(out).not.toContain("tunnel_token — Cloudflare");
    expect(out).not.toContain("still missing");
    expect(readFileSync(join(dir, "deploy_shape"), "utf8")).toBe("docker");
  });

  it("tunnel shape still requires the full set — a skipped token fails the check", async () => {
    seedRequired();
    // stdin: shape "1", Enter-skip the tunnel token, then the three optionals.
    const { code, out } = await runWizard("1\n\n\n\n\n");
    expect(code).toBe(1);
    expect(out).toContain("deployment shape: tunnel");
    expect(out).toContain("still missing: tunnel_token");
  });

  it("tunnel shape accepts a token and saves it 0600", async () => {
    seedRequired();
    const token = "t".repeat(72);
    const { code, out } = await runWizard(`1\n${token}\n\n\n\n`);
    expect(code).toBe(0);
    expect(out).toContain("tunnel_token saved");
    expect(out).toContain("all required secrets in place for the 'tunnel' shape");
    expect(readFileSync(join(dir, "tunnel_token"), "utf8")).toBe(token);
    expect(statSync(join(dir, "tunnel_token")).mode & 0o777).toBe(0o600);
  });

  it("QC_DEPLOY_SHAPE overrides non-interactively — no shape prompt at all", async () => {
    seedRequired();
    const { code, out } = await runWizard("\n\n\n", { env: { QC_DEPLOY_SHAPE: "docker" } });
    expect(code).toBe(0);
    expect(out).not.toContain("choose [1/2]");
    expect(out).toContain("deployment shape: docker (from QC_DEPLOY_SHAPE)");
    expect(readFileSync(join(dir, "deploy_shape"), "utf8")).toBe("docker");
  });

  it("refuses an unknown QC_DEPLOY_SHAPE", async () => {
    seedRequired();
    const { code, out } = await runWizard("", { env: { QC_DEPLOY_SHAPE: "nginx" } });
    expect(code).toBe(1);
    expect(out).toContain("QC_DEPLOY_SHAPE must be 'tunnel' or 'docker'");
  });

  it("a stored shape is reused on re-run without --force", async () => {
    seedRequired();
    const first = await runWizard("2\n\n\n\n");
    expect(first.code).toBe(0);
    const second = await runWizard("\n\n\n");
    expect(second.code).toBe(0);
    expect(second.out).not.toContain("choose [1/2]");
    expect(second.out).toContain("deployment shape: docker (stored");
  });

  it("a docker run with a leftover tunnel_token says the token is unused", async () => {
    seedRequired();
    writeFileSync(join(dir, "tunnel_token"), "x".repeat(72));
    const { code, out } = await runWizard("2\n\n\n\n");
    expect(code).toBe(0);
    expect(out).toContain("tunnel_token is present but unused under the docker shape");
  });
});

describe("wizard UX conventions survive the shape split", () => {
  it("validators still reject junk and re-prompt (app_id must be numeric)", async () => {
    writeFileSync(join(dir, "app.pem"), "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n");
    writeFileSync(join(dir, "webhook_secret"), "a".repeat(32));
    // stdin: bad app_id, good app_id, then Enter-skips for the optionals.
    const { code, out } = await runWizard("abc\n123456\n\n\n\n", { env: { QC_DEPLOY_SHAPE: "docker" } });
    expect(code).toBe(0);
    expect(out).toContain("that doesn't look right");
    expect(out).toContain("app_id saved");
    expect(readFileSync(join(dir, "app_id"), "utf8")).toBe("123456");
    expect(statSync(join(dir, "app_id")).mode & 0o777).toBe(0o600);
  });

  it("existing files are kept — no prompt, no overwrite, without --force", async () => {
    seedRequired();
    const before = readFileSync(join(dir, "webhook_secret"), "utf8");
    const { code, out } = await runWizard("\n\n\n", { env: { QC_DEPLOY_SHAPE: "docker" } });
    expect(code).toBe(0);
    expect(out).not.toContain("webhook_secret — the secret");
    expect(readFileSync(join(dir, "webhook_secret"), "utf8")).toBe(before);
  });

  it("the OpenViking keys stay optional-but-degrading with the existing wording", async () => {
    seedRequired();
    const { code, out } = await runWizard("2\n\n\n\n");
    expect(code).toBe(0);
    expect(out).toContain("server falls back to auth_mode=dev and per-user confinement is NOT enforced");
    expect(out).toContain("NEVER put the COMPANION key here");
  });
});
