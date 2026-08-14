import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXECUTION_POLICY_ADDENDUM,
  applyModelOverride,
  applyNameOverride,
  applyThinkingOverride,
  buildAgents,
  expandIncludes,
  frontmatterName,
  joinFrontmatter,
  splitFrontmatter,
  splitModelSpec,
  tiersForPass,
} from "../src/include.js";

/** In-memory fs for the pure expansion tests. */
function fakeFs(files: Record<string, string>) {
  return (path: string) => {
    const f = files[path];
    if (f === undefined) throw new Error("ENOENT");
    return f;
  };
}

describe("expandIncludes", () => {
  const root = "/sandbox";

  it("expands a single include, path relative to the sandbox root", () => {
    const readFile = fakeFs({ "/sandbox/prompts/pass-common.md": "SHARED CONTRACT" });
    expect(expandIncludes("head\n{{include:prompts/pass-common.md}}\ntail", { root, readFile })).toBe(
      "head\nSHARED CONTRACT\ntail",
    );
  });

  it("expands every occurrence, including repeats", () => {
    const readFile = fakeFs({ "/sandbox/a.md": "A" });
    expect(expandIncludes("{{include:a.md}}|{{include:a.md}}", { root, readFile })).toBe("A|A");
  });

  it("expands recursively", () => {
    const readFile = fakeFs({
      "/sandbox/a.md": "A[{{include:b.md}}]",
      "/sandbox/b.md": "B[{{include:c.md}}]",
      "/sandbox/c.md": "C",
    });
    expect(expandIncludes("{{include:a.md}}", { root, readFile })).toBe("A[B[C]]");
  });

  it("detects a direct cycle", () => {
    const readFile = fakeFs({ "/sandbox/a.md": "{{include:a.md}}" });
    expect(() => expandIncludes("{{include:a.md}}", { root, readFile })).toThrow(/include cycle/);
  });

  it("detects an indirect cycle", () => {
    const readFile = fakeFs({ "/sandbox/a.md": "{{include:b.md}}", "/sandbox/b.md": "{{include:a.md}}" });
    expect(() => expandIncludes("{{include:a.md}}", { root, readFile })).toThrow(/include cycle/);
  });

  it("throws on a missing include instead of emitting the directive", () => {
    const readFile = fakeFs({});
    expect(() => expandIncludes("{{include:nope.md}}", { root, readFile })).toThrow(/include not found/);
  });

  it("rejects absolute include paths", () => {
    expect(() => expandIncludes("{{include:/etc/passwd}}", { root, readFile: fakeFs({}) })).toThrow(/relative/);
  });

  it("leaves text without directives untouched", () => {
    const text = "no directives here {{not-an-include}}";
    expect(expandIncludes(text, { root, readFile: fakeFs({}) })).toBe(text);
  });
});

describe("frontmatter", () => {
  const doc = `---\nname: pass-x\nmodel: openai/gpt-5.6-sol\n---\nbody {{include:p.md}}\n`;

  it("splits and rejoins byte-for-byte", () => {
    const parsed = splitFrontmatter(doc);
    expect(parsed.hasFrontmatter).toBe(true);
    expect(frontmatterName(parsed.frontmatter)).toBe("pass-x");
    expect(joinFrontmatter(parsed)).toBe(doc);
  });

  it("treats a file without frontmatter as all body", () => {
    const parsed = splitFrontmatter("# just markdown\n");
    expect(parsed.hasFrontmatter).toBe(false);
    expect(parsed.body).toBe("# just markdown\n");
  });

  it("replaces the model field in place, leaving other fields alone", () => {
    const fm = "name: pass-x\ndescription: d\nmodel: openai/gpt-5.6-sol\ntools: read\n";
    expect(applyModelOverride(fm, "openai/gpt-5.6-terra")).toBe(
      "name: pass-x\ndescription: d\nmodel: openai/gpt-5.6-terra\ntools: read\n",
    );
  });

  it("adds a model field when absent", () => {
    expect(applyModelOverride("name: pass-x\n", "m")).toBe("name: pass-x\nmodel: m\n");
  });

  it("rewrites the name field and adds/rewrites thinking", () => {
    expect(applyNameOverride("name: pass-x\nmodel: m\n", "pass-x--sol-med")).toBe("name: pass-x--sol-med\nmodel: m\n");
    expect(applyThinkingOverride("name: pass-x\n", "high")).toBe("name: pass-x\nthinking: high\n");
    expect(applyThinkingOverride("thinking: low\n", "medium")).toBe("thinking: medium\n");
  });
});

