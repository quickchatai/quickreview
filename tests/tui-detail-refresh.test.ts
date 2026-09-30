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
import type { SshRunner } from "../src/tui/remote.js";

function snap(head: string, state = "reviewing"): StatusSnapshot {
  return {
    written_at: "2026-09-30T10:00:00Z",
    dry_run: false,
    prs: [
      { number: 5012, state, title: "t", head_sha: head, stale_recheck: false, rounds: 1, last_verdict: null },
      { number: 5013, state: "queued", title: "u", head_sha: "fff", stale_recheck: false, rounds: 0, last_verdict: null },
    ],
  } as unknown as StatusSnapshot;
}

function why(pr: number, head: string, tag: string, state = "reviewing"): string {
  return JSON.stringify({ pr, head_sha: head, state, title: tag, rounds: [], ledger: [] });
}

type Pending = { pr: number; resolve: (stdout: string) => void };

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
      whys.push({ pr, resolve: (stdout) => res({ ok: true, stdout, stderr: "", code: 0 }) }),
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
});
