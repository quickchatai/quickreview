// The repo portrait (src/setup/portrait.ts via SetupEngine). Every
// port faked the setup-engine way — an in-memory checkout, no memory, fake
// case runner / tracker / GitHub — and the two homes are temp dirs behind the
// real rooted ports. The contract under test: the FACTS (stack + units,
// conventions + what is enforced, review history themes) are assembled
// deterministically into the STATE home; the companion's NARRATIVE is stored
// in the CONFIG home against the facts' key; each half keeps the version it
// replaced, so a refresh can be diffed; and nothing of the raw review history
// reaches either.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DIGEST_KIND, DIGEST_VERSION, type ReviewHistoryDigest } from "../src/reviewhistory.js";
import { configHomeFs, notYetTrackerSink, stateHomeFs } from "../src/setup/adapters.js";
import { SetupEngine, type RepoReader } from "../src/setup/engine.js";
import { HISTORY_DIGEST_FILE, HISTORY_THEMES_FILE } from "../src/setup/history.js";
import {
  NARRATIVE_FILE,
  NARRATIVE_MAX,
  NARRATIVE_PREVIOUS_FILE,
  PORTRAIT_FACTS_FILE,
  lineDiff,
  parseNarrative,
  type PortraitFactsFile,
} from "../src/setup/portrait.js";
import { PORTRAIT_DIR } from "../src/install.js";
import { renderPortrait } from "../extensions/setup.js";
import type { StateFs } from "../src/setup/engine.js";

let dir: string;
let now: Date;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-portrait-"));
  now = new Date("2026-09-29T10:00:00Z");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stateDir = (): string => join(dir, "state");
const configDir = (): string => join(dir, "config");

function fakeRepo(files: Record<string, string>): RepoReader & { files: Record<string, string> } {
  const r = {
    files,
    location: "/reviewed-repo",
    listFiles: () => Object.keys(r.files),
    read: (p: string) => r.files[p] ?? null,
    lines: (p: string) => {
      const t = r.files[p];
      return t === undefined ? null : t.split("\n").length - (t.endsWith("\n") ? 1 : 0);
    },
    head: () => "abc123def4567890",
  };
  return r;
}

const REPO = {
  "README.md": "# hi\n",
  "AGENTS.md": "Use the service layer.\n",
  ".github/workflows/ci.yml": "name: CI\n",
  "backend/pyproject.toml":
    '[project]\ndependencies = [\n  "django>=4",\n]\n[tool.ruff]\nline-length = 100\n',
  "backend/payments/apps.py": "x\n",
  "backend/payments/models.py": "a\nb\nc\n",
  "frontend/package.json": JSON.stringify({ dependencies: { react: "18" } }),
  "frontend/src/app.tsx": "x\n",
  "frontend/node_modules/react/index.js": "x\n",
};

function engine(opts: { repo?: ReturnType<typeof fakeRepo> | RepoReader; config?: boolean } = {}) {
  const repo = (opts.repo ?? fakeRepo({ ...REPO })) as ReturnType<typeof fakeRepo>;
  const e = new SetupEngine({
    repo,
    state: stateHomeFs(stateDir()),
    ...(opts.config === false ? {} : { config: configHomeFs(configDir()) }),
    clock: () => now,
    memory: null,
    cases: { run: async () => ({ ok: false, reason: "no cases in these tests" }) },
    tracker: notYetTrackerSink(""),
    github: { get: async () => ({ ok: false, reason: "no network in tests" }) },
  });
  return { e, repo };
}

function factsOnDisk(): PortraitFactsFile {
  return JSON.parse(
    readFileSync(join(stateDir(), PORTRAIT_FACTS_FILE), "utf8"),
  ) as PortraitFactsFile;
}

function assembled(e: SetupEngine) {
  const r = e.portraitAssemble();
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r;
}

const RAW =
  "Please always wrap payment writes in a database transaction so a crash never leaves half a charge.";

