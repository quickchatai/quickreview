// The state-machine family: the `pass-sm-*` lenses as one registered set
// (packages/pi-plugin/src/passes.ts `STATE_FAMILY`). A member must be a known
// pass with an agent file, every anchor kind state_explore prints must have a
// lens that decides it, a lens field that names one must read as a
// state-machine lens however a session joined it, and every list that derives
// from the registry (the preset, the lesson ids, the planning table) must pick
// the members up without an edit of its own. The lens files' and the shared
// contract's words are pinned byte for byte by tests/built-agents-golden.test.ts.
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

describe("the state-machine family", () => {
  // MUTATION: remove "pass-sm-stuck" from STATE_FAMILY — this fails (the
  // member list, and the every-pass-sm-name check, both lose it).
  it("is the eight pass-sm-* lenses, in registry order, and every pass-sm-* name is a member", () => {
    expect([...STATE_FAMILY]).toEqual(FAMILY);
    expect([...STATE_FAMILY]).toEqual(ALL_PASSES.filter((p) => p.startsWith("pass-sm-")));
  });

  // MUTATION: rename "pass-sm-events" in STATE_FAMILY to "pass-sm-event" —
  // this fails (no shipped agent file, no planning entry).
  it("every member is a known pass with a shipped agent file and a signal planning entry", () => {
    for (const lens of STATE_FAMILY) {
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

describe("every anchor kind state_explore prints has a lens that decides it", () => {
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
});

describe("isStateLens and isStateFinding", () => {
  // MUTATION: test only the first token of the field — the joined rows fail.
  // MUTATION: match on the "pass-sm" prefix instead of membership — the
  // unknown-name row fails.
  it.each([
    ["pass-sm-stuck", true],
    ["pass-baseline + pass-sm-stuck", true],
    ["pass-sm-events,pass-sm-durable", true],
    ["pass-sm-transitions--deep", true],
    ["PASS-SM-STATES (2 lenses)", true],
    ["pass-sm-unknown", false],
    ["pass-statelessness", false],
    ["pass-sec-toctou", false],
    ["", false],
  ])("isStateLens(%j) is %s", (field, want) => {
    expect(isStateLens(field)).toBe(want);
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

  // A state defect a family lens hands to a security lens takes a security
  // kind, so it is a security finding (the security rules judge it and
  // `scope = "security"` posts it), and its lens keeps it a state one.
  it("the two families' findings stay apart, but a handed-over state defect is both", () => {
    expect(isSecurityFinding("state-machine:stuck", "pass-sm-stuck")).toBe(false);
    expect(isStateFinding("security:idor", "pass-sec-access")).toBe(false);
    expect(isSecurityLens("pass-sm-stuck")).toBe(false);
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
