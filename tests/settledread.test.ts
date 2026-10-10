// Reading a JSON file another process may still be writing.
// Deterministic: a virtual clock, a virtual sleep and a scripted file stand in
// for the filesystem, so every bound is checked exactly, not by wall time.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PARTIAL_WRITE_POLICY,
  readSettledJson,
  resolvePartialWritePolicy,
  type SettledReadIo,
} from "../src/settledread.js";

const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: scripted`), { code });
const enoent = (): NodeJS.ErrnoException => errno("ENOENT");

/** A file whose bytes change at scripted virtual times. Each entry is
 * [from_ms, content]; the mtime is the entry's own `from_ms` (plus `skewMs`). */
function scripted(
  script: Array<[number, string | null]>,
  opts: { skewMs?: number; startWallMs?: number } = {},
): { io: SettledReadIo; clock: () => number; sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  const wallBase = opts.startWallMs ?? 1_000_000;
  const at = (): [number, string | null] => {
    let cur: [number, string | null] = script[0]!;
    for (const step of script) if (step[0] <= now) cur = step;
    return cur;
  };
  const io: SettledReadIo = {
    monotonicMs: () => now,
    wallMs: () => wallBase + now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    stat: () => {
      const [from, body] = at();
      if (body === null) throw enoent();
      return { size: body.length, mtimeMs: wallBase + from + (opts.skewMs ?? 0), ino: 7 };
    },
    read: () => {
      const [, body] = at();
      if (body === null) throw enoent();
      return body;
    },
  };
  return { io, clock: () => now, sleeps };
}

const WHOLE = JSON.stringify({ pr: 5885, round_no: 2, verdict: "APPROVE" });
const HALF = WHOLE.slice(0, Math.floor(WHOLE.length / 2));

describe("readSettledJson", () => {
  it("a complete file parses on the first read, with no wait", async () => {
    const { io, sleeps } = scripted([[0, WHOLE]]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed", reads: 1 });
    expect(sleeps).toEqual([]);
  });

  it("#5885: an EMPTY file (open O_TRUNC, bytes not yet written) is waited out", async () => {
    const { io } = scripted([
      [0, ""],
      [130, WHOLE],
    ]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed" });
    expect(r.kind === "parsed" && r.value).toMatchObject({ verdict: "APPROVE" });
  });

  it("a file written in two halves 200 ms apart parses", async () => {
    const { io } = scripted([
      [0, HALF],
      [200, WHOLE],
    ]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed" });
  });

  it("a file written in two halves 2 s apart parses", async () => {
    const { io, clock } = scripted([
      [0, HALF],
      [2_000, WHOLE],
    ]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed" });
    expect(clock()).toBeGreaterThanOrEqual(2_000);
    expect(clock()).toBeLessThan(DEFAULT_PARTIAL_WRITE_POLICY.windowMs);
  });

  it("a truly corrupt file is declared once it has sat still for settleMs — not before, and well inside the window", async () => {
    const { io, clock } = scripted([[0, "{never valid"]]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "unparseable", why: "settled" });
    expect(clock()).toBeGreaterThanOrEqual(DEFAULT_PARTIAL_WRITE_POLICY.settleMs);
    expect(clock()).toBeLessThan(DEFAULT_PARTIAL_WRITE_POLICY.windowMs);
    expect(r.kind === "unparseable" && r.error).toMatch(/JSON/);
  });

  it("a stall cannot decide alone: an OLD mtime on the first look still needs several unchanged looks", async () => {
    // The daemon woke from a 13.7 s stall and the file's mtime is already
    // old — the writer, throttled in the same cgroup, may not have run yet.
    const { io, sleeps } = scripted([
      [-20_000, ""],
      [400, WHOLE],
    ]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed" });
    expect(sleeps.length).toBeGreaterThan(0);
  });

  it("a DAEMON stall across one sleep cannot decide alone: the look right after it is never the last", async () => {
    // The daemon and the writer share one throttled cgroup. The watcher
    // sleeps 50 ms and wakes 13.7 s later; the writer, starved just the same,
    // finishes its bytes a moment AFTER the watcher's first post-stall look.
    // That look alone sees "unchanged for 13.7 s, mtime 13.7 s old" — it must
    // not be the one that declares the file corrupt.
    const { io } = scripted([
      [0, ""],
      [13_760, WHOLE],
    ]);
    let first = true;
    const inner = io.sleep!;
    io.sleep = async (ms) => {
      await inner(first ? 13_700 : ms);
      first = false;
    };
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed" });
  });

  it("a file that never stops changing is still declared, at the hard window", async () => {
    const script: Array<[number, string | null]> = [];
    for (let t = 0; t < 60_000; t += 300) script.push([t, `{"partial": ${"x".repeat(t % 7)}`]);
    const { io, clock } = scripted(script);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "unparseable", why: "window" });
    expect(clock()).toBeGreaterThanOrEqual(DEFAULT_PARTIAL_WRITE_POLICY.windowMs);
    expect(clock()).toBeLessThan(DEFAULT_PARTIAL_WRITE_POLICY.windowMs + 1_100);
  });

  it("a window of 0 is no tolerance: one read decides", async () => {
    const { io, sleeps } = scripted([[0, HALF]]);
    const r = await readSettledJson("v.json", resolvePartialWritePolicy({ windowMs: 0 }), io);
    expect(r).toMatchObject({ kind: "unparseable", why: "no_tolerance", reads: 1 });
    expect(sleeps).toEqual([]);
  });

  it("a file that disappears mid-wait is missing, never malformed", async () => {
    const { io } = scripted([
      [0, HALF],
      [100, null],
    ]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "missing" });
  });

  it("a file whose mtime is AHEAD of the clock is not declared until that mtime has aged past settleMs", async () => {
    // Clock skew, or a wall-clock step: stillness under our own looks alone
    // would declare this at ~3 s; the mtime half of the rule holds it until
    // the file's own mtime is settleMs in the past (10 s skew + 3 s).
    const { io, clock } = scripted([[0, "{never valid"]], { skewMs: 10_000 });
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "unparseable", why: "settled" });
    expect(clock()).toBeGreaterThanOrEqual(10_000 + DEFAULT_PARTIAL_WRITE_POLICY.settleMs);
    expect(clock()).toBeLessThan(DEFAULT_PARTIAL_WRITE_POLICY.windowMs);
  });

  for (const code of ["EISDIR", "EACCES", "EIO"]) {
    it(`a ${code} read on a file that IS there is not "missing": waited out, then declared unreadable`, async () => {
      const { io, clock } = scripted([[0, "{}"]]);
      io.read = () => {
        throw errno(code);
      };
      const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
      expect(r).toMatchObject({ kind: "unparseable", why: "settled" });
      expect(r.kind === "unparseable" && r.error).toContain("could not be read");
      expect(r.kind === "unparseable" && r.error).toContain(code);
      expect(clock()).toBeGreaterThanOrEqual(DEFAULT_PARTIAL_WRITE_POLICY.settleMs);
    });
  }

  it("a stat that fails with anything but ENOENT is unreadable too, bounded by our own looks", async () => {
    const { io, clock } = scripted([[0, "{}"]]);
    io.stat = () => {
      throw errno("EACCES");
    };
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "unparseable", why: "settled" });
    expect(clock()).toBeGreaterThanOrEqual(DEFAULT_PARTIAL_WRITE_POLICY.settleMs);
    expect(clock()).toBeLessThan(DEFAULT_PARTIAL_WRITE_POLICY.windowMs);
  });

  it("a transient read error that clears is read normally", async () => {
    const { io } = scripted([[0, WHOLE]]);
    let fails = 2;
    const inner = io.read!;
    io.read = (p) => {
      if (fails-- > 0) throw errno("EIO");
      return inner(p);
    };
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed", reads: 3 });
  });

  it("parseable is complete whatever its shape: the caller judges the shape", async () => {
    const { io } = scripted([[0, '"just a string"']]);
    const r = await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(r).toMatchObject({ kind: "parsed", value: "just a string", reads: 1 });
  });

  it("the backoff is bounded: no single sleep exceeds maxDelayMs", async () => {
    const { io, sleeps } = scripted([[0, "{never valid"]]);
    await readSettledJson("v.json", DEFAULT_PARTIAL_WRITE_POLICY, io);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(DEFAULT_PARTIAL_WRITE_POLICY.maxDelayMs);
    expect(sleeps[0]).toBe(DEFAULT_PARTIAL_WRITE_POLICY.initialDelayMs);
  });
});
