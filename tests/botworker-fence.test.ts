// [P8.3] The bot worker opens no state.db. The daemon stays the only SQLite
// writer, so the worker's runtime import closure holds neither the state store
// nor a SQLite binding, and the worker's own code does not name them. Verified
// by mutation: the scan runs on the real tree (clean) and on planted trees.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runtimeSpecifiers,
  workerNamesTheStore,
  workerReachesStateStore,
} from "./helpers/worker-fences.js";

const ROOT = join(import.meta.dirname, "..");

function planted<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "worker-fence-"));
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

describe("[P8.3] src/botworker.ts opens no state.db", () => {
  it("its runtime import closure holds no state store and no SQLite binding", () => {
    expect(workerReachesStateStore(ROOT)).toEqual([]);
  });

  it("its own code does not name the store", () => {
    expect(workerNamesTheStore(ROOT)).toEqual([]);
  });

  it("fails on every planted way in", () => {
    const hits = planted(
      {
        "src/botworker.ts": [
          `import { a } from "./via-state.js";`,
          `import { b } from "./via-package.js";`,
          `import { c } from "./via-dynamic.js";`,
          `import type { Row } from "./state.js";`,
          `import { type Other } from "./state.js";`,
          `import { ok } from "./ok.js";`,
        ].join("\n"),
        "src/ok.ts": `export const ok = 1;\n// import { x } from "./state.js";\n`,
        "src/via-state.ts": `import { StateStore } from "./state.js";\n`,
        "src/via-package.ts": `import Database from "better-sqlite3";\n`,
        "src/via-dynamic.ts": `const m = await import("./deep/state-user.js");\n`,
        "src/deep/state-user.ts": `import { s } from "node:sqlite";\n`,
        "src/state.ts": `import Database from "better-sqlite3";\n`,
      },
      (root) => workerReachesStateStore(root),
    );
    expect(hits).toEqual([
      "src/botworker.ts > src/via-dynamic.ts > src/deep/state-user.ts > node:sqlite",
      "src/botworker.ts > src/via-package.ts > better-sqlite3",
      "src/botworker.ts > src/via-state.ts > src/state.ts",
    ]);
  });

  it("the closure follows the core's package specifiers into packages/pi-plugin", () => {
    const hits = planted(
      {
        "src/botworker.ts": `import { a } from "@quickchatai/pi-quickreview/src/engine/a.js";\n`,
        "packages/pi-plugin/src/engine/a.ts": `import { b } from "../b.js";\n`,
        "packages/pi-plugin/src/b.ts": `import { DatabaseSync } from "node:sqlite";\n`,
        "packages/pi-plugin/extensions/x.ts": `import Database from "better-sqlite3";\n`,
      },
      (root) => workerReachesStateStore(root),
    );
    expect(hits).toEqual([
      "src/botworker.ts > packages/pi-plugin/src/engine/a.ts > packages/pi-plugin/src/b.ts > node:sqlite",
    ]);
  });

  it("a re-export is an edge", () => {
    const hits = planted(
      {
        "src/botworker.ts": `export { StateStore } from "./state.js";\n`,
        "src/state.ts": `import Database from "better-sqlite3";\n`,
      },
      (root) => workerReachesStateStore(root),
    );
    expect(hits).toEqual(["src/botworker.ts > src/state.ts"]);
  });

  it("type-only imports are not edges", () => {
    const hits = planted(
      {
        "src/botworker.ts": [
          `import type { Row } from "./state.js";`,
          `import { type Other, type More } from "./state.js";`,
          `export type { Row } from "./state.js";`,
        ].join("\n"),
        "src/state.ts": `import Database from "better-sqlite3";\n`,
      },
      (root) => workerReachesStateStore(root),
    );
    expect(hits).toEqual([]);
  });

  it("a worker that names the store in its own code is caught", () => {
    const words = planted(
      { "src/botworker.ts": `const p = process.env.QCR_STATE_DB;\nopen("state.db");\n` },
      (root) => workerNamesTheStore(root),
    );
    expect(words).toEqual(["state.db", "QCR_STATE_DB"]);
  });

  it("reads import forms the way the build erases them", () => {
    expect(
      runtimeSpecifiers(
        [
          `import a from "./a.js";`,
          `import type { T } from "./t.js";`,
          `import { type U } from "./u.js";`,
          `import { type V, w } from "./vw.js";`,
          `export * from "./star.js";`,
          `import "./effect.js";`,
          `const x = await import("./dyn.js");`,
        ].join("\n"),
      ).sort(),
    ).toEqual(["./a.js", "./dyn.js", "./effect.js", "./star.js", "./vw.js"]);
  });
});
