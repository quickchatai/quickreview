// One login per box, through the home's factory: on a fake pi with
// a fake login owner (who refreshes the login, whether it expired, and the
// refresher's pause) and a fake of pi's own /login. What is pinned:
//   - an expired login says "login expired" on the login line, in pi's own
//     name for the provider, with the one key that signs in again, while
//     auto-review shows "Paused: login";
//   - signing in again (alt+l, `l` on the panel, home_relogin) pauses a
//     running refresher BEFORE pi's /login opens and lifts the pause after it,
//     however the sign-in ends, and auto-review resumes on the new login;
//   - the sign-in is done when a stored login was replaced, for whichever
//     provider, and ends when the person goes back to the chat;
//   - pi's own refusal in the chat marks the login expired too;
//   - auto-review's label ends its pause once the refresher has looked at a
//     working login after the daemon's last auth failure.
// The providers are made up: no rule here knows a real one.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import { autoReviewLabel } from "../src/home/autoreview.js";
import { LOGIN_MENU_MAX_MS, LOGIN_POLL_MS, replacedLogin } from "../src/home/loginowner.js";
import {
  known,
  unknown,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
  type LoginHealth,
  type LoginHold,
} from "../src/home/ports.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();

/** A key's re-login runs on past the key's own settle: let it finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await settle();
}

interface World {
  health: Known<LoginHealth>;
  auto: Known<AutoReviewStatus>;
  /** What the hold answers: paused (held), nothing to pause, or a refusal. */
  hold: "held" | "none" | { why: string };
  /** The login file's stamps, by provider: a re-login replaces one. */
  stamps: Known<ReadonlyMap<string, string>>;
  /** How pi's /login opens; null: this pi gives no way. */
  menu: "opened" | "prefilled" | null;
  /** The clock, which a test moves. */
  now: number;
  /** Everything asked of the outside world, in order. */
  log: string[];
}

const EXPIRED: Known<LoginHealth> = known({
  refresher: "auto-review",
  expired: "login expired",
  checkedAt: NOW - 60_000,
});
const PAUSED: Known<AutoReviewStatus> = known({ state: "paused-login", cause: "login expired" });
const stamps = (o: Record<string, string>): Known<ReadonlyMap<string, string>> =>
  known(new Map(Object.entries(o)));

function world(over: Partial<World> = {}): World {
  return {
    health: EXPIRED,
    auto: PAUSED,
    hold: "held",
    stamps: stamps({ north: "oauth:100", south: "oauth:200" }),
    menu: "opened",
    now: NOW,
    log: [],
    ...over,
  };
}

/** pi's model registry, by shape: two providers, both with a stored login. */
function registry() {
  const names: Record<string, string> = { north: "North", south: "South" };
  const models = Object.keys(names).map((provider) => ({
    provider,
    id: "large-3",
    name: "large-3",
    api: "made-up",
    reasoning: true,
    contextWindow: 200_000,
    cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  }));
  return {
    getAll: () => models as never,
    getAvailable: () => models as never,
    find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) as never,
    getProviderAuthStatus: () => ({ configured: true, source: "stored" }),
    getProvider: () => undefined,
    getProviderDisplayName: (p: string) => names[p] ?? p,
    isUsingOAuth: () => true,
  };
}

