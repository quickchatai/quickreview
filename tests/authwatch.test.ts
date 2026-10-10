// Passive pi auth-failure detection (src/authwatch.ts) + its surfaces:
// status.json flag, wake-grade anomaly, and the TUI alert bridge. No smoke
// calls: detection is purely observational over the session JSONLs pi
// already writes.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_TAIL_BYTES,
  PI_AUTH_ERROR_RE,
  PiAuthWatch,
  scanPiAuthErrors,
} from "../src/authwatch.js";
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
    jsonl(
      "--opt-quickreview-sandbox--/a.jsonl",
      JSON.stringify({ pad: "x".repeat(200) }) + "\n" + ERR,
    );
    // A file larger than the tail window with the error OUTSIDE the tail is
    // (deliberately) not matched — live failures sit at the end of the file.
    jsonl("--opt-quickreview-sandbox--/old-error.jsonl", ERR + "y".repeat(AUTH_TAIL_BYTES + 1024));
    jsonl("clean.jsonl", '{"ok":true}\n');
    jsonl("not-a-session.txt", ERR);
    const hits = scanPiAuthErrors(dir, 0);
    expect(hits.map((h) => h.file.split("/").pop())).toEqual(["a.jsonl"]);
  });

  it("quoted text is not an auth failure: only a record's errorMessage field counts", () => {
    // A reviewer session reads a PR touching OAuth code: the tool result
    // carries the signature as TEXT — even spelled as a JSON errorMessage.
    const toolResult = JSON.stringify({
      type: "message",
      message: {
        role: "toolResult",
        content: [
          {
            type: "text",
            text: 'raise OAuthError("invalid_grant")  # 401 Unauthorized\n{"errorMessage":"Provided authentication token is expired."}',
          },
        ],
      },
    });
    jsonl(
      "--opt-quickreview-sandbox--/quoted.jsonl",
      toolResult + "\n" + "not json: invalid_grant\n",
    );
    // The live shape: an assistant message pi stopped with an error.
    const real = JSON.stringify({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "Provided authentication token is expired.",
      },
    });
    jsonl("--opt-quickreview-sandbox--/real.jsonl", real + "\n");
    const hits = scanPiAuthErrors(dir, 0);
    expect(hits.map((h) => h.file.split("/").pop())).toEqual(["real.jsonl"]);
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

  it("an OLD error still in the tail is not re-counted when healthy turns are appended", () => {
    // Token expired, operator re-ran /login, the session keeps writing
    // successful turns: the old error line stays inside the 128 KiB tail.
    let t = Date.parse("2026-08-19T15:00:00Z");
    const watch = new PiAuthWatch(dir, () => new Date(t));
    const path = jsonl("s.jsonl", ERR, new Date(t));
    t += 60_000;
    expect(watch.scan()).toHaveLength(1);
    for (let i = 0; i < 40; i++) {
      writeFileSync(path, '{"ok":true}\n', { flag: "a" });
      utimesSync(path, new Date(t), new Date(t));
      t += 60_000;
      expect(watch.scan()).toEqual([]);
    }
    expect(watch.status()).toBeUndefined(); // cleared 30 min after the last REAL error
    // A genuinely NEW error in the same file is still caught.
    writeFileSync(path, ERR, { flag: "a" });
    utimesSync(path, new Date(t), new Date(t));
    t += 60_000;
    expect(watch.scan()).toHaveLength(1);
    expect(watch.status()!.hits).toBe(2);
  });

  it("an error line split across two scans is still caught", () => {
    let t = Date.parse("2026-08-19T15:00:00Z");
    const watch = new PiAuthWatch(dir, () => new Date(t));
    const half = ERR.indexOf("token") + 3;
    const path = jsonl("s.jsonl", '{"ok":true}\n' + ERR.slice(0, half), new Date(t));
    t += 60_000;
    expect(watch.scan()).toEqual([]);
    writeFileSync(path, ERR.slice(half), { flag: "a" });
    utimesSync(path, new Date(t), new Date(t));
    t += 60_000;
    expect(watch.scan()).toHaveLength(1);
  });

  it("an error line whose newline lands a scan later is counted ONCE", () => {
    let t = Date.parse("2026-08-19T15:00:00Z");
    const watch = new PiAuthWatch(dir, () => new Date(t));
    const path = jsonl("s.jsonl", ERR.slice(0, -1), new Date(t)); // no trailing \n yet
    t += 60_000;
    watch.scan();
    writeFileSync(path, "\n", { flag: "a" });
    utimesSync(path, new Date(t), new Date(t));
    t += 60_000;
    watch.scan();
    expect(watch.status()!.hits).toBe(1);
  });
});

