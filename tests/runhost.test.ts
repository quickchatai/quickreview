// Where the daemon runs: outside the release image it warns (log + status.json
// `run_host`), the tool uid stays opt-in via QCR_TOOL_UID, and with no Docker
// memory is switched off cleanly.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus } from "../src/cli.js";
import {
  dockerAvailableSync,
  hostFacts,
  MEMORY_OFF_NO_DOCKER,
  memoryOffOnHost,
  runHostStatus,
} from "../src/runhost.js";
import type { StatusSnapshot } from "../src/state.js";

const NPM_GLOBAL = "/home/u/.npm-global/lib/node_modules/@quickchatai/quickreview";

describe("runHostStatus", () => {
  it("the release image is home: no warning, the entrypoint's tool uid", () => {
    expect(runHostStatus("/opt/qcr", { QCR_IMAGE_TOOL_UID: "65534" })).toEqual({
      in_image: true,
      install: "image",
      tool_uid: "image",
    });
  });

  it("an npm install warns, and its tools run as this user unless QCR_TOOL_UID says otherwise", () => {
    const h = runHostStatus(NPM_GLOBAL, {});
    expect(h).toMatchObject({ in_image: false, install: "global", tool_uid: "off" });
    expect(h.warning).toMatch(/outside the release image \(global install\)/);
    expect(h.warning).toMatch(/set QCR_TOOL_UID/);
  });

  it("QCR_TOOL_UID outside the image is the opt-in split", () => {
    const h = runHostStatus(NPM_GLOBAL, { QCR_TOOL_UID: "1234" });
    expect(h.tool_uid).toBe("opt-in");
    expect(h.warning).toMatch(/QCR_TOOL_UID=1234/);
  });

  it("a checkout warns too", () => {
    const h = runHostStatus("/home/u/src/quickreview", {});
    expect(h).toMatchObject({ in_image: false, install: "checkout" });
    expect(h.warning).toBeDefined();
  });
});

describe("memory on a host without Docker", () => {
  it("is off outside the image when no Docker answers", () => {
    expect(memoryOffOnHost({ in_image: false }, true, () => false)).toBe(MEMORY_OFF_NO_DOCKER);
    expect(MEMORY_OFF_NO_DOCKER).toBe("memory off (no Docker)");
  });

  it("stays as configured in the image, with Docker, or when already off — Docker unasked", () => {
    let asked = 0;
    const probe = (up: boolean) => () => {
      asked++;
      return up;
    };
    expect(memoryOffOnHost({ in_image: true }, true, probe(false))).toBeUndefined();
    expect(memoryOffOnHost({ in_image: false }, false, probe(false))).toBeUndefined();
    expect(asked).toBe(0);
    expect(memoryOffOnHost({ in_image: false }, true, probe(true))).toBeUndefined();
    expect(asked).toBe(1);
  });

  it("hostFacts carries both", () => {
    expect(hostFacts(NPM_GLOBAL, true, {}, () => false)).toMatchObject({
      runHost: { in_image: false },
      memoryOff: MEMORY_OFF_NO_DOCKER,
    });
    expect(hostFacts("/opt/qcr", true, {}, () => false).memoryOff).toBeUndefined();
  });

  it("Docker is up only when `docker info` names a server version", () => {
    expect(dockerAvailableSync(() => ({ status: 0, stdout: "27.3.1\n" }))).toBe(true);
    expect(dockerAvailableSync(() => ({ status: 0, stdout: "" }))).toBe(false);
    expect(dockerAvailableSync(() => ({ status: 1, stdout: "" }))).toBe(false);
    expect(dockerAvailableSync(() => ({ status: null, stdout: "" }))).toBe(false);
    expect(
      dockerAvailableSync(() => {
        throw new Error("ENOENT");
      }),
    ).toBe(false);
  });
});

describe("the warning reaches the log, status.json and qcr status", () => {
  const daemon = readFileSync(join(process.cwd(), "src", "daemon.ts"), "utf8");
  const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");

  // MUTATION: drop either line in daemon.ts — this fails.
  it("the daemon logs it at start and writes the block into every heartbeat", () => {
    expect(daemon).toMatch(
      /if \(deps\.runHost\?\.warning\) log\(`WARNING: \$\{deps\.runHost\.warning\}`\);/,
    );
    expect(daemon).toMatch(
      /if \(deps\.runHost\) snapshot\.run_host = deps\.runHost;\s*writeStatusJson/,
    );
  });

  it("the production entry point asks its host before assembling", () => {
    expect(wire).toMatch(
      /buildParts\(root, loaded, hostFacts\(root, loaded\.openviking\.enabled\)\)/,
    );
    expect(wire).toMatch(/\.\.\.\(parts\.runHost \? \{ runHost: parts\.runHost \} : \{\}\),/);
  });

  it("qcr status prints it under the headline", () => {
    const snapshot = {
      written_at: "2026-10-23T10:00:00.000Z",
      dry_run: false,
      prs: [],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "2026-10-23T10:00:00.000Z",
      run_host: runHostStatus(NPM_GLOBAL, {}),
    } as unknown as StatusSnapshot;
    const lines = renderStatus(snapshot).split("\n");
    expect(lines[1]).toMatch(/^WARNING: running outside the release image/);
  });
});

describe("the release image is unchanged", () => {
  it("still names its tool uid and runs its own entrypoint", () => {
    const dockerfile = readFileSync(join(process.cwd(), "docker", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/ENV QCR_IMAGE_TOOL_UID="\$\{QCR_TOOL_UID\}"/);
  });
});