function digest(): ReviewHistoryDigest {
  return {
    kind: DIGEST_KIND,
    version: DIGEST_VERSION,
    repo: "example-org/example-app",
    generated_at: "2026-09-29T09:00:00.000Z",
    window: { since: "2026-03-29T09:00:00.000Z", until: "2026-09-29T09:00:00.000Z", months: 6 },
    human: {
      prs_enumerated: 1,
      prs_scanned: 1,
      prs_missing: 0,
      truncated: false,
      comments: [
        {
          pr: 12,
          merged_at: null,
          kind: "inline",
          state: "CHANGES_REQUESTED",
          path: "pay/charge.py",
          author: "rev-alpha",
          body: RAW,
        },
      ],
    },
    rounds: [],
    feedback: [],
    problems: [],
  };
}

const THEME = {
  title: "Money writes are atomic",
  summary: "Payment code is expected to commit in one transaction.",
  source: "human",
  weight: 1,
};

describe("the facts: assembled into the state home", () => {
  it("covers the stack, the units, the conventions, what is enforced and the themes — candidates flagged before a cut is saved", () => {
    const { e } = engine();
    const r = assembled(e);
    const f = r.current.facts;
    expect(r.current.key).toMatch(/^[0-9a-f]{12}$/);
    expect(f.head).toBe("abc123def4567890");
    expect(f.stack.frameworks.map((x) => x.name)).toEqual(
      expect.arrayContaining(["Django", "React"]),
    );
    expect(f.stack.languages.map((l) => l.language)).toEqual(
      expect.arrayContaining(["Python", "TypeScript"]),
    );
    expect(f.units.source).toBe("candidates");
    expect(f.units.saved_at).toBeNull();
    expect(f.units.units.map((u) => u.name)).toEqual(
      expect.arrayContaining(["payments", "frontend", "rest"]),
    );
    expect(f.units.ignored).toEqual(["frontend/node_modules"]);
    expect(f.conventions).toEqual({
      guides: ["README.md"],
      style_guides: expect.any(Array),
      agent_files: ["AGENTS.md"],
    });
    expect(f.enforced.ci).toEqual([
      { system: "GitHub Actions", path: ".github/workflows/ci.yml", name: "CI" },
    ]);
    expect(f.enforced.linters.map((l) => l.name)).toContain("Ruff");
    expect(f.history).toEqual({
      state: "absent",
      saved_at: null,
      digest_generated_at: null,
      themes: [],
    });
    expect(f.survey).toBeNull();
    expect(f.problems).toEqual([]);
    // Stored in the STATE home, and nothing written to the config home.
    expect(factsOnDisk()).toMatchObject({
      version: 1,
      current: { key: r.current.key, assembled_at: now.toISOString() },
      previous: null,
    });
    expect(existsSync(configDir())).toBe(false);
    expect(r.previous).toBeNull();
    expect(r.diff).toEqual([]);
  });

  it("uses the SAVED cut once there is one, and keeps the version it replaced with a diff", () => {
    const { e } = engine();
    const first = assembled(e);
    e.propose({
      units: [
        { name: "backend", roots: ["backend"] },
        { name: "web", roots: ["frontend"] },
        { name: "rest", roots: [""] },
      ],
    });
    e.save();
    now = new Date("2026-09-29T11:00:00Z");
    const second = assembled(e);
    expect(second.current.facts.units).toMatchObject({
      source: "saved",
      saved_at: "2026-09-29T10:00:00.000Z",
    });
    expect(second.current.facts.units.units.map((u) => u.name)).toEqual(["backend", "web", "rest"]);
    expect(second.current.key).not.toBe(first.current.key);
    expect(second.unchanged).toBe(false);
    expect(second.previous).toEqual(first.current);
    expect(factsOnDisk().previous).toEqual(first.current);
    const units = second.diff.find((d) => d.section === "units")!;
    expect(units.added).toEqual(
      expect.arrayContaining([
        "cut: saved",
        "unit backend [custom] backend",
        "unit web [custom] frontend",
      ]),
    );
    expect(units.removed).toEqual(expect.arrayContaining(["cut: none saved — candidates"]));
    expect(second.diff.map((d) => d.section)).toEqual(["units"]);
  });

  it("a count-only change refreshes in place — the key holds and the kept version is not thrown away", () => {
    const { e, repo } = engine();
    const first = assembled(e);
    // A new design doc is a change of shape: the first version is kept.
    repo.files["CONTRIBUTING.md"] = "# how\n";
    const second = assembled(e);
    expect(second.previous).toEqual(first.current);
    // A new file in a unit changes only counts.
    repo.files["backend/payments/more.py"] = "1\n";
    now = new Date("2026-09-29T12:00:00Z");
    const third = assembled(e);
    expect(third.unchanged).toBe(true);
    expect(third.current.key).toBe(second.current.key);
    expect(third.current.assembled_at).toBe(now.toISOString());
    expect(third.current.facts.stack.files).toBe(second.current.facts.stack.files + 1);
    // `previous` is still the version before the last SHAPE change.
    expect(third.previous).toEqual(first.current);
    expect(third.diff).toEqual(second.diff);
  });

  it("carries the saved history THEMES, never the digest", async () => {
    const { e } = engine();
    stateHomeFs(stateDir()).write(HISTORY_DIGEST_FILE, JSON.stringify(digest()));
    const saved = await e.saveHistoryThemes([THEME]);
    expect(saved.ok).toBe(true);
    const r = assembled(e);
    expect(r.current.facts.history).toEqual({
      state: "ok",
      saved_at: now.toISOString(),
      digest_generated_at: "2026-09-29T09:00:00.000Z",
      themes: [THEME],
    });
    const text = readFileSync(join(stateDir(), PORTRAIT_FACTS_FILE), "utf8");
    expect(text).not.toContain("rev-alpha");
    expect(text).not.toContain("database transaction so a crash");
  });

  it("an unreadable themes file is UNKNOWN in the facts, never 'none saved'", () => {
    const { e } = engine();
    stateHomeFs(stateDir()).write(HISTORY_THEMES_FILE, "{ nope");
    const f = assembled(e).current.facts;
    expect(f.history.state).toBe("unreadable");
    expect(f.problems).toEqual([expect.stringContaining(HISTORY_THEMES_FILE)]);
  });

  it("refuses without a checkout, and never overwrites a facts file it cannot read", () => {
    expect(
      engine({ repo: { ...fakeRepo({}), listFiles: () => null } }).e.portraitAssemble(),
    ).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no readable checkout/)],
    });
    const { e } = engine();
    stateHomeFs(stateDir()).write(PORTRAIT_FACTS_FILE, '{"version": 99}');
    const r = e.portraitAssemble();
    expect(r).toEqual({
      ok: false,
      errors: [expect.stringMatching(/not portrait facts this version reads.*move it aside/)],
    });
    expect(readFileSync(join(stateDir(), PORTRAIT_FACTS_FILE), "utf8")).toBe('{"version": 99}');
  });
});

