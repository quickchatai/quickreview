import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_SELF_CONFIG_KINDS,
  GUARD_REWRITABLE_FIELDS,
  MUTATION_KINDS,
  MutationGate,
  type MutationIntent,
} from "../src/gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-gate-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const intent: MutationIntent = {
  kind: "add_label",
  method: "POST",
  path: "/repos/o/r/issues/7/labels",
  body: { labels: ["AI review in progress"] },
  note: 'add label "AI review in progress" to #7',
  pr: 7,
};

describe("MutationGate in dry-run", () => {
  it("writes the intent to a file and never calls the executor", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);

    const result = await gate.execute(intent);

    expect(gate.isDryRun).toBe(true);
    expect(executor).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(result.response).toBeUndefined();
    expect(result.dryRunFile).toBeTruthy();

    const record = JSON.parse(readFileSync(result.dryRunFile!, "utf8"));
    expect(record).toMatchObject({
      kind: "add_label",
      method: "POST",
      path: "/repos/o/r/issues/7/labels",
      body: { labels: ["AI review in progress"] },
      pr: 7,
    });
    expect(record.note).toContain("#7");
    expect(typeof record.recorded_at).toBe("string");
  });

  it("names files by timestamp + sequence + kind, one per intent", async () => {
    const gate = new MutationGate(
      true,
      join(dir, "dryrun"),
      async () => undefined,
      () => new Date("2026-08-13T10:00:00.000Z"),
    );
    await gate.execute(intent);
    await gate.execute({ ...intent, kind: "remove_label", method: "DELETE" });

    const files = readdirSync(join(dir, "dryrun")).sort();
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith("-add_label.json"))).toBe(true);
    expect(files.some((f) => f.endsWith("-remove_label.json"))).toBe(true);
    for (const f of files) expect(f.startsWith("2026-08-13T10-00-00-000Z-")).toBe(true);
  });

  it("creates the dryrun directory on demand", async () => {
    const nested = join(dir, "state", "dryrun");
    expect(existsSync(nested)).toBe(false);
    await new MutationGate(true, nested, async () => undefined).execute(intent);
    expect(existsSync(nested)).toBe(true);
  });
});

describe("MutationGate live", () => {
  it("calls the executor, returns its response, and writes nothing", async () => {
    const executor = vi.fn(async (i: MutationIntent) => ({ echoed: i.path }));
    const dryrunDir = join(dir, "dryrun");
    const gate = new MutationGate(false, dryrunDir, executor);

    const result = await gate.execute(intent);

    expect(gate.isDryRun).toBe(false);
    expect(executor).toHaveBeenCalledOnce();
    // Equal, not identical: the executor receives the gate's frozen snapshot
    // of the admitted intent, never the caller's object.
    expect(executor.mock.calls[0]![0]).toEqual(intent);
    expect(executor.mock.calls[0]![0]).not.toBe(intent);
    expect(Object.isFrozen(executor.mock.calls[0]![0])).toBe(true);
    expect(result).toEqual({ executed: true, response: { echoed: "/repos/o/r/issues/7/labels" } });
    expect(existsSync(dryrunDir)).toBe(false);
  });

  it("propagates executor failures", async () => {
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => {
      throw new Error("422 unprocessable");
    });
    await expect(gate.execute(intent)).rejects.toThrow(/422/);
  });
});

