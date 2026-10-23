// The runtime port's contract (packages/pi-plugin/src/engine/port.ts), written against a harness
// so any runtime can be put through it. tests/engine-sdkruntime.test.ts runs it
// on the in-process SDK runtime, the one runtime.
//
// A harness builds a runtime whose backend plays a named behaviour, and can
// say what the backend was sent. The contract never reaches past the port:
// what only one runtime has (a pi child's argv, its process group) is that
// runtime's own describe in the test file.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RuntimeUnsupportedError,
  type Runtime,
  type SessionEvent,
  type SessionSpec,
} from "@quickchatai/pi-quickreview/src/engine/port.js";
import { waitFor } from "./wait-for.js";

/** What the backend does with each turn it is given.
 *  - stream:    answers with one message priced at 0.75 a turn and ends on
 *               its own.
 *  - echo:      ends at once with a bare agent_end.
 *  - slow:      ends on its own after about half a second.
 *  - hang:      never ends; only an abort, a dispose or a limit stops it.
 *  - spendy:    prices a fixed amount a message (at least 0.25, under 0.5) and
 *               never ends.
 *  - separators: an event whose string holds raw U+2028 and U+2029. */
export type Behaviour = "stream" | "echo" | "slow" | "hang" | "spendy" | "separators";

export interface PortHarness {
  name: string;
  /** Where steer lands: a runtime with no way into a running turn types it as
   * unsupported; one that has a way queues or handles it. */
  steer: "unsupported" | "delivered";
  /** Whether `resume` reopens a persisted session or is typed as unsupported. */
  resume: "unsupported" | "supported";
  /** Whether `agentsFiles` are delivered or refused. */
  agentsFiles: "unsupported" | "supported";
  /** The model name the specs carry. Default "m". */
  model?: string;
  /** Called after each test, to release what `runtime` built. */
  cleanup?(dir: string): void | Promise<void>;
  /** A runtime whose every turn plays `behaviour`. `dir` is the test's scratch
   * directory; the harness may keep its scripts and logs there. */
  runtime(dir: string, behaviour: Behaviour): Runtime;
  /** The message each turn delivered to the backend, in turn order. */
  delivered(dir: string): string[];
}

/** Raw line and paragraph separators: legal inside a JSON string, and where a
 * splitter that is not LF-only cuts an event in two. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
export const STREAM_SPENT_USD = 0.75;

/** Poll `ok` until it holds, inside the test's own timeout. */
export const pollUntil = waitFor;

