// Review history, the companion's half (src/setup/history.ts via
// SetupEngine). The state home is a temp dir behind the real rooted port, the
// memory an in-memory MemoryStore fake. The contract under test: the companion
// reads the raw digest, and ONLY its validated themes go onward — to memory as
// `#history` entries and to the file the portrait reads. A theme carrying a raw
// comment or a colleague's login is refused.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryEntry, MemoryOp, MemoryStore, MemoryWriteResult } from "../src/memory/store.js";
import { matchesQuery } from "../src/memory/store.js";
import { parseHashTags, parseEventTags } from "../src/memory/eventtags.js";
import { tagsOf } from "../src/openviking/store.js";
import { DIGEST_KIND, DIGEST_VERSION, type ReviewHistoryDigest } from "../src/reviewhistory.js";
import { SetupEngine } from "../src/setup/engine.js";
import { notYetTrackerSink, reviewerMemoryFromEnv, stateHomeFs } from "../src/setup/adapters.js";
import {
  HISTORY_DIGEST_FILE,
  HISTORY_THEMES_FILE,
  MAX_THEMES,
  leaksIn,
  readHistoryThemes,
  themeEntryText,
} from "../src/setup/history.js";
import { buildEngine, toolDefinitions } from "../extensions/setup.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-sethist-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A tiny MemoryStore: entries in an array, tags read the way the real store
 * reads them (OpenVikingStore's `tagsOf` — the WHOLE text, so a `#tag` quoted
 * in a body is searchable; only `pinned` is header-only), retire removes. */
class MemFake implements MemoryStore {
  entries: MemoryEntry[] = [];
  ops: MemoryOp[] = [];
  private n = 0;
  add(text: string, pinned = false): void {
    this.n++;
    this.entries.push({
      id: `e${this.n}`,
      ts: "2026-09-29 12:00:00",
      day: "2026-09-29",
      block: 0,
      text,
      tags: tagsOf(text),
      links: [],
      pinned,
      hash: `h${this.n}`,
    });
  }
  async read(): Promise<MemoryEntry[]> {
    return [...this.entries];
  }
  async search(q: string, opts?: { tag?: string | null }): Promise<MemoryEntry[]> {
    return this.entries.filter((e) => matchesQuery(e, q, opts));
  }
  async apply(op: MemoryOp): Promise<MemoryWriteResult> {
    this.ops.push(op);
    if (op.op === "note") {
      this.add(op.text);
      return { ok: true, message: "ok: note" };
    }
    if (op.op === "retire") {
      const i = this.entries.findIndex((e) => e.id === op.id && e.hash === op.expect);
      if (i < 0) return { ok: false, message: "stale" };
      this.entries.splice(i, 1);
      return { ok: true, message: "ok: retire" };
    }
    return { ok: false, message: "unsupported" };
  }
}

const RAW_1 =
  "Please always wrap payment writes in a database transaction so a crash never leaves half a charge.";
const RAW_2 =
  "[feedback] the reviewer keeps flagging logging calls that our style guide explicitly allows here";

function digest(over: Partial<ReviewHistoryDigest> = {}): ReviewHistoryDigest {
  return {
    kind: DIGEST_KIND,
    version: DIGEST_VERSION,
    repo: "example-org/example-app",
    generated_at: "2026-09-29T12:00:00.000Z",
    window: { since: "2026-03-29T12:00:00.000Z", until: "2026-09-29T12:00:00.000Z", months: 6 },
    human: {
      prs_enumerated: 2,
      prs_scanned: 2,
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
          body: RAW_1,
        },
        {
          pr: 11,
          merged_at: null,
          kind: "review",
          state: "COMMENTED",
          path: null,
          author: "quinnx",
          body: "Needs a test for the empty cart.",
        },
      ],
    },
    rounds: [
      {
        pr: 12,
        round_no: 1,
        verdict: "REQUEST_CHANGES",
        finished_at: "2026-09-01T00:00:00Z",
        backfilled: false,
        summary: "Blocked on the charge transaction.",
      },
    ],
    feedback: [
      {
        pr: 12,
        kind: "feedback_comment",
        created_at: "2026-09-02T00:00:00Z",
        author: "quinnx",
        body: RAW_2,
      },
    ],
    problems: [],
    ...over,
  };
}

