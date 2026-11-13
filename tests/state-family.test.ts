// The state-machine family: the `pass-sm-*` lenses as one registered set
// (packages/pi-plugin/src/passes.ts `STATE_FAMILY`). A member must be a known
// pass with an agent file that includes the family's contract, a lens field
// that names one must read as a state-machine lens however a session joined
// it, and every list that derives from the registry (the preset, the lesson
// ids, the planning table, the addendum family scope) must pick the members
// up without an edit of its own.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalLensIds } from "@quickchatai/pi-quickreview/src/lensids.js";
import { LENS_PLANNING } from "@quickchatai/pi-quickreview/src/lensplanning.js";
import {
  ALL_PASSES,
  DIFF_ONLY_LENSES,
  isSecurityLens,
  isStateLens,
  LENS_FAMILIES,
  SCAN_DEEP_LENSES,
  SECURITY_FAMILY,
  STATE_FAMILY,
} from "@quickchatai/pi-quickreview/src/passes.js";
import {
  parseReviewCommand,
  REVIEW_PRESETS,
  STATE_MACHINE_LENSES,
} from "@quickchatai/pi-quickreview/src/plugin/args.js";
import { isSecurityFinding, isStateFinding } from "@quickchatai/pi-quickreview/src/severity.js";
import { VALIDATE_STATE_EVIDENCE_ADDENDUM } from "@quickchatai/pi-quickreview/src/include.js";
import { ANCHOR_KINDS } from "@quickchatai/pi-quickreview/src/stateexplore.js";
import { kindKept, readingKey } from "@quickchatai/pi-quickreview/src/scan/scan.js";

const ROOT = join(import.meta.dirname, "..");

const FAMILY = [
  "pass-sm-states",
  "pass-sm-transitions",
  "pass-sm-exhaustive",
  "pass-sm-stuck",
  "pass-sm-events",
  "pass-sm-derived",
  "pass-sm-lifecycle",
  "pass-sm-durable",
];

/** The `kind:` class each lens's text names. */
const KIND: Record<string, string> = {
  "pass-sm-states": "state-machine:illegal-state",
  "pass-sm-transitions": "state-machine:transition",
  "pass-sm-exhaustive": "state-machine:unhandled-state",
  "pass-sm-stuck": "state-machine:stuck",
  "pass-sm-events": "state-machine:event-order",
  "pass-sm-derived": "state-machine:derived",
  "pass-sm-lifecycle": "state-machine:lifecycle",
  "pass-sm-durable": "state-machine:stored",
};

describe("the state-machine family", () => {
  // MUTATION: remove "pass-sm-stuck" from STATE_FAMILY — this fails (the
  // member list, and the every-pass-sm-name check, both lose it).
  it("is the eight pass-sm-* lenses, in registry order, and every pass-sm-* name is a member", () => {
    expect([...STATE_FAMILY]).toEqual(FAMILY);
    expect([...STATE_FAMILY]).toEqual(ALL_PASSES.filter((p) => p.startsWith("pass-sm-")));
  });

  it("shares no member with the security family, and keeps the neighbours out", () => {
    for (const lens of STATE_FAMILY) expect(SECURITY_FAMILY, lens).not.toContain(lens);
    for (const neighbour of ["pass-statelessness", "pass-concurrency", "pass-rollout"])
      expect(STATE_FAMILY).not.toContain(neighbour);
  });

  // MUTATION: rename "pass-sm-events" in STATE_FAMILY to "pass-sm-event" —
  // this fails (no shipped agent file, no planning entry).
  it("every member is a known pass with a shipped agent file and a signal planning entry", () => {
    for (const lens of STATE_FAMILY) {
      expect(ALL_PASSES, lens).toContain(lens);
      expect(existsSync(join(ROOT, "agents", `${lens}.md`)), `agents/${lens}.md`).toBe(true);
      expect(LENS_PLANNING[lens]?.priority, lens).toBe("signal");
    }
  });

  // MUTATION: move `...STATE_FAMILY,` after "pass-validate" in ALL_PASSES — this fails.
  it("sits in one block after the security family and before the validator", () => {
    const at = ALL_PASSES.indexOf(FAMILY[0]!);
    expect(ALL_PASSES[at - 1]).toBe(SECURITY_FAMILY.at(-1));
    expect(ALL_PASSES.slice(at, at + FAMILY.length)).toEqual(FAMILY);
    expect(ALL_PASSES[at + FAMILY.length]).toBe("pass-validate");
  });

  // MUTATION: replace `...STATE_FAMILY,` in ALL_PASSES with the eight names
  // written out — this fails.
  it("is declared once: passes.ts names each member a single time", () => {
    const src = readFileSync(join(ROOT, "packages", "pi-plugin", "src", "passes.ts"), "utf8");
    for (const lens of STATE_FAMILY) expect(src.split(`"${lens}"`).length - 1, lens).toBe(1);
    expect(src).toContain("...STATE_FAMILY,");
  });

  // MUTATION: give LENS_FAMILIES.state its own copy of the list — this fails.
  it("is the family table's state entry, by identity", () => {
    expect(LENS_FAMILIES.state).toBe(STATE_FAMILY);
  });

  // MUTATION: add "pass-sm-events" to DIFF_ONLY_LENSES — this fails.
  it("every member is a scan deep lens", () => {
    for (const lens of STATE_FAMILY) {
      expect(DIFF_ONLY_LENSES, lens).not.toContain(lens);
      expect(SCAN_DEEP_LENSES, lens).toContain(lens);
    }
  });
});