export function portContract(h: PortHarness): void {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "port-contract-"));
  });
  afterEach(async () => {
    await h.cleanup?.(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  const events = (): string => join(dir, "events.jsonl");
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
    cwd: dir,
    env: { PATH: process.env["PATH"] },
    model: h.model ?? "m",
    eventsFile: events(),
    stderrFile: join(dir, "stderr.log"),
    limits: { timeoutMs: 20_000 },
    ...over,
  });
  const open = (b: Behaviour, over: Partial<SessionSpec> = {}) =>
    h.runtime(dir, b).create(spec(over));

  describe(`[${h.name}] prompt`, () => {
    it("runs the first turn to its end and returns how it ended", async () => {
      const s = await open("echo");
      const r = await s.prompt("the order");
      expect(r).toMatchObject({ code: 0, timedOut: false, streamError: null });
      expect(h.delivered(dir)).toEqual(["the order"]);
      expect(s.stats()).toMatchObject({ turns: 1, busy: false });
      await s.dispose();
    });

    it("has an id, and a session file only once one is persisted", async () => {
      const s = await open("echo");
      expect(s.id).not.toBe("");
      // No sessionDir in the spec: nothing is persisted by this spec.
      expect(s.sessionFile).toBeNull();
      await s.dispose();
    });
  });

  describe(`[${h.name}] followUp`, () => {
    it("on an idle session runs the next turn now and says it was handled", async () => {
      const s = await open("echo");
      await s.prompt("first");
      const d = await s.followUp("second");
      expect(d).toMatchObject({ status: "handled", result: { code: 0 } });
      expect(h.delivered(dir)).toEqual(["first", "second"]);
      expect(s.stats().turns).toBe(2);
      await s.dispose();
    });

    it("sent while a turn runs is queued, and runs behind that turn, in order", async () => {
      const s = await open("slow");
      const first = s.prompt("first");
      expect(await s.followUp("second")).toEqual({ status: "queued" });
      expect(await s.followUp("third")).toEqual({ status: "queued" });
      expect(s.stats().busy).toBe(true);
      await first;
      await pollUntil(() => !s.stats().busy, "the queue to drain");
      expect(h.delivered(dir)).toEqual(["first", "second", "third"]);
      expect(s.stats().turns).toBe(3);
      await s.dispose();
    });

    it("before the first prompt is refused", async () => {
      const s = await open("echo");
      await expect(s.followUp("early")).rejects.toThrow();
      expect(h.delivered(dir)).toEqual([]);
      await s.dispose();
    });
  });

  describe(`[${h.name}] steer`, () => {
    it(
      h.steer === "unsupported"
        ? "is typed as unsupported, with a reason, and leaves the turn alone"
        : "reaches the turn in flight",
      async () => {
        const s = await open("slow");
        const turn = s.prompt("first");
        const d = await s.steer("now");
        if (h.steer === "unsupported") {
          expect(d.status).toBe("unsupported");
          if (d.status === "unsupported") expect(d.reason).not.toBe("");
          expect((await turn).code).toBe(0);
          expect(h.delivered(dir)).toEqual(["first"]);
        } else {
          expect(["queued", "handled"]).toContain(d.status);
          await turn;
        }
        await s.dispose();
      },
    );
  });

  describe(`[${h.name}] abort`, () => {
    it("ends the running turn, which is neither a success nor a timeout", async () => {
      const s = await open("hang");
      const turn = s.prompt("p");
      await pollUntil(() => h.delivered(dir).length === 1, "the turn to start");
      await s.abort();
      const r = await turn;
      expect(r.code).not.toBe(0);
      expect(r.timedOut).toBe(false);
      expect(s.stats()).toMatchObject({ busy: false, turns: 1 });
      await s.dispose();
    });

    it("on an idle session does nothing", async () => {
      const s = await open("echo");
      await s.prompt("p");
      await s.abort();
      expect(s.stats()).toMatchObject({ busy: false, turns: 1 });
      expect((await s.followUp("again")).status).toBe("handled");
      await s.dispose();
    });
  });

  describe(`[${h.name}] stats`, () => {
    it("starts empty", async () => {
      const s = await open("echo");
      expect(s.stats()).toEqual({ turns: 0, busy: false, spentUsd: 0, last: null });
      await s.dispose();
    });

    it("counts settled turns, keeps the latest result, and adds the spend", async () => {
      // The price is read off the stream only under a cap (the meter is fed
      // for the cap), so the spend is checked with one set.
      const s = await open("stream", { limits: { timeoutMs: 20_000, capUsd: 100 } });
      const turn = s.prompt("p");
      expect(s.stats().busy).toBe(true);
      const r1 = await turn;
      expect(s.stats().last).toBe(r1);
      expect(s.stats().spentUsd).toBeCloseTo(STREAM_SPENT_USD);
      const d = await s.followUp("again");
      const stats = s.stats();
      expect(stats).toMatchObject({ turns: 2, busy: false });
      expect(stats.spentUsd).toBeCloseTo(2 * STREAM_SPENT_USD);
      expect(d.status === "handled" && stats.last === d.result).toBe(true);
      await s.dispose();
    });
  });

  describe(`[${h.name}] dispose`, () => {
    it("stops a running turn and is idempotent", async () => {
      const s = await open("hang");
      const turn = s.prompt("p");
      await pollUntil(() => h.delivered(dir).length === 1, "the turn to start");
      await s.dispose();
      await s.dispose();
      expect((await turn).code).not.toBe(0);
      expect(s.stats().busy).toBe(false);
    });

    it("leaves a session that takes nothing more", async () => {
      const s = await open("echo");
      await s.dispose();
      await expect(s.prompt("p")).rejects.toThrow(/disposed/);
      await expect(s.followUp("p")).rejects.toThrow(/disposed/);
      expect(h.delivered(dir)).toEqual([]);
    });

    it("fails a queued follow-up fast rather than running it", async () => {
      const s = await open("hang");
      const turn = s.prompt("p");
      await pollUntil(() => h.delivered(dir).length === 1, "the turn to start");
      expect(await s.followUp("queued")).toEqual({ status: "queued" });
      await s.dispose();
      await turn;
      expect(h.delivered(dir)).toEqual(["p"]);
    });
  });

  describe(`[${h.name}] event stream`, () => {
    /** The events file as events: every line must be one whole JSON event. */
    const written = (): SessionEvent[] =>
      readFileSync(events(), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SessionEvent);

    it("writes the events file as one JSON event per line", async () => {
      const s = await open("stream");
      await s.prompt("p");
      await s.dispose();
      expect(written().length).toBeGreaterThan(0);
      expect(existsSync(join(dir, "stderr.log"))).toBe(true);
    });

    it("lets a subscriber hear each event that was written, in order, until it unsubscribes", async () => {
      const s = await open("stream");
      const heard: SessionEvent[] = [];
      const off = s.subscribe((e) => heard.push(e));
      const quiet: SessionEvent[] = [];
      s.subscribe((e) => quiet.push(e))();
      await s.prompt("p");
      off();
      const first = written();
      await s.followUp("again");
      await s.dispose();
      expect(first.length).toBeGreaterThan(0);
      expect(heard).toEqual(first);
      expect(quiet).toEqual([]);
    });

    it("does not let a listener's failure stop the others or the turn", async () => {
      const s = await open("stream");
      const heard: SessionEvent[] = [];
      s.subscribe(() => {
        throw new Error("listener bug");
      });
      s.subscribe((e) => heard.push(e));
      const r = await s.prompt("p");
      await s.dispose();
      expect(r.code).toBe(0);
      expect(heard.length).toBeGreaterThan(0);
    });

    it("frames events by LF alone: U+2028 and U+2029 inside a string stay in one event", async () => {
      const s = await open("separators");
      const heard: SessionEvent[] = [];
      s.subscribe((e) => heard.push(e));
      await s.prompt("p");
      await s.dispose();
      // Every line of the file is a whole event (no fragment cut at a separator),
      // the subscriber heard those same events, and the raw separators survived.
      expect(written()).toEqual(heard);
      expect(JSON.stringify(heard)).toContain(`a${LS}b${PS}c`);
    });
  });

  describe(`[${h.name}] cap and deadline`, () => {
    it("ends a turn that passes its wall clock, and says it timed out", async () => {
      const s = await open("hang", { limits: { timeoutMs: 300 } });
      const r = await s.prompt("p");
      expect(r.timedOut).toBe(true);
      expect(r.capped).not.toBe(true);
      await s.dispose();
    });

    it("lets a turn's own timeout win over the session's", async () => {
      const s = await open("hang");
      const r = await s.prompt("p", { timeoutMs: 300 });
      expect(r.timedOut).toBe(true);
      await s.dispose();
    });

    it("kills a turn whose spend reaches the cap, and says it was capped", async () => {
      const s = await open("spendy", { limits: { timeoutMs: 20_000, capUsd: 0.5 } });
      const r = await s.prompt("p");
      expect(r.capped).toBe(true);
      expect(r.timedOut).toBe(false);
      expect(r.spentUsd).toBeGreaterThanOrEqual(0.5);
      expect(s.stats().spentUsd).toBeCloseTo(r.spentUsd ?? NaN);
      await s.dispose();
    });

    it("lets a turn's own cap win over the session's", async () => {
      const s = await open("spendy", { limits: { timeoutMs: 20_000, capUsd: 100 } });
      const r = await s.prompt("p", { capUsd: 0.5 });
      expect(r.capped).toBe(true);
      await s.dispose();
    });

    it("does not cap a turn that stays under it", async () => {
      const s = await open("stream", { limits: { timeoutMs: 20_000, capUsd: 100 } });
      const r = await s.prompt("p");
      expect(r.capped).toBe(false);
      expect(r.code).toBe(0);
      await s.dispose();
    });
  });

  if (h.resume === "supported")
    describe(`[${h.name}] resume`, () => {
      // One runtime for the whole test: a harness may keep its record of what
      // was delivered per runtime, and a resume continues the same backend.
      let rt: Runtime;
      beforeEach(() => {
        rt = h.runtime(dir, "echo");
      });
      const persisted = async (file: string) => {
        const s = await rt.create(spec({ sessionFile: file }));
        await s.prompt("round one");
        const id = s.id;
        await s.dispose();
        return id;
      };
      const lines = (file: string): string[] =>
        readFileSync(file, "utf8").split("\n").filter(Boolean);

      it("reopens a persisted session under its own id and appends its turns to the same file", async () => {
        const file = join(dir, "run", "main.jsonl");
        const id = await persisted(file);
        const before = lines(file);
        const s = await rt.resume(file, spec({ eventsFile: join(dir, "e2.jsonl") }));
        expect(s.id).toBe(id);
        expect(s.sessionFile).toBe(file);
        expect(s.stats()).toEqual({ turns: 0, busy: false, spentUsd: 0, last: null });
        expect(await s.prompt("round two")).toMatchObject({ code: 0 });
        expect(await s.followUp("round three")).toMatchObject({ status: "handled" });
        await s.dispose();
        const after = lines(file);
        expect(after.slice(0, before.length)).toEqual(before);
        expect(after.length).toBeGreaterThan(before.length);
        expect(after.filter((l) => JSON.parse(l).type === "session")).toHaveLength(1);
        expect(h.delivered(dir)).toEqual(["round one", "round two", "round three"]);
      });

      it("takes a follow-up as the first message after a resume", async () => {
        const file = join(dir, "main.jsonl");
        await persisted(file);
        const s = await rt.resume(file, spec({ eventsFile: join(dir, "e2.jsonl") }));
        expect(await s.followUp("carry on")).toMatchObject({ status: "handled" });
        await s.dispose();
        expect(h.delivered(dir)).toEqual(["round one", "carry on"]);
      });

      it("refuses a file that is missing or is not a session, without creating a new session", async () => {
        const missing = join(dir, "nope.jsonl");
        await expect(rt.resume(missing, spec())).rejects.toThrow(/not a session/);
        expect(existsSync(missing)).toBe(false);
        const junk = join(dir, "junk.jsonl");
        writeFileSync(junk, "{}\n");
        await expect(rt.resume(junk, spec())).rejects.toThrow(/not a session/);
        expect(readFileSync(junk, "utf8")).toBe("{}\n");
        await expect(rt.resume("relative.jsonl", spec())).rejects.toThrow(/absolute/);
      });

      it("refuses a spec that names another file or a directory", async () => {
        const file = join(dir, "main.jsonl");
        await persisted(file);
        await expect(
          rt.resume(file, spec({ sessionFile: join(dir, "other.jsonl") })),
        ).rejects.toThrow(/another sessionFile/);
        await expect(rt.resume(file, spec({ sessionDir: dir }))).rejects.toThrow(/sessionDir/);
      });
    });

  describe(`[${h.name}] what the runtime cannot do`, () => {
    if (h.resume === "unsupported")
      it("types resume as unsupported", async () => {
        const rt = h.runtime(dir, "echo");
        await expect(rt.resume(join(dir, "s.jsonl"), spec())).rejects.toBeInstanceOf(
          RuntimeUnsupportedError,
        );
      });

    it(
      h.agentsFiles === "unsupported"
        ? "refuses agentsFiles rather than dropping them"
        : "accepts agentsFiles",
      async () => {
        const create = h
          .runtime(dir, "echo")
          .create(spec({ agentsFiles: [{ path: "AGENTS.md", content: "x" }] }));
        if (h.agentsFiles === "unsupported")
          await expect(create).rejects.toBeInstanceOf(RuntimeUnsupportedError);
        else await (await create).dispose();
      },
    );
  });
}
