// extensions/setup.ts — the companion's setup tool belt over the SetupEngine
//, and the real ports it assembles (src/setup/adapters.ts). The belt
// is driven over an engine with a scratch checkout and a temp state home; the
// ports are driven against temp dirs, one scratch git repo (the listing is
// `git ls-files`, so git is the thing under test there) and a fake fetch.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import activate, { buildEngine, toolDefinitions } from "../extensions/setup.js";
import {
  checkoutReader,
  stateHomeFs,
  tokenFileGitHubReader,
} from "../src/setup/adapters.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-setup-ext-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tree(root: string, files: Record<string, string>): void {
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), t);
  }
}

function textOf(r: PiToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}

async function call(defs: PiToolDefinition[], name: string, params: Record<string, unknown> = {}): Promise<string> {
  const def = defs.find((d) => d.name === name);
  expect(def, `tool ${name}`).toBeDefined();
  return textOf(await def!.execute("id", params));
}

describe("the tool belt", () => {
  function belt(): PiToolDefinition[] {
    const repo = join(dir, "repo");
    tree(repo, {
      "README.md": "# x\n",
      "api/apps.py": "x\n",
      "api/views.py": "a\nb\n",
      "web/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "web/src/a.tsx": "x\n",
      ".github/workflows/ci.yml": "name: CI\n",
    });
    const engine = buildEngine({ QCR_REVIEWED_REPO: repo, QCR_STATE_HOME: join(dir, "state") } as NodeJS.ProcessEnv);
    return toolDefinitions(engine);
  }

  it("registers the facts, status and propose/adjust/save tools, tool-name-safe", () => {
    const names = belt().map((d) => d.name);
    expect(names).toEqual([
      "setup_repo_facts",
      "setup_unit_cut",
      "setup_unit_cut_propose",
      "setup_unit_cut_adjust",
      "setup_unit_cut_save",
    ]);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it("drives the whole cut: facts → propose → adjust → save, then status shows it in use", async () => {
    const defs = belt();
    const facts = await call(defs, "setup_repo_facts");
    expect(facts).toMatch(/GitHub Actions — \.github\/workflows\/ci\.yml \("CI"\)/);
    expect(facts).toMatch(/React — web\/package\.json/);
    expect(facts).toMatch(/Unit candidates/);

    const proposed = await call(defs, "setup_unit_cut_propose", { units: [{ name: "api", roots: ["api"] }] });
    expect(proposed).toMatch(/Draft stored/);
    expect(proposed).toMatch(/! .*belong to no unit/);
    const refused = await call(defs, "setup_unit_cut_save");
    expect(refused).toMatch(/Save refused/);

    const adjusted = await call(defs, "setup_unit_cut_adjust", {
      ops: [
        { op: "add", name: "web", roots: ["web"], kind: "js-package" },
        { op: "add", name: "rest", roots: [""] },
      ],
    });
    expect(adjusted).toMatch(/Draft adjusted/);
    expect(await call(defs, "setup_unit_cut_save")).toMatch(/Unit cut saved/);
    const status = await call(defs, "setup_unit_cut");
    expect(status).toMatch(/Saved unit cut/);
    expect(status).toMatch(/- api \[custom\] api: 2 files/);
    expect(status).not.toMatch(/Draft/);
  });

  it("answers a bad call with a refusal, never a throw", async () => {
    const defs = belt();
    expect(await call(defs, "setup_unit_cut_adjust", {})).toMatch(/Adjustment refused:\n✗ `ops` must be/);
    expect(await call(defs, "setup_unit_cut_propose", { units: "nope" })).toMatch(/Proposal refused/);
  });

  it("a missing checkout is a refusal from the tools, not a failed start", async () => {
    const engine = buildEngine({ QCR_REVIEWED_REPO: join(dir, "absent"), QCR_STATE_HOME: join(dir, "state") } as NodeJS.ProcessEnv);
    expect(await call(toolDefinitions(engine), "setup_repo_facts")).toMatch(/no readable checkout at .*absent/);
  });

  it("activation degrades on a pi without registerTool, and registers every tool on one with it", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      activate({ on: () => {}, sendUserMessage: () => {} });
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/registerTool unavailable/));
      const registered: string[] = [];
      activate({ on: () => {}, sendUserMessage: () => {}, registerTool: (d) => registered.push(d.name) });
      expect(registered).toHaveLength(5);
    } finally {
      err.mockRestore();
    }
  });
});

