// Cache groups for SDK lens passes. The real pi SDK on pi-ai's faux
// provider (no model, no network). A faux response plays the provider's part: it
// opens a fake transport socket under the request's session id and runs the
// request payload through pi's before_provider_request hook (onPayload), as the
// codex provider does, so the leaf-cache extension sees what it would see live.
//
// Pinned: a group shares one session id and its payload key; one pass finishing
// never ends a sibling's stream (the lifetime test); the warm-up takes no
// permit, comes before the group and is released after 30 s; a pack-less group
// staggers; sessions are created a gap apart; and the pack is for one API
// family (PACK_FIRST_APIS): a group whose model speaks another API gets no
// warm-up, no wait and no rewrite.
//
// The passes run on a faux provider whose model says it speaks an API of that
// family (`family`), as a codex model does; `outside` is one that does not.
// pi-ai's faux provider answers by provider, whatever API its model names, so
// the name decides nothing but what the runner reads off it.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { AgentSession, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { CACHE_GROUP_MAX_IDLE_MS } from "@quickchatai/pi-quickreview/src/engine/lens/cache-group.js";
import {
  CacheGroups,
  WARMUP_ATTEMPTS,
  WARMUP_REPLY_TASK,
  cacheGroupKey,
  settledWithin,
} from "@quickchatai/pi-quickreview/src/engine/lens/cache-run.js";
import {
  PACK_FIRST_APIS,
  isPackFirstApi,
  leafCache,
  packFirstPayload,
} from "@quickchatai/pi-quickreview/src/engine/lens/leaf-cache.js";
import { loadBuiltAgents } from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import {
  createLensRunner,
  type LensRunConfig,
} from "@quickchatai/pi-quickreview/src/engine/lens/runlens.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { parseLedger } from "@quickchatai/pi-quickreview/src/lensresult.js";
import { MEASURED } from "@quickchatai/pi-quickreview/src/measured.js";
import { routableFaux } from "./helpers/priced-faux.js";
import {
  FakeTransport,
  createHostRig,
  useOfflineGuard,
  waitFor,
  type HostRig,
} from "./pi-canary/harness.js";

useOfflineGuard();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let rig: HostRig;
/** The provider the passes run on: its model speaks an API of the pack-first family. */
let family: FauxProviderHandle;
/** A provider whose model speaks an API outside the family. */
let outside: FauxProviderHandle;
let dir: string;
let sessions: AgentSession[];
let createdAt: number[];
let unhandled: unknown[];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

const FAMILY_MODEL = "faux-family/faux-1";
const OUTSIDE_MODEL = "faux-outside/faux-1";

/** A built agent file. `model` null: an unpinned tier's, with no `model:` line. */
const agentFile = (name: string, tools: string, model: string | null = FAMILY_MODEL): string =>
  `---\nname: ${name}\ndescription: ${name} lens\n${model === null ? "" : `model: ${model}\n`}tools: ${tools}\n---\nYou are ${name}. Report findings.\n`;

beforeEach(async () => {
  family = fauxProvider({ api: "openai-codex-responses", provider: "faux-family" });
  outside = fauxProvider({ api: "anthropic-messages", provider: "faux-outside" });
  rig = await createHostRig({
    configureModels: (runtime) => {
      runtime.registerNativeProvider(family.provider);
      runtime.registerNativeProvider(outside.provider);
    },
  });
  dir = mkdtempSync(join(tmpdir(), "lens-cache-"));
  mkdirSync(join(dir, "agents"));
  writeFileSync(join(dir, "agents", "pass-a.md"), agentFile("pass-a", "read, bash"));
  writeFileSync(join(dir, "agents", "pass-b.md"), agentFile("pass-b", "read, bash"));
  writeFileSync(join(dir, "agents", "pass-c.md"), agentFile("pass-c", "read, bash"));
  for (const name of ["pass-x", "pass-y", "pass-z"])
    writeFileSync(join(dir, "agents", `${name}.md`), agentFile(name, "read, bash", OUTSIDE_MODEL));
  for (const name of ["pass-free", "pass-free-b"])
    writeFileSync(join(dir, "agents", `${name}.md`), agentFile(name, "read, bash", null));
  sessions = [];
  createdAt = [];
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  const real = rig.host.makeSession.bind(rig.host);
  vi.spyOn(rig.host, "makeSession").mockImplementation(async (spec) => {
    createdAt.push(Date.now());
    const s = await real(spec);
    sessions.push(s);
    return s;
  });
});

afterEach(async () => {
  await sleep(20);
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
  rig.close();
  rmSync(dir, { recursive: true, force: true });
  expect(unhandled, "no unhandled rejection escaped a lens").toEqual([]);
});

const guard = (): ExtensionFactory =>
  createBashGuard({ sandboxRoot: dir, replay: false, secretDirs: [] });

function config(over: Partial<LensRunConfig> = {}): LensRunConfig {
  return {
    host: rig.host,
    permits: 8,
    registry: loadBuiltAgents(join(dir, "agents")),
    cwd: dir,
    env: { PATH: process.env["PATH"], HOME: dir },
    bashGuard: guard(),
    leafTools: () => [],
    ledgerPath: join(dir, "round", "lens-ledger.jsonl"),
    sessionGapMs: 0,
    ...over,
  };
}

const ledger = () => parseLedger(readFileSync(join(dir, "round", "lens-ledger.jsonl"), "utf8"));

const PACK = "PR CONTEXT PACK: the diff and the files.";

/** One request as the provider sees it. */
interface Seen {
  sessionId: string | undefined;
  /** The user text of the turn: "Task: …". */
  task: string;
  /** The payload after pi's before_provider_request hook ran. */
  payload: Record<string, unknown>;
  at: number;
}

/**
 * A faux provider reply that behaves like a codex request: it opens a socket
 * under the session id, builds a payload shaped like the codex one (the real
 * system prompt, the real input, the session id as the cache key), runs it
 * through pi's hook, and answers after `work`.
 */
function codexLike(
  seen: Seen[],
  transport: FakeTransport,
  work: (s: Seen, o: SimpleStreamOptions | undefined) => Promise<void> = async () => {},
  /** Changes to the request before pi's hook sees it. */
  dress: {
    raw?: (raw: Record<string, unknown>, task: string) => Record<string, unknown>;
  } = {},
) {
  return async (
    c: TranscriptContext,
    o: SimpleStreamOptions | undefined,
    _state?: unknown,
    model?: unknown,
  ) => {
    transport.open(o?.sessionId);
    const last = c.messages[c.messages.length - 1];
    const content = (last?.content ?? []) as unknown;
    const task = Array.isArray(content)
      ? content.map((part: { text?: string }) => part.text ?? "").join("")
      : String(content);
    // The transcript carries no system prompt; it is the one of the session
    // asking, found by its id and the task it was just sent.
    const system =
      sessions.find(
        (x) =>
          x.sessionId === o?.sessionId &&
          JSON.stringify(x.messages).includes(JSON.stringify(task).slice(1, -1)),
      )?.systemPrompt ?? "";
    const built: Record<string, unknown> = {
      model: "gpt-6.1-sol",
      instructions: system,
      input: c.messages.map((m) => ({
        role: m.role,
        content: [{ type: "input_text", text: JSON.stringify(m.content) }],
      })),
      prompt_cache_key: o?.sessionId,
    };
    const raw = dress.raw?.(built, task) ?? built;
    const hooked = (await o?.onPayload?.(raw, model as never)) ?? raw;
    const entry: Seen = {
      sessionId: o?.sessionId,
      task,
      payload: hooked as Record<string, unknown>,
      at: Date.now(),
    };
    seen.push(entry);
    await work(entry, o);
    return fauxAssistantMessage(`ok ${seen.length}`);
  };
}

