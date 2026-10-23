// The WorkerSupervisor's fences:
//   - the daemon never imports src/engine/, and the supervisor is a daemon root
//     (it takes GITHUB_TOKEN_ENVS from packages/pi-plugin/src/envstrip.ts, which has no imports);
//   - it is the single writer of worker-hosted session_commands rows: the
//     requeue only it may call, and no worker-side module names the table.
// Each is verified by mutation: the scan runs on the real tree (clean) and on a
// planted tree (must fail).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAEMON_ROOTS,
  daemonReachesEngine,
  stripComments,
  tsFilesUnder,
} from "./helpers/engine-fences.js";
import { SRC_DIRS } from "./helpers/source-trees.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { CORE_NAME, escapeRe } from "./helpers/source-trees.js";

const ROOT = join(import.meta.dirname, "..");

function planted<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ws-fence-"));
  try {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), text);
    }
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The src/ files, the app's and the core's (not the store itself), whose code calls `method(`. */
function callers(root: string, method: string): string[] {
  return SRC_DIRS.flatMap((d) => tsFilesUnder(join(root, d)))
    .map((f) => relative(root, f))
    .filter((f) => f !== "src/state.ts")
    .filter((f) =>
      new RegExp(`\\b${method}\\(`).test(stripComments(readFileSync(join(root, f), "utf8"))),
    )
    .sort();
}

describe("the supervisor stays out of src/engine/", () => {
  it(
    "is a daemon root, and no chain from it reaches the engine",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      expect(DAEMON_ROOTS).toContain("src/workersupervisor.ts");
      expect(daemonReachesEngine(ROOT)).toEqual([]);
    },
  );

  it("takes the GitHub credential names from the core's src/envstrip.ts", () => {
    const text = stripComments(readFileSync(join(ROOT, "src/workersupervisor.ts"), "utf8"));
    expect(text).toMatch(
      new RegExp(
        `import \\{ GITHUB_TOKEN_ENVS \\} from "${escapeRe(CORE_NAME)}/src/envstrip\\.js"`,
      ),
    );
    expect(text).not.toMatch(/["']GITHUB_TOKEN["']/);
  });

  it("fails on a planted import of the engine, from the supervisor or from what it imports", () => {
    const hits = planted(
      {
        "src/workersupervisor.ts": `import { l } from "./workerlease.js";\nimport { a } from "./engine/auth.js";\n`,
        "src/workerlease.ts": `export { b } from "./engine/tooluid.js";\n`,
        "src/engine/auth.ts": `export const a = 1;\n`,
        "src/engine/tooluid.ts": `export const b = 1;\n`,
      },
      daemonReachesEngine,
    );
    expect(hits).toEqual([
      "src/workersupervisor.ts > src/engine/auth.ts",
      "src/workersupervisor.ts > src/workerlease.ts > src/engine/tooluid.ts",
    ]);
  });
});

describe("the supervisor is the single writer of worker-hosted command rows", () => {
  it("only src/workersupervisor.ts requeues a worker's command", () => {
    expect(callers(ROOT, "requeueWorkerCommand")).toEqual(["src/workersupervisor.ts"]);
  });

  it("no worker-side module names the table or its store methods", () => {
    const workerSide = [
      "src/botworker.ts",
      ...tsFilesUnder(join(ROOT, "src/ipc")).map((f) => relative(ROOT, f)),
    ];
    for (const f of workerSide) {
      const text = stripComments(readFileSync(join(ROOT, f), "utf8"));
      expect(text, f).not.toMatch(/session_commands|SessionCommandRow|[a-z]+SessionCommand\(/);
    }
  });

  it("fails on a planted second writer", () => {
    expect(
      planted(
        {
          "src/state.ts": `requeueWorkerCommand(a) {}\n`,
          "src/workersupervisor.ts": `store.requeueWorkerCommand(id, null, t);\n`,
          "src/sneaky.ts": `store.requeueWorkerCommand(id, null, t);\n`,
          "src/commented.ts": `// store.requeueWorkerCommand(id, null, t);\n`,
        },
        (root) => callers(root, "requeueWorkerCommand"),
      ),
    ).toEqual(["src/sneaky.ts", "src/workersupervisor.ts"]);
  });
});
