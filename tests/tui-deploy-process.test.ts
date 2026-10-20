import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableDeployProcess } from "../src/tui/deploy-process.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("DurableDeployProcess", () => {
  it("starts one detached run and lets a new TUI generation attach to the same result", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-"));
    roots.push(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "tui-deploy-runner.mjs"),
      `
      import { appendFileSync, writeFileSync } from "node:fs";
      const [root, log, result, version] = process.argv.slice(2);
      appendFileSync(root + "/starts", "start\\n");
      appendFileSync(root + "/versions", version + "\\n");
      appendFileSync(log, "sync started\\n");
      setTimeout(() => writeFileSync(result, JSON.stringify({code: 0, finished_at: new Date().toISOString()})), 40);
    `,
    );
    const state = join(root, "state", "runs");
    const first = new DurableDeployProcess(root, state, 10);
    const second = new DurableDeployProcess(root, state, 10);
    const outputs: string[] = [];
    const wait = (runner: DurableDeployProcess) =>
      new Promise<number | null>((resolve) => {
        runner.startOrAttach("same-run-1234", "1.2.3", (chunk) => outputs.push(chunk), resolve);
      });
    const [a, b] = await Promise.all([wait(first), wait(second)]);
    expect([a, b]).toEqual([0, 0]);
    expect(readFileSync(join(root, "starts"), "utf8")).toBe("start\n");
    // The detached runner is started with the version the ceremony ships.
    expect(readFileSync(join(root, "versions"), "utf8")).toBe("1.2.3\n");
    expect(outputs.filter((line) => line.includes("sync started"))).toHaveLength(2);
  });

  it("refuses a version that is not a release spelling before anything starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "tui-deploy-version-"));
    roots.push(root);
    const runner = new DurableDeployProcess(root, join(root, "state", "runs"), 5);
    for (const bad of ["", "latest", "1.2", "1.2.3; rm -rf /", "$(id)", "../1.2.3"]) {
      const output: string[] = [];
      const code = await new Promise<number | null>((resolve) => {
        runner.startOrAttach("badver-run-1234", bad, (c) => output.push(c), resolve);
      });
      expect(code, bad).toBe(1);
      expect(output.join(""), bad).toContain("invalid release version");
    }
    expect(existsSync(join(root, "state", "runs"))).toBe(false);
  });

  it("fails a stale pre-spawn marker visibly instead of polling forever", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-stale-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "stale-run-1234.started.json"),
      JSON.stringify({
        pid: 0,
        state: "starting",
        started_at: "2026-08-28T00:00:00Z",
      }),
    );
    const output: string[] = [];
    const runner = new DurableDeployProcess(root, state, 5, 5);
    const code = await new Promise<number | null>((resolve) => {
      runner.startOrAttach("stale-run-1234", "1.2.3", (chunk) => output.push(chunk), resolve);
    });
    expect(code).toBe(1);
    expect(output.join("")).toContain("never started");
  });

  it("also bounds the crash window that leaves an empty exclusive marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-empty-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "empty-run-1234.started.json"), "");
    const output: string[] = [];
    const runner = new DurableDeployProcess(root, state, 5, 5);
    const code = await new Promise<number | null>((resolve) => {
      runner.startOrAttach("empty-run-1234", "1.2.3", (chunk) => output.push(chunk), resolve);
    });
    expect(code).toBe(1);
    expect(output.join("")).toContain("never started");
  });
  it("fails a running marker whose runner died without a result", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-dead-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    // A pid that has already exited and been reaped.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(
      join(state, "dead-run-1234.started.json"),
      JSON.stringify({ pid: gone, state: "running", started_at: new Date().toISOString() }),
    );
    const output: string[] = [];
    const runner = new DurableDeployProcess(root, state, 5, 5);
    const code = await new Promise<number | null>((resolve) => {
      runner.startOrAttach("dead-run-1234", "1.2.3", (chunk) => output.push(chunk), resolve);
    });
    expect(code).toBe(1);
    expect(output.join("")).toContain("exited without a result");
    // The failure is durable: the next generation reads it without polling.
    expect(JSON.parse(readFileSync(join(state, "dead-run-1234.result.json"), "utf8")).code).toBe(1);
  });

  it("treats a runner started before the last boot as gone even if its pid is live", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-boot-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "boot-run-1234.started.json"),
      JSON.stringify({ pid: process.pid, state: "running", started_at: "2000-01-01T00:00:00Z" }),
    );
    const output: string[] = [];
    const runner = new DurableDeployProcess(root, state, 5, 5);
    const code = await new Promise<number | null>((resolve) => {
      runner.startOrAttach("boot-run-1234", "1.2.3", (chunk) => output.push(chunk), resolve);
    });
    expect(code).toBe(1);
    expect(output.join("")).toContain("exited without a result");
  });

  it("names the signal that ended the deploy in the streamed log", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-signal-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "sig-run-1234.started.json"),
      JSON.stringify({ pid: process.pid, state: "running", started_at: new Date().toISOString() }),
    );
    writeFileSync(
      join(state, "sig-run-1234.result.json"),
      JSON.stringify({ code: null, signal: "SIGTERM" }),
    );
    let log = "";
    const code = await new Promise<number | null>((resolve) => {
      new DurableDeployProcess(root, state, 5, 5).startOrAttach(
        "sig-run-1234",
        "1.2.3",
        (chunk) => (log += chunk),
        resolve,
      );
    });
    expect(code).toBeNull();
    expect(log).toContain("deploy process ended by SIGTERM");
  });

  it("keeps attaching while the running marker's runner is alive", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-live-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "live-run-1234.started.json"),
      JSON.stringify({ pid: process.pid, state: "running", started_at: new Date().toISOString() }),
    );
    let exited = false;
    const runner = new DurableDeployProcess(root, state, 5, 5);
    runner.startOrAttach(
      "live-run-1234",
      "1.2.3",
      () => {},
      () => (exited = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exited).toBe(false);
    writeFileSync(join(state, "live-run-1234.result.json"), JSON.stringify({ code: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(exited).toBe(true);
  });
});
