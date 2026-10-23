// A real pi that loads the app's extension shims (extensions/cli/*.ts) loads
// the review core the way production does: `@quickchatai/pi-quickreview/...`
// through the package's export map, i.e. its COMPILED dist/. The vitest alias
// that points those specifiers at the core's sources covers only what vitest
// itself loads, so a suite that spawns such a pi runs the build, and with a
// missing or stale one it fails somewhere far from the cause. This names the
// cause first.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { emittedPath, inputFiles, readTsconfig } from "../../scripts/verify-dist.mjs";
import { CORE_PACKAGE } from "./source-trees.js";

/** Why the core's compiled tree cannot stand in for its sources (missing, or
 * a source newer than its output), or null when it can. */
export function coreBuildProblem(root: string): string | null {
  const at = join(root, CORE_PACKAGE);
  const cfg = readTsconfig(at);
  const stale: string[] = [];
  for (const src of inputFiles(at, cfg)) {
    const out = join(at, emittedPath(src, cfg));
    if (!existsSync(out) || statSync(out).mtimeMs < statSync(join(at, src)).mtimeMs)
      stale.push(`${CORE_PACKAGE}/${src}`);
  }
  if (stale.length === 0) return null;
  return (
    `${CORE_PACKAGE}/dist is missing or older than its sources (${stale.slice(0, 3).join(", ")}` +
    `${stale.length > 3 ? `, … ${stale.length - 3} more` : ""}): this suite spawns a real pi, ` +
    `which loads the compiled core. Run \`npm run build\` first.`
  );
}
