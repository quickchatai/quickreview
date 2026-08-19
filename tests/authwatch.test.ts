// Passive pi auth-failure detection (src/authwatch.ts) + its surfaces:
// status.json flag, WAKE-grade anomaly, and the TUI alert bridge. Ratified
// 2026-08-19 (the owner): NO smoke calls — detection is purely observational
// over the session JSONLs pi already writes.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AUTH_TAIL_BYTES, PI_AUTH_ERROR_RE, PiAuthWatch, scanPiAuthErrors } from "../src/authwatch.js";
import { anomalySeverity } from "../src/anomalies.js";
import { buildStatusSnapshot, StateStore } from "../src/state.js";
import { maybeWritePiAuthAlert } from "../src/tui/alerts.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-authwatch-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const ERR = '{"errorMessage":"Provided authentication token is expired."}\n';

function jsonl(rel: string, content: string, mtime?: Date): string {
  const path = join(dir, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

describe("scanPiAuthErrors", () => {
  it("matches the live error signature, in nested per-cwd dirs, tail-only", () => {
    expect(PI_AUTH_ERROR_RE.test(ERR)).toBe(true);
    jsonl("--opt-quickreview-sandbox--/a.jsonl", "x".repeat(200) + ERR);
    // A file larger than the tail window with the error OUTSIDE the tail is
    // (deliberately) not matched — live failures sit at the end of the file.
    jsonl("--opt-quickreview-sandbox--/old-error.jsonl", ERR + "y".repeat(AUTH_TAIL_BYTES + 1024));
    jsonl("clean.jsonl", '{"ok":true}\n');
    jsonl("not-a-session.txt", ERR);
    const hits = scanPiAuthErrors(dir, 0);
    expect(hits.map((h) => h.file.split("/").pop())).toEqual(["a.jsonl"]);
  });

  it("ignores files older than sinceMs", () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    jsonl("stale.jsonl", ERR, old);
    expect(scanPiAuthErrors(dir, Date.now() - 10 * 60 * 1000)).toEqual([]);
  });

  it("a missing dir is quiet, never a throw", () => {
    expect(scanPiAuthErrors(join(dir, "nope"), 0)).toEqual([]);
  });
});

describe("PiAuthWatch", () => {
  it("reports new hits, keeps the status flag fresh for 30 min, then clears", () => {
    let t = Date.parse("2026-08-19T15:00:00Z");
    const watch = new PiAuthWatch(dir, () => new Date(t));
    expect(watch.scan()).toEqual([]);
    expect(watch.status()).toBeUndefined();

    jsonl("s.jsonl", ERR, new Date(t));
    t += 60_000;
    expect(watch.scan()).toHaveLength(1);
    const flag = watch.status();
    expect(flag).toBeDefined();
    expect(flag!.hits).toBe(1);

    // 29 min later: still flagged; 31 min later: self-cleared.
    t += 29 * 60_000;
    expect(watch.status()).toBeDefined();
    t += 2 * 60_000;
    expect(watch.status()).toBeUndefined();
  });
});

describe("surfaces", () => {
  it("pi_auth_expired is a WAKE-grade anomaly", () => {
    expect(anomalySeverity("pi_auth_expired")).toBe("wake");
  });

  it("status.json carries the flag only when passed", () => {
    const store = new StateStore(":memory:");
    const now = () => new Date("2026-08-19T15:00:00Z");
    expect(buildStatusSnapshot(store, false, undefined, now)).not.toHaveProperty("pi_auth_expired");
    const snap = buildStatusSnapshot(store, false, undefined, now, undefined, { last_at: "2026-08-19T14:59:00Z", hits: 3 });
    expect(snap.pi_auth_expired).toEqual({ last_at: "2026-08-19T14:59:00Z", hits: 3 });
    store.close();
  });

  it("the TUI bridge writes ONE alert file per distinct detection, skips stale flags", () => {
    const alertsDir = join(dir, "alerts");
    const mem = { lastWritten: "" };
    const now = () => new Date("2026-08-19T15:05:00Z");
    const flag = { last_at: "2026-08-19T15:04:00Z", hits: 2 };

    const name = maybeWritePiAuthAlert(alertsDir, flag, mem, now);
    expect(name).toMatch(/pi-auth-expired\.json$/);
    const body = JSON.parse(readFileSync(join(alertsDir, name!), "utf8"));
    expect(body).toMatchObject({ tier: "alert", cause: "pi-auth-expired", pr: null });

    // Same detection again: no second file. New detection: one more.
    expect(maybeWritePiAuthAlert(alertsDir, flag, mem, now)).toBeUndefined();
    expect(maybeWritePiAuthAlert(alertsDir, { last_at: "2026-08-19T15:06:00Z", hits: 3 }, mem, () => new Date("2026-08-19T15:07:00Z"))).toBeDefined();
    expect(readdirSync(alertsDir)).toHaveLength(2);

    // A stale flag (>30 min old) is history, not an alert.
    expect(
      maybeWritePiAuthAlert(alertsDir, { last_at: "2026-08-19T14:00:00Z", hits: 9 }, { lastWritten: "" }, () => new Date("2026-08-19T15:07:00Z")),
    ).toBeUndefined();
    // Absent flag: nothing.
    expect(maybeWritePiAuthAlert(alertsDir, undefined, mem, now)).toBeUndefined();
  });
});
