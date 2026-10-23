// The scan behind the IPC fence. A pure function over a repo root, so
// tests/fences-ipc.test.ts runs it on the real tree AND on a planted one.
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { stripComments, tsFilesUnder } from "./engine-fences.js";

/**
 * Every import in src/ipc/ that reaches outside src/ipc/ or names anything but
 * a node: builtin. The module is NEUTRAL: it imports no engine, no pi, no
 * daemon module, no package, so the daemon (which must not reach src/engine/)
 * and a worker can both speak it. Returned as "file: specifier".
 */
export function ipcImportViolations(root: string): string[] {
  const ipcDir = join(root, "src", "ipc");
  const out: string[] = [];
  for (const f of tsFilesUnder(ipcDir)) {
    const code = stripComments(readFileSync(f, "utf8"));
    const specs = [
      ...code.matchAll(/\b(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/g),
      ...code.matchAll(/(?:^|[\n;])\s*import\s*["']([^"']+)["']/g),
      ...code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]!);
    for (const spec of specs) {
      const ok = spec.startsWith("node:")
        ? true
        : spec.startsWith(".") && !relative(ipcDir, resolve(dirname(f), spec)).startsWith("..");
      if (!ok) out.push(`${relative(root, f)}: ${spec}`);
    }
  }
  return out.sort();
}
