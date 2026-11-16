// The app's shipped defaults: `config.example.toml` at the app's package root,
// the file every app surface reads a config.toml over
// (packages/pi-plugin/src/shippedconfig.ts `readConfigToml`). Found from the
// app's own package root, never from the review core's asset root: an image
// that carries the app but not the core's data (the memory sidecar ships the
// core as `package.json` + `dist/`, with no `assets/`, `agents/` or
// `prompts/`) has no asset root, and its config must still load. Every app
// image copies the file to its app root (tests/shipped-config-images.test.ts).
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { packageRootFrom } from "@quickchatai/pi-quickreview/src/assetroot.js";
import {
  readConfigToml,
  shippedConfigText,
} from "@quickchatai/pi-quickreview/src/shippedconfig.js";

/** The shipped defaults' text at the app package root above `moduleDir` (this
 * module's own directory by default: `src/` in a checkout, `dist/src/` once
 * built). */
export function appShippedConfigText(
  moduleDir: string = dirname(fileURLToPath(import.meta.url)),
): string {
  return shippedConfigText(packageRootFrom(moduleDir, "app package root"));
}

/** A config.toml's text over the app's shipped defaults. */
export function readAppConfigToml(toml: string): Record<string, unknown> {
  return readConfigToml(toml, appShippedConfigText());
}
