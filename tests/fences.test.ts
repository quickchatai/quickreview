// structural fences, so this map does not have to be run again.
//
// Two audits (manifesto compliance,'s dead-surface
// inventory) reached the same conclusion independently: most of what they
// found was UNDETECTABLE BY CONSTRUCTION. A key could be registered with no
// handler, a union member could lose its last producer, a shipped config could
// describe a retired state, and nothing anywhere would notice. What follows
// turns each repeatable check into a permanent test.
//
// THREE RULES THIS FILE IS WRITTEN UNDER, each learned from a fence that
// looked right and proved nothing:
//
//   1. GREP FOR A READER, NEVER FOR A NAME. The charting session's "every
//      config knob is read somewhere" check was mention-based and came back
//      clean while six knobs were parsed and never consumed. A name appears in
//      its own declaration; that is not evidence of use.
//
//   2. A DERIVED SET CAN BE SATISFIED BY A SELF-LOOP. built "every
//      lifecycle state is produced by some transition" and it PASSED with the
//      dead state deliberately re-added, because `track`, `author_reply` and
//      `synchronize` all `return current` — a state with no writer anywhere
//      still "produces" itself. Every fence of the form "every X is reachable
//      from Y" has this shape. The answer here is real reachability (a BFS
//      from the initial state) rather than "has a producer", which is immune
//      to self-loops AND to producer-chains rooted in a dead member.
//
//   3. EVERY FENCE IS VERIFIED BY MUTATION. A fence that cannot be made to
//      fail is not a fence. The mutation that proved each one is named in its
//      comment, so a future reader can re-run it.
//
// Deliberate exemptions live in an explicit, commented allowlist beside the
// fence that would otherwise fail — so a reader can always tell "protected"
// from "overlooked". Where an allowlist can rot, it is checked by SET
// EQUALITY, not by subset: an entry that stopped being load-bearing fails too.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INITIAL_STATE, transition, type SmEvent } from "../src/statemachine.js";
import { CANCEL_CAUSES, type PrLifecycleState } from "../src/state.js";

const ROOT = join(import.meta.dirname, "..");

