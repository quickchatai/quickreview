// [P2.1] The engine fences, laid before the engine grows.
//
//   S2 SDK allowlist  only the core's packages/pi-plugin/src/engine/pisdk.ts and the extension
//                     factory modules import @earendil-works/pi-coding-agent
//                     at runtime
//   daemon / engine   no daemon module's import closure reaches src/engine/
//                     (the app's hosts or the core's, packages/pi-plugin),
//                     which keeps the process-global HTTP dispatcher out of
//                     the daemon
//   SDK host          no extension's import closure (the companion's pi, the
//                     tmux bot's) reaches an SDK host module [P5.7]
//   packageability    src/engine/** (both) carries no image-only path and reads no
//                     QCR_STATE_HOME, so a post-v1 pi package stays possible
//
// Each fence is verified by mutation, in this file: the scan runs on the real
// tree (must be clean) and on a planted tree (must fail).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  daemonReachesEngine,
  engineImageOnlyPaths,
  extensionsReachSdkHost,
  importsSdkAtRuntime,
  runtimeSdkImporters,
} from "./helpers/engine-fences.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

/** A throwaway tree holding `files` (path -> text), removed after `fn`. */
function planted<T>(files: Record<string, string>, fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "engine-fence-"));
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

const SDK = '"@earendil-works/pi-coding-agent"';

// The tree check for this fence is S2 in tests/single-shepherd.test.ts; the
// scan and its planted cases live here.
describe("[P2.1] S2: the pi SDK is imported at runtime by pisdk.ts and the extension factories only", () => {
  it("classifies the import shapes", () => {
    for (const yes of [
      `import { createAgentSession } from ${SDK};`,
      `import {\n  a,\n  type B,\n} from ${SDK};`,
      `import * as sdk from ${SDK};`,
      `import ${SDK};`,
      `export { x } from ${SDK};`,
      `const m = await import(${SDK});`,
      `const m = require(${SDK});`,
      `import { configureHttpDispatcher } from "@earendil-works/pi-coding-agent/dist/x.js";`,
    ])
      expect(importsSdkAtRuntime(yes), yes).toBe(true);
    for (const no of [
      `import type { Pi } from ${SDK};`,
      `import type {\n  Pi,\n  PiToolDefinition,\n} from ${SDK};`,
      `export type { Pi } from ${SDK};`,
      `// import { x } from ${SDK};`,
      `/* import { x } from ${SDK}; */`,
      ` * import { x } from ${SDK};`,
      `const s = 1;`,
    ])
      expect(importsSdkAtRuntime(no), no).toBe(false);
  });

  it("fails on a planted runtime import from a runLens-shaped engine module", () => {
    planted(
      {
        "packages/pi-plugin/src/engine/pisdk.ts": `import { createAgentSession } from ${SDK};\n`,
        "packages/pi-plugin/src/engine/lens/runlens.ts": `import { createAgentSession } from ${SDK};\n`,
        "src/typeonly.ts": `import type { Pi } from ${SDK};\n`,
        "src/engine/host.ts": `import { createAgentSession } from ${SDK};\n`,
        "extensions/factory.ts": `import { x } from ${SDK};\n`,
        "packages/pi-plugin/extensions/factory.ts": `import { x } from ${SDK};\n`,
      },
      (root) => {
        const offenders = runtimeSdkImporters(root).filter(
          (f) =>
            f !== "packages/pi-plugin/src/engine/pisdk.ts" &&
            !f.startsWith("extensions/") &&
            !f.startsWith("packages/pi-plugin/extensions/"),
        );
        expect(offenders).toEqual([
          "packages/pi-plugin/src/engine/lens/runlens.ts",
          "src/engine/host.ts",
        ]);
      },
    );
  });
});

