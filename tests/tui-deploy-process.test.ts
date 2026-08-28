import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DurableDeployProcess } from "../src/tui/deploy-process.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("DurableDeployProcess", () => {
  it("starts one detached run and lets a new TUI generation attach to the same result", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-"));
    roots.push(root);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts", "tui-deploy-runner.mjs"), `
      import { appendFileSync, writeFileSync } from "node:fs";
      const [root, log, result] = process.argv.slice(2);
      appendFileSync(root + "/starts", "start\\n");
      appendFileSync(log, "sync started\\n");
      setTimeout(() => writeFileSync(result, JSON.stringify({code: 0, finished_at: new Date().toISOString()})), 40);
    `);
    const state = join(root, "state", "runs");
    const first = new DurableDeployProcess(root, state, 10);
    const second = new DurableDeployProcess(root, state, 10);
    const outputs: string[] = [];
    const wait = (runner: DurableDeployProcess) => new Promise<number | null>((resolve) => {
      runner.startOrAttach("same-run-1234", (chunk) => outputs.push(chunk), resolve);
    });
    const [a, b] = await Promise.all([wait(first), wait(second)]);
    expect([a, b]).toEqual([0, 0]);
    expect(readFileSync(join(root, "starts"), "utf8")).toBe("start\n");
    expect(outputs.filter((line) => line.includes("sync started"))).toHaveLength(2);
  });

  it("fails a stale pre-spawn marker visibly instead of polling forever", async () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-durable-deploy-stale-"));
    roots.push(root);
    const state = join(root, "state", "runs");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "stale-run-1234.started.json"), JSON.stringify({
      pid: 0,
      state: "starting",
      started_at: "2026-08-28T00:00:00Z",
    }));
    const output: string[] = [];
    const runner = new DurableDeployProcess(root, state, 5, 5);
    const code = await new Promise<number | null>((resolve) => {
      runner.startOrAttach("stale-run-1234", (chunk) => output.push(chunk), resolve);
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
      runner.startOrAttach("empty-run-1234", (chunk) => output.push(chunk), resolve);
    });
    expect(code).toBe(1);
    expect(output.join("")).toContain("never started");
  });
});
