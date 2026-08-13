import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyModelOverride,
  buildAgents,
  expandIncludes,
  frontmatterName,
  joinFrontmatter,
  splitFrontmatter,
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

  it("builds every pass-*.md into the output dir with includes expanded", () => {
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, { root });

    expect(built.map((b) => b.name)).toEqual(["pass-alpha", "pass-beta"]);
    const alpha = readFileSync(join(out, "pass-alpha.md"), "utf8");
    expect(alpha).toContain("# shared\nrules");
    expect(alpha).not.toContain("{{include:");
    expect(alpha).toContain("# Lens: alpha");
  });

  it("passes frontmatter through untouched without an override", () => {
    const out = join(root, "state", "agents");
    buildAgents(join(root, "agents"), out, { root });
    const alpha = readFileSync(join(out, "pass-alpha.md"), "utf8");
    expect(alpha.startsWith("---\nname: pass-alpha\ndescription: a\ntools: read, bash\nmodel: openai/gpt-5.6-sol\n---\n")).toBe(true);
  });

  it("applies the per-pass model override from config.models.passes", () => {
    const out = join(root, "state", "agents");
    const built = buildAgents(join(root, "agents"), out, { root, models: { "pass-beta": "openai/gpt-5.6-terra" } });

    expect(readFileSync(join(out, "pass-beta.md"), "utf8")).toContain("model: openai/gpt-5.6-terra");
    // untouched pass keeps its own model
    expect(readFileSync(join(out, "pass-alpha.md"), "utf8")).toContain("model: openai/gpt-5.6-sol");
    expect(built.find((b) => b.name === "pass-beta")?.model).toBe("openai/gpt-5.6-terra");
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
      expect(built).toHaveLength(9);
      for (const b of built) {
        const text = readFileSync(b.output, "utf8");
        expect(text).not.toContain("{{include:");
        expect(text).toContain("You are a **blank-slate review pass**"); // from pass-common.md
        expect(text.startsWith("---\nname: ")).toBe(true);
      }
      expect(built.map((b) => b.name)).toContain("pass-validate");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});
