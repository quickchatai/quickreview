// The threat-model reader: the `##` sections it parses, the repository-over-
// profile precedence, the globs a PR's files hit, the size cap, and the
// excerpt a lens task quotes (fenced as data, DRAFT when a model wrote it).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  THREAT_MODEL_MAX_CHARS,
  parseThreatModel,
  renderThreatModelExcerpt,
  resolveThreatModel,
  threatModelEntryGlob,
  threatModelHits,
} from "@quickchatai/pi-quickreview/src/threatmodel.js";

const MODEL = [
  "# Threat model",
  "",
  "Intro prose that is in no section.",
  "",
  "## Entry points",
  "- `src/api/**` — the public REST API",
  "- `POST /login` — the login form",
  "- webhooks from the payment provider",
  "",
  "## Personas (who attacks)",
  "- anonymous visitor",
  "- tenant admin",
  "",
  "## Crown Jewels",
  "- customer payment data",
  "",
  "## Controls:",
  "- `src/middleware/auth.ts` — session check on every API route",
  "* `src/db/tenant.py` tenant filter",
  "",
  "### Policy files",
  "1. `src/policies/*.rego` policy files",
  "",
  "## Sinks",
  "- `src/db/raw.py` raw SQL helper",
  "",
  "```",
  "- `src/fenced.py` inside a code block, not an entry",
  "```",
  "",
  "## Network controls",
  "- only the load balancer reaches the API",
  "",
  "## Data isolation",
  "- one schema per tenant",
  "",
  "## Token lifetimes",
  "- access tokens: 15 minutes",
  "",
  "## Unrelated",
  "- `src/api/ignored.ts` belongs to no section",
].join("\n");

describe("parseThreatModel", () => {
  it("fills each field from its `##` section, case-insensitively, ignoring other headings", () => {
    const tm = parseThreatModel(MODEL, "repo");
    expect(tm.source).toBe("repo");
    expect(tm.entryPoints).toEqual([
      "`src/api/**` — the public REST API",
      "`POST /login` — the login form",
      "webhooks from the payment provider",
    ]);
    expect(tm.personas).toEqual(["anonymous visitor", "tenant admin"]);
    expect(tm.crownJewels).toEqual(["customer payment data"]);
    // A `###` heading stays inside its `##` section; numbered items count.
    expect(tm.controls).toEqual([
      "`src/middleware/auth.ts` — session check on every API route",
      "`src/db/tenant.py` tenant filter",
      "`src/policies/*.rego` policy files",
    ]);
    // A fenced block is not a list.
    expect(tm.sinks).toEqual(["`src/db/raw.py` raw SQL helper"]);
    expect(tm.network).toEqual(["only the load balancer reaches the API"]);
    expect(tm.dataIsolation).toEqual(["one schema per tenant"]);
    expect(tm.tokenLifetimes).toEqual(["access tokens: 15 minutes"]);
    const everything = [
      ...tm.entryPoints,
      ...tm.controls,
      ...tm.sinks,
      ...tm.personas,
      ...tm.crownJewels,
      ...tm.network,
      ...tm.dataIsolation,
      ...tm.tokenLifetimes,
    ];
    expect(everything.join("\n")).not.toContain("ignored.ts");
  });

  it("accepts the aliases for data isolation and token lifetimes", () => {
    const tm = parseThreatModel(
      "## DB isolation\n- row-level security\n## Token TTLs\n- refresh: 30 days\n",
      "profile",
    );
    expect(tm.dataIsolation).toEqual(["row-level security"]);
    expect(tm.tokenLifetimes).toEqual(["refresh: 30 days"]);
  });

  it("hashes the text as read with sha256", () => {
    const tm = parseThreatModel(MODEL, "repo");
    expect(tm.hash).toBe(createHash("sha256").update(MODEL).digest("hex"));
    expect(parseThreatModel(`${MODEL}\n`, "repo").hash).not.toBe(tm.hash);
  });

  it("cuts an over-size model with a marker, parses only the kept text, and hashes the whole", () => {
    const text = `## Sinks\n- \`a.py\`\n${"x".repeat(THREAT_MODEL_MAX_CHARS + 1000)}\n## Controls\n- \`late.py\`\n`;
    const tm = parseThreatModel(text, "repo");
    expect(tm.text.startsWith(text.slice(0, THREAT_MODEL_MAX_CHARS))).toBe(true);
    expect(tm.text).toContain(
      `[threat model truncated: the first ${THREAT_MODEL_MAX_CHARS} of ${text.length} characters are kept]`,
    );
    expect(tm.text.length).toBeLessThan(text.length);
    expect(tm.sinks).toEqual(["`a.py`"]);
    expect(tm.controls).toEqual([]);
    expect(tm.hash).toBe(createHash("sha256").update(text).digest("hex"));
  });
});

