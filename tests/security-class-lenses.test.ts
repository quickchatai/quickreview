// The seven class lenses of the security family (access, injection,
// boundaries, secrets-data, supply-chain, llm, variant): what each one's own
// text must carry beyond the family contract that
// `tests/security-lens-content.test.ts` holds. Routing is total only when
// every hand-off names a real member and every lens says where its remit
// ends, and the ownership rulings that moved a concern between lenses (OAuth
// `state`, row-level security, the privileged fields) must be written where
// the lens that gave the concern away will read them.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitFrontmatter } from "@quickchatai/pi-quickreview/src/include.js";
import { SECURITY_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";

const ROOT = join(import.meta.dirname, "..");

const CLASS_LENSES = [
  "pass-sec-access",
  "pass-sec-injection",
  "pass-sec-boundaries",
  "pass-sec-secrets-data",
  "pass-sec-supply-chain",
  "pass-sec-llm",
  "pass-sec-variant",
] as const;

/** The base block's lines and the named lines the family contract defines. */
const EVIDENCE_FIELDS = new Set([
  "source",
  "boundary",
  "sink",
  "path",
  "controls",
  "cwe",
  "proof-gaps",
  "gains",
  "pr-hop",
  "between",
  "lifetime",
  "listener",
  "siblings",
  "bypass",
  "glue",
  "weakest",
]);

const body = (lens: string): string =>
  splitFrontmatter(readFileSync(join(ROOT, "agents", `${lens}.md`), "utf8")).body;

/** The lens's own words: its body without the include lines (the family
 * contract's file is `pass-sec-common`, which is not a member). */
const ownText = (lens: string): string => body(lens).replace(/\{\{include:[^}]*\}\}/g, "");

/** The text under `## <heading>`, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const at = text.indexOf(`\n## ${heading}\n`);
  if (at === -1) return "";
  const rest = text.slice(at + heading.length + 5);
  const next = rest.indexOf("\n## ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the class lenses", () => {
  it("are family members", () => {
    for (const lens of CLASS_LENSES) expect(SECURITY_FAMILY, lens).toContain(lens);
  });

  // A hand-off to a name that is not a member sends the defect nowhere.
  // MUTATION: write `pass-sec-authn` for `pass-sec-authn-coverage` in
  // agents/pass-sec-access.md — fails.
  it("hand off only to family members", () => {
    for (const lens of CLASS_LENSES)
      for (const [name] of ownText(lens).matchAll(/pass-sec-[a-z]+(?:-[a-z]+)*/g))
        expect(SECURITY_FAMILY, `${lens} names ${name}`).toContain(name);
  });

  // MUTATION: delete the "## Stay inside your lens" section of
  // agents/pass-sec-boundaries.md — fails.
  it("each end with where their remit stops, naming another member", () => {
    for (const lens of CLASS_LENSES) {
      const stay = section(body(lens), "Stay inside your lens");
      const others = [...stay.matchAll(/`(pass-sec-[a-z-]+)`/g)]
        .map((m) => m[1])
        .filter((n) => n !== lens);
      expect(others.length, `${lens}: Stay inside your lens`).toBeGreaterThan(0);
      expect(section(body(lens), "Never a finding").trim(), `${lens}: Never a finding`).not.toBe(
        "",
      );
    }
  });

  // The family contract defines every named line once; a lens that invents
  // its own field gives the evidence parser a line no lens agrees on.
  // MUTATION: add a `    payload:` line to the evidence lines of
  // agents/pass-sec-injection.md — fails.
  it("add only evidence lines the family contract defines", () => {
    for (const lens of CLASS_LENSES) {
      const lines = section(body(lens), "Evidence lines");
      for (const [, field] of lines.matchAll(/^ {4}([a-z-]+):/gm))
        expect(EVIDENCE_FIELDS.has(field!), `${lens}: ${field}:`).toBe(true);
    }
  });
});

describe("the ownership rulings, where the class lens reads them", () => {
  // MUTATION: drop "OAuth `state` is `pass-sec-tokens`'s" from
  // agents/pass-sec-access.md — fails.
  it("access gives OAuth state to tokens, row-level security off to authn-coverage, privileged fields to privesc", () => {
    const stay = section(body("pass-sec-access"), "Stay inside your lens");
    expect(stay).toContain("OAuth `state` is `pass-sec-tokens`'s");
    expect(stay).toMatch(/row-level security switched off[\s\S]*`pass-sec-authn-coverage`'s/);
    expect(stay).toMatch(/privileged fields[\s\S]*`pass-sec-privesc`'s/);
  });

  // MUTATION: drop the "Secrets ignore reachability" paragraph from
  // agents/pass-sec-secrets-data.md — fails.
  it("secrets-data ignores reachability and keeps the cache and log-payload rules", () => {
    const text = body("pass-sec-secrets-data");
    expect(text).toContain("**Secrets ignore reachability.**");
    expect(text).toContain("`Cache-Control: no-store`");
    expect(text).toContain("`Vary`");
    expect(text).toContain("`refresh_token`");
  });

  it("injection names the escape hatches and keeps a token's kid in a query", () => {
    const text = body("pass-sec-injection");
    for (const hatch of ["`raw()`", "`|safe`", "`dangerouslySetInnerHTML`", "`shell=True`"])
      expect(text, hatch).toContain(hatch);
    expect(text).toContain("`kid` that reaches a query or a filter is yours");
  });

  // An event expression written with its wrapper would be a build-time
  // variable in a lens body (`{{` fails the build) or, wrapped once, read
  // as one by a model.
  // MUTATION: write the event expression with its `${…}` wrapper in
  // agents/pass-sec-supply-chain.md — fails.
  it("supply-chain writes the event expression without its wrapper", () => {
    const text = body("pass-sec-supply-chain");
    expect(text).toContain("`pull_request_target`");
    expect(text).toContain("`github.event.pull_request.title`");
    expect(text).not.toContain("${");
  });

  it("llm requires the source, the model hop and the control effect, all three", () => {
    const text = body("pass-sec-llm");
    expect(text).toContain(
      "the **payload or\nuntrusted source**, the **model hop** that carries it, and the **control\neffect**",
    );
  });

  // The variant lens reads history with the git verbs the exec policy
  // already allows; it may not carry a command list of its own.
  // MUTATION: add "Allowed commands: git, rg" to agents/pass-sec-variant.md — fails.
  it("variant reports siblings only and adds no command list", () => {
    const text = body("pass-sec-variant");
    expect(text).toContain("read-only `git log`");
    expect(text).toContain("The seed hunk itself");
    expect(text).not.toMatch(/allowed commands/i);
  });
});
