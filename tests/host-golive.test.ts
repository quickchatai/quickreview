// `host go-live` (src/host/golive.ts): a host's attested operator takes the
// reviewer live. The verb admits an attestation or refuses it; the walk it
// starts calls the existing go-live path, `runGoLive`, and nothing else. Over
// fake steps, as the home's switch-on tests are: what reaches the go-live
// step, and when nothing does, is what these assert (invariant 6). The
// go-live step itself is tests/onboard-golive.test.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CONFIRM_MAX_AGE_MS,
  CONFIRM_SKEW_MS,
  alreadyLive,
  attestationRefusal,
  goLiveProblem,
  hostGoLive,
  walkGoLive,
} from "../src/host/golive.js";
import { hostProofResult, hostProofStart } from "../src/host/proof.js";
import { readHostProgress, readHostRecord, updateHostRecord } from "../src/host/record.js";
import { SESSION_ENV_MARKERS } from "../src/host/session.js";
import { acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";
import { GO_LIVE_CONFIRMATION, GO_LIVE_STEP_ID } from "../src/onboard/steps/golive.js";
import {
  TEMPLATE,
  WALK_PID,
  finishedRound,
  hostWorld,
  setUpConfig,
  type HostWorld,
} from "./helpers/host-rig.js";

let w: HostWorld;
beforeEach(() => {
  w = hostWorld();
  w.writeConfig(setUpConfig());
});
afterEach(() => w.close());

/** A practice review of #7, asked for, finished and returned to the host. */
async function practice(): Promise<void> {
  expect(await hostProofStart(w.ports, ["7"])).toMatchObject({ state: "started" });
  const done = finishedRound(7, 1);
  w.daemon.rounds = [done.round];
  w.daemon.dryrun = done.records;
  expect(await hostProofResult(w.ports, ["7"])).toMatchObject({ state: "done" });
  w.calls.length = 0;
}

/** The attestation a host sends: its operator confirmed #7 round 1 just now. */
const attestation = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  operator: { host: "a-host", id: "user-1" },
  confirmed_at: new Date(w.now - 5_000).toISOString(),
  proof: { pr: 7, round_no: 1 },
  ...over,
});
const send = (a: unknown = attestation()): Promise<Awaited<ReturnType<typeof hostGoLive>>> => {
  w.stdin = typeof a === "string" ? a : JSON.stringify(a);
  return hostGoLive(w.ports, []);
};
const progress = () => readHostProgress(w.stateDir, w.facts());
/** The config as the go-live step leaves it: the flag moved, nothing else. */
const flipConfig = (): void => w.writeConfig(setUpConfig({ dryRun: false }));
const runWalk = (): Promise<number> => walkGoLive(w.walker(), w.launched.at(-1)!.token);
const dryRun = (): unknown => (parse(w.config()!) as Record<string, unknown>)["dry_run"];

/** When the operator confirmed, in the attestation a host sends. */
const T_CONFIRMED = Date.parse("2026-11-19T11:59:55Z");

/** Nothing was started, nothing reached a step, and the lock is free. */
function nothingHappened(): void {
  expect(w.launched).toEqual([]);
  expect(w.ran).toEqual([]);
  expect(readHostRecord(w.stateDir).go_live).toBeUndefined();
  expect(readHostRecord(w.stateDir).attestation_pending).toBeUndefined();
  expect(readHostRecord(w.stateDir).attestation).toBeUndefined();
  expect(dryRun()).toBe(true);
  const free = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID });
  expect(free.ok).toBe(true);
  if (free.ok) free.lock.release();
}

describe("admitting the attestation", () => {
  it("starts the go-live walk, detached, and runs no step itself", async () => {
    await practice();
    expect(await send()).toEqual({ state: "started" });
    expect(w.launched).toHaveLength(1);
    expect(w.launched[0]!.kind).toBe("go-live");
    expect(w.ran).toEqual([]);
    expect(readHostRecord(w.stateDir).attestation_pending).toMatchObject({
      operator: { host: "a-host", id: "user-1" },
      proof: { pr: 7, round_no: 1 },
    });
    expect(progress().go_live).toEqual({ state: "running" });
    // the flag has not moved: only the go-live step moves it
    expect(dryRun()).toBe(true);
  });

  // MUTATION: release the lock when the verb returns — a second call starts
  // a second go-live, and this fails.
  it("is single-flight: a second call answers `running`, and the home's lock answers `busy`", async () => {
    await practice();
    expect(await send()).toEqual({ state: "started" });
    expect(await send()).toEqual({ state: "running" });
    expect(w.launched).toHaveLength(1);
    expect(await runWalk()).toBe(0);
    const home = acquireChecklistLock(w.stateDir, "home", {
      pid: WALK_PID,
      alive: (p) => w.alivePids.has(p),
    });
    expect(home.ok).toBe(true);
    expect(await send()).toEqual({ state: "busy", holder: "home" });
  });
});

