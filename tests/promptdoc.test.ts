// src/promptdoc.ts — maintainer-only text never reaches a model: the
// `> Sandbox file:` doc header and the RATIFIED fence marker lines stay in the
// source (people and tests/invariant-fences.test.ts read them there) and are
// stripped on every load path that hands a prompt file to a model.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stripModelDocs } from "../src/promptdoc.js";
import { renderRecheckPrompt } from "../src/templates.js";

const ROOT = join(import.meta.dirname, "..");

describe("stripModelDocs", () => {
  it("drops the doc header and its rule, keeps the title and the body", () => {
    const src =
      "# Title\n\n> Sandbox file: `x.md`. Placeholders: `{{a}}`\n> more\n\n---\n\nBody {{a}}\n";
    expect(stripModelDocs(src)).toBe("# Title\n\nBody {{a}}\n");
  });
  it("drops the fence marker lines and keeps the fenced text byte for byte", () => {
    const src =
      "a\n<!-- RATIFIED x — do not edit; owner only -->\nkept\n<!-- /RATIFIED x -->\nb\n";
    expect(stripModelDocs(src)).toBe("a\nkept\nb\n");
  });
  it("leaves other HTML comments alone (the Slack origin marker is an instruction)", () => {
    expect(stripModelDocs("<!-- qcr:slack v1 -->\n")).toBe("<!-- qcr:slack v1 -->\n");
  });
  it("a text without either is unchanged", () => {
    expect(stripModelDocs("# T\n\n> a quote, not a header\n")).toBe(
      "# T\n\n> a quote, not a header\n",
    );
  });
  it("the recheck render no longer sends its evidence twice (the header listed the placeholders)", () => {
    const tpl = readFileSync(join(ROOT, "prompts", "round-recheck.md"), "utf8");
    expect(tpl).toContain("> Sandbox file:");
    expect(stripModelDocs(tpl)).not.toContain("Sandbox file");
    expect(typeof renderRecheckPrompt).toBe("function");
  });
});
