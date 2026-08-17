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
      tier: "owner_legacy",
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

  it("an expired record authorises nothing and is pruned", () => {
    origins.write("a.md", { event_id: "EvA", slack_user: "U0A", tier: "owner_legacy", authorized_prs: [] });
    at(ORIGIN_TTL_MS - 1);
    expect(origins.latest()?.event_id).toBe("EvA");
    at(ORIGIN_TTL_MS + 1);
    expect(origins.latest()).toBeNull();
    origins.prune();
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("latest() is null when the directory does not exist yet", () => {
    expect(new OriginStore(join(dir, "nope"), now).latest()).toBeNull();
  });

  it("garbage and wrong-shaped files grant nothing", () => {
    writeFileSync(join(dir, "junk.json"), "{ not json");
    writeFileSync(join(dir, "shape.json"), JSON.stringify({ tier: "owner_legacy" }));
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