describe("what it refuses, changing nothing", () => {
  // MUTATION: admit an attestation whose proof is not the recorded one — this fails.
  it("a proof that differs from the recorded one", async () => {
    await practice();
    for (const proof of [
      { pr: 8, round_no: 1 },
      { pr: 7, round_no: 2 },
    ]) {
      const out = await send(attestation({ proof }));
      expect(out).toMatchObject({ state: "refused", reason: "proof_mismatch" });
      expect(out.message).toMatch(/practice review on record is #7 round 1/);
    }
    nothingHappened();
  });

  // MUTATION: take the checklist's own `review_shown` for the mark, or drop
  // the proofWasShown check — a proof no host showed admits a go-live, and
  // this fails.
  it("a proof that proof-result never returned", async () => {
    // a practice round on record, as the wizard's own step records it, and
    // nothing a host returned
    mkdirSync(join(w.stateDir, "onboarding"), { recursive: true });
    writeFileSync(
      join(w.stateDir, "onboarding", "checklist.json"),
      JSON.stringify({
        version: 1,
        created_at: "2026-11-19T11:00:00Z",
        updated_at: "2026-11-19T11:00:00Z",
        completed_at: null,
        choices: {
          [CHOICE_KEYS.proof]: {
            pr: 7,
            round_no: 1,
            verdict: "APPROVE",
            completed_at: "2026-11-19T11:00:00Z",
            review_shown: true,
          },
        },
        steps: {},
      }),
    );
    const out = await send();
    expect(out).toMatchObject({ state: "refused", reason: "proof_not_shown" });
    expect(out.message).toMatch(/never returned by host proof-result/);
    // another round of the same pull request was returned: still not this one
    updateHostRecord(w.stateDir, (r) => ({
      ...r,
      proof_shown: { pr: 7, round_no: 3, shown_at: "2026-11-19T11:30:00Z" },
    }));
    expect(await send()).toMatchObject({ state: "refused", reason: "proof_not_shown" });
    nothingHappened();
  });

  it("no practice review at all", async () => {
    expect(await send()).toMatchObject({ state: "refused", reason: "proof_missing" });
    nothingHappened();
  });

  // MUTATION: drop the age check, or measure it from when the call arrives — this fails.
  it("a confirm ten minutes old or more, or one from the future", async () => {
    await practice();
    const at = (ms: number) => attestation({ confirmed_at: new Date(w.now + ms).toISOString() });
    expect(await send(at(-CONFIRM_MAX_AGE_MS))).toMatchObject({
      state: "refused",
      reason: "confirm_stale",
    });
    expect(await send(at(-3_600_000))).toMatchObject({ state: "refused", reason: "confirm_stale" });
    expect(await send(at(CONFIRM_SKEW_MS + 1_000))).toMatchObject({
      state: "refused",
      reason: "attestation_invalid",
    });
    expect(await send(attestation({ confirmed_at: "ten minutes ago" }))).toMatchObject({
      state: "refused",
      reason: "attestation_invalid",
    });
    nothingHappened();
    // just under ten minutes is admitted
    expect(await send(at(-CONFIRM_MAX_AGE_MS + 1_000))).toEqual({ state: "started" });
  });

  // MUTATION: drop `admit` from hostGoLive — this fails for every marker.
  it("a call from inside an agent session, whichever kind, or inside the stack's container", async () => {
    await practice();
    for (const marker of SESSION_ENV_MARKERS) {
      w.env = { [marker]: "pr-7" };
      const out = await send();
      expect(out, marker).toMatchObject({ state: "refused", reason: "in_session" });
      expect(out.message).toContain(marker);
    }
    w.env = {};
    w.inImage = true;
    expect(await send()).toMatchObject({ state: "refused", reason: "not_on_host" });
    w.inImage = false;
    nothingHappened();
  });

  // An attestation admits a go-live where the install says a host manages
  // it, and nowhere else: there is no attested operator on any other install.
  // MUTATION: drop the marker check from hostGoLive — a self-written
  // attestation starts a go-live on an install that keeps its own credential,
  // and this fails.
  it("an install whose config does not carry the host-managed marker", async () => {
    await practice();
    for (const unmarked of [setUpConfig({ hosted: false }), TEMPLATE, "", "[github\nrepo = "]) {
      w.writeConfig(unmarked);
      const out = await send();
      expect(out).toMatchObject({ state: "refused", reason: "not_host_managed" });
      expect(out.message).toMatch(/never makes an install host-managed/);
      expect(w.config()).toBe(unmarked);
    }
    expect(w.launched).toEqual([]);
    expect(w.ran).toEqual([]);
    expect(readHostRecord(w.stateDir).go_live).toBeUndefined();
    expect(readHostRecord(w.stateDir).attestation_pending).toBeUndefined();
    // with the marker back, the same attestation is admitted
    w.writeConfig(setUpConfig());
    expect(await send()).toEqual({ state: "started" });
  });

  it("a phrase on the command line, or no attestation on standard input", async () => {
    await practice();
    w.stdin = JSON.stringify(attestation());
    for (const args of [["GO LIVE"], ["--confirm", GO_LIVE_CONFIRMATION], ["7"]]) {
      const out = await hostGoLive(w.ports, args);
      expect(out, args.join(" ")).toMatchObject({ state: "refused", reason: "usage" });
    }
    for (const text of ["", "GO LIVE", "{", "[]", '{"confirm":"GO LIVE"}']) {
      const out = await send(text);
      expect(out, text).toMatchObject({ state: "refused", reason: "attestation_invalid" });
    }
    for (const broken of [
      attestation({ operator: { host: "a-host" } }),
      attestation({ operator: "user-1" }),
      attestation({ proof: { pr: 7 } }),
      attestation({ confirmed_at: undefined }),
    ])
      expect(await send(broken)).toMatchObject({ state: "refused", reason: "attestation_invalid" });
    nothingHappened();
  });
});

describe("the walk", () => {
  const admitted = async (): Promise<void> => {
    await practice();
    expect(await send()).toEqual({ state: "started" });
  };

  // MUTATION: run any other step in walkGoLive, or call the go-live step
  // with an input of its own — this fails.
  it("calls the go-live path with the confirm, and nothing else", async () => {
    await admitted();
    expect(await runWalk()).toBe(0);
    expect(w.ran).toEqual([
      { id: GO_LIVE_STEP_ID, input: { decision: "go_live", confirm: GO_LIVE_CONFIRMATION } },
    ]);
    expect(progress()).toMatchObject({ go_live: { state: "done" }, proof: { pr: 7, round_no: 1 } });
  });

  it("records the attestation: who confirmed, what, when it was received and when it went live", async () => {
    await admitted();
    w.now += 2_000;
    await runWalk();
    const record = readHostRecord(w.stateDir);
    expect(record.attestation).toMatchObject({
      operator: { host: "a-host", id: "user-1" },
      proof: { pr: 7, round_no: 1 },
      live_at: new Date(w.now).toISOString(),
    });
    expect(Date.parse(record.attestation!.received_at)).toBeLessThan(w.now);
    expect(record.attestation_pending).toBeUndefined();
  });

  // No host verb writes to GitHub: the trigger label is the live daemon's to
  // make sure of, through the gate (src/triggerlabel.ts).
  // MUTATION: make sure of the trigger label in walkGoLive again (the
  // wizard's `ensureLabel` with the token file's token) — the walk reaches
  // GitHub, and this fails.
  it("writes nothing to GitHub: the trigger label is the live daemon's own", async () => {
    await admitted();
    expect(await runWalk()).toBe(0);
    expect(w.github).toEqual([]);
  });

  it("is done once the go-live step has succeeded, and says nothing of a label", async () => {
    await admitted();
    expect(await runWalk()).toBe(0);
    expect(progress().go_live).toEqual({ state: "done" });
    expect(readHostRecord(w.stateDir).attestation?.live_at).toBeDefined();
    expect(readHostRecord(w.stateDir).go_live).not.toHaveProperty("label");
  });

  it("a go-live the step refuses fails with a closed problem, and GitHub is asked nothing", async () => {
    w.refuseGoLive = "proof";
    await admitted();
    expect(await runWalk()).toBe(1);
    expect(progress().go_live).toEqual({ state: "failed", problem: "proof_unverified" });
    expect(readHostRecord(w.stateDir).attestation).not.toHaveProperty("live_at");
    expect(w.github).toEqual([]);
    // the step's own words stay in the walk's log
    expect(w.logs.join("\n")).toMatch(/the step said no/);
    expect(JSON.stringify(readHostRecord(w.stateDir))).not.toMatch(/the step said no/);
  });

  // MUTATION: let the walk go live without admitting the recorded
  // attestation again — the go-live step is reached, and this fails.
  it("goes live only on an attestation on record that still holds", async () => {
    await admitted();
    // the confirm has gone stale by the time the walk runs
    w.now += CONFIRM_MAX_AGE_MS;
    expect(await runWalk()).toBe(1);
    expect(w.ran).toEqual([]);
    expect(progress().go_live).toEqual({ state: "failed", problem: "attestation_rejected" });
    expect(readHostRecord(w.stateDir).attestation).toBeUndefined();
  });

  // The walk asks again what the verb asked: is this an install a host manages?
  // MUTATION: drop the marker check from walkGoLive — a walk started on an
  // install whose marker is gone reaches the go-live step, and this fails.
  it("goes live only on an install that still carries the marker", async () => {
    await admitted();
    w.writeConfig(setUpConfig({ hosted: false }));
    expect(await runWalk()).toBe(1);
    expect(w.ran).toEqual([]);
    expect(progress().go_live).toEqual({ state: "failed", problem: "attestation_rejected" });
    expect(readHostRecord(w.stateDir).attestation).toBeUndefined();
    expect(w.github).toEqual([]);
    expect(dryRun()).toBe(true);
  });

  it("a walk with no attestation on record, or no lock handed to it, reaches no step", async () => {
    await admitted();
    expect(await walkGoLive(w.walker(), "not-the-token")).toBe(1);
    expect(w.ran).toEqual([]);
    updateHostRecord(w.stateDir, (r) => {
      const { attestation_pending: _gone, ...rest } = r;
      return rest;
    });
    expect(await runWalk()).toBe(1);
    expect(w.ran).toEqual([]);
    expect(progress().go_live).toEqual({ state: "failed", problem: "attestation_rejected" });
  });

  it("frees the lock when it ends, and a walk whose process dies is said as interrupted", async () => {
    await admitted();
    w.alivePids.delete(WALK_PID);
    expect(progress().go_live).toEqual({ state: "failed", problem: "interrupted" });
    w.alivePids.add(WALK_PID);
    await runWalk();
    expect(acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID }).ok).toBe(true);
  });
});

