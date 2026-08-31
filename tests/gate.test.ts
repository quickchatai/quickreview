import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_SELF_CONFIG_KINDS, MUTATION_KINDS, MutationGate, type MutationIntent } from "../src/gate.js";

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
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => undefined, () => new Date("2026-08-13T10:00:00.000Z"));
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
    expect(executor.mock.calls[0]![0]).toBe(intent);
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
      .slice(src.indexOf("export type MutationKind"), src.indexOf("/**\n * The same set at RUNTIME"))
      .split("\n")
      .filter((l) => !l.trim().startsWith("//")) // comments name retired kinds
      .join("\n");
    const declared = [...new Set((union.match(/"[a-z_]+"/g) ?? []).map((s) => s.replace(/"/g, "")))];
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
      gate.execute({ kind: "dismiss_review" as never, method: "PUT", path: "/x", note: "smuggled", pr: 1 }),
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
    expect(JSON.parse(readFileSync(result.dryRunFile!, "utf8"))).toMatchObject({ kind: "request_reviewer", pr: 7 });
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
    await expect(gate.execute({ ...request, forceLive: true })).rejects.toThrow(/forceLive is not allowed/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("is NOT in the app-self-config class — that set is still exactly one kind", () => {
    expect(APP_SELF_CONFIG_KINDS as readonly string[]).not.toContain("request_reviewer");
    expect([...APP_SELF_CONFIG_KINDS]).toEqual(["update_own_webhook_url"]);
  });

  it("cannot ride the git performer seam", async () => {
    const perform = vi.fn(async () => ({ smuggled: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}));
    await expect(gate.execute({ ...request, method: "git" }, perform)).rejects.toThrow(/only allowed for kind "push_branch"/);
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
      await expect(gate.execute({ ...intent, kind, forceLive: true })).rejects.toThrow(/forceLive is not allowed/);
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
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => ({}), undefined, undefined, log);
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
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}), undefined, undefined, log);
    await gate.execute(repoint);
    expect(log).toHaveBeenCalledOnce();
    const line = String(log.mock.calls[0]![0]);
    expect(line).toContain("APP-SELF-CONFIG");
    expect(line).not.toContain("despite dry_run");
  });

  it("EVERY other kind stays suppressed to state/dryrun in dry-run — adversarial sweep", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const gate = new MutationGate(true, join(dir, "dryrun"), executor);
    const others = MUTATION_KINDS.filter((k) => !(APP_SELF_CONFIG_KINDS as readonly string[]).includes(k));
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
    await expect(gate.execute({ ...repoint, forceLive: true })).rejects.toThrow(/forceLive is not allowed/);
    expect(executor).not.toHaveBeenCalled();
  });

  it("unknown kinds are still rejected, and no NEW kind joined the class", async () => {
    const gate = new MutationGate(true, join(dir, "dryrun"), async () => ({}));
    for (const kind of ["update_app_config", "dismiss_review", "set_app_permissions"]) {
      await expect(
        gate.execute({ kind: kind as never, method: "PATCH", path: "/app/hook/config", note: "smuggled" }),
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
    expect(JSON.parse(readFileSync(result.dryRunFile!, "utf8"))).toMatchObject({ kind: "push_branch", method: "git" });
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

    await expect(
      gate.execute({ ...push, kind: "create_review", pr: 7 }, perform),
    ).rejects.toThrow(/only allowed for kind "push_branch"/);
    expect(perform).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  it("a guard cannot rewrite a git intent into something else and still get the performer run", async () => {
    // The entry checks run BEFORE the guard, and a guard may return a rewritten
    // `decision.intent` (guard 1 does exactly that). The re-check at the
    // execute line is what stops a rewrite turning the performer loose on a
    // mutation nobody approved as a push.
    const perform = vi.fn(async () => ({ pushed: true }));
    const gate = new MutationGate(false, join(dir, "dryrun"), async () => ({}));
    gate.setGuard({
      before: async () => ({ intent: { ...intent, kind: "create_review", method: "POST" } }),
    });

    await expect(gate.execute(push, perform)).rejects.toThrow(/a guard rewrote a git intent/);
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
    await expect(gate.execute({ ...push, forceLive: true }, perform)).rejects.toThrow(/forceLive is not allowed/);
    expect(perform).not.toHaveBeenCalled();
  });
});
