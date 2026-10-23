// The layer fence: core (packages/pi-plugin) imports only core, and core
// never owns the process. See tests/helpers/layers.ts.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  coreForbiddenCalls,
  fencedFiles,
  layerOf,
  resolveSpecifier,
  runtimeSpecifiers,
  upwardEdges,
} from "./helpers/layers.js";
import { CORE_FORBIDDEN_ALLOWED, UPWARD_EDGES_ALLOWED } from "./helpers/layer-allowlist.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("the layer fence on the real tree", () => {
  it(
    "has no upward edge outside the ratchet, and no stale ratchet entry",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      // The core is really there to fence: a moved or renamed package would
      // otherwise pass on an empty set.
      expect(fencedFiles(ROOT).filter((f) => layerOf(f) === "core").length).toBeGreaterThan(100);
      const actual = upwardEdges(ROOT);
      expect(
        actual.filter((e) => !UPWARD_EDGES_ALLOWED.includes(e)),
        "new upward edges",
      ).toEqual([]);
      expect(
        UPWARD_EDGES_ALLOWED.filter((e) => !actual.includes(e)),
        "cut edges still listed",
      ).toEqual([]);
    },
  );

  it(
    "has no forbidden process call in core outside the ratchet",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const actual = coreForbiddenCalls(ROOT);
      expect(
        actual.filter((e) => !CORE_FORBIDDEN_ALLOWED.includes(e)),
        "new forbidden calls",
      ).toEqual([]);
      expect(
        CORE_FORBIDDEN_ALLOWED.filter((e) => !actual.includes(e)),
        "fixed calls still listed",
      ).toEqual([]);
    },
  );
});

describe("the fence can fail", () => {
  const dir = mkdtempSync(join(resolve(ROOT, "node_modules/.cache"), "layers-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // MUTATION: drop the relative-edge check in upwardEdges — the first case
  // fails; drop the bare-package check — the app-by-name case fails.
  it("sees a core → app edge, by path or by package, and keeps a type-only import out", () => {
    const core = join(dir, "packages/pi-plugin/src/engine");
    mkdirSync(core, { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src/state.ts"),
      "export const s = 1;\nexport interface Row { a: number }\n",
    );
    writeFileSync(
      join(core, "x.ts"),
      'import { s } from "../../../../src/state.js";\nimport type { Row } from "../../../../src/state.js";\nexport const y: Row = { a: s };\n',
    );
    writeFileSync(
      join(core, "t.ts"),
      'import { Row } from "../../../../src/state.js";\nexport const z: Row = { a: 1 };\n',
    );
    writeFileSync(
      join(core, "c.ts"),
      'export async function f() { return import("@quickchatai/quickreview/src/state.js"); }\n',
    );
    // The app imports the core by name and by path: neither is an upward edge.
    writeFileSync(
      join(dir, "src/app.ts"),
      'import { y } from "@quickchatai/pi-quickreview/src/engine/x.js";\nimport "../packages/pi-plugin/src/engine/t.js";\nexport const a = y;\n',
    );
    expect(upwardEdges(dir)).toEqual([
      "packages/pi-plugin/src/engine/c.ts -> pkg:@quickchatai/quickreview/src/state.js",
      "packages/pi-plugin/src/engine/x.ts -> src/state.ts",
    ]);
  });

  it("sees a forbidden call and ignores one in a comment", () => {
    const core = join(dir, "packages/pi-plugin/src/engine");
    mkdirSync(core, { recursive: true });
    writeFileSync(
      join(core, "p.ts"),
      "// process.exit(1) in prose\nexport function q() { process.exit(2); }\n",
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/exits.ts"), "export function q() { process.exit(2); }\n");
    expect(coreForbiddenCalls(dir)).toContain("packages/pi-plugin/src/engine/p.ts: process.exit");
    expect(coreForbiddenCalls(dir)).not.toContain(
      "packages/pi-plugin/src/engine/x.ts: process.exit",
    );
    expect(coreForbiddenCalls(dir)).not.toContain("src/exits.ts: process.exit");
  });

  it("classifies by package: the core package is core, the rest is the app", () => {
    expect(layerOf("packages/pi-plugin/src/engine/round.ts")).toBe("core");
    expect(layerOf("packages/pi-plugin/extensions/lens.ts")).toBe("core");
    expect(layerOf("src/engine/botsdk.ts")).toBe("app");
    expect(layerOf("src/reviewcli.ts")).toBe("app");
    expect(layerOf("src/daemon.ts")).toBe("app");
  });

  it("follows the core's package specifiers to its sources", () => {
    mkdirSync(join(dir, "packages/pi-plugin/src"), { recursive: true });
    writeFileSync(join(dir, "packages/pi-plugin/src/gate.ts"), "export const g = 1;\n");
    expect(resolveSpecifier(dir, "src/wire.ts", "@quickchatai/pi-quickreview/src/gate.js")).toBe(
      "packages/pi-plugin/src/gate.ts",
    );
    expect(resolveSpecifier(dir, "src/wire.ts", "smol-toml")).toBeNull();
  });

  it("reads re-exports and side-effect imports", () => {
    expect(runtimeSpecifiers('export { a } from "./a.js";\nimport "./b.js";\n').sort()).toEqual([
      "./a.js",
      "./b.js",
    ]);
  });
});

// The app imports the core by its package name at hundreds of sites. In the
// repo the workspace link makes that resolve, declared or not; a published
// app has only what its dependencies name.
// MUTATION: drop the dependency, or bump one version without the other — this fails.
describe("the app declares the core", () => {
  const read = (p: string) =>
    JSON.parse(readFileSync(join(ROOT, p), "utf8")) as {
      version: string;
      dependencies?: Record<string, string>;
    };
  it("at the exact workspace version, equal to the app's own", () => {
    const app = read("package.json");
    const core = read("packages/pi-plugin/package.json");
    expect(app.dependencies?.["@quickchatai/pi-quickreview"]).toBe(core.version);
    expect(core.version).toBe(app.version);
  });
});