describe("the closed mutation vocabulary", () => {
  it("enumerates only the intended kinds — no review-retraction kind exists", () => {
    expect([...MUTATION_KINDS].sort()).toEqual(
      [
        "add_label",
        "create_issue",
        "create_pull",
        "create_review",
        "create_review_comment_reply",
        "create_issue_comment",
        "delete_team_review_request",
        "push_branch",
        "remove_label",
        // Reviewer nomination, back on 2026-08-31 as the optional escalation
        // feature's second delivery shape (ratified rule-10
        // amendment). ORDINARY in every respect — see the describe below.
        "request_reviewer",
        // Bot-owned inline threads may be resolved after a checked author
        // response; this does not alter or dismiss a review verdict.
        "resolve_own_review_thread",
        // The one review-verdict-mutating kind, ratified by the owner 2026-08-13:
        // the bot superseding ITS OWN stale non-APPROVED review. No kind
        // for dismissing approvals or another identity's review exists.
        "supersede_own_review",
        // The one app-self-config kind (ratified rule-1 amendment, 2026-08-30):
        // the App re-pointing ITS OWN webhook URL. Never touches the repo.
        "update_own_webhook_url",
      ].sort(),
    );
    // Rule 2, untouched by and pinned here where it is easiest to
    // read: no kind dismisses a review or an approval. `supersede_own_review`
    // is the ONE review-verdict-mutating kind and the adapter owner-guards it.
    for (const gone of ["dismiss_review", "delete_review", "update_review", "dismiss_approval"]) {
      expect(MUTATION_KINDS).not.toContain(gone);
    }
  });

  it("the runtime list matches the compile-time union, so neither can drift", () => {
    const src = readFileSync(new URL("../src/gate.ts", import.meta.url), "utf8");
    const union = src
      .slice(
        src.indexOf("export type MutationKind"),
        src.indexOf("/**\n * The same set at RUNTIME"),
      )
      .split("\n")
      .filter((l) => !l.trim().startsWith("//")) // comments name retired kinds
      .join("\n");
    const declared = [
      ...new Set((union.match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, ""))),
    ];
    expect(declared.sort()).toEqual([...MUTATION_KINDS].sort());
  });

  it("rejects an unknown kind at runtime, recording nothing", async () => {
    // NB the constructor call: this test used to pass an OBJECT to a
    // positional constructor (found it), so `dryrunDir` was
    // `undefined` and the "recording nothing" assertion held because the
    // gate could not have written anywhere in the first place. Positional and
    // real now — the refusal is what stops the write.
    const dir = mkdtempSync(join(tmpdir(), "qcr-gate-kind-"));
    const executor = vi.fn(async () => ({}));
    const gate = new MutationGate(true, dir, executor);
    await expect(
      gate.execute({
        kind: "dismiss_review" as never,
        method: "PUT",
        path: "/x",
        note: "smuggled",
        pr: 1,
      }),
    ).rejects.toThrow(/unknown mutation kind/);
    expect(executor).not.toHaveBeenCalled();
    expect(existsSync(dir) ? readdirSync(dir) : []).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * reviewer nomination is back, and back as an ORDINARY kind.
 *
 * The whole point of these assertions is that there is nothing to say about
 * `request_reviewer` beyond "it behaves like `add_label`". The two ratified
 * dry-run exceptions did NOT widen to take it in, and the sweep in the
 * app-self-config describe below (every kind but one is suppressed in dry-run)
 * covers it automatically because it walks MUTATION_KINDS.
 */
describe("request_reviewer — the escalation feature's second delivery shape", () => {
  const request: MutationIntent = {
    kind: "request_reviewer",
    method: "POST",
    path: "/repos/o/r/pulls/7/requested_reviewers",
    body: { reviewers: ["teammate-one"] },
    note: "escalation: request review from @teammate-one on #7",
    pr: 7,
  };

  it("is suppressed to state/dryrun in dry-run, like every ordinary kind", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const result = await gate.execute(request);
    expect(executor).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(JSON.parse(readFileSync(result.dryRunFile!, "utf8"))).toMatchObject({
      kind: "request_reviewer",
      pr: 7,
    });
  });

  it("executes through the ONE executor in live mode", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    expect((await gate.execute(request)).executed).toBe(true);
    expect(executor).toHaveBeenCalledOnce();
  });

  it("forceLive THROWS on it — the supersede_own_review bypass is still the only one", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    await expect(gate.execute({ ...request, forceLive: true })).rejects.toThrow(
      /forceLive is not allowed/,
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("is NOT in the app-self-config class — that set is still exactly one kind", () => {
    expect(APP_SELF_CONFIG_KINDS as readonly string[]).not.toContain("request_reviewer");
    expect([...APP_SELF_CONFIG_KINDS]).toEqual(["update_own_webhook_url"]);
  });

  it("cannot ride the git performer seam", async () => {
    const perform = vi.fn(async () => ({ smuggled: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}));
    await expect(gate.execute({ ...request, method: "git" }, perform)).rejects.toThrow(
      /only allowed for kind "push_branch"/,
    );
    expect(perform).not.toHaveBeenCalled();
  });

  it("a posting guard can refuse it, and then it never happens", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard({ before: async () => ({ block: "pr-merged" }) });
    expect(await gate.execute(request)).toMatchObject({ executed: false, blocked: "pr-merged" });
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("forceLive (supersede_own_review only — the owner, 2026-08-13)", () => {
  const supersede: MutationIntent = {
    kind: "supersede_own_review",
    method: "PUT",
    path: "/repos/o/r/pulls/7/reviews/99/dismissals",
    body: { message: "superseded by round 4 review" },
    note: "supersede own stale RC review on #7",
    pr: 7,
    forceLive: true,
  };

  it("executes supersede_own_review for real even in dry-run (no dryrun record)", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const result = await gate.execute(supersede);
    expect(executor).toHaveBeenCalledOnce();
    expect(result.executed).toBe(true);
    expect(existsSync(join(dir, "dryrun"))).toBe(false);
  });

  it("refuses forceLive on every other kind — the dry-run bypass cannot widen", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    for (const kind of ["add_label", "create_review", "push_branch", "create_pull"] as const) {
      await expect(gate.execute({ ...intent, kind, forceLive: true })).rejects.toThrow(
        /forceLive is not allowed/,
      );
    }
    expect(executor).not.toHaveBeenCalled();
  });

  it("without forceLive, supersede_own_review dry-runs like everything else", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const result = await gate.execute({ ...supersede, forceLive: undefined });
    expect(executor).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(readdirSync(join(dir, "dryrun"))).toHaveLength(1);
  });
});

describe("the app-self-config gate class (ratified rule-1 amendment, 2026-08-30)", () => {
  const repoint: MutationIntent = {
    kind: "update_own_webhook_url",
    method: "PATCH",
    path: "/app/hook/config",
    body: { url: "https://new.trycloudflare.com/webhook" },
    note: "re-point own App webhook URL https://old.trycloudflare.com/webhook → https://new.trycloudflare.com/webhook",
  };

  it("is a CLOSED SET containing exactly update_own_webhook_url — adding a second kind fails here", () => {
    // Mirrors the forceLive pin: widening the class is the owner's ratification,
    // never an edit that survives CI. Deep equality, not containment.
    expect([...APP_SELF_CONFIG_KINDS]).toEqual(["update_own_webhook_url"]);
  });

  it("every class member is a declared mutation kind", () => {
    for (const kind of APP_SELF_CONFIG_KINDS) expect(MUTATION_KINDS).toContain(kind);
  });

  it("the session shell route never learns this kind — only the daemon self-configures the App", () => {
    // The shell mirror needs no change precisely because sessions have no
    // business here; this pins that they never grew one.
    for (const script of ["post-review.sh", "approve-pr.sh", "reply-thread.sh", "guards.sh"]) {
      const body = readFileSync(join(process.cwd(), "scripts", script), "utf8");
      for (const kind of APP_SELF_CONFIG_KINDS) expect(body).not.toContain(kind);
      expect(body).not.toContain("/app/hook/config");
    }
  });

  it("executes update_own_webhook_url FOR REAL in dry-run, writing no dryrun record", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const log = vi.fn();
    const gate = new MutationGate(true, join(dir, "dryrun"), executor, undefined, undefined, log);
    const result = await gate.execute(repoint);
    expect(executor).toHaveBeenCalledOnce();
    expect(result.executed).toBe(true);
    expect(existsSync(join(dir, "dryrun"))).toBe(false);
  });

  it("logs loudly on every execution, naming old and new URL via the note", async () => {
    const log = vi.fn();
    const gate = new MutationGate(
      true,
      join(dir, "dryrun"),
      async () => ({}),
      undefined,
      undefined,
      log,
    );
    await gate.execute(repoint);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain("APP-SELF-CONFIG");
    expect(line).toContain("update_own_webhook_url");
    expect(line).toContain("despite dry_run");
    expect(line).toContain("https://old.trycloudflare.com/webhook");
    expect(line).toContain("https://new.trycloudflare.com/webhook");
  });

  it("logs loudly in live mode too (without the dry-run wording)", async () => {
    const log = vi.fn();
    const gate = new MutationGate(
      false,
      join(dir, "dryrun"),
      async () => ({}),
      undefined,
      undefined,
      log,
    );
    await gate.execute(repoint);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain("APP-SELF-CONFIG");
    expect(line).not.toContain("despite dry_run");
  });

  it("EVERY other kind stays suppressed to state/dryrun in dry-run — adversarial sweep", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const others = MUTATION_KINDS.filter(
      (k) => !(APP_SELF_CONFIG_KINDS as readonly string[]).includes(k),
    );
    expect(others.length).toBe(MUTATION_KINDS.length - 1);
    for (const kind of others) {
      const result = await gate.execute({ ...intent, kind });
      expect(result.executed).toBe(false);
      expect(result.dryRunFile).toBeTruthy();
    }
    expect(executor).not.toHaveBeenCalled();
    expect(readdirSync(join(dir, "dryrun"))).toHaveLength(others.length);
  });

  it("forceLive on update_own_webhook_url still throws — the forceLive exception did not widen", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    await expect(gate.execute({ ...repoint, forceLive: true })).rejects.toThrow(
      /forceLive is not allowed/,
    );
    expect(executor).not.toHaveBeenCalled();
  });

  it("unknown kinds are still rejected, and no NEW kind joined the class", async () => {
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => ({}));
    for (const kind of ["update_app_config", "dismiss_review", "set_app_permissions"]) {
      await expect(
        gate.execute({
          kind: kind as never,
          method: "PATCH",
          path: "/app/hook/config",
          note: "smuggled",
        }),
      ).rejects.toThrow(/unknown mutation kind/);
    }
    expect(existsSync(join(dir, "dryrun"))).toBe(false);
    // added `request_reviewer` as an ORDINARY kind: it is real, and it
    // is not in the class that executes in dry-run.
    expect(MUTATION_KINDS).toContain("request_reviewer");
    expect(APP_SELF_CONFIG_KINDS as readonly string[]).not.toContain("request_reviewer");
  });
});