// The archiver unlinks closed PRs' transcripts and
// removes their dirs; the per-file offset map must follow the live tree, not
// keep every file that ever existed.
describe("the seen map follows the live tree", () => {
  it("shrinks once source files are unlinked — a whole session dir, or one file", () => {
    let t = Date.parse("2026-10-21T12:00:00Z");
    const watch = new PiAuthWatch(dir, () => new Date(t));
    const files = [
      jsonl("pr-1/a.jsonl", '{"ok":true}\n', new Date(t)),
      jsonl("pr-1/b.jsonl", '{"ok":true}\n', new Date(t)),
      jsonl("pr-2/c.jsonl", '{"ok":true}\n', new Date(t)),
      jsonl("pr-3/d.jsonl", '{"ok":true}\n', new Date(t)),
    ];
    t += 60_000;
    watch.scan();
    expect(watch.trackedFiles()).toBe(4);
    // The archiver: pr-1 archived whole (files unlinked, dir rmdir'd), one of
    // pr-2's files gone.
    rmSync(join(dir, "pr-1"), { recursive: true });
    rmSync(files[2]!);
    t += 60_000;
    watch.scan();
    expect(watch.trackedFiles()).toBe(1);
    // An OLD file the scan no longer reads (mtime before the window) is
    // live, so its offset is kept — pruning is about absence, not age.
    t += 3_600_000;
    watch.scan();
    expect(watch.trackedFiles()).toBe(1);
  });

  it("a directory that cannot be listed keeps its entries — unknown is never gone", () => {
    const seen = new Map<string, number>();
    const t = Date.parse("2026-10-21T12:00:00Z");
    jsonl("pr-1/a.jsonl", '{"ok":true}\n', new Date(t));
    scanPiAuthErrors(dir, 0, seen);
    expect([...seen.keys()]).toEqual([join(dir, "pr-1", "a.jsonl")]);
    // Another root's entries are never this root's to prune.
    seen.set("/elsewhere/x.jsonl", 10);
    // The root itself unreadable (here: a file where the dir was).
    rmSync(dir, { recursive: true });
    mkdirSync(join(dir, ".."), { recursive: true });
    writeFileSync(dir, "not a dir");
    scanPiAuthErrors(dir, 0, seen);
    expect(seen.has(join(dir, "pr-1", "a.jsonl"))).toBe(true);
    expect(seen.has("/elsewhere/x.jsonl")).toBe(true);
    rmSync(dir);
    // The root gone entirely: its files are gone too.
    scanPiAuthErrors(dir, 0, seen);
    expect(seen.has(join(dir, "pr-1", "a.jsonl"))).toBe(false);
    expect(seen.has("/elsewhere/x.jsonl")).toBe(true);
    mkdirSync(dir);
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
    const snap = buildStatusSnapshot(store, false, undefined, now, undefined, {
      last_at: "2026-08-19T14:59:00Z",
      hits: 3,
    });
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
    expect(
      maybeWritePiAuthAlert(
        alertsDir,
        { last_at: "2026-08-19T15:06:00Z", hits: 3 },
        mem,
        () => new Date("2026-08-19T15:07:00Z"),
      ),
    ).toBeDefined();
    expect(readdirSync(alertsDir)).toHaveLength(2);

    // A stale flag (>30 min old) is history, not an alert.
    expect(
      maybeWritePiAuthAlert(
        alertsDir,
        { last_at: "2026-08-19T14:00:00Z", hits: 9 },
        { lastWritten: "" },
        () => new Date("2026-08-19T15:07:00Z"),
      ),
    ).toBeUndefined();
    // Absent flag: nothing.
    expect(maybeWritePiAuthAlert(alertsDir, undefined, mem, now)).toBeUndefined();
  });
});
