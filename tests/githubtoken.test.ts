// `qcr github-token sync` — the own-account route's host-side refresher
// (src/githubtoken.ts). Everything faked: a routed fake runner stands in for
// gh / sh / crontab, a fake fetch for GitHub's `GET /user`, a temp dir for the
// secrets dir. The properties pinned:
//   * the file is the token alone, 0600 under a 0700 dir, replaced atomically;
//   * gh first (the binary the caller names), then GH_TOKEN, then GITHUB_TOKEN;
//   * a token GitHub refuses never reaches the file;
//   * no line the module prints carries the token;
//   * the crontab entry is idempotent and runs the resolved gh, not cron's PATH.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CRON_MARKER,
  GITHUB_TOKEN_FILE,
  cmdGithubToken,
  cronEntryState,
  cronLine,
  installCronEntry,
  mergeCrontab,
  parseGithubTokenArgs,
  readPersonToken,
  renderSync,
  resolveGhPath,
  syncGithubToken,
  tokenKind,
  writeTokenFile,
  type TokenRunner,
} from "../src/githubtoken.js";
import { resolveSpecifier, runtimeSpecifiers } from "./helpers/layers.js";

const TOKEN = "gho_abcdefghijklmnopqrstuvwxyz012345";
const BROKER_GH = "/usr/local/bin/gh";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-ghtoken-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface FakeHost {
  runner: TokenRunner;
  calls: string[][];
  crontab: { text: string | null };
}

function host(
  o: { ghToken?: string | null; ghAt?: string | null; crontab?: boolean } = {},
): FakeHost {
  const calls: string[][] = [];
  const crontab = { text: null as string | null };
  const ghAt = o.ghAt === undefined ? BROKER_GH : o.ghAt;
  const token = o.ghToken === undefined ? TOKEN : o.ghToken;
  return {
    calls,
    crontab,
    runner: {
      run: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === "sh" && args[1] === "command -v gh")
          return ghAt
            ? { code: 0, stdout: `${ghAt}\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "" };
        if (cmd === "sh" && args[1] === "command -v crontab")
          return o.crontab === false
            ? { code: 1, stdout: "", stderr: "" }
            : { code: 0, stdout: "/usr/bin/crontab\n", stderr: "" };
        if ((cmd === ghAt || cmd === "gh") && args.join(" ") === "auth token")
          return token
            ? { code: 0, stdout: `${token}\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." };
        if (cmd === "crontab" && args[0] === "-l")
          return crontab.text === null
            ? { code: 1, stdout: "", stderr: "no crontab for dana" }
            : { code: 0, stdout: crontab.text, stderr: "" };
        if (cmd === "crontab" && args.length === 1) {
          crontab.text = readFileSync(args[0]!, "utf8");
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 127, stdout: "", stderr: `${cmd}: not found` };
      },
    },
  };
}

function github(status = 200, login = "dana-op", expiry?: string): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    expect(auth.startsWith("Bearer ")).toBe(true);
    return new Response(
      JSON.stringify(status === 200 ? { login } : { message: "Bad credentials" }),
      {
        status,
        headers: expiry ? { "github-authentication-token-expiration": expiry } : {},
      },
    );
  }) as unknown as typeof fetch;
}

describe("the token file", () => {
  it("is the token alone, 0600 under a 0700 dir, with no temp file left behind", () => {
    const secrets = join(dir, "secrets");
    const path = writeTokenFile(secrets, TOKEN);
    expect(path).toBe(join(secrets, GITHUB_TOKEN_FILE));
    expect(readFileSync(path, "utf8")).toBe(TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(secrets).mode & 0o777).toBe(0o700);
    expect(readdirSync(secrets)).toEqual([GITHUB_TOKEN_FILE]);
  });

  it("replaces an existing file atomically and tightens a loose one", () => {
    const path = join(dir, GITHUB_TOKEN_FILE);
    writeFileSync(path, "old", { mode: 0o644 });
    writeTokenFile(dir, "ghu_newtokennewtokennewtoken01");
    expect(readFileSync(path, "utf8")).toBe("ghu_newtokennewtokennewtoken01");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses to write something that is not a token", () => {
    expect(() => writeTokenFile(dir, "not a token\n")).toThrow(/not a token/);
  });
});

