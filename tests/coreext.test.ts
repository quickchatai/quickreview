// The core's own pi extensions, as files the app hands pi (src/coreext.ts):
// found through the core PACKAGE's directory, in both layouts that package
// has. A checkout links the workspace, whose .ts sources are there; an npm
// install ships only the build, and the app's root has no packages/ at all.
import { afterAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  FINDING_CLUSTERS_ENTRY,
  PLUGIN_PACKAGE,
  coreExtensionPath,
  extensionFile,
  pluginPackageDir,
} from "../src/coreext.js";

const ROOT = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "coreext-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
const put = (file: string, body = ""): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
};

/** An app installed by npm: its own package, and the core beside it under
 * node_modules, carrying only what the core's tarball ships. */
function npmInstall(): { app: string; core: string } {
  const prefix = join(tmp, `install-${n++}`);
  const app = join(prefix, "node_modules", "@quickchatai", "quickreview");
  const core = join(prefix, "node_modules", ...PLUGIN_PACKAGE.split("/"));
  put(join(app, "package.json"), JSON.stringify({ name: "@quickchatai/quickreview" }));
  put(join(app, "dist", "src", "coreext.js"));
  put(
    join(core, "package.json"),
    JSON.stringify({ name: PLUGIN_PACKAGE, exports: { "./package.json": "./package.json" } }),
  );
  put(join(core, "dist", "extensions", "finding-clusters.js"), "export default () => {};\n");
  return { app, core };
}

/** The core as a checkout has it: the sources, and a build beside them. */
function workspace(): string {
  const core = join(tmp, `workspace-${n++}`, "packages", "pi-plugin");
  put(join(core, "extensions", "finding-clusters.ts"), "export default () => {};\n");
  put(join(core, "dist", "extensions", "finding-clusters.js"), "export default () => {};\n");
  return core;
}

describe("coreExtensionPath", () => {
  it("a checkout's core: the .ts source, even with a build beside it", () => {
    const core = workspace();
    expect(coreExtensionPath("finding-clusters", core)).toBe(
      join(core, "extensions", "finding-clusters.ts"),
    );
  });

  // MUTATION: return the source path unconditionally — this fails.
  it("an installed core, which ships no sources: the built dist/extensions/<name>.js", () => {
    const { core } = npmInstall();
    expect(coreExtensionPath("finding-clusters", core)).toBe(
      join(core, "dist", "extensions", "finding-clusters.js"),
    );
  });

  it("this checkout: the plugin package is the linked workspace, and the source is loaded", () => {
    expect(realpathSync(pluginPackageDir())).toBe(join(ROOT, "packages", "pi-plugin"));
    expect(realpathSync(coreExtensionPath("finding-clusters"))).toBe(
      join(ROOT, "packages", "pi-plugin", "extensions", "finding-clusters.ts"),
    );
  });
});

describe("an npm install end to end", () => {
  it("the app finds the core beside it and loads its build; its root has no packages/", () => {
    const { app, core } = npmInstall();
    const pkg = pluginPackageDir(pathToFileURL(join(app, "dist", "src", "coreext.js")).href);
    expect(realpathSync(pkg)).toBe(realpathSync(core));
    const file = extensionFile(app, FINDING_CLUSTERS_ENTRY, pkg);
    expect(file).toBe(join(pkg, "dist", "extensions", "finding-clusters.js"));
    expect(readFileSync(file, "utf8")).toContain("export default");
    expect(readdirSync(app)).not.toContain("packages");
  });
});

describe("extensionFile", () => {
  it("an app shim is a path under the root", () => {
    expect(extensionFile("/r", "extensions/cli/bash-guard.ts", "/nowhere")).toBe(
      "/r/extensions/cli/bash-guard.ts",
    );
  });

  // MUTATION: join(root, entry) for every entry — this fails.
  it("a core entry is the core package's file in either layout, never under the root", () => {
    const ws = workspace();
    expect(extensionFile("/r", FINDING_CLUSTERS_ENTRY, ws)).toBe(
      join(ws, "extensions", "finding-clusters.ts"),
    );
    const { core } = npmInstall();
    expect(extensionFile("/r", FINDING_CLUSTERS_ENTRY, core)).toBe(
      join(core, "dist", "extensions", "finding-clusters.js"),
    );
  });
});

/** Every .ts under the app's src/, recursively. */
function appSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? appSources(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("the fence", () => {
  // The app never names a core extension as a path under its own root: that
  // path exists in a checkout only. A reader is a quoted string literal; a
  // comment that points at the core's file in backticks does not count.
  // MUTATION: put back "packages/pi-plugin/extensions/finding-clusters.ts" in
  // src/opencli.ts MAIN_OPEN_EXTENSIONS — this fails.
  it("no app source builds a core extension's path under the app's root", () => {
    const literal =
      /["']packages\/pi-plugin\/extensions\/|"packages",\s*"pi-plugin",\s*"extensions"/;
    const offenders = appSources(join(ROOT, "src"))
      .filter((f) => literal.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