describe("the narrative: stored in the config home against the facts' key", () => {
  const BODY =
    "A Django backend with a React frontend.\n\nCI runs one workflow; Ruff is configured.";

  it("is refused without facts, without the key, against moved facts, or when empty, oversized or header-shaped", () => {
    const { e, repo } = engine();
    expect(e.storePortraitNarrative({ facts_key: "abc", narrative: BODY })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no portrait facts yet/)],
    });
    const key = assembled(e).current.key;
    expect(e.storePortraitNarrative({ narrative: BODY })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no `facts_key`/)],
    });
    expect(e.storePortraitNarrative({ facts_key: key, narrative: "  " })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/non-empty/)],
    });
    expect(
      e.storePortraitNarrative({ facts_key: key, narrative: "x".repeat(NARRATIVE_MAX + 1) }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/at most 16000/)],
    });
    expect(
      e.storePortraitNarrative({
        facts_key: key,
        narrative: "<!-- qcr repo portrait narrative -->\nhi",
      }),
    ).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/header line is the tool's/)],
    });
    repo.files["docs/DESIGN.md"] = "# design\n";
    const moved = assembled(e).current.key;
    expect(moved).not.toBe(key);
    expect(e.storePortraitNarrative({ facts_key: key, narrative: BODY })).toEqual({
      ok: false,
      errors: [expect.stringContaining(`the facts changed since that key (now ${moved})`)],
    });
    expect(existsSync(join(configDir(), NARRATIVE_FILE))).toBe(false);
  });

  it("a language overtaking another in file count is not a new shape: the key holds and the narrative stays current", () => {
    const { e, repo } = engine();
    const first = assembled(e);
    const key = first.current.key;
    e.storePortraitNarrative({ facts_key: key, narrative: BODY });
    repo.files["frontend/src/a.tsx"] = "x\n";
    repo.files["frontend/src/b.tsx"] = "x\n";
    repo.files["frontend/src/c.tsx"] = "x\n";
    const second = assembled(e);
    const order = (f: typeof first.current): string[] =>
      f.facts.stack.languages.map((l) => l.language);
    expect(order(second.current)).not.toEqual(order(first.current)); // the ranking flipped
    expect(second.current.key).toBe(key);
    expect(e.portrait().stale).toBe(false);
  });

  it("is refused, honestly, in an assembly with no config home", () => {
    const { e } = engine({ config: false });
    const key = assembled(e).current.key;
    expect(e.storePortraitNarrative({ facts_key: key, narrative: BODY })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/no config home in this assembly/)],
    });
    expect(e.portrait().narrative).toEqual({ state: "no-config-home" });
  });

  it("lands under portrait/ in the config home with the tool's header, and reads back current", () => {
    const { e } = engine();
    const key = assembled(e).current.key;
    const r = e.storePortraitNarrative({ facts_key: ` ${key} `, narrative: `${BODY}\r\n` });
    expect(r).toEqual({
      ok: true,
      facts_key: key,
      written_at: now.toISOString(),
      replaced: false,
      unchanged: false,
      diff: [],
    });
    expect(readdirSync(configDir())).toEqual([PORTRAIT_DIR]);
    const text = readFileSync(join(configDir(), NARRATIVE_FILE), "utf8");
    expect(text).toBe(
      `<!-- qcr repo portrait narrative · facts ${key} at abc123def456 · written ${now.toISOString()} -->\n\n${BODY}\n`,
    );
    expect(parseNarrative(text)).toEqual({
      facts_key: key,
      written_at: now.toISOString(),
      body: BODY,
    });
    const v = e.portrait();
    expect(v.narrative).toEqual({
      state: "ok",
      doc: { facts_key: key, written_at: now.toISOString(), body: BODY },
    });
    expect(v.stale).toBe(false);
    expect(v.has_previous_narrative).toBe(false);
    // The narrative never goes to the state home.
    expect(existsSync(join(stateDir(), NARRATIVE_FILE))).toBe(false);
  });

  it("keeps the narrative it replaces, diffs it, and a re-store of the same text rotates nothing", () => {
    const { e, repo } = engine();
    const key = assembled(e).current.key;
    e.storePortraitNarrative({ facts_key: key, narrative: "One.\nTwo.\nThree." });
    const firstFile = readFileSync(join(configDir(), NARRATIVE_FILE), "utf8");
    now = new Date("2026-09-29T11:00:00Z");
    const second = e.storePortraitNarrative({
      facts_key: key,
      narrative: "One.\nTwo, revised.\nThree.\nFour.",
    });
    expect(second).toMatchObject({
      ok: true,
      replaced: true,
      unchanged: false,
      diff: ["- Two.", "+ Two, revised.", "+ Four."],
    });
    expect(readFileSync(join(configDir(), NARRATIVE_PREVIOUS_FILE), "utf8")).toBe(firstFile);

    const again = e.storePortraitNarrative({
      facts_key: key,
      narrative: "One.\nTwo, revised.\nThree.\nFour.",
    });
    expect(again).toMatchObject({ ok: true, unchanged: true, replaced: false });
    expect(readFileSync(join(configDir(), NARRATIVE_PREVIOUS_FILE), "utf8")).toBe(firstFile);

    // The facts move: the stored reading is STALE until rewritten…
    repo.files["CONTRIBUTING.md"] = "# how\n";
    const moved = assembled(e).current.key;
    expect(e.portrait().stale).toBe(true);
    // …and re-storing the same prose against the new key re-stamps it without
    // displacing the kept version the diff needs.
    const restamped = e.storePortraitNarrative({
      facts_key: moved,
      narrative: "One.\nTwo, revised.\nThree.\nFour.",
    });
    expect(restamped).toMatchObject({ ok: true, replaced: false, unchanged: false, diff: [] });
    expect(readFileSync(join(configDir(), NARRATIVE_PREVIOUS_FILE), "utf8")).toBe(firstFile);
    expect(e.portrait().stale).toBe(false);

    const d = e.portrait({ diff: true });
    expect(d.narrative_diff).toEqual(["- Two.", "+ Two, revised.", "+ Four."]);
    expect(d.facts_diff).toEqual([
      { section: "conventions", added: ["design doc CONTRIBUTING.md"], removed: [] },
    ]);
  });

  it("refuses a narrative that quotes a raw review comment or names its author", () => {
    const { e } = engine();
    stateHomeFs(stateDir()).write(HISTORY_DIGEST_FILE, JSON.stringify(digest()));
    const key = assembled(e).current.key;
    const quoted = e.storePortraitNarrative({
      facts_key: key,
      narrative: `Reviewers say: always wrap payment writes in a database transaction so a crash never leaves half a charge.`,
    });
    expect(quoted).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/the narrative quotes a raw review comment/)],
    });
    const named = e.storePortraitNarrative({
      facts_key: key,
      narrative: "rev-alpha cares most about money code.",
    });
    expect(named).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/names a comment author \(rev-alpha\)/)],
    });
    expect(existsSync(join(configDir(), NARRATIVE_FILE))).toBe(false);
    // An unreadable digest cannot be checked against: refused, not waved through.
    stateHomeFs(stateDir()).write(HISTORY_DIGEST_FILE, "{ nope");
    expect(e.storePortraitNarrative({ facts_key: key, narrative: "Fine prose." })).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/cannot be checked for raw review comments/)],
    });
  });

  it("an operator's hand edit that drops the header reads as freshness UNKNOWN, and is still kept on replace", () => {
    const { e } = engine();
    const key = assembled(e).current.key;
    mkdirSync(join(configDir(), PORTRAIT_DIR), { recursive: true });
    writeFileSync(join(configDir(), NARRATIVE_FILE), "My own notes.\n");
    const v = e.portrait();
    expect(v.narrative).toEqual({
      state: "ok",
      doc: { facts_key: null, written_at: null, body: "My own notes." },
    });
    expect(v.stale).toBeNull();
    const r = e.storePortraitNarrative({ facts_key: key, narrative: "The companion's reading." });
    expect(r).toMatchObject({ ok: true, replaced: true });
    expect(readFileSync(join(configDir(), NARRATIVE_PREVIOUS_FILE), "utf8")).toBe(
      "My own notes.\n",
    );
  });
});

