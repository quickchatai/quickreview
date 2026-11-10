// Legacy-acceptance belts — permanent, not cleanup candidates.
//
// The tier split (owner_legacy → owner + system) and the command rename
// (flag-owner-legacy → flag-owner) follow the codebase's established pattern for
// retired spellings (ESCALATE → NEEDS_HUMAN in normalizeVerdict): the old
// string is accepted on input forever and folded to the current vocabulary at
// parse time, and the new spelling is the only one ever emitted. Live state
// makes the input side non-negotiable: origin records written before the
// rename sit on disk, slack_events rows sit in state.db, and frozen prompts
// (rule 6 — a correcting reseed is the owner's to ratify) plus long-lived
// overseer sessions keep emitting `flag-owner-legacy`.
//
// Every fold lives here, in one file, so a "dead code" sweep cannot remove
// one silently: deleting a fold breaks this file by name, and this header is
// the explanation the deleter must argue with. If you are here to clean up —
// don't. Removing an entry needs proof that no pre-rename state and no
// old-prompt session can still reach the daemon, which in practice means
// the owner's explicit call, recorded in the tracker.
//
// The folds:
//   1. tier string  "owner_legacy"      → "owner"      (foldSlackTier, src/state.ts;
//      applied by parseOriginRecord in src/slack/origin.ts and by
//      StateStore.slackEvent in src/state.ts)
//   2. command name "flag-owner-legacy" → "flag-owner" (LEGACY_COMMAND_NAMES,
//      validateCommand in src/commands.ts)
//   3. /qcr-review's retired arguments (parseReviewCommand,
//      packages/pi-plugin/src/plugin/args.ts): "--full" → the full preset,
//      "--branch" → the bare command's branch, "--to LIST" → accepted, its
//      "json" still the JSON result. Skills and saved prompts still type them;
//      ADR 0001's exception covers the command names, never these.
//   4. pass tier names: the ladder has two spellings ("terra-med" / "sol-med" /
//      "sol-high" and "light" / "standard" / "deep"), one emitted, both read
//      (foldTier and foldAgentName, packages/pi-plugin/src/types.ts). A
//      config.toml, a profile committed in someone else's repository, a bench
//      plan's `--config` lever, a stored round or ledger row and, longest of
//      all, a sticky PR session's transcript keep the name they were written
//      with, so the session goes on calling `pass-x--sol-high` and writing
//      `tier: "sol-high"` for as long as its pull request lives.
// Not a fold: regression.ts's Recommendation "ask-owner-legacy" → "ask-owner" —
// that value is produced and rendered only, never parsed back, so there is no
// input side to keep.
// Not a fold, by ruling: the pi plugin's unprefixed commands /review, /scan
// and /selfimprove are dropped with no alias (docs/adr/0001-plugin-and-app-nest.md,
// the one recorded exception to this file's rule). pi's command namespace is
// shared with every other extension, so an alias would keep the collision the
// rename removes. They are /qcr-review and /qcr-scan, and /selfimprove is the
// app's own pi's; the last block below holds that no alias creeps back.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeCommand,
  CommandWatcher,
  executeCommand,
  validateCommand,
  type CommandDeps,
} from "../src/commands.js";
import { parseConfig } from "../src/config.js";
import { OriginStore, parseOriginRecord } from "../src/slack/origin.js";
import { foldSlackTier, StateStore } from "../src/state.js";
import { VerdictWatcher, type VerdictAdapter } from "../src/verdicts.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createQuickReview } from "@quickchatai/pi-quickreview/extensions/quickreview.js";
import { applyConfigOverrides } from "@quickchatai/pi-quickreview/src/engine/context.js";
import { loadBuiltAgents } from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import { parseLensTable } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { ALL_PASSES } from "@quickchatai/pi-quickreview/src/passes.js";
import { parseReviewCommand } from "@quickchatai/pi-quickreview/src/plugin/args.js";
import {
  parseCoreConfig,
  parseModels,
  parseReviewSection,
  parseScan,
  parseScanTable,
  presetOf,
} from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { lensForAgent } from "@quickchatai/pi-quickreview/src/round-progress.js";
import {
  measuredRate,
  sameTier,
  type LedgerEntry,
} from "@quickchatai/pi-quickreview/src/scan/ledger.js";
import { sdkCaseRunner } from "@quickchatai/pi-quickreview/src/scan/scanleaves.js";
import { planStage2, type Stage2PlanInput } from "@quickchatai/pi-quickreview/src/scan/stage2.js";
import {
  foldAgentName,
  foldTier,
  LEGACY_TIER_NAMES,
  PASS_TIER_ORDER,
  type PassPlanEntry,
  type SessionHooks,
} from "@quickchatai/pi-quickreview/src/types.js";

