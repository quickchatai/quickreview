// On-demand state-machine review (src/staterequest.ts): a maintainer's PR
// label or `@<bot> state-machines` comment, and the operator's
// `qcr review-now <pr> --state-machines`.
//
// It is the security request's machinery under a second kind
// (tests/security-request.test.ts pins that machinery whole). What is pinned
// here is what the second kind adds: its grammar, its own label and switch,
// its own row beside a security one, the reconcile pass and dispatch reading
// it, and the operator's flag.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePrLeverArgs } from "../src/cli.js";
import { executeCommand, validateCommand, type CommandDeps } from "../src/commands.js";
import { parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { PrFileEntry, PrRef } from "../src/github.js";
import { reconcileOnce, type ReconcileAdapter } from "../src/reconcile.js";
import { reviewNow } from "../src/reviewnow.js";
import {
  isSecurityCommand,
  SECURITY_ACK_MARKER,
  SECURITY_REQUEST,
  securityAckBody,
  securityCommandDecision,
  sweepSecurityRequests,
} from "../src/securityrequest.js";
import { StateStore } from "../src/state.js";
import { STATE_ACK_MARKER, STATE_REQUEST, STATE_REQUEST_KIND } from "../src/staterequest.js";
import { applyInterpretation, interpretEvent, type InterpretDeps } from "../src/webhook.js";
import { prLeverPayload, renderPrLever } from "../src/tui/prpause.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import { hasNewEvidence } from "@quickchatai/pi-quickreview/src/guards.js";
import { isOwnContent } from "@quickchatai/pi-quickreview/src/identity.js";
import { SECURITY_FAMILY, STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import type { RoundOrder, SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const BOT = cfg.github.bot_login;
const MENTION = `@${BOT.replace(/\[bot\]$/, "")}`;
const LABEL = cfg.state_machines.label;

const interpretDeps = (over: Partial<InterpretDeps> = {}): InterpretDeps => ({
  botLogin: BOT,
  triggerLabel: cfg.github.trigger_label,
  reviewTeam: cfg.github.review_team,
  botCommentPr: () => undefined,
  securityLabel: cfg.security.label,
  securityCommand: true,
  stateLabel: LABEL,
  stateCommand: true,
  ...over,
});

function commentPayload(body: string, association: string, id = 6001, login = "maya-dev") {
  return {
    action: "created",
    issue: { number: 42, pull_request: {} },
    comment: { id, body, user: { login, type: "User" }, author_association: association },
    sender: { login },
  };
}

function labelPayload(action: "labeled" | "unlabeled", name: string) {
  return {
    action,
    label: { name },
    sender: { login: "maya-dev", type: "User" },
    pull_request: {
      number: 42,
      title: "Order lifecycle",
      user: { login: "dana-op", type: "User" },
      head: { sha: "head42" },
    },
  };
}

function tracked(store: StateStore, pr: number, state = "tracked", head = "head42"): void {
  store.upsertPr({
    number: pr,
    state: state as "tracked",
    head_sha: head,
    title: `PR ${pr}`,
    author: "dana-op",
    trigger_ts: state === "queued" ? "2026-11-01T09:00:00Z" : null,
    stale_recheck: 0,
    migration_gate: 0,
  });
}

describe("the @<bot> state-machines command", () => {
  const is = (body: string): boolean => isSecurityCommand(body, BOT, STATE_REQUEST);

  // MUTATION: change STATE_REQUEST.commandWord to "state" — the bare-word
  // case below is then heard, and this fails.
  it("is the first line; hyphen, space, singular and `review` are the same word", () => {
    expect(is(`${MENTION} state-machines`)).toBe(true);
    expect(is(`${MENTION} state-machine`)).toBe(true);
    expect(is(`${MENTION} State Machines Review`)).toBe(true);
    expect(is(`${MENTION} statemachines\nplease look at the order flow`)).toBe(true);
    expect(is(`${MENTION} state`)).toBe(false);
    expect(is(`${MENTION} state-machines please`)).toBe(false);
    expect(is(`please ${MENTION} state-machines`)).toBe(false);
    expect(is(`${MENTION} security`)).toBe(false);
  });

  it("is not the security command, nor the security command it", () => {
    expect(isSecurityCommand(`${MENTION} state-machines`, BOT)).toBe(false);
    expect(isSecurityCommand(`${MENTION} security`, BOT, SECURITY_REQUEST)).toBe(true);
  });

  it("a collaborator's command and the label are requests for the state-machine review", () => {
    expect(
      interpretEvent(
        "issue_comment",
        "created",
        commentPayload(`${MENTION} state-machines`, "MEMBER"),
        interpretDeps(),
      ),
    ).toEqual({
      kind: "security_requested",
      review: "state-machines",
      pr: 42,
      by: "maya-dev",
      source: "comment",
      comment_id: 6001,
    });
    expect(
      interpretEvent("pull_request", "labeled", labelPayload("labeled", LABEL), interpretDeps()),
    ).toMatchObject({ kind: "security_requested", review: "state-machines", source: "label" });
    expect(
      interpretEvent(
        "pull_request",
        "unlabeled",
        labelPayload("unlabeled", LABEL),
        interpretDeps(),
      ),
    ).toMatchObject({ kind: "security_withdrawn", review: "state-machines" });
  });

  // MUTATION: pass `deps.securityCommand` to the state decision in
  // webhook.ts — the switched-off case is heard and this fails.
  it("anyone else is ignored with a reason, and so is a switched-off command or label", () => {
    const outsider = interpretEvent(
      "issue_comment",
      "created",
      commentPayload(`${MENTION} state-machines`, "CONTRIBUTOR"),
      interpretDeps(),
    );
    expect(outsider).toMatchObject({ kind: "ignored" });
    expect((outsider as { reason: string }).reason).toContain(
      "state-machines command from a non-collaborator",
    );
    const off = interpretEvent(
      "issue_comment",
      "created",
      commentPayload(`${MENTION} state-machines`, "OWNER"),
      interpretDeps({ stateCommand: false }),
    );
    expect((off as { reason: string }).reason).toBe(
      "state-machines command is off ([state_machines] command)",
    );
    expect(
      interpretEvent(
        "pull_request",
        "labeled",
        labelPayload("labeled", LABEL),
        interpretDeps({ stateLabel: "" }),
      ),
    ).toMatchObject({ kind: "ignored" });
    expect(
      securityCommandDecision(
        { body: "hello", author_association: "OWNER" },
        { botLogin: BOT, command: true },
        STATE_REQUEST,
      ),
    ).toBeNull();
  });

  it("the security label still asks for a security review", () => {
    const i = interpretEvent(
      "pull_request",
      "labeled",
      labelPayload("labeled", cfg.security.label),
      interpretDeps(),
    );
    expect(i).toMatchObject({ kind: "security_requested", source: "label" });
    expect((i as { review?: string }).review).toBeUndefined();
  });
});

describe("a state-machine request", () => {
  // MUTATION: drop the kind argument from applySecurityRequest in
  // webhook.ts — the row lands under "security" and this fails.
  it("is its own row: new evidence, the PR queued, one acknowledgement naming the review", async () => {
    const store = new StateStore(":memory:");
    tracked(store, 42);
    store.recordReviewedHead(42, {
      head_sha: "head42",
      verdict: "APPROVE",
      posted_event: "APPROVE",
    });
    const ack = vi.fn();
    const i = interpretEvent(
      "issue_comment",
      "created",
      commentPayload(`${MENTION} state-machines`, "COLLABORATOR"),
      interpretDeps(),
    );
    await applyInterpretation({ cfg, store, onSecurityAck: ack }, i);
    expect(hasNewEvidence(store.reviewedHead(42), "head42")).toBe(true);
    expect(store.getPr(42)?.state).toBe("queued");
    expect(store.reviewRequest(42, STATE_REQUEST_KIND)).toMatchObject({
      source: "comment",
      requested_by: "maya-dev",
      comment_id: 6001,
    });
    expect(store.reviewRequest(42, "security")).toBeUndefined();
    expect(ack).toHaveBeenCalledOnce();
    expect(ack.mock.calls[0]![0]).toMatchObject({ review: "state-machines" });
  });

  it("stands beside a security request on the same PR, each withdrawn by its own label", async () => {
    const store = new StateStore(":memory:");
    tracked(store, 42);
    for (const name of [cfg.security.label, LABEL])
      await applyInterpretation(
        { cfg, store },
        interpretEvent("pull_request", "labeled", labelPayload("labeled", name), interpretDeps()),
      );
    expect(store.reviewRequest(42, "security")?.source).toBe("label");
    expect(store.reviewRequest(42, STATE_REQUEST_KIND)?.source).toBe("label");
    await applyInterpretation(
      { cfg, store },
      interpretEvent(
        "pull_request",
        "unlabeled",
        labelPayload("unlabeled", LABEL),
        interpretDeps(),
      ),
    );
    expect(store.reviewRequest(42, STATE_REQUEST_KIND)).toBeUndefined();
    expect(store.reviewRequest(42, "security")?.source).toBe("label");
  });

  it("the acknowledgement names the review and carries its own marker, read as the reviewer's own", () => {
    const body = securityAckBody("maya-dev", STATE_REQUEST);
    expect(body).toContain("State-machine review requested (asked by @maya-dev).");
    expect(body).toContain(STATE_ACK_MARKER);
    expect(body).not.toContain(SECURITY_ACK_MARKER);
    expect(isOwnContent(cfg.github, BOT, body)).toBe(true);
    // The security acknowledgement is what it was.
    expect(securityAckBody("maya-dev")).toBe(
      `Security review requested (asked by @maya-dev). The next review round of this pull request runs the security lenses.\n\n${SECURITY_ACK_MARKER}`,
    );
  });
});

describe("the reconcile pass", () => {
  const POLLING: Config = { ...cfg, ingress: { ...cfg.ingress, shape: "polling" } };
  const ref = (number: number, labels: string[]): PrRef => ({
    number,
    title: `PR ${number}`,
    author: "dana-op",
    head_sha: `head${number}`,
    base_ref: "main",
    updated_at: "2026-11-01T10:00:00Z",
    state: "open",
    draft: false,
    merged: false,
    labels,
  });
  const run = async (store: StateStore, open: PrRef[]) => {
    const adapter: ReconcileAdapter = {
      searchLabelTriggered: async () => [],
      searchTeamTriggered: async () => [],
      listOpenPrs: async () => open,
      getPr: async (n: number) => open.find((p) => p.number === n)!,
      listBotReviewComments: async () => [],
      listReviewCommentsFull: async () => [],
      listIssueComments: async () => [],
      listReviewsFull: async () => [],
    };
    const hooks = {
      async dispatchRound() {},
      async inject() {},
      async archiveAndClose() {},
    } as SessionHooks;
    await reconcileOnce({ cfg: POLLING, store, adapter, hooks, log: () => {} });
  };

  // MUTATION: sweep only the security kind in reconcile.ts — a polling
  // install never turns the state-machine label into a request; this fails.
  it(
    "a polling install turns each label into its own request, and withdraws it when the label goes",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      tracked(store, 61, "tracked", "head61");
      tracked(store, 62, "tracked", "head62");
      await run(store, [ref(61, [LABEL]), ref(62, [cfg.security.label])]);
      expect(store.reviewRequest(61, STATE_REQUEST_KIND)).toMatchObject({ source: "label" });
      expect(store.reviewRequest(61, "security")).toBeUndefined();
      expect(store.reviewRequest(62, "security")).toMatchObject({ source: "label" });
      expect(store.reviewRequest(62, STATE_REQUEST_KIND)).toBeUndefined();
      await run(store, [ref(61, []), ref(62, [cfg.security.label])]);
      expect(store.reviewRequest(61, STATE_REQUEST_KIND)).toBeUndefined();
      expect(store.reviewRequest(62, "security")).toMatchObject({ source: "label" });
    },
  );

  // One sweep per kind: a sweep for one kind never withdraws the other's
  // label request for want of its own label.
  it("a sweep of one kind leaves the other kind's label request standing", () => {
    const store = new StateStore(":memory:");
    tracked(store, 63, "tracked", "head63");
    store.recordReviewRequest({ pr: 63, kind: "security", source: "label", requested_by: "" });
    const open = new Map([
      [63, { title: "PR 63", head_sha: "head63", author: "dana-op", labels: [cfg.security.label] }],
    ]);
    sweepSecurityRequests(store, {
      open,
      listedAt: new Date(Date.now() + 60_000).toISOString(),
      label: LABEL,
      kind: STATE_REQUEST_KIND,
    });
    expect(store.reviewRequest(63, "security")).toBeDefined();
  });
});

describe("dispatch plans the family from the request", () => {
  const noop = async (): Promise<GateResult> => ({ executed: false, dryRunFile: "x" });
  async function dispatchWith(store: StateStore, labels: string[]): Promise<RoundOrder> {
    const files: PrFileEntry[] = [
      { filename: "app/service.py", additions: 12, deletions: 1, status: "modified" },
    ];
    const adapter: DispatchAdapter = {
      listPrFiles: async () => files,
      getPr: async () => ({ base_ref: "master", labels }),
      addLabel: noop,
      removeLabel: noop,
      deleteTeamReviewRequest: noop,
      createReview: noop,
    };
    const orders: RoundOrder[] = [];
    const hooks: SessionHooks = {
      async dispatchRound(order) {
        orders.push(order);
      },
      async inject() {},
      async archiveAndClose() {},
    };
    await dispatchOnce({ cfg, store, adapter, hooks });
    expect(orders).toHaveLength(1);
    return orders[0]!;
  }
  const rows = (o: RoundOrder, fam: readonly string[]): string[] =>
    o.pass_plan.map((p) => p.lens).filter((l) => fam.includes(l));

  // MUTATION: drop `stateRequest` from planSecurity in dispatch.ts — the
  // family is not planned and this fails.
  it(
    "the label on the PR plans the whole family and no security lens; with the label off a label request plans nothing",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      tracked(store, 51, "queued", "sha51");
      store.recordReviewRequest({
        pr: 51,
        kind: STATE_REQUEST_KIND,
        source: "label",
        requested_by: "maya-dev",
      });
      const labelled = await dispatchWith(store, [LABEL]);
      expect(rows(labelled, STATE_FAMILY).sort()).toEqual([...STATE_FAMILY].sort());
      expect(rows(labelled, SECURITY_FAMILY)).toEqual([]);
      expect(labelled.security_request).toBeUndefined();
      expect(labelled.pass_plan.find((p) => p.lens === "pass-sm-stuck")!.why).toBe(
        "a state-machine review was requested by @maya-dev with a PR label",
      );

      const store2 = new StateStore(":memory:");
      tracked(store2, 51, "queued", "sha51");
      store2.recordReviewRequest({
        pr: 51,
        kind: STATE_REQUEST_KIND,
        source: "label",
        requested_by: "maya-dev",
      });
      const unlabelled = await dispatchWith(store2, []);
      expect(rows(unlabelled, STATE_FAMILY)).toEqual([]);
    },
  );

  it(
    "a comment's request stands without the label, and a security request alone plans no state-machine lens",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      tracked(store, 52, "queued", "sha52");
      store.recordReviewRequest({
        pr: 52,
        kind: STATE_REQUEST_KIND,
        source: "comment",
        requested_by: "lee-ops",
      });
      expect(rows(await dispatchWith(store, []), STATE_FAMILY).length).toBe(STATE_FAMILY.length);

      const store2 = new StateStore(":memory:");
      tracked(store2, 53, "queued", "sha53");
      store2.recordReviewRequest({
        pr: 53,
        kind: "security",
        source: "comment",
        requested_by: "lee-ops",
      });
      expect(rows(await dispatchWith(store2, []), STATE_FAMILY)).toEqual([]);
    },
  );
});

