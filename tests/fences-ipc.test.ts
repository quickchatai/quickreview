// The IPC fence: src/ipc/ is a neutral module. It imports nothing from
// src/engine/, nothing from pi, no daemon module and no package, only node:
// builtins and its own files. Verified by mutation: the scan runs on the real
// tree (clean) and on a planted tree (must fail).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ipcImportViolations } from "./helpers/ipc-fences.js";

const ROOT = join(import.meta.dirname, "..");

function planted<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "ipc-fence-"));
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

describe("src/ipc imports no engine, no pi, no daemon module", () => {
  it("holds on the real tree", () => {
    expect(ipcImportViolations(ROOT)).toEqual([]);
  });

  it("fails on every planted way in", () => {
    const hits = planted(
      {
        "src/ipc/ok.ts": `import net from "node:net";\nimport { a } from "./other.js";\n`,
        "src/ipc/other.ts": `export const a = 1;\n// import { x } from "../engine/auth.js";\n`,
        "src/ipc/engine.ts": `import { x } from "../engine/auth.js";\n`,
        "src/ipc/pi.ts": `import { createAgentSession } from "@earendil-works/pi-coding-agent";\n`,
        "src/ipc/daemon.ts": `export { y } from "../state.js";\n`,
        "src/ipc/dyn.ts": `const m = await import("../engine/pisdk.js");\n`,
        "src/ipc/pkg.ts": `import Database from "better-sqlite3";\n`,
        "src/ipc/side.ts": `import "../engine/x.js";\n`,
      },
      ipcImportViolations,
    );
    expect(hits).toEqual([
      "src/ipc/daemon.ts: ../state.js",
      "src/ipc/dyn.ts: ../engine/pisdk.js",
      "src/ipc/engine.ts: ../engine/auth.js",
      "src/ipc/pi.ts: @earendil-works/pi-coding-agent",
      "src/ipc/pkg.ts: better-sqlite3",
      "src/ipc/side.ts: ../engine/x.js",
    ]);
  });
});
