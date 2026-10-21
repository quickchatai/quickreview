// scripts/emit-deploy-manifest.mjs: the manifest the release workflow attaches.
// It must validate against the P7.14 parser (deploy-manifest.mjs, documented by
// deploy/manifest.schema.json) and carry the pins the checkout's Dockerfiles hold.
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "emit-deploy-manifest.mjs");
const parser = join(root, "scripts", "deploy-manifest.mjs");
const d = (c: string): string => `sha256:${c.repeat(64)}`;

function emit(version: string, release: object, memory: object) {
  const dir = mkdtempSync(join(tmpdir(), "emit-manifest-"));
  try {
    writeFileSync(join(dir, "digests-release.json"), JSON.stringify(release));
    writeFileSync(join(dir, "digests-memory.json"), JSON.stringify(memory));
    const out = join(dir, `deploy-manifest-${version}.json`);
    const r = spawnSync(
      "node",
      [
        script,
        "--version",
        version,
        "--revision",
        "0123456789abcdef0123456789abcdef01234567",
        "--digests",
        dir,
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    const parsed = spawnSync("node", [parser, out, version], { encoding: "utf8" });
    let text = "";
    try {
      text = readFileSync(out, "utf8");
    } catch {
      /* not written */
    }
    return { r, text, parsed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rel = {
  repository: "ghcr.io/quickchatai/quickreview",
  index: d("1"),
  amd64: d("2"),
  arm64: d("3"),
};
const mem = {
  repository: "ghcr.io/quickchatai/quickreview-memory",
  index: d("4"),
  amd64: d("5"),
  arm64: d("6"),
};

describe("emit-deploy-manifest", () => {
  it("writes a manifest the controller's parser accepts, with both index and per-arch digests", () => {
    const { r, text, parsed } = emit("1.2.3", rel, mem);
    expect(r.status, r.stderr).toBe(0);
    expect(parsed.status, parsed.stderr).toBe(0);
    const m = JSON.parse(text);
    expect(m.images.daemon.index_digest).toBe(d("1"));
    expect(m.images.daemon.platforms["linux/arm64"]).toBe(d("3"));
    expect(m.images.memory.index_digest).toBe(d("4"));
    expect(m.revision).toBe("0123456789abcdef0123456789abcdef01234567");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(m.pins.pi).toBe(pkg.pi.version);
    expect(m.pins.runspec).toBeGreaterThanOrEqual(1);
  });

  it("refuses to write a manifest the parser would refuse", () => {
    const { r, text } = emit("1.2.3", { ...rel, index: "sha256:short" }, mem);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("index_digest");
    expect(text).toBe("");
  });
});
