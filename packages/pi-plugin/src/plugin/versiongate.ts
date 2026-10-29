// The pi versions the plugin runs on: the range its package.json declares
// for @earendil-works/pi-coding-agent in peerDependencies. The plugin reads
// the running pi's exported VERSION at load and, outside the range, registers
// no command at all and says why once: an engine written against one pi's
// SDK must never half-run on another. The CLI and the release image pin pi
// exactly; the range is the plugin's alone, and only versions the canaries
// were run on belong in it.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRootFrom } from "../assetroot.js";

/** The package whose version is gated. */
export const PI_PACKAGE = "@earendil-works/pi-coding-agent";

interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** A prerelease tag (`1.4.0-rc.1`): never inside a range here. */
  pre: string | null;
}

/** `1.3.0` (a leading `v` allowed, build metadata ignored); null when it is
 * not a version. */
export function parseSemver(v: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? null };
}

const cmp = (a: Semver, b: Semver): number =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch;

/**
 * Does `version` satisfy `range`? The range forms the plugin declares: an exact
 * version, a caret (`^1.3.0`: the same major, at least that version; for a 0.x,
 * the same minor), or comparators joined by spaces (`>=1.3.0 <1.5.0`). A
 * prerelease never satisfies. Anything else is refused: false.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseSemver(version);
  if (v === null || v.pre !== null) return false;
  const parts = range.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === "") return false;
  return parts.every((p) => {
    const caret = /^\^(.+)$/.exec(p);
    if (caret) {
      const lo = parseSemver(caret[1]!);
      if (lo === null || lo.pre !== null) return false;
      if (cmp(v, lo) < 0) return false;
      return lo.major > 0 ? v.major === lo.major : v.major === 0 && v.minor === lo.minor;
    }
    const op = /^(>=|<=|>|<|=)?(.+)$/.exec(p);
    const at = op ? parseSemver(op[2]!) : null;
    if (op === null || at === null || at.pre !== null) return false;
    const c = cmp(v, at);
    switch (op[1] ?? "=") {
      case ">=":
        return c >= 0;
      case "<=":
        return c <= 0;
      case ">":
        return c > 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}

/** The peer ranges this package declares, from its own package.json (the
 * version gate's pi range, and the peers src/plugin/peers.ts resolves). */
export function declaredPeerRanges(from: string = import.meta.url): Record<string, string> {
  const root = packageRootFrom(dirname(fileURLToPath(from)), "the plugin's package.json");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    peerDependencies?: Record<string, string>;
  };
  return pkg.peerDependencies ?? {};
}

/** The range this package declares for pi, from its own package.json. */
export function declaredPiRange(from: string = import.meta.url): string {
  const range = declaredPeerRanges(from)[PI_PACKAGE];
  if (typeof range !== "string" || range.trim() === "")
    throw new Error(`the plugin's package.json declares no peer range for ${PI_PACKAGE}`);
  return range;
}

/** The plugin's verdict on the running pi: null when it may load, else the
 * one message a person is told. */
export function piGate(running: string, range: string): string | null {
  if (satisfiesRange(running, range)) return null;
  return (
    `QuickReview runs on pi ${range}, and this pi is ${running || "an unknown version"}: ` +
    "its commands (/qcr-review, /qcr-scan, /qcr-setup) are not loaded. " +
    `Use a pi in ${range}, or a QuickReview release made for this pi.`
  );
}
