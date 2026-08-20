// Memory & learning tab (FT-0129): render, verbs, proposal verdicts, the
// companion request sweep. Fake stores/ssh throughout; the App is driven
// through its public hooks exactly as the real key router does.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import type { DigestFetcher } from "../src/tui/digesttab.js";
import { installMemoryLearningHooks, pinnedBudget, renderMemoryView, type MemTabState } from "../src/tui/memtab.js";
import { blockHash, parseMemory, type MemEditOp, type MemoryStore } from "../src/tui/memory.js";
import { parseMemRequest, processMemRequests } from "../src/tui/memrequests.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { RemoteResult } from "../src/tui/remote.js";

const SAMPLE = `<!-- 2026-08-19 18:13:54 [01a01ab3] -->
#false-positive #eod-learning lesson about merge bases.

#refuted lesson about External Apps.

<!-- 2026-08-20 09:01:42 [01a01b03] -->
#bug #operations [[stale-recheck]] stale recheck flag lingers on #5180.
`;

function fakeStreams() {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  let buf = "";
  (out as unknown as { columns: number }).columns = 110;
  (out as unknown as { rows: number }).rows = 30;
  out.write = ((s: string) => ((buf += s), true)) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  (input as unknown as { isTTY: boolean }).isTTY = false;
  input.resume = (() => input) as never;
  input.pause = (() => input) as never;
  return { out, input, written: () => buf };
}

class FakeMemory implements MemoryStore {
  applied: MemEditOp[] = [];
  constructor(private md: string = SAMPLE) {}
  read(): Promise<ReturnType<typeof parseMemory>> {
    return Promise.resolve(parseMemory(this.md));
  }
  apply(op: MemEditOp): Promise<{ ok: boolean; message: string }> {
    this.applied.push(op);
    return Promise.resolve({ ok: true, message: `ok: ${op.op}` });
  }
}

const fakeDigest: DigestFetcher = {
  list: () => Promise.resolve(["2026-08-19.md"]),
  read: () => Promise.resolve("# Review sandbox — 2026-08-19\n## Reviews\n- #5308 APPROVE"),
};

const okSsh = (_h: string, _argv: string[]): Promise<RemoteResult> => Promise.resolve({ ok: true, stdout: "", stderr: "", code: 0 });

function makeApp(): { app: App; written: () => string } {
  const { out, input, written } = fakeStreams();
  const app = new App(TUI_DEFAULTS, okSsh, out, input);
  app.tab = "digest";
  return { app, written };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

function install(app: App, mem: FakeMemory, extra: Parameters<typeof installMemoryLearningHooks>[1] = {}): MemTabState {
  return installMemoryLearningHooks(app, {
    memory: mem,
    digestFetcher: fakeDigest,
    fetchProposals: () =>
      Promise.resolve({
        proposals: [{ slug: "baseline-mergebase-2026-08-20", head: ["## Rationale", "3 refuted blockers"] }],
        improvements: [{ kind: "pr" as const, number: 12, title: "docs fix", state: "open" }],
      }),
    ...extra,
  });
}

describe("renderMemoryView", () => {
  it("shows timeline, proposals, improvements, defects", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    const screen = stripAnsi(app.hooks.digestScreen!(app, 110, 30));
    expect(screen).toContain("memory & learning");
    expect(screen).toContain("MEMORY (3)");
    expect(screen).toContain("RUBRIC PROPOSALS (1)");
    expect(screen).toContain("baseline-mergebase-2026-08-20");
    expect(screen).toContain("PR #12 [open]");
    expect(screen).toContain("DEFECT FLAGS (1)");
  });

  it("warns when pinned entries outgrow the injection head budget", () => {
    const entries = parseMemory(`<!-- 2026-08-20 08:00:00 [aa] -->\n#pinned ${"x".repeat(2000)}\n`);
    expect(pinnedBudget(entries).over).toBe(true);
    const st: MemTabState = {
      view: "memory",
      digest: { files: [], back: 0, scroll: 0, awaitingSelected: 0, loaded: true },
      entries,
      memLoaded: true,
      focus: "timeline",
      sel: 0,
      propSel: 0,
      scroll: 0,
      proposals: [],
      improvements: [],
      propLoaded: true,
      filedTotal: 0,
    };
    const screen = stripAnsi(renderMemoryView(st, false, undefined, 100, 24).render());
    expect(screen).toContain("⚠ pinned");
  });
});