const respondWith = (
  n: number,
  reply: ReturnType<typeof codexLike>,
  on: FauxProviderHandle = family,
): void => on.setResponses(Array.from({ length: n }, () => reply));

describe("leafCache (the extension)", () => {
  it("rewrites pack-first and sets the cache key to the group's; fail-open on anything else", () => {
    const handlers: Array<(e: { payload?: unknown }) => unknown> = [];
    const pi = { on: (_: string, h: (e: { payload?: unknown }) => unknown) => handlers.push(h) };
    void leafCache({ pack: PACK, cacheKey: "group-key", body: "LENS BODY" })(pi as never);
    const out = handlers[0]!({
      payload: {
        instructions: "base prompt\n\n<addendum>\nLENS BODY\n</addendum>",
        input: [{ role: "user", content: [{ type: "input_text", text: "Task: x" }] }],
        prompt_cache_key: "own-session-id",
      },
    }) as Record<string, unknown>;
    expect(out["prompt_cache_key"]).toBe("group-key");
    expect(out["instructions"]).toBe("base prompt");
    // The pack, the message that closes it, the lens body, the task.
    expect((out["input"] as Array<{ role: string }>).map((m) => m.role)).toEqual([
      "user",
      "user",
      "developer",
      "user",
    ]);
    // Not the expected shape: the payload goes out as it came (undefined = unchanged).
    expect(handlers[0]!({ payload: { messages: [] } })).toBeUndefined();
    expect(handlers[0]!({ payload: null })).toBeUndefined();
    // A payload already on the group's key and not rewritable is left alone.
    expect(handlers[0]!({ payload: { prompt_cache_key: "group-key" } })).toBeUndefined();
    // A blank pack installs nothing.
    const none: unknown[] = [];
    void leafCache({ pack: "  ", cacheKey: "k" })({ on: () => none.push(1) } as never);
    expect(none).toEqual([]);
  });

  it("the warm-up (no body) and a lens request share the pack-first prefix", () => {
    const base = "base prompt";
    const input = [{ role: "user", content: [{ type: "input_text", text: "Task: x" }] }];
    const warm = packFirstPayload({ instructions: base, input }, "", PACK) as Record<
      string,
      unknown
    >;
    const lens = packFirstPayload(
      { instructions: `${base}\n\n<addendum>\nBODY\n</addendum>`, input },
      "BODY",
      PACK,
    ) as Record<string, unknown>;
    expect(warm["instructions"]).toBe(lens["instructions"]);
    expect((warm["input"] as unknown[])[0]).toEqual((lens["input"] as unknown[])[0]);
  });
});

