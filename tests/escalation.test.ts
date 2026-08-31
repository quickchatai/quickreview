// the optional, off-by-default escalation feature.
//
// The ticket named two invariants and asked for both to be STRUCTURAL and
// pinned. This file is organised around them, and the first two describes are
// the ones to read if you only read two:
//
//   INVARIANT 1 — escalation can never withhold, defer or replace a verdict.
//   INVARIANT 2 — it escalates a QUESTION, never a review.
//
// Every assertion below was mutation-verified: the fix was reverted, the test
// watched to fail, and then restored.
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUARDS_DEFAULTS, parseConfig, parseEscalation, type Config, type EscalationConfig } from "../src/config.js";
import {
  ESCALATION_TAG,
  asksForWholeReview,
  deliverEscalations,
  evaluateEscalationRules,
  normalizeScope,
  normalizeSessionEscalations,
  pathMatches,
  promptTargetsFor,
  renderEscalationComment,
  renderEscalationPromptNote,
  renderScope,
  ruleFires,
  scopeKey,
  severityAtLeast,
  validateEscalationRequest,
  type EscalationFacts,
  type EscalationRequest,
} from "../src/escalation.js";
import { MutationGate, type MutationIntent } from "../src/gate.js";
import { makePostingGuard, type GuardAdapter } from "../src/guards.js";
import { buildRoundOrder } from "../src/dispatch.js";
import { StateStore } from "../src/state.js";
import { renderRoundPrompt, roundVars } from "../src/templates.js";
import type { GateResult } from "../src/gate.js";
import type { SessionHooks, VerdictFile } from "../src/types.js";
import { AnomalyWakePolicy } from "../src/anomalies.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";

const repoRoot = resolve(process.cwd());
const cfg: Config = parseConfig(readFileSync(join(repoRoot, "tests/fixtures/config.toml"), "utf8"));
const HEAD = "68b8040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/** A switched-ON escalation config, built through the real parser so every
 * test exercises the same validation a real config.toml would. */
function on(over: Record<string, unknown> = {}): EscalationConfig {
  return parseEscalation({
    enabled: true,
    targets: ["teammate-one", "teammate-two"],
    rules: [{ name: "migrations", to: "teammate-one", why: "you own the migration policy", paths: ["**/migrations/*.py"] }],
    ...over,
  });
}

const OFF = parseEscalation({});

function facts(over: Partial<EscalationFacts> = {}): EscalationFacts {
  return { changed_paths: [], labels: [], findings: [], failing_checks: [], ...over };
}

const SCOPE = { kind: "code" as const, path: "billing/charge.py", start_line: 12, end_line: 30 };

function request(over: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    target: "teammate-one",
    scope: SCOPE,
    question: "Does the retry here double-charge when the webhook replays?",
    why: "you own billing",
    origin: "session",
    ...over,
  };
}

/** The write half, recorded. */
function fakeAdapter(over: { blocked?: string; throws?: boolean } = {}) {
  const reviews: Array<{ pr: number; payload: unknown; purpose?: string }> = [];
  const requests: Array<{ pr: number; logins: string[] }> = [];
  const order: string[] = [];
  return {
    reviews,
    requests,
    order,
    async createReview(pr: number, payload: { commit_id: string; event: "COMMENT"; body: string }, options?: { purpose?: string }): Promise<GateResult> {
      if (over.throws) throw new Error("POST /reviews → 502");
      order.push("comment");
      reviews.push({ pr, payload, ...(options?.purpose ? { purpose: options.purpose } : {}) });
      return over.blocked ? { executed: false, blocked: over.blocked } : { executed: true };
    },
    async requestEscalationReview(pr: number, logins: string[]): Promise<GateResult> {
      order.push("request");
      requests.push({ pr, logins });
      return { executed: true };
    },
  };
}

let store: StateStore;
beforeEach(() => {
  store = new StateStore(":memory:");
});
afterEach(() => {
  store.close();
});

// ===========================================================================
// INVARIANT 1 — escalation can never withhold, defer or replace a verdict
// ===========================================================================

