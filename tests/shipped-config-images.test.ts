// The app reads every config.toml over the shipped defaults, the
// `config.example.toml` at the app's package root (src/shippeddefaults.ts):
// the package root is where the image puts `package.json` and `dist/`, the
// directory `packageRootFrom(dist/src)` finds. So every image that runs the
// app's config parser copies config.example.toml there, and its build context
// admits it; an image without it refuses to load any config at all.
//
// And the app's parser never needs the review core's asset root: the memory
// sidecar's image ships the core with none (tests/memory-image.test.ts lays
// out that image).
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@quickchatai/pi-quickreview/src/assetroot.js", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@quickchatai/pi-quickreview/src/assetroot.js")>();
  return {
    ...real,
    assetRoot: (): string => {
      throw new Error("asset root not found (mocked: an image that ships the core without one)");
    },
  };
});

const { loadConfig, parseConfig } = await import("../src/config.js");

const ROOT = resolve(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** Each image that runs the app's config parser, with the ignore list its
 * build reads (BuildKit prefers `<Dockerfile>.dockerignore` to the root's). */
const IMAGES = [
  { dockerfile: "docker/Dockerfile", ignore: "docker/Dockerfile.dockerignore" },
  { dockerfile: "docker/companion/Dockerfile", ignore: ".dockerignore" },
  { dockerfile: "docker/memory/Dockerfile", ignore: "docker/memory/Dockerfile.dockerignore" },
] as const;

/** Where each COPY of the last stage lands: `[source, absolute destination]`. */
function lastStageCopies(text: string): [string, string][] {
  const lines = text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim());
  const from = lines.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter((i) => i >= 0);
  let workdir = "/";
  const out: [string, string][] = [];
  for (const line of lines.slice(from.at(-1))) {
    const wd = /^WORKDIR\s+(\S+)/.exec(line);
    if (wd) workdir = resolve(workdir, wd[1]!);
    if (!line.startsWith("COPY ")) continue;
    const args = line
      .split(/\s+/)
      .slice(1)
      .filter((p) => !p.startsWith("--"));
    const dest = args.at(-1)!;
    for (const src of args.slice(0, -1)) {
      const abs = resolve(workdir, dest);
      out.push([src, dest.endsWith("/") ? join(abs, basename(src)) : abs]);
    }
  }
  return out;
}

describe("every app image carries the shipped defaults at its app root", () => {
  // MUTATION: drop `COPY config.example.toml /opt/qcr/config.example.toml`
  // from docker/companion/Dockerfile (or `!config.example.toml` from the root
  // .dockerignore) — the scan sandbox refuses every config and this fails.
  it.each(IMAGES)("$dockerfile", ({ dockerfile, ignore }) => {
    const copies = lastStageCopies(read(dockerfile));
    const dist = copies.find(([src]) => /(^|\/)dist$/.test(src) && !src.includes("pi-plugin"));
    expect(dist, "the image copies the app's dist/").toBeDefined();
    const appRoot = resolve(dist![1], "..");
    const at = (file: string) => copies.find(([, d]) => d === join(appRoot, file));
    expect(at("package.json"), `${dockerfile}: package.json at ${appRoot}`).toBeDefined();
    expect(at("config.example.toml")?.[0], `${dockerfile}: config.example.toml at ${appRoot}`).toBe(
      "config.example.toml",
    );
    const admitted = read(ignore)
      .split("\n")
      .map((l) => l.trim());
    expect(admitted, `${ignore} admits config.example.toml`).toContain("!config.example.toml");
  });
});

describe("the app's config parser never needs the core's asset root", () => {
  // MUTATION: call `readConfigToml(toml)` in src/config.ts parseConfig (the
  // core's asset-root default) instead of passing the app's shipped text —
  // this fails.
  it("parses and loads a partial config with no asset root", () => {
    expect(parseConfig('[review]\nprofile = "state-machines"\n').review.profile).toBe(
      "state-machines",
    );
    const dir = mkdtempSync(join(tmpdir(), "qcr-no-asset-root-"));
    try {
      const path = join(dir, "config.toml");
      writeFileSync(path, '[openviking]\nendpoint = "remote"\n');
      expect(loadConfig(path).openviking.endpoint).toBe("remote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