describe("a repeat call on an install that is already live", () => {
  /** Live, as the walk leaves it: the step ran on the attestation, and the
   * config reads live. */
  const wentLive = async (): Promise<void> => {
    await practice();
    expect(await send()).toEqual({ state: "started" });
    expect(await runWalk()).toBe(0);
    flipConfig();
    expect(progress().go_live).toEqual({ state: "done" });
    w.ran.length = 0;
    w.calls.length = 0;
    w.github.length = 0;
  };

  // MUTATION: drop the `alreadyLive` short-circuit from hostGoLive — the
  // repeat call starts a second walk, which runs the go-live step again and
  // restarts a daemon that posts; this fails.
  it("answers done and does nothing else: no walk, no step, no restart, no GitHub call", async () => {
    await wentLive();
    // the confirm is long stale by now, and that is no reason to refuse
    w.now += 3 * CONFIRM_MAX_AGE_MS;
    const stale = attestation({ confirmed_at: new Date(T_CONFIRMED).toISOString() });
    expect(await send(stale)).toEqual({ state: "done" });
    expect(w.launched).toHaveLength(1);
    expect(w.ran).toEqual([]);
    expect(w.calls).toEqual([]);
    expect(w.github).toEqual([]);
    expect(progress().go_live).toEqual({ state: "done" });
    // the lock was held for the call and is free again
    const free = acquireChecklistLock(w.stateDir, "home", { pid: WALK_PID });
    expect(free.ok).toBe(true);
    if (free.ok) free.lock.release();
  });

  it("asked again and again, it answers the same, and nothing changes", async () => {
    await wentLive();
    const before = readHostRecord(w.stateDir).attestation;
    expect(await send()).toEqual({ state: "done" });
    expect(await send()).toEqual({ state: "done" });
    expect(w.github).toEqual([]);
    expect(w.launched).toHaveLength(1);
    expect(w.ran).toEqual([]);
    expect(readHostRecord(w.stateDir).attestation).toEqual(before);
    expect(dryRun()).toBe(false);
  });

  it("still asks for an attestation it can read, the marker, and a place it may run", async () => {
    await wentLive();
    expect(await send("{")).toMatchObject({ state: "refused", reason: "attestation_invalid" });
    w.env = { QCR_SESSION_NAME: "pr-7" };
    expect(await send()).toMatchObject({ state: "refused", reason: "in_session" });
    w.env = {};
    w.writeConfig(setUpConfig({ dryRun: false, hosted: false }));
    expect(await send()).toMatchObject({ state: "refused", reason: "not_host_managed" });
    expect(w.github).toEqual([]);
  });

  // "Already live" is the flag as the config reads it and the attestation the
  // step succeeded on. Anything less is a go-live like any other.
  it("is not assumed: a live config with no go-live on record, or a recorded one whose config is dry-run", async () => {
    await practice();
    expect(alreadyLive(w.ports)).toBe(false);
    // the flag moved by hand: no attestation went live here
    flipConfig();
    expect(alreadyLive(w.ports)).toBe(false);
    expect(await send()).toEqual({ state: "started" });
    expect(w.launched).toHaveLength(1);
    expect(await runWalk()).toBe(0);
    expect(alreadyLive(w.ports)).toBe(true);
    // the config reads dry-run again (the fake step does not write it)
    w.writeConfig(setUpConfig());
    expect(alreadyLive(w.ports)).toBe(false);
    w.writeConfig("[github\nrepo = ");
    expect(alreadyLive(w.ports)).toBe(false);
  });
});

