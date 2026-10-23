// How this qcr was installed, read from where its package sits.
//
// A leaf: no import at all, so the daemon's host check (src/runhost.ts) and
// the npm bin's verbs (src/npmverbs.ts) share it without the daemon reaching
// the login and pi verbs.

/** The release image's app root (src/tui/companion.ts `CONTAINER.app`). */
export const IMAGE_APP_ROOT = "/opt/qcr";

export type Installer = "npm" | "pnpm" | "bun";

/** How this qcr was installed, read from where its package sits. */
export type InstallKind =
  | { kind: "image" }
  | { kind: "checkout"; root: string }
  | { kind: "global"; installer: Installer; root: string }
  | { kind: "local"; installer: Installer; root: string };

/** Where this qcr's package sits, and who put it there. The path decides
 * first (pnpm's and bun's global stores are recognisable); otherwise the user
 * agent of the package manager that ran it (`npm_config_user_agent`); npm is
 * the default. A package outside any `node_modules/` is a checkout; the
 * release image is its own kind. */
export function detectInstall(
  pkgRoot: string,
  env: Readonly<Record<string, string | undefined>>,
): InstallKind {
  const p = pkgRoot.replace(/\\/g, "/");
  if (p === IMAGE_APP_ROOT || p.startsWith(`${IMAGE_APP_ROOT}/`) || env["QCR_IMAGE_TOOL_UID"])
    return { kind: "image" };
  const parts = p.split("/");
  if (!parts.includes("node_modules")) return { kind: "checkout", root: pkgRoot };
  const ua = (env["npm_config_user_agent"] ?? "").trim();
  let installer: Installer = "npm";
  if (/\/\.bun\/install\/global\//.test(p) || /\/\.bun\//.test(p)) installer = "bun";
  else if (/\/pnpm\/global\//.test(p) || p.includes("/.pnpm/") || /\/pnpm-global\//.test(p))
    installer = "pnpm";
  else if (ua.startsWith("pnpm/")) installer = "pnpm";
  else if (ua.startsWith("bun/")) installer = "bun";
  // npm's global root is <prefix>/lib/node_modules (unix) or <prefix>/node_modules
  // (Windows); pnpm's and bun's global stores are named for it.
  const global =
    /\/lib\/node_modules\//.test(p) ||
    /\/pnpm\/global\//.test(p) ||
    /\/pnpm-global\//.test(p) ||
    /\/\.bun\/install\/global\//.test(p) ||
    /\/npm\/node_modules\//i.test(p) ||
    (env["npm_config_global"] ?? "") === "true";
  return { kind: global ? "global" : "local", installer, root: pkgRoot };
}