// ---- fold 1: the tier string --------------------------------------------

describe("tier fold: 'owner_legacy' → 'owner'", () => {
  it("foldSlackTier folds the retired spelling and passes the current vocabulary through", () => {
    expect(foldSlackTier("owner_legacy")).toBe("owner");
    for (const t of ["anyone", "author", "owner", "system", "ignored"] as const) {
      expect(foldSlackTier(t)).toBe(t);
    }
    // Unknown strings still grant nothing — the fold is not a wildcard.
    expect(foldSlackTier("root")).toBeNull();
    expect(foldSlackTier("")).toBeNull();
    expect(foldSlackTier(undefined)).toBeNull();
  });

  it("a pre-rename origin record on disk parses as tier 'owner' with its rights intact", () => {
    const rec = parseOriginRecord({
      source: "slack",
      event_id: "EvOLD",
      slack_user: "U0MAT",
      tier: "owner_legacy",
      authorized_prs: [1234],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(rec).not.toBeNull();
    expect(rec?.tier).toBe("owner");
    // …and the folded record carries the old top-tier rights end to end.
    expect(authorizeCommand({ command: "restart-session", pr: 12 }, rec!).ok).toBe(true);
  });

  it("OriginStore reads a legacy record file straight off disk into the new vocabulary", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-legacy-origin-"));
    try {
      writeFileSync(
        join(dir, "old-wake.json"),
        JSON.stringify({
          source: "local",
          event_id: "local:eod-sweep",
          slack_user: "",
          tier: "owner_legacy",
          authorized_prs: [],
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );
      const origins = new OriginStore(dir);
      // The audit view reads it in the new vocabulary. (A record read off disk
      // is never authority — only the records this process wrote are — so the
      // fold is pinned here, on the read path that still consumes old files.)
      expect(origins.onDisk()[0]).toMatchObject({ tier: "owner", source: "local" });
      expect(origins.latest()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writeLocal stamps 'system' — the legacy spelling is never emitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-legacy-writelocal-"));
    try {
      const origins = new OriginStore(dir);
      expect(origins.writeLocal("eod-sweep").tier).toBe("system");
      // The bytes on disk, not just the return value: nothing writes "owner_legacy".
      for (const name of readdirSync(dir)) {
        expect(readFileSync(join(dir, name), "utf8")).not.toContain("owner_legacy");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a pre-rename slack_events row reads back as tier 'owner'", () => {
    const store = new StateStore(":memory:");
    try {
      // Simulate a row written before the rename — raw SQL, the shape such
      // rows have in a live state.db.
      store.db
        .prepare(
          `INSERT INTO slack_events (event_id, channel, ts, thread_ts, slack_user, tier, disposition, received_at, injected_at)
           VALUES ('EvLEGACY', 'C1', '1.1', NULL, 'U0MAT', 'owner_legacy', 'injected', '2026-08-01T00:00:00Z', NULL)`,
        )
        .run();
      expect(store.slackEvent("EvLEGACY")?.tier).toBe("owner");
    } finally {
      store.close();
    }
  });
});

// ---- fold 2: the command name -------------------------------------------

describe("command fold: 'flag-owner-legacy' → 'flag-owner'", () => {
  it("validates as the CURRENT name — accepted on input, never emitted", () => {
    const res = validateCommand({ command: "flag-owner-legacy", message: "look at this" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.command).toEqual({ command: "flag-owner", message: "look at this" });
  });

  it("the alias inherits the exact strict schema, not a looser one", () => {
    expect(validateCommand({ command: "flag-owner-legacy", reason: "x" })).toEqual({
      ok: false,
      reason: "unknown field(s): reason",
    });
    expect(validateCommand({ command: "flag-owner-legacy", message: "  " }).ok).toBe(false);
  });

  it("stays tier-free under the old spelling — the safety valve never regresses", () => {
    const res = validateCommand({ command: "flag-owner-legacy", message: "help" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const anyone = {
      source: "slack" as const,
      event_id: "Ev",
      slack_user: "U0GUEST",
      tier: "anyone" as const,
      authorized_prs: [],
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(authorizeCommand(res.command, anyone).ok).toBe(true);
  });

  it("routes to the flagOwner handler", async () => {
    const deps = { flagOwner: vi.fn(async () => undefined) } as unknown as CommandDeps;
    const res = validateCommand({ command: "flag-owner-legacy", message: "m" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await executeCommand(res.command, deps)).toEqual({ ok: true });
    expect(deps.flagOwner).toHaveBeenCalledWith("m");
  });

  it("the retired-command hint (mark-escalation-worthy) names the current command", () => {
    const res = validateCommand({ command: "mark-escalation-worthy", pr: 1, reason: "x" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("flag-owner");
    // …and still points a session running an old prompt at the spelling it knows.
    expect(res.reason).toContain("flag-owner-legacy");
  });

  describe("end to end through the CommandWatcher", () => {
    let dir: string;
    let store: StateStore;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "qcr-legacy-watcher-"));
      mkdirSync(join(dir, "commands"), { recursive: true });
      store = new StateStore(":memory:");
    });
    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("an old-prompt session's flag-owner-legacy file executes, and the result records flag-owner", async () => {
      const cmdDir = join(dir, "commands");
      writeFileSync(
        join(cmdDir, "old-session.json"),
        JSON.stringify({ command: "flag-owner-legacy", message: "hi" }),
      );
      const flagOwner = vi.fn(async () => undefined);
      const deps = { flagOwner } as unknown as CommandDeps;
      await new CommandWatcher({
        dir: cmdDir,
        deps,
        store,
        log: () => {},
        parseAttempts: 2,
        parseRetryMs: 1,
      }).sweep();
      expect(flagOwner).toHaveBeenCalledWith("hi");
      // Everything we emit — the result file and the event ledger — carries
      // the current name; the legacy spelling exists only on the input side.
      const result = JSON.parse(
        readFileSync(join(cmdDir, "results", "old-session.result.json"), "utf8"),
      );
      expect(result).toMatchObject({ ok: true, command: "flag-owner", file: "old-session.json" });
      const events = store.eventsOn(new Date().toISOString().slice(0, 10));
      const executed = events.find((e) => e.kind === "command_executed");
      expect(JSON.stringify(executed)).toContain("flag-owner");
      expect(JSON.stringify(executed)).not.toContain("flag-owner-legacy");
    });
  });
});

// ---- fold 3: /qcr-review's retired arguments ------------------------------

describe("/qcr-review argument folds: --full, --branch, --to", () => {
  // MUTATION: delete the "--full" case from parseReviewCommand — this fails.
  it("--full is the full preset", () => {
    expect(parseReviewCommand("--full")).toMatchObject({
      preset: "full",
      target: { kind: "branch", uncommitted: true },
    });
    expect(parseReviewCommand("12 --full", "quick")).toMatchObject({
      preset: "full",
      target: { kind: "pr", pr: "12" },
    });
    expect(parseReviewCommand("full --full")).toMatchObject({ preset: "full" });
  });

  // MUTATION: delete the "--branch" case — this fails.
  it("--branch is the bare command's branch, with --base as before", () => {
    expect(parseReviewCommand("--branch")).toEqual(parseReviewCommand(""));
    expect(parseReviewCommand("--branch --base dev")).toEqual(parseReviewCommand("--base dev"));
  });

  // MUTATION: delete the "--to" case — this fails.
  it("--to takes the old destinations; json still means the JSON result", () => {
    expect(parseReviewCommand("12 --to pr")).toEqual(parseReviewCommand("12"));
    expect(parseReviewCommand("--to terminal,file")).toEqual(parseReviewCommand(""));
    expect(parseReviewCommand("--to json")).toMatchObject({ json: true });
    expect(parseReviewCommand("--to nowhere")).toHaveProperty("error");
  });

  it("the usage names only the current spellings", () => {
    const usage = (parseReviewCommand("--wat") as { error: string }).error;
    for (const old of ["--full", "--branch", "--to"]) expect(usage).not.toContain(old);
  });
});

// ---- fold 4: pass tier names ----------------------------------------------

describe("pass tiers: the older names are read forever", () => {
  // Every case holds under either ladder: whichever spelling PASS_TIER_ORDER
  // emits, the other one is read on every input, so each case names its
  // expectation by rung (PASS_TIER_ORDER[i]) and feeds both spellings.
  //
  // MUTATION: delete "sol-high" from LEGACY_TIER_NAMES — the tier block
  // fails. (While the ladder itself still spells its rungs that way the map
  // holds the other three: delete "deep".)
  const SPELLINGS = [
    ["terra-med", "light"],
    ["sol-med", "standard"],
    ["sol-high", "deep"],
  ] as const;
  const OLDER: readonly string[] = SPELLINGS.map(([older]) => older);
  const NEWER: readonly string[] = SPELLINGS.map(([, newer]) => newer);
  const [BASE, ADD, RISK] = PASS_TIER_ORDER;
  /** Rung `i` under each of its two names. */
  const bothAt = (i: number): readonly string[] => SPELLINGS[i]!;
  const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "config.toml"), "utf8");
  /** The fixture config with `[models.tiers]` holding exactly `tiers`. */
  const configToml = (tiers: Record<string, string>): string => {
    const without = FIXTURE.replace(/^\[models\.tiers\]\n(?:(?!\[).*\n)*/m, "");
    expect(without).not.toContain("[models.tiers]");
    const rows = Object.entries(tiers).map(([k, v]) => `"${k}" = "${v}"`);
    return `${without}\n[models.tiers]\n${rows.join("\n")}\n`;
  };
  const models = (over: Record<string, unknown>) =>
    parseModels({ default: "prov/m", conversation: "prov/m", ...over });

  it("the ladder is one of the two spellings and the alias map holds the other", () => {
    const ladder: readonly string[] = PASS_TIER_ORDER;
    expect([OLDER, NEWER]).toContainEqual(ladder);
    const other = ladder[0] === OLDER[0] ? NEWER : OLDER;
    expect(Object.keys(LEGACY_TIER_NAMES).sort()).toEqual([...other].sort());
    SPELLINGS.forEach((names, i) => {
      for (const name of names) expect(foldTier(name)).toBe(PASS_TIER_ORDER[i]);
    });
    // The fold is not a wildcard: no near miss, no object key, no other case.
    for (const not of ["", "sol-low", "sol-max", "Deep", "constructor", "toString"])
      expect(foldTier(not)).toBeUndefined();
  });

  it("an agent name folds its tier suffix and nothing else", () => {
    SPELLINGS.forEach((names, i) => {
      for (const name of names)
        expect(foldAgentName(`pass-x--${name}`)).toBe(`pass-x--${PASS_TIER_ORDER[i]}`);
    });
    for (const same of ["pass-x", "pass-x--sol-low", "deep", "pass-deep", "pass-x--deep--y"])
      expect(foldAgentName(same)).toBe(same);
  });

  it("config.toml [models.tiers] keys: either spelling sets its rung", () => {
    for (const names of [OLDER, NEWER]) {
      const cfg = parseCoreConfig(
        configToml({
          [names[0]!]: "prov/a:medium",
          [names[1]!]: "prov/b:medium",
          [names[2]!]: "prov/c:high",
        }),
      );
      expect(cfg.models.tiers).toEqual({
        [BASE]: "prov/a:medium",
        [ADD]: "prov/b:medium",
        [RISK]: "prov/c:high",
      });
    }
  });

  it("config.toml [models.tiers]: both spellings of one rung must agree", () => {
    const [a, b] = bothAt(2) as [string, string];
    expect(models({ tiers: { [a]: "prov/c:high", [b]: "prov/c:high" } }).tiers[RISK]).toBe(
      "prov/c:high",
    );
    expect(() => models({ tiers: { [a]: "prov/c:high", [b]: "prov/d:high" } })).toThrow(
      /\[models\.tiers\] sets .* and its older name .* to different models/,
    );
  });

  it("config.toml [models.tiers]: a key that is no tier loads, is left out, and is named once", () => {
    const warned: string[] = [];
    const cfg = parseCoreConfig(configToml({ [OLDER[2]!]: "prov/c:high", "sol-ultra": "prov/z" }), {
      warn: (line) => warned.push(line),
    });
    expect(cfg.models.tiers[RISK]).toBe("prov/c:high");
    expect(Object.keys(cfg.models.tiers).sort()).toEqual([...PASS_TIER_ORDER].sort());
    const named = warned.filter((line) => line.includes("[models.tiers]"));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain('"sol-ultra" is not a tier');
    for (const name of [...OLDER, ...NEWER]) expect(named[0]).toContain(name);
    // The app's parser hears the same line and loads the same tiers.
    const lines: string[] = [];
    const spy = vi.spyOn(console, "warn").mockImplementation((line) => void lines.push(line));
    try {
      const app = parseConfig(configToml({ [NEWER[2]!]: "prov/c:high", "sol-ultra": "prov/z" }));
      expect(app.models.tiers[RISK]).toBe("prov/c:high");
    } finally {
      spy.mockRestore();
    }
    expect(lines.filter((line) => line.includes('"sol-ultra" is not a tier'))).toHaveLength(1);
  });

  it("validate_tier and [models.pass_tiers] values: either spelling", () => {
    for (const name of bothAt(0)) {
      const m = models({ validate_tier: name, pass_tiers: { "pass-baseline": name } });
      expect(m.validate_tier).toBe(BASE);
      expect(m.pass_tiers["pass-baseline"]).toBe(BASE);
    }
    // A name that is no tier is still refused, naming the ladder.
    expect(() =>
      parseCoreConfig(FIXTURE.replace(/^validate_tier = .*$/m, 'validate_tier = "sol-ultra"')),
    ).toThrow(`unknown tier "sol-ultra" (one of ${PASS_TIER_ORDER.join(", ")})`);
  });

  it("[review] sweep_light_tier: either spelling, and off stays off", () => {
    const review = (v: string) =>
      parseReviewSection({ review: { sweep_light_tier: v } }, presetOf({})).sweep_light_tier;
    for (const name of bothAt(0)) expect(review(name)).toBe(BASE);
    expect(review("")).toBe("");
  });

  it("[scan] tier, in config.toml and in a profile: either spelling", () => {
    for (const name of bothAt(1)) {
      expect(parseScan({ tier: name }).tier).toBe(ADD);
      expect(parseScanTable("profile x", { tier: name }, ["tier"]).tier).toBe(ADD);
    }
    expect(() => parseScan({ tier: "sol-ultra" })).toThrow(
      `must be one of ${PASS_TIER_ORDER.join(", ")}`,
    );
  });

  it("a profile's [lenses.<pass>] min_tier: either spelling", () => {
    for (const name of bothAt(2)) {
      const table = parseLensTable(
        "profile x",
        { "pass-baseline": { min_tier: name } },
        ALL_PASSES,
      );
      expect(table["pass-baseline"]?.min_tier).toBe(RISK);
    }
    expect(() =>
      parseLensTable("profile x", { "pass-baseline": { min_tier: "sol-ultra" } }, ALL_PASSES),
    ).toThrow(`min_tier must be one of ${PASS_TIER_ORDER.join(", ")}`);
  });

  it("a --config lever: the models.tiers key and every tier value, either spelling", () => {
    const base = parseCoreConfig(FIXTURE);
    for (const names of [OLDER, NEWER]) {
      const out = applyConfigOverrides(
        base,
        [
          `models.tiers.${names[2]}=prov/levered:high`,
          `models.validate_tier=${names[1]}`,
          `models.pass_tiers.pass-sweep=${names[0]}`,
          `review.sweep_light_tier=${names[0]}`,
          `scan.tier=${names[2]}`,
        ].join(","),
      );
      expect(out.models.tiers[RISK]).toBe("prov/levered:high");
      expect(Object.keys(out.models.tiers).sort()).toEqual([...PASS_TIER_ORDER].sort());
      expect(out.models.validate_tier).toBe(ADD);
      expect(out.models.pass_tiers["pass-sweep"]).toBe(BASE);
      expect(out.review.sweep_light_tier).toBe(BASE);
      expect(out.scan.tier).toBe(RISK);
    }
    // A key that is no tier is still a typo, never a new table entry.
    expect(() => applyConfigOverrides(base, "models.tiers.sol-ultra=prov/m")).toThrow(
      'no key "models.tiers.sol-ultra"',
    );
  });

  describe("a verdict's tiers against the round's recorded plan", () => {
    class Adapter implements VerdictAdapter {
      async addLabel(): Promise<GateResult> {
        return { executed: false, dryRunFile: "d" };
      }
      async removeLabel(): Promise<GateResult> {
        return { executed: false, dryRunFile: "d" };
      }
    }
    const hooks: SessionHooks = {
      async dispatchRound() {},
      async inject() {},
      async archiveAndClose() {},
    };
    const cfg = parseConfig(FIXTURE);
    let dir: string;
    let store: StateStore;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "qcr-legacy-tier-verdict-"));
      store = new StateStore(":memory:");
    });
    afterEach(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    /** A round whose plan names its tiers in `plan`'s spelling, answered by
     * a verdict that names them in `said`'s; `baseline` is the rung the
     * verdict says pass-baseline ran at. Returns the mismatch payloads. */
    async function mismatches(
      pr: number,
      plan: readonly string[],
      said: readonly string[],
      baseline: number,
    ): Promise<Array<Record<string, unknown>>> {
      store.upsertPr({
        number: pr,
        state: "reviewing",
        head_sha: "abc123",
        title: `PR ${pr}`,
        author: "alice",
        trigger_ts: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      store.startRound(pr, "first", ["pass-baseline", "pass-validate"], 75, {
        pass_plan: [
          {
            lens: "pass-baseline",
            agent: `pass-baseline--${plan[1]}`,
            tier: plan[1],
            raisable_to: [`pass-baseline--${plan[2]}`],
          },
          {
            lens: "pass-validate",
            agent: `pass-validate--${plan[2]}`,
            tier: plan[2],
            raisable_to: [],
          },
        ] as unknown as PassPlanEntry[],
        addable_passes: [{ lens: "pass-concurrency", tier: plan[1]! }],
      });
      const name = `pr-${pr}-round-1.json`;
      writeFileSync(
        join(dir, name),
        JSON.stringify({
          pr,
          round_no: 1,
          verdict: "REQUEST_CHANGES",
          head_sha: "abc123",
          spend_usd: 1,
          finished_at: "2026-08-13T12:00:00Z",
          passes: [
            { name: "pass-baseline", tier: said[baseline], findings: 0 },
            { name: "pass-concurrency", tier: said[1], reason: "added: a race", findings: 0 },
            { name: "pass-validate", tier: said[2], findings: 0 },
          ],
        }),
      );
      await new VerdictWatcher({
        cfg,
        store,
        adapter: new Adapter(),
        hooks,
        verdictDir: dir,
        root: dir,
        usage: {},
        partialWrite: { windowMs: 0 },
      }).handleFile(name);
      return (
        store.db
          .prepare("SELECT payload FROM events WHERE kind = 'pass_plan_mismatch' AND pr = ?")
          .all(pr) as Array<{ payload: string }>
      ).map((row) => JSON.parse(row.payload) as Record<string, unknown>);
    }

    it("a verdict in the older names conforms to a plan in the newer ones, and the reverse", async () => {
      // pass-baseline raised to the top rung (its row allows the raise by
      // agent name), a reasoned addition at its tier, the validator at its own.
      expect(await mismatches(301, NEWER, OLDER, 2)).toEqual([]);
      expect(await mismatches(302, OLDER, NEWER, 2)).toEqual([]);
      const additions = (
        store.db
          .prepare("SELECT payload FROM events WHERE kind = 'pass_plan_conformant_addition'")
          .all() as Array<{ payload: string }>
      ).map((row) => (JSON.parse(row.payload) as { additions: unknown[] }).additions);
      // What is recorded names the tier one way: the ladder's.
      expect(additions).toEqual([
        [{ name: "pass-concurrency", tier: ADD, reason: "added: a race" }],
        [{ name: "pass-concurrency", tier: ADD, reason: "added: a race" }],
      ]);
    });

    it("the fold is not a wildcard: a rung the plan does not allow is still the wrong tier", async () => {
      // pass-baseline BELOW its planned rung, across the two spellings.
      const [payload] = await mismatches(303, NEWER, OLDER, 0);
      expect(payload).toMatchObject({ wrong_tier: ["pass-baseline"] });
    });
  });

  it("lensForAgent strips the tier suffix in either spelling", () => {
    for (const name of [...OLDER, ...NEWER])
      expect(lensForAgent(`pass-x--${name}`), name).toBe("pass-x");
    expect(lensForAgent("pass-x--sol-med")).toBe("pass-x");
  });

  describe("the built agent a name finds", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "qcr-legacy-tier-agents-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const build = (name: string): void =>
      writeFileSync(
        join(dir, `${name}.md`),
        `---\nname: ${name}\ndescription: a lens\n---\n\nRead the diff.\n`,
      );

    it("the lens tool's lookup: pass-x--sol-high finds the top rung's built agent", () => {
      build(`pass-x--${RISK}`);
      const registry = loadBuiltAgents(dir);
      for (const name of ["sol-high", ...bothAt(2)])
        expect(registry.get(`pass-x--${name}`)?.name, name).toBe(`pass-x--${RISK}`);
      // Another rung has no built agent here, under either name.
      for (const name of bothAt(1)) expect(registry.get(`pass-x--${name}`)).toBeUndefined();
      // Only the ladder's names are built and listed.
      expect(registry.names()).toEqual([`pass-x--${RISK}`]);
    });

    it("a scan case: an agent named in either spelling finds the built file", async () => {
      build(`pass-scan--${ADD}`);
      const runner = sdkCaseRunner({
        agentsDir: dir,
        cwd: dir,
        env: {},
        home: dir,
        runtime: () => {
          throw new Error("no runtime: the case must stop at the model check");
        },
      });
      const run = (agent: string) =>
        runner.run(
          { id: "c1", unit: "u", agent, files: [], prompt: "p" },
          new AbortController().signal,
        );
      // Found: the case gets as far as the agent's (absent) model.
      for (const name of bothAt(1))
        expect(await run(`pass-scan--${name}`)).toMatchObject({
          ok: false,
          reason: expect.stringContaining("names no model and none is set"),
        });
      // Not found: a rung with no built file, under either name.
      for (const name of bothAt(2))
        expect(await run(`pass-scan--${name}`)).toMatchObject({
          ok: false,
          reason: expect.stringContaining("no agent pass-scan--"),
        });
    });
  });

  it("a scan ledger row keyed sol-med still prices its rung, under either name", () => {
    const row = (tier: string): LedgerEntry => ({
      path: "src/a.ts",
      blob: "b1",
      lens: "pass-scan",
      tier,
      effort: "low",
      validator: true,
      sha: "1".repeat(40),
      lines: 1000,
      cost_usd: 2,
      run: "r1",
      case: "u",
      at: "2026-08-13T12:00:00Z",
    });
    const key = (tier: string) => ({ lens: "pass-scan", tier, effort: "low", validator: true });
    for (const stored of ["sol-med", ...bothAt(1)])
      for (const asked of bothAt(1))
        expect(measuredRate([row(stored)], key(asked))?.usd_per_kline, `${stored}/${asked}`).toBe(
          2,
        );
    // Another rung's row prices nothing here.
    for (const asked of bothAt(2)) expect(measuredRate([row("sol-med")], key(asked))).toBeNull();
    // A name that is no tier is only itself.
    expect(sameTier("custom", "custom")).toBe(true);
    expect(sameTier("custom", bothAt(1)[0]!)).toBe(false);
  });

  it("a stage-2 request row may name its tier in either spelling", () => {
    const plan = (tier: string) => {
      const input: Stage2PlanInput = {
        rows: [{ lens: "pass-security", files: ["pkg/foo.ts"], reason: "auth", tier }],
        cut: { units: [{ name: "pkg", roots: ["pkg"], kind: "directory", note: "" }], ignored: [] },
        files: [{ path: "pkg/foo.ts", blob: "b1" }],
        linesOf: () => 5,
        exclude: [],
        budget: { maxFiles: 30, maxLines: 3000 },
        riskPasses: [],
        defaultTier: ADD,
        covered: () => new Set(),
        price: () => ({
          rate: { usd_per_kline: 1, cases: 1, lines: 1000, cost_usd: 1 },
          basis: "measured",
          from: "x",
        }),
        budgetUsd: null,
      };
      return planStage2(input);
    };
    for (const name of bothAt(2)) {
      const p = plan(name);
      expect(p.ok && p.rows[0]?.tier, name).toBe(RISK);
    }
    const bad = plan("sol-ultra");
    expect(!bad.ok && bad.errors.join("; ")).toContain('cannot run at "sol-ultra" here');
  });

  it("the posting route's Python mirror strips both spellings", () => {
    // tests/required-passes.test.ts runs the script; this holds the list.
    const src = readFileSync(
      join(import.meta.dirname, "..", "scripts", "required-passes.py"),
      "utf8",
    );
    const alt = /TIER_SUFFIX = re\.compile\(r"--\(\?:([^)]*)\)\$"\)/.exec(src)?.[1]?.split("|");
    expect(alt?.sort()).toEqual([...OLDER, ...NEWER].sort());
  });
});

// ---- not a fold: the plugin's dropped command names (ADR 0001) ------------

describe("the pi plugin's unprefixed commands are dropped, not folded", () => {
  // MUTATION: register "review" as an alias of "qcr-review" — this fails.
  it("registers /qcr-review and /qcr-scan, and no /review, /scan or /selfimprove", () => {
    const names: string[] = [];
    const pi = {
      registerCommand: (name: string) => names.push(name),
      registerTool: () => {},
      on: () => () => {},
      sendMessage: () => {},
      sendUserMessage: () => {},
      getSettings: () => ({}),
    } as unknown as ExtensionAPI;
    createQuickReview({
      env: {},
      home: tmpdir(),
      runner: { which: () => null, run: async () => ({ code: 127, stdout: "", stderr: "" }) },
      print: () => {},
      piVersion: "1.4.0",
      range: "^1.4.0",
    })(pi);
    expect(names).toEqual(expect.arrayContaining(["qcr-review", "qcr-scan"]));
    for (const gone of ["review", "scan", "selfimprove"]) expect(names).not.toContain(gone);
  });
});
