// The release image's contract (docker/Dockerfile), checked statically: the
// stages, the pins, the build-time checks, the root-owned tree that any uid
// can run, and the one reviewer stub. The checks that are shell in the
// Dockerfile are EXECUTED here from the Dockerfile's own text, so the FATAL
// guards are proved to fail, not just to be present.
//
// Building the image is not part of the suite: it needs docker and the
// network. `QCR_RELEASE_IMAGE=<tag> npx vitest run tests/release-image.test.ts`
// adds the run-it checks against an image built locally:
//   docker build -f docker/Dockerfile -t qcr-release .
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.js";
import { readInventory } from "./helpers/context-files.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const dockerfile = read("docker/Dockerfile");
const ignore = read("docker/Dockerfile.dockerignore");
const groupVars = read("deploy/ansible/group_vars/all.yml");
const cfg = parseConfig(read("config.example.toml"));

const gv = (key: string): string | undefined =>
  new RegExp(`^${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?$`, "m").exec(groupVars)?.[1];
const arg = (name: string): string | undefined =>
  new RegExp(`^ARG ${name}=(.+)$`, "m").exec(dockerfile)?.[1];

/** Instruction lines with continuations joined and comments dropped. */
const instructions = (text: string): string[] =>
  text
    .replace(/\\\n/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
const lines = instructions(dockerfile);
/** The Dockerfile with its comments gone: what the checks below are about. */
const code = lines.join("\n");
/** The body of the one RUN line containing `needle`. */
const runWith = (needle: string): string => {
  const hits = lines.filter((l) => l.startsWith("RUN ") && l.includes(needle));
  expect(hits, `RUN lines containing ${needle}`).toHaveLength(1);
  return hits[0]!.slice(4);
};

describe("release image — stages and pins", () => {
  it("has the build and release stages, release last (the default target)", () => {
    const stages = [...dockerfile.matchAll(/^FROM\s+\S+\s+AS\s+(\S+)$/gm)].map((m) => m[1]);
    expect(stages).toContain("build");
    expect(stages).toContain("release");
    expect(stages.at(-1)).toBe("release");
  });

  it("is multi-arch by construction: no pinned platform, no arch literal", () => {
    expect(code).not.toMatch(/--platform/);
    expect(code).not.toMatch(/\b(amd64|arm64|aarch64|x86_64)\b/);
    // the one arch-dependent line asks dpkg
    expect(code).toContain("dpkg --print-architecture");
  });

  it("pi: ARG defaults == config.toml [pi] == group_vars == package.json", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(arg("PI_VERSION")).toBe(cfg.pi.version);
    expect(arg("PI_VERSION")).toBe(gv("pi_version"));
    expect(arg("PI_PACKAGE")).toBe(cfg.pi.package);
    expect(arg("PI_PACKAGE")).toBe(gv("pi_npm_package"));
    expect(pkg.dependencies[cfg.pi.package]).toBe(arg("PI_VERSION"));
  });

  it("tmux and node defaults == group_vars", () => {
    expect(arg("TMUX_VERSION")).toBe(gv("tmux_version"));
    expect(arg("NODE_MAJOR")).toBe(gv("node_major"));
  });

  it("install lines reference the ARGs, never a literal version", () => {
    expect(dockerfile).toContain('"${PI_PACKAGE}@${PI_VERSION}"');
    expect(code).not.toMatch(/pi-coding-agent@\d/);
    expect(dockerfile).toContain("tmux-${TMUX_VERSION}");
  });

  it("pi comes from npm ci, with the global CLI pinned beside it", () => {
    expect(lines).toContain("RUN npm ci --no-audit --no-fund");
    expect(runWith("npm install -g")).toContain('"${PI_PACKAGE}@${PI_VERSION}"');
  });

  it("builds tmux from source; there are no OpenViking layers", () => {
    expect(lines.some((l) => /^RUN .*\.\/configure && make/.test(l))).toBe(true);
    expect(runWith("tmux -V")).toBe("tmux -V");
    expect(code).not.toMatch(/openviking|llama|\.gguf/i);
  });

  it("the build stage compiles with tsc and verifies dist", () => {
    expect(lines).toContain("RUN npx tsc -p tsconfig.json && node scripts/verify-dist.mjs");
    // …then ships production dependencies only
    expect(runWith("npm prune")).toContain("--omit=dev");
  });
});