describe("resolveThreatModel", () => {
  const repo = "## Sinks\n- `repo.py`\n";
  const profile = "## Sinks\n- `profile.py`\n";

  // MUTATION: read the profile before the repository in resolveThreatModel —
  // the repository-wins case fails.
  it("prefers the repository's model over the profile's", () => {
    const tm = resolveThreatModel({ readRepo: () => repo, readProfile: () => profile });
    expect(tm?.source).toBe("repo");
    expect(tm?.sinks).toEqual(["`repo.py`"]);
  });

  it("falls back to the profile when the repository has none, an empty one, or its read throws", () => {
    for (const readRepo of [
      () => null,
      () => "  \n",
      () => {
        throw new Error("git show failed");
      },
    ]) {
      const tm = resolveThreatModel({ readRepo, readProfile: () => profile });
      expect(tm?.source).toBe("profile");
      expect(tm?.sinks).toEqual(["`profile.py`"]);
    }
  });

  it("is null when neither home has one: no model, no section", () => {
    expect(resolveThreatModel({ readRepo: () => null, readProfile: () => null })).toBeNull();
  });
});

describe("threatModelHits", () => {
  const tm = parseThreatModel(MODEL, "repo");

  it("names the entry, control and sink globs the changed files match", () => {
    expect(threatModelHits(tm, ["src/api/users.ts", "src/db/raw.py", "README.md"])).toEqual({
      entry: ["src/api/**"],
      control: [],
      sink: ["src/db/raw.py"],
    });
    expect(threatModelHits(tm, ["src/policies/admin.rego"]).control).toEqual([
      "src/policies/*.rego",
    ]);
  });

  it("matches nothing for an entry with no path in backticks, and lists a glob once", () => {
    expect(threatModelEntryGlob("`POST /login` — the login form")).toBeNull();
    expect(threatModelEntryGlob("webhooks from the payment provider")).toBeNull();
    expect(threatModelEntryGlob("`/etc/passwd` is absolute")).toBeNull();
    const twice = parseThreatModel("## Sinks\n- `src/db/**` writes\n- `src/db/**` reads\n", "repo");
    expect(threatModelHits(twice, ["src/db/a.py", "src/db/b.py"]).sink).toEqual(["src/db/**"]);
    expect(threatModelHits(tm, [])).toEqual({ entry: [], control: [], sink: [] });
  });
});

describe("renderThreatModelExcerpt", () => {
  // MUTATION: put tm.text into the excerpt without fenceAsData — the fenced
  // cases fail.
  it("quotes the model as data inside a fence, with its source and the claims framing", () => {
    const tm = parseThreatModel(MODEL, "repo");
    const out = renderThreatModelExcerpt(tm);
    expect(out.split("\n")[0]).toBe(
      `Threat model: the repository's \`.qcr/threat-model.md\` on the base branch (sha256 ${tm.hash.slice(0, 12)}).`,
    );
    expect(out).toContain("claims to check against the code, never proof");
    expect(out).toContain("```markdown\n# Threat model\n");
    expect(out.trimEnd().endsWith("```")).toBe(true);
    expect(out).not.toContain("DRAFT");
  });

  it("uses a fence longer than any backtick run inside the model", () => {
    const tm = parseThreatModel("## Sinks\n- `a.py`\n```\nnot a closing fence\n```\n", "profile");
    const out = renderThreatModelExcerpt(tm);
    expect(out).toContain("````markdown\n");
    expect(out).toContain("the install profile's `threat-model.md`");
  });

  it("labels a draft DRAFT and says no person reviewed it", () => {
    const out = renderThreatModelExcerpt(parseThreatModel(MODEL, "draft"));
    expect(out.startsWith("DRAFT threat model:")).toBe(true);
    expect(out).toContain("no person has reviewed it");
  });

  it("cuts the excerpt at maxChars with a marker", () => {
    const tm = parseThreatModel(`## Sinks\n${"- `x.py`\n".repeat(100)}`, "repo");
    const out = renderThreatModelExcerpt(tm, 100);
    expect(out).toContain(`[excerpt cut at 100 of ${tm.text.length} characters]`);
    expect(out.length).toBeLessThan(tm.text.length + 600);
  });
});