describe("[P2.1] no daemon module imports src/engine/", () => {
  /**
   * MUTATION: add `import "./engine/envmap.js"` to src/wire.ts, or to anything
   * wire.ts, daemon.ts, sessions.ts, verdicts.ts, dispatch.ts or posting.ts
   * imports — the chain appears here.
   */
  it("holds on the tree", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(daemonReachesEngine(ROOT)).toEqual([]);
  });

  it("fails on a planted import, direct, transitive and through the core's package", () => {
    planted(
      {
        "src/wire.ts": `import { helper } from "./util.js";\nimport { a } from "./engine/direct.js";\nimport { c } from "./corered.js";\n`,
        "src/util.ts": `export { b } from "./engine/lens/deep.js";\n`,
        "src/corered.ts": `export { c } from "@quickchatai/pi-quickreview/src/engine/core.js";\n`,
        "src/engine/direct.ts": `export const a = 1;\n`,
        "src/engine/lens/deep.ts": `export const b = 1;\n`,
        "packages/pi-plugin/src/engine/core.ts": `export const c = 1;\n`,
        "src/cli.ts": `import "./engine/direct.js";\n`, // not a daemon root
      },
      (root) => {
        expect(daemonReachesEngine(root)).toEqual([
          "src/wire.ts > src/corered.ts > packages/pi-plugin/src/engine/core.ts",
          "src/wire.ts > src/engine/direct.ts",
          "src/wire.ts > src/util.ts > src/engine/lens/deep.ts",
        ]);
      },
    );
  });

  it("ignores a commented-out import", () => {
    planted(
      {
        "src/wire.ts": `// import { a } from "./engine/direct.js";\n`,
        "src/engine/direct.ts": `export const a = 1;\n`,
      },
      (root) => expect(daemonReachesEngine(root)).toEqual([]),
    );
  });
});

describe("[P2.1] packageability (R22): src/engine/** holds no image-only path", () => {
  /**
   * MUTATION: put `"/opt/qcr/dist"` or `process.env.QCR_STATE_HOME` in any
   * src/engine/ module — it appears here. Paths arrive through
   * SessionSpec/config.
   */
  it("holds on the tree", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(engineImageOnlyPaths(ROOT)).toEqual([]);
  });

  it.each([
    [`export const APP = "/opt/qcr";\n`, "'/opt/qcr'"],
    [`export const APP = "/opt/qcr/dist/src/cli.js";\n`, "'/opt/qcr'"],
    [`export const R = \`/opt/quickreview/state\`;\n`, "'/opt/quickreview'"],
    [`export const M = "/qcr-state/pi";\n`, "a companion mount point"],
    [`export const h = process.env.QCR_STATE_HOME;\n`, "QCR_STATE_HOME"],
    [`export const d = join(home, "state/pi-sessions");\n`, "a state-home layout literal"],
  ])("fails on a planted literal %#", (text, what) => {
    planted(
      { "packages/pi-plugin/src/engine/lens/bad.ts": text, "src/engine/bad.ts": text },
      (root) => {
        const found = engineImageOnlyPaths(root);
        expect(found.length).toBe(2);
        expect(found[0]).toContain("packages/pi-plugin/src/engine/lens/bad.ts");
        expect(found[1]).toContain("src/engine/bad.ts");
        expect(found[1]).toContain(what);
        expect(found[0]).toContain(what);
      },
    );
  });

  it("ignores prose in comments and files outside src/engine/", () => {
    planted(
      {
        "packages/pi-plugin/src/engine/ok.ts": `// the image carries it at /opt/qcr\n/* QCR_STATE_HOME */\nexport const x = 1;\n`,
        "src/other.ts": `export const APP = "/opt/qcr";\n`,
      },
      (root) => expect(engineImageOnlyPaths(root)).toEqual([]),
    );
  });
});