describe("release image — any uid, a root-owned tree", () => {
  it("bakes /opt/qcr and runs from it", () => {
    expect(lines).toContain("WORKDIR /opt/qcr");
    expect(lines.at(-2)).toBe("WORKDIR /opt/qcr");
    // the one entrypoint, mode dispatch (tests/entrypoint.test.ts)
    expect(lines.at(-1)).toBe('ENTRYPOINT ["/opt/qcr/docker/entrypoint.sh"]');
  });

  it("creates no user and chowns nothing: the caller picks the uid", () => {
    expect(code).not.toMatch(/useradd|adduser|chown|--chown/);
    // the companion's and the VM's per-uid build args are gone
    expect(code).not.toMatch(/COMPANION_UID|REVIEW_UID/);
    // a default for a bare `docker run` is numeric: it needs no passwd entry
    expect(lines.filter((l) => l.startsWith("USER "))).toEqual(["USER 1000:1000"]);
  });

  it("fixes HOME at a world-writable sticky dir, so every uid has one", () => {
    expect(lines).toContain("ENV HOME=/home/qcr");
    expect(runWith("/home/qcr")).toBe("install -d -m 1777 /home/qcr");
  });

  it("makes the tree world-readable and writable by no runtime uid", () => {
    expect(runWith("chmod -R")).toBe(
      "chmod -R a+rX,go-w /opt/qcr && chmod 0444 /opt/qcr/AGENTS.override.md",
    );
  });

  it("lets git read repos mounted under any owner", () => {
    expect(runWith("safe.directory")).toBe("git config --system --add safe.directory '*'");
  });

  it("bakes code, seeds, manifest and profiles", () => {
    const copies = lines.filter((l) => l.startsWith("COPY ") && !l.includes("--from"));
    for (const dir of ["src", "extensions", "agents", "prompts", "seeds", "profiles", "schemas"])
      expect(copies, dir).toContain(`COPY ${dir} ./${dir}`);
    expect(copies).toContain(
      "COPY tests/fixtures/seed-manifest.json ./tests/fixtures/seed-manifest.json",
    );
    expect(lines).toContain("COPY --from=build /src/dist ./dist");
    expect(lines).toContain("COPY --from=build /src/node_modules ./node_modules");
  });

  it("every host path the Dockerfile copies is admitted by its own .dockerignore", () => {
    const admitted = new Set(
      ignore
        .split("\n")
        .filter((l) => l.startsWith("!"))
        .map((l) => l.slice(1)),
    );
    expect(ignore.split("\n").find((l) => l && !l.startsWith("#"))).toBe("*");
    const sources = lines
      .filter((l) => l.startsWith("COPY ") && !l.includes("--from"))
      .flatMap((l) => l.split(/\s+/).slice(1, -1))
      .map((p) => p.replace(/\/$/, ""));
    const covers = (a: string, s: string): boolean => s === a || s.startsWith(`${a}/`);
    for (const s of new Set(sources))
      expect(
        [...admitted].some((a) => covers(a, s)),
        s,
      ).toBe(true);
    // nothing else rides: every admitted path is copied
    for (const a of admitted)
      expect(
        sources.some((s) => covers(a, s)),
        a,
      ).toBe(true);
  });

  it("the secrets and state of a checkout are never admitted", () => {
    for (const bad of ["state", "evidence", ".env", "secrets", ".git"])
      expect(ignore.split("\n")).not.toContain(`!${bad}`);
    expect(ignore).toContain("**/.git");
    expect(ignore).toContain("**/node_modules");
  });
});

