import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { parseConfig } from "../src/config.js";
import { StateStore } from "../src/state.js";
import * as recheck from "../src/recheck.js";
import * as webhook from "../src/webhook.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg = parseConfig(readFileSync("tests/fixtures/config.toml", "utf8"));
afterEach(() => vi.restoreAllMocks());

async function fixture(onFeedback = async (_e: unknown) => {}) {
  const root = mkdtempSync(join(tmpdir(), "qcr-webhook-wire-"));
  const store = new StateStore(":memory:");
  let captured: webhook.WebhookDeps | undefined;
  vi.spyOn(webhook, "createWebhookServer").mockImplementation((deps) => {
    captured = deps;
    return {
      listen: (_port: number, _host: string, cb: () => void) => cb(),
      close: (cb: () => void) => cb(),
    } as unknown as ReturnType<typeof webhook.createWebhookServer>;
  });
  const adapter = {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => [],
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    listReviewCommentsFull: vi.fn(async () => [{ id: 80, user: cfg.github.bot_login }]),
  } as unknown as DaemonAdapter;
  const daemon = createDaemon({
    cfg,
    root,
    store,
    adapter,
    webhookSecret: "test",
    onFeedback,
    log: () => {},
  });
  await daemon.start();
  return {
    store,
    deps: captured!,
    adapter,
    close: async () => {
      await daemon.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it(
  "the polling shape boots with no webhook_secret on disk and hands the server none (auth = user needs no App secret)",
  { timeout: HEAVY_TIMEOUT_MS },
  async () => {
    // MUTATION: make readWebhookSecret read the file regardless of the shape —
    // the boot then throws ENOENT on the empty secrets dir, and this fails.
    const root = mkdtempSync(join(tmpdir(), "qcr-webhook-poll-"));
    const store = new StateStore(":memory:");
    let captured: webhook.WebhookDeps | undefined;
    vi.spyOn(webhook, "createWebhookServer").mockImplementation((deps) => {
      captured = deps;
      return {
        listen: (_port: number, _host: string, cb: () => void) => cb(),
        close: (cb: () => void) => cb(),
      } as unknown as ReturnType<typeof webhook.createWebhookServer>;
    });
    const person = {
      ...cfg,
      github: {
        ...cfg.github,
        auth: "user" as const,
        app_slug: "",
        secrets_dir: join(root, "no-secrets"),
      },
      ingress: { ...cfg.ingress, shape: "polling" as const },
    };
    const daemon = createDaemon({
      cfg: person,
      root,
      store,
      adapter: {
        searchLabelTriggered: async () => [],
        searchTeamTriggered: async () => [],
        searchAwaitingEscalationReviewer: async () => [],
        listOpenPrs: async () => [],
        stalenessScan: async () => [],
        listBotReviewComments: async () => [],
      } as unknown as DaemonAdapter,
      log: () => {},
    });
    try {
      await daemon.start();
      expect(captured?.secret).toBe("");
    } finally {
      await daemon.stop();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it(
  "production ingress forwards the GUID so lifecycle publication runs once across callback retries",
  { timeout: HEAVY_TIMEOUT_MS },
  async () => {
    const f = await fixture();
    try {
      f.store.acceptWebhookDelivery("wire-guid", "pull_request", "labeled", "{}");
      const i: webhook.Interpretation = {
        kind: "trigger",
        pr: 4242,
        source: "label",
        meta: { number: 4242, title: "Review", author: "human", head_sha: "abc" },
      };
      const ctx = { guid: "wire-guid", event: "pull_request", action: "labeled" };
      await f.deps.onInterpretation(i, ctx);
      await f.deps.onInterpretation(i, ctx);
      expect(f.store.prEvents(4242, ["pr_transition"])).toHaveLength(1);
      expect(await f.deps.listReviewCommentsFull?.(4242)).toEqual([
        { id: 80, user: cfg.github.bot_login },
      ]);
    } finally {
      await f.close();
    }
  },
);

it(
  "production ingress rejects pre-ledger feedback failure so the durable inbox remains owed",
  { timeout: HEAVY_TIMEOUT_MS },
  async () => {
    const f = await fixture(async () => {
      throw new Error("ledger unavailable");
    });
    try {
      await expect(
        f.deps.onInterpretation(
          { kind: "bot_comment_deleted", pr: 4242, comment_id: 80, scope: "issue_comment" },
          { guid: "feedback-guid", event: "issue_comment", action: "deleted" },
        ),
      ).rejects.toThrow("ledger unavailable");
    } finally {
      await f.close();
    }
  },
);

it.each(["push", "ci", "base_advance"] as const)(
  "does not acknowledge %s recheck failure before durable handoff",
  { timeout: HEAVY_TIMEOUT_MS },
  async (trigger) => {
    const f = await fixture();
    try {
      f.store.upsertPr({
        number: 4242,
        state: "tracked",
        head_sha: "abc",
        title: "Review",
        author: "human",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      f.store.acceptWebhookDelivery("handoff", "test", null, "{}");
      const outcome: recheck.RecheckOutcome = {
        action: "noop",
        reason: "delivery-failed",
        class: "empty",
      };
      vi.spyOn(recheck, "runRecheck").mockResolvedValue(outcome);
      vi.spyOn(recheck, "runBaseAdvance").mockResolvedValue(new Map([[4242, outcome]]));
      const i: webhook.Interpretation =
        trigger === "push"
          ? {
              kind: "synchronize",
              pr: 4242,
              meta: { number: 4242, title: "Review", author: "human", head_sha: "abc" },
            }
          : trigger === "ci"
            ? {
                kind: "ci_completed",
                pr: 4242,
                prs: [4242],
                head_sha: "abc",
                conclusion: "failure",
              }
            : { kind: "base_advanced", branch: "main", before: "old", after: "new" };
      const ctx = { guid: "handoff", event: "test", action: null };
      await expect(f.deps.onInterpretation(i, ctx)).rejects.toThrow(
        "before durable question handoff",
      );
      if (trigger !== "push") {
        const fingerprint = recheck.recheckFingerprint({
          trigger,
          head_sha: "abc",
          ci: trigger === "ci" ? { conclusion: "failure" } : undefined,
          base: trigger === "base_advance" ? { after: "new" } : undefined,
        });
        f.store.claimRecheck(4242, fingerprint, {
          head_sha: "abc",
          trigger,
          delivery: { payload: "durable question", reason: "owed" },
        });
        await expect(f.deps.onInterpretation(i, ctx)).resolves.toBeUndefined();
      }
    } finally {
      await f.close();
    }
  },
);