describe("the honest unknowns and the refusals at the disk (review fixes)", () => {
  it("facts that cannot be read make the narrative's freshness UNKNOWN — never blamed on an edited header", () => {
    const { e } = engine();
    const key = assembled(e).current.key;
    expect(e.storePortraitNarrative({ facts_key: key, narrative: "Prose." })).toMatchObject({
      ok: true,
    });
    stateHomeFs(stateDir()).write(PORTRAIT_FACTS_FILE, "{ nope");
    const v = e.portrait();
    expect(v.stale).toBeNull();
    const text = renderPortrait(v);
    expect(text).toContain(`written from facts ${key}; whether it is current is UNKNOWN`);
    expect(text).not.toMatch(/header was edited/);
  });

  it("a kept previous narrative that cannot be read is UNKNOWN, not 'no earlier version'", () => {
    const { e } = engine();
    const key = assembled(e).current.key;
    expect(e.storePortraitNarrative({ facts_key: key, narrative: "Prose." })).toMatchObject({
      ok: true,
    });
    // A directory where the file should be: reading it throws EISDIR.
    mkdirSync(join(configDir(), NARRATIVE_PREVIOUS_FILE), { recursive: true });
    const v = e.portrait({ diff: true });
    expect(v.has_previous_narrative).toBe(false);
    expect(v.previous_narrative_error).toMatch(/narrative\.previous\.md .*cannot be read/);
    const text = renderPortrait(v);
    expect(text).toMatch(/The kept previous narrative: UNKNOWN/);
    expect(text).not.toMatch(/Narrative: no earlier version kept yet/);
  });

  it("a current narrative that cannot be read beside a readable previous one is an UNKNOWN change, never 'the same text'", () => {
    const { e } = engine();
    const key = assembled(e).current.key;
    e.storePortraitNarrative({ facts_key: key, narrative: "First." });
    e.storePortraitNarrative({ facts_key: key, narrative: "Second." });
    rmSync(join(configDir(), NARRATIVE_FILE));
    mkdirSync(join(configDir(), NARRATIVE_FILE)); // reading it throws EISDIR
    const v = e.portrait({ diff: true });
    expect(v.has_previous_narrative).toBe(true);
    expect(v.narrative_diff).toBeNull();
    expect(renderPortrait(v)).not.toMatch(/the same text as the one it replaced/);
  });

  it("facts whose sections hold no lists are unreadable — refused, never a crash in a reader", () => {
    const { e } = engine();
    assembled(e);
    const bad = factsOnDisk();
    for (const s of ["stack", "units", "conventions", "enforced", "history"] as const)
      (bad.current.facts as unknown as Record<string, unknown>)[s] = {};
    stateHomeFs(stateDir()).write(PORTRAIT_FACTS_FILE, JSON.stringify(bad));
    const v = e.portrait({ diff: true });
    expect(v.facts.state).toBe("unreadable");
    expect(() => renderPortrait(v)).not.toThrow();
    expect(e.portraitAssemble()).toMatchObject({ ok: false });
  });

  it("a config home that cannot be written (portrait/ unmounted or read-only) is a refusal, never a throw", () => {
    const real = configHomeFs(configDir());
    const readOnly: StateFs = {
      location: real.location,
      read: (rel) => real.read(rel),
      write: () => {
        throw new Error("EROFS: read-only file system");
      },
    };
    const e = new SetupEngine({
      repo: fakeRepo({ ...REPO }),
      state: stateHomeFs(stateDir()),
      config: readOnly,
      clock: () => now,
      memory: null,
      cases: { run: async () => ({ ok: false, reason: "no cases in these tests" }) },
      tracker: notYetTrackerSink(""),
      github: { get: async () => ({ ok: false, reason: "no network in tests" }) },
    });
    const key = assembled(e).current.key;
    expect(e.storePortraitNarrative({ facts_key: key, narrative: "Prose." })).toEqual({
      ok: false,
      errors: [expect.stringMatching(/cannot be written: Error: EROFS/)],
    });
  });

  it("a state home that cannot be written refuses the assemble rather than throwing", () => {
    const real = stateHomeFs(stateDir());
    const e = new SetupEngine({
      repo: fakeRepo({ ...REPO }),
      state: {
        location: real.location,
        read: (rel) => real.read(rel),
        write: () => {
          throw new Error("EACCES");
        },
      },
      config: configHomeFs(configDir()),
      clock: () => now,
      memory: null,
      cases: { run: async () => ({ ok: false, reason: "no cases in these tests" }) },
      tracker: notYetTrackerSink(""),
      github: { get: async () => ({ ok: false, reason: "no network in tests" }) },
    });
    expect(e.portraitAssemble()).toEqual({
      ok: false,
      errors: [expect.stringMatching(/portrait-facts\.json .*cannot be written: Error: EACCES/)],
    });
  });
});

describe("lineDiff", () => {
  it("lists changed lines only, in order", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual(["- b", "+ d"]);
    expect(lineDiff("", "x")).toEqual(["+ x"]);
    expect(lineDiff("same", "same")).toEqual([]);
  });

  it("past its work bound it says the text was replaced rather than spending unbounded time", () => {
    expect(lineDiff("a\nb", "a\nc", 1)).toEqual(["- a", "- b", "+ a", "+ c"]);
  });
});

it("keeps saved-cut diagnostics in portrait facts after repo evolution", () => {
  const { e, repo } = engine();
  expect(e.propose().ok).toBe(true);
  expect(e.save().ok).toBe(true);
  repo.files = { "brand-new/file.py": "code\n" };
  assembled(e);
  expect(factsOnDisk().current.facts.problems.join("\n")).toMatch(/matches no file|unassigned/);
});
