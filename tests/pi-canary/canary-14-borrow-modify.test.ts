// Canary 14: when pi asks its credential store to change, and what it does
// with the answer.
//
// VERIFY-ON-PIN: a borrowed login (packages/pi-plugin/src/engine/auth.ts
// `borrowedCredentials`) never refreshes, and still has to outlive a token
// that is shorter than the run. It does so in the store's `modify`: instead of
// running pi's updater (which would spend the owner's refresh token), it takes
// the newer token from the owner's file and returns that. This holds only
// while pi behaves as read at the pin (pi-ai auth/resolve.js), so it is held
// here against the real pi:
//
//   - pi calls `modify` for a stored OAuth login only when the token is inside
//     pi's five minutes, and never for a stored key or a status read;
//   - the credential `modify` resolves with is the one the request runs on,
//     whether or not the store ran the updater pi handed it;
//   - pi keeps no copy of that credential: the next request reads the store;
//   - a store that refuses is an auth failure pi names by provider, carrying
//     the store's own words.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PI_REFRESH_MARGIN_MS } from "@quickchatai/pi-quickreview/src/engine/auth.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { useOfflineGuard } from "./harness.js";

// A refresh pi made itself would have to reach the provider: the guard fails
// the file if anything tried.
useOfflineGuard();

const LOGIN = "anthropic";
const KEYED = "deepseek";
const MIN = 60_000;

type OAuth = { type: "oauth"; access: string; refresh: string; expires: number };
type Stored = OAuth | { type: "api_key"; key: string };

interface Call {
  providerId: string;
  /** What pi handed over as the updater. */
  updater: unknown;
}

/** A store over `data` whose `modify` answers with `answer(held)` and never
 * runs the updater pi hands it. `adopt` keeps the answer for the next read. */
function store(
  data: Record<string, Stored>,
  answer: (held: Stored | undefined) => Stored | undefined,
  adopt = true,
) {
  const calls: Call[] = [];
  const deletes: string[] = [];
  return {
    calls,
    deletes,
    credentials: {
      async read(providerId: string) {
        const c = data[providerId];
        return c ? structuredClone(c) : undefined;
      },
      async list() {
        return Object.entries(data).map(([providerId, c]) => ({ providerId, type: c.type }));
      },
      async modify(providerId: string, updater: unknown) {
        calls.push({ providerId, updater });
        const post = answer(data[providerId]);
        if (post && adopt) data[providerId] = post;
        return post ? structuredClone(post) : undefined;
      },
      async delete(providerId: string): Promise<void> {
        deletes.push(providerId);
      },
    },
  };
}

const login = (leftMs: number, access = "old-token"): OAuth => ({
  type: "oauth",
  access,
  refresh: "not-a-refresh-token",
  expires: Date.now() + leftMs,
});

/** The owner's newer token, as a borrower would take it from the owner's file. */
const renewed = (): OAuth => login(60 * MIN, "new-token");

let dir: string;
let host: PiHost | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-canary-modify-"));
});

afterEach(() => {
  host?.dispose();
  host = undefined;
  rmSync(dir, { recursive: true, force: true });
});

async function rig(s: ReturnType<typeof store>) {
  host = await PiHost.create({
    agentDir: join(dir, "agent"),
    credentials: s.credentials as never,
    authEnv: {},
  });
  return host.modelRuntime;
}

describe("[canary 14] pi's use of the credential store's modify", () => {
  it("a login with time left, a stored key and the inventory's reads never reach modify", async () => {
    const s = store(
      { [LOGIN]: login(60 * MIN), [KEYED]: { type: "api_key", key: "not-a-key" } },
      renewed,
    );
    const runtime = await rig(s);
    expect(await runtime.getAuth(LOGIN)).toMatchObject({
      auth: { apiKey: "old-token" },
      source: "OAuth",
    });
    expect(await runtime.getAuth(KEYED)).toMatchObject({ auth: { apiKey: "not-a-key" } });
    expect((await host!.inventory()).map((e) => e.provider).sort()).toEqual([KEYED, LOGIN].sort());
    expect(s.calls).toEqual([]);
    expect(s.deletes).toEqual([]);
  });

  it("the window is pi's five minutes: a token just outside it is used as it is, one just inside it is not", async () => {
    const outside = store({ [LOGIN]: login(PI_REFRESH_MARGIN_MS + MIN) }, renewed);
    expect(await (await rig(outside)).getAuth(LOGIN)).toMatchObject({
      auth: { apiKey: "old-token" },
    });
    expect(outside.calls).toEqual([]);
    host!.dispose();

    const inside = store({ [LOGIN]: login(PI_REFRESH_MARGIN_MS - MIN) }, renewed);
    expect(await (await rig(inside)).getAuth(LOGIN)).toMatchObject({
      auth: { apiKey: "new-token" },
    });
    expect(inside.calls).toHaveLength(1);
  });

  it("what modify resolves with is the credential the request runs on, though the store never ran pi's updater", async () => {
    const s = store({ [LOGIN]: login(MIN) }, renewed);
    const runtime = await rig(s);

    expect(await runtime.getAuth(LOGIN)).toMatchObject({
      auth: { apiKey: "new-token" },
      source: "OAuth",
    });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0]!.providerId).toBe(LOGIN);
    // pi handed over an updater (its refresh); the store did not call it, and
    // nothing reached the network (the offline guard).
    expect(typeof s.calls[0]!.updater).toBe("function");
    expect(s.deletes).toEqual([]);
  });

  it("pi keeps no copy of the answer: the next request reads the store again", async () => {
    // A store that kept the newer token is read, and not asked to change again.
    const kept = store({ [LOGIN]: login(MIN) }, renewed, true);
    const a = await rig(kept);
    await a.getAuth(LOGIN);
    expect(await a.getAuth(LOGIN)).toMatchObject({ auth: { apiKey: "new-token" } });
    expect(kept.calls).toHaveLength(1);
    host!.dispose();

    // One that did not keep it still holds the old token, so pi asks again.
    const dropped = store({ [LOGIN]: login(MIN) }, renewed, false);
    const b = await rig(dropped);
    await b.getAuth(LOGIN);
    await b.getAuth(LOGIN);
    expect(dropped.calls).toHaveLength(2);
  });

  it("an answer of nothing is a provider with no login, not an error", async () => {
    const s = store({ [LOGIN]: login(MIN) }, () => undefined);
    expect(await (await rig(s)).getAuth(LOGIN)).toBeUndefined();
    expect(s.calls).toHaveLength(1);
  });

  it("a store that refuses is an auth failure pi names by provider, with the store's error as its cause", async () => {
    const refusal = new Error("canary 14: the store refuses");
    const s = store({ [LOGIN]: login(MIN) }, () => {
      throw refusal;
    });
    const failure = await (await rig(s)).getAuth(LOGIN).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    // The store's own words ride in the message: a reader that classifies the
    // failure text sees both.
    expect(failure?.message).toBe(
      `Credential store modify failed for ${LOGIN}: ${refusal.message}`,
    );
    expect(failure?.cause).toBe(refusal);
    expect(s.calls).toHaveLength(1);
  });
});
