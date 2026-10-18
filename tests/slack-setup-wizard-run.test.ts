// deploy/collect-slack-secrets.mjs run for real: the script as a node child,
// a temp config and secrets dir, piped stdin, and Slack replaced by a fetch
// stub preloaded into the child (no network). The contract under test: input
// that runs out ends every prompt loop — the wizard finishes instead of
// polling Slack on the default answer of a [Y/n] question.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "deploy/collect-slack-secrets.mjs");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-slack-wizard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fetch stub where the channel exists but the bot is never a member. More
 *  than three membership checks is the runaway poll: exit 97 says so. */
const STUB = `
let infoCalls = 0;
globalThis.fetch = async (url) => {
  const method = new URL(String(url)).pathname.split("/").pop();
  let body = { ok: true };
  if (method === "conversations.info") {
    infoCalls += 1;
    if (infoCalls > 3) {
      process.stderr.write("RUNAWAY conversations.info poll\\n");
      process.exit(97);
    }
    body = { ok: true, channel: { name: "review", is_private: false, is_member: false } };
  } else if (method === "users.list") {
    body = { ok: true, members: [] };
  }
  return { json: async () => body };
};
`;

function runWizard(stdin: string): Promise<{ code: number; out: string }> {
  const config = join(dir, "config.toml");
  copyFileSync(join(root, "tests/fixtures/config.toml"), config);
  const secrets = join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(join(secrets, "slack_bot_token"), "xoxb-1-2-stub");
  writeFileSync(join(secrets, "slack_app_token"), "xapp-1-A-2-stub");
  const preload = join(dir, "fetch-stub.mjs");
  writeFileSync(preload, STUB);
  return new Promise((done, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", preload, script, "--config", config, "--secrets-dir", secrets],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1" } },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.stdin.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code !== "EPIPE") reject(err);
    });
    child.stdin.write(stdin);
    child.stdin.end();
    child.on("close", (code) => done({ code: code ?? -1, out }));
  });
}

describe("collect-slack-secrets: input that runs out", () => {
  it("ends the channel-membership re-check instead of polling on its default", async () => {
    // manifest file? n · Enter · the channel id · then end of input
    const { code, out } = await runWizard("n\n\nC0ABCDEFG\n");
    expect(out).not.toContain("RUNAWAY");
    expect(code).toBe(0);
    expect(out).toContain("the bot is NOT a member");
    expect(out).toContain("Step 8");
    expect(out).toContain("./scripts/deploy.sh rebuild");
  });
});
