import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ORIGIN_TTL_MS, OriginStore, parseOriginRecord } from "../src/slack/origin.js";
import type { SlackTier } from "../src/state.js";

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
      ...({ expires_at: far } as unknown as Record<string, never>),
    });
    expect(rec.expires_at).not.toBe(far);
  });

  it("latest() returns the most recent unexpired record", () => {
    origins.write("a.md", {
      event_id: "EvA",
      slack_user: "U0A",
      tier: "anyone",
      authorized_prs: [],
    });
    at(60_000);
    origins.write("b.md", {
      event_id: "EvB",
      slack_user: "U0B",
      tier: "author",
      authorized_prs: [7],
    });
    expect(origins.latest()).toMatchObject({
      event_id: "EvB",
      tier: "author",
      authorized_prs: [7],
    });
    expect(origins.all()).toHaveLength(2);
  });

  it("an expired record authorises nothing", () => {
    origins.write("a.md", {
      event_id: "EvA",
      slack_user: "U0A",
      tier: "owner",
      authorized_prs: [],
    });
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
    origins.write("a.md", {
      event_id: "EvA",
      slack_user: "U0A",
      tier: "anyone",
      authorized_prs: [],
    });
    at(60_000);
    origins.write("b.md", {
      event_id: "EvB",
      slack_user: "U0B",
      tier: "author",
      authorized_prs: [],
    });
    at(ORIGIN_TTL_MS + 120_000);
    origins.prune();
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual(["b.json"]);
    expect(origins.latestAny()?.event_id).toBe("EvB");
    expect(origins.latest()).toBeNull();
  });

  it("a router write is a `slack` source; writeLocal stamps a daemon turn", () => {
    const slack = origins.write("a.md", {
      event_id: "EvA",
      slack_user: "U0A",
      tier: "author",
      authorized_prs: [9],
    });
    expect(slack.source).toBe("slack");
    at(ORIGIN_TTL_MS * 3); // the Slack turn is long expired
    const local = origins.writeLocal("eod-sweep");
    expect(local).toMatchObject({
      source: "local",
      tier: "system",
      slack_user: "",
      authorized_prs: [],
    });
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
    // The audit view folds it to the restricting value…
    expect(origins.onDisk()[0]?.source).toBe("slack");
    // …and so does a daemon booting over it: the belt is ON (a restricting
    // cause may be trusted from disk), while nothing is authorised by it.
    const booted = new OriginStore(dir, now);
    expect(booted.latestAny()?.source).toBe("slack");
    expect(booted.latest()).toBeNull();
    expect(
      parseOriginRecord({
        source: "nonsense",
        event_id: "E",
        slack_user: "U",
        tier: "anyone",
        authorized_prs: [],
        expires_at: T0.toISOString(),
      })?.source,
    ).toBe("slack");
  });

  it("remove() drops a record and rename() moves it to the inject basename", () => {
    origins.write("event-Ev1", {
      event_id: "Ev1",
      slack_user: "U0A",
      tier: "author",
      authorized_prs: [],
    });
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
    writeFileSync(
      join(dir, "badtier.json"),
      JSON.stringify({
        event_id: "E",
        slack_user: "U",
        tier: "root",
        authorized_prs: [],
        expires_at: new Date(T0.getTime() + 60_000).toISOString(),
      }),
    );
    expect(origins.latest()).toBeNull();
  });

  describe("provenance: a record a session plants on disk grants nothing", () => {
    const forged = (name: string, rec: Record<string, unknown>) =>
      writeFileSync(
        join(dir, name),
        JSON.stringify({
          event_id: "local:eod-sweep",
          slack_user: "",
          authorized_prs: [],
          expires_at: new Date(T0.getTime() + 365 * 86_400_000).toISOString(),
          ...rec,
        }),
      );

    it("a far-future local/system file written mid-turn neither authorises nor lifts the belt", () => {
      origins.write("wake.md", {
        event_id: "EvGuest",
        slack_user: "U0GUEST",
        tier: "anyone",
        authorized_prs: [],
      });
      forged("zzz-forged.json", { source: "local", tier: "system" });
      forged("zzz-owner.json", { source: "slack", slack_user: "U0MAT", tier: "owner" });
      // The Slack dir still sees only the guest's turn…
      expect(origins.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      expect(origins.all()).toHaveLength(1);
      // …and the legacy belt still sees the guest as the cause.
      expect(origins.latestAny()).toMatchObject({ source: "slack", tier: "anyone" });
      // The forgeries are still there for forensics.
      expect(origins.onDisk().map((r) => r.tier)).toContain("system");
    });

    it("with no turn live, a planted grant does not open the Slack dir", () => {
      forged("forged.json", { source: "local", tier: "system" });
      expect(origins.latest()).toBeNull();
    });

    it("at boot, disk may switch the belt ON but never off", () => {
      forged("a.json", { source: "local", tier: "system" });
      expect(new OriginStore(dir, now).latestAny()).toBeNull();
      forged("b.json", {
        source: "slack",
        slack_user: "U0MAT",
        tier: "owner",
        expires_at: new Date(T0.getTime() + 400 * 86_400_000).toISOString(),
      });
      expect(new OriginStore(dir, now).latestAny()).toBeNull();
      forged("c.json", {
        source: "slack",
        slack_user: "U0GUEST",
        tier: "anyone",
        expires_at: new Date(T0.getTime() + 500 * 86_400_000).toISOString(),
      });
      const booted = new OriginStore(dir, now);
      expect(booted.latestAny()).toMatchObject({ tier: "anyone", source: "slack" });
      expect(booted.latest()).toBeNull();
      // A daemon wake in this process supersedes the boot cause.
      booted.writeLocal("eod-sweep");
      expect(booted.latestAny()).toMatchObject({ source: "local", tier: "system" });
    });
  });

  describe("authority follows the turn being served, never a queued wake", () => {
    let inject: string;
    let done: string;
    let served: OriginStore;
    beforeEach(() => {
      inject = join(dir, "inject");
      done = join(inject, ".done");
      mkdirSync(done, { recursive: true });
      served = new OriginStore(join(dir, "origin"), now, { deliveredDir: done });
    });
    /** The router's sequence: provisional record, wake file, bind. */
    const slackTurn = (n: number, user: string, tier: SlackTier, prs: number[] = []) => {
      served.write(`event-Ev${n}`, {
        event_id: `Ev${n}`,
        slack_user: user,
        tier,
        authorized_prs: prs,
      });
      const wake = `wake-${n}.md`;
      writeFileSync(join(inject, wake), "turn\n");
      served.rename(`event-Ev${n}`, wake);
      return wake;
    };
    const accept = (wake: string) => renameSync(join(inject, wake), join(done, wake));

    it("a queued owner message never lends its rights to the running guest turn", () => {
      accept(slackTurn(1, "U0GUEST", "anyone"));
      at(30_000);
      const owner = slackTurn(2, "U0MAT", "owner");
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      expect(served.latestAny()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      // Once pi takes the owner's wake, the guest's turn is over.
      accept(owner);
      expect(served.latest()).toMatchObject({ slack_user: "U0MAT", tier: "owner" });
    });

    it("a queued daemon wake does not lift the belt off the running guest turn", () => {
      accept(slackTurn(1, "U0GUEST", "anyone"));
      at(30_000);
      const local = served.writeLocal("anomaly");
      // Before its wake file exists, and after, until pi accepts it.
      expect(served.latestAny()).toMatchObject({ source: "slack", tier: "anyone" });
      writeFileSync(join(inject, "wake-local.md"), "wake\n");
      served.bind(local, join(inject, "wake-local.md"));
      expect(served.latestAny()).toMatchObject({ source: "slack", tier: "anyone" });
      expect(existsSync(join(dir, "origin", "wake-local.json"))).toBe(true);
      accept("wake-local.md");
      expect(served.latestAny()).toMatchObject({ source: "local", tier: "system" });
    });

    it("a queued guest message restricts a running owner turn (fail closed)", () => {
      accept(slackTurn(1, "U0MAT", "owner"));
      at(30_000);
      slackTurn(2, "U0GUEST", "anyone");
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
    });

    it("two authors overlapping keep only the PRs both are authorised on", () => {
      accept(slackTurn(1, "U0ALICE", "author", [1, 2]));
      slackTurn(2, "U0BOB", "author", [2, 3]);
      expect(served.latest()).toMatchObject({ slack_user: "U0ALICE", authorized_prs: [2] });
    });

    it("an expired running turn authorises nothing, whatever is queued behind it", () => {
      accept(slackTurn(1, "U0GUEST", "anyone"));
      at(ORIGIN_TTL_MS + 1);
      slackTurn(2, "U0MAT", "owner");
      expect(served.latest()).toBeNull();
      // The belt still names the guest, and prune keeps its record.
      served.prune();
      expect(served.latestAny()).toMatchObject({ slack_user: "U0GUEST" });
    });

    // The writers record first and name the wake only after an await, so a
    // record written earlier can get the LATER wake name. The bridge serves
    // by name; so must the rights.
    // MUTATION: order `serving()` by write order (`held()` alone) — the
    // owner/daemon rights below leak into the guest's turn.
    it("follows the bridge's wake-name order, not the order records were written", () => {
      served.write("event-EvG", {
        event_id: "EvG",
        slack_user: "U0GUEST",
        tier: "anyone",
        authorized_prs: [],
      });
      at(1_000);
      served.write("event-EvO", {
        event_id: "EvO",
        slack_user: "U0MAT",
        tier: "owner",
        authorized_prs: [],
      });
      writeFileSync(join(inject, "0001.md"), "owner\n");
      served.rename("event-EvO", "0001.md");
      writeFileSync(join(inject, "0002.md"), "guest\n");
      served.rename("event-EvG", "0002.md");
      accept("0001.md");
      // The owner's turn runs with the guest's message queued behind it.
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      accept("0002.md");
      // The guest's turn runs: the owner's older-named wake is over.
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      expect(served.latestAny()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
    });

    it("a daemon wake named before a guest's never lifts the belt off the guest's turn", () => {
      served.write("event-EvG", {
        event_id: "EvG",
        slack_user: "U0GUEST",
        tier: "anyone",
        authorized_prs: [],
      });
      at(1_000);
      const local = served.writeLocal("anomaly");
      writeFileSync(join(inject, "0001.md"), "wake\n");
      served.bind(local, join(inject, "0001.md"));
      writeFileSync(join(inject, "0002.md"), "guest\n");
      served.rename("event-EvG", "0002.md");
      accept("0001.md");
      accept("0002.md");
      expect(served.latestAny()).toMatchObject({ source: "slack", tier: "anyone" });
    });

    // MUTATION: drop the pending-file check from `isAccepted` — the planted
    // `.done/` file hands the queued owner's rights to the guest's turn.
    it("a file planted in .done/ beside a wake still pending is no acceptance", () => {
      accept(slackTurn(1, "U0GUEST", "anyone"));
      at(30_000);
      const owner = slackTurn(2, "U0MAT", "owner");
      writeFileSync(join(done, owner), "forged\n");
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      const local = served.writeLocal("eod-sweep");
      writeFileSync(join(inject, "wake-3.md"), "wake\n");
      served.bind(local, join(inject, "wake-3.md"));
      writeFileSync(join(done, "wake-3.md"), "forged\n");
      expect(served.latestAny()).toMatchObject({ source: "slack", tier: "anyone" });
      // The real move still counts.
      rmSync(join(done, owner));
      accept(owner);
      expect(served.latest()).toMatchObject({ slack_user: "U0MAT", tier: "owner" });
      rmSync(join(done, "wake-3.md"));
      accept("wake-3.md");
      expect(served.latestAny()).toMatchObject({ source: "local", tier: "system" });
    });

    it("a wake that left the queue unaccepted ahead of the running one describes no turn", () => {
      const guest = slackTurn(1, "U0GUEST", "anyone");
      at(30_000);
      const owner = slackTurn(2, "U0MAT", "owner");
      accept(owner);
      // Still pending: the bridge serves it next, so it restricts.
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
      // Quarantined without being served: it no longer does.
      mkdirSync(join(inject, ".terminal"), { recursive: true });
      renameSync(join(inject, guest), join(inject, ".terminal", `${guest}.failed`));
      expect(served.latest()).toMatchObject({ slack_user: "U0MAT", tier: "owner" });
    });

    describe("a restart keeps a queued guest wake a guest's turn", () => {
      const reboot = () => new OriginStore(join(dir, "origin"), now, { deliveredDir: done });
      const daemonWake = (store: OriginStore, wake: string) => {
        const rec = store.writeLocal("anomaly");
        writeFileSync(join(inject, wake), "wake\n");
        store.bind(rec, join(inject, wake));
      };

      it.each([false, true])(
        "keeps an accepted guest restricted behind a queued owner after restart (prune %s)",
        (prune) => {
          accept(slackTurn(1, "U0GUEST", "anyone"));
          at(1_000);
          slackTurn(2, "U0MAT", "owner");
          if (prune) {
            at(ORIGIN_TTL_MS + 2_000);
            served.prune();
          }
          expect(reboot().latestAny()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
          expect(reboot().latest()).toBeNull();
        },
      );

      // MUTATION: drop `bootQueued` from `latestAny()` — the newest record on
      // disk is the daemon's, so the guest's queued turn runs beltless.
      it("a guest wake queued before a daemon wake keeps the belt on after the restart", () => {
        const guest = slackTurn(1, "U0GUEST", "anyone");
        at(1_000);
        daemonWake(served, "wake-2.md");
        const booted = reboot();
        accept(guest);
        expect(booted.latestAny()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
        // Disk never opens the Slack dir on its own.
        expect(booted.latest()).toBeNull();
        // The previous run's daemon wake is no wake this process recorded: the
        // belt stays on through it (fail closed)…
        accept("wake-2.md");
        expect(booted.latestAny()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
        // …until a wake this process recorded is accepted.
        at(2_000);
        daemonWake(booted, "wake-3.md");
        accept("wake-3.md");
        expect(booted.latestAny()).toMatchObject({ source: "local", tier: "system" });
      });

      it("an owner message after the restart never lends its rights to the queued guest turn", () => {
        const guest = slackTurn(1, "U0GUEST", "anyone");
        at(1_000);
        daemonWake(served, "wake-2.md");
        const booted = reboot();
        at(2_000);
        booted.write("event-Ev3", {
          event_id: "Ev3",
          slack_user: "U0MAT",
          tier: "owner",
          authorized_prs: [],
        });
        writeFileSync(join(inject, "wake-3.md"), "turn\n");
        booted.rename("event-Ev3", "wake-3.md");
        accept(guest);
        expect(booted.latest()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
        accept("wake-2.md");
        accept("wake-3.md");
        expect(booted.latest()).toMatchObject({ slack_user: "U0MAT", tier: "owner" });
      });

      // MUTATION: drop the pending-wake keep from `prune()` — the expired
      // guest record is deleted and the restart forgets its queued turn.
      it("prune keeps an expired record whose wake is still queued", () => {
        slackTurn(1, "U0GUEST", "anyone");
        at(ORIGIN_TTL_MS + 1);
        daemonWake(served, "wake-2.md");
        served.prune();
        expect(existsSync(join(dir, "origin", "wake-1.json"))).toBe(true);
        expect(reboot().latestAny()).toMatchObject({ slack_user: "U0GUEST" });
      });

      it("a record planted against a queued wake never lifts the belt or grants", () => {
        const guest = slackTurn(1, "U0GUEST", "anyone");
        at(1_000);
        writeFileSync(join(inject, "wake-2.md"), "wake\n");
        writeFileSync(
          join(dir, "origin", "wake-2.json"),
          JSON.stringify({
            source: "local",
            event_id: "local:forged",
            slack_user: "",
            tier: "system",
            authorized_prs: [],
            expires_at: new Date(T0.getTime() + 365 * 86_400_000).toISOString(),
          }),
        );
        const booted = reboot();
        accept(guest);
        accept("wake-2.md");
        expect(booted.latestAny()).toMatchObject({ slack_user: "U0GUEST", tier: "anyone" });
        expect(booted.latest()).toBeNull();
      });
    });

    it("a failed audit-file move still binds the record to its wake", () => {
      served.write("event-Ev1", {
        event_id: "Ev1",
        slack_user: "U0GUEST",
        tier: "anyone",
        authorized_prs: [],
      });
      rmSync(join(dir, "origin", "event-Ev1.json"));
      writeFileSync(join(done, "wake-1.md"), "turn\n");
      served.rename("event-Ev1", "wake-1.md");
      at(30_000);
      const owner = slackTurn(2, "U0MAT", "owner");
      expect(served.latest()).toMatchObject({ slack_user: "U0GUEST" });
      accept(owner);
      expect(served.latest()).toMatchObject({ slack_user: "U0MAT" });
    });
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
