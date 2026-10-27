// One login per box, as the home sees it: who refreshes
// the OpenAI login the home signed in to, whether it still works, and the
// re-login that replaces it safely.
//
//   owner     the daemon's refresher holds the login while auto-review runs
//             on this machine (its single-instance lock, beside auth.json in
//             the home's own pi agent dir, which the stack mounts:
//             src/onboard/steps/loginshare.ts). Otherwise the home's pi refreshes it
//             itself, by pi's own rule: a token inside pi's 5-minute window,
//             under pi's own lock. While the refresher runs no token gets
//             near that window, so the home's pi never refreshes: it borrows.
//   expired   the refresher's record says its refresh fails and the token is
//             past its expiry (or the grant was refused); or the chat itself
//             was refused for the login (extensions/home.ts reads pi's error);
//             or auto-review is paused on it. The login line then says "login
//             expired", with one key that signs in again.
//   re-login  pi's own device login (src/home/devicelogin.ts), with the
//             entrypoint's handover around it (src/loginrefresh/handover.ts):
//             a running refresher is paused first, and keeps its lock, so its
//             refresh can never land on top of the new login; the pause is
//             lifted after, and the refresher re-reads the new login at once,
//             so auto-review resumes on it.
//
// Nothing here reads or prints a token: the refresher's status file carries
// expiry times and redacted errors only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PI_AUTH_ERROR_RE } from "@quickchatai/pi-quickreview/src/authwatch.js";
import { holdRefresher, refresherRuns, type HoldOptions } from "../loginrefresh/handover.js";
import { STATUS_FILE } from "../loginrefresh/refresher.js";
import { providerLabel, type HomeModel } from "./model.js";
import {
  known,
  unknown,
  type Known,
  type LoginHealth,
  type LoginHold,
  type LoginOwnerPort,
} from "./ports.js";
import {
  DEVICE_LOGIN_PROVIDERS,
  loginFailureText,
  type DeviceCode,
  type DeviceLoginPort,
  type LoginFailureKind,
} from "./setup.js";

/** What the login line says of a login that no longer works. */
export const LOGIN_EXPIRED = "login expired";
/** The key that signs in again, while typing (the panel's is `l`). */
export const RELOGIN_KEY = "alt+l";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A refresh refused for good: the grant is gone, not a network blip. */
const REFUSED = /invalid_grant|revoked|refresh_token_(?:reused|expired|invalidated)/i;

/** Why the refresher's record (its loginrefresh.status.json) says the login
 * no longer works, or null. Pure. */
export function expiredWhy(record: unknown, now: number): string | null {
  if (!isObj(record)) return null;
  const err = record["last_error"];
  if (typeof err !== "string" || err === "") return null;
  if (REFUSED.test(err)) return LOGIN_EXPIRED;
  const expires = typeof record["expires_at"] === "string" ? Date.parse(record["expires_at"]) : NaN;
  return Number.isFinite(expires) && expires <= now ? LOGIN_EXPIRED : null;
}

/** An error pi showed in the chat that is the login's (pi-ai's refresh
 * failure, or the provider refusing the token). */
export function isLoginError(text: string): boolean {
  return PI_AUTH_ERROR_RE.test(text) || /OAuth refresh failed/i.test(text);
}

export interface HostLoginOwnerOptions extends Pick<HoldOptions, "flockBin" | "waitMs"> {
  /** The home's pi agent dir: its auth.json, and the refresher's files beside it. */
  loginDir: string;
  now: () => number;
  /** Where flock cannot tell: does auto-review's daemon run here? */
  daemonRuns?: () => Promise<boolean | null>;
  read?: (p: string) => string;
}

/** The login in the home's own pi agent dir, beside the refresher that may
 * hold it. */
export function hostLoginOwner(o: HostLoginOwnerOptions): LoginOwnerPort {
  const read = o.read ?? ((p: string) => readFileSync(p, "utf8"));
  const probe = {
    ...(o.flockBin ? { flockBin: o.flockBin } : {}),
    ...(o.daemonRuns ? { refresherRuns: o.daemonRuns } : {}),
  };
  return {
    health: async (): Promise<Known<LoginHealth>> => {
      const runs = await refresherRuns(o.loginDir, probe);
      if (runs === null) return unknown("can't tell whether auto-review's login refresher runs");
      if (!runs) return known({ refresher: "home" });
      let record: unknown;
      try {
        record = JSON.parse(read(join(o.loginDir, STATUS_FILE)));
      } catch {
        // it has not written one yet: nothing says the login fails
        return known({ refresher: "auto-review" });
      }
      const why = expiredWhy(record, o.now());
      const checked =
        isObj(record) && typeof record["checked_at"] === "string"
          ? Date.parse(record["checked_at"])
          : NaN;
      return known({
        refresher: "auto-review",
        ...(why ? { expired: why } : {}),
        ...(Number.isFinite(checked) ? { checkedAt: checked } : {}),
      });
    },
    hold: (): Promise<LoginHold> =>
      holdRefresher(o.loginDir, { ...probe, ...(o.waitMs ? { waitMs: o.waitMs } : {}) }),
  };
}

