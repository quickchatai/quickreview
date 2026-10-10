// Carrying the review history digest to the PC's state home
// (src/tui/historypull.ts). The runner is a fake — no ssh, no docker — and the
// state home a temp dir: what is asserted is the exact argv the VM is asked to
// run, and that the ONE file lands where the companion reads it, 0600, and
// nowhere else — or not at all.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TUI_DEFAULTS, type TuiConfig } from "../src/config.js";
import { DIGEST_KIND, DIGEST_VERSION, type ReviewHistoryDigest } from "../src/reviewhistory.js";
import { HISTORY_DIGEST_FILE } from "../src/setup/history.js";
import { pullReviewHistory } from "../src/tui/historypull.js";
import { historyDigestArgv, type SshRunner } from "../src/tui/remote.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "qcr-pull-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const tui: TuiConfig = {
  ...TUI_DEFAULTS,
  ssh_host: "review-vm",
  container: "quickreview-sandbox",
  sudo_docker: true,
};
const REPO = "example-org/example-app";

function digest(over: Partial<ReviewHistoryDigest> = {}): ReviewHistoryDigest {
  return {
    kind: DIGEST_KIND,
    version: DIGEST_VERSION,
    repo: REPO,
    generated_at: "2026-09-29T12:00:00.000Z",
    window: { since: "2026-03-29T12:00:00.000Z", until: "2026-09-29T12:00:00.000Z", months: 6 },
    human: { prs_enumerated: 0, prs_scanned: 0, prs_missing: 0, truncated: false, comments: [] },
    rounds: [],
    feedback: [],
    problems: [],
    ...over,
  };
}

function runner(
  stdout: string,
  ok = true,
  stderr = "",
): SshRunner & { calls: Array<{ host: string; argv: string[]; timeoutMs?: number }> } {
  const calls: Array<{ host: string; argv: string[]; timeoutMs?: number }> = [];
  const r = (async (host: string, argv: string[], opts?: { timeoutMs?: number }) => {
    calls.push({
      host,
      argv,
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return { ok, stdout, stderr, code: ok ? 0 : 1 };
  }) as SshRunner & { calls: typeof calls };
  r.calls = calls;
  return r;
}

describe("historyDigestArgv", () => {
  it("runs `qcr history digest --json` in the container, read-only", () => {
    expect(historyDigestArgv(tui)).toEqual([
      "sudo",
      "docker",
      "exec",
      "quickreview-sandbox",
      "node",
      "dist/src/cli.js",
      "history",
      "digest",
      "--json",
    ]);
    expect(historyDigestArgv({ ...tui, sudo_docker: false }, 3)).toEqual([
      "docker",
      "exec",
      "quickreview-sandbox",
      "node",
      "dist/src/cli.js",
      "history",
      "digest",
      "--months",
      "3",
      "--json",
    ]);
  });
});

describe("pullReviewHistory", () => {
  it("writes the digest into the state home — 0600, the one file — and names it", async () => {
    const d = digest({
      human: {
        prs_enumerated: 1,
        prs_scanned: 1,
        prs_missing: 0,
        truncated: false,
        comments: [
          {
            pr: 1,
            merged_at: null,
            kind: "review",
            state: "COMMENTED",
            path: null,
            author: "bob",
            body: "hello",
          },
        ],
      },
    });
    const ssh = runner(JSON.stringify(d));
    const r = await pullReviewHistory({ tui, ssh, stateHome: home, repo: REPO, months: 4 });
    expect(r.ok).toBe(true);
    expect(ssh.calls).toEqual([
      { host: "review-vm", argv: historyDigestArgv(tui, 4), timeoutMs: 30 * 60_000 },
    ]);
    const path = join(home, HISTORY_DIGEST_FILE);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(d);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(home, "setup"))).toEqual(["review-history.json"]); // no tmp left behind
  });

  it("an empty history is delivered like any other", async () => {
    const r = await pullReviewHistory({
      tui,
      ssh: runner(JSON.stringify(digest())),
      stateHome: home,
      repo: REPO,
    });
    expect(r.ok).toBe(true);
    expect(existsSync(join(home, HISTORY_DIGEST_FILE))).toBe(true);
  });

  it("writes nothing when the VM fails, prints a non-digest, or describes another repo", async () => {
    const failed = await pullReviewHistory({
      tui,
      ssh: runner("", false, "boom\nError: no credential\n"),
      stateHome: home,
      repo: REPO,
    });
    expect(failed).toEqual({
      ok: false,
      reason: "the VM could not produce the digest: Error: no credential",
    });
    const junk = await pullReviewHistory({
      tui,
      ssh: runner('{"hello":1}'),
      stateHome: home,
      repo: REPO,
    });
    expect(junk.ok).toBe(false);
    const other = await pullReviewHistory({
      tui,
      ssh: runner(JSON.stringify(digest({ repo: "x/y" }))),
      stateHome: home,
      repo: REPO,
    });
    expect(other).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/about x\/y.*nothing written/),
    });
    expect(existsSync(join(home, "setup"))).toBe(false);
  });
});
