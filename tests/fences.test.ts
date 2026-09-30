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
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALLOWED_PROGRAMS, checkBashCommand } from "../extensions/bash-guard.js";
import {
  ALLOWED_COMMANDS_CLAUSE,
  EXECUTION_POLICY_ADDENDUM,
  PASS_ADDENDA,
  buildAgents,
  identityVars,
} from "../src/include.js";
import { postTag } from "../src/severity.js";
import { renderOverseerSystemPrompt } from "../src/templates.js";
import { loadProfileAddenda } from "../src/profiles.js";
import { locateProfile } from "../src/install.js";
import { stageFixtureProfiles } from "./helpers/tracked-profiles.js";
import { INITIAL_STATE, transition, type SmEvent } from "../src/statemachine.js";
import { CANCEL_CAUSES, type PrLifecycleState } from "../src/state.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/** Every .ts under a tree, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
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
  if (!m?.[1])
    throw new Error(`union ${typeName} not found in ${relPath} — the fence over it is now vacuous`);
  const members = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
  if (members.length === 0)
    throw new Error(`union ${typeName} in ${relPath} parsed to zero members`);
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
     * A SELF-RETIRING record, not an exemption — and it is EMPTY, so the
     * fence below demands a clean union outright.
     *
     * It held one entry, `awaiting_human`, while (retire the park
     * surface) was in flight in a parallel worktree. That entry was
     * deliberately intolerant of its own ticket landing: the state left the
     * union, this test went red, and the fix was to delete it. That is the
     * point — an entry that quietly kept passing after its ticket closed is
     * how the surface it describes becomes invisible again.
     *
     * The mechanism stays for the next such removal. An entry needs a ticket
     * id, and it retires itself the moment that ticket lands.
     */
    const UNREACHABLE_PENDING_REMOVAL: ReadonlyArray<{ state: string; ticket: string }> = [];
    for (const e of UNREACHABLE_PENDING_REMOVAL) {
      if (!declared.includes(e.state)) {
        throw new Error(
          `${e.ticket} has landed — '${e.state}' is gone from PrLifecycleState. Delete its ` +
            "UNREACHABLE_PENDING_REMOVAL entry; the fence below then stands on its own.",
        );
      }
    }

    const unreachable = declared.filter((s) => !reachable.has(s as PrLifecycleState));
    expect(
      unreachable.sort(),
      "a lifecycle state nothing can transition INTO is dead — delete it from the union and every reader, " +
        "or add the transition that produces it",
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
  it("every SmEventType is constructed by a module outside statemachine.ts", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const declared = unionMembers("src/statemachine.ts", "SmEventType");
    const producers = SRC_FILES.filter((f) => !f.endsWith("/statemachine.ts"))
      .map(codeOf)
      .join("\n");

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
          "[A6]: the staleness round type has no producer and takes the whole round type with it. " +
          "Classified DELETE by the inventory and cut as its own batch (the inventory's Batch 6), which has " +
          "not landed — it depends on whether the live VM database holds rows with stale_recheck = 1 " +
          "([U1], stated there as an unknown rather than guessed). Recorded here so it reads as " +
          "a ticketed removal, not an oversight.",
      },
    ];
    for (const e of NO_PRODUCER_ALLOWLIST) {
      expect(declared, `${e.type} is allowlisted but is no longer in SmEventType`).toContain(
        e.type,
      );
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
   *
   * The five are split below into the four that ship in every tree and the
   * one that does not; two more spellings (rule 7 and the deploying skill)
   * follow, both private-only.
   */
  /**
   * PRIVATE-ONLY SPELLINGS. Two of the places this fact is written down are
   * absent from the published snapshot: the operating rulebook `CLAUDE.md`
   * and the deploying skill (bound to the private VM). (The operator's LIVE
   * `config.toml` left the checkout altogether with; deploy.sh's
   * preflight holds its pin, and the test fixture stands in below.) Each of
   * their fences is
   * GUARDED on the file existing rather than deleted, so in this tree they
   * run exactly as before and drift still fails; in a published tree they
   * skip visibly instead of reading a file that is not there. The PUBLIC
   * spellings below are asserted unconditionally in every tree, and
   * `config.example.toml` — which carries the same pin — is the reference the
   * guarded ones are reconciled against.
   */
  const has = (rel: string) => existsSync(join(ROOT, rel));
  const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
  const tomlPiVersion = (rel: string) =>
    /version\s*=\s*"([^"]+)"/.exec(/\[pi\]([\s\S]*?)(?=\n\[|\n*$)/.exec(read(rel))?.[1] ?? "")?.[1];

  /** The four spellings that ship in every tree. */
  const publicPins = () => ({
    "config.example.toml [pi] version": tomlPiVersion("config.example.toml"),
    "package.json pi.version": (JSON.parse(read("package.json")) as { pi?: { version?: string } })
      .pi?.version,
    "group_vars pi_version": /^pi_version:\s*"([^"]+)"/m.exec(
      read("deploy/ansible/group_vars/all.yml"),
    )?.[1],
    "docker/daemon/Dockerfile ARG PI_VERSION": /^ARG PI_VERSION=(\S+)/m.exec(
      read("docker/daemon/Dockerfile"),
    )?.[1],
  });

  /** The one fact, read from a file that is in every tree. */
  const realPin = () => publicPins()["config.example.toml [pi] version"];

  it("all four published spellings agree, and none is missing", () => {
    const found = publicPins();
    for (const [where, value] of Object.entries(found)) {
      expect(
        value,
        `${where} — the pin could not be READ; a fence that finds nothing asserts nothing`,
      ).toBeTruthy();
    }
    expect(
      new Set(Object.values(found)).size,
      `pi version drift: ${JSON.stringify(found, null, 2)}`,
    ).toBe(1);
  });

  /**
   * The test fixture is the fifth spelling. The LIVE config — the one
   * `scripts/deploy.sh` and the container read — left the checkout with
   * `qcr install migrate`, so no test can see it; its pin is held
   * by deploy.sh's preflight instead, which reads it through the install
   * locator and REFUSES on drift from group_vars (pinned in
   * tests/deploy.test.ts). The fixture is the config every other test
   * parses, so a stale pin there would let those tests exercise a pi the
   * image never runs.
   *
   * MUTATION: change `version` in tests/fixtures/config.toml's `[pi]` block —
   * this fails.
   */
  it("the test fixture config's pin agrees with the published spellings", () => {
    const cfg = tomlPiVersion("tests/fixtures/config.toml");
    expect(
      cfg,
      "tests/fixtures/config.toml no longer spells the pin in the shape this fence reads",
    ).toBeTruthy();
    expect(
      cfg,
      "tests/fixtures/config.toml's pi version drifted from config.example.toml — reconcile it",
    ).toBe(realPin());
  });

  /**
   * The rulebook half. Until this recorded a KNOWN stale value
   * (`0.84.1`, [P11]) rather than asserting the truth, because the
   * rulebook is the owner's file — and was written to fail the moment the
   * value was corrected, so the record would retire itself. It fired on
   *'s correction, made on the owner's order to complete this effort,
   * and this is the direct form it demanded.
   *
   * MUTATION: change the version in rule 7's first sentence — this fails.
   */
  it.skipIf(!has("CLAUDE.md"))(
    "CLAUDE.md rule 7 quotes the real pi version (private tree only)",
    () => {
      const rule7 = /^7\. pi is pinned \(`([^`]+)`/m.exec(read("CLAUDE.md"))?.[1];
      expect(
        rule7,
        "rule 7 no longer quotes a pi version in the shape this fence reads",
      ).toBeTruthy();
      expect(rule7, "rule 7's pi version drifted from the shipped pin — reconcile it").toBe(
        realPin(),
      );
    },
  );

  /**
   * The deploy checklist quotes the pin too ("currently `…`"), and it sat at
   * `0.84.1` after rule 7 was corrected — the same file said `0.84.4` two
   * hundred lines later. An operator reads this one before every deploy.
   *
   * MUTATION: change the version after "currently" in the deploying skill —
   * this fails.
   */
  const DEPLOY_SKILL = join(".claude", "skills", "deploying", "SKILL.md");
  it.skipIf(!has(DEPLOY_SKILL))(
    "the deploying skill's 'currently' pin quotes the real pi version (private tree only)",
    () => {
      const skill = read(DEPLOY_SKILL);
      const quoted = /\*\*pi pin coherent\*\*[^\n]*\n[^\n]*\(currently `([^`]+)`\)/.exec(
        skill,
      )?.[1];
      expect(
        quoted,
        "the deploying skill no longer quotes the pin in the shape this fence reads",
      ).toBeTruthy();
      expect(
        quoted,
        "the deploying skill's pi version drifted from the shipped pin — reconcile it",
      ).toBe(realPin());
    },
  );
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
        for (const m of readFileSync(join(ROOT, dir, f), "utf8").matchAll(
          /scripts\/([a-z0-9._-]+\.sh)/g,
        )) {
          mandated.add(m[1]!);
        }
      }
    }
    expect(
      mandated.size,
      "no prompt names a script — the derivation found nothing and would pass vacuously",
    ).toBeGreaterThan(3);

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
    for (const form of [
      "scripts/pr-self.sh 5 reviews",
      "./scripts/pr-self.sh 5 head",
      "bash scripts/pr-self.sh 5 checks",
    ]) {
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
   * SCOPE: this fence covers the ENV-PREFIX spelling. The two further routes
   * the review named are now CLOSED by and fenced in
   * tests/bash-guard.test.ts: `bash -c '<sanctioned> ; <anything>'` (the payload
   * is re-parsed as its own command) and overwriting the config / `guards.sh` /
   * the posting scripts / the compiled guard (the policy surface is unwritable
   * at both boundaries). `QCR_POSTING_RECEIPT_DIR` joined this set there too.
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
      throw new Error(
        "dist/extensions/bash-guard.js is missing — run `npm run build`; the shipped policy is unverified",
      );
    }
    const compiled = (await import(dist)) as {
      checkBashCommand: (c: string) => { allowed: boolean };
    };
    const source = await import("../extensions/bash-guard.js");
    for (const cmd of [
      "QCR_CONFIG=/tmp/x.toml bash scripts/approve-pr.sh 5 b.md",
      "scripts/pr-self.sh 5 reviews",
      "gh pr review 5 --approve",
    ]) {
      expect(compiled.checkBashCommand(cmd).allowed, `compiled: ${cmd}`).toBe(
        source.checkBashCommand(cmd).allowed,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The prompt half and the enforcing half of the no-exec policy are ONE fact,
// and the retired park is in no prompt a model reads 
// ---------------------------------------------------------------------------

describe("what a built pass is told it may run is exactly what the guard lets through", () => {
  /**
   * took `awk` off the guard's allowlist; the execution-policy
   * addendum — composed onto all 37 built pass variants — kept advertising it,
   * so `checkBashCommand("awk '{print $1}' f")` blocked a command the prompt
   * had just offered. Nothing noticed, because the prompt was pinned by a
   * prefix (`"Allowed commands: git, rg, grep, cat, ls, find"`) and the guard
   * by its own probes, never against each other. The sentence is now RENDERED
   * from `ALLOWED_PROGRAMS`; this fence holds the two to set equality anyway,
   * so a literal pasted back over the render fails too.
   *
   * The sentence is read off the body, never off the render helper: what
   * ships is the text.
   */
  function advertisedIn(body: string): string[] {
    const m = /Allowed commands: ([^\n]+?)\. CI results are READ/.exec(body);
    if (!m)
      throw new Error(
        "no 'Allowed commands: …' clause in the body — the execution policy is missing",
      );
    return m[1]!.replace(", and read-only gh", ", gh").split(", ");
  }

  /** One benign READ spelling per program — the guard's answer, not the list's. */
  const READ_PROBE: Readonly<Record<string, string>> = {
    git: "git log -1 --oneline",
    gh: "gh pr view 5",
    find: "find . -name '*.py'",
    sed: "sed -n 1,5p README.md",
    xargs: "xargs cat",
    test: "test -f README.md",
    true: "true",
    false: "false",
    date: "date -u",
  };

  /**
   * MUTATION: replace `${ALLOWED_COMMANDS_CLAUSE}` in EXECUTION_POLICY_ADDENDUM
   * with the legacy literal (which names `awk`) — this fails twice, on
   * the set and on the probe. Add "awk" back to ALLOWED_PROGRAMS — the probe
   * `awk '{print $1}' f` is then allowed and this fails.
   */
  it("the advertised set equals ALLOWED_PROGRAMS, each advertised program reads, and the blocked ones stay blocked", () => {
    const advertised = advertisedIn(EXECUTION_POLICY_ADDENDUM);
    expect(new Set(advertised).size, "a program is advertised twice").toBe(advertised.length);
    expect([...advertised].sort()).toEqual([...ALLOWED_PROGRAMS].sort());
    expect(EXECUTION_POLICY_ADDENDUM).toContain(`Allowed commands: ${ALLOWED_COMMANDS_CLAUSE}.`);
    for (const p of advertised) {
      const cmd = READ_PROBE[p] ?? `${p} README.md`;
      const r = checkBashCommand(cmd);
      expect(r.allowed, `advertised but refused: ${cmd} — ${r.reason ?? ""}`).toBe(true);
    }
    // The ticket's own reproduction, plus awk's kin: advertised nowhere, and
    // refused by the function — not merely absent from a list.
    for (const cmd of [
      "awk '{print $1}' file.txt",
      "gawk '{print}' f",
      "perl -e 1",
      "python3 -c 1",
    ]) {
      expect(checkBashCommand(cmd).allowed, `${cmd} must be refused`).toBe(false);
      expect(advertised).not.toContain(cmd.split(" ")[0]);
    }
  });

  /**
   * Every BUILT variant — all of them, from the real `agents/` seeds, in the
   * default composition and under every shipped profile pack — and never a
   * sample: the stale-prose sweep grepped `src/` and `docs/` and
   * missed this text entirely, because a composed body exists in no file.
   *
   * MUTATION: put the old sentence ("route such findings to a human park
   * (NEEDS_HUMAN with an escalation comment)") back into
   * FIRST_PARTY_DIRECTIVE_ADDENDUM — fails on every variant. Put `awk` back
   * into the allowlist sentence — fails on every variant.
   */
  it("no built pass variant names the park, NEEDS_HUMAN or awk, and each carries the rendered allowlist", { timeout: HEAVY_TIMEOUT_MS }, () => {
    // Every pack the locator would load (a stranded checkout pack is
    // not one — it is never read, so it composes into nothing): the generic
    // examples, plus the frozen fixture copy of the deployment's pack
    // (tests/fixtures/profiles/), staged into the temp config home so the
    // deployed composition stays one of the compositions this fence covers.
    const fixtures = stageFixtureProfiles(ROOT);
    const examples = readdirSync(join(ROOT, "profiles"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    const profiles = [...examples, ...fixtures].filter(
      (name) => locateProfile({ root: ROOT, profile: name }) !== null,
    );
    expect(
      profiles.length,
      "no profile packs found — the profile half of this fence would be vacuous",
    ).toBeGreaterThan(0);
    const compositions: Array<[string, typeof PASS_ADDENDA]> = [
      ["default", PASS_ADDENDA],
      ...profiles.map((name): [string, typeof PASS_ADDENDA] => [
        name,
        [...PASS_ADDENDA, ...loadProfileAddenda(ROOT, name)],
      ]),
    ];
    for (const [label, addenda] of compositions) {
      const out = mkdtempSync(join(tmpdir(), `qcr-ft0403-${label}-`));
      try {
        const built = buildAgents(join(ROOT, "agents"), out, { root: ROOT, addenda });
        expect(
          built.length,
          `${label}: too few variants built to be the real set`,
        ).toBeGreaterThanOrEqual(30);
        for (const b of built) {
          const body = readFileSync(b.output, "utf8");
          const where = `${label}/${b.name}`;
          expect(body, where).toContain(`Allowed commands: ${ALLOWED_COMMANDS_CLAUSE}.`);
          expect([...advertisedIn(body)].sort(), where).toEqual([...ALLOWED_PROGRAMS].sort());
          expect(body, `${where} names NEEDS_HUMAN`).not.toMatch(/NEEDS_HUMAN/);
          expect(body, `${where} names the park`).not.toMatch(/\bpark(s|ed|ing)?\b/i);
          expect(body, `${where} names awk`).not.toMatch(/\bawk\b/);
        }
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }
  });

  /**
   * The sentence lists PROGRAMS, and the guard admits a few SHAPES beyond
   * any program: `cd` (a builtin — its argument is a path), `sh -n <file>`
   * (a syntax check, the only `sh` form), an `env`/`VAR=val` prefix in front
   * of an ALLOWED program, and the sanctioned `scripts/*.sh` — directly or
   * via `bash` — which are the session's posting route and are described to
   * it separately. So "advertised ⇒ admitted" is the direction the fence
   * above holds, and the prompt UNDER-advertises by these shapes, which is
   * harmless for a leaf.
   *
   * What this test holds, precisely: each documented shape is ADMITTED and
   * is genuinely a shape rather than a program the sentence forgot (the
   * token the guard resolves is either a non-program — `cd`, `sh`, `bash`, a
   * script path — or, for the prefix forms, an already-advertised program);
   * and a fixed list of near-misses is REFUSED. It is an enumeration, not a
   * derivation: a NEW shape admitted by the guard does not fail here — the
   * "advertised ⇒ admitted" fence above and the guard's own suite are where a
   * widened allowlist shows — but a documented shape narrowing, or a
   * near-miss opening, does.
   *
   * MUTATION: make `cd` fall through to the allowlist in checkProgram — the
   * `cd /tmp` probe is then refused and this fails.
   */
  it("the guard admits the documented shapes beyond the advertised programs, and refuses their near-misses", () => {
    // [command, the token the guard resolves as the program]
    const shapes: readonly (readonly [string, string])[] = [
      ["cd /tmp", "cd"],
      ["sh -n scripts/post-review.sh", "sh"],
      ["env FOO=1 cat README.md", "cat"],
      ["FOO=1 cat README.md", "cat"],
      ["bash scripts/post-review.sh", "bash"],
      ["scripts/reply-thread.sh 5 1 reply.md", "scripts/reply-thread.sh"],
    ];
    for (const [cmd, program] of shapes) {
      const r = checkBashCommand(cmd);
      expect(r.allowed, `documented shape refused: ${cmd} — ${r.reason ?? ""}`).toBe(true);
      if (program === "cat") {
        // A prefix is a shape only because what follows it is still vetted:
        // the program after the prefix must be one the sentence advertises.
        expect(ALLOWED_PROGRAMS, `${cmd}: the prefixed program must be advertised`).toContain(
          program,
        );
      } else {
        expect(
          ALLOWED_PROGRAMS,
          `${cmd}: '${program}' is a shape, not a program the sentence should list`,
        ).not.toContain(program);
      }
    }
    // …and the shapes are exactly that narrow: the other `sh` form, a `bash -c`
    // whose re-parsed payload is not itself an advertised program,
    // an unsanctioned script, other builtins — and a prefix in front of a
    // program the sentence does NOT advertise, which is what makes the prefix
    // a shape rather than a bypass.
    for (const cmd of [
      "sh scripts/post-review.sh",
      "bash -c pwd",
      "bash -c 'python3 x.py'",
      "scripts/rogue.sh",
      "pwd",
      "command -v git",
      "type ls",
      "[ -f README.md ]",
      "env FOO=1 awk '{print $1}' README.md",
      "FOO=1 pwd",
      "env FOO=1 python3 x.py",
    ]) {
      expect(checkBashCommand(cmd).allowed, `${cmd} must be refused`).toBe(false);
    }
  });

  /**
   * The overseer is the OTHER prompt a model reads on every day, and it too
   * is composed: the frozen seed rendered, plus — when `[slack] enabled` —
   * the non-seeded appendix, concatenated at spawn (`ensureOverseerSession`;
   * `tests/slack-appendix.test.ts` proves this is the body that is spawned).
   * The appendix is ours, and it still told the overseer "a PR stops for a
   * person only when a round returns NEEDS_HUMAN" — the MC-48 sentence this
   * ticket took out of src/commands.ts — plus that the seed still listed a
   * command the 2026-08-18 reseed had removed.
   *
   * MUTATION: restore that sentence in prompts/slack-overseer-appendix.md —
   * fails. Put `mark-escalation-worthy` into the seed's command list — fails.
   */
  it("the composed overseer body — seed rendered plus the Slack appendix — names neither the park nor NEEDS_HUMAN", () => {
    const seed = readFileSync(join(ROOT, "prompts", "overseer-system.md"), "utf8");
    const appendix = readFileSync(join(ROOT, "prompts", "slack-overseer-appendix.md"), "utf8");
    const rendered = renderOverseerSystemPrompt(seed, identityVars({}));
    // The appendix says the seed no longer lists the retired command; hold
    // the fact the sentence rests on, not the sentence.
    expect(rendered).not.toContain("mark-escalation-worthy");
    for (const [label, body] of [
      ["slack off", rendered],
      ["slack on", `${rendered}\n\n${appendix.trimEnd()}\n`],
    ] as const) {
      expect(body, `${label}: names NEEDS_HUMAN`).not.toMatch(/NEEDS_HUMAN/);
      expect(body, `${label}: names the park`).not.toMatch(/\bpark(s|ed|ing)?\b/i);
    }
  });

  /**
   * Rule 2 of this map's review discipline: PROBE THE COMPILED ARTIFACT. The
   * daemon builds `state/agents` from `dist/src/include.js`, so the sentence
   * the VM's passes read is the compiled module's, not the source's.
   */
  it("the COMPILED execution policy is the source's, and names no awk", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    const dist = join(ROOT, "dist", "src", "include.js");
    if (!existsSync(dist)) {
      throw new Error(
        "dist/src/include.js is missing — run `npm run build`; the shipped prompt is unverified",
      );
    }
    const compiled = (await import(dist)) as { EXECUTION_POLICY_ADDENDUM: string };
    expect(compiled.EXECUTION_POLICY_ADDENDUM).toBe(EXECUTION_POLICY_ADDENDUM);
    expect(compiled.EXECUTION_POLICY_ADDENDUM).not.toMatch(/\bawk\b/);
  });
});

describe("the prose beside the posting map says what the map does (MC-45)", () => {
  /**
   * `src/severity.ts` is where the directive gate was first built and
   * where reshaped it, and its module header outlived both: it kept
   * asserting that a first-party directive injection "never blocks" and
   * "posts as a [question]" while `postTag`, four lines below, mapped exactly
   * that finding to a blocker. A header that contradicts its own function is
   * the MC-45 defect, and a grep-shaped sweep missed it twice because the
   * paragraph also mentioned the park's retirement, which READ as fixed.
   *
   * The fence pairs the two halves: the behaviour (a surviving P0/P1/P2
   * injection on a first-party directive path blocks) and the prose (no
   * "never blocks", no "posts as a [question]", no present-tense "parks").
   *
   * MUTATION: put "never blocks — directive text inside a directive file is
   * the file doing its job. The finding posts as a [question]" back into the
   * header — fails. Restore "the ONLY session-side input that parks a PR" on
   * `needsHuman` — fails.
   */
  it("src/severity.ts no longer claims a first-party directive injection never blocks, and postTag agrees", () => {
    const src = readFileSync(join(ROOT, "src", "severity.ts"), "utf8");
    // The directive paragraph is the last one of the module header; the
    // paragraph above it legitimately says `contrived` "never blocks".
    const header = src.slice(0, src.indexOf("\nimport "));
    const directive = header.slice(header.indexOf("//"));
    expect(directive.length, "the paragraph is the header's last").toBeGreaterThan(0);
    expect(directive).toMatch(/FT-\d{4}/);
    expect(directive).not.toMatch(/never blocks/);
    expect(directive).not.toMatch(/posts as a \[question\]/);
    expect(src, "present-tense park narration").not.toMatch(/\bparks\b/);
    for (const path of ["CLAUDE.md", ".claude/skills/x/SKILL.md", "prompts/system.md"]) {
      const ctx = { kind: "injection", path };
      expect(postTag("P0", 1, "routine", ctx), path).toBe("blocker");
      expect(postTag("P1", 0.9, "routine", ctx), path).toBe("blocker");
      expect(postTag("P2", 0.9, "routine", ctx), path).toBe("blocker");
    }
  });
});