describe("the family's lens files", () => {
  // MUTATION: drop the `{{include:prompts/pass-sm-common.md}}` line from
  // agents/pass-sm-stuck.md — this fails.
  it("each includes the shared contract and the family's, and names its own kind", () => {
    for (const lens of STATE_FAMILY) {
      const text = readFileSync(join(ROOT, "agents", `${lens}.md`), "utf8");
      expect(text, lens).toMatch(new RegExp(`^---\\nname: ${lens}\\n`));
      expect(text, lens).toContain("{{include:prompts/pass-common.md}}");
      expect(text, lens).toContain("{{include:prompts/pass-sm-common.md}}");
      expect(text, lens).toContain(`\`${KIND[lens]}\``);
      for (const section of [
        "## Worksheet",
        "## Evidence lines",
        "## Never a finding",
        "## Stay inside your lens",
      ])
        expect(text, `${lens}: ${section}`).toContain(section);
    }
  });

  // The contract every lens includes is where the evidence standard and the
  // family's exclusions live; the validator's addendum reads the same lines.
  // MUTATION: delete the `trace:` line from the evidence block — this fails.
  it("the shared contract carries the evidence block, the outcomes and every owner", () => {
    const common = readFileSync(join(ROOT, "prompts", "pass-sm-common.md"), "utf8");
    for (const line of [
      "state-var:",
      "state:",
      "event:",
      "trace:",
      "unguarded:",
      "property:",
      "consequence:",
      "guards:",
      "proof-gaps:",
    ])
      expect(common, line).toContain(`    ${line}`);
    for (const outcome of ["**Confirmed**", "**Plausible**", "**Refuted**", "**Excluded**"])
      expect(common).toContain(outcome);
    expect(common).toContain("representable but not reachable");
    expect(common).toContain("`kind:` is `state-machine:<class>`");
    for (const lens of STATE_FAMILY) expect(common, lens).toContain(`- \`${lens}\`:`);
  });
});

/** A lens file or the shared contract, whitespace folded to single spaces. */
const flat = (rel: string): string => readFileSync(join(ROOT, rel), "utf8").replace(/\s+/g, " ");