describe("[P5.7] no pi process hosts an SDK session: extensions/ never reach an SDK host module", () => {
  /**
   * MUTATION: add `import "../src/engine/caserunner-sdk.js"` (or the core's
   * pisdk.js, sdkruntime.js) to any extension, the app's or the core's, or to
   * anything an extension imports —
   * src/scancli.ts included — and the chain appears here. scancli loads the
   * scan's SDK leaf runner only inside the detached driver, by a dynamic
   * import that no extension reaches.
   */
  it("holds on the tree", { timeout: HEAVY_TIMEOUT_MS }, () => {
    expect(extensionsReachSdkHost(ROOT)).toEqual([]);
  });

  it("fails on a planted import, direct, transitive and dynamic", () => {
    planted(
      {
        "extensions/setup.ts": `import { scan } from "../src/scan.js";\nimport "@quickchatai/pi-quickreview/src/engine/pisdk.js";\n`,
        "extensions/other.ts": `const m = await import("../src/lazy.js");\n`,
        "extensions/clean.ts": `import { a } from "@quickchatai/pi-quickreview/src/engine/auth.js";\n`,
        "packages/pi-plugin/extensions/core.ts": `import { s } from "../src/engine/sdkruntime.js";\n`,
        "src/scan.ts": `export { x } from "./engine/caserunner-sdk.js";\n`,
        "src/lazy.ts": `import("@quickchatai/pi-quickreview/src/engine/sdkruntime.js");\n`,
        "packages/pi-plugin/src/engine/pisdk.ts": `export const p = 1;\n`,
        "packages/pi-plugin/src/engine/sdkruntime.ts": `export const r = 1;\n`,
        "src/engine/caserunner-sdk.ts": `export const c = 1;\n`,
        "packages/pi-plugin/src/engine/auth.ts": `export const a = 1;\n`,
      },
      (root) => {
        expect(extensionsReachSdkHost(root)).toEqual([
          "extensions/other.ts > src/lazy.ts > packages/pi-plugin/src/engine/sdkruntime.ts",
          "extensions/setup.ts > packages/pi-plugin/src/engine/pisdk.ts",
          "extensions/setup.ts > src/scan.ts > src/engine/caserunner-sdk.ts",
          "packages/pi-plugin/extensions/core.ts > packages/pi-plugin/src/engine/sdkruntime.ts",
        ]);
      },
    );
  });

  it("lets the core's extensions/lens.ts reach the host builder and nothing else, and no other extension", () => {
    planted(
      {
        "packages/pi-plugin/extensions/lens.ts": `import { H } from "../src/engine/pisdk.js";\nimport "../src/engine/sdkruntime.js";\n`,
        "extensions/other.ts": `import "@quickchatai/pi-quickreview/src/engine/pisdk.js";\n`,
        "packages/pi-plugin/src/engine/pisdk.ts": `export const H = 1;\n`,
        "packages/pi-plugin/src/engine/sdkruntime.ts": `export const r = 1;\n`,
      },
      (root) =>
        expect(extensionsReachSdkHost(root)).toEqual([
          "extensions/other.ts > packages/pi-plugin/src/engine/pisdk.ts",
          "packages/pi-plugin/extensions/lens.ts > packages/pi-plugin/src/engine/sdkruntime.ts",
        ]),
    );
    planted(
      {
        "packages/pi-plugin/extensions/lens.ts": `import { x } from "../src/engine/lens/tool.js";\n`,
        "packages/pi-plugin/src/engine/lens/tool.ts": `import type { H } from "../pisdk.js";\nexport const x = 1;\n`,
        "packages/pi-plugin/src/engine/pisdk.ts": `export const H = 1;\n`,
      },
      (root) => expect(extensionsReachSdkHost(root)).toEqual([]),
    );
  });

  it("ignores a commented-out import", () => {
    planted(
      {
        "extensions/setup.ts": `// import "@quickchatai/pi-quickreview/src/engine/pisdk.js";\n`,
        "packages/pi-plugin/src/engine/pisdk.ts": `export const p = 1;\n`,
      },
      (root) => expect(extensionsReachSdkHost(root)).toEqual([]),
    );
  });
});
