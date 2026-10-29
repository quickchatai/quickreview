// pi's own packages for what the plugin imports with Node's import()
// (packages/pi-plugin/src/plugin/peers.ts). pi installs a package without its
// peers, so a module the plugin loads outside pi's loader finds no pi beside
// it; the resolve hook answers from the running pi's package dir instead.
//
//   - the hook in isolation: Node's own answer first, the pi fallback only
//     for a declared peer Node could not find, every other failure as it was;
//   - the peers are the package.json's, so the two lists cannot drift;
//   - the real registerHooks route, in a child node over a pi-shaped tree:
//     the plugin's module resolves pi's packages from pi's dir, and an
//     undeclared package still fails. Skipped without a build (it runs the
//     core's dist/).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  declaredPeers,
  isPeer,
  peerResolve,
} from "@quickchatai/pi-quickreview/src/plugin/peers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORE = join(ROOT, "packages", "pi-plugin");
const PEERS_DIST = join(CORE, "dist", "src", "plugin", "peers.js");
const tmp = mkdtempSync(join(tmpdir(), "plugin-peers-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const notFound = (s: string): Error =>
  Object.assign(new Error(`Cannot find package '${s}'`), { code: "ERR_MODULE_NOT_FOUND" });

describe("the peer resolve hook", () => {
  const PI = "/opt/pi/node_modules/@earendil-works/pi-coding-agent";
  const PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
  const fromPi = pathToFileURL(join(PI, "package.json")).href;
  /** A Node resolver that finds a peer only when the importer is pi. */
  const next = (specifier: string, context?: { parentURL?: string }) => {
    if (specifier.startsWith("@earendil-works/") && context?.parentURL !== fromPi)
      throw notFound(specifier);
    return { url: `file:///resolved/${specifier}`, from: context?.parentURL };
  };
  const hook = peerResolve(PI, PEERS);

  it("keeps Node's own answer when it has one", () => {
    expect(hook("./lens.js", { parentURL: "file:///plugin/x.js" }, next)).toEqual({
      url: "file:///resolved/./lens.js",
      from: "file:///plugin/x.js",
    });
  });

  // MUTATION: drop the fallback (rethrow every error) — this fails.
  it("resolves a declared peer, and a subpath of one, from pi's package dir", () => {
    const ctx = { parentURL: "file:///plugin/dist/extensions/lens.js", conditions: ["import"] };
    expect(hook("@earendil-works/pi-coding-agent", ctx, next)).toEqual({
      url: "file:///resolved/@earendil-works/pi-coding-agent",
      from: fromPi,
    });
    expect(hook("@earendil-works/pi-ai/oauth", ctx, next)).toMatchObject({ from: fromPi });
  });

  // MUTATION: make isPeer answer true for any specifier — this fails.
  it("leaves an undeclared package and every other error as Node raised them", () => {
    const ctx = { parentURL: "file:///plugin/x.js" };
    expect(() => hook("@earendil-works/pi-other", ctx, next)).toThrow(/pi-other/);
    expect(() => hook("@earendil-works/pi-ai-x", ctx, next)).toThrow(/pi-ai-x/);
    const denied = () => {
      throw Object.assign(new Error("denied"), { code: "ERR_ACCESS_DENIED" });
    };
    expect(() => hook("@earendil-works/pi-ai", ctx, denied)).toThrow("denied");
  });

  it("names a peer or a subpath of one, never a longer name", () => {
    expect(isPeer("typebox", ["typebox"])).toBe(true);
    expect(isPeer("typebox/value", ["typebox"])).toBe(true);
    expect(isPeer("typeboxy", ["typebox"])).toBe(false);
  });

  it("takes the peers from the plugin's package.json", () => {
    const pkg = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")) as {
      peerDependencies: Record<string, string>;
    };
    expect(declaredPeers()).toEqual(Object.keys(pkg.peerDependencies));
    expect(declaredPeers()).toContain("@earendil-works/pi-coding-agent");
  });
});

/** Write `files` (path -> text) under `root`. */
function tree(root: string, files: Record<string, string>): void {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
}

describe.skipIf(!existsSync(PEERS_DIST))("in a child node, through module.registerHooks", () => {
  it("resolves pi's packages for the plugin's own import(), once per process", () => {
    // pi as npm lays it out: the package, with its own dependency hoisted beside it
    const piHome = join(tmp, "pi", "node_modules", "@earendil-works");
    const pkg = (name: string, body: string) => ({
      [`${name}/package.json`]: JSON.stringify({
        name: `@earendil-works/${name}`,
        type: "module",
        exports: { ".": "./index.js" },
      }),
      [`${name}/index.js`]: body,
    });
    tree(piHome, {
      ...pkg("pi-coding-agent", 'export const who = "pi";\n'),
      ...pkg("pi-ai", 'export const ai = "ai";\n'),
    });
    // the plugin as pi installs it: no peer beside it
    const plugin = join(tmp, "plugin", "node_modules", "@quickchatai", "pi-quickreview");
    const lens = [
      'import { who } from "@earendil-works/pi-coding-agent";',
      'import { ai } from "@earendil-works/pi-ai";',
      "export default `${who}+${ai}`;",
    ].join("\n");
    tree(plugin, {
      "package.json": JSON.stringify({ name: "@quickchatai/pi-quickreview", type: "module" }),
      "before.js": lens,
      "lens.js": lens,
      "other.js": 'import "left-pad-nowhere";\n',
    });
    const at = (f: string) => pathToFileURL(join(plugin, f)).href;
    const script = `
      const out = {};
      const code = (e) => e?.code ?? String(e);
      try { await import(${JSON.stringify(at("before.js"))}); out.before = "ok"; } catch (e) { out.before = code(e); }
      const { resolvePeersFrom } = await import(${JSON.stringify(pathToFileURL(PEERS_DIST).href)});
      const peers = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"];
      out.first = resolvePeersFrom(${JSON.stringify(join(piHome, "pi-coding-agent"))}, peers);
      out.second = resolvePeersFrom("/nowhere", peers);
      out.lens = (await import(${JSON.stringify(at("lens.js"))})).default;
      try { await import(${JSON.stringify(at("other.js"))}); out.other = "ok"; } catch (e) { out.other = code(e); }
      process.stdout.write(JSON.stringify(out));
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual({
      before: "ERR_MODULE_NOT_FOUND",
      first: true,
      second: false,
      lens: "pi+ai",
      other: "ERR_MODULE_NOT_FOUND",
    });
  });
});
