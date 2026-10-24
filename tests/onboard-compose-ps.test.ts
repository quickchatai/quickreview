// composePs before the bring-up: `docker compose ps` refuses to interpolate a
// compose file whose project .env has not been written yet, and that refusal
// must not read as an unknown stack. The first-run path that hit it: the
// github_account step writes config.toml, asks whether a daemon needs a
// restart, and went red ("delivery is unknown") on a machine with no stack.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../src/onboard/engine.js";
import { COMPOSE_PROJECT, composePs, projectPsArgs } from "../src/onboard/steps/compose.js";

const INTERPOLATION =
  "error while interpolating services.daemon.volumes.[]: required variable QCR_SECRETS_DIR is missing a value";

function runner(compose: ProcessResult, plain: ProcessResult) {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_cmd: string, args: readonly string[]): Promise<ProcessResult> => {
      calls.push([...args]);
      return args[0] === "compose" ? compose : plain;
    },
  };
}

describe("composePs", () => {
  it("answers from Docker's project label when the compose file cannot be read yet", async () => {
    // MUTATION: return the compose failure without asking `docker ps` — this fails.
    const r = runner({ code: 1, stdout: "", stderr: INTERPOLATION }, { code: 0, stdout: "", stderr: "" });
    expect(await composePs(r, "/checkout")).toEqual({ ok: true, rows: [], detail: "" });
    expect(r.calls[1]).toEqual(projectPsArgs());
    expect(projectPsArgs()).toContain(`label=com.docker.compose.project=${COMPOSE_PROJECT}`);
  });

  it("reads a running project container through the fallback in compose ps's own shape", async () => {
    const r = runner(
      { code: 1, stdout: "", stderr: INTERPOLATION },
      { code: 0, stdout: '{"Service":"daemon","State":"running"}\n{"Service":"memory","State":"running"}\n', stderr: "" },
    );
    expect((await composePs(r, "/checkout")).rows).toEqual([
      { service: "daemon", state: "running" },
      { service: "memory", state: "running" },
    ]);
  });

  it("stays unknown, with compose's own reason, when Docker cannot answer either", async () => {
    const r = runner(
      { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
      { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon" },
    );
    expect(await composePs(r, "/checkout")).toEqual({
      ok: false,
      rows: [],
      detail: "Cannot connect to the Docker daemon",
    });
  });

  it("labels by the project name docker-compose.yml itself declares", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    expect(/^name:\s*(\S+)\s*$/m.exec(compose)?.[1]).toBe(COMPOSE_PROJECT);
  });
});