describe("where the token comes from", () => {
  it("gh first — the binary the caller resolved — and env is never read then", async () => {
    const h = host();
    const got = await readPersonToken({
      runner: h.runner,
      env: { GH_TOKEN: "ghp_envenvenvenvenvenvenv0000" },
      gh: BROKER_GH,
    });
    expect(got).toEqual({ ok: true, token: TOKEN, source: "gh" });
    expect(h.calls[0]).toEqual([BROKER_GH, "auth", "token"]);
  });

  it("falls back to GH_TOKEN, then GITHUB_TOKEN, when gh gives nothing", async () => {
    const h = host({ ghToken: null, ghAt: null });
    expect(
      await readPersonToken({
        runner: h.runner,
        env: {
          GH_TOKEN: "ghp_envenvenvenvenvenvenv0000",
          GITHUB_TOKEN: "ghp_other0000000000000000000",
        },
      }),
    ).toMatchObject({ ok: true, source: "env:GH_TOKEN" });
    expect(
      await readPersonToken({
        runner: h.runner,
        env: { GITHUB_TOKEN: "ghp_other0000000000000000000" },
      }),
    ).toMatchObject({ ok: true, source: "env:GITHUB_TOKEN" });
    const none = await readPersonToken({ runner: h.runner, env: {} });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.problem).toMatch(/gh auth login/);
  });

  it("resolveGhPath reports the gh THIS environment resolves", async () => {
    expect(await resolveGhPath(host().runner)).toBe(BROKER_GH);
    expect(await resolveGhPath(host({ ghAt: null }).runner)).toBeNull();
  });

  it("names a token's kind without its value", () => {
    expect(tokenKind("ghu_x").prefix).toBe("ghu_");
    expect(tokenKind("ghu_x").label).toMatch(/8 hours/);
    expect(tokenKind("gho_x")).toMatchObject({ prefix: "gho_", expires: false });
    expect(tokenKind("ghp_x").prefix).toBe("ghp_");
    expect(tokenKind("github_pat_x").prefix).toBe("github_pat_");
    expect(tokenKind("zzz").prefix).toBe("unknown");
  });
});

