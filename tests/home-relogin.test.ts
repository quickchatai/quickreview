// One login per box, through the home's factory: on a fake pi with
// a fake login owner (who refreshes the login, whether it expired, and the
// refresher's pause) and a fake device login. What is pinned:
//   - an expired login says "login expired" on the login line, with the one
//     key that signs in again, while auto-review shows "Paused: login";
//   - signing in again (alt+l, `l` on the panel, home_relogin) pauses a
//     running refresher BEFORE pi's device login and lifts the pause after it,
//     whatever the login's outcome, and auto-review resumes on the new login;
//   - pi's own refusal in the chat marks the login expired too;
//   - auto-review's label ends its pause once the refresher has looked at a
//     working login after the daemon's last auth failure.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import { autoReviewLabel } from "../src/home/autoreview.js";
import {
  known,
  unknown,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
  type LoginHealth,
  type LoginHold,
} from "../src/home/ports.js";
import type { DeviceLoginPort, LoginOutcome } from "../src/home/setup.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();
const CODE = { userCode: "ABCD-1234", verificationUri: "https://auth.openai.com/codex/device" };

/** A key's re-login runs on past the key's own settle: let it finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await settle();
}

interface World {
  health: Known<LoginHealth>;
  auto: Known<AutoReviewStatus>;
  /** What the hold answers: paused (held), nothing to pause, or a refusal. */
  hold: "held" | "none" | { why: string };
  /** How the device login ends, once `approve` is called. */
  outcome: LoginOutcome;
  /** Everything asked of the outside world, in order. */
  log: string[];
  approve: () => void;
}

const EXPIRED: Known<LoginHealth> = known({
  refresher: "auto-review",
  expired: "login expired",
  checkedAt: NOW - 60_000,
});
const PAUSED: Known<AutoReviewStatus> = known({ state: "paused-login", cause: "login expired" });

function world(over: Partial<World> = {}): World {
  return {
    health: EXPIRED,
    auto: PAUSED,
    hold: "held",
    outcome: { ok: true },
    log: [],
    approve: () => {},
    ...over,
  };
}

function adaptersOver(w: World): HomeAdapters {
  return {
    login: { providers: async () => known(["openai-codex"]) },
    github: {
      user: async () => known("octo"),
      openPulls: async () => known([]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known("acme/widgets") },
    clock: { now: () => NOW },
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

function deviceLoginOver(w: World): DeviceLoginPort {
  return {
    login: async ({ onCode }) => {
      w.log.push("login");
      onCode(CODE);
      await new Promise<void>((r) => (w.approve = r));
      return w.outcome;
    },
  };
}

async function home(w: World): Promise<{ pi: FakePi; text: () => string }> {
  const pi = fakePi({ model: { provider: "openai-codex", id: "gpt-6.1-sol" } });
  await createHome({
    adapters: adaptersOver(w),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
    setup: { deviceLogin: deviceLoginOver(w) },
  })(pi.api);
  await pi.start();
  // wide enough that no notice here wraps
  return { pi, text: () => pi.render(160, 40).lines.join("\n") };
}

describe("an expired login", () => {
  // MUTATION: drop the expired branch from the panel's login line — this fails.
  it("says so on the login line, with the key that signs in again; auto-review shows Paused: login", async () => {
    const h = await home(world());
    expect(h.text()).toMatch(/✗ OpenAI login expired · alt\+l sign in again/);
    expect(h.text()).toMatch(/‖ Auto-review paused · login expired/);
    expect(h.text()).not.toMatch(/ChatGPT/);
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
    expect(h.text()).toMatch(/✓ OpenAI ChatGPT/);
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
  // MUTATION: run the device login before the hold, or release the pause before the
  // login ends — the order below fails.
  it("pauses the refresher, runs pi's device login, lifts the pause, and auto-review resumes", async () => {
    const w = world();
    const h = await home(w);
    await h.pi.key("alt+l");
    await drain();
    expect(w.log).toEqual(["hold", "login"]);
    expect(h.text()).toMatch(/OpenAI signing in again…/);
    expect(h.text()).toMatch(
      /Open https:\/\/auth\.openai\.com\/codex\/device and enter the code ABCD-1234/,
    );
    // the person approves; the refresher re-reads the new login, the daemon resumes
    w.health = known({ refresher: "auto-review", checkedAt: NOW });
    w.auto = known({ state: "on-live", checkedAt: NOW });
    w.approve();
    await drain();
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(/✓ OpenAI ChatGPT/);
    expect(h.text()).toMatch(/● Auto-review on · live/);
    expect(h.text()).toMatch(
      /Signed in to OpenAI again\. Auto-review's refresher has the new login, and auto-review resumes\./,
    );
  });

  it("home_relogin answers with the code; a second press during the sign-in pauses nothing twice", async () => {
    const w = world();
    const h = await home(w);
    expect(await h.pi.tool("home_relogin")).toMatch(
      /^Open https:\/\/auth\.openai\.com\/codex\/device and enter the code ABCD-1234\./,
    );
    await h.pi.input("l");
    expect(await h.pi.tool("home_relogin")).toMatch(/^Still waiting: .* ABCD-1234\./);
    expect(w.log).toEqual(["hold", "login"]);
    w.approve();
    await drain();
    expect(w.log).toEqual(["hold", "login", "release"]);
  });

  it("stops before pi is asked when the refresher will not pause", async () => {
    const w = world({ hold: { why: "auto-review's login refresher did not pause within 60 s" } });
    const h = await home(w);
    expect(await h.pi.tool("home_relogin")).toMatch(/did not start: .* did not pause within 60 s/);
    expect(w.log).toEqual(["hold"]);
    expect(h.text()).toMatch(/Couldn't sign in again: .* Nothing changed\./);
    expect(h.text()).toMatch(/login expired · alt\+l sign in again/);
  });

  it("lifts the pause after a device login that did not finish, and says how to try again", async () => {
    const w = world({ outcome: { ok: false, kind: "expired", why: "the device code timed out" } });
    const h = await home(w);
    await h.pi.key("alt+l");
    await drain();
    w.approve();
    await drain();
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(/The code expired before it was approved\. alt\+l gets a new one\./);
    expect(h.text()).toMatch(/login expired · alt\+l sign in again/);
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
    w.approve();
    await drain();
    expect(w.log).toEqual(["hold", "login", "release"]);
    expect(h.text()).toMatch(/Signed in to OpenAI again\./);
    expect(h.text()).not.toMatch(/refresher has the new login/);
  });
});

describe("pi's own word on the login", () => {
  // MUTATION: drop the message_end handler in extensions/home.ts — this fails.
  it("a reply refused for the login marks it expired; the next reply that comes back clears it", async () => {
    const w = world({ health: known({ refresher: "home" }), auto: known({ state: "off" }) });
    const h = await home(w);
    expect(h.text()).toMatch(/✓ OpenAI ChatGPT/);
    await h.pi.emit("message_end", {
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "OAuth refresh failed for openai-codex",
      },
    });
    expect(h.text()).toMatch(/✗ OpenAI login expired · alt\+l sign in again/);
    // another error is not the login's
    await h.pi.emit("message_end", {
      message: { role: "assistant", stopReason: "error", errorMessage: "529 overloaded" },
    });
    expect(h.text()).toMatch(/login expired/);
    await h.pi.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    expect(h.text()).toMatch(/✓ OpenAI ChatGPT/);
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