describe("INVARIANT 1 — the reviewer still decides; escalation rides beside the verdict", () => {
  it("STRUCTURAL: src/escalation.ts cannot express a verdict at all", () => {
    // The strongest form available in TypeScript: the module does not import
    // the vocabulary. `Verdict` lives in src/types.ts, and escalation.ts
    // imports neither the type nor the module — so no function here can
    // accept, return, or construct one, and adding such a signature is a
    // compile-visible change to this fence rather than a quiet edit.
    const src = readFileSync(join(repoRoot, "src/escalation.ts"), "utf8");
    const imports = [...src.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports).not.toContain("./types.js");
    // …and no exported signature mentions a Verdict type either (the verdict
    // the note QUOTES is a plain string carried in for rendering).
    const exported = [...src.matchAll(/^export (?:async )?function ([A-Za-z]+)\(([\s\S]*?)\)(?::\s*([^{]+))?\s*\{/gm)];
    expect(exported.length).toBeGreaterThan(8);
    for (const [, name, params, ret] of exported) {
      expect(`${params ?? ""} ${ret ?? ""}`, `escalation.ts ${name} must not traffic in verdicts`).not.toMatch(/\bVerdict\b/);
    }
  });

  it("STRUCTURAL: the delivery result carries no verdict channel", async () => {
    const adapter = fakeAdapter();
    const outcomes = await deliverEscalations(
      { cfg: on(), store, adapter },
      { pr: 7, verdict: "APPROVE", head_sha: HEAD, round_no: 1, candidates: [request({ origin: "rule", rule: "migrations" })] },
    );
    expect(outcomes).toHaveLength(1);
    // Every key on the outcome, enumerated: nothing here could be read as
    // "hold the review", "change the verdict" or "wait for a human".
    expect(Object.keys(outcomes[0]!).sort()).toEqual(["comment_executed", "origin", "refused", "scope_key", "target"]);
  });

  it("BEHAVIOURAL: the verdict a round lands is IDENTICAL with escalation on and off", async () => {
    // Same round, same verdict file, same everything — driven twice through
    // the real VerdictWatcher, once with the feature off and once with it on
    // and actually firing. If escalation could touch the verdict, these two
    // snapshots would diverge.
    const snapshots: Array<Record<string, unknown>> = [];
    for (const escalation of [OFF, on({ targets: ["teammate-one"], rules: [{ name: "all", to: "teammate-one", why: "w", paths: ["**"] }] })]) {
      const s = new StateStore(":memory:");
      const dir = mkdtempSync(join(tmpdir(), "qcr-esc-verdict-"));
      const labelCalls: string[] = [];
      const adapter: VerdictAdapter = {
        async addLabel(n, l) { labelCalls.push(`add:${n}:${l}`); return { executed: true }; },
        async removeLabel(n, l) { labelCalls.push(`rm:${n}:${l}`); return { executed: true }; },
        async listPrFiles() { return [{ filename: "billing/charge.py" }]; },
        async getPr() { return { labels: [] }; },
        async createReview() { return { executed: true }; },
        async requestEscalationReview() { return { executed: true }; },
      };
      const hooks: SessionHooks = {
        async dispatchRound() {}, async inject() {}, async injectOverseer() {}, async archiveAndClose() {},
      };
      s.setAnomalySink((sig) => new AnomalyWakePolicy({ injectOverseer: (m) => hooks.injectOverseer(m) }).onAnomaly(sig));
      s.upsertPr({ number: 42, state: "reviewing", head_sha: HEAD, title: "T", author: "alice", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
      s.startRound(42, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
      const v: VerdictFile = { pr: 42, round_no: 1, verdict: "REQUEST_CHANGES", head_sha: HEAD, finished_at: "2026-08-31T12:00:00Z" };
      writeFileSync(join(dir, "pr-42-round-1.json"), JSON.stringify(v));
      const w = new VerdictWatcher({
        cfg: { ...cfg, escalation },
        store: s, adapter, hooks, verdictDir: dir, root: dir,
        usage: { globalStoreDir: null }, parseRetries: 0, retryDelayMs: 1, ledgerCheckDelayMs: 0,
      });
      await w.sweep();
      const row = s.getPr(42)!;
      snapshots.push({
        state: row.state,
        verdict: row.last_verdict ?? null,
        head: row.head_sha,
        round: s.roundsFor(42).map((r) => `${r.round_no}:${r.status}:${r.verdict ?? ""}`),
        // Timestamps are wall-clock, so only the SHAPE and content are
        // compared — everything else about the mark must be identical.
        reviewedHead: JSON.stringify(s.reviewedHead(42) ?? null).replace(/"reviewed_at":"[^"]*"/, '"reviewed_at":"<ts>"'),
        labels: labelCalls,
      });
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  it("BEHAVIOURAL: a delivery that THROWS still leaves the verdict applied", async () => {
    const s = new StateStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "qcr-esc-throw-"));
    const adapter: VerdictAdapter = {
      async addLabel() { return { executed: true }; },
      async removeLabel() { return { executed: true }; },
      async listPrFiles() { return [{ filename: "a.py" }]; },
      async getPr() { return { labels: [] }; },
      async createReview() { throw new Error("POST /reviews → 502"); },
    };
    const hooks: SessionHooks = { async dispatchRound() {}, async inject() {}, async injectOverseer() {}, async archiveAndClose() {} };
    s.setAnomalySink(() => {});
    s.upsertPr({ number: 43, state: "reviewing", head_sha: HEAD, title: "T", author: "a", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
    s.startRound(43, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    writeFileSync(
      join(dir, "pr-43-round-1.json"),
      JSON.stringify({ pr: 43, round_no: 1, verdict: "APPROVE", head_sha: HEAD, finished_at: "2026-08-31T12:00:00Z" }),
    );
    const w = new VerdictWatcher({
      cfg: { ...cfg, escalation: on({ targets: ["teammate-one"], rules: [{ name: "all", to: "teammate-one", why: "w", paths: ["**"] }] }) },
      store: s, adapter, hooks, verdictDir: dir, root: dir,
      usage: { globalStoreDir: null }, parseRetries: 0, retryDelayMs: 1, ledgerCheckDelayMs: 0,
    });
    const handled = await w.sweep();
    expect(s.roundsFor(43)[0]!.verdict).toBe("APPROVE");
    // …and the ROUND COMPLETED, not just "the verdict row was written before
    // the throw". An unwrapped delivery throw aborts apply()'s tail, so the
    // file is never consumed and never archived — which is what these two
    // assertions catch and the verdict row alone does not.
    expect(handled).toContain("pr-43-round-1.json");
    expect(existsSync(join(dir, "pr-43-round-1.json"))).toBe(false);
    expect(s.getPr(43)!.state).toBe("tracked");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a malformed escalations array never rejects the verdict it rides on", () => {
    for (const bad of ["nonsense", 7, { target: "x" }, [1, 2, 3]]) {
      const parsed = normalizeSessionEscalations(bad);
      expect(parsed.entries.every((e) => typeof e === "object")).toBe(true);
    }
    expect(normalizeSessionEscalations(undefined).entries).toEqual([]);
    expect(normalizeSessionEscalations("nope").note).toMatch(/not an array/);
  });
});

// ===========================================================================
// INVARIANT 2 — escalate a question, never a review
// ===========================================================================

describe("INVARIANT 2 — a specific thing, never 'review this PR'", () => {
  it("refuses an escalation that names nothing to look at", () => {
    const c = on();
    for (const scope of [undefined, null, {}, { kind: "code" }, { kind: "code", path: "" }, { kind: "decision" }, { kind: "decision", decision: "  " }, { kind: "migration", path: "" }]) {
      const v = validateEscalationRequest({ target: "teammate-one", scope, question: "look at this bit", origin: "rule" }, c);
      expect(v.ok, `scope ${JSON.stringify(scope)} must be refused`).toBe(false);
      if (!v.ok) expect(v.refusal).toBe("no-scope");
    }
  });

  it("there is no way to SPELL a whole-PR scope — the union has no such member", () => {
    // `{kind: "pr"}` and friends fall through to the code branch, which needs
    // a path; with none, the scope is null and the escalation is refused.
    expect(normalizeScope({ kind: "pr" })).toBeNull();
    expect(normalizeScope({ kind: "pull_request", pr: 42 })).toBeNull();
    expect(normalizeScope({ kind: "whole_pr", path: "" })).toBeNull();
    // …and every scope that IS expressible renders as something concrete.
    for (const raw of [{ path: "a/b.py" }, { kind: "code", path: "a/b.py", start_line: "3", end_line: "9" }, { kind: "migration", path: "m/0042.py", migration: "0042" }, { kind: "decision", decision: "the retry budget" }]) {
      const scope = normalizeScope(raw)!;
      expect(scope).not.toBeNull();
      expect(renderScope(scope).trim().length).toBeGreaterThan(3);
      expect(scopeKey(scope)).toMatch(/^(code|migration|decision):/);
    }
  });

  it("refuses a question that asks for a review of the change", () => {
    const c = on();
    for (const q of [
      "Please review this PR.",
      "Can you review the pull request when you get a chance?",
      "Take a full review pass over this.",
      "Could you look over the whole diff?",
      "Sign off on this MR?",
      "Please review it.",
    ]) {
      expect(asksForWholeReview(q), q).toBe(true);
      const v = validateEscalationRequest({ ...request(), question: q, origin: "rule" }, c);
      expect(v.ok, q).toBe(false);
      if (!v.ok) expect(v.refusal).toBe("asks-for-whole-review");
    }
  });

  it("lets a genuinely narrow question through", () => {
    for (const q of [
      "Does the retry here double-charge when the webhook replays?",
      "Is index 0042 safe to build without CONCURRENTLY on this table size?",
      "We reviewed the code and think this decision is yours: keep the flag or drop it?",
    ]) {
      expect(asksForWholeReview(q), q).toBe(false);
      expect(validateEscalationRequest({ ...request(), question: q }, on({ session_judgement: true })).ok).toBe(true);
    }
  });

  it("the rendered note names the thing, the person and the reason, and disowns the whole-PR ask", () => {
    const body = renderEscalationComment(request({ origin: "rule", rule: "billing" }), { verdict: "REQUEST_CHANGES", round_no: 3 });
    expect(body.startsWith(ESCALATION_TAG)).toBe(true);
    expect(body).toContain("@teammate-one");
    expect(body).toContain("not a review of this pull request");
    expect(body).toContain("billing/charge.py");
    expect(body).toContain("lines 12–30");
    expect(body).toContain("you own billing");
    expect(body).toContain("double-charge");
    // The verdict is stated as DONE — the recipient must not think the review
    // is waiting on them.
    expect(body).toContain("already decided and posted");
    expect(body).toContain("REQUEST_CHANGES");
    expect(body).toContain("`billing`");
  });

  it("the review-request shape says out loud what GitHub's queue entry does NOT mean", () => {
    const body = renderEscalationComment(request(), { verdict: "APPROVE", review_requested: true });
    expect(body).toContain("review-requested queue");
    expect(body).toContain("It is not what is being asked");
  });

  it("a fired rule always produces a concrete scope, whatever it keyed on", () => {
    const cases: Array<[Record<string, unknown>, EscalationFacts]> = [
      [{ paths: ["**/migrations/*.py"] }, facts({ changed_paths: ["app/migrations/0042_x.py"] })],
      [{ labels: ["needs-security"] }, facts({ labels: ["needs-security"] })],
      [{ failing_checks: ["e2e"] }, facts({ failing_checks: ["e2e"] })],
      [{ min_severity: "P1" }, facts({ findings: [{ severity: "P0", path: "a/b.py" }] })],
    ];
    for (const [cond, f] of cases) {
      const c = on({ rules: [{ name: "r", to: "teammate-one", why: "why you", ...cond }] });
      const out = evaluateEscalationRules(c, f);
      expect(out, JSON.stringify(cond)).toHaveLength(1);
      expect(renderScope(out[0]!.scope).length).toBeGreaterThan(3);
      expect(asksForWholeReview(out[0]!.question)).toBe(false);
    }
  });

  it("a rule whose matched fact yields nothing concrete escalates NOTHING", () => {
    // A severity rule that fires on a finding with neither a path nor a
    // reason has nothing to point at — and silence beats a whole-PR ask.
    const c = on({ rules: [{ name: "sev", to: "teammate-one", why: "w", min_severity: "P1" }] });
    expect(evaluateEscalationRules(c, facts({ findings: [{ severity: "P0" }] }))).toEqual([]);
  });
});

// ===========================================================================
// Off by default
// ===========================================================================

describe("off by default — a stock install is unchanged", () => {
  it("the shipped example config has escalation off, with no targets and no rules", () => {
    const example = parseConfig(readFileSync(join(repoRoot, "config.example.toml"), "utf8"));
    expect(example.escalation.enabled).toBe(false);
    expect(example.escalation.targets).toEqual([]);
    expect(example.escalation.rules).toEqual([]);
    // …and a config with no [escalation] table at all is the same thing.
    expect(parseEscalation({}).enabled).toBe(false);
  });

  it("nothing evaluates, nothing renders and nothing is delivered when off", async () => {
    expect(evaluateEscalationRules(OFF, facts({ changed_paths: ["app/migrations/0042.py"] }))).toEqual([]);
    // Even a config with rules and targets written down: `enabled = false`
    // makes the whole table a draft.
    const draft = parseEscalation({ enabled: false, targets: ["teammate-one"], rules: [{ name: "r", to: "teammate-one", why: "w", paths: ["**"] }] });
    expect(evaluateEscalationRules(draft, facts({ changed_paths: ["a.py"] }))).toEqual([]);
    expect(promptTargetsFor(draft)).toBeUndefined();
    expect(renderEscalationPromptNote(promptTargetsFor(draft))).toBe("");
    const adapter = fakeAdapter();
    expect(await deliverEscalations({ cfg: draft, store, adapter }, { pr: 1, verdict: "APPROVE", head_sha: HEAD, candidates: [request()] })).toEqual([]);
    expect(adapter.reviews).toHaveLength(0);
    expect(adapter.requests).toHaveLength(0);
  });

  it("the round order carries no escalation field, and the prompt no escalation text", () => {
    const order = buildRoundOrder({
      cfg, row: { number: 5, title: "T", head_sha: HEAD, author: "a", state: "reviewing", trigger_ts: null, stale_recheck: 0, migration_gate: 0 } as never,
      files: [], roundId: 1, roundNo: 1, roundType: "first", worktree: "/w", settledDigest: "", issuedAt: "2026-08-31T12:00:00Z",
    });
    expect(order.escalation_targets).toBeUndefined();
    expect(roundVars(order).escalation_note).toBe("");
    const template = readFileSync(join(repoRoot, "prompts/round-first.md"), "utf8");
    const rendered = renderRoundPrompt(template, order);
    expect(rendered).not.toMatch(/ESCALATION \(optional/);
    expect(rendered).not.toMatch(/escalations.*array/i);
    // The placeholder itself is fully consumed — no `{{…}}` survives.
    expect(rendered).not.toContain("{{escalation_note}}");
  });

  it("with the feature on but session judgement off, the prompt STILL says nothing", () => {
    // The deterministic half needs no prompt at all: the daemon evaluates and
    // delivers it. Only session judgement puts words in front of a model.
    expect(promptTargetsFor(on())).toBeUndefined();
    expect(promptTargetsFor(on({ session_judgement: true }))).toEqual(["teammate-one", "teammate-two"]);
    const note = renderEscalationPromptNote(promptTargetsFor(on({ session_judgement: true })));
    expect(note).toContain("@teammate-one");
    expect(note).toContain("never instead of it");
    expect(note).toContain("no concrete scope");
  });
});

// ===========================================================================
// Deterministic triggers — inspectable and testable with no LLM
// ===========================================================================

describe("deterministic triggers", () => {
  it("path globs: * within a segment, ** across", () => {
    expect(pathMatches("**/migrations/*.py", "app/db/migrations/0042_x.py")).toBe(true);
    expect(pathMatches("**/migrations/*.py", "migrations/0042_x.py")).toBe(true);
    expect(pathMatches("**/migrations/*.py", "app/migrations/sub/0042.py")).toBe(false);
    expect(pathMatches("billing/*.py", "billing/charge.py")).toBe(true);
    expect(pathMatches("billing/*.py", "billing/sub/charge.py")).toBe(false);
    expect(pathMatches("billing/**", "billing/sub/charge.py")).toBe(true);
    // A literal dot is a dot, not "any character".
    expect(pathMatches("a.py", "axpy")).toBe(false);
  });

  it("severity floors compare in the right direction, and an unknown spelling never fires", () => {
    expect(severityAtLeast("P0", "P2")).toBe(true);
    expect(severityAtLeast("P2", "P2")).toBe(true);
    expect(severityAtLeast("p1", "P1")).toBe(true);
    expect(severityAtLeast("P3", "P2")).toBe(false);
    expect(severityAtLeast("nit", "P3")).toBe(false);
    expect(severityAtLeast("critical", "P3")).toBe(false);
    expect(severityAtLeast("", "P3")).toBe(false);
  });

  it("conditions AND together — a rule with two conditions needs both", () => {
    const rule = { name: "r", to: "teammate-one", why: "w", paths: ["billing/**"], labels: ["release"], min_severity: "" as const, failing_checks: [] };
    expect(ruleFires(rule, facts({ changed_paths: ["billing/a.py"], labels: ["release"] }))).toBe(true);
    expect(ruleFires(rule, facts({ changed_paths: ["billing/a.py"] }))).toBe(false);
    expect(ruleFires(rule, facts({ labels: ["release"] }))).toBe(false);
  });

  it("labels and check names match case-insensitively; paths do not", () => {
    const base = { name: "r", to: "teammate-one", why: "w", paths: [], labels: [], min_severity: "" as const, failing_checks: [] };
    expect(ruleFires({ ...base, labels: ["Needs-Security"] }, facts({ labels: ["needs-security"] }))).toBe(true);
    expect(ruleFires({ ...base, failing_checks: ["E2E"] }, facts({ failing_checks: ["e2e"] }))).toBe(true);
    expect(ruleFires({ ...base, paths: ["Billing/**"] }, facts({ changed_paths: ["billing/a.py"] }))).toBe(false);
  });

  it("a rule that declares no condition never fires", () => {
    const bare = { name: "r", to: "teammate-one", why: "w", paths: [], labels: [], min_severity: "" as const, failing_checks: [] };
    expect(ruleFires(bare, facts({ changed_paths: ["anything"] }))).toBe(false);
  });

  it("evaluation is pure — same facts in, same escalations out, no I/O", () => {
    const c = on();
    const f = facts({ changed_paths: ["app/migrations/0042_x.py"] });
    const a = evaluateEscalationRules(c, f);
    const b = evaluateEscalationRules(c, f);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a[0]!.origin).toBe("rule");
    expect(a[0]!.rule).toBe("migrations");
    expect(a[0]!.why).toBe("you own the migration policy");
  });
});

// ===========================================================================
// The bound on session judgement
// ===========================================================================

describe("session-judgement escalation is bounded, daemon-side", () => {
  it("cannot reach a login the operator did not configure", async () => {
    const c = on({ session_judgement: true });
    const v = validateEscalationRequest({ ...request(), target: "someone-else" }, c);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.refusal).toBe("target-not-configured");

    const adapter = fakeAdapter();
    const outcomes = await deliverEscalations(
      { cfg: c, store, adapter },
      { pr: 9, verdict: "APPROVE", head_sha: HEAD, candidates: [{ ...request(), target: "someone-else" }] },
    );
    expect(adapter.reviews).toHaveLength(0);
    expect(adapter.requests).toHaveLength(0);
    expect(outcomes[0]!.refused).toBe("target-not-configured");
    expect(store.recentEvents(10).map((e) => e.kind)).toContain("escalation_refused");
  });

  it("cannot escalate at all when the operator left session judgement off", async () => {
    const adapter = fakeAdapter();
    const outcomes = await deliverEscalations(
      { cfg: on(), store, adapter },
      { pr: 9, verdict: "APPROVE", head_sha: HEAD, candidates: [request()] },
    );
    expect(outcomes[0]!.refused).toBe("session-judgement-off");
    expect(adapter.reviews).toHaveLength(0);
  });

  it("the daemon does not even LOOK at the verdict file's escalations when the knob is off", async () => {
    // Pinned at the wiring, not just the validator: verdicts.ts only forwards
    // `v.escalations` when session_judgement is on.
    const src = readFileSync(join(repoRoot, "src/verdicts.ts"), "utf8");
    expect(src).toMatch(/cfg\.session_judgement \? \(v\.escalations \?\? \[\]\) : \[\]/);
  });

  it("a rule-origin escalation is NOT gated on session judgement", async () => {
    const adapter = fakeAdapter();
    await deliverEscalations(
      { cfg: on(), store, adapter },
      { pr: 9, verdict: "APPROVE", head_sha: HEAD, candidates: evaluateEscalationRules(on(), facts({ changed_paths: ["app/migrations/0042.py"] })) },
    );
    expect(adapter.reviews).toHaveLength(1);
  });
});

// ===========================================================================
// Delivery: shapes, caps, dedup
// ===========================================================================

describe("delivery", () => {
  it("the comment shape posts ONE purposed COMMENT review anchored to the reviewed head", async () => {
    const adapter = fakeAdapter();
    await deliverEscalations(
      { cfg: on(), store, adapter },
      { pr: 11, verdict: "APPROVE", head_sha: HEAD, round_no: 2, candidates: evaluateEscalationRules(on(), facts({ changed_paths: ["app/migrations/0042.py"] })) },
    );
    expect(adapter.reviews).toHaveLength(1);
    expect(adapter.reviews[0]!.purpose).toBe("escalation");
    const payload = adapter.reviews[0]!.payload as { commit_id: string; event: string; body: string };
    expect(payload.event).toBe("COMMENT");
    expect(payload.commit_id).toBe(HEAD);
    expect(payload.body).toContain(ESCALATION_TAG);
    // The comment shape makes NO review request.
    expect(adapter.requests).toHaveLength(0);
  });

  it("the review-request shape posts the comment FIRST, then requests", async () => {
    const adapter = fakeAdapter();
    const c = on({ shape: "review_request" });
    await deliverEscalations(
      { cfg: c, store, adapter },
      { pr: 12, verdict: "APPROVE", head_sha: HEAD, candidates: evaluateEscalationRules(c, facts({ changed_paths: ["app/migrations/0042.py"] })) },
    );
    // The order is the invariant: GitHub's queue entry says "review this pull
    // request", so the narrow ask must already be on the PR when it lands.
    expect(adapter.order).toEqual(["comment", "request"]);
    expect(adapter.requests[0]).toEqual({ pr: 12, logins: ["teammate-one"] });
  });

  it("a guard refusal stops the review request too — and records nothing, so a later round retries", async () => {
    const adapter = fakeAdapter({ blocked: "pr-merged" });
    const c = on({ shape: "review_request" });
    const candidates = evaluateEscalationRules(c, facts({ changed_paths: ["app/migrations/0042.py"] }));
    await deliverEscalations({ cfg: c, store, adapter }, { pr: 13, verdict: "APPROVE", head_sha: HEAD, candidates });
    expect(adapter.requests).toHaveLength(0);
    expect(store.escalationCount(13)).toBe(0);
    // Second attempt is not suppressed by the dedup ledger.
    const again = fakeAdapter();
    await deliverEscalations({ cfg: c, store, adapter: again }, { pr: 13, verdict: "APPROVE", head_sha: HEAD, candidates });
    expect(again.reviews).toHaveLength(1);
  });

  it("the same person is never pointed at the same thing twice on one PR", async () => {
    const c = on();
    const candidates = evaluateEscalationRules(c, facts({ changed_paths: ["app/migrations/0042.py"] }));
    const first = fakeAdapter();
    await deliverEscalations({ cfg: c, store, adapter: first }, { pr: 14, verdict: "APPROVE", head_sha: HEAD, candidates });
    expect(first.reviews).toHaveLength(1);
    const second = fakeAdapter();
    const out = await deliverEscalations({ cfg: c, store, adapter: second }, { pr: 14, verdict: "REQUEST_CHANGES", head_sha: "deadbeef", candidates });
    expect(second.reviews).toHaveLength(0);
    expect(out[0]!.refused).toBe("already-delivered");
  });

  it("max_per_pr caps the rest", async () => {
    const c = on({
      session_judgement: true,
      max_per_pr: 1,
      rules: [
        { name: "a", to: "teammate-one", why: "w", paths: ["a/**"] },
        { name: "b", to: "teammate-two", why: "w", paths: ["b/**"] },
      ],
    });
    const adapter = fakeAdapter();
    const out = await deliverEscalations(
      { cfg: c, store, adapter },
      { pr: 15, verdict: "APPROVE", head_sha: HEAD, candidates: evaluateEscalationRules(c, facts({ changed_paths: ["a/x.py", "b/y.py"] })) },
    );
    expect(adapter.reviews).toHaveLength(1);
    expect(out.filter((o) => o.refused === "capped")).toHaveLength(1);
    expect(store.recentEvents(20).map((e) => e.kind)).toContain("escalation_capped");
  });

  it("delivery is recorded in the ledger with its provenance", async () => {
    const c = on();
    await deliverEscalations(
      { cfg: c, store, adapter: fakeAdapter() },
      { pr: 16, verdict: "APPROVE", head_sha: HEAD, round_no: 4, candidates: evaluateEscalationRules(c, facts({ changed_paths: ["app/migrations/0042.py"] })) },
    );
    const rows = store.escalationsFor(16);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: "teammate-one", shape: "comment", origin: "rule", rule: "migrations", round_no: 4 });
    expect(store.recentEvents(10).map((e) => e.kind)).toContain("escalation_delivered");
  });

  it("a round with nothing to escalate makes no call at all", async () => {
    const adapter = fakeAdapter();
    await deliverEscalations({ cfg: on(), store, adapter }, { pr: 17, verdict: "APPROVE", head_sha: HEAD, candidates: [] });
    expect(adapter.reviews).toHaveLength(0);
  });
});

// ===========================================================================
// The gate and the posting guards
// ===========================================================================

describe("the escalation note obeys the posting guards", () => {
  class Fake implements GuardAdapter {
    pr = { state: "open" as "open" | "closed", merged: false, head_sha: HEAD, author: "alice" };
    async getPr() { return this.pr; }
    async listReviews() { return []; }
  }

  function harness(dryRun = false) {
    const adapter = new Fake();
    const executor = vi.fn(async () => ({ id: 1 }));
    const dryrunDir = mkdtempSync(join(tmpdir(), "qcr-esc-gate-"));
    const gate = new MutationGate(dryRun, dryrunDir, executor as unknown as (i: MutationIntent) => Promise<unknown>);
    gate.setGuard(makePostingGuard({ store, adapter, botLogin: cfg.github.bot_login, guards: GUARDS_DEFAULTS }));
    return { gate, adapter, executor, dryrunDir };
  }

  const note = (): MutationIntent => ({
    kind: "create_review",
    method: "POST",
    path: "/repos/o/r/pulls/7/reviews",
    body: { commit_id: HEAD, event: "COMMENT", body: `${ESCALATION_TAG} @teammate-one …` },
    note: "escalation note on #7",
    pr: 7,
    reviewPurpose: "escalation",
  });

  it("guard 2 does not suppress it at an already-reviewed head — but still suppresses a real review", async () => {
    const { gate, executor } = harness();
    // The round's own review has just claimed this head, which is exactly the
    // moment the escalation note is posted.
    store.recordReviewedHead(7, { head_sha: HEAD, posted_event: "REQUEST_CHANGES" });
    expect((await gate.execute(note())).executed).toBe(true);
    // A SUBSTANTIVE review at the same head is still refused — the exemption
    // did not widen into "guard 2 is optional".
    const substantive = { ...note() };
    delete (substantive as { reviewPurpose?: unknown }).reviewPurpose;
    expect(await gate.execute(substantive)).toMatchObject({ executed: false, blocked: "no-new-evidence" });
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it("never claims the head — the round's own review keeps that mark", async () => {
    const { gate } = harness();
    await gate.execute(note());
    expect(store.reviewedHead(7)).toBeUndefined();
  });

  it("is still refused on a merged PR (guard 3) and on head drift (guard 5)", async () => {
    const merged = harness();
    merged.adapter.pr = { ...merged.adapter.pr, merged: true };
    expect(await merged.gate.execute(note())).toMatchObject({ executed: false, blocked: "pr-merged" });
    expect(merged.executor).not.toHaveBeenCalled();

    const drifted = harness();
    drifted.adapter.pr = { ...drifted.adapter.pr, head_sha: "0000000000000000000000000000000000000000" };
    expect(await drifted.gate.execute(note())).toMatchObject({ executed: false, blocked: "head-drift" });
    expect(drifted.executor).not.toHaveBeenCalled();
  });

  it("both escalation mutations are suppressed in dry-run", async () => {
    const { gate, executor, dryrunDir } = harness(true);
    expect((await gate.execute(note())).executed).toBe(false);
    const req: MutationIntent = {
      kind: "request_reviewer", method: "POST", path: "/repos/o/r/pulls/7/requested_reviewers",
      body: { reviewers: ["teammate-one"] }, note: "escalation request on #7", pr: 7,
    };
    expect((await gate.execute(req)).executed).toBe(false);
    expect(executor).not.toHaveBeenCalled();
    rmSync(dryrunDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// Configuration: no half-configured state is representable
// ===========================================================================

describe("configuration refuses a half-configured feature", () => {
  it("on with no targets does not load", () => {
    expect(() => parseEscalation({ enabled: true, targets: [], rules: [{ name: "r", to: "x", why: "w", paths: ["**"] }] })).toThrow(/no `targets`/);
  });

  it("on with nothing that can fire does not load", () => {
    expect(() => parseEscalation({ enabled: true, targets: ["teammate-one"] })).toThrow(/nothing could ever escalate/);
    // …unless session judgement is the trigger, which is a real answer.
    expect(parseEscalation({ enabled: true, targets: ["teammate-one"], session_judgement: true }).enabled).toBe(true);
  });

  it("a rule pointing outside the target list does not load", () => {
    expect(() =>
      parseEscalation({ enabled: true, targets: ["teammate-one"], rules: [{ name: "r", to: "stranger", why: "w", paths: ["**"] }] }),
    ).toThrow(/not in \[escalation\] targets/);
  });

  it("a rule with no condition, no why, no name, or a duplicate name does not load", () => {
    const base = { enabled: false };
    expect(() => parseEscalation({ ...base, rules: [{ name: "r", to: "t", why: "w" }] })).toThrow(/declares no condition/);
    expect(() => parseEscalation({ ...base, rules: [{ name: "r", to: "t", paths: ["**"] }] })).toThrow(/needs a `why`/);
    expect(() => parseEscalation({ ...base, rules: [{ to: "t", why: "w", paths: ["**"] }] })).toThrow(/needs a `name`/);
    expect(() =>
      parseEscalation({ ...base, rules: [{ name: "r", to: "t", why: "w", paths: ["**"] }, { name: "r", to: "t", why: "w", labels: ["x"] }] }),
    ).toThrow(/duplicate rule name/);
  });

  it("rejects a bad shape, a bad severity floor, a bad cap and a non-login target", () => {
    expect(() => parseEscalation({ shape: "email" })).toThrow(/shape must be/);
    expect(() => parseEscalation({ rules: [{ name: "r", to: "t", why: "w", min_severity: "URGENT" }] })).toThrow(/min_severity must be/);
    expect(() => parseEscalation({ max_per_pr: 0 })).toThrow(/max_per_pr/);
    expect(() => parseEscalation({ targets: ["not a login!"] })).toThrow(/is not a GitHub login/);
  });

  it("a switched-off table is a DRAFT, not an error", () => {
    const draft = parseEscalation({ enabled: false, targets: [], rules: [] });
    expect(draft.enabled).toBe(false);
    // …and "@login" is accepted and normalised, so an operator's @ is not a
    // configuration error.
    expect(parseEscalation({ targets: ["@teammate-one"] }).targets).toEqual(["teammate-one"]);
  });
});

// ===========================================================================
// The verdict path, end to end
// ===========================================================================

describe("the verdict path delivers what the rules found", () => {
  it("a rule keyed on the round's POSTED findings fires from the reasoning record", async () => {
    const s = new StateStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "qcr-esc-e2e-"));
    const findingsDir = join(dir, "findings");
    mkdirSync(findingsDir, { recursive: true });
    writeFileSync(
      join(findingsDir, "pr-50-round-1.json"),
      JSON.stringify({
        pr: 50,
        round_no: 1,
        head_sha: HEAD,
        findings: [
          { key: "f1", lens: "pass-security", path: "billing/charge.py", line: 20, severity: "P1", disposition: "posted", reason: "unbounded retry" },
          { key: "f2", lens: "pass-style", path: "x.py", severity: "nit", disposition: "killed" },
        ],
      }),
    );
    const reviews: Array<{ pr: number; payload: { body: string } }> = [];
    const adapter: VerdictAdapter = {
      async addLabel() { return { executed: true }; },
      async removeLabel() { return { executed: true }; },
      async listPrFiles() { return [{ filename: "billing/charge.py" }]; },
      async getPr() { return { labels: [] }; },
      async createReview(pr, payload) { reviews.push({ pr, payload }); return { executed: true }; },
    };
    const hooks: SessionHooks = { async dispatchRound() {}, async inject() {}, async injectOverseer() {}, async archiveAndClose() {} };
    s.setAnomalySink(() => {});
    s.upsertPr({ number: 50, state: "reviewing", head_sha: HEAD, title: "T", author: "a", trigger_ts: null, stale_recheck: 0, migration_gate: 0 });
    s.startRound(50, "first", ["pass-security"], cfg.daemon.round_deadline_min);
    writeFileSync(
      join(dir, "pr-50-round-1.json"),
      JSON.stringify({ pr: 50, round_no: 1, verdict: "REQUEST_CHANGES", head_sha: HEAD, finished_at: "2026-08-31T12:00:00Z" }),
    );
    const w = new VerdictWatcher({
      cfg: { ...cfg, escalation: on({ targets: ["teammate-two"], rules: [{ name: "blockers", to: "teammate-two", why: "you triage severe findings", min_severity: "P1" }] }) },
      store: s, adapter, hooks, verdictDir: dir, root: dir, findingsDir,
      usage: { globalStoreDir: null }, parseRetries: 0, retryDelayMs: 1, ledgerCheckDelayMs: 0,
    });
    await w.sweep();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.payload.body).toContain("@teammate-two");
    expect(reviews[0]!.payload.body).toContain("billing/charge.py");
    expect(reviews[0]!.payload.body).toContain("REQUEST_CHANGES");
    // The verdict itself landed untouched.
    expect(s.roundsFor(50)[0]!.verdict).toBe("REQUEST_CHANGES");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
