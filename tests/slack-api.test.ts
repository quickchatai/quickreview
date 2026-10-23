import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackApiClient } from "../src/slack/api.js";
import type { SlackFetchFn } from "../src/slack/types.js";

interface Call {
  method: string; // the Slack API method, e.g. "chat.postMessage"
  body: Record<string, unknown>;
  auth: string | undefined;
}

type Reply = { status?: number; headers?: Record<string, string>; payload?: unknown };

function fakeFetch(replies: (call: Call, n: number) => Reply) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: String(url).split("/").pop() ?? "",
      body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      auth: headers["authorization"],
    };
    calls.push(call);
    const r = replies(call, calls.length);
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.payload ?? { ok: true, ts: "1712345678.000100" },
    } as unknown as Response;
  }) as unknown as SlackFetchFn;
  return { fetchFn, calls };
}

function build(
  fetchFn: SlackFetchFn,
  over: Partial<ConstructorParameters<typeof SlackApiClient>[0]> = {},
) {
  return new SlackApiClient({
    botToken: "xoxb-test",
    fetchFn,
    apiBase: "https://slack.test/api",
    postMinIntervalMs: 1100,
    now: () => Date.now(),
    ...over,
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("chat.postMessage", () => {
  it("does not resend a server-error create and exposes its unknown delivery", async () => {
    const f = fakeFetch(() => ({ status: 500, payload: { ok: false, error: "internal_error" } }));
    const p = build(f.fetchFn).postMessage({ channel: "C1", text: "one announcement" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls).toHaveLength(1);
    expect(await p).toMatchObject({ ok: false, ambiguous: true });
  });
  it("preserves ambiguity for callers after a lost create response", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as SlackFetchFn;
    const p = build(fetchFn).postMessage({ channel: "C1", text: "one announcement" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toMatchObject({ ok: false, ambiguous: true });
  });
  it("posts with the bot token and returns the ts as a string", async () => {
    const f = fakeFetch(() => ({ payload: { ok: true, ts: "1712345678.123456" } }));
    const api = build(f.fetchFn);
    const res = await api.postMessage({
      channel: "C1",
      text: "hi",
      thread_ts: "1712000000.000001",
    });

    expect(res).toEqual({ ok: true, ts: "1712345678.123456" });
    expect(typeof res.ts).toBe("string");
    expect(f.calls[0]!.method).toBe("chat.postMessage");
    expect(f.calls[0]!.auth).toBe("Bearer xoxb-test");
    expect(f.calls[0]!.body).toEqual({ channel: "C1", text: "hi", thread_ts: "1712000000.000001" });
  });

  it("omits thread_ts when the post is not threaded", async () => {
    const f = fakeFetch(() => ({}));
    await build(f.fetchFn).postMessage({ channel: "C1", text: "hi" });
    expect(f.calls[0]!.body).not.toHaveProperty("thread_ts");
  });

  it("keeps a ts that looks numeric as a string, never a float", async () => {
    const f = fakeFetch(() => ({ payload: { ok: true, ts: "1712345678.000100" } }));
    const res = await build(f.fetchFn).postMessage({ channel: "C1", text: "x" });
    expect(res.ts).toBe("1712345678.000100");
    // Round-tripping through a float would have eaten the trailing zeros.
    expect(String(Number(res.ts))).not.toBe(res.ts);
  });
});

describe("serialized post queue", () => {
  it("spaces two posts by at least post_min_interval_ms", async () => {
    const f = fakeFetch(() => ({}));
    const api = build(f.fetchFn);

    const a = api.postMessage({ channel: "C1", text: "first" });
    const b = api.postMessage({ channel: "C1", text: "second" });

    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1); // second is queued behind the interval

    await vi.advanceTimersByTimeAsync(1099);
    expect(f.calls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(f.calls[1]!.body["text"]).toBe("second");
  });

  it("serializes chat.update behind chat.postMessage in the same queue", async () => {
    const f = fakeFetch(() => ({}));
    const api = build(f.fetchFn);
    void api.postMessage({ channel: "C1", text: "first" });
    const upd = api.updateMessage({ channel: "C1", ts: "1712345678.000100", text: "edited" });

    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1100);
    expect(f.calls.map((c) => c.method)).toEqual(["chat.postMessage", "chat.update"]);
    expect((await upd).ok).toBe(true);
    expect(f.calls[1]!.body).toEqual({ channel: "C1", ts: "1712345678.000100", text: "edited" });
  });
});

describe("rate limits and retries", () => {
  it("honors a 429 Retry-After before retrying, then succeeds", async () => {
    const f = fakeFetch((_c, n) =>
      n === 1
        ? { status: 429, headers: { "retry-after": "7" } }
        : { payload: { ok: true, ts: "1712345678.222222" } },
    );
    const api = build(f.fetchFn);
    const p = api.postMessage({ channel: "C1", text: "hi" });

    await vi.advanceTimersByTimeAsync(0);
    expect(f.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(6999);
    expect(f.calls).toHaveLength(1); // still waiting out Retry-After: 7s
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls).toHaveLength(2);
    await expect(p).resolves.toEqual({ ok: true, ts: "1712345678.222222" });
  });

  it("retries a definite refusal twice then gives up — logged and dropped, never thrown", async () => {
    const f = fakeFetch(() => ({ status: 400, payload: { ok: false, error: "internal_error" } }));
    const logs: string[] = [];
    const api = build(f.fetchFn, { log: (m) => void logs.push(m) });

    const p = api.postMessage({ channel: "C1", text: "hi" });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p; // resolves, does not reject

    expect(f.calls).toHaveLength(3); // 1 attempt + 2 retries
    expect(res.ok).toBe(false);
    expect(res.error).toBe("internal_error");
    expect(logs).toContain("slack.api.dropped");
  });

  it("a dropped post does not wedge the queue for the next one", async () => {
    const f = fakeFetch((_c, n) =>
      n === 1 ? { status: 500, payload: { ok: false, error: "boom" } } : {},
    );
    const api = build(f.fetchFn);
    const first = api.postMessage({ channel: "C1", text: "doomed" });
    const second = api.postMessage({ channel: "C1", text: "next" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect((await first).ok).toBe(false);
    expect((await second).ok).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("a stalled request is abandoned at the per-attempt deadline, so it cannot wedge the queue", async () => {
    // Slack accepts the connection and never answers: only the abort signal
    // can end the attempt.
    let n = 0;
    const fetchFn = ((_url: string, init: RequestInit = {}) => {
      n += 1;
      if (n > 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true, ts: "1712345678.000200" }),
        } as unknown as Response);
      }
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as SlackFetchFn;
    const api = build(fetchFn, { requestTimeoutMs: 5_000 });
    const first = api.postMessage({ channel: "C1", text: "stalled" });
    const second = api.postMessage({ channel: "C1", text: "next" });

    await vi.advanceTimersByTimeAsync(60_000);
    expect((await first).ok).toBe(false);
    expect(await second).toEqual({ ok: true, ts: "1712345678.000200" });
    // The stalled post may have landed: it is never resent.
    expect(n).toBe(2);
  });

  it("a new message is resent only after a definite refusal — never when Slack may have taken it", async () => {
    let calls = 0;
    const throwing = (err: unknown) =>
      (async () => {
        calls += 1;
        throw err;
      }) as unknown as SlackFetchFn;
    // A reset mid-exchange: the post may be in the channel already.
    let api = build(throwing(new Error("ECONNRESET")));
    let p = api.postMessage({ channel: "C1", text: "hi" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).ok).toBe(false);
    expect(calls).toBe(1);
    // Never connected: nothing was sent, so it is retried.
    calls = 0;
    api = build(
      throwing(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })),
    );
    p = api.postMessage({ channel: "C1", text: "hi" });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(calls).toBe(3);
    // An edit is idempotent: retried whatever happened.
    calls = 0;
    api = build(throwing(new Error("ECONNRESET")));
    const u = api.updateMessage({ channel: "C1", ts: "1712345678.000100", text: "x" });
    await vi.advanceTimersByTimeAsync(10_000);
    await u;
    expect(calls).toBe(3);
  });

  it("a network throw is swallowed into an error result", async () => {
    const fetchFn = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as SlackFetchFn;
    const api = build(fetchFn);
    const p = api.postMessage({ channel: "C1", text: "hi" });
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ECONNRESET");
  });
});

describe("users.info cache", () => {
  it("caches by user id — a second lookup makes no second fetch", async () => {
    const f = fakeFetch(() => ({
      payload: {
        ok: true,
        user: { id: "U1", name: "morgan", profile: { display_name: "matt" }, is_bot: false },
      },
    }));
    const api = build(f.fetchFn);

    const a = await api.usersInfo("U1");
    const b = await api.usersInfo("U1");
    expect(a).toEqual({ id: "U1", display_name: "matt", is_bot: false });
    expect(b).toEqual(a);
    expect(f.calls).toHaveLength(1);

    await api.usersInfo("U2");
    expect(f.calls).toHaveLength(2); // a different id is a miss
  });

  it("re-fetches once the TTL has expired", async () => {
    let clock = 1_000_000;
    const f = fakeFetch(() => ({ payload: { ok: true, user: { id: "U1", real_name: "Morgan" } } }));
    const api = build(f.fetchFn, { userCacheTtlSec: 60, now: () => clock });

    await api.usersInfo("U1");
    clock += 59_000;
    await api.usersInfo("U1");
    expect(f.calls).toHaveLength(1);
    clock += 2_000;
    await api.usersInfo("U1");
    expect(f.calls).toHaveLength(2);
  });

  it("falls back through display_name -> real_name -> name -> id", async () => {
    const f = fakeFetch((c) => {
      const id = c.body["user"];
      if (id === "U1") return { payload: { ok: true, user: { id: "U1", real_name: "Real Name" } } };
      return { payload: { ok: true, user: { id: "U2" } } };
    });
    const api = build(f.fetchFn);
    expect((await api.usersInfo("U1"))?.display_name).toBe("Real Name");
    expect((await api.usersInfo("U2"))?.display_name).toBe("U2");
  });

  it("returns undefined (not a throw) when Slack refuses the lookup", async () => {
    const f = fakeFetch(() => ({ payload: { ok: false, error: "user_not_found" } }));
    await expect(build(f.fetchFn).usersInfo("U9")).resolves.toBeUndefined();
  });
});

describe("auth.test and pins.add", () => {
  it("auth.test returns our own user_id and bot_id", async () => {
    const f = fakeFetch(() => ({
      payload: { ok: true, user_id: "U0BOT", bot_id: "B0BOT", team_id: "T1" },
    }));
    const id = await build(f.fetchFn).authTest();
    expect(id).toEqual({ user_id: "U0BOT", bot_id: "B0BOT", team_id: "T1" });
    expect(f.calls[0]!.method).toBe("auth.test");
  });

  it("auth.test yields undefined on failure", async () => {
    const f = fakeFetch(() => ({ payload: { ok: false, error: "invalid_auth" } }));
    await expect(build(f.fetchFn).authTest()).resolves.toBeUndefined();
  });

  it("auth.test logs the failure cause so a boot refusal can be told apart", async () => {
    const f = fakeFetch(() => ({ payload: { ok: false, error: "invalid_auth" } }));
    const logs: Array<[string, Record<string, unknown> | undefined]> = [];
    const api = build(f.fetchFn, { log: (m, meta) => void logs.push([m, meta]) });
    await api.authTest();
    expect(logs).toContainEqual(["slack.api.auth_test_failed", { error: "invalid_auth" }]);
  });

  it("pins.add is best-effort: no_permission comes back as a value, not a throw", async () => {
    const f = fakeFetch(() => ({ payload: { ok: false, error: "no_permission" } }));
    const res = await build(f.fetchFn).pinsAdd({ channel: "C1", ts: "1712345678.000100" });
    expect(res).toEqual({ ok: false, error: "no_permission" });
    expect(f.calls[0]!.body).toEqual({ channel: "C1", timestamp: "1712345678.000100" });
  });
});
