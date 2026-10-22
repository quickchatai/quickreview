// The board's detail pane for a PR that STAYS selected must follow the PR:
// a poll that proves the cached detail stale (head/state moved) or finds it
// past its TTL refetches it — the operator should not have to move away and
// back, or press `r`, to see the new round. And a slower, older `why` read
// must never overwrite a newer one in the per-PR cache.
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { App } from "../src/tui/app.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";

function snap(head: string, state = "reviewing"): StatusSnapshot {
  return {
    written_at: "2026-09-30T10:00:00Z",
    dry_run: false,
    prs: [
      {
        number: 5012,
        state,
        title: "t",
        head_sha: head,
        stale_recheck: false,
        rounds: 1,
        last_verdict: null,
      },
      {
        number: 5013,
        state: "queued",
        title: "u",
        head_sha: "fff",
        stale_recheck: false,
        rounds: 0,
        last_verdict: null,
      },
    ],
  } as unknown as StatusSnapshot;
}

function why(pr: number, head: string, tag: string, state = "reviewing"): string {
  return JSON.stringify({ pr, head_sha: head, state, title: tag, rounds: [], ledger: [] });
}

type Pending = { pr: number; resolve: (stdout: string) => void; fail: () => void };

function harness() {
  const out = new EventEmitter() as unknown as NodeJS.WriteStream;
  (out as unknown as { columns: number }).columns = 100;
  (out as unknown as { rows: number }).rows = 30;
  out.write = (() => true) as never;
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const whys: Pending[] = [];
  const ssh: SshRunner = (_host, argv) => {
    const i = argv.indexOf("why");
    if (i < 0) return Promise.resolve({ ok: false, stdout: "", stderr: "", code: 1 });
    const pr = Number(argv[i + 1]);
    return new Promise((res) =>
      whys.push({
        pr,
        resolve: (stdout) => res({ ok: true, stdout, stderr: "", code: 0 }),
        fail: () => res({ ok: false, stdout: "", stderr: "boom", code: 1 }),
      }),
    );
  };
  const app = new App(TUI_DEFAULTS, ssh, out, input);
  const a = app as unknown as { onPoll(): void };
  const poll = (s: StatusSnapshot) => {
    app.poller.state.snapshot = s;
    a.onPoll();
  };
  return { app, whys, poll };
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => vi.restoreAllMocks());

describe("App detail refresh", () => {
  it("refetches the SELECTED PR's detail once a poll proves its cache stale (head moved)", async () => {
    const h = harness();
    h.poll(snap("aaa"));
    expect(h.whys.map((w) => w.pr)).toEqual([5012]);
    h.whys[0]!.resolve(why(5012, "aaa", "round-1"));
    await flush();
    expect(h.app.view.detail?.title).toBe("round-1");

    // Steady state: fresh cache, same head — no new read.
    h.poll(snap("aaa"));
    expect(h.whys.length).toBe(1);

    // The head moves; the PR stays selected.
    h.poll(snap("bbb"));
    expect(h.whys.length).toBe(2);
    // A second tick while that read is in flight does not stack another.
    h.poll(snap("bbb"));
    expect(h.whys.length).toBe(2);
    h.whys[1]!.resolve(why(5012, "bbb", "round-2"));
    await flush();
    expect(h.app.view.detail?.title).toBe("round-2");
  });

  it("refetches the selected PR's detail once its cache is past the TTL", async () => {
    const h = harness();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    h.poll(snap("aaa"));
    h.whys[0]!.resolve(why(5012, "aaa", "old"));
    await flush();
    now += 61_000;
    h.poll(snap("aaa"));
    expect(h.whys.length).toBe(2);
    h.whys[1]!.resolve(why(5012, "aaa", "new"));
    await flush();
    expect(h.app.view.detail?.title).toBe("new");
  });

  it("an older `why` read resolving after a newer one never overwrites the newer cache entry", async () => {
    const h = harness();
    h.poll(snap("aaa")); // read A for 5012
    h.app.selectPr(5013); // read for 5013
    h.app.selectPr(5012); // read B for 5012 (still uncached)
    const reads5012 = h.whys.filter((w) => w.pr === 5012);
    expect(reads5012.length).toBe(2);
    const [a, b] = reads5012;
    b!.resolve(why(5012, "aaa", "newer"));
    await flush();
    a!.resolve(why(5012, "aaa", "older"));
    await flush();
    expect(h.app.view.detail?.title).toBe("newer");
    // Away and back: the cache must serve the newer read, not the older one.
    h.app.selectPr(5013);
    h.app.selectPr(5012);
    expect(h.app.view.detail?.title).toBe("newer");
  });

  it("a first read slower than the poll is not superseded by a new read every tick", async () => {
    const h = harness();
    h.poll(snap("aaa"));
    h.poll(snap("aaa"));
    h.poll(snap("aaa"));
    expect(h.whys.length).toBe(1);
    h.whys[0]!.resolve(why(5012, "aaa", "slow"));
    await flush();
    expect(h.app.view.detail?.title).toBe("slow");
  });

  it("a failed read is retried by the poll only after a backoff, not every tick", async () => {
    const h = harness();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    h.poll(snap("aaa"));
    h.whys[0]!.resolve(why(5012, "aaa", "round-1"));
    await flush();
    h.poll(snap("bbb")); // invalidated → refetch
    expect(h.whys.length).toBe(2);
    h.whys[1]!.fail();
    await flush();
    now += 3_000;
    h.poll(snap("bbb"));
    expect(h.whys.length).toBe(2);
    now += 15_000;
    h.poll(snap("bbb"));
    expect(h.whys.length).toBe(3);
  });
});

