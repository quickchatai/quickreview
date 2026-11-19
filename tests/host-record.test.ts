// The host record (src/host/record.ts) and what the board export prints from
// it: `setup` and `go_live`, how far a host's long steps have got, and
// `proof`, the practice review a go-live is confirmed against. The reader is
// total, and a walk that is recorded as running while nothing runs it is said
// as failed, never as running.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBoardProgress } from "../src/boardexport.js";
import {
  GO_LIVE_PROBLEMS,
  PROGRESS_STATES,
  SETUP_PROBLEMS,
  SETUP_STEPS,
} from "../src/host/outcomes.js";
import {
  attestationOf,
  hostRecordPath,
  readHostProgress,
  readHostRecord,
  updateHostRecord,
  writeHostRecord,
} from "../src/host/record.js";
import { acquireChecklistLock } from "../src/onboard/checklistlock.js";
import { CHOICE_KEYS } from "../src/onboard/choices.js";

let stateDir: string;
const alive = (pid: number): boolean => pid === 77;
const AT = "2026-11-19T12:00:00.000Z";

beforeEach(() => {
  stateDir = join(mkdtempSync(join(tmpdir(), "qcr-hostrec-")), "state");
});
afterEach(() => rmSync(join(stateDir, ".."), { recursive: true, force: true }));

function writeChecklist(choices: Record<string, unknown>): void {
  mkdirSync(join(stateDir, "onboarding"), { recursive: true });
  writeFileSync(
    join(stateDir, "onboarding", "checklist.json"),
    JSON.stringify({
      version: 1,
      created_at: AT,
      updated_at: AT,
      completed_at: null,
      choices,
      steps: {},
    }),
  );
}

const PROOF = { pr: 12, round_no: 2, verdict: "APPROVE", completed_at: AT, review_shown: true };

describe("reading the record", () => {
  it("no file, or one that is not this shape, is an empty record", () => {
    expect(readHostRecord(stateDir)).toEqual({ version: 1 });
    mkdirSync(join(stateDir, "onboarding"), { recursive: true });
    for (const junk of ["", "{", "[]", '"text"', "null"]) {
      writeFileSync(hostRecordPath(stateDir), junk);
      expect(readHostRecord(stateDir), junk).toEqual({ version: 1 });
    }
  });

  it("round-trips what the verbs write", () => {
    const record = {
      version: 1,
      setup: {
        state: "failed" as const,
        step: "bringup" as const,
        problem: "start_failed" as const,
        started_at: AT,
        updated_at: AT,
      },
      go_live: { state: "running" as const, started_at: AT, updated_at: AT },
      proof_request: { pr: 12, floor: 1, requested_at: AT, command: "x-reviewnow-12.json" },
      proof_shown: { pr: 12, round_no: 2, shown_at: AT },
      attestation_pending: {
        operator: { host: "a-host", id: "user-1" },
        confirmed_at: AT,
        proof: { pr: 12, round_no: 2 },
        received_at: AT,
      },
    };
    writeHostRecord(stateDir, record);
    expect(readHostRecord(stateDir)).toEqual(record);
    const next = updateHostRecord(stateDir, (r) => ({ ...r, setup: undefined }));
    expect(next.setup).toBeUndefined();
    expect(readHostRecord(stateDir).go_live?.state).toBe("running");
  });

  // MUTATION: take `step` and `problem` as any string in setupOf — a word
  // outside the closed sets then reaches the board export, and this fails.
  it("takes each part only when every field of it is what it should be", () => {
    mkdirSync(join(stateDir, "onboarding"), { recursive: true });
    writeFileSync(
      hostRecordPath(stateDir),
      JSON.stringify({
        setup: { state: "failed", step: "a made-up step", problem: "<b>", started_at: AT },
        go_live: { state: "exploded", started_at: AT },
        proof_request: { pr: "12", floor: 0, requested_at: AT },
        proof_shown: { pr: 12, round_no: 0, shown_at: AT },
        attestation: { operator: { host: "h" }, confirmed_at: AT, proof: { pr: 1, round_no: 1 } },
      }),
    );
    expect(readHostRecord(stateDir)).toEqual({
      version: 1,
      setup: { state: "failed", started_at: AT, updated_at: AT },
    });
  });

  it("an attestation is whole or it is none", () => {
    const whole = {
      operator: { host: "a-host", id: "user-1" },
      confirmed_at: AT,
      proof: { pr: 12, round_no: 2 },
    };
    expect(attestationOf(whole)).toEqual(whole);
    // what a host adds beside it is not kept
    expect(attestationOf({ ...whole, phrase: "GO LIVE" })).toEqual(whole);
    for (const broken of [
      null,
      "GO LIVE",
      { ...whole, operator: { host: "a-host" } },
      { ...whole, operator: { host: "", id: "user-1" } },
      { ...whole, operator: { host: "h".repeat(65), id: "user-1" } },
      { ...whole, confirmed_at: 1763553600 },
      { ...whole, proof: { pr: 12 } },
      { ...whole, proof: { pr: "12", round_no: 2 } },
      { ...whole, proof: { pr: 12, round_no: 0 } },
    ])
      expect(attestationOf(broken), JSON.stringify(broken)).toBeUndefined();
  });
});

