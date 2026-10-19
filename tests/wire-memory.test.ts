// The production wiring of reviewer memory. Every slice
// below degrades SILENTLY and correctly when memory is absent — rounds render
// memory-less, the raw tier is skipped, the watchdog stands down — which is
// the behaviour we want at runtime and exactly what makes an unwired daemon
// invisible to every other test. These assertions are the tripwire: they fail
// if a refactor disconnects memory while leaving the suite green.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MEMORY_DEFAULTS, parseConfig } from "../src/config.js";
import { memoryStatusLine } from "../src/memory/health.js";
import { DEFAULT_CATEGORY } from "../src/openviking/store.js";
import { buildParts, migrationMemoryStatus, roundMemorySeed } from "../src/wire.js";

const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");

describe("wire.ts: the memory phase is actually connected", () => {
  it("the daemon is handed a round-memory seed built on the assembler", () => {
    expect(wire).toMatch(/\.\.\.roundMemorySeed\(cfg\.openviking\.enabled, \{\s*\n\s*assembler:/);
    expect(wire).toContain("openVikingContextAssembler");
  });

  it("memory switched off seeds no round and builds no pinned-area watchdog — off is not an outage", () => {
    const seed = { assembler: {} } as never;
    expect(roundMemorySeed(true, seed)).toEqual({ memory: seed });
    // No seed: dispatch renders the round memory-less without a read, so no
    // prompt says "MEMORY UNAVAILABLE" and no round records degraded memory.
    expect(roundMemorySeed(false, seed)).toEqual({});
    // The holders the round assembler and the EOD watchdog read are filled
    // only while memory is on; an empty sweep holder builds no watchdog.
    expect(wire).toMatch(
      /if \(cfg\.openviking\.enabled\) \{\s*memoryStore = memory;\s*memorySweep = memory;\s*memoryAssembler = openVikingContextAssembler\(/,
    );
    expect(wire).toMatch(/cfg\.eod\.pinned_watchdog && sweepSource\s*\?\s*startEodPinWatch/);
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

  it("the round context block searches experiences/ only — the default quotas name nothing else", () => {
    expect(MEMORY_DEFAULTS.context_quotas).toEqual({ experiences: 24 });
  });

  it("every round publishes its query as the PR session's recall hint", () => {
    expect(wire).toMatch(
      /publishQuery: \(pr: number, query: string\) => \{\s*writeRecallHint\(\s*sessions\.ovRecallHintPath\(prSessionName\(pr\)\),\s*\{ query, areas: ROUND_SEARCH_AREAS \}/,
    );
  });

  it("the EOD watchdog reads through the store that has the pinned-area read", () => {
    // `readPinnedFromSweep` prefers `pinnedSweep()` — the directory the round's
    // head reads — and the store handed to it has one.
    expect(wire).toMatch(/memorySweep = memory;/);
    expect(wire).toMatch(/readPinned: readPinnedFromSweep\(sweepSource\)/);
  });

  it("the round renderer receives the assembled seed", () => {
    // The owner name rides along so the pinned-head framing renders from
    // config; the profile-selected ecosystem rides along too, so a none
    // profile's prompts really carry no migration-gate prose; and the identity
    // variable map rides beside them.
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
    expect(wire).toMatch(/writeInbox:\s*pinWatch \? pinWatch\.wrapInject/);
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
    // `digest/<date>.md`. A readiness probe on state/digest/ would never see
    // it, so the watch would never close early and would run its whole window.
    expect(wire).toContain('latestDigestHeadline(join(root, "digest"))');
    expect(wire).toMatch(
      /digestReady:\s*\(date\)\s*=>\s*digestWritten\(date, join\(root, "digest"\)\)/,
    );
    expect(wire).not.toMatch(/"state",\s*"digest"/);
  });
});

// Memory failures reach a person. Like everything above, this
// wiring degrades silently when disconnected (no block, no wake, no banner),
// so the tripwire is structural.
describe("wire.ts: reviewer-memory health is actually connected", () => {
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
    // The block is the monitor's status plus the [feedback]
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

describe("tui/index.ts: memory failures reach the operator", () => {
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

  it("an EOD curation incident files the same way, with its own memo", () => {
    expect(tui).toMatch(
      /maybeFileCurationIncident\(incidentTracker, a\.view\.snapshot\?\.memory, \{[\s\S]{0,200}?afterMs: full\.memory\.incident_ticket_after_min \* 60_000,\s*memo: curationMemo,/,
    );
  });

  it("the companion's view carries the TUI's own request counts", () => {
    expect(tui).toContain("tuiMemoryRequests: memStore.requestCounts()");
  });
});

describe("wire.ts: bounded sessions, shed load", () => {
  it("the daemon's store publishes the retired list where the sessions' recall reads it, returning the write's result so a failed one is retried", () => {
    expect(wire).toMatch(
      /openVikingStore\(memoryClient, \{[\s\S]*?onRetired: \(uris\) =>\s*writeRetiredUris\(sessions\.ovRetiredPath\(\), uris,/,
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
});

// The local English embedder. Unwired, the server would start
// with nothing on its api_base: every search and every new vector fails while
// the server itself looks up. The tripwire is structural, like the rest.
describe("wire.ts: the local English embedder is actually connected", () => {
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

  // Memory health's probe is an fs/ls, which needs no embedding — unwired, a
  // dead embedder would read healthy while every search failed.
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

// The lesson shadow ledger — every slice below degrades silently
// (no selector ⇒ no ledger rows, no hook ⇒ no marks), so these are tripwires.
describe("wire.ts: the lesson shadow ledger is actually connected", () => {
  const daemon = readFileSync(join(process.cwd(), "src", "daemon.ts"), "utf8");

  it("the daemon is handed the late-bound selection hook and the findings matcher", () => {
    expect(wire).toMatch(/lessons: lateLessons,/);
    expect(wire).toMatch(/start: \(order, files\) => lessonSelector\?\.start\(order, files\)/);
    // MUTATION: replace wire's completeRecordedFindings(...) reader with
    // Promise.resolve(...), or remove the helper's markRound(...) reader.
    // Either disconnect must fail despite both imports/declarations remaining.
    expect(wire).toMatch(
      /onFindingsRecorded: \(target\) =>\s*completeRecordedFindings\(\s*\{\s*store: daemon\.store,\s*ledger: lessonLedger,[\s\S]*?\},\s*target,/,
    );
    const findingsConsumer = readFileSync(
      join(process.cwd(), "src", "recordedfindings.ts"),
      "utf8",
    );
    expect(findingsConsumer).toMatch(/const \{ pr, roundNo \} = target;/);
    expect(findingsConsumer).toMatch(/markRound\(deps\.ledger, deps\.store, pr, roundNo\)/);
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
    // The budget follows the mode — the selector is handed the shadow budget
    // too, and opens its windows on the one round-activity
    // tracker the case writer yields to.
    expect(wire).toMatch(
      /budgetMs: cfg\.memory\.delivery_budget_ms,[\s\S]{0,240}?shadowBudgetMs: cfg\.memory\.shadow_budget_ms,\s*activity: roundActivity,/,
    );
    expect(wire).toMatch(/if \(cfg\.openviking\.enabled && cfg\.memory\.delivery !== "off"\)/);
  });

  it("shutdown CUTS the shadow selections and waits only for an awaited one's ≤ 2 s budget — never the shadow budget (docker's 10 s stop grace)", () => {
    const stop = /async onStop\(reason = "shutdown"\) \{[\s\S]*?\n {4}\},\n/.exec(wire)?.[0] ?? "";
    expect(stop).not.toBe("");
    // stop() first, then the bounded wait — and both before the server goes.
    expect(stop).toMatch(
      /selector\.stop\(\);\s*await Promise\.race\(\[\s*selector\.idle\(\),\s*new Promise<void>\(\(r\) => setTimeout\(r, cfg\.memory\.delivery_budget_ms \+ 500\)/,
    );
    expect(stop).not.toMatch(/setTimeout\([^;]*shadow_budget_ms/);
    expect(stop.indexOf("selector.stop()")).toBeLessThan(stop.indexOf("openviking.stop()"));
  });

  it("shutdown stops the EOD pinned-area watchdog before the server goes", () => {
    const stop = /async onStop\(reason = "shutdown"\) \{[\s\S]*?\n {4}\},\n/.exec(wire)?.[0] ?? "";
    expect(stop).toMatch(/pinWatch\?\.stop\(\);/);
    expect(stop.indexOf("pinWatch?.stop()")).toBeLessThan(stop.indexOf("openviking.stop()"));
  });

  it("the kill switch is wired to the ledger, and the headline reaches the memory status block", () => {
    expect(wire).toMatch(
      /lessonSwitch\(change, file\) \{[\s\S]*?lessonLedger\.apply\(change, file\)/,
    );
    expect(wire).toMatch(/base\.lessons = lessonStatusCache\.value;/);
  });
});

// Delivery — each slice below degrades silently (a hook method
// not forwarded ⇒ dispatch never delivers; an addendum not composed ⇒ the
// validator never learns `lesson-shape`), so these are tripwires too.
describe("wire.ts: lesson delivery is actually connected", () => {
  const daemon = readFileSync(join(process.cwd(), "src", "daemon.ts"), "utf8");

  it("the late-bound hook forwards delivering, select and repoFacts to the selector", () => {
    expect(wire).toMatch(/delivering: \(\) => lessonSelector\?\.delivering\(\) \?\? false,/);
    expect(wire).toMatch(
      /select: \(order, files, opts\) =>\s*lessonSelector\?\.select\(order, files, opts\) \?\? Promise\.resolve\(null\),/,
    );
    // A round discarded before its handoff drops its selection record.
    expect(wire).toMatch(/discard: \(roundId\) => lessonSelector\?\.discard\(roundId\),/);
    expect(wire).toMatch(
      /repoFacts: \(q\) => lessonSelector\?\.repoFacts\(q\) \?\? Promise\.resolve\(""\),/,
    );
    expect(wire).toMatch(/new RoundLessonSelector\(\{[\s\S]*?repo: cfg\.github\.repo,/);
  });

  it("the agents build composes the validator's lesson addendum BESIDE the feedback one, from the switch and the kill switch", () => {
    // The ledger (the kill switch) exists before the first build.
    expect(wire.indexOf("lessonLedger = new LessonLedger(d.store);")).toBeGreaterThan(-1);
    expect(wire.indexOf("lessonLedger = new LessonLedger(d.store);")).toBeLessThan(
      wire.indexOf("const agentsDay = dayScopedRebuild("),
    );
    // The composition rule itself (the kill switch read from the ledger) is
    // pinned behaviourally in tests/lesson-delivery.test.ts
    // (`lessonAddendaFor`); here, that the build calls it with the ledger.
    expect(wire).toMatch(
      /const lessonAdd = lessonAddendaFor\(cfg\.memory\.delivery, lessonLedger\);/,
    );
    expect(wire).toMatch(
      /\.\.\.postingPolicyAddenda\(cfg\.posting\),[\s\S]*?\.\.\.lessonAdd,\s*\.\.\.\(fb \? \[fb\] : \[\]\),/,
    );
  });

  it("flipping the kill switch rebuilds the agents (the feedback addendum's rebuild-on-change)", () => {
    expect(wire).toMatch(
      /lessonSwitch\(change, file\) \{[\s\S]*?if \(r\.changed && \(change\.action === "off" \|\| change\.action === "on"\)\) \{\s*try \{\s*rebuildAgents\(\);/,
    );
  });

  it("the daemon hands the repo facts to the recheck nudge and the ping-pong wake", () => {
    expect(daemon).toMatch(/repoFacts: \(q: [^)]*\) => repoFactsFor\(q\)/);
    // The ping-pong path is `serveAuthorReply`, driven behaviourally in
    // tests/lesson-delivery.test.ts; here, that the daemon hands it the facts.
    expect(daemon).toMatch(
      /onAuthorReply: async \(reply\) => \{\s*await serveAuthorReply\(\s*\{[\s\S]*?\.\.\.\(deps\.lessons\?\.repoFacts \? \{ repoFacts: repoFactsFor \} : \{\}\),[\s\S]*?reply,\s*\);/,
    );
    expect(wire).toMatch(
      /lessonDeliveryStatus\(lessonLedger, cfg\.memory\.delivery, \{\s*selecting: lessonSelector !== null,\s*\}\)/,
    );
  });
});

it("a failed boot migration disables every assembled memory consumer without changing operator config", () => {
  const loaded = parseConfig(
    readFileSync(join(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
  );
  expect(loaded.openviking.enabled).toBe(true);
  vi.stubEnv("QCR_OPENVIKING_BOOT_DISABLED", "1");
  try {
    const parts = buildParts(process.cwd(), loaded);
    expect(parts.cfg.openviking.enabled).toBe(false);
    expect(parts.sessions.cfg.openviking.enabled).toBe(false);
    expect(parts.memoryBootFailure).toMatch(/migration.*incomplete/i);
    const status = migrationMemoryStatus(parts.memoryBootFailure!);
    expect(status).toMatchObject({
      enabled: true,
      state: "down",
      last_error: { code: "migration_incomplete" },
      serving: { ok: false },
    });
    expect(memoryStatusLine(status)).toMatch(/DOWN.*migration.*incomplete/i);
    // MUTATION: remove the parts.memoryBootFailure branch from memoryStatus — this fails.
    expect(wire).toMatch(
      /memoryStatus:.*[\s\S]*?migrationMemoryStatus\(parts\.memoryBootFailure, memoryBootAt\)/,
    );

    expect(loaded.openviking.enabled).toBe(true);
    expect(parts.cfg.dry_run).toBe(loaded.dry_run);
  } finally {
    vi.unstubAllEnvs();
  }
});
