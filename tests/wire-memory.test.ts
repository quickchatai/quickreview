// The production wiring of the memory phase. Every slice
// below degrades SILENTLY and correctly when memory is absent — rounds render
// memory-less, the raw tier is skipped, the watchdog stands down — which is
// the behaviour we want at runtime and exactly what makes an unwired daemon
// invisible to every other test. These assertions are the tripwire: they fail
// if a refactor disconnects memory while leaving the suite green.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MEMORY_DEFAULTS } from "../src/config.js";
import { DEFAULT_CATEGORY } from "../src/openviking/store.js";

const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");

describe("wire.ts: the memory phase is actually connected", () => {
  it("the daemon is handed a round-memory seed built on the assembler", () => {
    expect(wire).toMatch(/memory:\s*\{\s*\n\s*assembler:/);
    expect(wire).toContain("openVikingContextAssembler");
  });

  it("the context search is quota'd to the memory scopes, not left to the server's balance", () => {
    // Unquota'd, the server spreads the block over every scope it holds and a
    // round sees ~one memory entry beside two built-in blurbs — memory is
    // wired but effectively not read. Config-driven so the scopes are a knob.
    expect(wire).toMatch(/quotas:\s*cfg\.memory\.context_quotas/);
    expect(MEMORY_DEFAULTS.context_quotas["experiences"]).toBeGreaterThan(0);
    // Every entry the store writes lands in the default category, so a quota
    // map that omits it would silently starve the round of reviewer memory.
    expect(Object.keys(MEMORY_DEFAULTS.context_quotas)).toContain(DEFAULT_CATEGORY);
  });

  it("the round context block searches experiences/ only (S5) — the default quotas name nothing else", () => {
    expect(MEMORY_DEFAULTS.context_quotas).toEqual({ experiences: 24 });
  });

  it("every round publishes its query as the PR session's recall hint (S5)", () => {
    expect(wire).toMatch(
      /publishQuery: \(pr: number, query: string\) => \{\s*writeRecallHint\(\s*sessions\.ovRecallHintPath\(prSessionName\(pr\)\),\s*\{ query, areas: ROUND_SEARCH_AREAS \}/,
    );
  });

  it("the EOD watchdog reads through the store that has the pinned-area read", () => {
    // `readPinnedFromSweep` prefers `pinnedSweep()` — the directory the round's
    // head reads (S5) — and the store handed to it has one.
    expect(wire).toMatch(/memorySweep = memory;/);
    expect(wire).toMatch(/readPinned: readPinnedFromSweep\(sweepSource\)/);
  });

  it("the round renderer receives the assembled seed", () => {
    // the owner name rides along so the pinned-head framing renders
    // from config.
    // the profile-selected ecosystem rides along too, so a none
    // profile's prompts really carry no migration-gate prose.
    // the identity variable map rides beside them.
    expect(wire).toMatch(
      /renderRoundPrompt\([\s\S]*?order,\s*memory,\s*cfg\.owner\.name,\s*ecosystem,\s*identity,?\s*\)/,
    );
    expect(wire).toMatch(/renderPrompt = \(order: RoundOrder, memory: RoundMemory\)/);
  });

  it("PR sessions are given the OpenViking session lifecycle (the raw tier)", () => {
    expect(wire).toContain("openVikingSessionLifecycle");
    expect(wire).toMatch(/new PiSessionManager\(\{[^}]*ovSessions/s);
  });

  it("the feedback sink writes through the OpenViking store, not a default", () => {
    expect(wire).toMatch(/new FeedbackEngine\(\{[^}]*memory[,}]/s);
    expect(wire).toContain("openVikingStore(memoryClient");
  });

  it("the EOD inject is wrapped by the pinned-area watchdog", () => {
    expect(wire).toContain("startEodPinWatch");
    expect(wire).toMatch(/injectOverseer:\s*pinWatch \? pinWatch\.wrapInject/);
  });

  it("the daemon materializes the memory root when the server comes up", () => {
    // Without this the daemon's first sweep on a fresh server lists a root
    // that does not exist and leans on how the server spells a missing one.
    expect(wire).toMatch(/new OpenVikingSupervisor\(\{[\s\S]*?onReady:[\s\S]*?ensureWritable\(\)/);
  });

  it("only the reviewer USER key is ever read — never ADMIN or ROOT", () => {
    expect(wire).toContain("OV_REVIEWER_KEY_SECRET");
    expect(wire).not.toMatch(/root_api_key|admin_key|ROOT_KEY/i);
  });
  it("the EOD pin-watch waits for the digest where the sweep WRITES it — the sandbox root's digest/, the same dir the headline reads", () => {
    // prompts/eod-sweep.md has the overseer (cwd = the sandbox root) write
    // `digest/<date>.md`. A readiness probe on state/digest/ never saw it, so
    // the watch never closed early and ran its whole window every night.
    expect(wire).toContain('latestDigestHeadline(join(root, "digest"))');
    expect(wire).toMatch(
      /digestReady:\s*\(date\)\s*=>\s*digestWritten\(date, join\(root, "digest"\)\)/,
    );
    expect(wire).not.toMatch(/"state",\s*"digest"/);
  });
});

// memory failures reach a person. Like everything above, this
// wiring degrades silently when disconnected (no block, no wake, no banner),
// so the tripwire is structural.
describe("wire.ts: reviewer-memory health is actually connected (S1)", () => {
  it("BOTH credentials in use are probed, authenticated, separately", () => {
    expect(wire).toContain("new MemoryHealthMonitor({");
    expect(wire).toMatch(/daemon: credentialProbe\(\{[\s\S]*?reviewerKey\(\)/);
    expect(wire).toMatch(
      /sessions: credentialProbe\(\{[\s\S]*?readOvcliKey\(sessions\.ovcliConfPath\(\)\)/,
    );
  });

  it("the daemon's own requests and every round seed feed it", () => {
    expect(wire).toMatch(
      /apiKey: reviewerKey,[\s\S]*?onRequest: \(r\) => memoryHealth\?\.recordRequest\(r\)/,
    );
    expect(wire).toMatch(/onSeeded: \(mem: RoundMemory\) =>\s*memoryHealth\?\.recordRoundSeed\(/);
    // The raw-tier client built in buildParts is counted too, late-bound.
    expect(wire).toMatch(/onRequest: \(r\) => memoryRequests\.sink\?\.\(r\)/);
    expect(wire).toMatch(
      /parts\.memoryRequests\.sink = \(r\) => memoryHealth\?\.recordRequest\(r\)/,
    );
  });

  it("its block reaches status.json beside openviking", () => {
    // the block is the monitor's status plus the [feedback]
    // ledger's memory backlog.
    expect(wire).toMatch(
      /memoryStatus: \(\): MemoryStatus => \{\s*const base = memoryHealth\s*\? memoryHealth\.status\(\)/,
    );
    // Before onStart decides, the block is UNKNOWN (pending), never "off".
    expect(wire).toContain(": pendingMemoryStatus()");
  });

  it("wakes go through the anomaly funnel, and a drain only defers memory_down", () => {
    expect(wire).toMatch(
      /wake: \(kind, detail, message\) => d\.store\.logAnomaly\(kind, null, null, detail, message\)/,
    );
    expect(wire).toMatch(/draining: \(\) => d\.store\.drainState\(\)\.draining/);
    expect(wire).toMatch(/load: \(\) => d\.store\.memoryIncident\(\)/);
  });

  it("a changed daemon key rewrites the live sessions' ovcli.conf", () => {
    expect(wire).toMatch(
      /keyChangeWatcher\(\(\) => \{\s*const res = sessions\.provisionOvCredentials\(\)/,
    );
    expect(wire).toMatch(/beforeProbe: \(\) => \{\s*watchKey\(reviewerKey\(\)\)/);
  });

  it("the boot provisioning report is read and wakes once per report", () => {
    // The step itself (one row, once per report, an unreadable file included)
    // is tested against a real StateStore in openviking-provision.test.ts;
    // this pins that the daemon's boot actually runs it, over the anomaly
    // funnel, before the monitor starts.
    expect(wire).toMatch(
      /const prov = readProvisionReport\(provisionReportPath\(root\)\);\s*memoryHealth\.setProvision\(prov\);\s*raiseProvisionWake\(d\.store, prov\);\s*memoryHealth\.start\(\);/,
    );
  });

  it("gaps are counted into a QUIET openviking_gap, rate-limited", () => {
    // The limiter is tested in memory-probe.test.ts; this pins the wiring.
    expect(wire).toContain("onGap: countedGap");
    expect(wire).toMatch(
      /const countedGap = countedGapSink\(\{\s*record: \(gap\) => memoryHealth\?\.recordGap\(gap\),\s*logAnomaly: \(kind, pr, roundNo, detail\) => d\.store\.logAnomaly\(kind, pr, roundNo, detail\),/,
    );
  });

  it("only memory switched OFF is 'not monitored' — a configured-on memory with no server is an outage", () => {
    expect(wire).toMatch(
      /if \(!cfg\.openviking\.enabled\) \{\s*memoryUnmonitored = "\[openviking\] enabled = false";\s*\} else \{/,
    );
    // The supervisor's "enabled" folds in a missing binary; it must not
    // decide whether memory is watched.
    expect(wire).not.toMatch(/memoryUnmonitored = cfg\.openviking\.enabled/);
    expect(wire).not.toMatch(/if \(!supervisor\.status\(\)\.enabled\)/);
  });

  it("the dead per-round alert knob is gone", () => {
    expect(wire).not.toContain("alertCooldownMin");
    expect(wire).not.toContain("alert_cooldown_min");
    expect(MEMORY_DEFAULTS).not.toHaveProperty("alert_cooldown_min");
    expect(MEMORY_DEFAULTS).toMatchObject({
      probe_interval_s: 120,
      down_after_min: 10,
      boot_grace_min: 5,
      rewake_h: 6,
      incident_ticket_after_min: 120,
    });
  });
});

describe("tui/index.ts: memory failures reach the operator (S1)", () => {
  const tui = readFileSync(join(process.cwd(), "src", "tui", "index.ts"), "utf8");

  it("the desktop notification rides the alert pipeline, from status.json", () => {
    expect(tui).toMatch(
      /maybeWriteMemoryAlert\(\s*full\.companion\.alerts_dir,\s*a\.view\.snapshot\?\.memory,/,
    );
  });

  it("the tracker ticket is filed from status.json past the configured age", () => {
    expect(tui).toMatch(/maybeFileMemoryIncident\(incidentTracker, a\.view\.snapshot\?\.memory,/);
    expect(tui).toContain("full.memory.incident_ticket_after_min * 60_000");
  });

  it("an EOD curation incident (S8) files the same way, with its own memo", () => {
    expect(tui).toMatch(
      /maybeFileCurationIncident\(incidentTracker, a\.view\.snapshot\?\.memory, \{[\s\S]{0,200}?afterMs: full\.memory\.incident_ticket_after_min \* 60_000,\s*memo: curationMemo,/,
    );
  });

  it("the companion's view carries the TUI's own request counts", () => {
    expect(tui).toContain("tuiMemoryRequests: memStore.requestCounts()");
  });
});

describe("wire.ts: bounded sessions, shed load (S3)", () => {
  it("the daemon's store publishes the retired list where the sessions' recall reads it", () => {
    expect(wire).toMatch(
      /openVikingStore\(memoryClient, \{[\s\S]*?onRetired: \(uris\) => \{\s*writeRetiredUris\(sessions\.ovRetiredPath\(\), uris,/,
    );
  });

  it("…starting from the list the last daemon published, so a warming-up first sweep wipes nothing", () => {
    expect(wire).toMatch(
      /openVikingStore\(memoryClient, \{[\s\S]*?initialRetired: readRetiredUrisFile\(sessions\.ovRetiredPath\(\)\),/,
    );
  });

  it("the TUI's ONE memory store publishes the companion tree's retired list into the state home the companion mounts", () => {
    const tui = readFileSync(join(process.cwd(), "src", "tui", "index.ts"), "utf8");
    expect(tui).toMatch(
      /const memStore = tuiMemoryStore\(\{\s*retiredFiles: \{ companion: join\(memStateHome\(\), COMPANION_MEMORY\.retiredFile\) \},\s*\}\);/,
    );
  });

  it("the reconcile pass's raw-tier sweep survives the daemon-origin wrap", () => {
    expect(wire).toMatch(
      /hooks\.sweepStaleOvSessions\s*\?\s*\{ sweepStaleOvSessions: \(\) => hooks\.sweepStaleOvSessions!\(\) \}/,
    );
  });
});

// the local English embedder. Unwired, the server would start
// with nothing on its api_base: every search and every new vector fails while
// the server itself looks up. The tripwire is structural, like the rest.
describe("wire.ts: the local English embedder is actually connected (S4)", () => {
  it("the embedder supervisor starts BEFORE the server, and gates the server's first start, bounded", () => {
    const embedderAt = wire.indexOf(
      "new LocalEmbedderSupervisor({ cfg: cfg.openviking, repoRoot: root, log })",
    );
    const serverAt = wire.indexOf("openviking = new OpenVikingSupervisor({");
    expect(embedderAt).toBeGreaterThan(0);
    expect(embedderAt).toBeLessThan(serverAt);
    expect(wire).toMatch(/localEmbedder\.start\(\);/);
    expect(wire).toMatch(
      /new OpenVikingSupervisor\(\{[\s\S]*?startGate: \{\s*open: \(\) => embedderForGate\.gateOpen\(\),\s*maxWaitMs: EMBEDDER_GATE_MAX_WAIT_MS,/,
    );
  });

  it("its block rides the heartbeat's openviking entry, beside the reembed journal", () => {
    expect(wire).toMatch(
      /openvikingStatus: \(\) => \{[\s\S]*?\.\.\.\(localEmbedder \? \{ embedder: localEmbedder\.status\(\) \} : \{\}\)/,
    );
  });

  // Review (S4): memory health's probe is an fs/ls, which needs no embedding —
  // unwired, a dead embedder read healthy while every search failed.
  it("memory health reads whether memory SERVES, from both supervisors", () => {
    expect(wire).toMatch(
      /new MemoryHealthMonitor\(\{[\s\S]*?serving: \(\) =>\s*memoryServing\(\s*cfg\.openviking\.embedding_provider,\s*openviking\?\.status\(\),\s*localEmbedder\?\.status\(\),\s*\)/,
    );
  });

  it("shutdown stops it after the server", () => {
    const stopServer = wire.indexOf("await openviking.stop();");
    const stopEmbedder = wire.indexOf("await localEmbedder.stop();");
    expect(stopServer).toBeGreaterThan(0);
    expect(stopEmbedder).toBeGreaterThan(stopServer);
  });
});

// the lesson shadow ledger — every slice below degrades silently
// (no selector ⇒ no ledger rows, no hook ⇒ no marks), so these are tripwires.
describe("wire.ts: the lesson shadow ledger is actually connected", () => {
  const daemon = readFileSync(join(process.cwd(), "src", "daemon.ts"), "utf8");

  it("the daemon is handed the late-bound selection hook and the findings matcher", () => {
    expect(wire).toMatch(/lessons: lateLessons,/);
    expect(wire).toMatch(/start: \(order, files\) => lessonSelector\?\.start\(order, files\)/);
    expect(wire).toMatch(
      /onFindingsRecorded: \(\{ pr, roundNo \}\) => \{[\s\S]*?markRound\(lessonLedger, daemon\.store, pr, roundNo\)/,
    );
    // …and the daemon passes both on: the hook to every dispatch pump, the
    // matcher to the verdict watcher's findings check.
    expect(daemon).toMatch(/\.\.\.\(deps\.lessons \? \{ lessons: deps\.lessons \} : \{\}\)/);
    expect(daemon).toMatch(
      /\.\.\.\(deps\.onFindingsRecorded \? \{ onFindingsRecorded: deps\.onFindingsRecorded \} : \{\}\)/,
    );
  });

  it("the selector reads the switch and the budget from config, through the OpenViking engine on its OWN client", () => {
    // Its own client: a find the round's budget aborts must never reach the
    // memory-health window or the counted gap (the shared client's
    // observers) — so the engine is never built on `memoryClient`.
    expect(wire).toMatch(
      /const lessonEngine = openVikingLessonEngine\(\s*lessonFindClient\(\{[^}]*apiKey: reviewerKey,[^}]*\}\),\s*memory,\s*\);/,
    );
    expect(wire).not.toMatch(/openVikingLessonEngine\(\s*memoryClient/);
    const lessonClientCall = /lessonFindClient\(\{[^}]*\}\)/.exec(wire)?.[0] ?? "";
    expect(lessonClientCall).not.toMatch(/onRequest|onGap|memoryHealth|countedGap/);
    expect(wire).toMatch(
      /new RoundLessonSelector\(\{\s*ledger: lessonLedger,\s*mode: \(\) => cfg\.memory\.delivery,\s*engine: \(\) => lessonEngine,\s*budgetMs: cfg\.memory\.delivery_budget_ms,/,
    );
    expect(wire).toMatch(/if \(cfg\.openviking\.enabled && cfg\.memory\.delivery !== "off"\)/);
  });

  it("the kill switch is wired to the ledger, and the headline reaches the memory status block", () => {
    expect(wire).toMatch(
      /lessonSwitch\(change, file\) \{[\s\S]*?lessonLedger\.apply\(change, file\)/,
    );
    expect(wire).toMatch(/base\.lessons = lessonStatusCache\.value;/);
    expect(wire).toMatch(/lessonDeliveryStatus\(lessonLedger, cfg\.memory\.delivery\)/);
  });
});