describe("the sync", () => {
  it("proves the token with GET /user, then writes it, and prints login + kind, never the token", async () => {
    const r = await syncGithubToken({
      runner: host().runner,
      env: {},
      fetch: github(200, "dana-op", "2026-11-01 00:00:00 UTC"),
      secretsDir: dir,
      gh: BROKER_GH,
    });
    expect(r).toMatchObject({
      ok: true,
      login: "dana-op",
      source: "gh",
      expiry: "2026-11-01 00:00:00 UTC",
    });
    expect(readFileSync(join(dir, GITHUB_TOKEN_FILE), "utf8")).toBe(TOKEN);
    const line = renderSync(r);
    expect(line).toContain("dana-op");
    expect(line).toContain("gho_");
    expect(line).toContain("2026-11-01");
    expect(line).not.toContain(TOKEN);
  });

  it("a token GitHub refuses never reaches the file", async () => {
    writeFileSync(join(dir, GITHUB_TOKEN_FILE), "ghp_previousgoodtoken000000000", { mode: 0o600 });
    const r = await syncGithubToken({
      runner: host().runner,
      env: {},
      fetch: github(401),
      secretsDir: dir,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toMatch(/rejected the token .* left as it was/);
    expect(readFileSync(join(dir, GITHUB_TOKEN_FILE), "utf8")).toBe(
      "ghp_previousgoodtoken000000000",
    );
    expect(renderSync(r)).not.toContain(TOKEN);
  });

  it("the CLI verb prints one line with no token in it, and exits by the outcome", async () => {
    const lines: string[] = [];
    const ok = await cmdGithubToken(["sync", "--gh", BROKER_GH, "--secrets-dir", dir], {
      runner: host().runner,
      env: {},
      fetch: github(),
      secretsDir: () => "/nowhere",
      log: (l) => lines.push(l),
    });
    expect(ok).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(readFileSync(join(dir, GITHUB_TOKEN_FILE), "utf8")).toBe(TOKEN);
    const bad = await cmdGithubToken(["sync"], {
      runner: host({ ghToken: null, ghAt: null }).runner,
      env: {},
      fetch: github(),
      secretsDir: () => dir,
      log: (l) => lines.push(l),
    });
    expect(bad).toBe(1);
  });

  it("parses its arguments strictly", () => {
    expect(parseGithubTokenArgs(["sync"])).toEqual({ gh: null, secretsDir: null });
    expect(parseGithubTokenArgs(["sync", "--gh", "/x/gh", "--secrets-dir", "/s"])).toEqual({
      gh: "/x/gh",
      secretsDir: "/s",
    });
    for (const bad of [[], ["sync", "--gh"], ["sync", "--token", "x"], ["refresh"]])
      expect(() => parseGithubTokenArgs(bad)).toThrow(/usage/);
  });
});

describe("the crontab entry", () => {
  const words = {
    node: "/usr/bin/node",
    cli: "/opt/qcr app/dist/src/cli.js",
    gh: BROKER_GH,
    secretsDir: "/home/dana/.config/qcr/default/secrets",
  };

  it("is every 20 minutes, absolute paths throughout, quoted where needed, and marked", () => {
    const line = cronLine(words);
    expect(line).toBe(
      "*/20 * * * * /usr/bin/node '/opt/qcr app/dist/src/cli.js' github-token sync --gh /usr/local/bin/gh " +
        `--secrets-dir /home/dana/.config/qcr/default/secrets >/dev/null 2>&1 ${CRON_MARKER}`,
    );
  });

  it("mergeCrontab replaces the marked line, keeps the rest, and is idempotent", () => {
    const line = cronLine(words);
    const first = mergeCrontab("MAILTO=x\n0 1 * * * backup\n", line);
    expect(first.changed).toBe(true);
    expect(first.text).toBe(`MAILTO=x\n0 1 * * * backup\n${line}\n`);
    expect(mergeCrontab(first.text, line)).toEqual({ text: first.text, changed: false });
    const moved = mergeCrontab(first.text, cronLine({ ...words, gh: "/opt/gh" }));
    expect(moved.text.split("\n").filter((l) => l.includes(CRON_MARKER))).toHaveLength(1);
    expect(moved.text).toContain("--gh /opt/gh");
  });

  it("installs through `crontab <file>` (an empty crontab included), then reports unchanged", async () => {
    const h = host();
    const line = cronLine(words);
    expect(await installCronEntry({ runner: h.runner, line, scratchDir: dir })).toEqual({
      kind: "installed",
      line,
    });
    expect(h.crontab.text).toBe(`${line}\n`);
    expect(await installCronEntry({ runner: h.runner, line, scratchDir: dir })).toEqual({
      kind: "unchanged",
      line,
    });
    // The scratch file never outlives the install.
    expect(readdirSync(dir)).toEqual([]);
    expect(await cronEntryState(h.runner, BROKER_GH)).toBe("present");
    expect(await cronEntryState(h.runner, "/usr/bin/gh")).toBe("stale");
  });

  it("a machine without crontab is reported as such, never an error", async () => {
    const h = host({ crontab: false });
    expect((await installCronEntry({ runner: h.runner, line: "x", scratchDir: dir })).kind).toBe(
      "no-crontab",
    );
    expect(await cronEntryState(h.runner, BROKER_GH)).toBe("no-crontab");
  });
});

describe("the daemon never reads a personal token itself", () => {
  // The token reaches the daemon as a FILE; this module, which runs gh and
  // reads GH_TOKEN, is the host's. Every runtime edge from the daemon's and
  // workers' process entries is walked (a direct-import grep cannot see a
  // module that imports something that imports it).
  // MUTATION: import { tokenKind } from "./githubtoken.js" in src/reviewnow.ts — this fails.
  it("no daemon or worker entry reaches src/githubtoken.ts, however indirectly", () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const entries = [
      "src/wire.ts",
      "src/botworker.ts",
      "src/answerworker.ts",
      "src/loginrefresh/main.ts",
      "src/openviking/sidecar-main.ts",
    ];
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length > 0) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      for (const spec of runtimeSpecifiers(readFileSync(join(ROOT, f), "utf8"))) {
        const to = resolveSpecifier(ROOT, f, spec);
        if (to !== null && !seen.has(to)) queue.push(to);
      }
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(seen.has("src/reviewnow.ts")).toBe(true);
    expect(seen.has("src/githubtoken.ts")).toBe(false);
    // Nor the wizard's step registry, which imports it (src/version.ts reads
    // the pi pin from the leaf src/onboard/pipin.ts, never from launch.ts).
    expect(seen.has("src/onboard/steps/index.ts")).toBe(false);
  });
});