describe("splitModelSpec", () => {
  it("splits a recognized thinking suffix into the separate field", () => {
    expect(splitModelSpec("openai-codex/gpt-5.6-sol:high")).toEqual({ model: "openai-codex/gpt-5.6-sol", thinking: "high" });
    expect(splitModelSpec("openai-codex/gpt-5.6-terra:medium")).toEqual({
      model: "openai-codex/gpt-5.6-terra",
      thinking: "medium",
    });
  });

  it("leaves specs without a thinking suffix whole", () => {
    expect(splitModelSpec("openai-codex/gpt-5.6-sol")).toEqual({ model: "openai-codex/gpt-5.6-sol", thinking: null });
    // A colon whose tail is not a thinking level is part of the model id.
    expect(splitModelSpec("provider/model:v2")).toEqual({ model: "provider/model:v2", thinking: null });
  });
});

describe("tiersForPass", () => {
  const risk = ["pass-security", "pass-prod-risk", "pass-data-safety"];

  it("risk passes get only sol-high; validate its fixed tier; others all three", () => {
    expect(tiersForPass("pass-security", risk, "terra-med")).toEqual(["sol-high"]);
    expect(tiersForPass("pass-validate", risk, "terra-med")).toEqual(["terra-med"]);
    expect(tiersForPass("pass-baseline", risk, "terra-med")).toEqual(["terra-med", "sol-med", "sol-high"]);
  });
});