describe("what the board export prints", () => {
  it("nothing where no host verb ran", () => {
    expect(readHostProgress(stateDir, { alive })).toEqual({});
    expect(readBoardProgress(stateDir)).toEqual({});
  });

  it("a walk that holds the lock is running, at its step", () => {
    const lock = acquireChecklistLock(stateDir, "setup", { pid: 77, alive });
    expect(lock.ok).toBe(true);
    updateHostRecord(stateDir, (r) => ({
      ...r,
      setup: { state: "running", step: "bringup", started_at: AT, updated_at: AT },
    }));
    expect(readHostProgress(stateDir, { alive })).toEqual({
      setup: { state: "running", step: "bringup" },
    });
  });

  // MUTATION: print the recorded state as it is in readHostProgress — a walk
  // that died reads as running for ever, and this fails.
  it("a walk recorded as running that nothing runs is failed, interrupted", () => {
    updateHostRecord(stateDir, (r) => ({
      ...r,
      setup: { state: "running", step: "bringup", started_at: AT, updated_at: AT },
      go_live: { state: "running", started_at: AT, updated_at: AT },
    }));
    const lost = {
      setup: { state: "failed", step: "bringup", problem: "interrupted" },
      go_live: { state: "failed", problem: "interrupted" },
    };
    // no lock at all
    expect(readHostProgress(stateDir, { alive })).toEqual(lost);
    // the real reader, over this process's own table: the same
    expect(readBoardProgress(stateDir)).toEqual(lost);
    // a lock whose process is gone
    expect(acquireChecklistLock(stateDir, "setup", { pid: 5, alive: () => true }).ok).toBe(true);
    expect(readHostProgress(stateDir, { alive })).toEqual(lost);
  });

  it("a lock held for something else does not make another walk run", () => {
    updateHostRecord(stateDir, (r) => ({
      ...r,
      setup: { state: "running", started_at: AT, updated_at: AT },
      go_live: { state: "running", started_at: AT, updated_at: AT },
    }));
    expect(acquireChecklistLock(stateDir, "go_live", { pid: 77, alive }).ok).toBe(true);
    expect(readHostProgress(stateDir, { alive })).toEqual({
      setup: { state: "failed", problem: "interrupted" },
      go_live: { state: "running" },
    });
  });

  it("a walk that ended is said as it ended, lock or none", () => {
    updateHostRecord(stateDir, (r) => ({
      ...r,
      setup: { state: "done", started_at: AT, updated_at: AT },
      go_live: { state: "failed", problem: "restart_failed", started_at: AT, updated_at: AT },
    }));
    expect(readHostProgress(stateDir, { alive })).toEqual({
      setup: { state: "done" },
      go_live: { state: "failed", problem: "restart_failed" },
    });
  });

  // A go-live says nothing of a trigger label: no host verb writes one. A
  // record an earlier build left with a `label` beside it reads without it.
  // MUTATION: read `label` off the record again in goLiveOf and print it in
  // readHostProgress — a host reads a field its schema does not list, and
  // this fails.
  it("a go-live record carries no label, and one written with it reads without it", () => {
    mkdirSync(join(stateDir, "onboarding"), { recursive: true });
    writeFileSync(
      hostRecordPath(stateDir),
      JSON.stringify({ go_live: { state: "done", label: "ok", started_at: AT, updated_at: AT } }),
    );
    expect(readHostRecord(stateDir).go_live).not.toHaveProperty("label");
    expect(readHostProgress(stateDir, { alive }).go_live).toEqual({ state: "done" });
    expect(GO_LIVE_PROBLEMS.filter((p) => /label/.test(p))).toEqual([]);
  });

  // A lock left by another boot of the machine holds nothing.
  // MUTATION: read the lock's holder by its pid alone in readHostProgress —
  // a setup the machine was restarted under reads as running, and this fails.
  it("a walk whose lock is another boot's is failed, interrupted", () => {
    let boot = "boot-1";
    const facts = { alive, bootId: () => boot, startTime: () => "100" };
    const lock = acquireChecklistLock(stateDir, "setup", { pid: 77, ...facts });
    expect(lock.ok).toBe(true);
    updateHostRecord(stateDir, (r) => ({
      ...r,
      setup: { state: "running", step: "bringup", started_at: AT, updated_at: AT },
    }));
    expect(readHostProgress(stateDir, facts).setup).toEqual({ state: "running", step: "bringup" });
    boot = "boot-2";
    expect(readHostProgress(stateDir, facts).setup).toEqual({
      state: "failed",
      step: "bringup",
      problem: "interrupted",
    });
  });

  // MUTATION: print the checklist's proof whether or not proof-result
  // returned it — the first assertion fails.
  it("`proof` is the checklist's practice round, once proof-result has returned it", () => {
    writeChecklist({ [CHOICE_KEYS.proof]: PROOF });
    expect(readHostProgress(stateDir, { alive })).toEqual({});
    updateHostRecord(stateDir, (r) => ({
      ...r,
      proof_shown: { pr: 12, round_no: 1, shown_at: AT },
    }));
    // another round was shown, not this one
    expect(readHostProgress(stateDir, { alive })).toEqual({});
    updateHostRecord(stateDir, (r) => ({
      ...r,
      proof_shown: { pr: 12, round_no: 2, shown_at: AT },
    }));
    expect(readHostProgress(stateDir, { alive })).toEqual({
      proof: { pr: 12, round_no: 2, verdict: "APPROVE", completed_at: AT },
    });
    // a record that is not whole is no proof
    writeChecklist({ [CHOICE_KEYS.proof]: { ...PROOF, verdict: "" } });
    expect(readHostProgress(stateDir, { alive })).toEqual({});
  });

  it("the words it can print are the closed sets", () => {
    expect(PROGRESS_STATES).toEqual(["running", "done", "failed"]);
    expect(new Set(SETUP_STEPS).size).toBe(SETUP_STEPS.length);
    expect(SETUP_PROBLEMS).toContain("interrupted");
    expect(GO_LIVE_PROBLEMS).toContain("interrupted");
  });
});
