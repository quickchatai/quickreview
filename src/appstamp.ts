// The app's build stamp: one hash over the files the companion image copies
// from the checkout (docker/companion/Dockerfile, admitted by the root
// .dockerignore). `qcr companion rebuild` stamps the image with it
// (`--build-arg BUILD_SHA`, the `qcr.build-sha` label), and the scan sandbox
// compares the image's stamp with the checkout's before it runs a driver
// there, so a container never drives a scan with code other than the host's.
//
// A leaf: node built-ins only, so the companion lifecycle and the scan
// sandbox both read it.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** What the image copies into its app dir, relative to the app root — the
 * ignore list's allowlist, entry for entry. `src/` and `extensions/` ride
 * along so a pi extension loaded from the image resolves its imports. */
export const BAKED_PATHS = [
  "package.json",
  "package-lock.json",
  "dist",
  "src",
  "extensions",
  "agents",
  "prompts",
  "seeds",
  "profiles",
  "docker/companion",
] as const;

/** Directory names never descended: none of them is copied into the image. */
const SKIP = new Set(["node_modules", ".git"]);

/** The stamp of the baked files under `root`: 16 hex digits of a sha256
 * over each file's path, length and bytes, in path order. A missing path adds
 * nothing. */
export function appStamp(root: string): string {
  const files: string[] = [];
  const visit = (rel: string): void => {
    const abs = join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isFile()) {
      files.push(rel);
      return;
    }
    if (!st.isDirectory()) return;
    for (const name of readdirSync(abs)) if (!SKIP.has(name)) visit(`${rel}/${name}`);
  };
  for (const p of BAKED_PATHS) visit(p);
  files.sort();
  const h = createHash("sha256");
  for (const f of files) {
    const bytes = readFileSync(join(root, f));
    h.update(`${f}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return h.digest("hex").slice(0, 16);
}
