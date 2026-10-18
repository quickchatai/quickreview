import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../src/state.js";
import { parseConfig } from "../src/config.js";
import {
  handleDelivery,
  signBody,
  createWebhookServer,
  applyInterpretation,
  resumeWebhookDeliveries,
  type WebhookDeps,
  type Interpretation,
} from "../src/webhook.js";
const cfg = parseConfig(readFileSync(resolve("tests/fixtures/config.toml"), "utf8"));
const servers: ReturnType<typeof createWebhookServer>[] = [];
const stores: StateStore[] = [],
  roots: string[] = [];
afterEach(async () => {
  for (const server of [...servers]) await close(server);
  for (const s of stores.splice(0)) s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});
const store = () => {
  const s = new StateStore(":memory:");
  stores.push(s);
  return s;
};

it("retains colliding bot IDs in separate comment namespaces and routes only the review root", () => {
  const s = store();
  s.registerBotComment(71, 2, "issue_comment");
  s.registerBotComment(71, 4, "review_comment");
  expect(s.db.prepare("SELECT comment_id,kind FROM bot_comments WHERE pr=4").all()).toEqual(
    expect.arrayContaining([expect.objectContaining({ comment_id: 71, kind: "review_comment" })]),
  );
  const raw = Buffer.from(
    JSON.stringify({
      action: "created",
      comment: {
        id: 80,
        in_reply_to_id: 71,
        body: "answer",
        user: { login: "human", type: "User" },
      },
      pull_request: { number: 4, user: { login: "human" }, head: { sha: "a" } },
      sender: { login: "human", type: "User" },
    }),
  );
  const result = handleDelivery(
    { cfg, store: s, secret: "test", onInterpretation: async () => {} },
    { guid: "namespace", event: "pull_request_review_comment", signature: signBody(raw, "test") },
    raw,
  );
  expect(result.interpretation?.kind).toBe("author_reply");
  expect(s.botCommentPr(71)).toBeUndefined();
});

it("migrates legacy bot-comment keys without losing original attribution", () => {
  const root = mkdtempSync(join(tmpdir(), "qcr-webhook-namespaces-"));
  roots.push(root);
  const path = join(root, "state.db");
  const legacy = new Database(path);
  legacy.exec(
    "CREATE TABLE bot_comments(comment_id INTEGER PRIMARY KEY,pr INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'review_comment',posted_at TEXT NOT NULL,round_no INTEGER)",
  );
  legacy.prepare("INSERT INTO bot_comments VALUES (71,4,'review_comment','2020-01-01',3)").run();
  legacy.close();
  const s = new StateStore(path);
  stores.push(s);
  s.registerBotComment(71, 2, "issue_comment");
  const rows = s.db
    .prepare(
      "SELECT pr,kind,posted_at,round_no FROM bot_comments WHERE comment_id=71 ORDER BY kind",
    )
    .all();
  expect(rows).toHaveLength(2);
  expect(rows).toContainEqual({
    pr: 4,
    kind: "review_comment",
    posted_at: "2020-01-01",
    round_no: 3,
  });
});

async function listen(deps: Parameters<typeof createWebhookServer>[0]) {
  const server = createWebhookServer(deps);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback address");
  return { server, url: `http://127.0.0.1:${address.port}/webhook` };
}
async function close(server: ReturnType<typeof createWebhookServer>) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  servers.splice(servers.indexOf(server), 1);
}
function payload(pr = 4242) {
  return {
    action: "labeled",
    label: { name: cfg.github.trigger_label },
    pull_request: { number: pr, title: "Review", head: { sha: "abc" }, user: { login: "human" } },
    sender: { login: "human", type: "User" },
  };
}
const signed = (guid: string, event: string, raw: Buffer) => ({
  guid,
  event,
  signature: signBody(raw, "test"),
});