/**
 * / MC-07 — the gate genuinely mediates `method: "git"` pushes.
 *
 * `src/gate.ts`'s header has always claimed it covers "REST, GraphQL or git
 * push". It did not: `GitHubAdapter.executeMutation` throws on `method: "git"`,
 * so `src/improvements.ts` consulted the gate ONLY when `isDryRun` was true and
 * shelled straight to `git push` otherwise — the one mode in which the push was
 * real was the one mode the gate never saw. The honest shape chosen (rather
 * than softening the header) is a caller-supplied performer that the GATE, not
 * the call site, decides whether to run.
 */
describe("MutationGate — git pushes", () => {
  const push: MutationIntent = {
    kind: "push_branch",
    method: "git",
    path: "git push origin wip:refs/heads/bot/improve-x",
    body: { remote: "origin", source: "wip", target: "bot/improve-x" },
    note: "push bot/improve-x",
  };

  it("runs the performer in LIVE mode — the push happens through the gate, not around it", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);

    const result = await gate.execute(push, perform);

    expect(perform).toHaveBeenCalledTimes(1);
    // The REST executor is never the one that pushes — it throws on "git".
    expect(executor).not.toHaveBeenCalled();
    expect(result.executed).toBe(true);
    expect(result.response).toEqual({ pushed: true });
  });

  it("does NOT run the performer in dry-run — it records the intent instead", async () => {
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => ({}));

    const result = await gate.execute(push, perform);

    expect(perform).not.toHaveBeenCalled();
    expect(result.executed).toBe(false);
    expect(JSON.parse(readFileSync(result.dryRunFile!, "utf8"))).toMatchObject({
      kind: "push_branch",
      method: "git",
    });
  });

  it("a guard can refuse the push, and then it never happens", async () => {
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}));
    gate.setGuard({ before: async () => ({ block: "pr-closed" }) });

    const result = await gate.execute(push, perform);

    expect(perform).not.toHaveBeenCalled();
    expect(result).toMatchObject({ executed: false, blocked: "pr-closed" });
  });

  it("the performer seam is push_branch-only — method alone is not enough", async () => {
    // `method` is a free field with no relation to `kind`, so a hand-rolled
    // intent could otherwise claim `method: "git"` for any kind and ride the
    // performer instead of the REST executor.
    const executor = vi.fn(async () => ({ ok: true }));
    const perform = vi.fn(async () => ({ smuggled: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);

    await expect(gate.execute({ ...push, kind: "create_review", pr: 7 }, perform)).rejects.toThrow(
      /only allowed for kind "push_branch"/,
    );
    expect(perform).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("a guard cannot rewrite a git intent into something else and still get the performer run", async () => {
    // The entry checks run BEFORE the guard, and a guard may return a rewritten
    // `decision.intent` (guard 1 does exactly that). Since the rewrite
    // is refused at the seam itself — a guard may change only body and note —
    // so the performer is never turned loose on a mutation nobody approved as
    // a push (see the describe below for the whole contract).
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}));
    gate.setGuard({
      before: async () => ({ intent: { ...intent, kind: "create_review", method: "POST" } }),
    });

    await expect(gate.execute(push, perform)).rejects.toThrow(
      /a guard may rewrite only body and note/,
    );
    expect(perform).not.toHaveBeenCalled();
  });

  it("the performer seam cannot widen: it is refused for any method but git", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const perform = vi.fn(async () => ({ smuggled: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);

    // `intent` is the ordinary REST add_label at the top of this file.
    await expect(gate.execute(intent, perform)).rejects.toThrow(/only allowed for method "git"/);
    expect(perform).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("an unknown kind is still rejected before the performer is even considered", async () => {
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}));
    await expect(
      gate.execute({ ...push, kind: "push_to_master" as never }, perform),
    ).rejects.toThrow(/unknown mutation kind/);
    expect(perform).not.toHaveBeenCalled();
  });

  it("forceLive on a push still throws — the git seam did not widen the dry-run bypass", async () => {
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => ({}));
    await expect(gate.execute({ ...push, forceLive: true }, perform)).rejects.toThrow(
      /forceLive is not allowed/,
    );
    expect(perform).not.toHaveBeenCalled();
  });
});