describe("checkoutReader", () => {
  it("lists what git tracks — ignored build output is not the repo", () => {
    const repo = join(dir, "git");
    tree(repo, { "a.py": "x\ny\n", ".gitignore": "out/\n", "out/gen.js": "x\n", "sub/b.py": "z" });
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-qm", "init");
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual([".gitignore", "a.py", "sub/b.py"]);
    expect(r.head()).toMatch(/^[0-9a-f]{40}$/);
    expect(r.lines("a.py")).toBe(2);
    expect(r.lines("sub/b.py")).toBe(1);
  });

  it("falls back to a walk without git, and never reads outside the root or a binary", () => {
    const repo = join(dir, "plain");
    tree(repo, { "x.ts": "x\n", "node_modules/y.js": "y\n", "bin.dat": "a\0b" });
    tree(dir, { "secret.txt": "no" });
    const r = checkoutReader(repo);
    expect(r.listFiles()?.sort()).toEqual(["bin.dat", "x.ts"]);
    expect(r.read("../secret.txt")).toBeNull();
    expect(r.read("/etc/passwd")).toBeNull();
    expect(r.read("bin.dat")).toBeNull();
    expect(r.head()).toBeNull();
    expect(checkoutReader(join(dir, "absent")).listFiles()).toBeNull();
  });
});

describe("stateHomeFs", () => {
  it("writes atomically inside the root and refuses paths that leave it", () => {
    const fs = stateHomeFs(join(dir, "state"));
    expect(fs.read("setup/x.json")).toBeNull();
    fs.write("setup/x.json", "{}\n");
    expect(fs.read("setup/x.json")).toBe("{}\n");
    expect(() => fs.write("../escape", "x")).toThrow(/leaves the state home/);
    expect(() => fs.read("/etc/passwd")).toThrow(/leaves the state home/);
  });
});

describe("tokenFileGitHubReader — GET only, API paths only", () => {
  const now = new Date("2026-09-29T10:00:00Z");
  function envFile(expires: string): string {
    const p = join(dir, "github-read.env");
    writeFileSync(p, `QCR_GITHUB_READ_TOKEN=ghs_abc\nQCR_GITHUB_READ_EXPIRES_AT=${expires}\nQCR_GITHUB_REPO=o/r\n`);
    return p;
  }

  it("GETs under the API root with the token, and nothing else", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ full_name: "o/r" }), { status: 200 }));
    const gh = tokenFileGitHubReader({ envFile: envFile("2026-09-29T11:00:00Z"), fetch: fetch as unknown as typeof globalThis.fetch, clock: () => now });
    expect(await gh.get("/repos/o/r")).toEqual({ ok: true, data: { full_name: "o/r" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.github.com/repos/o/r");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer ghs_abc");
  });

  it("refuses a path that could aim the token elsewhere, and an expired or missing token", async () => {
    const fetch = vi.fn();
    const f = fetch as unknown as typeof globalThis.fetch;
    const live = tokenFileGitHubReader({ envFile: envFile("2026-09-29T11:00:00Z"), fetch: f, clock: () => now });
    for (const bad of ["https://evil.example/x", "//evil.example/x", "/repos/../x", "repos/o/r"]) {
      expect((await live.get(bad)).ok).toBe(false);
    }
    const expired = tokenFileGitHubReader({ envFile: envFile("2026-09-29T09:00:00Z"), fetch: f, clock: () => now });
    expect(await expired.get("/repos/o/r")).toEqual({ ok: false, reason: expect.stringMatching(/expired/) });
    const none = tokenFileGitHubReader({ envFile: undefined, fetch: f, clock: () => now });
    expect(await none.get("/repos/o/r")).toEqual({ ok: false, reason: expect.stringMatching(/QCR_GITHUB_READ_ENV unset/) });
    expect(fetch).not.toHaveBeenCalled();
  });
});
