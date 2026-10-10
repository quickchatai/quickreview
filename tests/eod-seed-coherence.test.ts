// The ratified eod-sweep seed and the daemon-rendered sections that ride
// after it say ONE thing.
//
// The seed `prompts/eod-sweep.md`: the curator starts §1 from the daemon's
// outcomes packet (the "Outcomes to curate" section), names the `events/` and
// `experiences/` areas, writes typed lessons through `viking_write`'s `lesson`
// fields citing `cand:c<id>`, files repo facts as `repo-fact`/`convention`
// lessons (never under `viking://resources/`), and closes §1 with the
// `eod-curation-receipt`; the memory-discipline fence names
// `preferences/pinned/`, `#manual` in `preferences/` and
// `kind=bug area=operations` in an `events/` entry's header.
//
// The seed is frozen (rule 6; pinned by tests/seed-integrity.test.ts and its
// fences by tests/invariant-fences.test.ts). What this file holds is the
// OTHER half: the prompt the curator actually receives is the seed PLUS the
// sections the daemon renders after it — "Reviewer memory layout"
// (`MEMORY_LAYOUT_NOTE`), "Outcomes to curate" (`renderCurationSection`, or
// `renderNoPacketSection` when no packet came) and the daemon-measured
// lines — and none of those may contradict the seed. Each check below names
// the claim on both sides, rendered from the real seed file and the real
// renderers, so either side drifting fails here.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { COMMAND_WHITELIST, executeCommand, type CommandDeps } from "../src/commands.js";
import { eodDigestContext } from "../src/digest.js";
import { EOD_SECTIONS, renderEodPrompt, startEodTimer } from "../src/eod.js";
import { Learner } from "../src/learner/learner.js";
import {
  packetPointer,
  packetRelDir,
  receiptExample,
  renderCurationSection,
  renderNoPacketSection,
  type OutcomesPacket,
} from "../src/learner/packet.js";
import { RECEIPT_DECISIONS, validateReceipt } from "../src/learner/receipt.js";
import {
  EVENTS_AREA,
  EXPERIENCES_AREA,
  MEMORY_LAYOUT_NOTE,
  PINNED_AREA,
  PREFERENCES_AREA,
} from "../src/memory/layout.js";
import { LESSON_KINDS } from "../src/memory/lessons.js";
import { OutcomeCapture } from "../src/outcomes.js";
import { StateStore } from "../src/state.js";
import { routeCurationReceipt } from "../src/wire.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED_PATH = join(ROOT, "prompts", "eod-sweep.md");
const SEED = readFileSync(SEED_PATH, "utf8");
const DAY = "2026-10-07";
const MEMORIES = "viking://user/reviewer/memories/";

/** The seed with its markdown line wrapping undone, so a phrase the seed
 * breaks across lines (the pinned area's URI does) reads as one. */