/**
 * a guard may soften a mutation, never change which one it is.
 *
 * Found by the audit re-verification, BY EXECUTION: `execute()` ran
 * the kind list, the forceLive check and the performer checks on the caller's
 * intent, then let a guard hand back a rewritten one, then re-checked only
 * `reviewPurpose` and the performer's method/kind on what came back. Three
 * hostile rewrites therefore went through — a dismissal kind EXECUTED; a
 * rewrite into `update_own_webhook_url` EXECUTED FOR REAL in dry-run; a
 * `forceLive` added to a `create_review` EXECUTED LIVE in dry-run. Latent (the
 * shipped guards rewrite `body` and `note` only), but rule 2 is meant to be
 * structural and dry-run is the one belt an operator has during bring-up.
 *
 * Two independent belts close it, and the tests below tell them apart:
 * `GUARD_REWRITABLE_FIELDS` (a guard may change ONLY body and note — the
 * method/path/pr cases are caught by nothing else) and re-admission of the
 * post-guard intent in full. Each case below drives a HOSTILE guard through
 * the real gate, and each was verified by mutation — removing the post-guard
 * `guardRewriteCheck` + `admit` pair in `src/gate.ts` turns every one red.
 *
 * Round-1 review of the fix found the belts guarded only what a guard
 * RETURNED: the guard was handed the admitted object by reference, so
 * `intent.kind = "dismiss_review"; return {}` — and `return { intent }` with
 * the same mutated reference, which compared an object with itself — still
 * executed through the compiled gate. The gate now hands the guard a FROZEN
 * snapshot and copies what comes back before comparing; the "in place" and
 * "read once" cases below pin that, and removing the `Object.freeze` / the
 * spread copy in `execute` turns them red. The re-review of that fix found the
 * snapshot's `body` was still the caller's object by reference, so a getter
 * inside a returned body answered the reviewPurpose check with COMMENT and the
 * executor with APPROVE; `snapshot` now clones the body too, and the two
 * "body" cases below go red without the clone.
 */