/** Every .ts under a tree, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

const SRC_FILES = tsFiles(join(ROOT, "src"));

/** Comments removed — a fence that reads prose asserts about prose. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Source with comments removed — a fence that fires on prose gets muted. */
function codeOf(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * The string members of a `export type X = "a" | "b";` union, read out of the
 * SOURCE.
 *
 * TypeScript erases the union, so a runtime list is the only way to iterate
 * one — and reading the declaration rather than a hand-kept mirror is what
 * makes these fences survive a merge that adds or removes a member. Throws
 * loudly if the declaration moved: a fence that silently finds nothing to
 * check is worse than no fence.
 */
function unionMembers(relPath: string, typeName: string): string[] {
  // Comments FIRST. Several of these unions carry a doc comment per member,
  // and the terminator search below stops at the first `;` — a prose
  // semicolon ("The PR advanced mid-round; the session correctly posted
  // nothing") silently truncated `CancelCause` to three of its nine members,
  // and a fence over three members that claims to cover nine is worse than
  // none. Caught only because the truncated read disagreed with the runtime
  // array it was being compared to.
  const text = stripComments(readFileSync(join(ROOT, relPath), "utf8"));
  const m = new RegExp(`export type ${typeName}\\b[^=]*=([\\s\\S]*?);`).exec(text);
  if (!m?.[1]) throw new Error(`union ${typeName} not found in ${relPath} — the fence over it is now vacuous`);
  const members = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  if (members.length === 0) throw new Error(`union ${typeName} in ${relPath} parsed to zero members`);
  return members;
}

// ---------------------------------------------------------------------------
// [T3] Every union member must have a real producer
// ---------------------------------------------------------------------------

describe("[T3] union members have producers", () => {
  /**
   * Reachability, not "has a producer".
   *
   * `transition` is a pure function, so this drives it rather than grepping
   * it: a BFS from `INITIAL_STATE` over every event shape, with every
   * payload variant that changes the outcome. A state is legitimate only if
   * some sequence of events actually LANDS on it.
   *
   * That is deliberately stronger than the obvious version. "Some transition
   * returns this state" is satisfied by `return current` — `track`,
   * `author_reply`, `synchronize` and `human_requested` all do — so a state
   * with no writer in the entire codebase still produces itself, and the fence
   * that exists to catch exactly that member passes. built that
   * version and it passed with the dead state re-added. BFS from the initial
   * state cannot be fooled that way: a self-loop adds no new node, and a
   * producer that only fires from an unreachable state is never visited.
   *
   * MUTATION: add `| "awaiting_human"` back to `PrLifecycleState` in
   * src/state.ts (nothing transitions into it) — this fails naming it.
   */
  it("every PrLifecycleState is REACHABLE from the initial state — self-loops do not count", () => {
    const declared = unionMembers("src/state.ts", "PrLifecycleState");

    // Every event shape, with each payload variant that steers the outcome.
    // Payload matters: `round_overdue` picks its target off `standing`, and
    // `verdict` off the verdict string, so a single representative event per
    // type would leave real branches unexercised.
    const events: SmEvent[] = [
      { type: "track" },
      { type: "trigger", source: "label" },
      { type: "trigger", source: "team_request" },
      { type: "trigger", source: "manual" },
      { type: "trigger", source: "reconcile" },
      { type: "stale_detected" },
      { type: "dispatched" },
      { type: "verdict", verdict: "APPROVE" },
      { type: "verdict", verdict: "REQUEST_CHANGES" },
      { type: "verdict", verdict: "NEEDS_HUMAN" },
      { type: "round_overdue", standing: "REQUEST_CHANGES" },
      { type: "round_overdue", standing: "APPROVE" },
      { type: "round_overdue", standing: null },
      { type: "author_reply" },
      { type: "synchronize" },
      { type: "human_requested" },
      { type: "closed" },
      { type: "reopened" },
    ];
    // The event list must cover the declared event union, or the BFS explores
    // a smaller graph than the one that ships and the reachability answer is
    // about a machine nobody runs.
    const eventTypes = unionMembers("src/statemachine.ts", "SmEventType");
    expect([...new Set(events.map((e) => e.type))].sort()).toEqual([...eventTypes].sort());

    const reachable = new Set<PrLifecycleState>([INITIAL_STATE]);
    const queue: PrLifecycleState[] = [INITIAL_STATE];
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const ev of events) {
        const to = transition(from, ev);
        if (to === from) continue; // a self-loop is not a producer
        if (!reachable.has(to)) {
          reachable.add(to);
          queue.push(to);
        }
      }
    }

    /**
     * A SELF-RETIRING record, not an exemption.
     *
     * `awaiting_human` is unreachable and that is correct — it is what this
     * fence is for. Its removal is, in flight in a parallel worktree
     * as this lands, so the two would collide if this fence simply demanded
     * the union be clean today.
     *
     * The entry is deliberately INTOLERANT of the removal landing: when
     * merges, the state leaves the union, this test goes RED, and the
     * fix is to delete these three lines. That is the point — an entry that
     * quietly kept passing after its ticket closed is how the surface it
     * describes becomes invisible again. Whoever merges second re-runs the
     * suite anyway (the worktree rule says so), and gets a one-line deletion
     * with a message naming it.
     */
    const UNREACHABLE_PENDING_REMOVAL: ReadonlyArray<{ state: string; ticket: string }> = [
      { state: "awaiting_human", ticket: "(retire the park surface)" },
    ];
    for (const e of UNREACHABLE_PENDING_REMOVAL) {
      if (!declared.includes(e.state)) {
        throw new Error(
          `${e.ticket} has landed — '${e.state}' is gone from PrLifecycleState. Delete its `
            + "UNREACHABLE_PENDING_REMOVAL entry; the fence below then stands on its own.",
        );
      }
    }

    const unreachable = declared.filter((s) => !reachable.has(s as PrLifecycleState));
    expect(
      unreachable.sort(),
      "a lifecycle state nothing can transition INTO is dead — delete it from the union and every reader, "
        + "or add the transition that produces it",
    ).toEqual(UNREACHABLE_PENDING_REMOVAL.map((e) => e.state).sort());
  });

  /**
   * The event half. An event type is live only if some module OUTSIDE the
   * state machine's own declaration constructs it — the same reader-not-name
   * rule as everywhere else here.
   *
   * MUTATION: delete the `{ type: "dispatched" }` construction from
   * src/dispatch.ts — this fails naming `dispatched`.
   */
  it("every SmEventType is constructed by a module outside statemachine.ts", () => {
    const declared = unionMembers("src/statemachine.ts", "SmEventType");
    const producers = SRC_FILES.filter((f) => !f.endsWith("/statemachine.ts")).map(codeOf).join("\n");

    /**
     * ALLOWLIST — event types with no producer, each with the reason it is
     * still in the union and the ticket that will remove it.
     *
     * This is NOT a place to park a member nobody wants to think about: an
     * entry needs a ticket id, and the fence below refuses an entry that has
     * quietly acquired a producer, so a resolved item cannot linger here
     * pretending to be debt.
     */
    const NO_PRODUCER_ALLOWLIST: ReadonlyArray<{ type: string; why: string }> = [
      {
        type: "stale_detected",
        why:
          "[A6]: the staleness round type has no producer and takes the whole round type with it. "
          + "Classified DELETE by the inventory and cut as its own batch (the inventory's Batch 6), which has "
          + "not landed — it depends on whether the live VM database holds rows with stale_recheck = 1 "
          + "([U1], stated there as an unknown rather than guessed). Recorded here so it reads as "
          + "a ticketed removal, not an oversight.",
      },
    ];
    for (const e of NO_PRODUCER_ALLOWLIST) {
      expect(declared, `${e.type} is allowlisted but is no longer in SmEventType`).toContain(e.type);
      expect(e.why).toMatch(/FT-\d{4}/);
    }

    const constructed = new Set(declared.filter((t) => producers.includes(`type: "${t}"`)));
    const orphans = declared.filter((t) => !constructed.has(t));
    const allowed = NO_PRODUCER_ALLOWLIST.map((e) => e.type).sort();

    expect(
      orphans.sort(),
      "an SmEventType with no producer is dead vocabulary — delete it, or allowlist it with the ticket that will",
    ).toEqual(allowed);
  });
});

