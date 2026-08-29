import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN_TTL_MS, OriginStore, parseOriginRecord } from "../src/slack/origin.js";

const T0 = new Date("2026-08-17T09:00:00.000Z");
let clock = T0;
const now = () => clock;
const at = (ms: number) => {
  clock = new Date(T0.getTime() + ms);
};

let dir: string;
let origins: OriginStore;

beforeEach(() => {
  clock = T0;
  dir = mkdtempSync(join(tmpdir(), "qcr-origin-"));
  origins = new OriginStore(dir, now);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("OriginStore", () => {
  it("writes <inject-basename>.json with a stamped expiry and no tmp files left", () => {
    const rec = origins.write("2026-08-17T09-00-00-000Z-0001.md", {
      event_id: "Ev1",
      slack_user: "U0ALICE",
      tier: "author",
      authorized_prs: [1234, 1240],
    });
    expect(rec.expires_at).toBe(new Date(T0.getTime() + ORIGIN_TTL_MS).toISOString());
    const path = join(dir, "2026-08-17T09-00-00-000Z-0001.json");
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(rec);
    expect(readdirSync(dir).filter((n) => n.includes(".tmp"))).toHaveLength(0);
  });

  it("the TTL cannot be widened from outside — a caller-supplied expiry is ignored", () => {
    const far = new Date(T0.getTime() + 999 * 60_000).toISOString();
    const rec = origins.write("a.md", {
      event_id: "Ev1",
      slack_user: "U",
      tier: "owner",
      authorized_prs: [],
      // deliberately smuggled in
      ...({ expires_at: far } as Record<string, never>),
    });
    expect(rec.expires_at).not.toBe(far);
  });

  it("latest() returns the most recent unexpired record", () => {
    origins.write("a.md", { event_id: "EvA", slack_user: "U0A", tier: "anyone", authorized_prs: [] });
    at(60_000);
    origins.write("b.md", { event_id: "EvB", slack_user: "U0B", tier: "author", authorized_prs: [7] });
    expect(origins.latest()).toMatchObject({ event_id: "EvB", tier: "author", authorized_prs: [7] });
    expect(origins.all()).toHaveLength(2);
  });

  it("an expired record authorises nothing", () => {
    origins.write("a.md", { event_id: "EvA", slack_user: "U0A", tier: "owner", authorized_prs: [] });
    at(ORIGIN_TTL_MS - 1);
    expect(origins.latest()?.event_id).toBe("EvA");
    at(ORIGIN_TTL_MS + 1);
    expect(origins.latest()).toBeNull();
    origins.prune();
    // …but it is still THERE: `latestAny()` (the legacy-dir belt) must keep
    // seeing what caused the last turn, or waiting out the TTL would be an
    // escalation. Only the newest record is kept.
    expect(origins.latestAny()?.event_id).toBe("EvA");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("prune keeps only the newest expired record, never a stale pile", () => {
    origins.write("a.md", { event_id: "EvA", slack_user: "U0A", tier: "anyone", authorized_prs: [] });
    at(60_000);
    origins.write("b.md", { event_id: "EvB", slack_user: "U0B", tier: "author", authorized_prs: [] });
    at(ORIGIN_TTL_MS + 120_000);
    origins.prune();
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual(["b.json"]);
    expect(origins.latestAny()?.event_id).toBe("EvB");
    expect(origins.latest()).toBeNull();
  });

  it("a router write is a `slack` source; writeLocal stamps a daemon turn", () => {
    const slack = origins.write("a.md", { event_id: "EvA", slack_user: "U0A", tier: "author", authorized_prs: [9] });
    expect(slack.source).toBe("slack");
    at(ORIGIN_TTL_MS * 3); // the Slack turn is long expired
    const local = origins.writeLocal("eod-sweep");
    expect(local).toMatchObject({ source: "local", tier: "system", slack_user: "", authorized_prs: [] });
    expect(local.event_id).toBe("local:eod-sweep");
    // The daemon wake supersedes the Slack origin for the belt…
    expect(origins.latestAny()).toMatchObject({ source: "local", tier: "system" });
    // …and it is a live origin like any other for the Slack dir.
    expect(origins.latest()?.source).toBe("local");
  });

  it("a record with no `source` on disk reads as `slack` — the restricting value", () => {
    writeFileSync(
      join(dir, "old.json"),
      JSON.stringify({
        event_id: "EvOld",
        slack_user: "U0A",
        tier: "anyone",
        authorized_prs: [],
        expires_at: new Date(T0.getTime() + 60_000).toISOString(),
      }),
    );
    expect(origins.latest()?.source).toBe("slack");
    expect(parseOriginRecord({ source: "nonsense", event_id: "E", slack_user: "U", tier: "anyone", authorized_prs: [], expires_at: T0.toISOString() })?.source).toBe("slack");
  });

  it("remove() drops a record and rename() moves it to the inject basename", () => {
    origins.write("event-Ev1", { event_id: "Ev1", slack_user: "U0A", tier: "author", authorized_prs: [] });
    origins.rename("event-Ev1", "wake-0007.md");
    expect(existsSync(join(dir, "wake-0007.json"))).toBe(true);
    expect(existsSync(join(dir, "event-Ev1.json"))).toBe(false);
    expect(origins.latest()?.event_id).toBe("Ev1");
    origins.remove("wake-0007.md");
    expect(origins.latestAny()).toBeNull();
    origins.rename("gone", "also-gone"); // missing source is a no-op, never a throw
  });

  it("latest() is null when the directory does not exist yet", () => {
    expect(new OriginStore(join(dir, "nope"), now).latest()).toBeNull();
  });

  it("garbage and wrong-shaped files grant nothing", () => {
    writeFileSync(join(dir, "junk.json"), "{ not json");
    writeFileSync(join(dir, "shape.json"), JSON.stringify({ tier: "owner" }));
    writeFileSync(join(dir, "badtier.json"), JSON.stringify({ event_id: "E", slack_user: "U", tier: "root", authorized_prs: [], expires_at: new Date(T0.getTime() + 60_000).toISOString() }));
    expect(origins.latest()).toBeNull();
  });

  it("parseOriginRecord drops non-integer PR entries", () => {
    const rec = parseOriginRecord({
      event_id: "E",
      slack_user: "U",
      tier: "author",
      authorized_prs: [1, "2", 3.5, -4, 5],
      expires_at: T0.toISOString(),
    });
    expect(rec?.authorized_prs).toEqual([1, 5]);
  });
});
