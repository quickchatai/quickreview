// The layer fence: core imports only core, the CLI never imports the
// app, and core never owns the process. See tests/helpers/layers.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { coreForbiddenCalls, layerOf, runtimeSpecifiers, upwardEdges } from "./helpers/layers.js";
import { CORE_FORBIDDEN_ALLOWED, UPWARD_EDGES_ALLOWED } from "./helpers/layer-allowlist.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("the layer fence on the real tree", () => {
  it(
    "has no upward edge outside the ratchet, and no stale ratchet entry",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
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

  it("sees a core → app edge, a cli → app edge, and keeps a type-only import out", () => {
    mkdirSync(join(dir, "src/engine"), { recursive: true });
    writeFileSync(
      join(dir, "src/state.ts"),
      "export const s = 1;\nexport interface Row { a: number }\n",
    );
    writeFileSync(
      join(dir, "src/engine/x.ts"),
      'import { s } from "../state.js";\nimport type { Row } from "../state.js";\nexport const y: Row = { a: s };\n',
    );
    writeFileSync(
      join(dir, "src/engine/t.ts"),
      'import { Row } from "../state.js";\nexport const z: Row = { a: 1 };\n',
    );
    writeFileSync(
      join(dir, "src/reviewcli.ts"),
      'export async function f() { return import("./state.js"); }\n',
    );
    expect(upwardEdges(dir)).toEqual([
      "src/engine/x.ts -> src/state.ts",
      "src/reviewcli.ts -> src/state.ts",
    ]);
  });

  it("sees a forbidden call and ignores one in a comment", () => {
    mkdirSync(join(dir, "src/engine"), { recursive: true });
    writeFileSync(
      join(dir, "src/engine/p.ts"),
      "// process.exit(1) in prose\nexport function q() { process.exit(2); }\n",
    );
    expect(coreForbiddenCalls(dir)).toContain("src/engine/p.ts: process.exit");
    expect(coreForbiddenCalls(dir)).not.toContain("src/engine/x.ts: process.exit");
  });

  it("classifies the hosts of the bot and bench as app", () => {
    expect(layerOf("src/engine/round.ts")).toBe("core");
    expect(layerOf("src/engine/botsdk.ts")).toBe("app");
    expect(layerOf("src/reviewcli.ts")).toBe("cli");
    expect(layerOf("src/daemon.ts")).toBe("app");
  });

  it("reads re-exports and side-effect imports", () => {
    expect(runtimeSpecifiers('export { a } from "./a.js";\nimport "./b.js";\n').sort()).toEqual([
      "./a.js",
      "./b.js",
    ]);
  });
});
