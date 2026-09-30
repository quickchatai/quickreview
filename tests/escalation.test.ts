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
import {
  GUARDS_DEFAULTS,
  parseConfig,
  parseEscalation,
  type Config,
  type EscalationConfig,
} from "../src/config.js";
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
import { postingMarker, roundPostingKey } from "../src/posting-receipt.js";
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
    rules: [
      {
        name: "migrations",
        to: "teammate-one",
        why: "you own the migration policy",
        paths: ["**/migrations/*.py"],
      },
    ],
    ...over,
  });
}

const OFF = parseEscalation({});

function facts(over: Partial<EscalationFacts> = {}): EscalationFacts {
  return { changed_paths: [], labels: [], findings: [], failing_checks: [], ...over };
}

const SCOPE = { kind: "code" as const, path: "billing/charge.py", start_line: 12, end_line: 30 };

/** The PR's changed files, as every delivery call must now supply them: a
 * `code`/`migration` scope naming anything else is refused (review,
 * blocker 2). */
const CHANGED = [
  "billing/charge.py",
  "app/migrations/0042.py",
  "app/migrations/0042_x.py",
  "a/x.py",
  "b/y.py",
  "a.py",
];

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
function fakeAdapter(
  over: { blocked?: string; throws?: boolean; dryRun?: boolean; requestThrows?: boolean } = {},
) {
  const reviews: Array<{ pr: number; payload: unknown; purpose?: string }> = [];
  const requests: Array<{ pr: number; logins: string[] }> = [];
  const order: string[] = [];
  return {
    reviews,
    requests,
    order,
    async createReview(
      pr: number,
      payload: { commit_id: string; event: "COMMENT"; body: string },
      options?: { purpose?: string },
    ): Promise<GateResult> {
      if (over.throws) throw new Error("POST /reviews → 502");
      order.push("comment");
      reviews.push({ pr, payload, ...(options?.purpose ? { purpose: options.purpose } : {}) });
      if (over.blocked) return { executed: false, blocked: over.blocked };
      // What the REAL gate returns in dry-run: not executed, no `blocked`,
      // a recorded file. This shape is the whole of blocker 1.
      if (over.dryRun) return { executed: false, dryRunFile: `/tmp/dryrun/${pr}.json` };
      return { executed: true };
    },
    async requestEscalationReview(pr: number, logins: string[]): Promise<GateResult> {
      order.push("request");
      requests.push({ pr, logins });
      if (over.requestThrows) throw new Error("POST /requested_reviewers → 422");
      return over.dryRun
        ? { executed: false, dryRunFile: `/tmp/dryrun/${pr}-req.json` }
        : { executed: true };
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
    const exported = [
      ...src.matchAll(
        /^export (?:async )?function ([A-Za-z]+)\(([\s\S]*?)\)(?::\s*([^{]+))?\s*\{/gm,
      ),
    ];
    expect(exported.length).toBeGreaterThan(8);
    for (const [, name, params, ret] of exported) {
      expect(
        `${params ?? ""} ${ret ?? ""}`,
        `escalation.ts ${name} must not traffic in verdicts`,
      ).not.toMatch(/\bVerdict\b/);
    }
  });

  it("STRUCTURAL: the delivery result carries no verdict channel", async () => {
    const adapter = fakeAdapter();
    const outcomes = await deliverEscalations(
      { cfg: on(), store, adapter },
      {
        pr: 7,
        verdict: "APPROVE",
        head_sha: HEAD,
        round_no: 1,
        changed_paths: CHANGED,
        ruleRequests: [request({ rule: "migrations" })],
      },
    );
    expect(outcomes).toHaveLength(1);
    // Every key on the outcome, enumerated: nothing here could be read as
    // "hold the review", "change the verdict" or "wait for a human".
    expect(Object.keys(outcomes[0]!).sort()).toEqual([
      "comment_executed",
      "origin",
      "refused",
      "scope_key",
      "target",
    ]);
  });

  it("BEHAVIOURAL: the verdict a round lands is IDENTICAL with escalation on and off", async () => {
    // Same round, same verdict file, same everything — driven twice through
    // the real VerdictWatcher, once with the feature off and once with it on
    // and actually firing. If escalation could touch the verdict, these two
    // snapshots would diverge.
    const snapshots: Array<Record<string, unknown>> = [];
    for (const escalation of [
      OFF,
      on({
        targets: ["teammate-one"],
        rules: [{ name: "all", to: "teammate-one", why: "w", paths: ["**"] }],
      }),
    ]) {
      const s = new StateStore(":memory:");
      const dir = mkdtempSync(join(tmpdir(), "qcr-esc-verdict-"));
      const labelCalls: string[] = [];
      const adapter: VerdictAdapter = {
        async addLabel(n, l) {
          labelCalls.push(`add:${n}:${l}`);
          return { executed: true };
        },
        async removeLabel(n, l) {
          labelCalls.push(`rm:${n}:${l}`);
          return { executed: true };
        },
        async listPrFiles() {
          return [{ filename: "billing/charge.py" }];
        },
        async getPr() {
          return { labels: [] };
        },
        async createReview() {
          return { executed: true };
        },
        async requestEscalationReview() {
          return { executed: true };
        },
      };
      const hooks: SessionHooks = {
        async dispatchRound() {},
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
      };
      s.setAnomalySink((sig) =>
        new AnomalyWakePolicy({ injectOverseer: (m) => hooks.injectOverseer(m) }).onAnomaly(sig),
      );
      s.upsertPr({
        number: 42,
        state: "reviewing",
        head_sha: HEAD,
        title: "T",
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      s.startRound(42, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
      const v: VerdictFile = {
        pr: 42,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        finished_at: "2026-08-31T12:00:00Z",
      };
      writeFileSync(join(dir, "pr-42-round-1.json"), JSON.stringify(v));
      const w = new VerdictWatcher({
        cfg: { ...cfg, escalation },
        store: s,
        adapter,
        hooks,
        verdictDir: dir,
        root: dir,
        usage: { globalStoreDir: null },
        parseRetries: 0,
        retryDelayMs: 1,
        ledgerCheckDelayMs: 0,
      });
      await w.sweep();
      const row = s.getPr(42)!;
      snapshots.push({
        state: row.state,
        // (`PrStateRow` carries no verdict column at all — the line that used
        // to read `row.last_verdict` here compared undefined against undefined
        // on both sides of the parity and asserted nothing. The `round` line
        // below is where the verdict actually is..)
        head: row.head_sha,
        round: s.roundsFor(42).map((r) => `${r.round_no}:${r.status}:${r.verdict ?? ""}`),
        // Timestamps are wall-clock, so only the SHAPE and content are
        // compared — everything else about the mark must be identical.
        reviewedHead: JSON.stringify(s.reviewedHead(42) ?? null).replace(
          /"reviewed_at":"[^"]*"/,
          '"reviewed_at":"<ts>"',
        ),
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
      async addLabel() {
        return { executed: true };
      },
      async removeLabel() {
        return { executed: true };
      },
      async listPrFiles() {
        return [{ filename: "a.py" }];
      },
      async getPr() {
        return { labels: [] };
      },
      async createReview() {
        throw new Error("POST /reviews → 502");
      },
    };
    const hooks: SessionHooks = {
      async dispatchRound() {},
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    };
    s.setAnomalySink(() => {});
    s.upsertPr({
      number: 43,
      state: "reviewing",
      head_sha: HEAD,
      title: "T",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    s.startRound(43, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
    writeFileSync(
      join(dir, "pr-43-round-1.json"),
      JSON.stringify({
        pr: 43,
        round_no: 1,
        verdict: "APPROVE",
        head_sha: HEAD,
        finished_at: "2026-08-31T12:00:00Z",
      }),
    );
    const w = new VerdictWatcher({
      cfg: {
        ...cfg,
        escalation: on({
          targets: ["teammate-one"],
          rules: [{ name: "all", to: "teammate-one", why: "w", paths: ["**"] }],
        }),
      },
      store: s,
      adapter,
      hooks,
      verdictDir: dir,
      root: dir,
      usage: { globalStoreDir: null },
      parseRetries: 0,
      retryDelayMs: 1,
      ledgerCheckDelayMs: 0,
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
    for (const scope of [
      undefined,
      null,
      {},
      { kind: "code" },
      { kind: "code", path: "" },
      { kind: "decision" },
      { kind: "decision", decision: "  " },
      { kind: "migration", path: "" },
    ]) {
      const v = validateEscalationRequest(
        { target: "teammate-one", scope, question: "look at this bit" },
        c,
        "rule",
      );
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
    for (const raw of [
      { path: "a/b.py" },
      { kind: "code", path: "a/b.py", start_line: "3", end_line: "9" },
      { kind: "migration", path: "m/0042.py", migration: "0042" },
      { kind: "decision", decision: "the retry budget" },
    ]) {
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
      // Session origin: this is the text a MODEL wrote, and it is the text the
      // belt guards. (A rule's question is our own template over the
      // operator's config and is exempt — see the test below.)
      const v = validateEscalationRequest(
        { ...request(), question: q },
        on({ session_judgement: true }),
        "session",
        CHANGED,
      );
      expect(v.ok, q).toBe(false);
      if (!v.ok) expect(v.refusal).toBe("asks-for-whole-review");
    }
    void c;
  });

  it("lets a genuinely narrow question through", () => {
    for (const q of [
      "Does the retry here double-charge when the webhook replays?",
      "Is index 0042 safe to build without CONCURRENTLY on this table size?",
      "We reviewed the code and think this decision is yours: keep the flag or drop it?",
    ]) {
      expect(asksForWholeReview(q), q).toBe(false);
      expect(
        validateEscalationRequest(
          { ...request(), question: q },
          on({ session_judgement: true }),
          "session",
        ).ok,
      ).toBe(true);
    }
  });

  it("the rendered note names the thing, the person and the reason, and disowns the whole-PR ask", () => {
    const body = renderEscalationComment(request({ origin: "rule", rule: "billing" }), {
      verdict: "REQUEST_CHANGES",
      round_no: 3,
      review_posted: true,
    });
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

  it("never claims the review is POSTED unless the receipt says so", () => {
    // The escalation note is the one posting exempt from guard 2, so the case
    // where the round's own review was refused is exactly the case where this
    // note still goes out. Telling a named human to go read a review that
    // never landed sends them hunting for nothing (review, F3).
    for (const ctx of [{ verdict: "APPROVE" }, { verdict: "APPROVE", review_posted: false }]) {
      const body = renderEscalationComment(request(), ctx);
      expect(body).toContain("already decided");
      expect(body).not.toContain("already decided and posted");
      expect(body).toContain("not confirmed on this pull request yet");
    }
    expect(
      renderEscalationComment(request(), { verdict: "APPROVE", review_posted: true }),
    ).toContain("already decided and posted");
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
      [
        { min_severity: "P1" },
        facts({ changed_paths: ["a/b.py"], findings: [{ severity: "P0", path: "a/b.py" }] }),
      ],
    ];
    for (const [cond, f] of cases) {
      const c = on({ rules: [{ name: "r", to: "teammate-one", why: "why you", ...cond }] });
      const out = evaluateEscalationRules(c, f);
      expect(out, JSON.stringify(cond)).toHaveLength(1);
      expect(renderScope(out[0]!.scope).length).toBeGreaterThan(3);
      expect(asksForWholeReview(out[0]!.question)).toBe(false);
    }
  });

  // --- review, blocker 2: the two holes that made a whole-PR
  // escalation spellable after all, and the tests that close them.

  it("a path must be a file THIS PR touches — an invented one is refused", () => {
    const c = on({ session_judgement: true });
    const diff = ["billing/charge.py", "app/migrations/0042.py"];
    // The exploit: any non-empty string passed as a path.
    for (const path of [
      "the entire diff",
      "**",
      "*",
      "the whole pull request",
      "src/",
      "billing/charge.pyc",
      "Billing/charge.py",
    ]) {
      const v = validateEscalationRequest(
        { ...request(), scope: { kind: "code", path } },
        c,
        "session",
        diff,
      );
      expect(v.ok, path).toBe(false);
      if (!v.ok) expect(v.refusal).toBe("path-not-in-diff");
    }
    // A migration scope is held to the same rule.
    expect(
      validateEscalationRequest(
        { ...request(), scope: { kind: "migration", path: "nope/0001.py" } },
        c,
        "session",
        diff,
      ).ok,
    ).toBe(false);
    // A real file in the diff passes — and surrounding whitespace is trimmed
    // rather than being treated as a different file.
    expect(
      validateEscalationRequest(
        { ...request(), scope: { kind: "code", path: "billing/charge.py" } },
        c,
        "session",
        diff,
      ).ok,
    ).toBe(true);
    expect(
      validateEscalationRequest(
        { ...request(), scope: { kind: "code", path: " billing/charge.py " } },
        c,
        "session",
        diff,
      ).ok,
    ).toBe(true);
  });

  it("an unreadable diff refuses every path-bearing scope rather than waving it through", async () => {
    // `deliverEscalations` passes `[]` when the file listing failed, and the
    // safe direction is silence: better no escalation than one pointing at a
    // file nobody can confirm is in this change.
    const adapter = fakeAdapter();
    const out = await deliverEscalations(
      { cfg: on({ session_judgement: true }), store, adapter },
      {
        pr: 20,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: [],
        sessionCandidates: [request()],
      },
    );
    expect(out[0]!.refused).toBe("path-not-in-diff");
    expect(adapter.reviews).toHaveLength(0);
  });

  it("a `decision` name goes through the whole-review check and is capped", () => {
    const c = on({ session_judgement: true });
    // THE EXPLOIT the reviewer found: `decision` was unconstrained free text.
    const v = validateEscalationRequest(
      {
        ...request(),
        scope: { kind: "decision", decision: "whether this pull request should be merged at all" },
        question: "Have a think and let me know.",
      },
      c,
      "session",
      CHANGED,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.refusal).toBe("asks-for-whole-review");
    // …and it is a NAME, not an essay.
    const long = normalizeScope({ kind: "decision", decision: "x".repeat(500) })!;
    expect(long.kind).toBe("decision");
    if (long.kind === "decision") expect(long.decision.length).toBeLessThanOrEqual(120);
  });

  it("the whole-review check catches the natural phrasings, not just the obvious ones", () => {
    // Every one of these passed the first version of the predicate.
    for (const q of [
      "Could you cast an eye over all of it?",
      "Please read through the changes.",
      "Are you happy with everything here?",
      "I would like a second pair of eyes on the whole change before it ships.",
      "Mind giving the diff a quick scan?",
      "Can you go through the patch top to bottom?",
      "Would you sign off on this branch?",
      "whether this pull request should be merged at all",
      "Just have a look at it.",
    ]) {
      expect(asksForWholeReview(q), q).toBe(true);
    }
  });

  it("…and does NOT over-block a genuinely narrow question", () => {
    // The belt must not eat the thing the feature exists for.
    for (const q of [
      "Does the retry here double-charge when the webhook replays?",
      "Is index 0042 safe to build without CONCURRENTLY on this table size?",
      "Should this migration be split in two, given the deploy window?",
      "Does this change the ordering guarantee callers rely on?",
      "We reviewed the retry path and this call is yours: keep the flag or drop it?",
      "Is 30 seconds the right timeout for the payments client?",
      "the retry budget",
      "the decision to key the cache on tenant id",
    ]) {
      expect(asksForWholeReview(q), q).toBe(false);
    }
  });

  it("SCOPE-OF-EFFECT questions are not whole-review asks — the belt's own failure mode", () => {
    // re-review, N2, and the reason this describe exists twice over.
    //
    // The second cut of the predicate treated `whole`, `entire`, `everything`,
    // `at all`, `overall` as damning ON THEIR OWN, reasoning that "nothing
    // narrow needs them". That is false: they are the standard vocabulary of
    // SCOPE-OF-EFFECT questions, which is exactly what a narrow escalation
    // asks — the first line below is the canonical thing this feature exists
    // for. It refused 9 of 12 such questions.
    //
    // A false positive here is a SILENT DROP: `escalation_refused`, no
    // delivery, nobody told. So the belt is tuned to UNDER-block, and this
    // negative set is the pin. The previous negative set could not see the
    // bug because every phrasing in it avoided the trigger words.
    for (const q of [
      "Does this lock the whole row, or just the counter?",
      "Is the entire cache invalidated here, or only the tenant slice?",
      "Does this drop everything in the retry queue?",
      "Is this index used at all?",
      "Is the overall timeout still 30s after this?",
      "Does this retry the entire request, or only the failed page?",
      "Is the whole table rewritten by this migration, or just the new column?",
      "Does the entire batch fail if one row does?",
      "Is everything in this payload serialised, or only the public keys?",
      "Does this invalidate the whole tenant namespace at all, or just one key?",
      "Is the whole lock held for the duration, or released between pages?",
      "Does this reset everything in the session, overall?",
      // These three carry an ARTIFACT word as well, so they are what makes
      // dropping `at all` and `overall` from BREADTH load-bearing rather than
      // decorative — without the drop, the conjunction fires on them.
      "Is this branch used at all?",
      "Is the overall latency of these changes affected?",
      "Does this diff alter the timeout at all?",
    ]) {
      expect(asksForWholeReview(q), q).toBe(false);
    }
  });

  it("a breadth word DOES damn once it is talking about the change", () => {
    // The other half of the same rule: "the whole row" is narrow, "the whole
    // diff" is not. Both sides pinned so neither can drift alone.
    for (const q of [
      "Could you look over the whole diff?",
      "Can you go through the entire patch?",
      "Is everything in this pull request ready to merge?",
      "Please review the whole thing.",
    ]) {
      expect(asksForWholeReview(q), q).toBe(true);
    }
  });

  it("a fired rule is NEVER silently dropped by wording — the operator's own words cannot break it", () => {
    // Two things this pins together (re-review):
    //
    //  * the rule-built strings are back to their natural phrasing — they were
    //    briefly written defensively to dodge the belt, and needing to dodge
    //    was the signal that the belt was wrong;
    //  * the belt does not run on rule-origin text at all, so an operator who
    //    names a label "review the whole thing" still gets their escalation.
    //    That case is deliberately in the list: it is the one that would be a
    //    silent drop otherwise.
    const cases: Array<[Record<string, unknown>, EscalationFacts]> = [
      [{ paths: ["**"] }, facts({ changed_paths: ["app/migrations/0042_x.py"] })],
      [{ paths: ["**"] }, facts({ changed_paths: ["billing/charge.py"] })],
      [{ labels: ["needs-security"] }, facts({ labels: ["needs-security"] })],
      [{ labels: ["review the whole thing"] }, facts({ labels: ["review the whole thing"] })],
      [{ failing_checks: ["e2e"] }, facts({ failing_checks: ["e2e"] })],
      [{ failing_checks: ["review-everything"] }, facts({ failing_checks: ["review-everything"] })],
      [
        { min_severity: "P1" },
        facts({ changed_paths: ["a/b.py"], findings: [{ severity: "P0", path: "a/b.py" }] }),
      ],
      [
        { min_severity: "P1" },
        facts({ findings: [{ severity: "P0", title: "the retry budget is unbounded" }] }),
      ],
    ];
    for (const [cond, f] of cases) {
      const rule = {
        name: "r",
        to: "teammate-one",
        why: "please just review the whole PR and sign off",
        ...cond,
      };
      const c = on({ rules: [rule] });
      const refusals: string[] = [];
      const out = evaluateEscalationRules(c, f, (_r, refusal) => refusals.push(refusal));
      expect(refusals, JSON.stringify(cond)).toEqual([]);
      expect(out, JSON.stringify(cond)).toHaveLength(1);
      // …and the operator's `why` is rendered verbatim, belt or no belt.
      expect(out[0]!.why).toBe("please just review the whole PR and sign off");
    }
  });

  it("but a MODEL-written finding reason is filtered where it enters a rule scope", () => {
    // The one piece of untrusted text that can reach a rule-built scope. It is
    // belted in `scopeForRule`, at the boundary — so it costs this candidate a
    // scope, and the rule is REPORTED rather than silently producing a
    // whole-review headline.
    const c = on({ rules: [{ name: "sev", to: "teammate-one", why: "w", min_severity: "P1" }] });
    const refusals: string[] = [];
    const out = evaluateEscalationRules(
      c,
      facts({
        findings: [
          { severity: "P0", title: "please review the whole pull request before merging" },
        ],
      }),
      (_r, refusal) => refusals.push(refusal),
    );
    expect(out).toEqual([]);
    expect(refusals).toEqual(["no-scope-derivable"]);
    // A narrow reason is carried through untouched.
    const ok = evaluateEscalationRules(
      c,
      facts({ findings: [{ severity: "P0", title: "the retry budget is unbounded" }] }),
    );
    expect(ok).toHaveLength(1);
    expect(ok[0]!.scope).toEqual({ kind: "decision", decision: "the retry budget is unbounded" });
  });

  it("a fired rule that produces nothing is REPORTED, never silent", () => {
    // The operator configured it and it matched; if nobody is told, they must
    // at least be able to see why (re-review).
    const c = on({ rules: [{ name: "sev", to: "teammate-one", why: "w", min_severity: "P1" }] });
    const refusals: Array<[string, string]> = [];
    const out = evaluateEscalationRules(c, facts({ findings: [{ severity: "P0" }] }), (r, why) =>
      refusals.push([r.name, why]),
    );
    expect(out).toEqual([]);
    expect(refusals).toEqual([["sev", "no-scope-derivable"]]);

    // …and the same for a candidate that fails validation rather than scoping.
    const c2 = on({
      rules: [{ name: "outside", to: "teammate-one", why: "w", min_severity: "P1" }],
    });
    const refusals2: Array<[string, string]> = [];
    evaluateEscalationRules(
      c2,
      facts({
        changed_paths: ["a/b.py"],
        findings: [{ severity: "P0", path: "somewhere/else.py" }],
      }),
      (r, why) => refusals2.push([r.name, why]),
    );
    expect(refusals2).toEqual([["outside", "path-not-in-diff"]]);
  });

  it("`why` is a third free-text slot and is belted for SESSION escalations", () => {
    // re-review, N1. A narrow question could ride beside a "why you"
    // that asked for the whole review — and `why` is model-written on a
    // session entry.
    const c = on({ session_judgement: true });
    const smuggled =
      "honestly, please just review this whole pull request end to end and sign off on it — " +
      "I want a second pair of eyes on everything before it ships";
    const v = validateEscalationRequest({ ...request(), why: smuggled }, c, "session", CHANGED);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.refusal).toBe("asks-for-whole-review");

    // An OPERATOR's `why` is exempt — it is their own text, rendered verbatim
    // by design, and they may word it however they like.
    const ruled = validateEscalationRequest(
      { ...request(), rule: "r", why: smuggled },
      c,
      "rule",
      CHANGED,
    );
    expect(ruled.ok).toBe(true);

    // A narrow session `why` is untouched.
    expect(
      validateEscalationRequest(
        { ...request(), why: "you own the billing retry policy" },
        c,
        "session",
        CHANGED,
      ).ok,
    ).toBe(true);
  });

  it('a session candidate CANNOT relabel itself `origin: "rule"` to buy the exemption', async () => {
    // re-review, the blocker. `origin` used to be read off the
    // candidate — and for a session candidate the candidate IS the verdict
    // file's `escalations` entry, which the model writes. So the model marked
    // its own trust level: `"origin": "rule"` bought the belt exemption on all
    // three free-text slots AND forged the audit trail, since the ledger row
    // and the rendered "_Escalated by the configured rule `x`._" line both
    // name a rule that need not exist.
    //
    // Origin is now an argument, and `deliverEscalations` takes the two groups
    // separately, so the label on the payload is inert.
    const c = on({ session_judgement: true });
    const forged = {
      ...request(),
      origin: "rule",
      rule: "billing",
      why: "please just review this whole pull request and sign off on all of it",
    };

    // Directly: the caller says "session", and the payload's claim is ignored.
    const v = validateEscalationRequest(forged, c, "session", CHANGED);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.refusal).toBe("asks-for-whole-review");

    // Through the real delivery path, as a session candidate.
    const adapter = fakeAdapter();
    const out = await deliverEscalations(
      { cfg: c, store, adapter },
      {
        pr: 40,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        sessionCandidates: [forged],
      },
    );
    expect(out[0]).toMatchObject({ refused: "asks-for-whole-review", origin: "session" });
    expect(adapter.reviews).toHaveLength(0);
    expect(
      store
        .recentEvents(10)
        .some(
          (e) =>
            e.kind === "escalation_refused" && String(e.payload).includes('"origin":"session"'),
        ),
    ).toBe(true);
  });

  it("…and a session escalation that IS fine is still recorded as origin session, with no rule name", async () => {
    // The other half of the forgery: even when the content is unobjectionable,
    // the ledger and the rendered note must say the MODEL asked for this, not
    // a configured rule. `escalationsFor` is the operator's audit view.
    const c = on({ session_judgement: true });
    const adapter = fakeAdapter();
    await deliverEscalations(
      { cfg: c, store, adapter },
      {
        pr: 41,
        verdict: "APPROVE",
        head_sha: HEAD,
        round_no: 2,
        changed_paths: CHANGED,
        sessionCandidates: [{ ...request(), origin: "rule", rule: "billing" }],
      },
    );
    const rows = store.escalationsFor(41);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("session");
    expect(rows[0]!.rule).toBeNull();
    // …and the comment does not claim a rule escalated it.
    expect(adapter.reviews[0]!.payload).toMatchObject({ event: "COMMENT" });
    expect((adapter.reviews[0]!.payload as { body: string }).body).not.toContain(
      "Escalated by the configured rule",
    );
  });

  it("a decision scope's OPTIONAL path is checked against the diff too", () => {
    // re-review, N4: `scope.kind !== "decision"` exempted the whole
    // scope, so an invented path rode along on a decision, rendered, and minted
    // its own dedup key.
    const c = on({ session_judgement: true });
    const bad = validateEscalationRequest(
      {
        ...request(),
        scope: { kind: "decision", decision: "the retry budget", path: "the entire diff" },
      },
      c,
      "session",
      CHANGED,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal).toBe("path-not-in-diff");

    // A real file is fine, and a decision with NO path is fine.
    expect(
      validateEscalationRequest(
        {
          ...request(),
          scope: { kind: "decision", decision: "the retry budget", path: "billing/charge.py" },
        },
        c,
        "session",
        CHANGED,
      ).ok,
    ).toBe(true);
    expect(
      validateEscalationRequest(
        { ...request(), scope: { kind: "decision", decision: "the retry budget" } },
        c,
        "session",
        CHANGED,
      ).ok,
    ).toBe(true);
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
    expect(
      evaluateEscalationRules(OFF, facts({ changed_paths: ["app/migrations/0042.py"] })),
    ).toEqual([]);
    // Even a config with rules and targets written down: `enabled = false`
    // makes the whole table a draft.
    const draft = parseEscalation({
      enabled: false,
      targets: ["teammate-one"],
      rules: [{ name: "r", to: "teammate-one", why: "w", paths: ["**"] }],
    });
    expect(evaluateEscalationRules(draft, facts({ changed_paths: ["a.py"] }))).toEqual([]);
    expect(promptTargetsFor(draft)).toBeUndefined();
    expect(renderEscalationPromptNote(promptTargetsFor(draft))).toBe("");
    const adapter = fakeAdapter();
    expect(
      await deliverEscalations(
        { cfg: draft, store, adapter },
        {
          pr: 1,
          verdict: "APPROVE",
          head_sha: HEAD,
          changed_paths: CHANGED,
          sessionCandidates: [request()],
        },
      ),
    ).toEqual([]);
    expect(adapter.reviews).toHaveLength(0);
    expect(adapter.requests).toHaveLength(0);
  });

  it("the dedup key is the PLACE, not the line offsets", () => {
    // review, F5. Keying on lines made 12–30 and 14–32 two distinct
    // asks rendering near-identical notes — the nag the ledger exists to stop.
    expect(scopeKey({ kind: "code", path: "a/b.py", start_line: 12, end_line: 30 })).toBe(
      scopeKey({ kind: "code", path: "a/b.py", start_line: 14, end_line: 32 }),
    );
    expect(scopeKey({ kind: "code", path: "a/b.py" })).toBe(
      scopeKey({ kind: "code", path: "a/b.py", start_line: 3 }),
    );
    // Different files stay different, and a decision keeps its own identity.
    expect(scopeKey({ kind: "code", path: "a/b.py" })).not.toBe(
      scopeKey({ kind: "code", path: "a/c.py" }),
    );
    expect(scopeKey({ kind: "decision", decision: "the retry budget" })).not.toBe(
      scopeKey({ kind: "decision", decision: "the cache key" }),
    );
  });

  it("an end_line without a start_line is dropped, not carried", () => {
    // The old `end ?? start` was dead code inside a branch that already
    // required `end`, and a lone end_line rendered as nothing while sitting
    // in the scope (review, F5).
    const scope = normalizeScope({ kind: "code", path: "a/b.py", end_line: 40 })!;
    expect(scope).toEqual({ kind: "code", path: "a/b.py" });
    // A reversed range is clamped rather than rendering backwards.
    expect(normalizeScope({ kind: "code", path: "a/b.py", start_line: 30, end_line: 12 })).toEqual({
      kind: "code",
      path: "a/b.py",
      start_line: 30,
      end_line: 30,
    });
  });

  it("the round order carries no escalation field, and the prompt no escalation text", () => {
    const order = buildRoundOrder({
      cfg,
      row: {
        number: 5,
        title: "T",
        head_sha: HEAD,
        author: "a",
        state: "reviewing",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      } as never,
      files: [],
      roundId: 1,
      roundNo: 1,
      roundType: "first",
      worktree: "/w",
      settledDigest: "",
      issuedAt: "2026-08-31T12:00:00Z",
    });
    expect(order.escalation_targets).toBeUndefined();
    expect(roundVars(order).escalation_note).toBe("");
    const template = readFileSync(join(repoRoot, "prompts/round-first.md"), "utf8");
    const rendered = renderRoundPrompt(template, order);
    expect(rendered).not.toMatch(/ESCALATION \(optional/);
    expect(rendered).not.toMatch(/escalations.*array/i);
    // The placeholder itself is fully consumed — no `{{…}}` survives.
    expect(rendered).not.toContain("{{escalation_note}}");

    // …and WHITESPACE IS THE ONLY DIFFERENCE from a template that never had
    // the placeholder. This is the honest form of the claim: the acceptance
    // criterion is behaviour, and the docs used to overstate it as "byte
    // identical" (review, near-blocking). `{{escalation_note}}`
    // renders empty and leaves a blank line, exactly as the sibling
    // `{{directive_note}}` beside it already does.
    const withoutPlaceholder = template.replace("\n{{escalation_note}}\n", "");
    expect(withoutPlaceholder).not.toBe(template); // the placeholder really is there
    const collapse = (t: string) => t.replace(/\n{2,}/g, "\n\n");
    expect(collapse(rendered)).toBe(collapse(renderRoundPrompt(withoutPlaceholder, order)));
  });

  it("with the feature on but session judgement off, the prompt STILL says nothing", () => {
    // The deterministic half needs no prompt at all: the daemon evaluates and
    // delivers it. Only session judgement puts words in front of a model.
    expect(promptTargetsFor(on())).toBeUndefined();
    expect(promptTargetsFor(on({ session_judgement: true }))).toEqual([
      "teammate-one",
      "teammate-two",
    ]);
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
    const rule = {
      name: "r",
      to: "teammate-one",
      why: "w",
      paths: ["billing/**"],
      labels: ["release"],
      min_severity: "" as const,
      failing_checks: [],
    };
    expect(ruleFires(rule, facts({ changed_paths: ["billing/a.py"], labels: ["release"] }))).toBe(
      true,
    );
    expect(ruleFires(rule, facts({ changed_paths: ["billing/a.py"] }))).toBe(false);
    expect(ruleFires(rule, facts({ labels: ["release"] }))).toBe(false);
  });

  it("labels and check names match case-insensitively; paths do not", () => {
    const base = {
      name: "r",
      to: "teammate-one",
      why: "w",
      paths: [],
      labels: [],
      min_severity: "" as const,
      failing_checks: [],
    };
    expect(
      ruleFires({ ...base, labels: ["Needs-Security"] }, facts({ labels: ["needs-security"] })),
    ).toBe(true);
    expect(
      ruleFires({ ...base, failing_checks: ["E2E"] }, facts({ failing_checks: ["e2e"] })),
    ).toBe(true);
    expect(
      ruleFires({ ...base, paths: ["Billing/**"] }, facts({ changed_paths: ["billing/a.py"] })),
    ).toBe(false);
  });

  it("a rule that declares no condition never fires", () => {
    const bare = {
      name: "r",
      to: "teammate-one",
      why: "w",
      paths: [],
      labels: [],
      min_severity: "" as const,
      failing_checks: [],
    };
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
    const v = validateEscalationRequest({ ...request(), target: "someone-else" }, c, "session");
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.refusal).toBe("target-not-configured");

    const adapter = fakeAdapter();
    const outcomes = await deliverEscalations(
      { cfg: c, store, adapter },
      {
        pr: 9,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        sessionCandidates: [{ ...request(), target: "someone-else" }],
      },
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
      {
        pr: 9,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        sessionCandidates: [request()],
      },
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
      {
        pr: 9,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: evaluateEscalationRules(
          on(),
          facts({ changed_paths: ["app/migrations/0042.py"] }),
        ),
      },
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
      {
        pr: 11,
        verdict: "APPROVE",
        head_sha: HEAD,
        round_no: 2,
        changed_paths: CHANGED,
        review_posted: true,
        ruleRequests: evaluateEscalationRules(
          on(),
          facts({ changed_paths: ["app/migrations/0042.py"] }),
        ),
      },
    );
    expect(adapter.reviews).toHaveLength(1);
    expect(adapter.reviews[0]!.purpose).toBe("escalation");
    const payload = adapter.reviews[0]!.payload as {
      commit_id: string;
      event: string;
      body: string;
    };
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
      {
        pr: 12,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: evaluateEscalationRules(
          c,
          facts({ changed_paths: ["app/migrations/0042.py"] }),
        ),
      },
    );
    // The order is the invariant: GitHub's queue entry says "review this pull
    // request", so the narrow ask must already be on the PR when it lands.
    expect(adapter.order).toEqual(["comment", "request"]);
    expect(adapter.requests[0]).toEqual({ pr: 12, logins: ["teammate-one"] });
  });

  it("a failed review request after a posted comment still records the delivery (never re-posts the note)", async () => {
    // GitHub 422s a request for the PR author or a non-collaborator. The
    // comment is already on the PR by then; losing the ledger row would make
    // every later round post the same note again, and skip the candidates
    // after it in this one.
    const adapter = fakeAdapter({ requestThrows: true });
    const c = on({ shape: "review_request" });
    const candidates = evaluateEscalationRules(
      c,
      facts({ changed_paths: ["app/migrations/0042.py"] }),
    );
    const outcomes = await deliverEscalations(
      { cfg: c, store, adapter },
      {
        pr: 14,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(adapter.order).toEqual(["comment", "request"]);
    expect(outcomes[0]).toMatchObject({ comment_executed: true, review_requested: false });
    // The note was posted BEFORE the request failed, so it must not have
    // promised a queue entry that never arrived (selfscan d5a5ee72).
    const posted = (adapter.reviews[0]!.payload as { body: string }).body;
    expect(posted).not.toContain("You will also see");
    expect(posted).toContain("review-requested queue");
    expect(store.escalationCount(14)).toBe(1);
    const again = fakeAdapter();
    const second = await deliverEscalations(
      { cfg: c, store, adapter: again },
      {
        pr: 14,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(again.reviews).toHaveLength(0);
    expect(second[0]).toMatchObject({ refused: "already-delivered" });
  });

  it("a guard refusal stops the review request too — and records nothing, so a later round retries", async () => {
    const adapter = fakeAdapter({ blocked: "pr-merged" });
    const c = on({ shape: "review_request" });
    const candidates = evaluateEscalationRules(
      c,
      facts({ changed_paths: ["app/migrations/0042.py"] }),
    );
    await deliverEscalations(
      { cfg: c, store, adapter },
      {
        pr: 13,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(adapter.requests).toHaveLength(0);
    expect(store.escalationCount(13)).toBe(0);
    // Second attempt is not suppressed by the dedup ledger.
    const again = fakeAdapter();
    await deliverEscalations(
      { cfg: c, store, adapter: again },
      {
        pr: 13,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(again.reviews).toHaveLength(1);
  });

  it("the same person is never pointed at the same thing twice on one PR", async () => {
    const c = on();
    const candidates = evaluateEscalationRules(
      c,
      facts({ changed_paths: ["app/migrations/0042.py"] }),
    );
    const first = fakeAdapter();
    await deliverEscalations(
      { cfg: c, store, adapter: first },
      {
        pr: 14,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(first.reviews).toHaveLength(1);
    const second = fakeAdapter();
    const out = await deliverEscalations(
      { cfg: c, store, adapter: second },
      {
        pr: 14,
        verdict: "REQUEST_CHANGES",
        head_sha: "deadbeef",
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
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
      {
        pr: 15,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: evaluateEscalationRules(c, facts({ changed_paths: ["a/x.py", "b/y.py"] })),
      },
    );
    expect(adapter.reviews).toHaveLength(1);
    expect(out.filter((o) => o.refused === "capped")).toHaveLength(1);
    expect(store.recentEvents(20).map((e) => e.kind)).toContain("escalation_capped");
  });

  it("delivery is recorded in the ledger with its provenance", async () => {
    const c = on();
    await deliverEscalations(
      { cfg: c, store, adapter: fakeAdapter() },
      {
        pr: 16,
        verdict: "APPROVE",
        head_sha: HEAD,
        round_no: 4,
        changed_paths: CHANGED,
        ruleRequests: evaluateEscalationRules(
          c,
          facts({ changed_paths: ["app/migrations/0042.py"] }),
        ),
      },
    );
    const rows = store.escalationsFor(16);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: "teammate-one",
      shape: "comment",
      origin: "rule",
      rule: "migrations",
      round_no: 4,
    });
    expect(store.recentEvents(10).map((e) => e.kind)).toContain("escalation_delivered");
  });

  // --- review, blocker 1: the ledger records DELIVERIES, not attempts.

  it("a DRY-RUN escalation consumes neither the dedup key nor the cap", async () => {
    // The scenario the docs walk a new operator into: enable escalation, run
    // the documented dry-run bring-up. The gate returns
    // {executed:false, dryRunFile} with NO `blocked`, so before the fix this
    // wrote a row — and `escalations_once` then owned that (pr, target,
    // scope_key) pair FOREVER. Going live, the real escalation came back
    // `already-delivered`, silently, fixable only by editing SQLite by hand.
    const c = on();
    const candidates = evaluateEscalationRules(
      c,
      facts({ changed_paths: ["app/migrations/0042.py"] }),
    );
    const dry = fakeAdapter({ dryRun: true });
    const out = await deliverEscalations(
      { cfg: c, store, adapter: dry },
      {
        pr: 30,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );

    // The intent was built and handed to the gate — that is what dry-run is for…
    expect(dry.reviews).toHaveLength(1);
    expect(out[0]).toMatchObject({ refused: null, comment_executed: false });
    // …and NOTHING was consumed.
    expect(store.escalationCount(30)).toBe(0);
    expect(store.escalationsFor(30)).toEqual([]);
    const kinds = store.recentEvents(20).map((e) => e.kind);
    expect(kinds).toContain("escalation_not_executed");
    expect(kinds).not.toContain("escalation_delivered");

    // A second dry-run round is not suppressed either.
    const dry2 = fakeAdapter({ dryRun: true });
    await deliverEscalations(
      { cfg: c, store, adapter: dry2 },
      {
        pr: 30,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(dry2.reviews).toHaveLength(1);

    // …and going LIVE still delivers, because nothing was ever claimed.
    const live = fakeAdapter();
    const liveOut = await deliverEscalations(
      { cfg: c, store, adapter: live },
      {
        pr: 30,
        verdict: "APPROVE",
        head_sha: HEAD,
        changed_paths: CHANGED,
        ruleRequests: candidates,
      },
    );
    expect(live.reviews).toHaveLength(1);
    expect(liveOut[0]!.refused).toBeNull();
    expect(liveOut[0]!.comment_executed).toBe(true);
    expect(store.escalationCount(30)).toBe(1);
  });

  it("many dry-run rounds never exhaust max_per_pr", async () => {
    const c = on({ max_per_pr: 1 });
    const candidates = evaluateEscalationRules(
      c,
      facts({ changed_paths: ["app/migrations/0042.py"] }),
    );
    for (let i = 0; i < 5; i++) {
      const dry = fakeAdapter({ dryRun: true });
      await deliverEscalations(
        { cfg: c, store, adapter: dry },
        {
          pr: 31,
          verdict: "APPROVE",
          head_sha: HEAD,
          changed_paths: CHANGED,
          ruleRequests: candidates,
        },
      );
      expect(dry.reviews, `round ${i}`).toHaveLength(1);
    }
    expect(store.escalationCount(31)).toBe(0);
  });

  it("a round with nothing to escalate makes no call at all", async () => {
    const adapter = fakeAdapter();
    await deliverEscalations(
      { cfg: on(), store, adapter },
      { pr: 17, verdict: "APPROVE", head_sha: HEAD, changed_paths: CHANGED, ruleRequests: [] },
    );
    expect(adapter.reviews).toHaveLength(0);
  });
});

// ===========================================================================
// The gate and the posting guards
// ===========================================================================

describe("the escalation note obeys the posting guards", () => {
  class Fake implements GuardAdapter {
    pr = { state: "open" as "open" | "closed", merged: false, head_sha: HEAD, author: "alice" };
    async getPr() {
      return this.pr;
    }
    async listReviews() {
      return [];
    }
  }

  function harness(dryRun = false) {
    const adapter = new Fake();
    const executor = vi.fn(async () => ({ id: 1 }));
    const dryrunDir = mkdtempSync(join(tmpdir(), "qcr-esc-gate-"));
    const gate = new MutationGate(
      dryRun,
      dryrunDir,
      executor as unknown as (i: MutationIntent) => Promise<unknown>,
    );
    gate.setGuard(
      makePostingGuard({ store, adapter, botLogin: cfg.github.bot_login, guards: GUARDS_DEFAULTS }),
    );
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
    expect(await gate.execute(substantive)).toMatchObject({
      executed: false,
      blocked: "no-new-evidence",
    });
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
    expect(await merged.gate.execute(note())).toMatchObject({
      executed: false,
      blocked: "pr-merged",
    });
    expect(merged.executor).not.toHaveBeenCalled();

    const drifted = harness();
    drifted.adapter.pr = {
      ...drifted.adapter.pr,
      head_sha: "0000000000000000000000000000000000000000",
    };
    expect(await drifted.gate.execute(note())).toMatchObject({
      executed: false,
      blocked: "head-drift",
    });
    expect(drifted.executor).not.toHaveBeenCalled();
  });

  it("a reviewPurpose is confined to a COMMENT create_review — the exemptions cannot ride anything else", async () => {
    // review, F6. A purpose buys two exemptions (guard 2, and never
    // claiming the head), so an APPROVE carrying one would be an approval that
    // skips the no-new-evidence guard AND never marks the head it approved.
    // gate.ts asserted this in prose; now it refuses.
    const { gate, executor } = harness();
    for (const event of ["APPROVE", "REQUEST_CHANGES", ""]) {
      const bad = { ...note(), body: { commit_id: HEAD, event, body: "x" } };
      await expect(gate.execute(bad), event).rejects.toThrow(
        /reviewPurpose .* only allowed on a create_review with event COMMENT/,
      );
    }
    // Nor on another kind.
    await expect(
      gate.execute({ ...note(), kind: "create_review_comment_reply", body: { event: "COMMENT" } }),
    ).rejects.toThrow(/only allowed on a create_review/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("the PRE-guard half of that check binds on a gate with NO guard installed", async () => {
    // re-review, N5: with only the post-guard check, deleting the
    // pre-guard call passed the whole suite — and on a gate with no guard
    // (nothing runs between the two) a purposed APPROVE executed FOR REAL.
    // `wire.ts` always calls setGuard, so there was no live risk; half a
    // defence-in-depth belt being silently deletable is the defect.
    const executor = vi.fn(async () => ({ id: 1 }));
    const dryrunDir = mkdtempSync(join(tmpdir(), "qcr-esc-noguard-"));
    const bare = new MutationGate(
      false,
      dryrunDir,
      executor as unknown as (i: MutationIntent) => Promise<unknown>,
    );
    await expect(
      bare.execute({ ...note(), body: { commit_id: HEAD, event: "APPROVE", body: "x" } }),
    ).rejects.toThrow(/reviewPurpose/);
    expect(executor).not.toHaveBeenCalled();
    rmSync(dryrunDir, { recursive: true, force: true });
  });

  it("a guard cannot rewrite a purposed COMMENT into something the exemptions do not cover", async () => {
    // The entry check runs before the guards, and guard 1 really does rewrite
    // the event — so the check runs again on what the guards hand back.
    const { gate, executor } = harness();
    gate.setGuard({
      before: async (i) => ({
        intent: { ...i, body: { commit_id: HEAD, event: "APPROVE", body: "x" } },
      }),
    });
    await expect(gate.execute(note())).rejects.toThrow(/reviewPurpose/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("both escalation mutations are suppressed in dry-run", async () => {
    const { gate, executor, dryrunDir } = harness(true);
    expect((await gate.execute(note())).executed).toBe(false);
    const req: MutationIntent = {
      kind: "request_reviewer",
      method: "POST",
      path: "/repos/o/r/pulls/7/requested_reviewers",
      body: { reviewers: ["teammate-one"] },
      note: "escalation request on #7",
      pr: 7,
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
    expect(() =>
      parseEscalation({
        enabled: true,
        targets: [],
        rules: [{ name: "r", to: "x", why: "w", paths: ["**"] }],
      }),
    ).toThrow(/no `targets`/);
  });

  it("on with nothing that can fire does not load", () => {
    expect(() => parseEscalation({ enabled: true, targets: ["teammate-one"] })).toThrow(
      /nothing could ever escalate/,
    );
    // …unless session judgement is the trigger, which is a real answer.
    expect(
      parseEscalation({ enabled: true, targets: ["teammate-one"], session_judgement: true })
        .enabled,
    ).toBe(true);
  });

  it("a rule pointing outside the target list does not load", () => {
    expect(() =>
      parseEscalation({
        enabled: true,
        targets: ["teammate-one"],
        rules: [{ name: "r", to: "stranger", why: "w", paths: ["**"] }],
      }),
    ).toThrow(/not in \[escalation\] targets/);
  });

  it("a rule with no condition, no why, no name, or a duplicate name does not load", () => {
    const base = { enabled: true, targets: ["t"] };
    expect(() => parseEscalation({ ...base, rules: [{ name: "r", to: "t", why: "w" }] })).toThrow(
      /declares no condition/,
    );
    expect(() =>
      parseEscalation({ ...base, rules: [{ name: "r", to: "t", paths: ["**"] }] }),
    ).toThrow(/needs a `why`/);
    expect(() =>
      parseEscalation({ ...base, rules: [{ to: "t", why: "w", paths: ["**"] }] }),
    ).toThrow(/needs a `name`/);
    expect(() =>
      parseEscalation({
        ...base,
        rules: [
          { name: "r", to: "t", why: "w", paths: ["**"] },
          { name: "r", to: "t", why: "w", labels: ["x"] },
        ],
      }),
    ).toThrow(/duplicate rule name/);
  });

  it("rejects a bad shape, a bad severity floor, a bad cap and a non-login target", () => {
    const base = {
      enabled: true,
      targets: ["t"],
      rules: [{ name: "ok", to: "t", why: "w", paths: ["**"] }],
    };
    expect(() => parseEscalation({ ...base, shape: "email" })).toThrow(/shape must be/);
    expect(() =>
      parseEscalation({
        ...base,
        rules: [{ name: "r", to: "t", why: "w", min_severity: "URGENT" }],
      }),
    ).toThrow(/min_severity must be/);
    expect(() => parseEscalation({ ...base, max_per_pr: 0 })).toThrow(/max_per_pr/);
    expect(() => parseEscalation({ ...base, max_per_pr: 1.5 })).toThrow(/max_per_pr/);
    expect(() => parseEscalation({ ...base, targets: ["not a login!"] })).toThrow(
      /is not a GitHub login/,
    );
  });

  it("a switched-off table is a DRAFT — a half-written rule cannot wedge startup", () => {
    // review, F8. Both docs call a switched-off table a draft; before
    // the fix the rule-shape checks ran ahead of the early return, so a rule
    // an operator was still writing threw out of parseConfig — i.e. the daemon
    // would not boot — with the feature OFF.
    const drafts = [
      { enabled: false, rules: [{ name: "half-written", to: "someone", paths: ["src/**"] }] }, // no `why` yet
      { enabled: false, rules: [{ name: "thinking", to: "someone", why: "because" }] }, // no condition yet
      { enabled: false, rules: [{ to: "someone", why: "w", paths: ["**"] }] }, // no name yet
      { enabled: false, shape: "email" },
      { enabled: false, max_per_pr: 0 },
      { enabled: false, targets: ["not a login!"] },
      {
        enabled: false,
        targets: ["someone"],
        rules: [{ name: "r", to: "nobody-listed", why: "w", paths: ["**"] }],
      },
    ];
    for (const draft of drafts) {
      expect(() => parseEscalation(draft), JSON.stringify(draft)).not.toThrow();
      expect(parseEscalation(draft).enabled).toBe(false);
    }
    // …and every one of them is refused the moment the switch is flipped, so
    // "draft" is never a way to smuggle a broken live config past validation.
    for (const draft of drafts) {
      expect(() => parseEscalation({ ...draft, enabled: true }), JSON.stringify(draft)).toThrow();
    }
  });

  it("normalises an operator's leading @, which is not a configuration error", () => {
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
          {
            key: "f1",
            lens: "pass-security",
            path: "billing/charge.py",
            line: 20,
            severity: "P1",
            disposition: "posted",
            reason: "unbounded retry",
          },
          { key: "f2", lens: "pass-style", path: "x.py", severity: "nit", disposition: "killed" },
        ],
      }),
    );
    const reviews: Array<{ pr: number; payload: { body: string } }> = [];
    const adapter: VerdictAdapter = {
      async addLabel() {
        return { executed: true };
      },
      async removeLabel() {
        return { executed: true };
      },
      async listPrFiles() {
        return [{ filename: "billing/charge.py" }];
      },
      async getPr() {
        return { labels: [] };
      },
      async createReview(pr, payload) {
        reviews.push({ pr, payload });
        return { executed: true };
      },
    };
    const hooks: SessionHooks = {
      async dispatchRound() {},
      async inject() {},
      async injectOverseer() {},
      async archiveAndClose() {},
    };
    s.setAnomalySink(() => {});
    s.upsertPr({
      number: 50,
      state: "reviewing",
      head_sha: HEAD,
      title: "T",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    s.startRound(50, "first", ["pass-security"], cfg.daemon.round_deadline_min);
    writeFileSync(
      join(dir, "pr-50-round-1.json"),
      JSON.stringify({
        pr: 50,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        head_sha: HEAD,
        finished_at: "2026-08-31T12:00:00Z",
      }),
    );
    const w = new VerdictWatcher({
      cfg: {
        ...cfg,
        escalation: on({
          targets: ["teammate-two"],
          rules: [
            {
              name: "blockers",
              to: "teammate-two",
              why: "you triage severe findings",
              min_severity: "P1",
            },
          ],
        }),
      },
      store: s,
      adapter,
      hooks,
      verdictDir: dir,
      root: dir,
      findingsDir,
      usage: { globalStoreDir: null },
      parseRetries: 0,
      retryDelayMs: 1,
      ledgerCheckDelayMs: 0,
    });
    await w.sweep();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.payload.body).toContain("@teammate-two");
    expect(reviews[0]!.payload.body).toContain("billing/charge.py");
    expect(reviews[0]!.payload.body).toContain("REQUEST_CHANGES");
    // The verdict itself landed untouched.
    expect(s.roundsFor(50)[0]!.verdict).toBe("REQUEST_CHANGES");
    // No receipt was written, so the note must NOT claim the review is posted.
    expect(reviews[0]!.payload.body).not.toContain("already decided and posted");
    expect(reviews[0]!.payload.body).toContain("not confirmed on this pull request yet");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // re-review, N6: `roundReviewConfirmed` was unpinned — `return true`
  // passed the whole suite. These two drive the REAL receipt reader through the
  // real verdict path, over the branches that decide the note's wording.
  it("the note says POSTED when the round's posting receipt confirms it, and not otherwise", async () => {
    async function noteFor(receipt: Record<string, unknown> | null): Promise<string> {
      const s = new StateStore(":memory:");
      const dir = mkdtempSync(join(tmpdir(), "qcr-esc-receipt-"));
      const reviews: Array<{ body: string }> = [];
      const adapter: VerdictAdapter = {
        async addLabel() {
          return { executed: true };
        },
        async removeLabel() {
          return { executed: true };
        },
        async listPrFiles() {
          return [{ filename: "billing/charge.py" }];
        },
        async getPr() {
          return { labels: [] };
        },
        async createReview(_pr, payload) {
          reviews.push({ body: payload.body });
          return { executed: true };
        },
      };
      const hooks: SessionHooks = {
        async dispatchRound() {},
        async inject() {},
        async injectOverseer() {},
        async archiveAndClose() {},
      };
      s.setAnomalySink(() => {});
      s.upsertPr({
        number: 60,
        state: "reviewing",
        head_sha: HEAD,
        title: "T",
        author: "a",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      s.startRound(60, "first", ["pass-baseline"], cfg.daemon.round_deadline_min);
      if (receipt) {
        const rdir = join(dir, "state", "posting-receipts");
        mkdirSync(rdir, { recursive: true });
        writeFileSync(join(rdir, "pr-60-round-1.json"), JSON.stringify(receipt));
      }
      writeFileSync(
        join(dir, "pr-60-round-1.json"),
        JSON.stringify({
          pr: 60,
          round_no: 1,
          verdict: "REQUEST_CHANGES",
          head_sha: HEAD,
          finished_at: "2026-08-31T12:00:00Z",
        }),
      );
      const w = new VerdictWatcher({
        cfg: {
          ...cfg,
          escalation: on({
            targets: ["teammate-one"],
            rules: [{ name: "all", to: "teammate-one", why: "w", paths: ["**"] }],
          }),
        },
        store: s,
        adapter,
        hooks,
        verdictDir: dir,
        root: dir,
        usage: { globalStoreDir: null },
        parseRetries: 0,
        retryDelayMs: 1,
        ledgerCheckDelayMs: 0,
      });
      await w.sweep();
      s.close();
      rmSync(dir, { recursive: true, force: true });
      expect(reviews).toHaveLength(1);
      return reviews[0]!.body;
    }

    const key = roundPostingKey(60, 1, HEAD);
    const base = {
      version: 1,
      posting_key: key,
      marker: postingMarker(key),
      pr: 60,
      round_no: 1,
      head_sha: HEAD,
      intended_event: "REQUEST_CHANGES",
      actual_event: "REQUEST_CHANGES",
      payload_sha256: "a".repeat(64),
      prepared_at: "2026-08-31T11:59:00Z",
    };
    /** The extra fields `parsePostingReceipt` demands of a confirmed receipt. */
    const confirmed = {
      status: "confirmed",
      confirmed_at: "2026-08-31T12:00:00Z",
      gh_review_id: 1,
      gh_commit_id: HEAD,
      gh_state: "CHANGES_REQUESTED",
    };

    // CONFIRMED ⇒ the note may say the review is posted.
    expect(await noteFor({ ...base, ...confirmed })).toContain("already decided and posted");

    // Every other branch must NOT claim it: no receipt at all, a receipt still
    // only prepared, a dry-run receipt, and one belonging to another head.
    for (const [label, r] of [
      ["no receipt", null],
      ["prepared only", { ...base, status: "prepared" }],
      ["dry-run", { ...base, status: "dryrun", confirmed_at: "2026-08-31T12:00:00Z" }],
      // A confirmed receipt for a DIFFERENT head or round must not be read as
      // this round's proof.
      [
        "other head",
        {
          ...base,
          ...confirmed,
          head_sha: "0".repeat(40),
          gh_commit_id: "0".repeat(40),
          posting_key: roundPostingKey(60, 1, "0".repeat(40)),
          marker: postingMarker(roundPostingKey(60, 1, "0".repeat(40))),
        },
      ],
      ["other round", { ...base, ...confirmed, round_no: 9 }],
    ] as Array<[string, Record<string, unknown> | null]>) {
      const body = await noteFor(r);
      expect(body, label).not.toContain("already decided and posted");
      expect(body, label).toContain("not confirmed on this pull request yet");
    }
  });
});
