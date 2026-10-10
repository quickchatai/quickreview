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
// Not a fold: regression.ts's Recommendation "ask-owner-legacy" → "ask-owner" —
// that value is produced and rendered only, never parsed back, so there is no
// input side to keep.
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
import { OriginStore, parseOriginRecord } from "../src/slack/origin.js";
import { foldSlackTier, StateStore } from "../src/state.js";

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
    expect(authorizeCommand({ command: "restart-session", pr: "overseer" }, rec!).ok).toBe(true);
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