describe("the operator's `r` and the help overlay", () => {
  // `r` asks for the detail again, whatever the cache says. MUTATION: let `r`
  // serve a fresh cache without a read — red.
  it("r re-reads the selected PR's detail even while its cache is fresh", async () => {
    const h = harness();
    h.poll(snap("aaa"));
    h.whys[0]!.resolve(why(5012, "aaa", "round-1"));
    await flush();
    h.app.pressKey("r");
    expect(h.whys.filter((w) => w.pr === 5012)).toHaveLength(2);
    h.whys[1]!.resolve(why(5012, "aaa", "round-1b"));
    await flush();
    expect(h.app.view.detail?.title).toBe("round-1b");
  });

  // The KEYS overlay hides the board's rows; the wheel under it must not move
  // a selection nobody can see. MUTATION: guard help only off the board — red.
  it("the wheel under the board's help overlay moves nothing", () => {
    const h = harness();
    h.poll(snap("aaa"));
    h.app.view.help = true;
    const mouse = h.app as unknown as {
      handleMouse(ev: { kind: string; x: number; y: number }): void;
    };
    mouse.handleMouse({ kind: "wheel-down", x: 10, y: 5 });
    expect(h.app.currentPr()).toBe(5012);
    expect(h.app.view.help).toBe(true);
    mouse.handleMouse({ kind: "click", x: 10, y: 5 });
    expect(h.app.view.help).toBe(false); // a click dismisses it, as any key does
    expect(h.app.currentPr()).toBe(5012);
  });
});

it("drops an events response after the app stopped", async () => {
  const h = harness();
  let finish!: (r: RemoteResult) => void;
  let callbacks = 0;
  (h.app as unknown as { ssh: SshRunner }).ssh = (() =>
    new Promise<RemoteResult>((r) => (finish = r))) as SshRunner;
  h.app.hooks.onPoll = () => {
    callbacks++;
  };
  const app = h.app as unknown as { refreshEvents(): Promise<void>; stopped: boolean };
  const request = app.refreshEvents();
  app.stopped = true;
  finish({ ok: true, stdout: JSON.stringify({ events: [] }), stderr: "", code: 0 });
  await request;
  expect(callbacks).toBe(0);
});

it("an older events response finishing late never replaces a newer one", async () => {
  const h = harness();
  const finishes: Array<(r: RemoteResult) => void> = [];
  (h.app as unknown as { ssh: SshRunner }).ssh = (() =>
    new Promise<RemoteResult>((r) => finishes.push(r))) as SshRunner;
  const app = h.app as unknown as { refreshEvents(): Promise<void>; rawEvents: unknown[] };
  const older = app.refreshEvents();
  const newer = app.refreshEvents();
  const ev = (kind: string) => ({ ts: "2026-10-22T10:00:00Z", kind, pr: null, payload: null });
  finishes[1]!({ ok: true, stdout: JSON.stringify({ events: [ev("newer")] }), stderr: "", code: 0 });
  await newer;
  finishes[0]!({ ok: true, stdout: JSON.stringify({ events: [ev("older")] }), stderr: "", code: 0 });
  await older;
  expect(app.rawEvents).toEqual([ev("newer")]);
});

it("selecting another PR (click, wheel, deep link) drops a cancelled message draft like j/k does", () => {
  const h = harness();
  h.poll(snap("aaa"));
  const app = h.app as unknown as { msgDraft: string };
  app.msgDraft = "cancelled text for 5012";
  expect(h.app.selectPr(5013)).toBe(true);
  expect(app.msgDraft).toBe("");
});

it("the quit prompt paints on a terminal narrower than its box", async () => {
  const { Frame } = await import("../src/tui/paint.js");
  const h = harness();
  h.app.view.confirmQuit = true;
  const paintQuit = h.app as unknown as {
    paintQuitPrompt(f: InstanceType<typeof Frame>, cols: number, rows: number): void;
  };
  expect(() => paintQuit.paintQuitPrompt(new Frame(5, 10), 5, 10)).not.toThrow();
});