function engine(memory: MemoryStore | null) {
  const state = stateHomeFs(join(dir, "state"));
  const e = new SetupEngine({
    repo: {
      location: "/reviewed-repo",
      listFiles: () => [],
      read: () => null,
      lines: () => null,
      head: () => null,
    },
    state,
    clock: () => new Date("2026-09-29T13:00:00Z"),
    memory,
    cases: { run: async () => ({ ok: false, reason: "no cases in these tests" }) },
    tracker: notYetTrackerSink(""),
    github: { get: async () => ({ ok: false, reason: "no network in tests" }) },
  });
  return {
    e,
    state,
    put: (d: ReviewHistoryDigest | string) =>
      state.write(HISTORY_DIGEST_FILE, typeof d === "string" ? d : JSON.stringify(d)),
  };
}

const GOOD = [
  {
    title: "Money writes are atomic",
    summary:
      "Reviewers block payment code that can leave a partial charge; they expect one transaction around it.",
    source: "mixed",
    weight: 2,
  },
  {
    title: "Edge-case tests",
    summary: "Empty and boundary inputs are expected to carry a test.",
    source: "human",
    weight: 1,
  },
];

describe("reading the digest", () => {
  it("absent is the normal state before a pull — no error, and the save is refused with the way to get one", async () => {
    const { e } = engine(new MemFake());
    expect(e.history()).toMatchObject({
      digest: "absent",
      problems: [],
      summary: null,
      themes: null,
    });
    const r = await e.saveHistoryThemes(GOOD);
    expect(r).toEqual({ ok: false, errors: [expect.stringMatching(/qcr history pull/)] });
  });

  it("an unreadable digest is reported, never half-used", () => {
    const { e, put } = engine(null);
    put("{ not json");
    expect(e.history()).toMatchObject({
      digest: "unreadable",
      problems: [expect.stringMatching(/not JSON/)],
    });
  });

  it("summarises and pages each half — raw, for the companion to condense", () => {
    const { e, put } = engine(null);
    put(digest());
    const h = e.history({ section: "human", offset: 1, limit: 5 });
    expect(h.summary).toMatchObject({ human_comments: 2, rounds: 1, feedback: 1, empty: false });
    expect(h.page).toEqual({
      section: "human",
      total: 2,
      offset: 1,
      lines: ["#11 review [COMMENTED] @quinnx: Needs a test for the empty cart."],
    });
    expect(e.history({ section: "rounds" }).page!.lines[0]).toMatch(/^#12 round 1 REQUEST_CHANGES/);
    expect(e.history({ section: "feedback", limit: 500 }).page!.lines).toHaveLength(1);
  });
});

describe("saving themes", () => {
  it("only the themes reach memory and the portrait's file — no raw comment, no author", async () => {
    const mem = new MemFake();
    const { e, put } = engine(mem);
    put(digest());
    const r = await e.saveHistoryThemes(GOOD);
    expect(r).toMatchObject({ ok: true, memory: { written: 2, retired: 0, problems: [] } });

    // Memory: exactly the two theme entries, tagged #history, built from theme fields only.
    expect(mem.ops.map((o) => o.op)).toEqual(["note", "note"]);
    expect(mem.entries.map((x) => x.text)).toEqual(GOOD.map((t) => themeEntryText(t as never)));
    for (const x of mem.entries) expect(x.tags).toEqual(["history"]);

    // The portrait's accessor returns the themes and nothing of the digest.
    const saved = readHistoryThemes(stateHomeFs(join(dir, "state")))!;
    expect(saved.themes).toEqual(GOOD);
    expect(saved.digest_generated_at).toBe("2026-09-29T12:00:00.000Z");

    const onward = [
      ...mem.entries.map((x) => x.text),
      readFileSync(join(dir, "state", HISTORY_THEMES_FILE), "utf8"),
    ].join("\n");
    const d = digest();
    for (const raw of [...d.human.comments.map((c) => c.body), ...d.feedback.map((f) => f.body!)])
      expect(onward).not.toContain(raw);
    for (const who of ["rev-alpha", "quinnx"]) expect(onward).not.toContain(who);
  });

  it("refuses a theme that quotes a raw comment or names its author — and writes nothing", async () => {
    const mem = new MemFake();
    const { e, put } = engine(mem);
    put(digest());
    const quoting = [
      {
        title: "Transactions",
        summary:
          "As one reviewer put it: always wrap payment writes in a database transaction so a crash never",
        source: "human",
        weight: 1,
      },
    ];
    const q = await e.saveHistoryThemes(quoting);
    expect(q).toEqual({
      ok: false,
      errors: [expect.stringMatching(/^themes\[0\] quotes a raw review comment/)],
    });
    const feedbackQuote = [
      {
        title: "Logging",
        summary:
          "They said the reviewer keeps flagging logging calls that our style guide explicitly allows",
        source: "feedback",
        weight: 1,
      },
    ];
    expect((await e.saveHistoryThemes(feedbackQuote)).ok).toBe(false);
    const naming = [
      { title: "Tests", summary: "quinnx wants tests for empty carts", source: "human", weight: 1 },
    ];
    expect(await e.saveHistoryThemes(naming)).toEqual({
      ok: false,
      errors: [expect.stringMatching(/names a comment author \(quinnx\)/)],
    });
    expect((await e.saveHistoryThemes([{ ...naming[0], summary: "@rev-alpha asks" }])).ok).toBe(
      false,
    );
    expect(mem.ops).toEqual([]);
    expect(readHistoryThemes(stateHomeFs(join(dir, "state")))).toBeNull();
  });

  it("the round summaries are the daemon's own prose, not a colleague's — quoting one is allowed", () => {
    expect(leaksIn("Blocked on the charge transaction.", digest())).toEqual([]);
  });

  it("validates shape: caps, one line, no leading #, a known source, a positive weight", async () => {
    const { e, put } = engine(null);
    put(digest());
    const many = Array.from({ length: MAX_THEMES + 1 }, (_, i) => ({
      title: `t${i}`,
      summary: "s",
      source: "human",
      weight: 1,
    }));
    expect((await e.saveHistoryThemes(many)).ok).toBe(false);
    const bad = await e.saveHistoryThemes([
      { title: "#pinned trick", summary: "x", source: "human", weight: 1 },
      { title: "a\nb", summary: "x", source: "human", weight: 1 },
      { title: "ok", summary: "x", source: "gossip", weight: 0 },
    ]);
    expect(bad.ok).toBe(false);
    expect((bad as { errors: string[] }).errors.join("\n")).toMatch(
      /must not start with '#'[\s\S]*no newlines[\s\S]*source must be[\s\S]*weight must be/,
    );
    expect((await e.saveHistoryThemes("nope")).ok).toBe(false);
  });

  it("a theme's text cannot extend the entry header into a tag", () => {
    const text = themeEntryText({
      title: "pinned=yes k=v",
      summary: "#pinned",
      source: "human",
      weight: 3,
    });
    expect(parseHashTags(text)).toEqual(["history"]);
    expect(parseEventTags(text)).toEqual({ source: "human", weight: "3" });
  });

  it("incomplete memory enumeration cannot report complete theme supersession", async () => {
    const mem = new MemFake();
    mem.add("#history earlier theme");
    const memory = Object.assign(mem, {
      sweep: async () => ({ entries: [], unread: ["unreachable"] }),
    });
    const { e, put } = engine(memory);
    put(digest());
    const r = await e.saveHistoryThemes([]);
    expect(r).toMatchObject({
      ok: true,
      memory: {
        retired: 0,
        problems: expect.arrayContaining([expect.stringContaining("UNKNOWN")]),
      },
    });
    expect(mem.entries).toHaveLength(1);
  });

  it("history supersession protects source=manual in the header without trusting body metadata", async () => {
    const mem = new MemFake();
    mem.add("#history source=manual Theme: operator note");
    mem.add("#history source=human Theme: earlier automatic note mentions source=manual");
    const { e, put } = engine(mem);
    put(digest());
    expect(await e.saveHistoryThemes([])).toMatchObject({ ok: true, memory: { retired: 1 } });
    expect(mem.entries.map((entry) => entry.text)).toEqual([
      "#history source=manual Theme: operator note",
    ]);
  });

  it("a re-save supersedes the earlier unpinned #history entries and keeps the operator's", async () => {
    const mem = new MemFake();
    mem.add("#history #manual the operator's own note");
    mem.add("#history pinned by the operator", true);
    mem.add("#survey unrelated");
    const { e, put, state } = engine(mem);
    put(digest());
    await e.saveHistoryThemes(GOOD);
    const r = await e.saveHistoryThemes([GOOD[0]]);
    expect(r).toMatchObject({ ok: true, memory: { written: 1, retired: 1, problems: [] } });
    expect(mem.entries.map((x) => x.text)).toEqual([
      "#history #manual the operator's own note",
      "#history pinned by the operator",
      "#survey unrelated",
      themeEntryText(GOOD[0] as never),
    ]);
    const f = readHistoryThemes(state)!;
    expect(f.themes).toEqual([GOOD[0]]);
    expect(f.previous?.themes).toEqual(GOOD);
  });

  it("a theme that MENTIONS #manual is still replaced by the next save — its own #words are de-hashed", async () => {
    const mem = new MemFake();
    const { e, put } = engine(mem);
    put(digest());
    const mentioning = [
      { ...GOOD[0]!, summary: "Reviewers respect our #manual notes on payments." },
    ];
    await e.saveHistoryThemes(mentioning);
    expect(mem.entries[0]!.text).not.toMatch(/#manual/);
    expect(mem.entries[0]!.tags).toEqual(["history"]);
    const r = await e.saveHistoryThemes([GOOD[1]]);
    expect(r).toMatchObject({ ok: true, memory: { written: 1, retired: 1, problems: [] } });
    expect(mem.entries.map((x) => x.text)).toEqual([themeEntryText(GOOD[1] as never)]);
  });

  it("an earlier theme written with a body #manual (before de-hashing) is replaced too — only the header protects", async () => {
    const mem = new MemFake();
    mem.add("#history source=human weight=1 Theme: Notes — keep our #manual notes");
    const { e, put } = engine(mem);
    put(digest());
    const r = await e.saveHistoryThemes([GOOD[0]]);
    expect(r).toMatchObject({ ok: true, memory: { written: 1, retired: 1 } });
  });

  it("keeps the earlier themes live when memory refuses a new one — never neither", async () => {
    const mem = new MemFake();
    const { e, put } = engine(mem);
    put(digest());
    await e.saveHistoryThemes(GOOD);
    const apply = mem.apply.bind(mem);
    mem.apply = async (op) =>
      op.op === "note" && op.text.includes("Edge-case")
        ? { ok: false, message: "refused" }
        : apply(op);
    const r = await e.saveHistoryThemes([GOOD[0], { ...GOOD[1]!, weight: 5 }]);
    expect(r).toMatchObject({ ok: true, memory: { written: 1, retired: 0 } });
    expect((r as { memory: { problems: string[] } }).memory.problems.join("\n")).toMatch(
      /earlier #history entries are kept/,
    );
    expect(mem.entries.filter((x) => x.text.includes("Edge-case"))).toHaveLength(1);
  });

  it("two overlapping saves leave ONE theme set live — the later one, as the file says", async () => {
    const mem = new MemFake();
    const search = mem.search.bind(mem);
    // Every search reads at once and answers a beat later, so two saves in
    // flight would both read the store as it was before either wrote.
    mem.search = async (q, opts) => {
      const found = await search(q, opts);
      await new Promise((r) => setTimeout(r, 10));
      return found;
    };
    const { e, put, state } = engine(mem);
    put(digest());
    await Promise.all([e.saveHistoryThemes(GOOD), e.saveHistoryThemes([GOOD[0]])]);
    expect(readHistoryThemes(state)!.themes).toEqual([GOOD[0]]);
    expect(mem.entries.map((x) => x.text)).toEqual([themeEntryText(GOOD[0] as never)]);
  });

  it("an unreadable saved-themes file is UNKNOWN in the history view, never 'none saved'", () => {
    const { e, put } = engine(null);
    put(digest());
    writeFileSync(join(dir, "state", HISTORY_THEMES_FILE), "garbage");
    const h = e.history();
    expect(h.themes).toBeNull();
    expect(h.themes_error).toMatch(/history-themes|themes/);
  });

  it("never retires an entry that only MENTIONS #history in its body — the tag is the header's", async () => {
    const mem = new MemFake();
    const quoted = "#feedback kind=comment pr=7 [feedback] keep #history out of billing";
    mem.add(quoted);
    mem.add("#eod the sweep noted a #history theme drifting");
    const { e, put } = engine(mem);
    put(digest());
    const r = await e.saveHistoryThemes([GOOD[0]]);
    expect(r).toMatchObject({ ok: true, memory: { written: 1, retired: 0, problems: [] } });
    expect(mem.entries.map((x) => x.text)).toEqual([
      quoted,
      "#eod the sweep noted a #history theme drifting",
      themeEntryText(GOOD[0] as never),
    ]);
  });

  it("works for a repo with no rounds: the empty history summarises as empty and saves an empty theme list", async () => {
    const mem = new MemFake();
    const { e, put } = engine(mem);
    put(
      digest({
        human: {
          prs_enumerated: 0,
          prs_scanned: 0,
          prs_missing: 0,
          truncated: false,
          comments: [],
        },
        rounds: [],
        feedback: [],
      }),
    );
    const h = e.history({ section: "rounds" });
    expect(h.summary).toMatchObject({ empty: true, human_comments: 0, rounds: 0, feedback: 0 });
    expect(h.page).toEqual({ section: "rounds", total: 0, offset: 0, lines: [] });
    const r = await e.saveHistoryThemes([]);
    expect(r).toMatchObject({ ok: true, themes: [], memory: { written: 0, retired: 0 } });
    expect(readHistoryThemes(stateHomeFs(join(dir, "state")))!.themes).toEqual([]);
  });

  it("with no memory in the assembly the themes are still saved, and it says memory was not written", async () => {
    const { e, put } = engine(null);
    put(digest());
    const r = await e.saveHistoryThemes(GOOD);
    expect(r).toMatchObject({
      ok: true,
      memory: { written: 0, problems: [expect.stringMatching(/no reviewer memory/)] },
    });
  });

  it("a themes file this version cannot read is never overwritten", async () => {
    const { e, put, state } = engine(new MemFake());
    put(digest());
    state.write(HISTORY_THEMES_FILE, "garbage");
    const r = await e.saveHistoryThemes(GOOD);
    expect(r).toEqual({ ok: false, errors: [expect.stringMatching(/nothing will overwrite it/)] });
    expect(state.read(HISTORY_THEMES_FILE)).toBe("garbage");
  });
});

describe("the tool belt", () => {
  it("registers the history tools, and they read, refuse and save through the engine", async () => {
    const env = {
      QCR_REVIEWED_REPO: join(dir, "repo"),
      QCR_STATE_HOME: join(dir, "state"),
    } as NodeJS.ProcessEnv;
    const defs = toolDefinitions(buildEngine(env));
    const call = async (name: string, params: Record<string, unknown> = {}): Promise<string> => {
      const def = defs.find((d) => d.name === name)!;
      const r = await def.execute("id", params);
      return (r.content[0] as { text: string }).text;
    };
    expect(await call("setup_review_history")).toMatch(/Ask the owner to run `qcr history pull`/);
    stateHomeFs(join(dir, "state")).write(
      HISTORY_DIGEST_FILE,
      JSON.stringify(
        digest({
          human: {
            prs_enumerated: 0,
            prs_scanned: 0,
            prs_missing: 0,
            truncated: false,
            comments: [],
          },
          rounds: [],
          feedback: [],
        }),
      ),
    );
    expect(await call("setup_review_history", { section: "human" })).toMatch(
      /EMPTY history[\s\S]*human \(none\)/,
    );
    // No endpoint or reviewer key in this env: the themes save, memory says why not.
    const saved = await call("setup_review_history_themes", { themes: [] });
    expect(saved).toMatch(/Themes saved:\n {2}\(none — an empty history has no themes\)/);
    expect(saved).toMatch(/! no reviewer memory in this assembly/);
    expect(await call("setup_review_history_themes", { themes: "x" })).toMatch(/Themes refused/);
  });
});

describe("reviewerMemoryFromEnv", () => {
  it("is null unless the spawn carries both the endpoint and the REVIEWER key", () => {
    expect(reviewerMemoryFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(
      reviewerMemoryFromEnv({ OPENVIKING_URL: "http://10.0.0.1:1933" } as NodeJS.ProcessEnv),
    ).toBeNull();
    // The companion's own key is never the reviewer's.
    expect(
      reviewerMemoryFromEnv({
        OPENVIKING_URL: "http://10.0.0.1:1933",
        OPENVIKING_API_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      reviewerMemoryFromEnv({
        OPENVIKING_URL: "http://10.0.0.1:1933",
        OPENVIKING_REVIEWER_KEY: "k",
      } as NodeJS.ProcessEnv),
    ).not.toBeNull();
  });
});

it("keeps identical content-addressed replacements live on a repeated theme save", async () => {
  const mem = new MemFake();
  const apply = mem.apply.bind(mem);
  mem.apply = async (op) => {
    if (op.op === "note" && mem.entries.some((entry) => entry.text === op.text))
      return { ok: true, message: "same content address" };
    return apply(op);
  };
  const { e, put } = engine(mem);
  put(digest());
  await e.saveHistoryThemes(GOOD);
  await e.saveHistoryThemes([GOOD[0]]);
  expect(mem.entries.map((entry) => entry.text)).toEqual([themeEntryText(GOOD[0] as never)]);
});