// ---------------------------------------------------------------------------
// [T5] CANCEL_CAUSES is a complete enumeration of its union
// ---------------------------------------------------------------------------

describe("[T5] the cancel-cause list and its union agree", () => {
  /**
   * `CANCEL_CAUSES` is a runtime array beside an erased union — exactly the
   * shape that drifts silently. The inventory proposed deleting the array as
   * unused; pinning it against the union is better, because it makes the list
   * earn its keep instead.
   *
   * MUTATION: add `| "rogue"` to the `CancelCause` union in src/state.ts
   * without touching CANCEL_CAUSES — this fails.
   */
  it("CANCEL_CAUSES equals the CancelCause union, in declaration order", () => {
    expect([...CANCEL_CAUSES]).toEqual(unionMembers("src/state.ts", "CancelCause"));
  });
});

// ---------------------------------------------------------------------------
// [T12] Rule 7's pin must equal the real pins
// ---------------------------------------------------------------------------

describe("[T12] the pi version pin is one fact, spelled the same everywhere", () => {
  /**
   * OpenViking has this check (tests/openviking.test.ts pins its triple
   * mirror, and `scripts/deploy.sh` refuses to deploy on drift). pi did not —
   * which is exactly why two of its five spellings drifted while the suite
   * stayed green.
   *
   * Two of the five were covered before this: `tests/docker-daemon.test.ts`
   * pins config.toml ↔ group_vars ↔ Dockerfile. The two that were not are the
   * two that drifted: `package.json`'s `pi` block (never read by any test —
   * `scripts/deploy.sh` only tells the operator to reconcile it by hand) and
   * the version quoted in the operating rulebook's rule 7.
   *
   * MUTATION: change `version` in the `pi` block of package.json — this fails.
   */
  const pins = () => {
    const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
    const cfgPi = /\[pi\]([\s\S]*?)(?=\n\[|\n*$)/.exec(read("config.toml"))?.[1] ?? "";
    const examplePi = /\[pi\]([\s\S]*?)(?=\n\[|\n*$)/.exec(read("config.example.toml"))?.[1] ?? "";
    return {
      "config.toml [pi] version": /version\s*=\s*"([^"]+)"/.exec(cfgPi)?.[1],
      "config.example.toml [pi] version": /version\s*=\s*"([^"]+)"/.exec(examplePi)?.[1],
      "package.json pi.version": (JSON.parse(read("package.json")) as { pi?: { version?: string } }).pi?.version,
      "group_vars pi_version": /^pi_version:\s*"([^"]+)"/m.exec(read("deploy/ansible/group_vars/all.yml"))?.[1],
      "docker/daemon/Dockerfile ARG PI_VERSION": /^ARG PI_VERSION=(\S+)/m.exec(read("docker/daemon/Dockerfile"))?.[1],
    };
  };

  it("all five code-side spellings agree, and none is missing", () => {
    const found = pins();
    for (const [where, value] of Object.entries(found)) {
      expect(value, `${where} — the pin could not be READ; a fence that finds nothing asserts nothing`).toBeTruthy();
    }
    expect(new Set(Object.values(found)).size, `pi version drift: ${JSON.stringify(found, null, 2)}`).toBe(1);
  });

  /**
   * The rulebook half, and the one place a KNOWN, TICKETED divergence is
   * recorded rather than fixed.
   *
   * This test does NOT assert that rule 7 is correct — it is not. It asserts
   * that the divergence is EXACTLY the one already written down, which makes
   * it loud in both directions:
   *
   *   * a NEW drift (rule 7 acquires some third version) fails here;
   *   * and the moment the recorded stale value is corrected, THIS TEST FAILS
   *     TOO, forcing the entry to be deleted and the assertion flipped to the
   *     direct form below it. The allowlist retires itself.
   *
   * Why it is recorded rather than repaired: `CLAUDE.md` is the operating
   * rulebook, and this agent does not edit it on its own authority. The fix is
   * one digit; it belongs to whoever next touches rule 7.
   */
  it("CLAUDE.md rule 7 quotes a pi version — currently a RECORDED stale one ([P11])", () => {
    const KNOWN_STALE_RULE_7_PIN = "0.84.1";
    const rule7 = /^7\. pi is pinned \(`([^`]+)`/m.exec(readFileSync(join(ROOT, "CLAUDE.md"), "utf8"))?.[1];
    expect(rule7, "rule 7 no longer quotes a pi version in the shape this fence reads").toBeTruthy();

    const real = pins()["config.toml [pi] version"];
    if (rule7 === real) {
      throw new Error(
        "rule 7 has been corrected — delete KNOWN_STALE_RULE_7_PIN and assert `expect(rule7).toBe(real)` directly",
      );
    }
    expect(
      rule7,
      "rule 7's pi version drifted to a THIRD value — reconcile it with config.toml, package.json, group_vars and the Dockerfile",
    ).toBe(KNOWN_STALE_RULE_7_PIN);
  });
});

// ---------------------------------------------------------------------------
// The exec policy and the prompt contract cannot disagree  (audit #6, MC-08)
// ---------------------------------------------------------------------------

describe("the sanctioned-script set is DERIVED from the prompts, not maintained beside them", () => {
  /**
   * `scripts/pr-self.sh` was mandated by all three round templates and absent
   * from the exec policy's `SANCTIONED_SCRIPTS`, so every invocation form was
   * blocked and a mandated read simply failed — fail-closed, and a live
   * functional defect that no test could see, because the two halves were
   * asserted separately and never against each other.
   *
   * SET EQUALITY, both directions: a script the prompts name and the policy
   * refuses is the MC-08 bug; a script the policy sanctions and no prompt
   * names is an allowlist wider than the contract it exists to serve.
   *
   * MUTATION: remove "pr-self.sh" from SANCTIONED_SCRIPTS — this fails naming
   * it. Add "deploy.sh" to that set — this fails too.
   */
  it("every script the prompts mandate is accepted, and nothing else is sanctioned", async () => {
    const { checkBashCommand } = await import("../extensions/bash-guard.js");

    const mandated = new Set<string>();
    for (const dir of ["prompts", "agents"]) {
      for (const f of readdirSync(join(ROOT, dir))) {
        if (!f.endsWith(".md")) continue;
        for (const m of readFileSync(join(ROOT, dir, f), "utf8").matchAll(/scripts\/([a-z0-9._-]+\.sh)/g)) {
          mandated.add(m[1]!);
        }
      }
    }
    expect(mandated.size, "no prompt names a script — the derivation found nothing and would pass vacuously").toBeGreaterThan(3);

    // The policy's own view, probed through the real entry point rather than
    // read off the constant: what ships is the function's answer.
    const accepted = readdirSync(join(ROOT, "scripts"))
      .filter((f) => f.endsWith(".sh"))
      .filter((f) => checkBashCommand(`scripts/${f} 5`).allowed);

    expect(
      [...mandated].sort(),
      "the set of scripts the prompts mandate and the set the exec policy accepts have diverged",
    ).toEqual(accepted.sort());
  });

  /**
   * Every invocation FORM a template could produce, not just the bare one —
   * the MC-08 report noted the block hit "every invocation form", and a fence
   * that only probes one spelling would pass on a policy that accepts one.
   */
  it("accepts each mandated script through every spelling a session would use", async () => {
    const { checkBashCommand } = await import("../extensions/bash-guard.js");
    for (const form of ["scripts/pr-self.sh 5 reviews", "./scripts/pr-self.sh 5 head", "bash scripts/pr-self.sh 5 checks"]) {
      const r = checkBashCommand(form);
      expect(r.allowed, `${form} — ${r.reason ?? ""}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The posting guards are not a knob a session may relocate  (audit #5, MC-05)
// ---------------------------------------------------------------------------

describe("no env prefix can move the posting guards' own configuration", () => {
  /**
   * MC-05. `VAR=val` prefixes are skipped by the segment splitter, and only
   * the git family was named — so
   *
   *     QCR_CONFIG=/tmp/mine.toml bash scripts/approve-pr.sh 5 body.md
   *
   * passed the exec policy on a SANCTIONED script. Every guard knob the
   * posting scripts consult is read out of `$QCR_CONFIG`, and `guard_enabled`
   * treats a knob as on unless the value is literally `false`; the same file
   * also carries `dry_run`. One hand-written TOML, written with the ordinary
   * write tool, turned guards 2-5 off on a real approval and could flip a
   * dry-run install into posting for real.
   *
   * SCOPE: this fence covers the ENV-PREFIX spelling only. Adversarial review
   * found two further routes to the same end — `bash -c '<sanctioned script> ;
   * <anything>'` past the segment policy, and a writable default config path
   * (the config, `guards.sh` and the posting scripts can all be overwritten
   * outright). Both are follow-up tickets. Do not read a pass here as "the
   * guards cannot be moved".
   *
   * MUTATION: remove "QCR_CONFIG" from POLICY_RELOCATING_ENV in
   * extensions/bash-guard.ts — this fails.
   */
  it("refuses the relocators and still allows the per-call arguments", async () => {
    const { checkBashCommand } = await import("../extensions/bash-guard.js");
    for (const cmd of [
      "QCR_CONFIG=/tmp/x.toml bash scripts/approve-pr.sh 5 b.md",
      "env QCR_CONFIG=/tmp/x.toml scripts/approve-pr.sh 5 b.md",
      "QCR_STATE_DB=/tmp/x.db scripts/post-review.sh 5 COMMENT b.md",
      "QCR_DRYRUN_DIR=/tmp/d scripts/approve-pr.sh 5 b.md",
    ]) {
      expect(checkBashCommand(cmd).allowed, cmd).toBe(false);
    }
    // The daemon's own dispatch path sets these; blocking them would break it.
    // They are ARGUMENTS about this call, not the policy the guards apply.
    for (const cmd of [
      "QCR_EXPECTED_HEAD=abc123 scripts/post-review.sh 5 COMMENT b.md",
      "QCR_POSTING_KEY=k scripts/post-review.sh 5 COMMENT b.md",
      "QCR_ROUND_NO=2 scripts/post-review.sh 5 COMMENT b.md",
    ]) {
      expect(checkBashCommand(cmd).allowed, cmd).toBe(true);
    }
  });

  /**
   * Rule 2 of this map's review discipline: PROBE THE COMPILED ARTIFACT. The
   * container runs `dist/`, and two rounds of live bypasses on this exact
   * module were found by testing the build rather than the source.
   */
  it("the COMPILED guard agrees with the source", async () => {
    const dist = join(ROOT, "dist", "extensions", "bash-guard.js");
    if (!existsSync(dist)) {
      throw new Error("dist/extensions/bash-guard.js is missing — run `npm run build`; the shipped policy is unverified");
    }
    const compiled = (await import(dist)) as { checkBashCommand: (c: string) => { allowed: boolean } };
    const source = await import("../extensions/bash-guard.js");
    for (const cmd of [
      "QCR_CONFIG=/tmp/x.toml bash scripts/approve-pr.sh 5 b.md",
      "scripts/pr-self.sh 5 reviews",
      "gh pr review 5 --approve",
    ]) {
      expect(compiled.checkBashCommand(cmd).allowed, `compiled: ${cmd}`).toBe(source.checkBashCommand(cmd).allowed);
    }
  });
});