// ---- the re-login -----------------------------------------------------------

export interface ReloginOptions {
  model: HomeModel;
  /** The box's login: the refresher to pause. Absent: nothing is paused. */
  owner: LoginOwnerPort | undefined;
  /** pi's device login, once pi's session exists. */
  deviceLogin: () => DeviceLoginPort | undefined;
  onChange?: () => void;
}

interface Signing {
  ac: AbortController;
  code?: DeviceCode;
  onCode?: (code: DeviceCode) => void;
}

/** "login expired" → one key, or `home_relogin`: sign in again. */
export class Relogin {
  private signing: Signing | null = null;
  private closed = false;

  constructor(private readonly o: ReloginOptions) {}

  /** A re-login in flight: its code once pi has one. */
  running(): { code?: DeviceCode } | null {
    return this.signing === null ? null : this.signing.code ? { code: this.signing.code } : {};
  }

  private changed(): void {
    this.o.onChange?.();
  }

  /** Sign in again. The answer comes once the code is shown (or the login
   * ended): the sign-in goes on in the background. */
  async start(): Promise<string> {
    const m = this.o.model;
    const s = this.signing;
    if (s !== null)
      return s.code
        ? `Still waiting: open ${s.code.verificationUri} and enter ${s.code.userCode}.`
        : "The sign-in is starting: the code shows in a moment.";
    if (this.closed) return "the home has closed";
    const provider = m.chatProvider();
    const label = providerLabel(provider);
    const port = DEVICE_LOGIN_PROVIDERS.has(provider) ? this.o.deviceLogin() : undefined;
    if (port === undefined) {
      const why = `sign in to ${label} again with pi's own /login (switch auto-review off first, so its refresher does not write over the new login)`;
      m.say(`${why[0]!.toUpperCase()}${why.slice(1)}.`, "warn");
      return why;
    }
    const signing: Signing = { ac: new AbortController() };
    this.signing = signing;
    this.changed();
    // the refresher first, when one runs: it keeps its lock and stops writing
    let hold: LoginHold;
    try {
      hold = this.o.owner
        ? await this.o.owner.hold()
        : { ok: true, held: false, release: () => {} };
    } catch (err) {
      hold = { ok: false, why: message(err) };
    }
    if (!hold.ok) {
      this.signing = null;
      m.say(`Couldn't sign in again: ${hold.why}. Nothing changed.`, "warn");
      this.changed();
      return `the sign-in did not start: ${hold.why}`;
    }
    const release = hold.release;
    const held = hold.held;
    if (signing.ac.signal.aborted) {
      release();
      this.signing = null;
      return "the home has closed";
    }
    m.say(`Signing in to ${label} again with pi's device code.`);
    let answer!: (text: string) => void;
    const answered = new Promise<string>((r) => (answer = r));
    signing.onCode = (c) => {
      m.say(`Open ${c.verificationUri} and enter the code ${c.userCode}.`);
      answer(
        `Open ${c.verificationUri} and enter the code ${c.userCode}. The home finishes the sign-in once you approve it.`,
      );
    };
    void (async () => {
      let outcome: { ok: true } | { ok: false; kind: LoginFailureKind; why: string };
      try {
        outcome = await port.login({
          provider,
          signal: signing.ac.signal,
          onCode: (code) => {
            signing.code = code;
            signing.onCode?.(code);
            this.changed();
          },
        });
      } catch (err) {
        outcome = { ok: false, kind: "failed", why: message(err) };
      } finally {
        // the pause is lifted whatever happened: the refresher re-reads the file
        release();
        this.signing = null;
      }
      if (outcome.ok) {
        m.signedInAgain();
        await m.refresh();
        m.say(
          `Signed in to ${label} again.${held ? " Auto-review's refresher has the new login, and auto-review resumes." : ""}`,
          "ok",
        );
        answer(`signed in to ${label} again`);
      } else {
        if (outcome.kind !== "cancelled") m.say(loginFailureText(outcome, RELOGIN_KEY), "warn");
        answer(`the sign-in did not finish: ${outcome.why}`);
      }
      this.changed();
    })();
    return answered;
  }

  /** The session ends: a re-login in flight stops, and its pause is lifted. */
  close(): void {
    this.closed = true;
    this.signing?.ac.abort();
  }
}