it("resumes a failed acknowledged callback after server restart without redelivery and transitions once", async () => {
  let clock = new Date("2026-10-18T12:00:00Z");
  const s = new StateStore(":memory:", () => clock);
  stores.push(s);
  let calls = 0;
  const deps = {
    cfg,
    store: s,
    secret: "test",
    now: () => clock.getTime(),
    onInterpretation: async (i: Interpretation, ctx: { guid: string }) => {
      const actionDeps = {
        cfg,
        store: s,
        deliveryGuid: ctx.guid,
        onPrTouched: async () => {
          calls++;
          if (calls === 1) throw new Error("publication failed");
        },
      };
      await applyInterpretation(actionDeps, i);
    },
  };
  const first = await listen(deps);
  const raw = Buffer.from(JSON.stringify(payload()));
  expect(
    (
      await fetch(first.url, {
        method: "POST",
        headers: {
          "x-github-delivery": "callback-restart",
          "x-github-event": "pull_request",
          "x-hub-signature-256": signBody(raw, "test"),
        },
        body: raw,
      })
    ).status,
  ).toBe(200);
  await vi.waitFor(() => expect(calls).toBe(1));
  await close(first.server);
  clock = new Date(clock.getTime() + 60_000);
  await listen(deps);
  await vi.waitFor(() => expect(calls).toBe(2), { timeout: 2000 });
  expect(s.prEvents(4242, ["pr_transition"])).toHaveLength(1);
});

it("recovers accepted raw payload when preparation fails after deduplication", async () => {
  const s = store();
  const raw = Buffer.from(JSON.stringify(payload(4243)));
  let calls = 0;
  const deps = {
    cfg,
    store: s,
    secret: "test",
    onInterpretation: async () => {
      calls++;
    },
  };
  s.db.exec(
    "CREATE TRIGGER fail_prepare BEFORE INSERT ON events WHEN NEW.kind='webhook_event' BEGIN SELECT RAISE(FAIL,'prepare failed'); END",
  );
  expect(() => handleDelivery(deps, signed("prepare-restart", "pull_request", raw), raw)).toThrow(
    "prepare failed",
  );
  s.db.exec("DROP TRIGGER fail_prepare");
  await listen(deps);
  await vi.waitFor(() => expect(calls).toBe(1), { timeout: 2000 });
});

it.each(["missing", "unreadable"])(
  "retains an inline reply with %s root evidence until bot ownership is verified",
  async (mode) => {
    let clock = new Date("2026-10-18T12:00:00Z"),
      available = false,
      replies = 0;
    const s = new StateStore(":memory:", () => clock);
    stores.push(s);
    const raw = Buffer.from(
      JSON.stringify({
        action: "created",
        comment: {
          id: 90,
          in_reply_to_id: 80,
          body: "answer",
          user: { login: "human", type: "User" },
        },
        pull_request: { number: 4, user: { login: "human" }, head: { sha: "a" } },
        sender: { login: "human", type: "User" },
      }),
    );
    const deps = {
      cfg,
      store: s,
      secret: "test",
      now: () => clock.getTime(),
      listReviewCommentsFull: async () => {
        if (!available && mode === "unreadable") throw new Error("unavailable");
        return available ? [{ id: 80, user: cfg.github.bot_login }] : [];
      },
      onInterpretation: async (i: Interpretation) => {
        if (i.kind === "author_reply") replies++;
      },
    };
    handleDelivery(deps, signed("inline-" + mode, "pull_request_review_comment", raw), raw);
    const first = await listen(deps);
    await vi.waitFor(() =>
      expect(s.webhookInbox("inline-" + mode)?.attempted_at).toEqual(expect.any(String)),
    );
    expect(replies).toBe(0);
    await close(first.server);
    available = true;
    clock = new Date(clock.getTime() + 60_000);
    await listen(deps);
    await vi.waitFor(() => expect(replies).toBe(1), { timeout: 2000 });
  },
);

function accepted(s: StateStore, guid: string, value: unknown = payload(), event = "pull_request") {
  const raw = Buffer.from(JSON.stringify(value));
  const deps: WebhookDeps = { cfg, store: s, secret: "test", onInterpretation: async () => {} };
  return { deps, raw, result: handleDelivery(deps, signed(guid, event, raw), raw) };
}