function adaptersOver(w: World): HomeAdapters {
  return {
    login: {
      providers: async () => unknown("the login file's providers are not read here"),
      stamps: async () => w.stamps,
    },
    github: {
      user: async () => known("octo"),
      openPulls: async () => known([]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known("acme/widgets") },
    clock: { now: () => w.now },
    reviews: idleReviews(),
    autoReview: { status: async () => w.auto },
    memory: { status: async () => known("off") },
    spend: { totals: async () => unknown("not yet") },
    loginOwner: {
      health: async () => w.health,
      hold: async (): Promise<LoginHold> => {
        w.log.push("hold");
        if (typeof w.hold === "object") return { ok: false, why: w.hold.why };
        return {
          ok: true,
          held: w.hold === "held",
          release: () => w.log.push("release"),
        };
      },
    },
  };
}

interface Home {
  pi: FakePi;
  text: () => string;
  /** Let the sign-in look once more whether it is done. */
  poll: () => Promise<void>;
  /** The person sends the chat a message. */
  say: (text: string) => Promise<void>;
}

async function home(w: World): Promise<Home> {
  const pi = fakePi({ model: { provider: "north", id: "large-3" } });
  Object.assign(pi.ctx, { modelRegistry: registry() });
  Object.assign(pi.api, { setModel: async () => true });
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  await createHome({
    adapters: adaptersOver(w),
    model: "",
    tools: "reviewer",
    every: () => () => {},
    after: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    loginMenu: {
      open: () => {
        if (w.menu !== null) w.log.push("login");
        return w.menu;
      },
    },
  })(pi.api);
  await pi.start();
  return {
    pi,
    // wide enough that no notice here wraps
    text: () => pi.render(160, 40).lines.join("\n"),
    poll: async () => {
      for (const t of timers.splice(0)) {
        if (t.cancelled) continue;
        if (t.ms === LOGIN_POLL_MS) t.fn();
        else timers.push(t);
      }
      await drain();
    },
    say: async (text) => {
      await pi.emit("input", { text, source: "interactive" });
      await drain();
    },
  };
}

describe("an expired login", () => {
  // MUTATION: drop the expired branch from the panel's login line — this fails.
  it("says so on the login line, with the key that signs in again; auto-review shows Paused: login", async () => {
    const h = await home(world());
    expect(h.text()).toMatch(/✗ North login expired · alt\+l sign in again/);
    expect(h.text()).toMatch(/‖ Auto-review paused · login expired/);
    expect(h.text()).not.toMatch(/signed in with pi/);
    const status = JSON.parse(await h.pi.tool("home_status")) as {
      login: { expired: unknown; refreshed_by: unknown; signed_in: unknown };
    };
    expect(status.login).toMatchObject({
      expired: true,
      refreshed_by: "auto-review",
      signed_in: true,
    });
  });

  it("names the panel's own key when the panel has the keyboard", async () => {
    const h = await home(world());
    await h.pi.key("f2");
    expect(h.text()).toMatch(/login expired · l sign in again/);
  });

  it("is not said while the login works, and who refreshes it is reported", async () => {
    const h = await home(
      world({ health: known({ refresher: "home" }), auto: known({ state: "off" }) }),
    );
    expect(h.text()).toMatch(/✓ North · signed in with pi/);
    expect(h.text()).not.toMatch(/login expired/);
    const status = JSON.parse(await h.pi.tool("home_status")) as { login: unknown };
    expect(status.login).toMatchObject({ expired: false, refreshed_by: "home" });
  });

  it("is unknown, not fine, when who refreshes it cannot be read", async () => {
    const h = await home(
      world({ health: unknown("no flock here"), auto: known({ state: "off" }) }),
    );
    const status = JSON.parse(await h.pi.tool("home_status")) as { login: unknown };
    expect(status.login).toMatchObject({
      expired: null,
      refreshed_by: null,
      refresher_unknown_because: "no flock here",
    });
  });
});

describe("signing in again", () => {
  // MUTATION: open pi's /login before the hold, or release the pause before
  // the sign-in ends (LoginMenu.run) — the order below fails.
  it("pauses the refresher, opens pi's /login, lifts the pause once a login was replaced, and auto-review resumes", async () => {
    const w = world();
    const h = await home(w);
    await h.pi.key("alt+l");
    await drain();
    expect(w.log).toEqual(["hold", "login"]);
    expect(h.text()).toMatch(/North signing in again…/);
    expect(h.text()).toMatch(/Signing in again: pi's \/login is open\./);
    // nothing replaced yet: the pause holds
    await h.poll();
    expect(w.log).toEqual(["hold", "login"]);
    // the person signs in to the other provider; the refresher re-reads the
    // new login, the daemon resumes
    w.stamps = stamps({ north: "oauth:100", south: "oauth:900" });
    w.health = known({ refresher: "auto-review", checkedAt: NOW });
    w.auto = known({ state: "on-live", checkedAt: NOW });
    await h.poll();
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(/✓ North · signed in with pi/);
    expect(h.text()).toMatch(/● Auto-review on · live/);
    expect(h.text()).toMatch(
      /Signed in to South again\. Auto-review's refresher has the new login, and auto-review resumes\./,
    );
  });

  // The home cannot see pi's menu close: after Esc the sign-in still waits.
  // MUTATION: drop `again: true` from the alt+l key in createHome, or make
  // LoginMenu.reopen return null — the key opens nothing and this fails.
  it("home_relogin answers once pi's menu is open; a second call opens nothing, and the person's key puts /login up again under the one pause", async () => {
    const w = world();
    const h = await home(w);
    expect(await h.pi.tool("home_relogin")).toMatch(/^Signing in again: pi's \/login is open\./);
    expect(await h.pi.tool("home_relogin")).toBe(
      "pi's /login is open already: finish the sign-in in pi's menu.",
    );
    expect(w.log).toEqual(["hold", "login"]);
    await h.pi.key("alt+l");
    await drain();
    expect(w.log).toEqual(["hold", "login", "login"]);
    expect(h.text()).toMatch(/North signing in again…/);
    // the one wait still ends the sign-in, and lifts the one pause
    w.stamps = stamps({ north: "oauth:900", south: "oauth:200" });
    await h.poll();
    expect(w.log).toEqual(["hold", "login", "login", "release"]);
    expect(h.text()).toMatch(/Signed in to North again\./);
  });

  // The stamps are the real port's shape: type, expiry, a digest of the entry
  // (tests/home-adapters.test.ts pins that a replaced key changes the digest).
  it("an API key replaced by another API key ends the sign-in as done", async () => {
    const w = world({ stamps: stamps({ north: "api_key::0a1b2c3d" }) });
    const h = await home(w);
    expect(await h.pi.tool("home_relogin")).toMatch(/^Signing in again: pi's \/login is open\./);
    w.stamps = stamps({ north: "api_key::9f8e7d6c" });
    await h.poll();
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(/Signed in to North again\./);
    expect(h.text()).not.toMatch(/no stored login changed/);
  });

  it("stops before pi is asked when the refresher will not pause", async () => {
    const w = world({ hold: { why: "auto-review's login refresher did not pause within 60 s" } });
    const h = await home(w);
    expect(await h.pi.tool("home_relogin")).toMatch(/did not start: .* did not pause within 60 s/);
    expect(w.log).toEqual(["hold"]);
    expect(h.text()).toMatch(/Couldn't sign in again: .* Nothing changed\./);
    expect(h.text()).toMatch(/login expired · alt\+l sign in again/);
  });

  // MUTATION: drop the onInput hook in createHome (loginMenu.left) — the
  // refresher stays paused after the person left pi's menu, and this fails.
  it("lifts the pause when the person goes back to the chat with no login replaced, and says how to try again", async () => {
    const w = world();
    const h = await home(w);
    await h.pi.key("alt+l");
    await drain();
    await h.say("never mind");
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(
      /pi's \/login closed and no stored login changed\. alt\+l opens it again\./,
    );
    expect(h.text()).toMatch(/login expired · alt\+l sign in again/);
  });

  // MUTATION: drop the LOGIN_MENU_MAX_MS ceiling from LoginMenu's poll — a
  // menu left open holds the refresher for good, and this fails.
  it("a menu left open is not a pause for good: the hold is lifted at the ceiling", async () => {
    const w = world();
    const h = await home(w);
    await h.pi.key("alt+l");
    await drain();
    w.now = NOW + LOGIN_MENU_MAX_MS;
    await h.poll();
    expect(w.log).toEqual(["hold", "login", "release"]);
  });

  it("pauses nothing while auto-review is off: the home's own pi owns the login", async () => {
    const w = world({
      hold: "none",
      health: known({ refresher: "home" }),
      auto: known({ state: "off" }),
    });
    const h = await home(w);
    await h.pi.key("alt+l");
    await drain();
    w.stamps = stamps({ north: "oauth:900", south: "oauth:200" });
    await h.poll();
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(/Signed in to North again\./);
    expect(h.text()).not.toMatch(/refresher has the new login/);
  });

  it("a pi that gives no way to open its menu: nothing is left paused, and /login is named", async () => {
    const w = world({ menu: null });
    const h = await home(w);
    expect(await h.pi.tool("home_relogin")).toMatch(
      /^type \/login to sign in again with pi's own menu \(switch auto-review off first/,
    );
    expect(w.log).toEqual(["hold", "release"]);
  });

  it("replacedLogin names the provider whose stored login is new or reads differently", () => {
    const before = stamps({ north: "oauth:100" });
    expect(replacedLogin(before, stamps({ north: "oauth:100" }))).toBeNull();
    expect(replacedLogin(before, stamps({ north: "oauth:500" }))).toBe("north");
    expect(replacedLogin(before, stamps({ north: "oauth:100", south: "api_key:" }))).toBe("south");
    // an unreadable file says nothing: never "replaced"
    expect(replacedLogin(before, unknown("EACCES"))).toBeNull();
    expect(replacedLogin(null, stamps({ north: "oauth:500" }))).toBeNull();
  });
});

describe("pi's own word on the login", () => {
  // MUTATION: drop the message_end handler in extensions/home.ts — this fails.
  it("a reply refused for the login marks it expired; the next reply that comes back clears it", async () => {
    const w = world({ health: known({ refresher: "home" }), auto: known({ state: "off" }) });
    const h = await home(w);
    expect(h.text()).toMatch(/✓ North · signed in with pi/);
    await h.pi.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "OAuth refresh failed for north",
      },
    });
    expect(h.text()).toMatch(/✗ North login expired · alt\+l sign in again/);
    // another error is not the login's
    await h.pi.emit("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" },
    });
    expect(h.text()).toMatch(/login expired/);
    await h.pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    expect(h.text()).toMatch(/✓ North · signed in with pi/);
  });
});

