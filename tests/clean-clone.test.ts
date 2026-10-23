// The clean-clone check: nothing this repo ships may resolve against
// a `dist/` artifact whose SOURCE no longer exists.
//
// `npm run build` compiles into `dist/` without removing what is no longer
// produced, and `dist/` is never cleaned. So a module can be deleted from
// `extensions/` or `src/` while its compiled `.js` sits in `dist/` forever —
// and anything importing that path keeps "working" on the machine that once
// built it while failing on any fresh `git clone`.
//
// It also catches a reference to a path the compiler never emits (the layout
// is `dist/src/<file>.js`, not `dist/<file>.js`), which no build can fix.
//
// The check therefore resolves every `dist/…` reference back to its SOURCE,
// never to `dist/` itself: asserting against `dist/` would inherit exactly the
// staleness it exists to catch, and would pass on a dirty tree and fail on a
// clean one.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every `dist/<path>.<js|mjs|cjs>` literal, the app's or a workspace
 * package's (`packages/<name>/dist/…`), wherever it appears. */
const DIST_REF = /(?:packages\/[A-Za-z0-9_-]+\/)?dist\/[A-Za-z0-9_./-]+\.(?:js|mjs|cjs)/g;

/**
 * The source file a `dist/` path is compiled from. `tsconfig.json` sets
 * `outDir: "dist"` over `src/**` and `extensions/**` with `rootDir: "."`, so
 * the layout is `dist/<dir>/<file>.js` ⟵ `<dir>/<file>.ts`; a workspace package
 * (packages/pi-plugin) does the same inside its own directory.
 */
function sourceFor(distPath: string): string {
  return distPath.replace(/^(packages\/[^/]+\/)?dist\//, "$1").replace(/\.(js|mjs|cjs)$/, ".ts");
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(full);
        continue;
      }
      if (statSync(full).size > 512 * 1024) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Where a stale `dist/` reference would strand a stranger: the advertised
 * commands and the shell/node they run. */
function surfaces(): string[] {
  return [join(root, "package.json"), ...filesUnder(join(root, "scripts"))];
}

describe("clean-clone check — no dist/ reference outlives its source", () => {
  it("finds the references at all, so a broken regex cannot make this vacuous", () => {
    const found = surfaces().flatMap((f) => readFileSync(f, "utf8").match(DIST_REF) ?? []);
    // A green suite proves the assertions that exist
    // pass, not that they assert what their names suggest. If the scan ever
    // stops finding references, this test is checking nothing.
    expect(found.length).toBeGreaterThan(5);
    expect(new Set(found).size).toBeGreaterThan(3);
  });

  it("every dist/ path an advertised command resolves has a source in the tree", () => {
    const missing: string[] = [];
    for (const file of surfaces()) {
      for (const ref of new Set(readFileSync(file, "utf8").match(DIST_REF) ?? [])) {
        const src = sourceFor(ref);
        if (!existsSync(join(root, src))) {
          missing.push(`${file.slice(root.length + 1)} → ${ref} (no ${src})`);
        }
      }
    }
    // A stale entry here means the referenced module was deleted (or the path
    // never existed) and only an uncleaned dist/ is hiding it. Fix the
    // reference or the script step — never the assertion.
    expect(missing).toEqual([]);
  });

  it("the retired companion-wake module is gone from every surface, source and reference alike", () => {
    expect(existsSync(join(root, "extensions/companion-wake.ts"))).toBe(false);
    for (const file of surfaces()) {
      expect(readFileSync(file, "utf8"), file).not.toContain("companion-wake");
    }
  });
});