it("completed duplicates and legacy GUIDs without payload never invent replay work", async () => {
  const s = store();
  const f = accepted(s, "completed");
  const callback = vi.fn(async () => {});
  f.deps.onInterpretation = callback;
  await resumeWebhookDeliveries(f.deps);
  expect(callback).toHaveBeenCalledOnce();
  expect(handleDelivery(f.deps, signed("completed", "pull_request", f.raw), f.raw).reason).toBe(
    "duplicate",
  );
  s.recordDelivery("legacy", "pull_request", "labeled");
  expect(handleDelivery(f.deps, signed("legacy", "pull_request", f.raw), f.raw).reason).toBe(
    "duplicate",
  );
  await resumeWebhookDeliveries(f.deps);
  expect(callback).toHaveBeenCalledOnce();
});

it("raw inbox insertion failure rolls back the GUID so a later authentic retry is accepted", () => {
  const s = store();
  const raw = Buffer.from(JSON.stringify(payload()));
  const deps = { cfg, store: s, secret: "test", onInterpretation: async () => {} };
  s.db.exec(
    "CREATE TRIGGER fail_accept BEFORE INSERT ON webhook_inbox BEGIN SELECT RAISE(FAIL,'inbox full'); END",
  );
  expect(() => handleDelivery(deps, signed("accept-fault", "pull_request", raw), raw)).toThrow(
    "inbox full",
  );
  s.db.exec("DROP TRIGGER fail_accept");
  expect(handleDelivery(deps, signed("accept-fault", "pull_request", raw), raw).reason).toBe(
    "trigger",
  );
});

it("pending payload protects its GUID even if the old dedup row was archived", () => {
  const s = store();
  const f = accepted(s, "archived-guid");
  s.db.prepare("DELETE FROM deliveries WHERE guid=?").run("archived-guid");
  expect(handleDelivery(f.deps, signed("archived-guid", "pull_request", f.raw), f.raw).reason).toBe(
    "duplicate",
  );
  expect(s.webhookInbox("archived-guid")).not.toBeUndefined();
});

it("reopens the database and retries callback debt without repeating local lifecycle facts", async () => {
  const root = mkdtempSync(join(tmpdir(), "qcr-webhook-durable-"));
  roots.push(root);
  const path = join(root, "state.db");
  let s = new StateStore(path);
  const f = accepted(s, "disk-restart");
  f.deps.onInterpretation = async (i, ctx) =>
    applyInterpretation(
      {
        cfg,
        store: s,
        deliveryGuid: ctx.guid,
        onPrTouched: async () => {
          throw Error("publication lost");
        },
      },
      i,
    );
  await resumeWebhookDeliveries(f.deps);
  s.close();
  s = new StateStore(path);
  stores.push(s);
  s.db.prepare("UPDATE webhook_inbox SET next_attempt_at=NULL").run();
  const calls = vi.fn(async () => {});
  await resumeWebhookDeliveries({
    ...f.deps,
    store: s,
    onInterpretation: async (i, ctx) =>
      applyInterpretation({ cfg, store: s, deliveryGuid: ctx.guid, onPrTouched: calls }, i),
  });
  expect(calls).toHaveBeenCalledOnce();
  expect(s.prEvents(4242, ["pr_transition"])).toHaveLength(1);
  expect(s.webhookInbox("disk-restart")).toBeUndefined();
});

it("drain preserves already accepted work and the existing incoming-drop contract", async () => {
  const s = store();
  const f = accepted(s, "owed-before-drain");
  const callback = vi.fn(async () => {});
  f.deps.onInterpretation = callback;
  s.engageDrain({ issuer: "operator", expires_at: null });
  await resumeWebhookDeliveries(f.deps);
  expect(callback).not.toHaveBeenCalled();
  expect(handleDelivery(f.deps, signed("during-drain", "pull_request", f.raw), f.raw).reason).toBe(
    "draining",
  );
  expect(s.webhookInbox("during-drain")).toBeUndefined();
  expect(s.webhookInbox("owed-before-drain")).not.toBeUndefined();
  s.liftDrain("operator");
  await resumeWebhookDeliveries(f.deps);
  expect(callback).toHaveBeenCalledOnce();
});