describe("the rules, on their own", () => {
  const whole = {
    operator: { host: "a-host", id: "user-1" },
    confirmed_at: "2026-11-19T12:00:00Z",
    proof: { pr: 7, round_no: 1 },
  };
  const now = Date.parse(whole.confirmed_at);
  const shown = { proof_shown: { pr: 7, round_no: 1, shown_at: "2026-11-19T11:59:00Z" } };

  it("checks the proof, then that it was shown, then the confirm's age", () => {
    const ok = { now, recorded: { pr: 7, round_no: 1 }, record: shown };
    expect(attestationRefusal(whole, ok)).toBeNull();
    expect(attestationRefusal(whole, { ...ok, recorded: undefined })?.reason).toBe("proof_missing");
    expect(attestationRefusal(whole, { ...ok, recorded: { pr: 7, round_no: 2 } })?.reason).toBe(
      "proof_mismatch",
    );
    expect(attestationRefusal(whole, { ...ok, record: {} })?.reason).toBe("proof_not_shown");
    expect(attestationRefusal(whole, { ...ok, now: now + CONFIRM_MAX_AGE_MS - 1 })).toBeNull();
    expect(attestationRefusal(whole, { ...ok, now: now + CONFIRM_MAX_AGE_MS })?.reason).toBe(
      "confirm_stale",
    );
    expect(attestationRefusal(whole, { ...ok, now: now - CONFIRM_SKEW_MS })).toBeNull();
    expect(attestationRefusal(whole, { ...ok, now: now - CONFIRM_SKEW_MS - 1 })?.reason).toBe(
      "attestation_invalid",
    );
    // a time with no zone is no instant
    expect(attestationRefusal({ ...whole, confirmed_at: "2026-11-19T12:00:00" }, ok)?.reason).toBe(
      "attestation_invalid",
    );
  });

  it("a refused go-live is named by the step's first failed check", () => {
    expect(goLiveProblem("proof: there is no completed proof round")).toBe("proof_unverified");
    expect(goLiveProblem("flip: refusing to change dry_run")).toBe("config_failed");
    expect(goLiveProblem("config: config.toml is not readable")).toBe("config_failed");
    expect(goLiveProblem("confirmed: the config reads back as true")).toBe("config_failed");
    expect(goLiveProblem("daemon-restart: exited 1; confirmed: x")).toBe("restart_failed");
    expect(goLiveProblem("going live did not finish")).toBe("go_live_failed");
  });
});