describe("every lead a lens is handed is decided, and decided by a cited line", () => {
  const common = readFileSync(join(ROOT, "prompts", "pass-sm-common.md"), "utf8");
  /** The anchor-kind list of the tool section: kind → the lenses it names. */
  const owners = ((): Map<string, string[]> => {
    const list = common.slice(
      common.indexOf("Each anchor kind has its lenses:"),
      common.indexOf("Open and decide every anchor of your kinds."),
    );
    const out = new Map<string, string[]>();
    for (const item of list.split(/\n- /).slice(1)) {
      const colon = item.indexOf("`:");
      const kinds = [...item.slice(0, colon + 1).matchAll(/`([a-z-]+)`/g)].map((m) => m[1]!);
      const lenses = [...item.slice(colon).matchAll(/`(pass-[a-z-]+)`/g)].map((m) => m[1]!);
      for (const k of kinds) out.set(k, lenses);
    }
    return out;
  })();

  // An anchor kind no lens owns is a lead nobody decides.
  // MUTATION: delete the `call-to-cache` line from the anchor-kind list in
  // prompts/pass-sm-common.md — this fails. MUTATION: name `pass-sm-cache`
  // as its owner — this fails on family membership.
  it("each anchor kind the tool prints is owned by a family lens", () => {
    expect(owners.size).toBeGreaterThan(0);
    for (const kind of ANCHOR_KINDS) {
      expect(owners.get(kind)?.length ?? 0, kind).toBeGreaterThan(0);
      for (const lens of owners.get(kind)!)
        expect(STATE_FAMILY, `${kind}: ${lens}`).toContain(lens);
    }
  });

  // A kind the text hands a lens that the tool never prints is a lead the
  // lens waits for and never gets.
  // MUTATION: remove "writer-companion" from ANCHOR_KINDS in
  // packages/pi-plugin/src/stateexplore.ts — this fails.
  it("each anchor kind the text assigns is one the tool prints", () => {
    expect(owners.size).toBeGreaterThan(0);
    for (const kind of owners.keys()) expect(ANCHOR_KINDS, kind).toContain(kind);
  });

  // A write that lacks the mark its sibling writes carry is a stored write
  // that never persists, a transition that skips its siblings' work, or a
  // copy left stale: three lenses decide that anchor.
  // MUTATION: drop `pass-sm-durable` from the `writer-companion` line — this fails.
  it("writer-companion is decided by the durable, transitions and derived lenses", () => {
    expect(owners.get("writer-companion")).toEqual(
      expect.arrayContaining(["pass-sm-durable", "pass-sm-transitions", "pass-sm-derived"]),
    );
  });

  // MUTATION: restore the NONE-only `checked:` rule ("`NONE` is an answer
  // only with a `checked:` list") — this fails. MUTATION: drop "or with a
  // different problem reported at its lines" — this fails. MUTATION: drop
  // `missing before` or `not beside` from the row list (the tool's other
  // absence rows go undecided) — this fails.
  it("the shared contract says how a lead is decided, in these words", () => {
    const text = flat("prompts/pass-sm-common.md");
    for (const sentence of [
      "**Decide every lead:** each anchor of a kind your lens owns, and each row a tool call returned to you that names a statement one site has and another lacks (`missing near it`, `missing before`, `not beside`, `lacks`) where either site is a line the change adds, moves or removes.",
      "`cleared: <anchor or row> — <file:line you opened>, <what that line does that answers the lead>`",
      '"Handled", "safe" or "not needed" with no mechanism clears nothing, and neither does a lead with no cited line or with a different problem reported at its lines.',
      "A lead becomes a finding only through the trace and guard hunt of steps 5 and 6, never as a question because it was hard to clear.",
      "Two mechanisms are two findings, each with its own trace: a race and a halfway failure (a throw or crash between two writes) at the same lines;",
      "A write through a pointer or reference to long-lived state (an object's field, a global, a persisted struct) writes that state, not a local:",
      "the neighbouring lines each of them lacks, and those this place lacks that they carry.",
    ])
      expect(text, sentence.slice(0, 30)).toContain(sentence);
    // The worked example is in the format the rule names.
    const example = common.slice(common.indexOf("```\nNONE\nchecked:\n") + 4);
    const rows = example.slice(0, example.indexOf("```")).split("\n").slice(2, -1);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows)
      expect(row, row).toMatch(/^ {2}cleared: \[[a-z-]+\] \S+:\d+.* — \S+:\d+, /);
  });

  // MUTATION: put "A new optional field whose absence every reader treats as
  // its intended default" back under "Never a finding" in
  // agents/pass-sm-durable.md — this fails. MUTATION: drop step 8
  // (Registration) — this fails.
  it("the durable lens separates the cut from the race, asks for the registration, and narrows absent-means-default", () => {
    const durable = flat("agents/pass-sm-durable.md");
    for (const sentence of [
      "**The cut.** The process stops or a call throws — never a second actor —",
      "Answer the cut apart from any race step 3 found, with its own trace: a cut that leaves stored data nothing picks up from is its own finding once the hunt below finds nothing that makes it safe.",
      "A call that commits its own write (a repository or service method that saves, updates or deletes) is a stored write, though no tool follows it.",
      '"Absent means default" clears a new field only when the value an upgraded reader actually receives for it — read where the store loads it: an optional or nullable type, a language zero value, a deserializer or column default, a store merge that fills the initial state — is the value the new code intends,',
      "A store that tracks changes itself needs no mark: compare with the sibling writes, never with the API.",
      "**Registration.**",
      "(check with `writes` or a `writer-companion` anchor)",
    ])
      expect(durable, sentence.slice(0, 30)).toContain(sentence);
    const never = durable.slice(
      durable.indexOf("## Never a finding"),
      durable.indexOf("## Stay inside"),
    );
    expect(never.length).toBeGreaterThan(0);
    expect(never).not.toMatch(/absence|optional field/);
  });

  // MUTATION: delete the registration-order sentence from item 6 of
  // agents/pass-sm-lifecycle.md — this fails.
  it("the lifecycle lens reads early error exits against the registration order, and stuck hands that to it", () => {
    expect(flat("agents/pass-sm-lifecycle.md")).toContain(
      "against the registration order: an exit whose teardown assumes a setup step that has not run yet (it removes the object from a list or registry it was never added to, decrements a count never incremented, or asserts that it is registered), or after which the caller goes on to register or use the object the callee freed, is a finding. Freeing an object that was never registered, on an exit that then leaves setup, is the right cleanup.",
    );
    expect(flat("agents/pass-sm-stuck.md")).toContain(
      "An error exit whose teardown assumes a registration that has not happened yet is `pass-sm-lifecycle`'s.",
    );
  });
});