describe("[cache groups] one shared session id per group", () => {
  it("passes of a group share the id and payload key; the next group and a cache-less pass differ", async () => {
    const seen: Seen[] = [];
    const transport = new FakeTransport();
    respondWith(5, codexLike(seen, transport));
    const runner = createLensRunner(
      config({ cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 } }),
    );
    const runs = await Promise.all(
      ["pass-a", "pass-b", "pass-c"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(runs.every((r) => r.result.exitCode === 0)).toBe(true);
    const lens = sessions.filter((s) => s.systemPrompt.includes("Report findings."));
    expect(lens).toHaveLength(3);
    const [g1a, g1b, g2] = lens.map((s) => s.sessionId) as [string, string, string];
    expect(g1a).toBe(g1b);
    expect(g2).not.toBe(g1a);
    // Every request's payload key is its group's key, and every lens request was packed.
    for (const s of seen) expect(s.payload["prompt_cache_key"]).toBe(s.sessionId);
    const packed = seen.filter((s) => JSON.stringify(s.payload["input"]).includes("PR CONTEXT"));
    expect(packed).toHaveLength(seen.length);
  });

  it("without groups every pass keeps an id of its own", async () => {
    const seen: Seen[] = [];
    respondWith(3, codexLike(seen, new FakeTransport()));
    const runner = createLensRunner(config());
    await Promise.all(
      ["pass-a", "pass-b", "pass-c"].map((agent) => runner.run({ agent, task: "t" })),
    );
    expect(new Set(sessions.map((s) => s.sessionId)).size).toBe(3);
    expect(seen.every((s) => !JSON.stringify(s.payload["input"]).includes("PR CONTEXT"))).toBe(
      true,
    );
  });
});

describe("[cache telemetry] what a packed group's runs say of their first request", () => {
  const packed = (over: Partial<LensRunConfig> = {}) =>
    config({ cache: { size: 3, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 }, ...over });
  const isWarmup = (task: string): boolean => task.includes(WARMUP_REPLY_TASK);

  // MUTATION: leave `cacheFacts` unset in attemptsOf and warmUp (runlens.ts) —
  // the lines carry no group, first turn or hashes; this fails.
  it("every ledger line carries its group, its first turn and hashes of its first request, never the pack", async () => {
    respondWith(3, codexLike([], new FakeTransport()));
    const said: string[] = [];
    const runner = createLensRunner(packed({ debug: (m) => said.push(m) }));
    await Promise.all(["pass-a", "pass-b"].map((agent) => runner.run({ agent, task: agent })));
    const lines = ledger();
    expect(lines.map((l) => l.kind).sort()).toEqual(["lens", "lens", "warmup"]);
    const warm = lines.find((l) => l.kind === "warmup")!;
    expect(warm.group).toMatch(/^[0-9a-f-]{36}$/);
    for (const line of lines) {
      expect(line.group).toBe(warm.group);
      expect(line.prefix).toMatch(/^other=[0-9a-f]{10} reasoning=[0-9a-f]{10} instructions=/);
      expect(line.prefix).toMatch(/ pack_at=0 tools_after_pack=0$/);
      // The faux provider's own count of the request: what the first turn sent.
      expect(
        line.turn1!.input + line.turn1!.cacheRead + (line.turn1!.cacheWrite ?? 0),
      ).toBeGreaterThan(0);
    }
    const text = readFileSync(join(dir, "round", "lens-ledger.jsonl"), "utf8");
    expect(text).not.toContain("PR CONTEXT PACK");
    expect(text).not.toContain("Report findings.");
    // And the group's own count, once its sessions are disposed.
    const size = warm.turn1!.input + warm.turn1!.cacheRead + (warm.turn1!.cacheWrite ?? 0);
    expect(
      said.filter((m) =>
        new RegExp(`^cache group ${warm.group}: turn1_hot=\\d/2 warmup_input=${size}$`).test(m),
      ),
    ).toHaveLength(1);
  });

  // MUTATION: count every first turn as hot in CacheLease.firstTurn
  // (cache-run.ts) — the second pass counts too; this fails.
  it("CacheGroups: a first turn is hot when it read nine tenths of what the warm-up sent", () => {
    const groups = new CacheGroups(3, 0, () => "k");
    const warm = groups.join("m", 0);
    // Before the warm-up's size is known nothing is counted.
    expect(warm.firstTurn({ input: 10, cacheRead: 990 })).toBeUndefined();
    warm.warmedInput(1000);
    expect(warm.firstTurn({ input: 60, cacheRead: 940 })).toBe(true);
    expect(warm.firstTurn({ input: 1100, cacheRead: 0 })).toBe(false);
    expect(warm.firstTurn({ input: 200, cacheRead: 899 })).toBe(false);
    warm.release();
    // A late pass joins the key after its first members are gone: the key's
    // facts are still there.
    const late = groups.join("m", 1);
    expect(late.key).toBe("k");
    expect(late.firstTurn({ input: 50, cacheRead: 960 })).toBe(true);
    expect(groups.factsOf("k")).toMatchObject({ turn1: 4, turn1Hot: 2, warmupInput: 1000 });
  });

  // The passes' requests must repeat the warm-up's up to the end of the pack;
  // a pi or a host that makes them differ leaves every lens cold, silently.
  // MUTATION: never call lease.differenceFromWarmup in attemptsOf (runlens.ts)
  // — no warning; this fails.
  it("a pass whose request does not extend the warm-up's is said once per group, with the part", async () => {
    respondWith(
      3,
      codexLike([], new FakeTransport(), undefined, {
        raw: (raw, task) => (isWarmup(task) ? raw : { ...raw, text: { verbosity: "high" } }),
      }),
    );
    const warnings: string[] = [];
    const runner = createLensRunner(packed({ warn: (m) => warnings.push(m), debug: () => {} }));
    await Promise.all(["pass-a", "pass-b"].map((agent) => runner.run({ agent, task: agent })));
    const told = warnings.filter((m) => m.includes("does not extend its warm-up"));
    expect(told).toHaveLength(1);
    expect(told[0]).toMatch(
      /^cache group \S+: the request of pass-[ab] does not extend its warm-up's \(it differs in other\)/,
    );
  });

  // The provider keeps a cache per thinking level, so a group holds one
  // level. A request that still reaches the provider at another level than
  // its warm-up's reads none of it, and the line says so.
  // MUTATION: drop the `reasoning` comparison from prefixDifference
  // (leaf-cache.ts) — no warning; this fails.
  it("a pass sent at another thinking level than its warm-up is said to differ in `reasoning`", async () => {
    respondWith(
      3,
      codexLike([], new FakeTransport(), undefined, {
        raw: (raw, task) => ({ ...raw, reasoning: { effort: isWarmup(task) ? "high" : "medium" } }),
      }),
    );
    const warnings: string[] = [];
    const runner = createLensRunner(packed({ warn: (m) => warnings.push(m), debug: () => {} }));
    await Promise.all(["pass-a", "pass-b"].map((agent) => runner.run({ agent, task: agent })));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/does not extend its warm-up's \(it differs in reasoning\)/);
  });
});

describe("[cache groups] one thinking level per group, one key per round", () => {
  const packed = (over: Partial<LensRunConfig> = {}) =>
    config({ cache: { size: 8, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 }, ...over });
  const levelAgent = (name: string, level: string): string =>
    `---\nname: ${name}\ndescription: ${name} lens\nmodel: ${FAMILY_MODEL}\nthinking: ${level}\ntools: read, bash\n---\nYou are ${name}. Report findings.\n`;

  // On the family's Responses API a lens reads nothing of a warm-up sent at
  // another thinking level (measured), so passes of two levels are two
  // groups, each warmed at its own.
  // MUTATION: pass no level to cacheGroupKey in execute (runlens.ts) — one
  // group, one warm-up, at the first pass's level; this fails.
  it("passes on one model and tool list at two thinking levels are two groups, each with its own warm-up", async () => {
    writeFileSync(join(dir, "agents", "pass-hi.md"), levelAgent("pass-hi", "high"));
    writeFileSync(join(dir, "agents", "pass-hi2.md"), levelAgent("pass-hi2", "high"));
    writeFileSync(join(dir, "agents", "pass-lo.md"), levelAgent("pass-lo", "low"));
    respondWith(5, codexLike([], new FakeTransport()));
    const runner = createLensRunner(packed());
    const runs = await Promise.all(
      ["pass-hi", "pass-lo", "pass-hi2"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(runs.map((r) => r.result.errorMessage)).toEqual([undefined, undefined, undefined]);
    const lines = ledger();
    expect(lines.filter((l) => l.kind === "warmup")).toHaveLength(2);
    const groupOf = (agent: string) => lines.find((l) => l.agent === agent)!.group;
    expect(groupOf("pass-hi")).toBe(groupOf("pass-hi2"));
    expect(groupOf("pass-lo")).not.toBe(groupOf("pass-hi"));
  });

  // A row that comes after its group's first wave (the validator, a retry)
  // reads the cache the wave left: it joins the key and starts no warm-up.
  // MUTATION: start a warm-up for every pass that finds none running in
  // groupReady (runlens.ts) — the late pass warms again; this fails.
  it("a pass that joins a warmed key late starts no warm-up of its own", async () => {
    respondWith(3, codexLike([], new FakeTransport()));
    const runner = createLensRunner(packed());
    expect((await runner.run({ agent: "pass-a", task: "first" })).result.exitCode).toBe(0);
    expect(runner.liveSessions()).toBe(0);
    expect((await runner.run({ agent: "pass-b", task: "late" })).result.exitCode).toBe(0);
    const lines = ledger();
    expect(lines.filter((l) => l.kind === "warmup")).toHaveLength(1);
    expect(new Set(lines.map((l) => l.group)).size).toBe(1);
  });

  // MUTATION: drop the `grouper.used` refresh in CacheGroups.join, or
  // `this.used(nowMs)` in CacheLease.release (cache-run.ts) — the late row
  // gets "k2"; this fails.
  it("CacheGroups: a group is in use while a pass runs and until its last release", () => {
    let n = 0;
    const groups = new CacheGroups(8, 0, () => `k${++n}`);
    const a = groups.join("m", 0);
    // `a` is still running five minutes on: the join finds the group in use.
    const b = groups.join("m", 5 * 60_000);
    expect(b.key).toBe("k1");
    a.release(5 * 60_000);
    b.release(8 * 60_000);
    // Counted from the last release, the group is not idle too long yet.
    const c = groups.join("m", 8 * 60_000 + CACHE_GROUP_MAX_IDLE_MS);
    expect(c.key).toBe("k1");
    c.release(8 * 60_000 + CACHE_GROUP_MAX_IDLE_MS);
    // Idle past the limit after that last release: afresh.
    expect(groups.join("m", 8 * 60_000 + 2 * CACHE_GROUP_MAX_IDLE_MS + 1).key).toBe("k2");
  });

  // The validator starts minutes after its round's first pass and seconds
  // after its last: it reads the cache the wave left.
  // MUTATION: `lease?.release()` with no clock in execute (runlens.ts) — the
  // late pass gets a new key and a second warm-up; this fails.
  it("a pass that starts long after the group's first pass, soon after its last, joins the key", async () => {
    let t = 0;
    respondWith(
      3,
      codexLike([], new FakeTransport(), async (s) => {
        // The first pass is still at work five minutes after the group began.
        if (s.task.includes("first")) t = 5 * 60_000;
      }),
    );
    const runner = createLensRunner(packed({ now: () => t }));
    expect((await runner.run({ agent: "pass-a", task: "first" })).result.exitCode).toBe(0);
    t = 8 * 60_000;
    expect((await runner.run({ agent: "pass-b", task: "late" })).result.exitCode).toBe(0);
    const lines = ledger();
    expect(lines.filter((l) => l.kind === "warmup")).toHaveLength(1);
    expect(new Set(lines.map((l) => l.group)).size).toBe(1);
  });

  // MUTATION: answer false from needsWarmup once the key had a first pass
  // (cache-run.ts) — a key whose warm-up failed is never warmed; this fails.
  it("CacheLease.needsWarmup: the first pass, and a later one only while the key was never warmed", async () => {
    const groups = new CacheGroups(8, 0, () => "k");
    const first = groups.join("m", 0);
    expect(first.needsWarmup()).toBe(true);
    // A warm-up that ran and failed: it says nothing of its size.
    await first.startWarmup(async () => {});
    first.release(1);
    const second = groups.join("m", 2);
    expect(second.key).toBe(first.key);
    expect(second.needsWarmup()).toBe(true);
    // One that ended well.
    let done!: () => void;
    const running = second.startWarmup(() => new Promise<void>((r) => (done = r)));
    const sibling = groups.join("m", 3);
    expect(sibling.needsWarmup()).toBe(false); // one is running: wait for it
    second.warmedInput(1000);
    done();
    await running;
    second.release(4);
    sibling.release(5);
    expect(groups.join("m", 6).needsWarmup()).toBe(false);
  });

  // A wave's rows queue behind the permit cap, so a row joins its key while
  // the rows before it still run. A warm-up that ended and warmed nothing is
  // then started again by the next row that joins, not only once the group
  // is empty; one that is running is waited for; and a key gets two.
  // MUTATION: keep the first warm-up's promise for the group's whole life
  // (`if (this.life.warmup !== undefined) return false` in needsWarmup,
  // cache-run.ts) — the row that joins beside a live pass starts none; this
  // fails.
  // MUTATION: drop the WARMUP_ATTEMPTS bound from needsWarmup — the third
  // row starts a third warm-up; this fails.
  it("CacheLease.needsWarmup: a warm-up that warmed nothing is started again beside a live pass, twice at most", async () => {
    const groups = new CacheGroups(8, 0, () => "k");
    const first = groups.join("m", 0);
    let fail!: () => void;
    const failing = first.startWarmup(() => new Promise<void>((r) => (fail = r)));
    const second = groups.join("m", 1);
    expect(second.needsWarmup()).toBe(false); // running: one at a time
    expect(second.warmup()).toBe(failing);
    fail();
    await failing;
    // `first` still runs; the warm-up ended and warmed nothing.
    expect(second.needsWarmup()).toBe(true);
    let ran = 0;
    const again = second.startWarmup(async () => {
      ran += 1;
    });
    expect(again).not.toBe(failing);
    await again;
    expect(ran).toBe(1);
    expect(WARMUP_ATTEMPTS).toBe(2);
    const third = groups.join("m", 2);
    expect(third.needsWarmup()).toBe(false);
    for (const lease of [first, second, third]) lease.release(3);
    // And not in a later life of the key either.
    expect(groups.join("m", 4).needsWarmup()).toBe(false);
  });
});

describe("[cache groups] keyed by model spec and tool list", () => {
  // The request's `tools` field is part of the cached prefix, so a group that
  // mixed tool lists would warm one list's prefix for the other's passes.
  // MUTATION: join the group by `on.spec` alone in execute (runlens.ts) —
  // pass-g joins pass-a's group, one warm-up serves both lists; this fails.
  it("passes on one model with different tools never share a group, and each group warms with its own tools", async () => {
    writeFileSync(join(dir, "agents", "pass-g.md"), agentFile("pass-g", "read, bash, grep"));
    respondWith(5, codexLike([], new FakeTransport()));
    const runner = createLensRunner(
      config({ cache: { size: 3, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 } }),
    );
    const runs = await Promise.all(
      ["pass-a", "pass-g", "pass-b"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(runs.every((r) => r.result.exitCode === 0)).toBe(true);
    const made = vi.mocked(rig.host.makeSession).mock.calls.map(([spec]) => spec);
    // three passes and two warm-ups
    expect(made).toHaveLength(5);
    const toolsById = new Map<string, Set<string>>();
    for (const spec of made) {
      const id = spec.sessionId ?? "";
      const lists = toolsById.get(id) ?? new Set<string>();
      lists.add((spec.tools ?? []).join(","));
      toolsById.set(id, lists);
    }
    expect(toolsById.size).toBe(2);
    for (const lists of toolsById.values()) expect(lists.size).toBe(1);
    expect([...toolsById.values()].map((l) => [...l][0]).sort()).toEqual([
      "read,bash",
      "read,bash,grep",
    ]);
    expect(ledger().filter((l) => l.kind === "warmup")).toHaveLength(2);
  });

  // MUTATION: return `spec` alone from cacheGroupKey (cache-run.ts) — this fails.
  it("cacheGroupKey: the spec and the tools in order; no allowlist is not an empty one", () => {
    const key = cacheGroupKey(FAMILY_MODEL, ["read", "bash"]);
    expect(key).toBe(cacheGroupKey(FAMILY_MODEL, ["read", "bash"]));
    expect(key).not.toBe(cacheGroupKey(FAMILY_MODEL, ["read", "bash", "state_explore"]));
    expect(key).not.toBe(cacheGroupKey(FAMILY_MODEL, ["bash", "read"]));
    expect(key).not.toBe(cacheGroupKey(OUTSIDE_MODEL, ["read", "bash"]));
    expect(cacheGroupKey(FAMILY_MODEL, undefined)).not.toBe(cacheGroupKey(FAMILY_MODEL, []));
  });

  // MUTATION: leave `level` out of the key in cacheGroupKey (cache-run.ts) — this fails.
  it("cacheGroupKey: a thinking level is part of the key when one is given, and none is no level", () => {
    const tools = ["read", "bash"];
    const key = cacheGroupKey(FAMILY_MODEL, tools);
    expect(cacheGroupKey(FAMILY_MODEL, tools, null)).toBe(key);
    expect(cacheGroupKey(FAMILY_MODEL, tools, undefined)).toBe(key);
    expect(cacheGroupKey(FAMILY_MODEL, tools, "high")).not.toBe(key);
    expect(cacheGroupKey(FAMILY_MODEL, tools, "high")).toBe(
      cacheGroupKey(FAMILY_MODEL, tools, "high"),
    );
    expect(cacheGroupKey(FAMILY_MODEL, tools, "high")).not.toBe(
      cacheGroupKey(FAMILY_MODEL, tools, "medium"),
    );
  });
});

describe("[cache groups] lifetime: dispose is group-scoped", () => {
  it("one pass finishing never ends a sibling's stream; the group is disposed together, after its last pass", async () => {
    const transport = new FakeTransport();
    transport.attach();
    try {
      let releaseB!: () => void;
      const gateB = new Promise<void>((r) => (releaseB = r));
      const seen: Seen[] = [];
      respondWith(
        2,
        codexLike(seen, transport, async (s) => {
          if (s.task.includes("slow")) await gateB;
        }),
      );
      const runner = createLensRunner(config({ cache: { size: 4, staggerMs: 0 } }));
      const a = runner.run({ agent: "pass-a", task: "quick" });
      const b = runner.run({ agent: "pass-b", task: "slow" });
      expect((await a).result.exitCode).toBe(0);
      await waitFor(() => transport.sockets.length === 2, 4000, "B's socket");
      const key = sessions[0]!.sessionId;
      expect(sessions[1]!.sessionId).toBe(key);
      // A is done and read; B is still on the wire. Nothing was cleaned up.
      expect(transport.cleanups, "A's finish did not dispose the group's id").toEqual([]);
      expect(transport.isOpen(key), "B is still streaming").toBe(true);
      releaseB();
      expect((await b).text).toMatch(/^ok/);
      // The last pass is done: both sessions went together.
      expect(transport.cleanups).toEqual([key, key]);
      expect(transport.isOpen(key)).toBe(false);
      expect(runner.liveSessions()).toBe(0);
    } finally {
      transport.detach();
    }
  });

  it("a failed or aborted pass does not dispose its group either", async () => {
    const transport = new FakeTransport();
    transport.attach();
    try {
      let releaseB!: () => void;
      const gateB = new Promise<void>((r) => (releaseB = r));
      const seen: Seen[] = [];
      family.setResponses([
        codexLike(seen, transport, async (_s, o) => {
          await new Promise<void>((resolve) => {
            if (!o?.signal || o.signal.aborted) return resolve();
            o.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }),
        codexLike(seen, transport, async () => gateB),
      ]);
      const runner = createLensRunner(config({ cache: { size: 4, staggerMs: 0 } }));
      const stop = new AbortController();
      const a = runner.run({ agent: "pass-a", task: "a", signal: stop.signal });
      await waitFor(() => seen.length === 1, 4000, "A's request");
      const b = runner.run({ agent: "pass-b", task: "b" });
      await waitFor(() => seen.length === 2, 4000, "B's request");
      stop.abort();
      expect((await a).result.stopReason).toBe("aborted");
      expect(transport.cleanups).toEqual([]);
      expect(transport.isOpen(sessions[0]!.sessionId)).toBe(true);
      releaseB();
      await b;
      expect(transport.cleanups).toHaveLength(2);
    } finally {
      transport.detach();
    }
  });

  // A caller that names no debug sink (the daemon's botworker, the bench) keeps
  // the disposal line on its warn sink, where the pin's evidence is read.
  // MUTATION: make runlens's debug default `() => {}` instead of `warn` — this fails.
  it("with no debug sink, the group's disposal line goes to warn", async () => {
    respondWith(1, codexLike([], new FakeTransport()));
    const warnings: string[] = [];
    const runner = createLensRunner(
      config({ cache: { size: 2, staggerMs: 0 }, warn: (m) => warnings.push(m) }),
    );
    expect((await runner.run({ agent: "pass-a", task: "go" })).result.exitCode).toBe(0);
    expect(runner.liveSessions()).toBe(0);
    expect(
      warnings.filter((w) => /^pin-evidence cache-group-disposed key=\S+ sessions=1$/.test(w)),
    ).toHaveLength(1);
  });

  it("CacheGroups: sessions are disposed on the last release only, and a release is once", () => {
    const groups = new CacheGroups(2, 0, () => "k");
    const disposed: string[] = [];
    const mk = (n: string) => ({ dispose: () => void disposed.push(n) });
    const a = groups.join("m", 0);
    const b = groups.join("m", 0);
    a.keep(mk("a"));
    a.release();
    a.release();
    expect(disposed).toEqual([]);
    b.keep(mk("b"));
    b.release();
    expect(disposed).toEqual(["a", "b"]);
    expect(groups.liveGroups()).toBe(0);
  });
});

describe("[cache groups] the warm-up", () => {
  it("runs first, takes no permit, and the group's passes follow it; one ledger line of kind warmup", async () => {
    const seen: Seen[] = [];
    let warmEnd = 0;
    respondWith(
      4,
      codexLike(seen, new FakeTransport(), async (s) => {
        if (s.task.includes(WARMUP_REPLY_TASK)) {
          await sleep(60);
          warmEnd = Date.now();
        }
      }),
    );
    // One permit: a warm-up that needed one could not run beside the first pass.
    const runner = createLensRunner(
      config({ permits: 1, cache: { size: 3, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 } }),
    );
    const runs = await Promise.all(
      ["pass-a", "pass-b", "pass-c"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(runs.every((r) => r.result.exitCode === 0)).toBe(true);
    expect(seen).toHaveLength(4);
    // The warm-up's whole prompt is the message that closes the pack: its
    // request then ends where the shared prefix ends, and a lens extends it.
    // MUTATION: send the warm-up as `Task: ` + WARMUP_REPLY_TASK in warmUp
    // (runlens.ts) — its request ends in words of its own; this fails.
    expect(seen[0]!.task).toBe(WARMUP_REPLY_TASK);
    for (const s of seen.slice(1)) expect(s.at).toBeGreaterThanOrEqual(warmEnd);
    // The warm-up has no lens text and the pack first, on the group's id.
    expect(JSON.stringify(seen[0]!.payload["input"])).toContain("PR CONTEXT PACK");
    expect(seen[0]!.sessionId).toBe(seen[1]!.sessionId);
    expect(new Set(seen.map((s) => s.sessionId)).size).toBe(1);
    const lines = ledger();
    expect(lines.filter((l) => l.kind === "warmup")).toHaveLength(1);
    expect(lines.filter((l) => l.kind === "lens")).toHaveLength(3);
    expect(lines.find((l) => l.kind === "warmup")).toMatchObject({ exitCode: 0 });
  });

  it("a later group of the same model warms again; passes of one group never start a second warm-up", async () => {
    const seen: Seen[] = [];
    respondWith(5, codexLike(seen, new FakeTransport()));
    const runner = createLensRunner(
      config({ cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 } }),
    );
    await Promise.all(
      ["pass-a", "pass-b", "pass-c"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(ledger().filter((l) => l.kind === "warmup")).toHaveLength(2);
  });

  it("a warm-up still running after the wait releases the group", async () => {
    const seen: Seen[] = [];
    let releaseWarm!: () => void;
    const warmGate = new Promise<void>((r) => (releaseWarm = r));
    respondWith(
      2,
      codexLike(seen, new FakeTransport(), async (s) => {
        if (s.task.includes(WARMUP_REPLY_TASK)) await warmGate;
      }),
    );
    const warnings: string[] = [];
    const runner = createLensRunner(
      config({
        cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 150 },
        warn: (m) => warnings.push(m),
      }),
    );
    const started = Date.now();
    const run = runner.run({ agent: "pass-a", task: "go" });
    await waitFor(() => seen.length === 2, 4000, "the lens request, past the stuck warm-up");
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(seen[1]!.task).toContain("go");
    expect(warnings.some((w) => /still running after 150 ms/.test(w))).toBe(true);
    expect((await run).result.exitCode).toBe(0);
    releaseWarm();
    await waitFor(() => ledger().some((l) => l.kind === "warmup"), 4000, "the warm-up's line");
  });

  it("a lens request whose payload the pack-first rewrite cannot match is warned about once, naming the lens", async () => {
    const seen: Seen[] = [];
    const warm = codexLike(seen, new FakeTransport());
    const odd: typeof warm = async (c, o, st, model) => {
      const last = c.messages[c.messages.length - 1];
      const text = JSON.stringify(last?.content ?? "");
      if (text.includes(WARMUP_REPLY_TASK)) return warm(c, o, st, model);
      await o?.onPayload?.({ messages: [] }, model as never);
      await o?.onPayload?.({ messages: [] }, model as never);
      return fauxAssistantMessage("ok");
    };
    respondWith(2, odd);
    const warnings: string[] = [];
    const runner = createLensRunner(
      config({
        cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 },
        warn: (m) => warnings.push(m),
      }),
    );
    expect((await runner.run({ agent: "pass-a", task: "go" })).result.exitCode).toBe(0);
    const hits = warnings.filter((w) => /pass-a.*request shape not as expected/.test(w));
    expect(hits).toHaveLength(1);
  });

  it("a warm-up that fails costs the group nothing: its passes run, the failure is on the ledger", async () => {
    const seen: Seen[] = [];
    family.setResponses([
      () => {
        throw new Error("provider down");
      },
      codexLike(seen, new FakeTransport()),
    ]);
    const runner = createLensRunner(
      config({ cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 } }),
    );
    const run = await runner.run({ agent: "pass-a", task: "go" });
    expect(run.result.exitCode).toBe(0);
    const warm = ledger().find((l) => l.kind === "warmup");
    expect(warm).toMatchObject({ exitCode: 1, stopReason: "error" });
  });

  // A key whose warm-up failed was never warmed: the next pass that joins it
  // starts the warm-up again, and does not run on a cache that is not there.
  // MUTATION: mark the key warmed when its warm-up settles, whatever its end
  // (`lease.warmedInput(1)` after the catch in warmUp, runlens.ts) — the late
  // pass starts no warm-up; this fails.
  it("a pass that joins a key whose warm-up failed starts the warm-up again", async () => {
    const seen: Seen[] = [];
    const ok = codexLike(seen, new FakeTransport());
    family.setResponses([
      () => {
        throw new Error("provider down");
      },
      ok,
      ok,
      ok,
    ]);
    const runner = createLensRunner(
      config({ cache: { size: 8, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 } }),
    );
    expect((await runner.run({ agent: "pass-a", task: "first" })).result.exitCode).toBe(0);
    expect(runner.liveSessions()).toBe(0);
    expect((await runner.run({ agent: "pass-b", task: "late" })).result.exitCode).toBe(0);
    const lines = ledger();
    expect(lines.filter((l) => l.kind === "warmup").map((l) => l.exitCode)).toEqual([1, 0]);
    expect(new Set(lines.map((l) => l.group)).size).toBe(1);
  });

  // pi writes a request that failed as an assistant message with no usage. A
  // warm-up that ended so warmed nothing, and a lens whose first request
  // ended so has no first turn to report: not a turn that read nothing.
  // MUTATION: drop the stopReason test from firstTurnOf (runlens.ts) — the
  // failed warm-up counts as warmed and the late pass starts none, and the
  // failed lens is counted as a cold first turn; this fails.
  it("a request that failed is no first turn: a failed warm-up warms nothing, a failed lens is not counted cold", async () => {
    const failed = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" });
    const ok = codexLike([], new FakeTransport());
    // The warm-up fails, pass-a runs; then a second warm-up, and pass-b's request fails.
    family.setResponses([failed, ok, ok, failed]);
    const said: string[] = [];
    const runner = createLensRunner(
      config({
        cache: { size: 8, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 },
        debug: (m) => said.push(m),
      }),
    );
    expect((await runner.run({ agent: "pass-a", task: "first" })).result.exitCode).toBe(0);
    expect(runner.liveSessions()).toBe(0);
    expect((await runner.run({ agent: "pass-b", task: "late" })).result.exitCode).toBe(1);
    const lines = ledger();
    const warm = lines.filter((l) => l.kind === "warmup");
    expect(warm).toHaveLength(2);
    expect(warm[0]!.turn1).toBeUndefined();
    expect(warm[1]!.turn1).toBeDefined();
    expect(lines.find((l) => l.agent === "pass-b")!.turn1).toBeUndefined();
    // The group counted no first turn for the lens whose request failed.
    expect(said.filter((m) => /turn1_hot=\d+\/0 /.test(m)).length).toBeGreaterThan(0);
    expect(said.some((m) => /turn1_hot=\d+\/[1-9]/.test(m))).toBe(false);
  });

  // The warm-up is a session with tools, so it carries the guard like any pass.
  // MUTATION: drop config.bashGuard from the warm-up's extensions in warmUp
  // (runlens.ts) - this fails.
  it("the warm-up's session carries the bash guard first, as every pass's does", async () => {
    const marked = guard();
    respondWith(2, codexLike([], new FakeTransport()));
    const runner = createLensRunner(
      config({
        bashGuard: marked,
        cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 },
      }),
    );
    expect((await runner.run({ agent: "pass-a", task: "go" })).result.exitCode).toBe(0);
    await waitFor(() => ledger().some((l) => l.kind === "warmup"), 4000, "the warm-up's line");
    const made = vi.mocked(rig.host.makeSession).mock.calls.map(([spec]) => spec);
    // the pass and its group's warm-up
    expect(made).toHaveLength(2);
    for (const spec of made) expect(spec.extensions?.[0]).toBe(marked);
  });

  // MUTATION: drop `...config.leafTools(agent)` from the warm-up's extensions
  // in warmUp (runlens.ts) — the warm-up's spec lacks the marked factory; this fails.
  it("the warm-up's session carries its first pass's leaf tools, after the guard", async () => {
    const marked = guard();
    const leaf: ExtensionFactory = () => {};
    respondWith(2, codexLike([], new FakeTransport()));
    const runner = createLensRunner(
      config({
        bashGuard: marked,
        leafTools: () => [leaf],
        cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 },
      }),
    );
    expect((await runner.run({ agent: "pass-a", task: "go" })).result.exitCode).toBe(0);
    await waitFor(() => ledger().some((l) => l.kind === "warmup"), 4000, "the warm-up's line");
    const made = vi.mocked(rig.host.makeSession).mock.calls.map(([spec]) => spec);
    // the pass and its group's warm-up
    expect(made).toHaveLength(2);
    for (const spec of made) expect(spec.extensions?.slice(0, 2)).toEqual([marked, leaf]);
  });

  it("a caller's abort while the group warms ends the pass without waiting out the warm-up", async () => {
    let releaseWarm!: () => void;
    const warmGate = new Promise<void>((r) => (releaseWarm = r));
    const seen: Seen[] = [];
    respondWith(
      2,
      codexLike(seen, new FakeTransport(), async () => warmGate),
    );
    const runner = createLensRunner(
      config({ cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 60_000 } }),
    );
    const stop = new AbortController();
    const run = runner.run({ agent: "pass-a", task: "go", signal: stop.signal });
    await waitFor(() => seen.length === 1, 4000, "the warm-up's request");
    stop.abort();
    const out = await run;
    expect(out.result).toMatchObject({ exitCode: 1, stopReason: "aborted" });
    releaseWarm();
  });

  it("the warm-up's hard stop repeats its abort until the turn settles, as an ordinary pass does", async () => {
    let releaseWarm!: () => void;
    const warmGate = new Promise<void>((r) => (releaseWarm = r));
    const real = vi.mocked(rig.host.makeSession).getMockImplementation()!;
    let warmAborts = 0;
    vi.spyOn(rig.host, "makeSession").mockImplementation(async (spec) => {
      const s = await real(spec);
      if (spec.sessionId !== undefined && warmAborts === 0 && sessions.length === 1) {
        const abort = s.abort.bind(s);
        // The first aborts land before the agent runs: no-ops.
        s.abort = async () => {
          warmAborts += 1;
          if (warmAborts >= 3) {
            releaseWarm();
            await abort();
          }
        };
      }
      return s;
    });
    const seen: Seen[] = [];
    respondWith(
      2,
      codexLike(seen, new FakeTransport(), async (e) => {
        if (seen.length === 1) await warmGate;
        void e;
      }),
    );
    const runner = createLensRunner(
      config({ cache: { size: 2, staggerMs: 0, pack: PACK, warmupWaitMs: 50 } }),
    );
    await runner.run({ agent: "pass-a", task: "go" });
    await waitFor(
      () => ledger().some((l) => l.kind === "warmup"),
      4000,
      "the warm-up's ledger line",
    );
    expect(warmAborts).toBeGreaterThanOrEqual(3);
    releaseWarm();
  });

  it("liveSessions counts the passes streaming, not the group ids they share", async () => {
    const seen: Seen[] = [];
    let live = -1;
    let runner!: ReturnType<typeof createLensRunner>;
    respondWith(
      2,
      codexLike(seen, new FakeTransport(), async () => {
        await waitFor(() => seen.length === 2, 4000, "both passes streaming");
        live = Math.max(live, runner.liveSessions());
      }),
    );
    runner = createLensRunner(config({ cache: { size: 2, staggerMs: 0 } }));
    await Promise.all(["pass-a", "pass-b"].map((agent) => runner.run({ agent, task: agent })));
    expect(live).toBe(2);
    expect(runner.liveSessions()).toBe(0);
  });

  it("settledWithin reports who won and leaves no timer behind", async () => {
    expect(await settledWithin(Promise.resolve(), 10_000)).toBe(true);
    expect(await settledWithin(new Promise(() => {}), 20)).toBe(false);
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 10);
    expect(await settledWithin(new Promise(() => {}), 10_000, stop.signal)).toBe(false);
  });

  it("settledWithin counts a rejected promise as settled", async () => {
    expect(await settledWithin(Promise.reject(new Error("boom")), 10_000)).toBe(true);
  });
});

describe("[pack-first family] the pack is for its API family only", () => {
  const packedCache = { size: 3, staggerMs: 0, pack: PACK, warmupWaitMs: 5_000 };
  const isWarmup = (s: Seen): boolean => s.task.includes(WARMUP_REPLY_TASK);
  const hasPack = (s: Seen): boolean => JSON.stringify(s.payload).includes("PR CONTEXT PACK");

  // The outside provider answers with the request shape the rewrite matches,
  // so a hook attached to it by mistake would show in the payload.
  // MUTATION: make isPackFirstApi (leaf-cache.ts) return true for every api -
  // the anthropic-messages group gets a warm-up and this fails.
  it("a group whose model speaks another API gets no warm-up, no wait and no rewrite; it staggers, on one shared id", async () => {
    const seen: Seen[] = [];
    respondWith(4, codexLike(seen, new FakeTransport()), outside);
    const warnings: string[] = [];
    const runner = createLensRunner(
      config({ cache: { ...packedCache, staggerMs: 200 }, warn: (m) => warnings.push(m) }),
    );
    const t0 = Date.now();
    const runs = await Promise.all(
      ["pass-x", "pass-y", "pass-z"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(runs.map((r) => r.result.errorMessage)).toEqual([undefined, undefined, undefined]);
    // Three lens requests and three sessions, and nothing else: no warm-up.
    expect(seen).toHaveLength(3);
    expect(seen.filter(isWarmup)).toEqual([]);
    expect(sessions).toHaveLength(3);
    expect(ledger().filter((l) => l.kind === "warmup")).toHaveLength(0);
    // No rewrite hook: the pack is in no request, the lens text is where pi
    // put it, and no request was called unexpected.
    expect(seen.filter(hasPack)).toEqual([]);
    for (const s of seen) expect(s.payload["instructions"]).toContain("Report findings.");
    expect(warnings.filter((w) => /request shape|warm-up/.test(w))).toEqual([]);
    // The path of a round with no pack: later passes start after the stagger.
    for (const s of seen.slice(1)) expect(s.at - t0).toBeGreaterThanOrEqual(190);
    // The shared id stays, on every API.
    expect(new Set(seen.map((s) => s.sessionId)).size).toBe(1);
  });

  // MUTATION: keep one answer per runner in packedOn (runlens.ts) instead of
  // one per model - the second model's group takes the first one's answer,
  // gets a warm-up, and this fails.
  it("in one round, the family's group is packed and the other group is not", async () => {
    const inFamily: Seen[] = [];
    const outFamily: Seen[] = [];
    respondWith(3, codexLike(inFamily, new FakeTransport()));
    respondWith(3, codexLike(outFamily, new FakeTransport()), outside);
    const runner = createLensRunner(config({ cache: { ...packedCache, size: 2 } }));
    const runs = await Promise.all(
      ["pass-a", "pass-x", "pass-b", "pass-y"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(runs.map((r) => r.result.errorMessage)).toEqual(runs.map(() => undefined));
    expect(ledger().filter((l) => l.kind === "warmup")).toHaveLength(1);
    // The family's group: its warm-up and two lens requests, all pack-first.
    expect(inFamily.filter(isWarmup)).toHaveLength(1);
    expect(inFamily).toHaveLength(3);
    expect(inFamily.filter(hasPack)).toHaveLength(3);
    // The other group: its two lens requests, as pi built them.
    expect(outFamily).toHaveLength(2);
    expect(outFamily.filter(isWarmup)).toEqual([]);
    expect(outFamily.filter(hasPack)).toEqual([]);
    // Two groups, one id each.
    const ids = (seen: Seen[]): Set<string | undefined> => new Set(seen.map((s) => s.sessionId));
    expect(ids(inFamily).size).toBe(1);
    expect(ids(outFamily).size).toBe(1);
    expect([...ids(inFamily)][0]).not.toBe([...ids(outFamily)][0]);
  });

  // An unpinned tier's agent names no model: its group is the route's, and
  // what is read is the API of the model the host's route landed on.
  // MUTATION: answer undefined in apiOf (runlens.ts) for a pass with no model
  // of its own - the routed family group gets no warm-up and this fails.
  it.each([
    ["an API of the family: packed", "openai-codex-responses", 1],
    // A Responses API whose request has no `instructions`: the rewrite would
    // do nothing there, so the group is not packed and waits for no warm-up.
    ["a Responses API outside the family: not packed", "azure-openai-responses", 0],
    ["another API: not packed", "anthropic-messages", 0],
  ] as const)(
    "passes on the host's route follow the route's model, %s",
    async (_what, api, warmups) => {
      const faux = routableFaux({ api, provider: "faux-routed" });
      const host = await PiHost.create({
        agentDir: join(dir, "agent-routed"),
        authEnv: {},
        settings: { compaction: { enabled: false }, retry: { enabled: false } },
        configureModels: (runtime) => runtime.registerNativeProvider(faux.provider),
      });
      try {
        const real = host.makeSession.bind(host);
        vi.spyOn(host, "makeSession").mockImplementation(async (spec) => {
          const s = await real(spec);
          sessions.push(s);
          return s;
        });
        const seen: Seen[] = [];
        respondWith(3, codexLike(seen, new FakeTransport()), faux);
        const runner = createLensRunner(config({ host, cache: { ...packedCache, size: 2 } }));
        const runs = await Promise.all(
          ["pass-free", "pass-free-b"].map((agent) => runner.run({ agent, task: agent })),
        );
        expect(runs.map((r) => r.result.errorMessage)).toEqual([undefined, undefined]);
        expect(seen.filter(isWarmup)).toHaveLength(warmups);
        const lens = seen.filter((s) => !isWarmup(s));
        expect(lens).toHaveLength(2);
        expect(lens.filter(hasPack)).toHaveLength(warmups === 1 ? 2 : 0);
        expect(new Set(lens.map((s) => s.sessionId)).size).toBe(1);
      } finally {
        host.dispose();
      }
    },
  );

  it("an API the host could not name is not in the family", () => {
    expect(isPackFirstApi(undefined)).toBe(false);
    expect(isPackFirstApi("")).toBe(false);
    for (const api of PACK_FIRST_APIS) expect(isPackFirstApi(api), api).toBe(true);
  });

  // The names are pi's API names, checked against the catalog this pi ships:
  // an API no model speaks would turn the pack off for everyone, silently.
  // MUTATION: misspell an entry of PACK_FIRST_FAMILY in leaf-cache.ts past the
  // compiler (annotate the list `readonly string[]`) - this fails.
  it("every API of the family is one a model of pi's catalog speaks", () => {
    const spoken = new Set<string>(
      getBuiltinProviders()
        .flatMap((p) => getBuiltinModels(p as Parameters<typeof getBuiltinModels>[0]))
        .map((m) => m.api),
    );
    expect(PACK_FIRST_APIS.size).toBeGreaterThan(0);
    for (const api of PACK_FIRST_APIS) expect(spoken.has(api), api).toBe(true);
  });

  // The rewrite reads the system prompt off `instructions`, so an API whose
  // request pi builds without that field would be packed in name only: a
  // warm-up, a wait and a request sent unchanged.
  // MUTATION: add "openai-responses" to PACK_FIRST_FAMILY in leaf-cache.ts
  // (and to MEASURED.apis, to pass the fence below) - this fails.
  it("pi builds every API of the family with the system prompt in `instructions`", () => {
    for (const api of PACK_FIRST_APIS) {
      const built = readFileSync(
        join(process.cwd(), "node_modules/@earendil-works/pi-ai/dist/api", `${api}.js`),
        "utf8",
      );
      expect(/\binstructions\s*:/.test(built), api).toBe(true);
    }
  });

  // The measured estimate is fitted to runs the pack shaped, so it is true
  // where the pack applies and nowhere else.
  // MUTATION: add "anthropic-messages" to PACK_FIRST_FAMILY in leaf-cache.ts,
  // or drop an entry from MEASURED.apis in measured.ts - this fails.
  it("the measured estimate's APIs are the pack's: MEASURED.apis equals PACK_FIRST_APIS", () => {
    expect([...MEASURED.apis].sort()).toEqual([...PACK_FIRST_APIS].sort());
  });
});

describe("[cache groups] the pack-less stagger", () => {
  it("a later pass of a group starts after the stagger, an awaited delay; the first at once", async () => {
    const seen: Seen[] = [];
    respondWith(3, codexLike(seen, new FakeTransport()));
    const runner = createLensRunner(config({ cache: { size: 3, staggerMs: 200 } }));
    const t0 = Date.now();
    await Promise.all(
      ["pass-a", "pass-b", "pass-c"].map((agent) => runner.run({ agent, task: agent })),
    );
    expect(seen).toHaveLength(3);
    expect(seen[0]!.at - t0).toBeLessThan(150);
    for (const s of seen.slice(1)) expect(s.at - t0).toBeGreaterThanOrEqual(190);
    expect(ledger().filter((l) => l.kind === "warmup")).toHaveLength(0);
  });
});

describe("[stagger] session creation", () => {
  it("creates the sessions of a wave a gap apart", async () => {
    respondWith(6, codexLike([], new FakeTransport()));
    const runner = createLensRunner(config({ sessionGapMs: 40 }));
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 6 }, (_, i) => runner.run({ agent: "pass-a", task: `row ${i}` })),
    );
    expect(createdAt).toHaveLength(6);
    // The slots are scheduled at t0 + i*40 at the earliest. A late timer only
    // moves a session later, so measure each against the schedule, not against
    // its neighbour (a late timer makes the next gap look short under load).
    // Timers may fire a millisecond early; a wave never starts in a burst.
    createdAt.forEach((t, i) => expect(t - t0).toBeGreaterThanOrEqual(i * 40 - 5));
  });

  it("is shared by every runner on the host", async () => {
    respondWith(4, codexLike([], new FakeTransport()));
    const one = createLensRunner(config({ sessionGapMs: 40 }));
    const two = createLensRunner(config({ sessionGapMs: 40 }));
    const t0 = Date.now();
    await Promise.all([
      one.run({ agent: "pass-a", task: "1" }),
      two.run({ agent: "pass-b", task: "2" }),
    ]);
    expect(createdAt[1]! - t0).toBeGreaterThanOrEqual(35);
  });
});