describe("release image — the reviewer stub (D34)", () => {
  it("lands as /opt/qcr/AGENTS.override.md, read-only, in the engine's cwd", () => {
    expect(lines).toContain("COPY deploy/reviewer/AGENTS.override.md ./AGENTS.override.md");
    // no full contributor guide anywhere in the tree: pi would find it
    expect(lines.filter((l) => /\b(AGENTS|CLAUDE)\.md\b/.test(l))).toEqual([]);
  });

  it("the inventory records the image's cwd loading exactly the stub", () => {
    const row = readInventory().routes["release-image"];
    expect(row?.cwd).toBe("/opt/qcr");
    expect(row?.effective).toEqual([
      { path: "/opt/qcr/AGENTS.override.md", source: "deploy/reviewer/AGENTS.override.md" },
    ]);
  });
});

describe("release image — rule 5: no claude", () => {
  it("asserts its absence and installs nothing of Anthropic's", () => {
    expect(lines).toContain("RUN ! command -v claude");
    expect(code).not.toMatch(/@anthropic-ai|claude-code|claude_driver/);
  });

  it("the claude arm lives only in bench/aacr/Dockerfile", () => {
    const bench = read("bench/aacr/Dockerfile");
    expect(`${bench}\n${dockerfile}`).toMatch(/claude/);
    expect(lines.filter((l) => /claude/i.test(l))).toEqual(["RUN ! command -v claude"]);
  });
});

// ---- the shell checks, executed ---------------------------------------------

interface Sandbox {
  dir: string;
  bin: string;
  env: NodeJS.ProcessEnv;
}

/** A scratch /opt/qcr: the seed trees and manifest, plus a fake npm. */
function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), "release-image-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const manifest = JSON.parse(read("tests/fixtures/seed-manifest.json")) as {
    files: Record<string, string>;
  };
  const app = join(dir, "opt-qcr");
  mkdirSync(join(app, "tests", "fixtures"), { recursive: true });
  copyFileSync(
    join(root, "tests/fixtures/seed-manifest.json"),
    join(app, "tests", "fixtures", "seed-manifest.json"),
  );
  for (const rel of Object.keys(manifest.files))
    for (const at of [rel, join("seeds", rel)]) {
      mkdirSync(dirname(join(app, at)), { recursive: true });
      copyFileSync(join(root, at), join(app, at));
    }
  // a global node_modules holding pi, and an `npm` that says where it is
  const globalRoot = join(dir, "global");
  mkdirSync(join(globalRoot, cfg.pi.package, "examples", "extensions", "subagent"), {
    recursive: true,
  });
  writeFileSync(
    join(globalRoot, cfg.pi.package, "examples", "extensions", "subagent", "index.ts"),
    "",
  );
  const npm = join(bin, "npm");
  writeFileSync(npm, `#!/bin/sh\necho ${globalRoot}\n`);
  chmodSync(npm, 0o755);
  return {
    dir,
    bin,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      PI_PACKAGE: cfg.pi.package,
      PI_VERSION: cfg.pi.version,
    },
  };
}