describe("buildAgents", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-include-"));
    mkdirSync(join(root, "agents"));
    mkdirSync(join(root, "prompts"));
    writeFileSync(join(root, "prompts", "pass-common.md"), "# shared\nrules\n");
    writeFileSync(
      join(root, "agents", "pass-alpha.md"),
      `---\nname: pass-alpha\ndescription: a\ntools: read, bash\nmodel: openai/gpt-5.6-sol\n---\n\n{{include:prompts/pass-common.md}}\n\n# Lens: alpha\n`,
    );
    writeFileSync(
      join(root, "agents", "pass-beta.md"),
      `---\nname: pass-beta\nmodel: openai/gpt-5.6-sol\n---\n\n{{include:prompts/pass-common.md}}\n`,
    );
    writeFileSync(join(root, "agents", "not-a-pass.md"), "ignored\n");
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("fans every pass out into per-tier variant files with includes expanded", () => {
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, { root });

    expect(built.map((b) => b.name)).toEqual([
      "pass-alpha--terra-med",
      "pass-alpha--sol-med",
      "pass-alpha--sol-high",
      "pass-beta--terra-med",
      "pass-beta--sol-med",
      "pass-beta--sol-high",
    ]);
    const alpha = readFileSync(join(out, "pass-alpha--sol-med.md"), "utf8");
    expect(alpha).toContain("# shared\nrules");
    expect(alpha).not.toContain("{{include:");
    expect(alpha).toContain("# Lens: alpha");
  });

  it("writes variant name/model/thinking frontmatter, other fields untouched", () => {
    const out = join(root, "state", "agents");
    buildAgents(join(root, "agents"), out, { root });
    const alpha = readFileSync(join(out, "pass-alpha--terra-med.md"), "utf8");
    expect(alpha.startsWith("---\nname: pass-alpha--terra-med\ndescription: a\ntools: read, bash\nmodel: openai-codex/gpt-5.6-terra\n")).toBe(true);
    expect(alpha).toContain("thinking: medium\n");
    const high = readFileSync(join(out, "pass-alpha--sol-high.md"), "utf8");
    expect(high).toContain("name: pass-alpha--sol-high\n");
    expect(high).toContain("model: openai-codex/gpt-5.6-sol\n");
    expect(high).toContain("thinking: high\n");
    // The thinking suffix never leaks into the model field.
    expect(high).not.toContain("model: openai-codex/gpt-5.6-sol:high");
  });

  it("appends the execution-policy addendum to every built body (seeds untouched)", () => {
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, { root });
    for (const b of built) {
      expect(readFileSync(b.output, "utf8")).toContain("## Execution policy (sandbox rule, enforced)");
      expect(readFileSync(b.output, "utf8").endsWith(EXECUTION_POLICY_ADDENDUM)).toBe(true);
    }
    expect(readFileSync(join(root, "agents", "pass-alpha.md"), "utf8")).not.toContain("Execution policy");
  });

  it("builds a single sol-high variant for risk passes and a single fixed-tier validate", () => {
    writeFileSync(
      join(root, "agents", "pass-validate.md"),
      `---\nname: pass-validate\nmodel: openai/gpt-5.6-sol\n---\n\n{{include:prompts/pass-common.md}}\n`,
    );
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, {
      root,
      riskPasses: ["pass-alpha"],
      validateTier: "terra-med",
    });
    expect(built.filter((b) => b.pass === "pass-alpha").map((b) => b.name)).toEqual(["pass-alpha--sol-high"]);
    expect(built.filter((b) => b.pass === "pass-validate").map((b) => b.name)).toEqual(["pass-validate--terra-med"]);
    expect(built.filter((b) => b.pass === "pass-beta")).toHaveLength(3);
    const validate = readFileSync(join(out, "pass-validate--terra-med.md"), "utf8");
    expect(validate).toContain("model: openai-codex/gpt-5.6-terra\n");
    expect(validate).toContain("thinking: medium\n");
  });

  it("honors custom tier specs and per-variant model overrides", () => {
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, {
      root,
      tiers: {
        "terra-med": "openai-codex/custom-terra:low",
        "sol-med": "openai-codex/custom-sol:medium",
        "sol-high": "openai-codex/custom-sol:high",
      },
      models: { "pass-beta--sol-high": "openai-codex/override-model" },
    });
    expect(readFileSync(join(out, "pass-alpha--terra-med.md"), "utf8")).toContain("model: openai-codex/custom-terra\n");
    expect(readFileSync(join(out, "pass-alpha--terra-med.md"), "utf8")).toContain("thinking: low\n");
    const beta = built.find((b) => b.name === "pass-beta--sol-high");
    expect(beta?.model).toBe("openai-codex/override-model");
    expect(beta?.thinking).toBe(null);
    expect(readFileSync(join(out, "pass-beta--sol-high.md"), "utf8")).toContain("model: openai-codex/override-model\n");
  });

  it("ignores non pass-* files", () => {
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, { root });
    expect(built.some((b) => b.source.endsWith("not-a-pass.md"))).toBe(false);
  });

  it("throws when a seeded agent references a missing include", () => {
    writeFileSync(join(root, "agents", "pass-broken.md"), `---\nname: pass-broken\n---\n{{include:prompts/gone.md}}\n`);
    expect(() => buildAgents(join(root, "agents"), join(root, "state", "agents"), { root })).toThrow(/include not found/);
  });
});

describe("the real seeded content", () => {
  it("expands every seeded agent against the real prompts/ dir", () => {
    const sandbox = join(import.meta.dirname, "..");
    const out = mkdtempSync(join(tmpdir(), "qcr-agents-build-"));
    try {
      const built = buildAgents(join(sandbox, "agents"), out, { root: sandbox });
      // 5 raisable passes × 3 tiers + 3 risk passes × 1 + validate × 1 = 19.
      expect(built).toHaveLength(19);
      for (const b of built) {
        const text = readFileSync(b.output, "utf8");
        expect(text).not.toContain("{{include:");
        expect(text).toContain("You are a **blank-slate review pass**"); // from pass-common.md
        expect(text).toContain("## Execution policy (sandbox rule, enforced)");
        expect(text.startsWith(`---\nname: ${b.name}\n`)).toBe(true);
        expect(b.name).toBe(`${b.pass}--${b.tier}`);
      }
      const names = built.map((b) => b.name);
      expect(names).toContain("pass-validate--terra-med");
      expect(names).toContain("pass-security--sol-high");
      expect(names).not.toContain("pass-security--terra-med");
      expect(names).not.toContain("pass-security--sol-med");
      expect(names.filter((n) => n.startsWith("pass-baseline--"))).toHaveLength(3);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
