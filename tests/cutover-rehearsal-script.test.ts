// scripts/cutover-rehearsal.sh: the two helpers that decide what survives a run, extracted from the
// script and run in bash. Nothing here starts docker, sshd or a VM.
//   - cleanup() under --keep leaves the throwaway sshd running (the --keep contract names it)
//   - a worker rehearsal that exits nonzero without a failed row still fails the report
import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = readFileSync(join(__dirname, "..", "scripts", "cutover-rehearsal.sh"), "utf8");

/** The text of the top-level shell function `name`, from `name() {` to its closing `}` at column 0. */
function fn(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, "m").exec(SCRIPT);
  if (!m) throw new Error(`${name}() not found in cutover-rehearsal.sh`);
  return m[0];
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cutover-rehearsal-"));
  dirs.push(d);
  return d;
};

describe("cutover-rehearsal.sh cleanup", () => {
  it("leaves sshd running under --keep and stops it otherwise", async () => {
    for (const keep of [1, 0]) {
      const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
      try {
        const body = `
log() { :; }
teardown_containers() { :; }
rm_host() { :; }
KEEP=${keep}; REG=r; WORK=w; H=h; PRISTINE=p; SSHD_PID=${sleeper.pid}
docker() { :; }
${fn("cleanup")}
cleanup`;
        spawnSync("bash", ["-c", body]);
        await new Promise((r) => setTimeout(r, 100));
        let alive = true;
        try {
          process.kill(sleeper.pid!, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(keep === 1);
      } finally {
        sleeper.kill("SIGKILL");
      }
    }
  });
});

describe("cutover-rehearsal.sh check_worker_exit", () => {
  function run(rc: number, results: string | null): string {
    const d = scratch();
    const tsv = join(d, "worker.tsv");
    if (results !== null) writeFileSync(tsv, results);
    const out = join(d, "results.tsv");
    writeFileSync(out, "");
    const body = `
RESULTS=${out}
log() { :; }
${fn("check")}
${fn("check_worker_exit")}
check_worker_exit ${rc} ${tsv}`;
    spawnSync("bash", ["-c", body]);
    return readFileSync(out, "utf8");
  }

  it("records a failed check when the worker run exits nonzero with no failed row", () => {
    expect(run(1, "W-1\tpass\tok\t\n")).toMatch(/^WORKER-RUN\tfail\t/m);
    expect(run(137, null)).toMatch(/^WORKER-RUN\tfail\t/m);
  });

  it("adds nothing for a clean exit, or when a failed row already carries the failure", () => {
    expect(run(0, "W-1\tpass\tok\t\n")).toBe("");
    expect(run(1, "W-1\tfail\tbad\tx\n")).toBe("");
  });
});

describe("cutover-rehearsal.sh login_expiry", () => {
  const expiry = (lr: string): string =>
    spawnSync("bash", ["-c", `${fn("login_expiry")}\nlogin_expiry "$1"`, "bash", lr], {
      encoding: "utf8",
    }).stdout.trim();
  it("reads expires_at from the refresher's nested login block", () => {
    const lr = JSON.stringify({
      state: "running",
      login: { pid: 1, expires_at: "2027-01-02T03:04:05Z" },
    });
    expect(expiry(lr)).toBe("2027-01-02T03:04:05Z");
  });
  it("is empty when the login block carries no expiry, or the status is empty", () => {
    expect(expiry(JSON.stringify({ state: "running", login: { pid: 1, expires_at: null } }))).toBe(
      "",
    );
    expect(
      expiry(JSON.stringify({ state: "running", expires_at: "top-level is not the shape" })),
    ).toBe("");
    expect(expiry("")).toBe("");
  });
});
