// The Node floor: the oldest Node an npm install of the App or the Plugin
// supports. Four places state it, and they must agree:
//   - the App's `engines.node` (package.json), which npm's engine check names;
//   - the Plugin's `engines.node` (packages/pi-plugin/package.json);
//   - the onboarding preflight's minimum (src/onboard/steps/preflight.ts);
//   - CI's test matrix (.github/workflows/ci.yml, `test`), which is what
//     proves the floor: it must run the floor's major, and 26, the Node the
//     images carry.
// The images, the companion and the Ansible role pin their own Node 26, and
// the release workflow's npm job publishes from 26 (tests/release-workflow.test.ts).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { MIN_NODE, MIN_NODE_LABEL } from "../src/onboard/steps/preflight.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const engines = (rel: string): string | undefined =>
  (JSON.parse(read(rel)) as { engines?: { node?: string } }).engines?.node;

interface Job {
  strategy?: { "fail-fast"?: boolean; matrix?: { node?: unknown } };
  steps: { uses?: string; with?: Record<string, unknown> }[];
}
const ci = parse(read(".github/workflows/ci.yml")) as { jobs: Record<string, Job> };
const test = ci.jobs.test!;

describe("the Node floor", () => {
  it("both packages' engines declare the preflight's minimum", () => {
    expect(MIN_NODE_LABEL).toBe(`${MIN_NODE.major}.${MIN_NODE.minor}`);
    expect(engines("package.json")).toBe(`>=${MIN_NODE_LABEL}`);
    expect(engines("packages/pi-plugin/package.json")).toBe(`>=${MIN_NODE_LABEL}`);
  });

  // MUTATION: drop "22" from the test job's matrix in ci.yml — this fails.
  it("CI's test job runs the floor's major and 26, and nothing under the floor", () => {
    const nodes = test.strategy?.matrix?.node;
    expect(Array.isArray(nodes), "a `node` matrix on the test job").toBe(true);
    const majors = (nodes as unknown[]).map((n) => String(n));
    expect(majors).toContain(String(MIN_NODE.major));
    expect(majors).toContain("26");
    for (const m of majors) expect(Number(m), m).toBeGreaterThanOrEqual(MIN_NODE.major);
    // every leg reports, so one failing Node does not hide another's result
    expect(test.strategy?.["fail-fast"]).toBe(false);
    const setup = test.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(setup?.with?.["node-version"]).toBe("${{ matrix.node }}");
  });

  it("lint, the clone build and the gate stay on 26", () => {
    for (const name of ["changes", "lint", "clone", "ci"]) {
      const job = ci.jobs[name]!;
      expect(job.strategy, name).toBeUndefined();
      const setup = job.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
      expect(setup?.with?.["node-version"], name).toBe("26");
    }
  });
});
