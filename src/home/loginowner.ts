// One login per box, as the home sees it: who refreshes the logins pi stores
// (any provider's), whether they still work, and the sign-in that adds or
// replaces one safely.
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
//   sign-in   pi's own /login, with every provider pi offers (LoginMenu):
//             the setup card's first step and the re-login both open it, with
//             the entrypoint's handover around it
//             (src/loginrefresh/handover.ts): a running refresher is paused
//             first, and keeps its lock, so its refresh can never land on top
//             of the new login; the pause is lifted after, and the refresher
//             re-reads the new login at once, so auto-review resumes on it.
//             The home cannot see pi's menu close. The pause lasts until what
//             the sign-in was for is true (pi has a credential; a stored
//             login was replaced), the person sends the chat a message (the
//             menu is gone then), the session ends, or LOGIN_MENU_MAX_MS.
//             A menu closed with Esc is one the home still takes for open:
//             the sign-in's own key puts /login up again, under the same
//             pause and the same wait (LoginMenu.reopen).
//
// Nothing here reads or prints a token: the refresher's status file carries
// expiry times and redacted errors only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { providerErrorKind } from "@quickchatai/pi-quickreview/src/modelerrors.js";
import { holdRefresher, refresherRuns, type HoldOptions } from "../loginrefresh/handover.js";
import { STATUS_FILE } from "../loginrefresh/refresher.js";
import type { HomeModel } from "./model.js";
import {
  known,
  unknown,
  type Known,
  type LoginHealth,
  type LoginHold,
  type LoginOwnerPort,
} from "./ports.js";

/** What the login line says of a login that no longer works. */
export const LOGIN_EXPIRED = "login expired";
/** The key that signs in again, while typing (the panel's is `l`). */
export const RELOGIN_KEY = "alt+l";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A refresh refused for good: the provider refused the credential (the grant
 * is gone), not a network blip, a rate limit or an outage. The refresher
 * joins one failure per login with "; ", and each is read by itself by the
 * one classifier (src/modelerrors.ts), so a rate limit on one login cannot
 * hide a refused grant on another. */
function refused(lastError: string): boolean {
  return lastError.split("; ").some((failure) => providerErrorKind(failure) === "auth");
}

/** Why the refresher's record (its loginrefresh.status.json) says the login
 * no longer works, or null. Pure. */
export function expiredWhy(record: unknown, now: number): string | null {
  if (!isObj(record)) return null;
  const err = record["last_error"];
  if (typeof err !== "string" || err === "") return null;
  if (refused(err)) return LOGIN_EXPIRED;
  const expires = typeof record["expires_at"] === "string" ? Date.parse(record["expires_at"]) : NaN;
  return Number.isFinite(expires) && expires <= now ? LOGIN_EXPIRED : null;
}

/** An error pi showed in the chat that is the login's (pi-ai's refresh
 * failure, or the provider refusing the credential): the classifier's `auth`
 * kind. A refused model, a rate limit or a spent usage window is not. */