const flat = (s: string): string =>
  s
    .replace(/\n[ \t]*/g, " ")
    .replace(/`viking:\/\/user\/reviewer\/memories\/ /g, "`viking://user/reviewer/memories/");

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A packet with something in it: two clusters, a person's quote and the
 * reviewer's own re-check, one expired candidate. */
function packet(day = DAY): OutcomesPacket {
  const cand = (
    id: number,
    extra: Partial<OutcomesPacket["clusters"][number]["candidates"][number]> = {},
  ) => ({
    id,
    label: `c${id}`,
    kind: "refuted_conceded" as const,
    source: "fate" as const,
    polarity: "dont-raise" as const,
    class: "baseline.pre-existing-scope",
    lens_ids: ["pass-baseline"],
    pr: 5401,
    path: "app/api/views.py",
    line: 12,
    summary: "The author refuted the finding and the bot conceded",
    quote: "This was already the behaviour before this PR.",
    evidence: ["https://github.com/o/r/pull/5401#discussion_r1"],
    occurred_at: `${day}T09:00:00.000Z`,
    offered_day: day,
    expires_after: "2026-10-16",
    new: true,
    ...extra,
  });
  return {
    day,
    generated_at: `${day}T16:00:00.000Z`,
    expiry_ops_days: 7,
    recurrence_days: 90,
    offered: 3,
    new: 2,
    carried: 1,
    queued: 0,
    expired: [
      { id: 9, label: "c9", class: "ui.copy", summary: "a copy nit", offered_day: "2026-09-28" },
    ],
    balance: {
      look_for: 1,
      dont_raise: 3,
      repo_fact: 2,
      convention: 0,
      unknown: 0,
      ratio: 0.33,
      typed: 6,
    },
    lessons_read: "ok",
    clusters: [
      {
        class: "baseline.pre-existing-scope",
        polarity: "dont-raise",
        recurrence: 4,
        fixed: 1,
        ignored: 0,
        covering: [],
        candidates: [cand(12), cand(13, { new: false, offered_day: "2026-10-05" })],
      },
      {
        class: "recheck.app",
        polarity: "look-for",
        recurrence: 1,
        fixed: 0,
        ignored: 0,
        covering: null,
        candidates: [
          cand(14, {
            kind: "recheck_flip",
            source: "recheck",
            polarity: "look-for",
            class: "recheck.app",
            quote: "The delta drops the tenant guard.",
          }),
        ],
      },
    ],
  };
}

/** The prompt exactly as `startEodTimer` renders it in production. */
function rendered(curation: string, day = DAY): string {
  const p = packet(day);
  return renderEodPrompt(
    SEED,
    day,
    `cancelled: none\n${packetPointer(p)}`,
    undefined,
    MEMORY_LAYOUT_NOTE,
    curation,
  );
}

/** The four parts of a rendered prompt, by the headings the daemon writes. */
function parts(out: string): { seed: string; layout: string; curation: string; measured: string } {
  const layoutAt = out.indexOf(`\n## ${EOD_SECTIONS.layout}\n`);
  const curationAt = out.indexOf(`\n## ${EOD_SECTIONS.curation}\n`);
  const measuredAt = out.indexOf("\n## Daemon-measured context for ");
  expect(layoutAt).toBeGreaterThan(0);
  expect(curationAt).toBeGreaterThan(layoutAt);
  expect(measuredAt).toBeGreaterThan(curationAt);
  return {
    seed: out.slice(0, layoutAt),
    layout: out.slice(layoutAt, curationAt),
    curation: out.slice(curationAt, measuredAt),
    measured: out.slice(measuredAt),
  };
}

describe("the ratified reseed is the seed on disk", () => {
  it("prompts/eod-sweep.md is the ratified text, hash-pinned and recorded as a ratified divergence", () => {
    const manifest = JSON.parse(
      readFileSync(join(ROOT, "tests/fixtures/seed-manifest.json"), "utf8"),
    ) as { files: Record<string, string> };
    const sha = createHash("sha256").update(readFileSync(SEED_PATH)).digest("hex");
    expect(manifest.files["prompts/eod-sweep.md"]).toBe(sha);
    expect(
      readFileSync(join(ROOT, "seeds/prompts/eod-sweep.md")).equals(readFileSync(SEED_PATH)),
    ).toBe(true);
    const divergence = JSON.parse(
      readFileSync(join(ROOT, "tests/fixtures/ratified-divergence.json"), "utf8"),
    ) as { files: Record<string, string[]> };
    const notes = divergence.files["prompts/eod-sweep.md"] ?? [];
    // A ratified reseed is recorded by a human, with its date and citation.
    expect(notes.at(-1)).toMatch(/^2026-10-07 owner ratified in-session \(R8, /);
  });

  it("keeps its {{date}} placeholders, and nothing else the renderer would have to know", () => {
    // The sweep's date, the events' day=, the digest's path and title, the
    // packet's path and the receipt's day.
    expect(SEED.match(/\{\{date\}\}/g)?.length).toBe(6);
    for (const at of [
      "Date: {{date}}.",
      "`state/eod/{{date}}/outcomes.md`",
      "`day={{date}}`",
      '`day: "{{date}}"`',
      "`digest/{{date}}.md`",
      "# Review sandbox — {{date}}",
    ])
      expect(SEED).toContain(at);
    expect(new Set([...SEED.matchAll(/\{\{([^}]+)\}\}/g)].map((m) => m[1]))).toEqual(
      new Set(["date"]),
    );
  });

  it("carries every ruled change", () => {
    const s = flat(SEED);
    // §1 starts from the packet, by the section's own name, and its file.
    expect(s).toContain("**Start from the outcomes packet.**");
    expect(s).toContain(`the section "${EOD_SECTIONS.curation}" below this prompt`);
    expect(s).toContain("`state/eod/{{date}}/outcomes.md`");
    // The events and experiences areas, by URI.
    expect(s).toContain(`(\`${MEMORIES}${EVENTS_AREA}/\`, \`day={{date}}\``);
    expect(s).toContain(`(\`${MEMORIES}${EXPERIENCES_AREA}/\`) via \`viking_write\``);
    // Typed lessons through the tool's lesson fields, citing candidates.
    expect(s).toContain("Pass the lesson's fields as the tool's `lesson` parameter");
    expect(s).toContain("Cite every candidate a lesson adopts as `cand:c<id>` in its evidence.");
    // Repo facts are lessons in experiences/, not resources.
    expect(s).toContain(
      "is a lesson of kind `repo-fact` (or `convention`), in the same experiences area",
    );
    expect(s).not.toContain("viking://resources");
    // §1 closes with the receipt.
    expect(s).toContain("**Close §1 with the curation receipt.**");
    // The memory discipline names the areas and the header.
    expect(s).toContain(`\`${MEMORIES}${PINNED_AREA}/\``);
    expect(s).toContain(
      `**\`#manual\` entries in \`${PREFERENCES_AREA}/\` are the owner's own words**`,
    );
    expect(s).toContain(
      "with `kind=bug area=operations` in the entry's header (never only in its body)",
    );
    expect(s).not.toContain("source=manual");
    // An outage still writes the receipt.
    expect(s).toContain(
      "Still write the receipt, deciding every candidate you could not write as `refused` with the error.",
    );
  });
});

describe("the seed and the daemon-rendered sections do not contradict each other", () => {
  const out = rendered(renderCurationSection(packet()));
  const { seed, layout, curation, measured } = parts(out);

  it("the rendered prompt is the seed, then the layout, then the curation, then the measured lines — fences and placeholders gone", () => {
    expect(out).not.toContain("{{");
    expect(out).not.toContain("RATIFIED");
    // The seed part is the seed, rendered — nothing of it moved or duplicated.
    expect(seed.trim()).toBe(renderEodPrompt(SEED, DAY).trim());
    expect(out.split(`## ${EOD_SECTIONS.curation}`).length).toBe(2);
    expect(measured).toContain(`## Daemon-measured context for ${DAY}`);
  });

  it("the section the seed starts §1 from exists, under the name the seed uses, and names the file the seed names", () => {
    const file = `${packetRelDir(DAY)}/outcomes.md`;
    expect(flat(seed)).toContain(
      `the section "${EOD_SECTIONS.curation}" below this prompt (also \`${file}\`)`,
    );
    expect(curation).toContain(`\`${file}\``);
    // The digest's pointer line names the same file.
    expect(measured).toContain(`outcomes packet: ${file} — `);
  });

  it("the areas the seed names are the layout's areas, and the layout note names them too", () => {
    const s = flat(seed);
    for (const area of [EVENTS_AREA, EXPERIENCES_AREA, PINNED_AREA]) {
      expect(s).toContain(`${MEMORIES}${area}/`);
      expect(layout).toContain(`\`${area}/\``);
    }
    expect(s).toContain(`\`${PREFERENCES_AREA}/\``);
    expect(layout).toContain(`\`${PREFERENCES_AREA}/\``);
    // The bug header the seed asks for is the one the layout describes.
    expect(s).toContain("`kind=bug area=operations`");
    expect(layout).toContain("`kind=bug area=operations`");
    // The curation section writes lessons where the seed says.
    expect(curation).toContain(`\`${MEMORIES}${EXPERIENCES_AREA}/\``);
  });

  it("nothing after the seed sends a repo fact anywhere but experiences/ (the resources promotion is gone)", () => {
    // Every variant of the curation section is checked below, by the same rule.
    for (const section of [layout, measured]) expect(section).not.toContain("resources");
    expect(layout).toMatch(/`experiences\/` — the day's learnings/);
  });

  it("the layout note leaves #manual entries to the seed's memory discipline (its old 'Not yours to write' is gone)", () => {
    // The seed lets the curator consolidate or retire a #manual entry when a
    // newer manual entry supersedes it; the layout note must not say "Not
    // yours to write".
    expect(flat(seed)).toContain(
      "consolidate or retire them only when one is superseded by a newer manual entry",
    );
    expect(layout).not.toMatch(/not yours/i);
    expect(flat(layout)).toContain(
      "`preferences/` — the owner's own words (`#manual`); the memory discipline above rules on them.",
    );
    // The pinned area: both say never to touch it.
    expect(flat(seed)).toContain("Never consolidate, rewrite, retire, or move an entry in it");
    expect(flat(layout)).toContain("Never write, move, retire or rewrite anything under it.");
  });

  it("the lesson's content is the seed's to define (the section's 'the rule and its reason' is gone)", () => {
    // The seed's half; that no variant of the curation section restates it
    // is checked below, over all three.
    expect(flat(seed)).toContain(
      "`content` is the one-sentence lesson and its evidence PR link(s), nothing more",
    );
  });

  it("the lesson fields and kinds the seed lists are the ones viking_write's lesson takes", () => {
    const s = flat(seed);
    const kinds = /`kind` \(([^)]+)\)/
      .exec(s)?.[1]
      ?.split("|")
      .map((k) => k.trim());
    expect(new Set(kinds)).toEqual(new Set(LESSON_KINDS));
    for (const field of ["kind", "lens", "class", "paths", "evidence"]) {
      expect(s).toContain(`\`${field}\``);
    }
    expect(curation).toContain("`{kind, lens, class, paths, evidence}`");
    expect(s).toContain("`cand:c<id>`");
    expect(curation).toContain("`cand:c<id>`");
  });

  it("the receipt the seed closes §1 with is the command the daemon takes, with the decisions it validates", () => {
    expect(COMMAND_WHITELIST).toContain("eod-curation-receipt");
    const s = flat(seed);
    expect(s).toContain(`\`eod-curation-receipt\`, with \`day: "${DAY}"\``);
    const named = [...s.matchAll(/`(adopted|declined|refused)`/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(RECEIPT_DECISIONS));
    // The section's example is a receipt the daemon accepts, for the same day.
    const json = /```json\n(.+)\n```/.exec(curation)?.[1];
    const example = JSON.parse(json ?? "null") as Record<string, unknown>;
    expect(example).toEqual(receiptExample(DAY));
    expect(validateReceipt(example)).toMatchObject({ ok: true, receipt: { day: DAY } });
  });

  it("an undecided candidate and a memory outage mean the same on both sides", () => {
    const s = flat(seed);
    expect(s).toContain("Decide every offered candidate; an undecided one comes back tomorrow.");
    expect(flat(curation)).toContain(
      "A candidate you leave out stays open and rides the next packet",
    );
    // Outage: the seed says decide what could not be written as refused, with
    // the error; the section says the same of a failed write.
    expect(flat(curation)).toContain(
      "Use `refused` for a candidate whose lesson write failed, with the error.",
    );
  });

  it("the digest's Learnings line asks for the decisions the receipt records", () => {
    expect(seed).toContain(
      "## Learnings    — candidates decided (adopted / declined / refused) and lessons written today (one line each)",
    );
  });
});

// The section the seed sends the curator to comes in three variants: the
// packet's instructions, and the two no-packet sections that stand in for it
// whenever there is no learner, the packet build throws, or it misses the
// day-context wait. Each one is checked against every claim of the seed,
// rendered where the curator reads it.
describe.each([
  ["packet", () => renderCurationSection(packet())],
  ["off", () => renderNoPacketSection(DAY, "off")],
  ["unavailable", () => renderNoPacketSection(DAY, "unavailable")],
] as const)("the %s variant of the curation section says nothing against the seed", (_v, section) => {
  const { seed, curation } = parts(rendered(section()));

  it("sends no repo fact to resources/ (the seed files them as experiences/ lessons)", () => {
    expect(flat(seed)).not.toContain("viking://resources");
    expect(curation).not.toContain("resources");
  });

  it("does not tell the curator #manual entries are not theirs (the seed's memory discipline rules on them)", () => {
    expect(flat(seed)).toContain(
      "consolidate or retire them only when one is superseded by a newer manual entry",
    );
    expect(curation).not.toMatch(/not yours/i);
  });

  it("leaves a lesson's `content` to the seed (no 'the rule and its reason')", () => {
    expect(flat(seed)).toContain(
      "`content` is the one-sentence lesson and its evidence PR link(s), nothing more",
    );
    expect(curation).not.toContain("`content`");
    expect(curation).not.toMatch(/and its reason/);
  });

  it("asks for no `source=manual` header (the seed's discipline names `#manual`)", () => {
    expect(flat(seed)).not.toContain("source=manual");
    expect(curation).not.toContain("source=manual");
  });
});

/** The production receipt route — wire.ts's own `routeCurationReceipt` —
 * behind the command handler the watcher calls, on a daemon with or without
 * a learner. Every other handler is unreachable for this command. */
function receiptVia(learner: Learner | null) {
  const unreachable = () => {
    throw new Error("not the receipt's handler");
  };
  const deps: CommandDeps = {
    rerunRound: unreachable,
    restartSession: unreachable,
    resolveTerminalFailure: unreachable,
    pausePr: unreachable,
    resumePr: unreachable,
    flagOwner: unreachable,
    fileImprovementPr: unreachable,
    fileIssue: unreachable,
    curationReceipt: (receipt) => routeCurationReceipt(learner, receipt),
  };
  return (day: string) =>
    executeCommand({ command: "eod-curation-receipt", day, decisions: [] }, deps);
}

describe("a sweep without a packet still has the section the seed points at", () => {
  it("off: no learner on this daemon — no candidates, no receipt, and why", () => {
    const { curation } = parts(rendered(renderNoPacketSection(DAY, "off")));
    expect(curation).toContain(
      "the learner is not running on this daemon (`[openviking] enabled = false`)",
    );
    expect(curation).toContain("no `eod-curation-receipt` to write — the daemon would refuse one");
    expect(curation).not.toContain("```json");
  });

  it("off: the claim is true of the daemon — with no learner, wire's receipt route refuses, naming the same cause", async () => {
    const out = await receiptVia(null)(DAY);
    expect(out).toMatchObject({
      ok: false,
      reason: expect.stringContaining("the learner is not running on this daemon"),
    });
    expect(renderNoPacketSection(DAY, "off")).toContain(
      "the learner is not running on this daemon",
    );
  });

  it("unavailable: the packet may still be on disk — curate it if it is, with a receipt the daemon accepts", () => {
    const { curation } = parts(rendered(renderNoPacketSection(DAY, "unavailable")));
    expect(curation).toContain(
      `If \`${packetRelDir(DAY)}/outcomes.md\` exists, it is today's packet`,
    );
    expect(curation).toContain(
      "If it does not exist, there are no candidates to decide and no receipt to write",
    );
    const json = /```json\n(.+)\n```/.exec(curation)?.[1];
    expect(validateReceipt(JSON.parse(json ?? "null") as Record<string, unknown>)).toMatchObject({
      ok: true,
      receipt: { day: DAY },
    });
  });

  it("the claims are true of the daemon: a receipt for a day with no packet is refused, and one after the packet is taken", async () => {
    let now = new Date(`${DAY}T15:00:00.000Z`);
    const clock = () => now;
    const store = new StateStore(":memory:", clock);
    new OutcomeCapture({ store, botLogin: "quickreview[bot]", now: clock });
    const root = mkdtempSync(join(tmpdir(), "qcr-eod-seed-"));
    roots.push(root);
    const learner = new Learner({
      store,
      root,
      eodTime: "18:00",
      timeZone: "Europe/Warsaw",
      botLogin: "quickreview[bot]",
      baseBranch: "main",
      lessons: { sweep: async () => ({ entries: [], unread: [] }) },
      healthy: () => true,
      wake: () => {},
      now: clock,
    });
    // No packet yet: "the daemon would refuse one" — through wire's route.
    const receipt = receiptVia(learner);
    expect(await receipt(DAY)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("no outcomes packet was written"),
    });
    // The production assembly: the real seed, the real learner's packet and
    // curation, the daemon-measured lines — through the timer itself.
    now = new Date(`${DAY}T16:00:00.000Z`);
    const prep = await learner.prepareEod(DAY);
    const out = renderEodPrompt(
      SEED,
      DAY,
      `${eodDigestContext(store, DAY, "Europe/Warsaw")}\n${prep.lines}`,
      undefined,
      MEMORY_LAYOUT_NOTE,
      prep.curation,
    );
    const { curation, measured } = parts(out);
    expect(curation).toContain(`\`${packetRelDir(DAY)}/outcomes.md\``);
    expect(measured).toContain(`outcomes packet: ${packetRelDir(DAY)}/outcomes.md`);
    expect(await receipt(DAY)).toMatchObject({ ok: true });
  });
});

describe("startEodTimer renders the fallback only where the curation is missing", () => {
  const TZ = "Europe/Warsaw";
  async function fireOnce(deps: Partial<Parameters<typeof startEodTimer>[0]>): Promise<string[]> {
    let clock = new Date("2026-10-07T09:00:00Z");
    const timers: Array<{ cb: () => void; ms: number }> = [];
    const injected: string[] = [];
    const timer = startEodTimer({
      timeHHMM: "18:00",
      timeZone: TZ,
      now: () => clock,
      readPrompt: () => "sweep {{date}}",
      memoryLayout: "the layout",
      injectOverseer: async (m) => {
        injected.push(m);
      },
      setTimer: (cb, ms) => {
        timers.push({ cb, ms });
        return timers.length - 1;
      },
      clearTimer: () => {},
      ...deps,
    });
    clock = new Date("2026-10-07T16:00:00Z");
    timers[0]!.cb();
    await new Promise((r) => setTimeout(r, 40));
    timer.stop();
    return injected;
  }
  const section = (m: string) => m.split(`## ${EOD_SECTIONS.curation}\n\n`)[1]?.split("\n## ")[0];

  it("a dayContext with no curation (no learner, a packet that threw) gets the no-packet section", async () => {
    const [m] = await fireOnce({
      dayContext: () => "cancelled: none",
      noCuration: (d) => `no packet for ${d}`,
    });
    expect(section(m!)).toBe("no packet for 2026-10-07\n");
    expect(m).toContain("cancelled: none");
  });

  it("a dayContext that never answers gets it too", async () => {
    const [m] = await fireOnce({
      dayContext: () => new Promise<string>(() => {}),
      dayContextTimeoutMs: 10,
      noCuration: () => "no packet",
    });
    expect(section(m!)).toBe("no packet\n");
  });

  it("a real curation wins over the fallback", async () => {
    const [m] = await fireOnce({
      dayContext: () => ({ lines: "x", curation: "decide them" }),
      noCuration: () => "no packet",
    });
    expect(section(m!)).toBe("decide them\n");
    expect(m).not.toContain("no packet");
  });

  it("a fallback that throws or says nothing costs the section, never the sweep — and without one nothing changes", async () => {
    const [thrown] = await fireOnce({
      noCuration: () => {
        throw new Error("boom");
      },
    });
    expect(thrown).toBe("sweep 2026-10-07\n\n## Reviewer memory layout\n\nthe layout\n");
    const [blank] = await fireOnce({ noCuration: () => "  " });
    expect(blank).toBe(thrown);
    const [none] = await fireOnce({});
    expect(none).toBe(thrown);
  });

  it("wire.ts hands the timer the no-packet section, 'off' exactly when there is no learner — and its receipt route is the one driven above", () => {
    const wire = readFileSync(join(ROOT, "src", "wire.ts"), "utf8");
    expect(wire).toMatch(
      /noCuration: \(date\) => renderNoPacketSection\(date, learner \? "unavailable" : "off"\),/,
    );
    expect(wire).toMatch(
      /curationReceipt\(receipt\) \{\s*return routeCurationReceipt\(learner, receipt\);\s*\}/,
    );
  });
});