it("checks the configured repository again before replaying accepted payload", async () => {
  const s = store();
  const f = accepted(s, "repo-changed", {
    ...payload(),
    repository: { full_name: cfg.github.repo },
  });
  const callback = vi.fn(async () => {});
  await resumeWebhookDeliveries({
    ...f.deps,
    cfg: { ...cfg, github: { ...cfg.github, repo: "another/repo" } },
    onInterpretation: callback,
  });
  expect(callback).not.toHaveBeenCalled();
  expect(s.webhookInbox("repo-changed")).toBeUndefined();
});

it.each(["human", "foreign-bot", "drain"])(
  "never routes an unknown root after %s evidence",
  async (mode) => {
    const s = store();
    const value = {
      action: "created",
      comment: {
        id: 90,
        in_reply_to_id: 80,
        body: "answer",
        user: { login: "human", type: "User" },
      },
      pull_request: { number: 4, user: { login: "human" }, head: { sha: "a" } },
      sender: { login: "human", type: "User" },
    };
    const f = accepted(s, "root-control", value, "pull_request_review_comment");
    const callback = vi.fn(async () => {});
    await resumeWebhookDeliveries({
      ...f.deps,
      listReviewCommentsFull: async () => {
        if (mode === "drain") s.engageDrain({ issuer: "operator", expires_at: null });
        return [
          {
            id: 80,
            user:
              mode === "human"
                ? "human"
                : mode === "foreign-bot"
                  ? "another[bot]"
                  : cfg.github.bot_login,
          },
        ];
      },
      onInterpretation: callback,
    });
    expect(callback).not.toHaveBeenCalled();
    expect(s.botCommentPr(80, "review_comment")).toBeUndefined();
    if (mode === "drain") expect(s.webhookInbox("root-control")).not.toBeUndefined();
    else expect(s.webhookInbox("root-control")).toBeUndefined();
  },
);

it.each(["issue_comment", "pull_request_review_comment"])(
  "retains the deletion namespace from %s",
  async (event) => {
    const s = store();
    const value = {
      action: "deleted",
      comment: { id: 71, user: { login: cfg.github.bot_login, type: "Bot" } },
      pull_request: { number: 4 },
      issue: { number: 4, pull_request: {} },
      sender: { login: "human", type: "User" },
    };
    const f = accepted(s, "deletion", value, event);
    const signal = vi.fn(async () => {});
    await resumeWebhookDeliveries({
      ...f.deps,
      onInterpretation: async (i, ctx) =>
        applyInterpretation({ cfg, store: s, deliveryGuid: ctx.guid, onFeedbackSignal: signal }, i),
    });
    expect(signal).toHaveBeenCalledWith({
      kind: "bot_comment_deleted",
      pr: 4,
      comment_id: 71,
      scope: event === "issue_comment" ? "issue_comment" : "review_comment",
    });
  },
);

it("capture-only persistence failure cannot divert an otherwise usable inline reply", async () => {
  const s = store();
  s.upsertPr({
    number: 4,
    state: "tracked",
    head_sha: "a",
    title: "Review",
    author: "human",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  s.registerBotComment(80, 4, "review_comment");
  s.db.exec(
    "CREATE TRIGGER fail_capture BEFORE INSERT ON pr_comments BEGIN SELECT RAISE(FAIL,'capture unavailable'); END",
  );
  const value = {
    action: "created",
    comment: {
      id: 90,
      in_reply_to_id: 80,
      body: "answer",
      created_at: "2026-10-18T12:00:00Z",
      user: { login: "human", type: "User" },
    },
    pull_request: { number: 4, user: { login: "human" }, head: { sha: "a" } },
    sender: { login: "human", type: "User" },
  };
  const f = accepted(s, "capture-fault", value, "pull_request_review_comment");
  expect(f.result.interpretation?.kind).toBe("author_reply");
  const replies = vi.fn(async () => {});
  const deps = {
    ...f.deps,
    onInterpretation: async (i: Interpretation, ctx: { guid: string }) =>
      applyInterpretation({ cfg, store: s, deliveryGuid: ctx.guid, onAuthorReply: replies }, i),
  };
  await resumeWebhookDeliveries(deps);
  await resumeWebhookDeliveries(deps);
  expect(replies).toHaveBeenCalledOnce();
  expect(s.webhookInbox("capture-fault")).toBeUndefined();
  expect(
    s.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='comment_capture_failed'").get(),
  ).toEqual({ n: 1 });
});