function sh(s: Sandbox, script: string): { status: number | null; stderr: string } {
  // the Dockerfile's RUN steps `cd /opt/qcr`; point that at the scratch copy
  const r = spawnSync("/bin/sh", ["-c", script.replaceAll("/opt/qcr", join(s.dir, "opt-qcr"))], {
    env: s.env,
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}

describe("release image — the build-time checks fail when they should", () => {
  const hasJq = spawnSync("jq", ["--version"]).status === 0;

  it("FATAL: the subagent example missing from the published pi", () => {
    const s = sandbox();
    try {
      const step = runWith("examples/extensions/subagent/index.ts");
      expect(sh(s, step).status).toBe(0);
      rmSync(
        join(s.dir, "global", cfg.pi.package, "examples", "extensions", "subagent", "index.ts"),
      );
      const bad = sh(s, step);
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("FATAL: pi 1.3.0 does not ship examples/extensions/subagent");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasJq)("FATAL: a seed that no longer hashes to the manifest", () => {
    const s = sandbox();
    try {
      const step = runWith("seed-manifest.json | sha256sum");
      expect(sh(s, step).status).toBe(0);
      const victim = Object.keys(
        (JSON.parse(read("tests/fixtures/seed-manifest.json")) as { files: object }).files,
      )[0]!;
      // drift in the live tree…
      writeFileSync(join(s.dir, "opt-qcr", victim), "drifted\n");
      expect(sh(s, step).status).not.toBe(0);
      // …and in the canonical copy under seeds/
      copyFileSync(join(root, victim), join(s.dir, "opt-qcr", victim));
      expect(sh(s, step).status).toBe(0);
      writeFileSync(join(s.dir, "opt-qcr", "seeds", victim), "drifted\n");
      const bad = sh(s, step);
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("FATAL: the baked seeds do not match");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("! command -v claude fails when a claude is on PATH", () => {
    const s = sandbox();
    try {
      const step = runWith("command -v claude");
      // a PATH the host's own claude is not on
      s.env.PATH = s.bin;
      expect(sh(s, step).status).toBe(0);
      const claude = join(s.bin, "claude");
      writeFileSync(claude, "#!/bin/sh\n");
      chmodSync(claude, 0o755);
      expect(sh(s, step).status).not.toBe(0);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it("the three pi versions must agree with the ARG", () => {
    const s = sandbox();
    try {
      const step = runWith("global=");
      // the scratch tree has no node_modules pi: the step refuses…
      expect(sh(s, step).status).not.toBe(0);
      // …and passes once the global CLI, node_modules and config all say 1.3.0
      for (const base of [join(s.dir, "global"), join(s.dir, "opt-qcr", "node_modules")]) {
        const dir = join(base, cfg.pi.package);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "package.json"), JSON.stringify({ version: cfg.pi.version }));
      }
      copyFileSync(
        join(root, "config.example.toml"),
        join(s.dir, "opt-qcr", "config.example.toml"),
      );
      expect(sh(s, step).status).toBe(0);
      writeFileSync(
        join(s.dir, "global", cfg.pi.package, "package.json"),
        JSON.stringify({ version: "9.9.9" }),
      );
      const bad = sh(s, step);
      expect(bad.status).not.toBe(0);
      expect(bad.stderr).toContain("FATAL: pi versions disagree");
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
});

// ---- the image itself (opt-in) ----------------------------------------------

const image = process.env.QCR_RELEASE_IMAGE;
describe.skipIf(!image)("release image — a locally built image", () => {
  const run = (user: string, ...args: string[]) =>
    spawnSync("docker", ["run", "--rm", "--user", user, image!, ...args], { encoding: "utf8" });

  it.each(["1000:1000", "4242:4242", "0:0"])("version --json runs under uid %s", (user) => {
    const r = run(user, "version", "--json");
    expect(r.status, r.stderr).toBe(0);
    const v = JSON.parse(r.stdout) as { schema_version: number; pi: { version: string } };
    expect(v.schema_version).toBe(1);
    expect(v.pi.version).toBe(cfg.pi.version);
  });

  it("nothing under /opt/qcr but state/ is writable, HOME is, claude is absent", () => {
    const r = spawnSync(
      "docker",
      [
        "run",
        "--rm",
        "--user",
        "4242:4242",
        "--entrypoint",
        "sh",
        image!,
        "-c",
        "! touch /opt/qcr/x 2>/dev/null && touch /opt/qcr/state/x && mkdir -p $HOME/.pi && ! command -v claude && tmux -V",
      ],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(root, "docker/Dockerfile"))).toBe(true);
  });
});