describe("isStateLens and isStateFinding", () => {
  // MUTATION: test only the first token of the field — the joined cases fail.
  it("reads a member however the session joined or suffixed it", () => {
    expect(isStateLens("pass-sm-stuck")).toBe(true);
    expect(isStateLens("pass-baseline + pass-sm-stuck")).toBe(true);
    expect(isStateLens("pass-sm-events,pass-sm-durable")).toBe(true);
    expect(isStateLens("pass-sm-transitions--deep")).toBe(true);
    expect(isStateLens("PASS-SM-STATES (2 lenses)")).toBe(true);
  });

  // MUTATION: match on the "pass-sm" prefix instead of membership — the
  // unknown-name case fails.
  it("reads nothing else as one", () => {
    expect(isStateLens("pass-sm-unknown")).toBe(false);
    expect(isStateLens("pass-statelessness")).toBe(false);
    expect(isStateLens("pass-sec-toctou")).toBe(false);
    expect(isStateLens("")).toBe(false);
  });

  // MUTATION: make STATE_KIND_RE match "state" alone — the `stateless` and
  // `state` cases fail.
  it("a finding is a state-machine finding by its lens or by its kind", () => {
    expect(isStateFinding("state-machine:stuck", "pass-baseline")).toBe(true);
    expect(isStateFinding("state-machine", null)).toBe(true);
    expect(isStateFinding(null, "pass-sm-durable")).toBe(true);
    expect(isStateFinding("logic", "pass-baseline")).toBe(false);
    expect(isStateFinding("state", "pass-baseline")).toBe(false);
    expect(isStateFinding("state-machinery", "pass-baseline")).toBe(false);
    expect(isStateFinding(undefined, undefined)).toBe(false);
  });

  it("the two families' findings stay apart", () => {
    expect(isSecurityFinding("state-machine:stuck", "pass-sm-stuck")).toBe(false);
    expect(isStateFinding("security:idor", "pass-sec-access")).toBe(false);
    expect(isSecurityLens("pass-sm-stuck")).toBe(false);
  });

  // A state defect a family lens hands to a security lens takes a security
  // kind, written by the lens or else by the validator: the record has no
  // owner field, so the kind is what makes the security rules judge it and
  // `scope = "security"` post it, and the lens keeps it a state finding.
  // MUTATION: delete the hand-off sentence from prompts/pass-sm-common.md, or
  // the `owner pass-sec-` sentence from VALIDATE_STATE_EVIDENCE_ADDENDUM
  // (include.ts) — this fails.
  it("a state defect handed to a security lens is a security finding and stays a state one", () => {
    expect(flat("prompts/pass-sm-common.md")).toContain(
      "A defect you hand to `pass-sec-*` or `pass-security` (`detail: owner pass-sec-…`) takes `kind: security:<class>` instead: the security rules judge and post it, and its `pass-sm-*` lens keeps it a state-machine finding.",
    );
    expect(VALIDATE_STATE_EVIDENCE_ADDENDUM).toContain(
      "A state candidate whose `detail` begins `owner pass-sec-` or `owner pass-security` is also a security candidate: record its `kind:` as `security` (or `security:<class>`) if the lens wrote `state-machine`.",
    );
    expect(isSecurityFinding("security:toctou", "pass-sm-events")).toBe(true);
    expect(isStateFinding("security:toctou", "pass-sm-events")).toBe(true);
  });

  it("canonical lens ids know the family", () => {
    expect(canonicalLensIds("pass-sm-stuck + pass-baseline")).toEqual([
      "pass-sm-stuck",
      "pass-baseline",
    ]);
  });
});

