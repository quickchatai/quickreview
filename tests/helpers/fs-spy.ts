// Records every filesystem call whose first argument is a path under a watched
// directory, for a test that must prove a component reads and writes nothing
// there. It wraps the functions of node:fs and node:fs/promises in place and
// re-syncs the ESM named exports, so modules that imported `{ readFileSync }`
// are caught too, and it works whether or not the OS would have allowed the call
// (a chmod 000 directory only makes an attempt fail; this makes it visible).
import fs from "node:fs";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve, sep } from "node:path";

export interface FsSpy {
  /** "<function> <path>" for each touch of a watched path, in order. */
  touches: string[];
  restore(): void;
}

function pathOf(arg: unknown): string | undefined {
  if (typeof arg === "string") return arg;
  if (arg instanceof URL && arg.protocol === "file:") return arg.pathname;
  if (Buffer.isBuffer(arg)) return arg.toString();
  return undefined;
}

type Fn = (...args: unknown[]) => unknown;

export function spyOnFs(watched: readonly string[]): FsSpy {
  const roots = watched.map((w) => resolve(w));
  const touches: string[] = [];
  const restores: Array<() => void> = [];
  const wrap = (holder: Record<string, unknown>, prefix: string): void => {
    for (const name of Object.keys(holder)) {
      const original = holder[name];
      // Classes (Stats, Dirent, ReadStream) and the promises namespace stay as they are.
      if (typeof original !== "function" || /^[A-Z]/.test(name)) continue;
      holder[name] = function (this: unknown, ...args: unknown[]) {
        const p = pathOf(args[0]);
        if (p !== undefined) {
          const abs = resolve(p);
          if (roots.some((r) => abs === r || abs.startsWith(r + sep)))
            touches.push(`${prefix}${name} ${abs}`);
        }
        return (original as Fn).apply(this, args);
      };
      restores.push(() => {
        holder[name] = original;
      });
    }
  };
  wrap(fs as unknown as Record<string, unknown>, "");
  wrap(fsp as unknown as Record<string, unknown>, "promises.");
  syncBuiltinESMExports();
  return {
    touches,
    restore() {
      for (const r of restores.splice(0)) r();
      syncBuiltinESMExports();
    },
  };
}