describe("auto-review's pause ends with the re-login", () => {
  const snapshot = (over: Record<string, unknown>): string =>
    JSON.stringify({
      written_at: ago(20),
      heartbeat: ago(20),
      dry_run: false,
      prs: [],
      running_rounds: 0,
      total_spend_usd: 0,
      poll: { last_at: ago(60), ok: true, interval_s: 300 },
      ...over,
    });
  const label = (over: Record<string, unknown>) => {
    const k = autoReviewLabel({
      container: known("running"),
      snapshot: known(snapshot(over)),
      now: NOW,
    });
    return k.kind === "known" ? k.value.state : "unknown";
  };
  const refresher = (login: Record<string, unknown>) => ({
    state: "supervised",
    running: true,
    restarts: 0,
    login: {
      paused: false,
      last_error: null,
      expires_at: new Date(NOW + 10 * 3_600_000).toISOString(),
      ...login,
    },
  });

  // MUTATION: let pi_auth_expired win over a later working login in loginPause, or
  // drop the loginRecovered check from brokenCause's provider branch — this fails.
  it("a working login the refresher read after the last auth failure resumes it", () => {
    // the snapshot carries the auth failure twice: its flag and the provider
    // record derived from it (src/state.ts), with the same last_at
    const failed = {
      pi_auth_expired: { last_at: ago(300), hits: 2 },
      provider: { healthy: false, detail: "pi auth expired (2 hits)", last_at: ago(300) },
    };
    expect(label(failed)).toBe("paused-login");
    expect(label({ ...failed, login_refresh: refresher({ checked_at: ago(10) }) })).toBe("on-live");
    // a login with no expiry is written `never`, and that one works too
    // MUTATION: require a finite expires_at in worksSince — this fails.
    expect(
      label({
        ...failed,
        login_refresh: refresher({ checked_at: ago(10), expires_at: "never" }),
      }),
    ).toBe("on-live");
    // a record from before the failure, a paused one, or a failing one does not
    expect(label({ ...failed, login_refresh: refresher({ checked_at: ago(600) }) })).toBe(
      "paused-login",
    );
    expect(
      label({ ...failed, login_refresh: refresher({ checked_at: ago(10), paused: true }) }),
    ).toBe("paused-login");
    expect(
      label({
        ...failed,
        login_refresh: refresher({ checked_at: ago(10), last_error: "openai-codex: 500" }),
      }),
    ).toBe("paused-login");
  });

  // MUTATION: skip every unhealthy provider once the login recovered — this fails.
  it("a provider failure of its own still reads Broken after the re-login", () => {
    const failed = { pi_auth_expired: { last_at: ago(300), hits: 2 } };
    const working = { login_refresh: refresher({ checked_at: ago(10) }) };
    expect(
      label({
        ...failed,
        ...working,
        provider: { healthy: false, detail: "rate limited for 2h", last_at: ago(30) },
      }),
    ).toBe("broken");
    // without the re-login, the auth failure is a pause, not Broken
    expect(
      label({
        ...failed,
        provider: { healthy: false, detail: "pi auth expired (2 hits)", last_at: ago(300) },
      }),
    ).toBe("paused-login");
  });
});