export function isLoginError(text: string): boolean {
  return providerErrorKind(text) === "auth";
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

// ---- pi's own /login --------------------------------------------------------

/** How often a sign-in in flight looks whether it is done. */
export const LOGIN_POLL_MS = 1000;
/** The longest a sign-in keeps the refresher paused: a menu left open and
 * forgotten must not hold auto-review's refresher for good. */
export const LOGIN_MENU_MAX_MS = 15 * 60_000;

/** pi's own /login, as the home opens it: extensions/home.ts builds it over
 * the login route's submitThroughEditor. */
export interface LoginMenuPort {
  /** Open pi's login menu. "opened": it is on screen. "prefilled": `/login`
   * is on the input line, for one Enter. null: this pi gives the home no way
   * to open it (no terminal). */
  open(): "opened" | "prefilled" | null;
}

/** How a sign-in ended. `held` says a refresher was paused around it. */
export type LoginMenuEnd =
  /** What the sign-in was for is true. */
  | { kind: "done"; held: boolean }
  /** The person went back to the chat before it was. */
  | { kind: "left"; held: boolean }
  /** LOGIN_MENU_MAX_MS passed. */
  | { kind: "timeout"; held: boolean }
  /** Another sign-in is in flight: nothing was opened. */
  | { kind: "busy" }
  /** This pi gave no way to open its menu: nothing was paused. */
  | { kind: "no-menu" }
  /** The refresher could not be paused: nothing was opened. */
  | { kind: "no-hold"; why: string }
  /** The session ended. */
  | { kind: "closed" };

export interface LoginMenuOptions {
  /** The box's stored logins: the refresher to pause. Absent: nothing is paused. */
  owner: LoginOwnerPort | undefined;
  /** pi's menu, once pi's session exists. */
  menu: () => LoginMenuPort | undefined;
  /** Run `fn` once after `ms`; the returned function cancels it. */
  after: (ms: number, fn: () => void) => () => void;
  now: () => number;
  onChange?: () => void;
}

interface OpenMenu {
  /** End it; a no-op until the menu is open, and after the first call. */
  finish: (end: LoginMenuEnd) => void;
  /** Look once more whether it is done, then end it as left. */
  leave: () => void;
  /** Put pi's menu up again; null until the first open is through. */
  again: () => "opened" | "prefilled" | null;
}

/** pi's /login with the refresher held around it: one at a time, for the
 * setup card's sign-in and the re-login alike. */
export class LoginMenu {
  private open: OpenMenu | null = null;
  private closed = false;

  constructor(private readonly o: LoginMenuOptions) {}

  /** A sign-in is in flight. */
  running(): boolean {
    return this.open !== null;
  }

  /**
   * Pause the refresher when one runs, open pi's /login, and wait until
   * `done` answers true, the person leaves, the session ends or the ceiling
   * passes; then lift the pause. `opened` is told once the menu is up.
   * Never throws.
   */
  async run(w: {
    done: () => Promise<boolean>;
    opened?: (how: "opened" | "prefilled") => void;
  }): Promise<LoginMenuEnd> {
    if (this.closed) return { kind: "closed" };
    if (this.open !== null) return { kind: "busy" };
    const menu = this.o.menu();
    if (menu === undefined) return { kind: "no-menu" };
    const mine: OpenMenu = { finish: () => {}, leave: () => {}, again: () => null };
    this.open = mine;
    this.o.onChange?.();
    const drop = (): void => {
      if (this.open === mine) this.open = null;
      this.o.onChange?.();
    };
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
      drop();
      return { kind: "no-hold", why: hold.why };
    }
    const { held, release } = hold;
    if (this.closed) {
      release();
      drop();
      return { kind: "closed" };
    }
    let how: "opened" | "prefilled" | null;
    try {
      how = menu.open();
    } catch {
      how = null;
    }
    if (how === null) {
      release();
      drop();
      return { kind: "no-menu" };
    }
    const started = this.o.now();
    let cancel: (() => void) | null = null;
    let settled = false;
    let end!: (e: LoginMenuEnd) => void;
    const ended = new Promise<LoginMenuEnd>((r) => (end = r));
    mine.finish = (e) => {
      if (settled) return;
      settled = true;
      cancel?.();
      cancel = null;
      // the pause is lifted whatever happened: the refresher re-reads the file
      release();
      drop();
      end(e);
    };
    const isDone = async (): Promise<boolean> => {
      try {
        return await w.done();
      } catch {
        return false;
      }
    };
    mine.leave = () => {
      cancel?.();
      cancel = null;
      // a login made just before the message still counts
      void isDone().then((done) => mine.finish({ kind: done ? "done" : "left", held }));
    };
    const poll = (): void => {
      cancel = this.o.after(LOGIN_POLL_MS, () => {
        cancel = null;
        void isDone().then((done) => {
          if (settled) return;
          if (done) mine.finish({ kind: "done", held });
          else if (this.o.now() - started >= LOGIN_MENU_MAX_MS)
            mine.finish({ kind: "timeout", held });
          else poll();
        });
      });
    };
    mine.again = () => {
      if (settled) return null;
      try {
        return menu.open();
      } catch {
        return null;
      }
    };
    w.opened?.(how);
    poll();
    return ended;
  }

  /** The person pressed the sign-in's key while one is in flight: pi's menu
   * may have been closed with Esc, which the home cannot see, so /login is
   * put up again. The pause and the wait are the ones already running: no
   * second hold, no second poll. null: no sign-in has its menu up yet, or
   * this pi gave no way. */
  reopen(): "opened" | "prefilled" | null {
    return this.open?.again() ?? null;
  }

  /** The person sent the chat a message: pi's menu is gone. */
  left(): void {
    this.open?.leave();
  }

  /** The session ends: a sign-in in flight stops, and its pause is lifted. */
  close(): void {
    this.closed = true;
    this.open?.finish({ kind: "closed" });
  }
}

// ---- the re-login -----------------------------------------------------------