describe("qcr review-now --state-machines", () => {
  it("validates, parses and renders the field, alone and beside --security", () => {
    const op = { issuer: "operator" as const };
    expect(validateCommand({ command: "review-now", pr: 17, state_machines: true }, op)).toEqual({
      ok: true,
      command: { command: "review-now", pr: 17, state_machines: true },
    });
    expect(validateCommand({ command: "review-now", pr: 17, state_machines: false }, op)).toEqual({
      ok: true,
      command: { command: "review-now", pr: 17 },
    });
    expect(validateCommand({ command: "review-now", pr: 17, state_machines: "yes" }, op).ok).toBe(
      false,
    );
    const cmd = parsePrLeverArgs("review-now", ["17", "--state-machines"]);
    expect(cmd).toEqual({ command: "review-now", pr: 17, state_machines: true });
    expect(JSON.parse(prLeverPayload(cmd))).toEqual(cmd);
    expect(() => parsePrLeverArgs("pause-pr", ["17", "--state-machines"])).toThrow(/usage/);
    expect(renderPrLever(cmd, { ok: true, issuer: "operator" }).lines[0]).toContain(
      "a state-machine review",
    );
    const both = parsePrLeverArgs("review-now", ["17", "--security", "--state-machines"]);
    expect(both).toEqual({ command: "review-now", pr: 17, security: true, state_machines: true });
    expect(renderPrLever(both, { ok: true, issuer: "operator" }).lines[0]).toContain(
      "a security and a state-machine review",
    );
  });

  it("the executor hands the flag to the handler", async () => {
    const seen: unknown[] = [];
    const deps = {
      reviewNow: (n: number, file: string, opts: unknown) => (
        seen.push([n, file, opts]),
        { ok: true }
      ),
    } as unknown as CommandDeps;
    await executeCommand({ command: "review-now", pr: 3, state_machines: true }, deps, {
      file: "f1",
      issuer: "operator",
    });
    expect(seen).toEqual([[3, "f1", { stateMachines: true }]]);
  });

  // MUTATION: pass no kind to applySecurityRequest in reviewNow — the row
  // lands under "security" and this fails.
  it("records the operator's request and reviews a PR reviewed at its head again", async () => {
    const store = new StateStore(":memory:");
    tracked(store, 17, "tracked", "abc123");
    store.recordReviewedHead(17, {
      head_sha: "abc123",
      verdict: "APPROVE",
      posted_event: "APPROVE",
    });
    const pump = vi.fn(async () => {});
    const ref: PrRef = {
      number: 17,
      title: "Order lifecycle",
      author: "dana-op",
      head_sha: "abc123",
      base_ref: "main",
      updated_at: "2026-10-24T10:00:00Z",
      state: "open",
      draft: false,
      merged: false,
      labels: [],
    };
    const out = await reviewNow({ store, getPr: async () => ref, pump }, 17, {
      stateMachines: true,
    });
    expect(out).toMatchObject({
      ok: true,
      state: "queued",
      outcome: "state-machine review requested",
    });
    expect(store.reviewRequest(17, STATE_REQUEST_KIND)?.source).toBe("operator");
    expect(store.reviewRequest(17, "security")).toBeUndefined();
    expect(hasNewEvidence(store.reviewedHead(17), "abc123")).toBe(true);
    const again = await reviewNow({ store, getPr: async () => ref, pump }, 17, {
      security: true,
      stateMachines: true,
    });
    expect(again).toMatchObject({ ok: true });
    expect(again.ok && again.outcome).toContain("state-machine review already requested");
    expect(store.reviewRequest(17, "security")?.source).toBe("operator");
  });
});