describe("a guard may rewrite only body and note", () => {
  const review: MutationIntent = {
    kind: "create_review",
    method: "POST",
    path: "/repos/o/r/pulls/7/reviews",
    body: { commit_id: "abc1234", event: "REQUEST_CHANGES", body: "one blocker" },
    note: "post REQUEST_CHANGES review on #7",
    pr: 7,
  };
  /** A guard that returns the same intent with the given fields overridden. */
  const hostile = (over: Partial<Record<keyof MutationIntent, unknown>>) => ({
    before: async (i: MutationIntent) => ({ intent: { ...i, ...over } as MutationIntent }),
  });
  const nothingHappened = (executor: ReturnType<typeof vi.fn>) => {
    expect(executor).not.toHaveBeenCalled();
    expect(existsSync(join(dir, "dryrun"))).toBe(false);
  };

  it("the rewritable set is exactly body and note — widening it is a decision, not a diff", () => {
    expect([...GUARD_REWRITABLE_FIELDS]).toEqual(["body", "note"]);
  });

  it("① kind → dismiss_review in LIVE mode is refused, and the executor never sees it", async () => {
    // Rule 2: no dismissal kind exists. Before this rewrite executed.
    const executor = vi.fn(async () => ({ dismissed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard(
      hostile({
        kind: "dismiss_review",
        method: "PUT",
        path: "/repos/o/r/pulls/7/reviews/99/dismissals",
      }),
    );
    await expect(gate.execute(review)).rejects.toThrow(
      /a guard may rewrite only body and note.*"kind"/,
    );
    nothingHappened(executor);
  });

  it("② kind → update_own_webhook_url in DRY-RUN is refused — the app-self-config class cannot be entered by rewrite", async () => {
    // The class executes for real in dry-run, so this rewrite was a dry-run
    // bypass. `update_own_webhook_url` IS a declared kind and this guard adds
    // no forceLive, so re-admission alone would have let it through: this
    // case is caught by the field list and by nothing else.
    const executor = vi.fn(async () => ({ repointed: true }));
    const log = vi.fn();
    const gate = new MutationGate(true, join(dir, "dryrun"), executor, undefined, undefined, log);
    gate.setGuard(
      hostile({ kind: "update_own_webhook_url", method: "PATCH", path: "/app/hook/config" }),
    );
    await expect(gate.execute(review)).rejects.toThrow(
      /a guard may rewrite only body and note.*"kind"/,
    );
    nothingHappened(executor);
    expect(log).not.toHaveBeenCalled();
    expect([...APP_SELF_CONFIG_KINDS]).toEqual(["update_own_webhook_url"]);
  });

  it("③ forceLive added to a create_review in DRY-RUN is refused — the dry-run bypass cannot be minted by a guard", async () => {
    const executor = vi.fn(async () => ({ posted: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    gate.setGuard(hostile({ forceLive: true }));
    await expect(gate.execute(review)).rejects.toThrow(
      /a guard may rewrite only body and note.*"forceLive"/,
    );
    nothingHappened(executor);
  });

  it("the same kind at a different method/path is refused — the executor sends method+path, not kind", async () => {
    // A kind-only re-check would pass this: `create_review` is a fine kind,
    // and the rewritten request is GitHub's dismissal endpoint.
    const executor = vi.fn(async () => ({ dismissed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard(hostile({ method: "PUT", path: "/repos/o/r/pulls/7/reviews/99/dismissals" }));
    await expect(gate.execute(review)).rejects.toThrow(
      /a guard may rewrite only body and note.*"method"/,
    );
    nothingHappened(executor);
  });

  it("re-pointing the pr or minting a reviewPurpose is refused too — identity, not policy", async () => {
    for (const over of [{ pr: 8 }, { reviewPurpose: "escalation" }] as const) {
      const executor = vi.fn(async () => ({}));
      const gate = new MutationGate(false, join(dir, "dryrun"), executor);
      gate.setGuard(hostile({ ...over, body: { ...(review.body as object), event: "COMMENT" } }));
      await expect(gate.execute(review)).rejects.toThrow(/a guard may rewrite only body and note/);
      nothingHappened(executor);
    }
  });

  it("the post-guard intent is re-admitted in full, independently of the field list", async () => {
    // Guard 1 really does rewrite the event; a rewrite that turns a purposed
    // COMMENT into an APPROVE stays within body and note and is still refused
    // — by admission, not by the field list.
    const executor = vi.fn(async () => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard(hostile({ body: { commit_id: "abc1234", event: "APPROVE", body: "x" } }));
    await expect(
      gate.execute({
        ...review,
        reviewPurpose: "escalation",
        body: { commit_id: "abc1234", event: "COMMENT", body: "x" },
      }),
    ).rejects.toThrow(/reviewPurpose/);
    nothingHappened(executor);
  });

  it("the shipped shape — body and note softened, everything else identical — still goes through", async () => {
    // Positive control: guard 1's downgrade and guard 4's withhold are exactly
    // this rewrite, and the executor receives the rewritten intent.
    const executor = vi.fn(async (_i: MutationIntent) => ({ ok: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    const softened = { ...(review.body as object), event: "COMMENT" };
    gate.setGuard(hostile({ body: softened, note: "post COMMENT review on #7 (downgraded)" }));
    const result = await gate.execute(review);
    expect(result.executed).toBe(true);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]![0]).toEqual({
      ...review,
      body: softened,
      note: "post COMMENT review on #7 (downgraded)",
    });
  });

  /** The IN-PLACE shapes (review round 1): a guard that edits the object it
   * was handed instead of returning a new one — then says "no opinion", or
   * returns that same object. Both executed the edit through the compiled
   * gate before the snapshot: `return {}` skipped both post-guard checks, and
   * the same-reference return compared the object with itself. */
  const inPlace = (edit: (i: Record<string, unknown>) => void, returnSame: boolean) => ({
    before: async (i: MutationIntent) => {
      edit(i as unknown as Record<string, unknown>);
      return returnSame ? { intent: i } : {};
    },
  });
  const dismissals = "/repos/o/r/pulls/7/reviews/99/dismissals";
  const inPlaceEdits: Array<[string, (i: Record<string, unknown>) => void]> = [
    [
      "kind → dismiss_review",
      (i) => {
        i.kind = "dismiss_review";
        i.method = "PUT";
        i.path = dismissals;
      },
    ],
    [
      "kind → update_own_webhook_url",
      (i) => {
        i.kind = "update_own_webhook_url";
        i.method = "PATCH";
        i.path = "/app/hook/config";
      },
    ],
    [
      "forceLive added",
      (i) => {
        i.forceLive = true;
      },
    ],
    [
      "method/path → dismissals, kind kept",
      (i) => {
        i.method = "PUT";
        i.path = dismissals;
      },
    ],
  ];

  it("the guard is handed a FROZEN snapshot: an in-place edit throws inside the guard, for `return {}` and for returning the same reference, live and dry-run", async () => {
    for (const dryRun of [false, true]) {
      for (const returnSame of [false, true]) {
        for (const [name, edit] of inPlaceEdits) {
          const label = `${name} (dryRun=${dryRun}, returnSame=${returnSame})`;
          const executor = vi.fn(async () => ({}));
          const log = vi.fn();
          const gate = new MutationGate(
            dryRun,
            join(dir, "dryrun"),
            executor,
            undefined,
            undefined,
            log,
          );
          gate.setGuard(inPlace(edit, returnSame));
          await expect(gate.execute(review), label).rejects.toThrow(
            /read only property|not extensible/,
          );
          nothingHappened(executor);
          expect(log, label).not.toHaveBeenCalled();
        }
      }
    }
    // And the caller's own object was never the one on the table.
    expect([review.kind, review.method, review.path, "forceLive" in review]).toEqual([
      "create_review",
      "POST",
      "/repos/o/r/pulls/7/reviews",
      false,
    ]);
  });

  it("the returned intent is read ONCE: a getter cannot answer the check with one path and the executor with another", async () => {
    // Without the copy in `execute`, guardRewriteCheck would read the honest
    // path, pass, and hand the executor an object whose next read is the
    // dismissal endpoint.
    const executor = vi.fn(async (_i: MutationIntent) => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard({
      before: async (i) => {
        let reads = 0;
        const shifty: Record<string, unknown> = { ...i };
        Object.defineProperty(shifty, "path", {
          enumerable: true,
          get: () => (reads++ === 0 ? i.path : dismissals),
        });
        return { intent: shifty as unknown as MutationIntent };
      },
    });
    await gate.execute(review);
    expect(executor).toHaveBeenCalledOnce();
    const sent = executor.mock.calls[0]![0] as MutationIntent;
    expect(sent.path).toBe(review.path);
    expect(sent.path).toBe(review.path); // still, on the second read
    expect(Object.getOwnPropertyDescriptor(sent, "path")).toMatchObject({ value: review.path });
  });

  it("…and so is the returned BODY: a getter inside it cannot say COMMENT to the reviewPurpose check and APPROVE to the executor", async () => {
    // Re-review of round 1: the body was copied by reference, so this shape
    // executed a purposed APPROVE — an approval exempt from guard 2 that never
    // claims the head. Without the body clone in `snapshot` the executor sees
    // APPROVE here.
    const purposed: MutationIntent = {
      ...review,
      reviewPurpose: "escalation",
      body: { commit_id: "abc1234", event: "COMMENT", body: "x" },
    };
    const executor = vi.fn(async (_i: MutationIntent) => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard({
      before: async (i) => {
        let reads = 0;
        const body: Record<string, unknown> = { ...(i.body as object) };
        Object.defineProperty(body, "event", {
          enumerable: true,
          get: () => (reads++ === 0 ? "COMMENT" : "APPROVE"),
        });
        return { intent: { ...i, body } };
      },
    });
    await gate.execute(purposed);
    expect(executor).toHaveBeenCalledOnce();
    const sentBody = (executor.mock.calls[0]![0] as MutationIntent).body as Record<string, unknown>;
    expect(sentBody.event).toBe("COMMENT");
    expect(sentBody.event).toBe("COMMENT"); // still, on the second read
    expect(Object.getOwnPropertyDescriptor(sentBody, "event")).toMatchObject({ value: "COMMENT" });
  });

  it("the caller's body is never on the table: a guard's in-place body edit reaches the executor and not the caller", async () => {
    // Body is the guard's to rewrite — in place on its own copy or by return,
    // the executor gets what the guard left. What it must never be is the
    // caller's object: without the clone in the pre-guard `snapshot` this
    // edit lands on `mine.body`.
    const mine: MutationIntent = { ...review, body: { ...(review.body as object) } };
    const executor = vi.fn(async (_i: MutationIntent) => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard({
      before: async (i) => {
        (i.body as Record<string, unknown>).event = "COMMENT";
        return {};
      },
    });
    const result = await gate.execute(mine);
    expect(result.executed).toBe(true);
    expect(
      ((executor.mock.calls[0]![0] as MutationIntent).body as Record<string, unknown>).event,
    ).toBe("COMMENT");
    expect((mine.body as Record<string, unknown>).event).toBe("REQUEST_CHANGES");
    expect((review.body as Record<string, unknown>).event).toBe("REQUEST_CHANGES");
  });

  it("the comparison is SameValue: a field the guard never touched is not blamed on it, NaN included", async () => {
    // `!==` reads NaN as changed and refused an honest no-op guard with
    // '"pr" … (null → null)'. No live path produces a NaN pr; the primitive is
    // simply the right one for "did the guard change this".
    const executor = vi.fn(async (_i: MutationIntent) => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard({ before: async () => ({}) });
    const result = await gate.execute({ ...review, pr: NaN });
    expect(result.executed).toBe(true);
    expect((executor.mock.calls[0]![0] as MutationIntent).pr).toBeNaN();
  });

  it("a field the type does not declare is identity by default: adding one is refused by name", async () => {
    // The check walks the returned object's own keys as strings, so a field
    // `MutationIntent` has never heard of is caught, not assumed absent.
    const executor = vi.fn(async () => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard({ before: async (i) => ({ intent: { ...i, extra: 1 } as MutationIntent }) });
    await expect(gate.execute(review)).rejects.toThrow(
      /a guard may rewrite only body and note.*"extra".*undefined → 1/,
    );
    nothingHappened(executor);
  });

  /** Round-2 review: admission ran on the caller's RAW object, and the
   * snapshot the guards and the executor got was a SECOND read of it. With no
   * guard installed nothing re-admitted that snapshot, so a getter on `kind`
   * that said `create_review` to `admit()` and `dismiss_review` to the spread
   * executed a dismissal through the compiled gate; one on `forceLive` saying
   * `false` then `true` executed for real in dry-run. Same class as
   * itself, one step earlier. The snapshot is now taken FIRST and admitted;
   * swapping the two lines back in `execute` turns both cases red. */
  const readOnce = (over: Record<string, [first: unknown, then: unknown]>): MutationIntent => {
    const shifty: Record<string, unknown> = { ...review };
    for (const [field, [first, then]] of Object.entries(over)) {
      let reads = 0;
      Object.defineProperty(shifty, field, {
        enumerable: true,
        get: () => (reads++ === 0 ? first : then),
      });
    }
    return shifty as unknown as MutationIntent;
  };

  it("with NO guard installed, the entry check and the executor read the same snapshot: a getter on kind cannot pass admission as create_review and execute as dismiss_review", async () => {
    const executor = vi.fn(async (_i: MutationIntent) => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    await gate.execute(readOnce({ kind: ["create_review", "dismiss_review"] }));
    expect(executor).toHaveBeenCalledOnce();
    const sent = executor.mock.calls[0]![0] as MutationIntent;
    expect(sent.kind).toBe("create_review");
    expect(Object.getOwnPropertyDescriptor(sent, "kind")).toMatchObject({ value: "create_review" });
    expect(Object.isFrozen(sent)).toBe(true);
  });

  it("…nor can a getter on forceLive pass admission as false and skip the dry-run branch as true", async () => {
    const executor = vi.fn(async (_i: MutationIntent) => ({}));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const result = await gate.execute(readOnce({ forceLive: [false, true] }));
    expect(result.executed).toBe(false);
    expect(executor).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(result.dryRunFile!, "utf8")).forceLive).toBe(false);
  });

  it("a symbol-keyed field a guard adds is refused like any other: the walk covers every own key the spread copies", async () => {
    // `Object.keys` saw string keys only, while `snapshot`'s spread carries own
    // enumerable symbol keys onto the executed object; the walk is
    // `Reflect.ownKeys` now, and reverting it lets this ride through.
    const executor = vi.fn(async () => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    const tag = Symbol("x");
    gate.setGuard({ before: async (i) => ({ intent: { ...i, [tag]: 1 } as MutationIntent }) });
    await expect(gate.execute(review)).rejects.toThrow(
      /a guard may rewrite only body and note.*"Symbol\(x\)".*undefined → 1/,
    );
    nothingHappened(executor);
  });

  it("a body that is not plain data is refused with the gate's name and the kind on it — from the caller and from a guard alike", async () => {
    // structuredClone throws a bare DataCloneError ("() => 1 could not be
    // cloned.") that names neither the gate nor the mutation; the refusal an
    // operator reads in the log must say which mutation went nowhere.
    const withFn = { ...review, body: { ...(review.body as object), fn: () => 1 } };
    const bare = vi.fn(async () => ({}));
    await expect(
      new MutationGate(false, join(dir, "dryrun"), bare).execute(withFn),
    ).rejects.toThrow(
      /^gate: intent body for create_review is not plain data \(.*could not be cloned.*\) — refusing to execute or record it$/,
    );
    nothingHappened(bare);

    const guarded = vi.fn(async () => ({}));
    const gate = new MutationGate(true, join(dir, "dryrun"), guarded);
    gate.setGuard({
      before: async (i) => ({ intent: { ...i, body: { ...(i.body as object), fn: () => 1 } } }),
    });
    await expect(gate.execute(review)).rejects.toThrow(
      /^gate: intent body for create_review is not plain data/,
    );
    nothingHappened(guarded);
  });

  it("the type is honest about the frozen object: every field is readonly, so a guard that assigns instead of returning does not compile — and would not run", async () => {
    // Round-2 review: `body` and `note` — the two fields a guard is invited to
    // touch — were the only ones still assignable in the type, so a first-party
    // guard writing `intent.note = …` compiled and died inside the guard with
    // a bare TypeError. The `@ts-expect-error`s below are the fence
    // (`npm run typecheck:tests` fails if any of the three assignments
    // compiles); the runtime half shows what such a guard gets.
    const assigning = {
      before: async (i: MutationIntent) => {
        // @ts-expect-error note is readonly — rewrite by returning a new object
        i.note = "softened";
        // @ts-expect-error body is readonly — rewrite by returning a new object
        i.body = {};
        // @ts-expect-error kind is readonly
        i.kind = "create_review";
        return {};
      },
    };
    const executor = vi.fn(async () => ({}));
    const gate = new MutationGate(false, join(dir, "dryrun"), executor);
    gate.setGuard(assigning);
    await expect(gate.execute(review)).rejects.toThrow(/read only property 'note'/);
    nothingHappened(executor);
  });
});
