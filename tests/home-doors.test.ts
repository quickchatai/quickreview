// The home's doors, structurally: what a bare `qcr` loads never starts the
// companion (only `qcr tui` does), and every source file the home's pi loads
// by path ships in the npm package, so the launch finds it in an installed
// package as it does in a checkout.
//
// Both walk the real import graph from the home's two entries: the launch a
// bare `qcr` runs (src/home/launch.ts) and the extension shim pi loads
// (extensions/cli/home.ts), following every relative import, static or
// dynamic, to the files it reaches.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { homeExtensionPath } from "../src/home/launch.js";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRIES = ["src/home/launch.ts", "extensions/cli/home.ts"];

/** Every app source file reachable from `entries` through relative imports. */
function reachable(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const stack = entries.map((e) => resolve(ROOT, e));
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g)) {
      let target = resolve(dirname(file), m[1]!);
      if (target.endsWith(".js")) target = `${target.slice(0, -3)}.ts`;
      if (existsSync(target)) stack.push(target);
    }
  }
  return [...seen].map((f) => relative(ROOT, f)).sort();
}

/** Does the package.json `files` list ship `path`? Directory entries, exact
 * files and negations, as the list writes them. */
function shipped(files: readonly string[], path: string): boolean {
  const matches = (pattern: string): boolean => {
    if (pattern.startsWith("**/")) return path.split("/").at(-1) === pattern.slice(3);
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -2));
    if (pattern.endsWith("/")) return path.startsWith(pattern);
    if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
    return path === pattern;
  };
  let on = false;
  for (const f of files) {
    if (f.startsWith("!")) {
      if (matches(f.slice(1))) on = false;
    } else if (matches(f)) on = true;
  }
  return on;
}

describe("the home's doors", () => {
  const graph = reachable(ENTRIES);

  it("the walk reaches the home's own modules", () => {
    // a walk that found nothing would pass the fences below vacuously
    for (const f of [
      "extensions/home.ts",
      "src/home/setup.ts",
      "src/home/setupcard.ts",
      "src/home/setupadapters.ts",
      "src/home/panel.ts",
    ])
      expect(graph, f).toContain(f);
  });

  // MUTATION: import CompanionLifecycle from ../tui/companion.js in src/home/launch.ts — this fails.
  it("a bare qcr never reaches the companion's lifecycle: only qcr tui starts it", () => {
    const companion = graph.filter((f) =>
      [
        "src/tui/companion.ts",
        "src/tui/companionplan.ts",
        "src/tui/nativecompanion.ts",
        "src/tui/index.ts",
      ].includes(f),
    );
    expect(companion).toEqual([]);
    // and the TUI's start is where it is started
    expect(readFileSync(resolve(ROOT, "src/tui/index.ts"), "utf8")).toMatch(
      /new CompanionLifecycle\(/,
    );
  });

  // MUTATION: drop "extensions/" (or "src/") from package.json `files` — this fails.
  it("every file the home's pi loads by path ships in the npm package", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
      files: string[];
    };
    const missing = graph.filter((f) => !shipped(pkg.files, f));
    expect(missing).toEqual([]);
    // the launch names the shim under the package root it runs from
    expect(relative("/pkg", homeExtensionPath("/pkg"))).toBe("extensions/cli/home.ts");
    expect(graph).toContain("extensions/cli/home.ts");
  });
});