describe("a scan's kinds filter", () => {
  // MUTATION: drop the isStateKind clause from kindKept — the second
  // expectation fails (a family lens's finding is lost over a spelling).
  it("`state-machine` keeps every class, and a family lens's findings whatever kind it wrote", () => {
    expect(kindKept("state-machine:stuck", "pass-baseline", ["state-machine"])).toBe(true);
    expect(kindKept("stuck", "pass-sm-stuck", ["state-machine"])).toBe(true);
    expect(kindKept("logic", "pass-baseline", ["state-machine"])).toBe(false);
    expect(kindKept("security:idor", "pass-sec-access", ["state-machine"])).toBe(false);
  });

  it("a family lens under a state-machine kinds list keeps its plain ledger key", () => {
    expect(readingKey("pass-sm-stuck", ["state-machine"])).toBe("pass-sm-stuck");
    expect(readingKey("pass-baseline", ["state-machine"])).toBe(
      "pass-baseline:kinds=state-machine",
    );
  });
});

describe("the state-machines preset and flag", () => {
  // MUTATION: leave "pass-sm-derived" out of STATE_MACHINE_LENSES — this
  // fails (the preset would skip a family lens).
  it("the preset keeps the family and the validator, skips every other lens, and asks for the family", () => {
    expect([...STATE_MACHINE_LENSES]).toEqual([...STATE_FAMILY, "pass-validate"]);
    const preset = REVIEW_PRESETS["state-machines"];
    expect(preset.stateRequest).toBe(true);
    expect(preset.securityRequest).toBe(false);
    const skipped = preset.levers.replace("review.skip_lenses=", "").split("|");
    expect(skipped.sort()).toEqual(
      ALL_PASSES.filter((p) => !STATE_MACHINE_LENSES.includes(p)).sort(),
    );
  });

  it("the security preset now skips the state-machine family too", () => {
    const skipped = REVIEW_PRESETS.security.levers.replace("review.skip_lenses=", "").split("|");
    for (const lens of STATE_FAMILY) expect(skipped, lens).toContain(lens);
  });

  // MUTATION: drop the `--state-machines` case from parseReviewCommand — the
  // flag is then an unknown argument and this fails.
  it("/qcr-review reads the preset as its first word and the flag anywhere", () => {
    const preset = parseReviewCommand("state-machines 42");
    expect(preset).toMatchObject({ preset: "state-machines" });
    expect((preset as { stateRequest?: true }).stateRequest).toBeUndefined();
    const flag = parseReviewCommand("42 --state-machines");
    expect(flag).toMatchObject({ preset: null, stateRequest: true });
    const both = parseReviewCommand("--security --state-machines");
    expect(both).toMatchObject({ securityRequest: true, stateRequest: true });
  });
});
