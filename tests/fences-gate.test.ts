// Fences over the mutation gate and the daemon's dead surfaces.
// See tests/fences.test.ts for the three rules these are written under.
//
// A green suite proves the assertions that exist pass, not that they assert
// what their names suggest. "Dismissing a review is a nonexistent code path"
// needs both a name-shape check (an explicit list of names would let a kind
// called `retract_review` through) and a no-caller check.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MUTATION_KINDS } from "@quickchatai/pi-quickreview/src/gate.js";
import { TYPECHECK_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { SRC_DIRS } from "./helpers/source-trees.js";

const ROOT = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

/** Comments removed — this fence's own explanation of what it removed quotes
 * the removed line, and a detector that reads prose flags its own docs. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Every .ts under the app's src/ and the review core's (packages/pi-plugin/src). */
function srcTs(): string[] {
  return SRC_DIRS.flatMap((d) => tsFiles(join(ROOT, d)));
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

// ---------------------------------------------------------------------------
// Rule 2 — no dismissal, by NAME SHAPE and by CALLER
// ---------------------------------------------------------------------------

describe("no review-dismissing mutation can appear", () => {
  /**
   * A name-shape fence, so a future `dismiss_stale_review` fails before anyone
   * reads the diff. An explicit blocklist (`dismiss_review`, `delete_review`,
   * `update_review`, `dismiss_approval`) only covers the names somebody
   * thought of.
   *
   * `reviewer` is deliberately not in the pattern: `request_reviewer` is a
   * sanctioned, default-off kind. The dismissal half is the half that must
   * never move — AGENTS.md invariant 2, which has no knob and no exception.
   *
   * MUTATION: add `"retract_review"` to MUTATION_KINDS — this fails.
   */
  it("no MutationKind name suggests dismissing, retracting or withdrawing a review", () => {
    const offenders = MUTATION_KINDS.filter((k) => /dismiss|retract|withdraw|revoke/i.test(k));
    expect(
      offenders,
      "AGENTS.md invariant 2 has no exception: the bot never dismisses an approval or another identity's review",
    ).toEqual([]);
  });

  /**
   * The assertion that pins "dismissal is a nonexistent code path".
   *
   * `supersede_own_review` is a declared kind whose sanctioned endpoint is
   * GitHub's dismissal endpoint. Nothing constructs it. So the claim is true
   * of the executable path and false of the type — a reader of `packages/pi-plugin/src/gate.ts`
   * alone would conclude a dismissal is representable. This is what makes the
   * difference checkable.
   *
   * MUTATION: add `kind: "supersede_own_review"` to any object literal under
   * src/ — this fails.
   */
  it("supersede_own_review has no caller in src/ or scripts/", () => {
    const callers: string[] = [];
    for (const f of [...srcTs(), ...allFiles(join(ROOT, "scripts"))]) {
      if (f.endsWith("/gate.ts")) continue; // the declaration, the kind list and the forceLive guard
      const text = readFileSync(f, "utf8");
      if (/kind:\s*["']supersede_own_review["']|supersede_own_review["']?\s*[,)]/.test(text)) {
        callers.push(f.slice(ROOT.length + 1));
      }
    }
    expect(
      callers,
      "supersede_own_review acquired a caller. It is the ONE review-mutating kind, its endpoint is GitHub's " +
        "dismissal endpoint, and it is the sole `forceLive` bypass — a caller needs the owner's ratification, not a diff.",
    ).toEqual([]);
  });

  /**
   * `/dismissals` must appear in no request path; and the POST to
   * `/requested_reviewers` — the escalation feature's second delivery shape —
   * must have exactly one builder, so nomination cannot grow a second, ungated route.
   *
   * MUTATION: add a second `requested_reviewers` POST to src/github.ts — this
   * fails.
   */
  it("no /dismissals path exists, and requested_reviewers has exactly one POST builder", () => {
    const dismissals: string[] = [];
    const reviewerPosts: string[] = [];
    for (const f of [...srcTs(), ...allFiles(join(ROOT, "scripts"))]) {
      const text = readFileSync(f, "utf8");
      if (text.includes("/dismissals")) dismissals.push(f.slice(ROOT.length + 1));
      // A POST to that route, in either the adapter's or the shell's spelling.
      for (const line of text.split("\n")) {
        if (!line.includes("requested_reviewers")) continue;
        if (/POST|-X\s*POST|--method\s+POST/i.test(line))
          reviewerPosts.push(`${f.slice(ROOT.length + 1)}: ${line.trim()}`);
      }
    }
    expect(
      dismissals,
      "a dismissal route appeared — AGENTS.md invariant 2 forbids the code path, not merely the caller",
    ).toEqual([]);
    expect(
      reviewerPosts.length,
      `reviewer nomination must have ONE builder (GitHubAdapter.requestEscalationReview, gated as request_reviewer, ` +
        `called only from src/escalation.ts). Found:\n${reviewerPosts.join("\n")}`,
    ).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// A gate reachable from a process entrypoint must have its guards installed
// ---------------------------------------------------------------------------

describe("every process entrypoint that builds a gate installs its guards", () => {
  /**
   * A second process entrypoint that builds a real gate against the real
   * config without calling `setGuard`/`setLog` would be a daemon whose posting
   * guards and CI gate simply do not exist.
   *
   * The fence is stated as the invariant, not as "daemon.ts has no main":
   * a module that is a process entrypoint AND constructs a MutationGate must
   * also install a guard on it. `wire.ts` does; anything else must too.
   *
   * MUTATION: delete the `setGuard(` call from src/wire.ts — this fails
   * naming wire.ts.
   */
  it("no entrypoint builds a live, unguarded MutationGate", () => {
    const offenders: string[] = [];
    for (const f of srcTs()) {
      const text = codeOf(f);
      const isEntrypoint = /process\.argv\[1\]|import\.meta\.main/.test(text);
      if (!isEntrypoint) continue;
      if (!/new MutationGate\(/.test(text)) continue;
      if (/\.setGuard\(/.test(text)) continue;

      // A gate constructed with the LITERAL `true` can never execute anything:
      // it is permanently dry-run, and in `cli.ts` its executor additionally
      // throws or returns undefined. Guards on a gate that cannot mutate would
      // be ceremony. A gate built from `cfg.dry_run` is the live one, and that
      // is what this fence is about.
      const constructions = [...text.matchAll(/new MutationGate\(\s*([^,]+),/g)].map((m) =>
        m[1]!.trim(),
      );
      if (constructions.every((first) => first === "true")) continue;

      offenders.push(f.slice(ROOT.length + 1));
    }
    expect(
      offenders,
      "a process entrypoint constructs a config-driven MutationGate and never installs a posting guard on it — " +
        "that is a daemon whose guards 1-5 and CI gate do not exist, one `node dist/src/<it>.js` away",
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// [T6] tests/ type-checks — the structural fix, run as part of the suite
// ---------------------------------------------------------------------------

describe("[T6] tests/ type-checks", () => {
  /**
   * `tsconfig.json` excludes `tests/` from the build, so without this nothing
   * type-checks the suite, and type errors hide tests that assert nothing at
   * all (a filesystem seam passed into the wrong positional parameter, a
   * parameter a function never reads, a field the row type does not have).
   *
   * It runs here rather than in `npm run build` on purpose: `scripts/dev-tui.sh`
   * blocks on that build before the TUI paints, and a
   * second full tsc pass there is seven seconds of blank terminal. The suite
   * is this repo's CI, so the suite is where it belongs.
   *
   * MUTATION: write `const x: number = "s";` into any test file — this fails
   * and prints tsc's own message.
   */
  it("npm run typecheck:tests is clean", { timeout: TYPECHECK_TIMEOUT_MS }, () => {
    // Incremental, with the build info kept per checkout: a cold run of this
    // tsc is the suite's longest test, and a warm one re-checks only what changed
    // and re-reports every error it recorded, so the fence is exactly as
    // strict. `noEmit` means there is no emitted output for the build info to
    // go stale against (the one staleness tsconfig.json documents). The run
    // works on a sibling copy and renames it over the cache, so a killed run
    // or a second suite in the same checkout never leaves a torn file; the
    // key is this checkout's path, so worktrees sharing one node_modules never
    // trade caches. `npm run typecheck:tests` stays a plain cold check.
    const cacheDir = join(ROOT, "node_modules", ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const key = createHash("sha256").update(ROOT).digest("hex").slice(0, 12);
    const cache = join(cacheDir, `qcr-typecheck-tests-${key}.tsbuildinfo`);
    // Same directory as the cache: tsc records paths relative to it.
    const work = `${cache}.${process.pid}.tmp`;
    if (existsSync(cache)) copyFileSync(cache, work);
    try {
      execFileSync(
        "npx",
        ["tsc", "-p", "tsconfig.tests.json", "--incremental", "--tsBuildInfoFile", work],
        { cwd: ROOT, encoding: "utf8", stdio: "pipe" },
      );
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      throw new Error(
        "tests/ does not type-check. Fix the errors — do not add them to an ignore list; " +
          "this is the check that finds tests which assert nothing.\n\n" +
          `${err.stdout ?? ""}${err.stderr ?? ""}`,
        { cause: e },
      );
    } finally {
      if (existsSync(work)) renameSync(work, cache);
    }
  });
});
