// deploy/manifest.schema.json and scripts/deploy-manifest.mjs: the record CI
// emits next to a release's two images and `deploy.sh release` reads.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestLines, manifestProblems, parseManifest } from "../scripts/deploy-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests", "fixtures", "deploy-manifest-1.2.3.json");
const text = readFileSync(fixture, "utf8");
const schema = JSON.parse(readFileSync(join(root, "deploy", "manifest.schema.json"), "utf8")) as {
  required: string[];
  properties: {
    pins: { required: string[]; properties: Record<string, { $ref?: string }> };
    images: { required: string[] };
  };
  $defs: { image: { required: string[] }; pin: { pattern?: string } };
};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const edit = (fn: (m: Json) => void): string => {
  const m = JSON.parse(text) as Json;
  fn(m);
  return JSON.stringify(m);
};

describe("the deploy manifest", () => {
  it("accepts the fixture and yields the lines deploy.sh reads", () => {
    const m = parseManifest(text);
    expect(m.version).toBe("1.2.3");
    expect(manifestLines(m)).toContain(
      "DAEMON_INDEX_DIGEST=sha256:1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(manifestLines(m)).toContain("PIN_PI=1.4.0");
    expect(manifestLines(m)).toContain("PIN_RUNSPEC=1");
  });

  it("holds both index digests and the per-arch digests", () => {
    const m = JSON.parse(text);
    for (const img of ["daemon", "memory"]) {
      expect(m.images[img].index_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(Object.keys(m.images[img].platforms).sort()).toEqual(["linux/amd64", "linux/arm64"]);
    }
  });

  it("REFUSES a malformed manifest, naming every problem", () => {
    for (const [what, body, needle] of [
      ["not JSON", "{ nope", "not JSON"],
      ["an array", "[]", "not a JSON object"],
      ["a missing revision", edit((m) => delete m.revision), 'missing "revision"'],
      ["a short revision", edit((m) => (m.revision = "abc")), "revision"],
      ["a bad version", edit((m) => (m.version = "latest")), "version"],
      [
        "a bad digest",
        edit((m) => (m.images.daemon.index_digest = "sha256:short")),
        "index_digest",
      ],
      [
        "a missing arch",
        edit((m) => delete m.images.memory.platforms["linux/arm64"]),
        'missing "linux/arm64"',
      ],
      [
        "a bad arch digest",
        edit((m) => (m.images.memory.platforms["linux/amd64"] = "x")),
        "platforms",
      ],
      ["an unknown key", edit((m) => (m.extra = 1)), 'unknown key "extra"'],
      ["a missing pin", edit((m) => delete m.pins.pi), 'missing "pi"'],
      ["a bad embedder sha", edit((m) => (m.pins.embedder_sha256 = "zz")), "embedder_sha256"],
      ["a bad runspec", edit((m) => (m.pins.runspec = 0)), "runspec"],
      ["a pin that is a shell command", edit((m) => (m.pins.pi = "1.0; rm -rf /")), "pins.pi"],
      ["schema 2", edit((m) => (m.schema = 2)), "schema"],
    ] as const) {
      expect(() => parseManifest(body), what).toThrow(needle);
    }
    expect(
      manifestProblems(
        JSON.parse(
          edit((m) => {
            delete m.revision;
            m.version = "x";
          }),
        ),
      ).length,
    ).toBe(2);
  });

  it("the CLI prints the lines, refuses a manifest for another version, and exits non-zero on a bad file", () => {
    const ok = spawnSync("node", [join(root, "scripts", "deploy-manifest.mjs"), fixture, "1.2.3"], {
      encoding: "utf8",
    });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("VERSION=1.2.3");
    const other = spawnSync(
      "node",
      [join(root, "scripts", "deploy-manifest.mjs"), fixture, "1.2.4"],
      { encoding: "utf8" },
    );
    expect(other.status).toBe(1);
    expect(other.stderr).toContain("is for version 1.2.3, not 1.2.4");
    const dir = mkdtempSync(join(tmpdir(), "qcr-manifest-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(
        bad,
        edit((m) => delete m.images),
      );
      const r = spawnSync("node", [join(root, "scripts", "deploy-manifest.mjs"), bad], {
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("malformed deploy manifest");
      expect(
        execFileSync("node", [join(root, "scripts", "deploy-manifest.mjs"), fixture], {
          encoding: "utf8",
        }),
      ).toContain("REVISION=");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a platform digest that is not a string is reported, never coerced", () => {
    const digest = JSON.parse(edit(() => {})).images.daemon.platforms["linux/amd64"];
    const problems = manifestProblems(
      JSON.parse(edit((m) => (m.images.daemon.platforms["linux/amd64"] = [digest]))),
    );
    expect(problems).toContain('images.daemon.platforms["linux/amd64"]: not a sha256 digest');
  });

  it("a repository that is not a string is reported, never passed on", () => {
    for (const bad of [null, 7, ["ghcr.io/x/y"], {}]) {
      const problems = manifestProblems(
        JSON.parse(edit((m) => (m.images.daemon.repository = bad))),
      );
      expect(problems, JSON.stringify(bad)).toContain("images.daemon.repository: not a string");
    }
  });

  it("the schema documents what the validator enforces (same required keys)", () => {
    expect([...schema.required].sort()).toEqual([
      "images",
      "pins",
      "revision",
      "schema",
      "version",
    ]);
    expect([...schema.properties.images.required].sort()).toEqual(["daemon", "memory"]);
    expect([...schema.$defs.image.required].sort()).toEqual([
      "index_digest",
      "platforms",
      "repository",
    ]);
    expect([...schema.properties.pins.required].sort()).toEqual([
      "embedder_file",
      "embedder_sha256",
      "llama_cpp_python",
      "openviking",
      "pi",
      "runspec",
    ]);
    // each required key is one the validator reports missing
    for (const k of schema.required) {
      expect(manifestProblems(JSON.parse(edit((m) => delete m[k])))).toContain(
        `manifest: missing "${k}"`,
      );
    }
  });

  it("the schema's plain-string pins accept and refuse the same values as the validator", () => {
    for (const k of ["pi", "openviking", "llama_cpp_python", "embedder_file"]) {
      expect(schema.properties.pins.properties[k]?.$ref, k).toBe("#/$defs/pin");
      const pattern = schema.$defs.pin.pattern as string | undefined;
      expect(pattern, k).toBeTypeOf("string");
      const re = new RegExp(pattern!);
      for (const v of [
        "1.3.0",
        "models/a_b.gguf",
        "v1+x@y:z-1",
        "has space",
        "semi;colon",
        "$(x)",
      ]) {
        const refused = manifestProblems(
          JSON.parse(edit((m) => ((m.pins as Record<string, unknown>)[k] = v))),
        ).some((e) => e.startsWith(`pins.${k}:`));
        expect(re.test(v), `${k}=${v}`).toBe(!refused);
      }
    }
  });

  it("the fixture's pins are the repo's own (pi, openviking, llama, embedder), so a drift is caught here too", () => {
    const m = JSON.parse(text) as { pins: Record<string, string | number> };
    const gv = readFileSync(join(root, "deploy", "ansible", "group_vars", "all.yml"), "utf8");
    const val = (k: string): string =>
      new RegExp(`^${k}:\\s*"?([^"\\n]+)"?`, "m").exec(gv)![1]!.trim();
    expect(m.pins.pi).toBe(val("pi_version"));
    expect(m.pins.openviking).toBe(val("openviking_version"));
    expect(m.pins.llama_cpp_python).toBe(val("llama_cpp_python_version"));
    expect(m.pins.embedder_sha256).toBe(val("openviking_local_embedder_sha256"));
    expect(m.pins.embedder_file).toBe(
      `${val("openviking_local_embedder_dir")}/${val("openviking_local_embedder_model")}.gguf`,
    );
  });
});