describe("management verbs", () => {
  it("v toggles between digest and memory views", async () => {
    const { app } = makeApp();
    const st = install(app, new FakeMemory());
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    expect(st.view).toBe("digest");
    app.hooks.digestKey!(app, { kind: "char", ch: "v" });
    expect(st.view).toBe("memory");
  });

  it("retire needs x twice; the first only arms", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    expect(mem.applied).toHaveLength(0);
    expect(st.confirmRetire).toBeDefined();
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    await settle();
    expect(mem.applied).toHaveLength(1);
    expect(mem.applied[0]).toMatchObject({ op: "retire" });
  });

  it("any other key disarms a pending retire", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    app.hooks.digestKey!(app, { kind: "down", arrow: true });
    app.hooks.digestKey!(app, { kind: "char", ch: "x" });
    expect(mem.applied).toHaveLength(0); // re-armed on the new selection instead
  });

  it("p pins the selected (unpinned) entry with the right address", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "p" });
    await settle();
    const entries = parseMemory(SAMPLE);
    const newest = entries.find((e) => e.id === "01a01b03")!; // timeline floats newest first
    expect(mem.applied[0]).toMatchObject({ op: "pin", id: newest.id, ts: newest.ts, block: 0, expect: blockHash(newest.text) });
  });

  it("e opens a prefilled edit prompt; submit applies the edit", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "events" });
    expect(app.view.inputBox).toBeDefined();
    expect(app.view.inputBox!.text).toContain("stale recheck flag");
    // Submit through the real input path: append text + enter.
    const send = (s: string): void => (app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send(" AMENDED");
    send("\r");
    await settle();
    expect(mem.applied[0]).toMatchObject({ op: "edit" });
    expect((mem.applied[0] as { text: string }).text).toContain("AMENDED");
  });

  it("n prompts for a new manual entry", async () => {
    const { app } = makeApp();
    const mem = new FakeMemory();
    const st = install(app, mem);
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "n" });
    const send = (s: string): void => (app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send("never trust a resolved checkmark");
    send("\r");
    await settle();
    expect(mem.applied[0]).toMatchObject({ op: "add", text: "never trust a resolved checkmark" });
  });

  it("A accepts and R (with reason) rejects the selected proposal", async () => {
    const { app } = makeApp();
    const accept = vi.fn().mockResolvedValue({ ok: true, message: "accepted" });
    const reject = vi.fn().mockResolvedValue({ ok: true, message: "rejected" });
    const st = install(app, new FakeMemory(), { accept, reject });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    st.view = "memory";
    app.hooks.digestKey!(app, { kind: "char", ch: "t" }); // focus proposals
    app.hooks.digestKey!(app, { kind: "char", ch: "A" });
    await settle();
    expect(accept).toHaveBeenCalledWith(app, "baseline-mergebase-2026-08-20");
    app.hooks.digestKey!(app, { kind: "char", ch: "R" });
    const send = (s: string): void => (app as unknown as { handleInput(b: Buffer): void }).handleInput(Buffer.from(s));
    send("not evidence-backed");
    send("\r");
    await settle();
    expect(reject).toHaveBeenCalledWith(app, "baseline-mergebase-2026-08-20", "not evidence-backed");
  });

  it("auto-files #bug entries into the tracker on memory load", async () => {
    const root = mkdtempSync(join(tmpdir(), "memtab-tracker-"));
    mkdirSync(join(root, ".ids"), { recursive: true });
    mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
    writeFileSync(join(root, ".ids", "0100"), "x\n");
    const { app } = makeApp();
    install(app, new FakeMemory(), { tracker: { root, effort: "review-sandbox", parent: "FT-0026" } });
    app.hooks.digestScreen!(app, 110, 30);
    await settle();
    const tickets = readdirSync(join(root, "efforts/review-sandbox/tickets"));
    expect(tickets).toHaveLength(1);
    expect(readFileSync(join(root, "efforts/review-sandbox/tickets", tickets[0]!), "utf8")).toContain("by qcr-tui");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("companion memedit requests", () => {
  it("parses strict schemas and refuses garbage", () => {
    expect(parseMemRequest(JSON.stringify({ op: "add", text: "hello" }))).toMatchObject({ ok: true });
    expect(parseMemRequest(JSON.stringify({ op: "retire", id: "a", ts: "2026-08-20 09:01:42", block: 0, expect: "0123456789ab" }))).toMatchObject({ ok: true });
    expect(parseMemRequest(JSON.stringify({ op: "retire", id: "a", ts: "bad", block: 0, expect: "0123456789ab" }))).toMatchObject({ ok: false });
    expect(parseMemRequest(JSON.stringify({ op: "obliterate" }))).toMatchObject({ ok: false });
    expect(parseMemRequest("nope")).toMatchObject({ ok: false });
  });

  it("applies valid requests, records results, and archives to .done", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memreq-"));
    writeFileSync(join(dir, "001-add.json"), JSON.stringify({ op: "add", text: "companion lesson" }));
    writeFileSync(join(dir, "002-bad.json"), JSON.stringify({ op: "retire" }));
    const mem = new FakeMemory();
    const done = await processMemRequests(dir, mem);
    expect(done).toHaveLength(2);
    expect(mem.applied).toHaveLength(1);
    expect(mem.applied[0]).toMatchObject({ op: "add", text: "companion lesson" });
    expect(readdirSync(join(dir, ".done")).sort()).toEqual(["001-add.json", "002-bad.json"]);
    const badResult = JSON.parse(readFileSync(join(dir, "002-bad.result.json"), "utf8"));
    expect(badResult.ok).toBe(false);
    expect(badResult.message).toContain("refused");
    rmSync(dir, { recursive: true, force: true });
  });

  it("a missing dir is a quiet no-op", async () => {
    expect(await processMemRequests("/nonexistent/memedit", new FakeMemory())).toEqual([]);
  });
});

describe("quit vs late async repaints (ghost-frame regression)", () => {
  it("a load resolving after quit paints nothing onto the restored screen", async () => {
    const { app, written } = makeApp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowMemory: MemoryStore = {
      read: async () => {
        await gate;
        return parseMemory(SAMPLE);
      },
      apply: () => Promise.resolve({ ok: true, message: "ok" }),
    };
    install(app, slowMemory as FakeMemory);
    const running = app.run(); // installs streams, starts poller
    app.hooks.digestScreen!(app, 110, 30); // kicks the slow load
    app.quit();
    await running; // teardown done — terminal restored
    const at = written().length;
    release(); // the load resolves late and calls app.repaint()
    await settle();
    expect(written().length).toBe(at); // not one more byte on the normal screen
  });

  it("a late attach resume after quit also paints nothing", async () => {
    const { app, written } = makeApp();
    install(app, new FakeMemory());
    const running = app.run();
    app.quit();
    await running;
    const at = written().length;
    app.resume();
    app.notice("late notice");
    await settle();
    expect(written().length).toBe(at);
  });
});
