// "Review this PR now" — the operator's `review-now` command.
//
//   (1) it is an OPERATOR command: a session's file cannot spell it, the
//       executor's belt refuses any other issuer, and Slack never authorizes it;
//   (2) the handler queues ONE PR as a human-asked round — the trigger a fresh
//       label produces — with no GitHub write, after reading the PR (closed,
//       merged and paused PRs are refused with their reason);
//   (3) on the own-account route the person's own PRs are reviewed (the "bot"
//       is the person); on the App route the App's own PRs never are;
//   (4) wire.ts connects it, and the host CLI parses it onto the sealed channel.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePrLeverArgs } from "../src/cli.js";
import {
  COMMAND_WHITELIST,
  OPERATOR_COMMANDS,
  authorizeCommand,
  executeCommand,
  validateCommand,
  type CommandDeps,
} from "../src/commands.js";
import type { PrRef } from "../src/github.js";
import { reviewNow } from "../src/reviewnow.js";
import { StateStore } from "../src/state.js";
import { prLeverPayload, renderPrLever } from "../src/tui/prpause.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pr(over: Partial<PrRef> = {}): PrRef {
  return {
    number: 17,
    title: "Add the tenant filter",
    author: "dana-op",
    head_sha: "abc123",
    base_ref: "main",
    updated_at: "2026-10-24T10:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels: [],
    ...over,
  };
}

describe("review-now is the operator's alone", () => {
  it("is an operator command, never in a session's vocabulary", () => {
    expect(OPERATOR_COMMANDS).toContain("review-now");
    expect(COMMAND_WHITELIST as readonly string[]).not.toContain("review-now");
    for (const v of [
      validateCommand({ command: "review-now", pr: 17 }),
      validateCommand({ command: "review-now", pr: 17 }, { issuer: "session" }),
    ]) {
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason).toMatch(/OPERATOR's alone/);
    }
    expect(validateCommand({ command: "review-now", pr: 17 }, { issuer: "operator" })).toEqual({
      ok: true,
      command: { command: "review-now", pr: 17 },
    });
  });

  it("has a strict schema", () => {
    const op = { issuer: "operator" as const };
    expect(validateCommand({ command: "review-now", pr: 17, label: "x" }, op)).toEqual({
      ok: false,
      reason: "unknown field(s): label",
    });
    for (const n of [0, -1, 1.5, "17", null, undefined])
      expect(validateCommand({ command: "review-now", pr: n }, op).ok, String(n)).toBe(false);
  });

  it("the executor's belt refuses any issuer but the operator; Slack never authorizes it", async () => {
    const seen: unknown[] = [];
    const deps = {
      reviewNow: (n: number, file: string) => (seen.push([n, file]), { ok: true }),
    } as unknown as CommandDeps;
    expect((await executeCommand({ command: "review-now", pr: 3 }, deps)).ok).toBe(false);
    expect(seen).toEqual([]);
    expect(
      await executeCommand({ command: "review-now", pr: 3 }, deps, {
        file: "f1",
        issuer: "operator",
      }),
    ).toEqual({ ok: true });
    expect(seen).toEqual([[3, "f1"]]);
    expect(
      await executeCommand({ command: "review-now", pr: 3 }, {} as CommandDeps, {
        file: "f",
        issuer: "operator",
      }),
    ).toEqual({ ok: false, reason: "review-now is not wired on this daemon" });
    expect(authorizeCommand({ command: "review-now", pr: 3 }, null)).toMatchObject({ ok: false });
  });
});

describe("the handler queues one human-asked round", () => {
  it("adopts an untracked open PR straight into queued, as the person's ask, and pumps", async () => {
    const store = new StateStore(":memory:");
    let pumped = 0;
    const out = await reviewNow(
      {
        store,
        getPr: async () => pr(),
        pump: async () => void (pumped += 1),
        botLogin: "acme-reviewer[bot]",
      },
      17,
    );
    expect(out).toMatchObject({ ok: true, pr: 17, state: "queued", head_sha: "abc123" });
    const row = store.getPr(17)!;
    expect(row.state).toBe("queued");
    expect(row.trigger_provenance).toBe("human");
    expect(row.head_sha).toBe("abc123");
    expect(pumped).toBe(1);
  });

  it("refuses a merged, closed or paused PR with its reason, and queues nothing", async () => {
    const store = new StateStore(":memory:");
    const pump = async (): Promise<void> => undefined;
    expect(
      await reviewNow(
        { store, getPr: async () => pr({ merged: true, state: "closed" }), pump },
        17,
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/merged/),
    });
    expect(
      await reviewNow({ store, getPr: async () => pr({ state: "closed" }), pump }, 17),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/closed/),
    });
    expect(store.getPr(17)).toBeUndefined();
    expect(
      await reviewNow(
        {
          store,
          getPr: async () => {
            throw new Error("HTTP 404");
          },
          pump,
        },
        99,
      ),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/could not read PR #99/) });
  });

  it("the App's own PRs are never reviewed; on the own-account route the person's are", async () => {
    const store = new StateStore(":memory:");
    const pump = async (): Promise<void> => undefined;
    const app = await reviewNow(
      {
        store,
        getPr: async () => pr({ author: "acme-reviewer[bot]" }),
        pump,
        botLogin: "acme-reviewer[bot]",
      },
      17,
    );
    expect(app).toMatchObject({ ok: false, reason: expect.stringMatching(/bot itself/) });
    // Own-account route: wire.ts passes no botLogin, so the person's own PR queues.
    const mine = await reviewNow({ store, getPr: async () => pr({ author: "dana-op" }), pump }, 18);
    expect(mine).toMatchObject({ ok: true, state: "queued" });
  });

  it("wire.ts connects it, reading the PR and passing no bot login on the own-account route", () => {
    const wire = readFileSync(join(repoRoot, "src", "wire.ts"), "utf8");
    const at = wire.indexOf("reviewNow(pr) {");
    expect(at).toBeGreaterThan(0);
    const body = wire.slice(at, at + 700);
    expect(body).toMatch(/getPr: \(n\) => adapter\.getPr\(n\)/);
    expect(body).toMatch(/isPersonMode\(cfg\.github\) \? \{\} : \{ botLogin: cfg\.github\.bot_login \}/);
  });
});

describe("the host CLI", () => {
  it("parses `qcr review-now <pr>` onto the sealed channel's payload", () => {
    const cmd = parsePrLeverArgs("review-now", ["17"]);
    expect(cmd).toEqual({ command: "review-now", pr: 17 });
    expect(JSON.parse(prLeverPayload(cmd))).toEqual({ command: "review-now", pr: 17 });
    expect(() => parsePrLeverArgs("review-now", ["--reason", "x", "17"])).toThrow(/usage/);
    expect(renderPrLever(cmd, { ok: true, issuer: "operator" })).toMatchObject({ code: 0 });
    expect(renderPrLever(cmd, { ok: false, reason: "PR #17 is closed" }).lines[0]).toContain(
      "PR #17 is closed",
    );
  });
});
