// `daemon --preflight` (P8.4b): each named failure, the clean pass, and that the
// live inputs are only read (hash and mtime compare, mounted-read-only shape).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight, type PreflightOptions } from "../src/preflight.js";
import { StateStore } from "../src/state.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOOD_CONFIG = readFileSync(join(root, "config.example.toml"), "utf8");
const NOW = Date.parse("2026-10-20T12:00:00Z");

let dir: string;
let opts: PreflightOptions;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-preflight-test-"));
  const state = join(dir, "state");
  const cfg = join(dir, "config-home");
  const agent = join(dir, "pihome", "agent");
  for (const d of [state, cfg, agent, join(state, "pi-sessions", "pr-7")])
    mkdirSync(d, { recursive: true });
  const store = new StateStore(join(state, "state.db"));
  store.upsertPr({
    number: 7,
    state: "awaiting_author",
    head_sha: "abc",
    title: "t",
    author: "a",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.upsertPr({
    number: 8,
    state: "closed",
    head_sha: "abc",
    title: "t",
    author: "a",
    trigger_ts: null,
    stale_recheck: 0,
    migration_gate: 0,
  });
  store.db.pragma("wal_checkpoint(TRUNCATE)");
  store.db.close();
  const lines = [
    {
      type: "session",
      version: 3,
      id: "sess-7",
      timestamp: "2026-10-01T00:00:00Z",
      cwd: "/opt/quickreview/sandbox/wt/pr-7",
    },
    {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-10-01T00:00:01Z",
      message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
    },
  ];
  writeFileSync(
    join(state, "pi-sessions", "pr-7", "s.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
  writeFileSync(join(cfg, "config.toml"), GOOD_CONFIG);
  writeFileSync(
    join(agent, "auth.json"),
    JSON.stringify({
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: NOW + 3600_000 },
    }),
  );
  writeFileSync(join(agent, "models.json"), "{}");
  opts = { stateDir: state, configHome: cfg, agentDir: agent, root, now: () => NOW };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const failed = (r: ReturnType<typeof runPreflight>): string[] =>
  r.checks.filter((c) => !c.ok).map((c) => c.name);
const reason = (r: ReturnType<typeof runPreflight>, n: string): string =>
  r.checks.find((c) => c.name === n)?.reason ?? "";

function snapshot(d: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) walk(f);
      else
        out[f] = createHash("sha256").update(readFileSync(f)).digest("hex") + statSync(f).mtimeMs;
    }
  };
  walk(d);
  return out;
}

describe("daemon --preflight", () => {
  it("passes a clean legacy-shaped copy and changes nothing it was given", () => {
    const before = snapshot(dir);
    const r = runPreflight(opts);
    expect(failed(r), JSON.stringify(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "resume")?.detail).toContain(
      "1 open PR(s), 1 session file(s)",
    );
    expect(snapshot(dir)).toEqual(before);
    expect(readdirSync(join(dir, "state")).sort()).toEqual(["pi-sessions", "state.db"]);
  });

  it("passes with the live state read-only, so it cannot have written there", () => {
    const state = opts.stateDir;
    const before = snapshot(dir);
    const dirs = [state, join(state, "pi-sessions"), join(state, "pi-sessions", "pr-7")];
    for (const d of dirs) chmodSync(d, 0o500);
    try {
      const r = runPreflight(opts);
      expect(failed(r), JSON.stringify(r)).toEqual([]);
    } finally {
      for (const d of dirs.reverse()) chmodSync(d, 0o700);
    }
    expect(snapshot(dir)).toEqual(before);
  });

  it("fails a corrupt JSONL by name", () => {
    writeFileSync(join(opts.stateDir, "pi-sessions", "pr-7", "s.jsonl"), "{not json\n");
    const r = runPreflight(opts);
    expect(failed(r)).toEqual(["resume"]);
    expect(reason(r, "resume")).toContain("pr-7/s.jsonl");
  });

  it("fails a migration error", () => {
    writeFileSync(
      join(opts.stateDir, "state.db"),
      "this is not a database, and it is long enough to be read as one".repeat(5),
    );
    const r = runPreflight(opts);
    expect(failed(r)).toContain("migrations");
    expect(reason(r, "migrations")).toContain("migrating the scratch copy");
  });

  it("fails a missing login, and a login that expires in the work window with no refresh token", () => {
    rmSync(join(opts.agentDir, "auth.json"));
    expect(reason(runPreflight(opts), "login")).toContain("no pi login");
    writeFileSync(
      join(opts.agentDir, "auth.json"),
      JSON.stringify({
        p: {
          type: "oauth",
          access: "a",
          refresh: "bench-refresh-disabled",
          expires: NOW + 600_000,
        },
      }),
    );
    expect(reason(runPreflight(opts), "login")).toContain("work window");
    writeFileSync(
      join(opts.agentDir, "auth.json"),
      JSON.stringify({
        p: {
          type: "oauth",
          access: "a",
          refresh: "bench-refresh-disabled",
          expires: NOW + 24 * 3600_000,
        },
      }),
    );
    expect(failed(runPreflight(opts))).toEqual([]);
  });

  it("fails an unparsable models.json", () => {
    writeFileSync(join(opts.agentDir, "models.json"), "{oops");
    const r = runPreflight(opts);
    expect(failed(r)).toEqual(["models"]);
  });

  it("fails a socket path that cannot fit a unix socket", () => {
    const deep = join(dir, "x".repeat(120), "state");
    mkdirSync(deep, { recursive: true });
    const r = runPreflight({ ...opts, stateDir: deep });
    expect(reason(r, "socket")).toContain("bytes");
  });

  it("fails when the scratch parent cannot hold a private dir", () => {
    const ro = join(dir, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    if (process.getuid?.() === 0) return;
    expect(() => runPreflight({ ...opts, scratchParent: ro })).toThrow();
    chmodSync(ro, 0o700);
  });

  it("fails a config the new image would refuse", () => {
    writeFileSync(join(opts.configHome, "config.toml"), "this is = not [valid");
    const r = runPreflight(opts);
    expect(failed(r)).toEqual(["config"]);
  });

  it("reaches no network: the module imports no http client", () => {
    const src = readFileSync(join(root, "src", "preflight.ts"), "utf8");
    expect(src).not.toMatch(/node:(http|https|net|dns)|fetch\(/);
  });
});

describe("the image carries the preflight", () => {
  it("labels qcr.preflight and dispatches the flag without starting the bot", () => {
    expect(readFileSync(join(root, "docker/Dockerfile"), "utf8")).toMatch(/qcr\.preflight="true"/);
    const ep = readFileSync(join(root, "docker/entrypoint.sh"), "utf8");
    expect(ep).toMatch(/--preflight[\s\S]{0,120}preflight\.js/);
  });
});
