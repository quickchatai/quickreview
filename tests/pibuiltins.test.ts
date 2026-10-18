// pi 0.99's built-in extensions (mcp, codemode, tool-search, llama.cpp) are
// switched OFF on every surface we provision pi settings for — the reasons per
// built-in are in src/pibuiltins.ts. This runs each entrypoint's REAL settings
// merge (the `node <<'PI_EXT_MERGE'` heredoc, extracted verbatim) against a
// scratch HOME, so it pins behaviour, not spelling: a merge that drops the
// disables or keeps a `+builtin:mcp` an older volume carried goes red here.
// (The VM merge's stale-extension prune also exempts `builtin:` entries, but
// the disables are re-appended after it on every boot, so that exemption only
// keeps the "pruned (not on disk)" log honest — nothing here can observe it.)
// The bench sandbox's settings are pinned below and by tests/bench-aacr.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { benchSettings } from "../src/bench/auth.js";
import { PI_DISABLED_BUILTINS, PI_TUI_MODE } from "../src/pibuiltins.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VM_GUARD = "/opt/quickreview/sandbox/extensions/bash-guard.ts";

function heredoc(file: string): string {
  const text = readFileSync(resolve(root, file), "utf8");
  const m = /node <<'PI_EXT_MERGE'\n([\s\S]*?)\nPI_EXT_MERGE\n/.exec(text);
  if (!m) throw new Error(`no PI_EXT_MERGE heredoc in ${file}`);
  return m[1]!;
}

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** Run one entrypoint's merge under a scratch HOME (already seeded); returns
 * the settings.json it leaves behind. The VM merge FATALs on a missing
 * bash-guard, so its path is pointed at a real scratch file. */
function runMerge(file: string, home: string, bootstrap = ""): Record<string, unknown> {
  const guard = join(home, "bash-guard.ts");
  writeFileSync(guard, "// stub\n");
  const script = bootstrap + "\n" + heredoc(file).split(VM_GUARD).join(guard);
  execFileSync(process.execPath, ["-"], {
    input: script,
    env: { PATH: process.env.PATH ?? "", HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("pi built-ins are switched off wherever we provision pi settings", () => {
  it("the list is the four built-ins pi 0.99.1 and 1.0.0 ship, in the documented `-builtin:<name>` spelling", () => {
    // VERIFY-ON-PIN (0.99.1, re-read at 1.0.0: dist/extensions/index.js builtInExtensions):
    // a bump that adds a built-in must decide about it here.
    expect([...PI_DISABLED_BUILTINS].sort()).toEqual([
      "-builtin:codemode",
      "-builtin:llama.cpp",
      "-builtin:mcp",
      "-builtin:tool-search",
    ]);
  });

  for (const file of [
    "deploy/ansible/templates/entrypoint.sh.j2",
    "docker/daemon/entrypoint.sh",
    "docker/companion/entrypoint.sh",
    "docker/entrypoint.sh",
  ]) {
    it(`${file}: the merge writes every disable, drops a stale +builtin:mcp, and is idempotent`, () => {
      const home = mkdtempSync(join(tmpdir(), "qcr-pibuiltins-"));
      tmps.push(home);
      mkdirSync(join(home, ".pi", "agent"), { recursive: true });
      // An older volume: a re-enable and a bare built-in entry left behind, and
      // an unrelated key a hand edit set.
      writeFileSync(
        join(home, ".pi", "agent", "settings.json"),
        JSON.stringify({ extensions: ["+builtin:mcp", "builtin:codemode"], theme: "mine" }),
      );
      const once = runMerge(file, home);
      const ext = once["extensions"] as string[];
      for (const d of PI_DISABLED_BUILTINS) expect(ext, `${file} ${d}`).toContain(d);
      expect(
        ext.filter((e) => /^[+!]?builtin:/.test(e)),
        file,
      ).toEqual([]);
      expect(once["theme"]).toBe("mine");
      expect(once["defaultProjectTrust"]).toBe("always");
      // pi 1.0 defaults to fullscreen; sessions under tmux keep regular scrollback.
      expect(once["tuiMode"]).toBe(PI_TUI_MODE);
      // A second boot on the same volume changes nothing.
      const twice = runMerge(file, home);
      expect(twice["extensions"]).toEqual(ext);
    });
  }

  it("the bench sandbox's settings carry the same list after bash-guard", () => {
    const s = JSON.parse(benchSettings("/r").settings) as { extensions: string[] };
    expect(s.extensions).toEqual(["/r/extensions/bash-guard.ts", ...PI_DISABLED_BUILTINS]);
  });

  it("the bench sandbox outlasts a provider overload window: durable agent-level retry", () => {
    // pi's default (3 attempts, ≤ 60 s apart) lost a DeepSeek lens to a
    // two-minute DigitalOcean 529 window on 2026-10-13.
    const s = JSON.parse(benchSettings("/r").settings) as {
      retry: { enabled: boolean; maxRetries: number; baseDelayMs: number; maxAgentDelayMs: number };
    };
    expect(s.retry.enabled).toBe(true);
    expect(s.retry.maxRetries).toBeGreaterThanOrEqual(10);
    expect(s.retry.maxAgentDelayMs).toBeGreaterThanOrEqual(120_000);
    // The backoff schedule covers at least ten minutes before a lens gives up.
    let waited = 0;
    for (let i = 0; i < s.retry.maxRetries; i++)
      waited += Math.min(s.retry.baseDelayMs * 2 ** i, s.retry.maxAgentDelayMs);
    expect(waited).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

it.each(
  ["docker/daemon/entrypoint.sh", "deploy/ansible/templates/entrypoint.sh.j2"].flatMap((file) =>
    ["settings.json", "trust.json"].map((name) => [file, name] as const),
  ),
)("preserves %s / %s after a failed JSON replacement", (file, name) => {
  const home = mkdtempSync(join(tmpdir(), "qcr-pi-write-failure-"));
  tmps.push(home);
  const agent = join(home, ".pi/agent");
  mkdirSync(agent, { recursive: true });
  const settings = { extensions: [], theme: "mine" };
  const trust = { "/opt/quickreview": false };
  writeFileSync(join(agent, "settings.json"), JSON.stringify(settings), { mode: 0o600 });
  writeFileSync(join(agent, "trust.json"), JSON.stringify(trust), { mode: 0o600 });
  const bootstrap = `const siFs = require("node:fs"); const siWrite = siFs.writeFileSync; siFs.writeFileSync = (file, data, ...args) => { if (require("node:path").basename(String(file)).startsWith(${JSON.stringify(name)})) { siWrite(file, "{"); throw new Error("disk full"); } return siWrite(file, data, ...args); };`;
  expect(() => runMerge(file, home, bootstrap)).toThrow();
  expect(JSON.parse(readFileSync(join(agent, name), "utf8"))).toEqual(
    name === "settings.json" ? settings : trust,
  );
  expect(runMerge(file, home).theme).toBe("mine");
  expect(statSync(join(agent, name)).mode & 0o777).toBe(0o600);
  expect(JSON.parse(readFileSync(join(agent, "trust.json"), "utf8"))["/opt/quickreview"]).toBe(true);
});