export interface ReloginOptions {
  model: HomeModel;
  /** pi's /login with the refresher held: the one the setup card uses too. */
  menu: LoginMenu;
  /** The login file's stamps: what tells that a stored login was replaced.
   * Absent: the home cannot tell, and the sign-in ends when the person goes
   * back to the chat. */
  stamps?: () => Promise<Known<ReadonlyMap<string, string>>>;
  /** Auto-review's refresher may run here (the home has a login owner). */
  shared: boolean;
  onChange?: () => void;
}

/** The provider whose stored credential is new or reads differently now;
 * null when none does, or when either read is unknown. Pure. */
export function replacedLogin(
  before: Known<ReadonlyMap<string, string>> | null,
  after: Known<ReadonlyMap<string, string>> | null,
): string | null {
  if (before?.kind !== "known" || after?.kind !== "known") return null;
  for (const [provider, stamp] of after.value)
    if (before.value.get(provider) !== stamp) return provider;
  return null;
}

/** "login expired" → one key, or `home_relogin`: sign in again, to any
 * provider, with pi's own /login. */
export class Relogin {
  private active = false;

  constructor(private readonly o: ReloginOptions) {}

  /** A re-login is in flight. */
  running(): boolean {
    return this.active;
  }

  private async stamps(): Promise<Known<ReadonlyMap<string, string>> | null> {
    const read = this.o.stamps;
    if (read === undefined) return null;
    try {
      return await read();
    } catch (err) {
      return unknown(message(err));
    }
  }

  /** Sign in again. The answer comes once pi's menu is open (or the sign-in
   * could not start): the sign-in itself goes on in the background. `again`
   * is the person's own key: pressed while a sign-in is in flight it puts
   * pi's /login up again (a menu closed with Esc), under the same pause. A
   * tool's call does not, for the menu may be open in front of the person. */
  async start(o: { again?: boolean } = {}): Promise<string> {
    const m = this.o.model;
    if (this.active || this.o.menu.running()) {
      const how = o.again === true ? this.o.menu.reopen() : null;
      if (how === null) return "pi's /login is open already: finish the sign-in in pi's menu.";
      const said =
        how === "opened"
          ? "Signing in again: pi's /login is open."
          : "Signing in again: /login is on the input line, press Enter to open pi's menu.";
      m.say(said);
      return said;
    }
    this.active = true;
    this.o.onChange?.();
    const before = await this.stamps();
    let replaced: string | null = null;
    let answer!: (text: string) => void;
    const answered = new Promise<string>((r) => (answer = r));
    void this.o.menu
      .run({
        done: async () => {
          replaced = replacedLogin(before, await this.stamps());
          return replaced !== null;
        },
        opened: (how) => {
          const said =
            how === "opened"
              ? "Signing in again: pi's /login is open."
              : "Signing in again: /login is on the input line, press Enter to open pi's menu.";
          m.say(said);
          answer(
            `${said} The person picks the provider there; the home sees the new login by itself.`,
          );
        },
      })
      .then(async (end) => {
        this.active = false;
        answer(await this.ended(end, replaced));
        this.o.onChange?.();
      });
    return answered;
  }

  /** Say how the sign-in ended; the text is the tool's answer when the menu
   * never opened. */
  private async ended(end: LoginMenuEnd, replaced: string | null): Promise<string> {
    const m = this.o.model;
    switch (end.kind) {
      case "done": {
        m.signedInAgain();
        await m.refresh();
        const name = replaced !== null ? m.nameOf(replaced) : "pi";
        m.say(
          `Signed in to ${name} again.${end.held ? " Auto-review's refresher has the new login, and auto-review resumes." : ""}`,
          "ok",
        );
        return `signed in to ${name} again`;
      }
      case "left":
      case "timeout": {
        await m.refresh();
        const why =
          this.o.stamps === undefined
            ? `pi's /login is closed. ${RELOGIN_KEY} opens it again`
            : `pi's /login closed and no stored login changed. ${RELOGIN_KEY} opens it again`;
        m.say(`${why}.`, "warn");
        return `the sign-in did not finish: ${why}`;
      }
      case "no-menu": {
        const why = `type /login to sign in again with pi's own menu${this.o.shared ? " (switch auto-review off first, so its refresher does not write over the new login)" : ""}`;
        m.say(`${why[0]!.toUpperCase()}${why.slice(1)}.`, "warn");
        return why;
      }
      case "no-hold":
        m.say(`Couldn't sign in again: ${end.why}. Nothing changed.`, "warn");
        return `the sign-in did not start: ${end.why}`;
      case "busy":
        return "pi's /login is open already: finish the sign-in in pi's menu.";
      case "closed":
        return "the home has closed";
    }
  }
}
