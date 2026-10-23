// `qcr review` destinations and the per-repo default (packages/pi-plugin/src/reviewdest.ts, src/reviewcli.ts).
// A real throwaway git repo is the branch fixture; pi is a fake shell script
// (no network, no model, no docker, no GitHub).

import { piCliRuntime } from "./helpers/pi-cli-runtime.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Destination } from "@quickchatai/pi-quickreview/src/reviewdest.js";

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { runReviewCli, parseReviewArgs } = await import("../src/reviewcli.js");
const { destinationChoices, FINDINGS_JSON_KEYS } =
  await import("@quickchatai/pi-quickreview/src/reviewdest.js");
const { loadDefaultDestinations, saveDefaultDestinations, openReviewStore } =
  await import("../src/reviewhome.js");
const { contextFor } = await import("../src/bench/runner.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "review-cli-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

/** main with one file, `feature` adding two lines to it. */
function mkRepo(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(join(repo, "src"), { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(
    join(repo, "src", "a.ts"),
    "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n",
  );
  git(repo, "commit", "-q", "-am", "add b and c");
  return repo;
}

function mkRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

const findings = [
  {
    path: "src/a.ts",
    line: 2,
    severity: "P2",
    title: "b is a magic number",
    disposition: "posted",
  },
  { path: "src/a.ts", line: 3, severity: "P0", title: "c breaks the build", disposition: "posted" },
  { path: "src/a.ts", line: 3, severity: "P1", title: "killed one", disposition: "killed" },
];
const record = JSON.stringify({ findings, verdict: "REQUEST_CHANGES" });
const outcome = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });

function fakePi(name: string, script: string[]): { bin: string; calls: string } {
  const calls = join(tmp, `${name}.calls`);
  const bin = join(tmp, `${name}-pi`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      ...script,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, calls };
}

const happyPi = (name: string, cost = 0.25) =>
  fakePi(name, [
    `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":${cost}}}}}'`,
    `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
    `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
  ]);

let root: string;
let ctx: ReturnType<typeof contextFor>;
beforeAll(() => {
  root = mkRoot("root");
  ctx = contextFor(root, "");
});

function harness(o: {
  repo: string;
  piBin: string;
  confirm?: ((q: string) => Promise<boolean>) | null;
  /** Present: the session is interactive and answers the destination question. */
  choose?: (options: string[]) => Destination;
}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const offered: string[][] = [];
  const deps = {
    cwd: o.repo,
    out: (l: string) => lines.push(l),
    confirm:
      o.confirm === null
        ? null
        : async (q: string) => {
            asked.push(q);
            return o.confirm ? o.confirm(q) : false;
          },
    ...(o.choose
      ? {
          choose: async (_q: string, opts: Array<{ value: string }>) => {
            const values = opts.map((x) => x.value);
            offered.push(values);
            return o.choose!(values);
          },
        }
      : {}),
    root,
    agentDir: join(tmp, "agent"),
    cfg: ctx.cfg,
    ecosystem: ctx.ecosystem,
    runtime: piCliRuntime({ bin: o.piBin }),
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    dryrunDir: join(tmp, `dryrun-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
  };
  return { deps, lines, asked, offered, text: () => lines.join("\n") };
}

/** The repo's settings: the limit the review runs under without asking. */
function setLimit(repo: string, limit: number, extra: Record<string, number> = {}): void {
  writeFileSync(
    join(repo, ".git", "qcr-review.json"),
    JSON.stringify({ auto_limit_usd: limit, ...extra }),
  );
}

const rich = (repo: string) => setLimit(repo, 1000);
const jsonLine = (lines: string[]): Record<string, any> =>
  JSON.parse(lines.filter((l) => l.startsWith("{")).at(-1)!);

describe("qcr review: destinations and the per-repo default", () => {
  it("the first interactive run asks, saves the answer, and the next run reuses it without asking", async () => {
    const repo = mkRepo("ask");
    rich(repo);
    const pi = happyPi("ask");
    const h1 = harness({ repo, piBin: pi.bin, choose: () => "json" });
    expect(await runReviewCli([], false, h1.deps)).toBe(0);
    expect(h1.offered).toHaveLength(1);
    expect(h1.offered[0]).toEqual(expect.arrayContaining(["terminal", "file", "json"]));
    expect(loadDefaultDestinations(repo)).toEqual(["json"]);
    expect(jsonLine(h1.lines).ok).toBe(true);

    const h2 = harness({ repo, piBin: pi.bin, choose: () => "terminal" });
    expect(await runReviewCli([], false, h2.deps)).toBe(0);
    expect(h2.offered).toHaveLength(0);
    expect(h2.lines.filter((l) => l.startsWith("{"))).toHaveLength(1);
  });

  it("the default is stored per repo, never globally", async () => {
    const a = mkRepo("per-a");
    const b = mkRepo("per-b");
    saveDefaultDestinations(a, ["file"]);
    expect(loadDefaultDestinations(a)).toEqual(["file"]);
    expect(loadDefaultDestinations(b)).toBeNull();
    // in the state home, not in the repo or its git dir
    expect(existsSync(openReviewStore(a)!.destinationPath())).toBe(true);
    expect(existsSync(join(a, ".git", "qcr-review-destination.json"))).toBe(false);
    expect(git(a, "status", "--porcelain")).toBe("");
  });

  it("a flag overrides the saved default for one run and does not change it", async () => {
    const repo = mkRepo("override");
    rich(repo);
    saveDefaultDestinations(repo, ["terminal"]);
    const h = harness({ repo, piBin: happyPi("override").bin, choose: () => "file" });
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    expect(h.offered).toHaveLength(0);
    expect(jsonLine(h.lines).findings).toBeDefined();
    expect(loadDefaultDestinations(repo)).toEqual(["terminal"]);
  });

  it("a flag also skips the question the first time, and saves nothing", async () => {
    const repo = mkRepo("flagfirst");
    rich(repo);
    const h = harness({ repo, piBin: happyPi("flagfirst").bin, choose: () => "json" });
    expect(await runReviewCli(["--to", "terminal"], false, h.deps)).toBe(0);
    expect(h.offered).toHaveLength(0);
    expect(loadDefaultDestinations(repo)).toBeNull();
  });

  it("non-interactive with no default: the terminal plus JSON, and it never blocks", async () => {
    const repo = mkRepo("noninteractive");
    rich(repo);
    const h = harness({ repo, piBin: happyPi("noninteractive").bin, confirm: null });
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    expect(h.text()).toMatch(/Findings \(2\)/);
    expect(jsonLine(h.lines).findings.P0).toHaveLength(1);
    expect(loadDefaultDestinations(repo)).toBeNull();
  });

  it("never offers posting for a target with no PR", () => {
    expect(destinationChoices({ pr: false }).map((c) => c.value)).not.toContain("post");
  });

  it("the markdown file carries the same findings as the JSON", async () => {
    const repo = mkRepo("md");
    rich(repo);
    const out = join(tmp, "report-md.md");
    const h = harness({ repo, piBin: happyPi("md").bin });
    expect(await runReviewCli(["--out", out], true, h.deps)).toBe(0);
    const md = readFileSync(out, "utf8");
    const data = jsonLine(h.lines);
    const flat = Object.values(data.findings).flat() as Array<Record<string, any>>;
    expect(flat).toHaveLength(2);
    const bullets = md.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(flat.length);
    for (const f of flat) {
      expect(
        bullets.some((b) => b.includes(f["title"]) && b.includes(`${f["path"]}:${f["line"]}`)),
      ).toBe(true);
    }
    expect(md).toMatch(/^## P0 \(1\)$/m);
    expect(md.indexOf("## P0")).toBeLessThan(md.indexOf("## P2"));
  });

  it("a saved file destination writes the report in the run's files and says where", async () => {
    const repo = mkRepo("savedfile");
    rich(repo);
    saveDefaultDestinations(repo, ["file"]);
    const h = harness({ repo, piBin: happyPi("savedfile").bin });
    expect(await runReviewCli([], false, h.deps)).toBe(0);
    const m = h.text().match(/Report: (\S+report\.md)/);
    expect(m).not.toBeNull();
    expect(readFileSync(m![1]!, "utf8")).toMatch(/b is a magic number/);
  });

  it("JSON schema: every finding has path, line, severity, title and lens", async () => {
    const repo = mkRepo("schema");
    rich(repo);
    const h = harness({ repo, piBin: happyPi("schema").bin });
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    const o = jsonLine(h.lines);
    expect(o.ok).toBe(true);
    expect(typeof o.partial).toBe("boolean");
    expect(o.findings).toEqual(expect.any(Object));
    expect(FINDINGS_JSON_KEYS).toEqual(["path", "line", "severity", "title", "lens"]);
    for (const [sev, list] of Object.entries(o.findings as Record<string, any[]>)) {
      expect(Array.isArray(list)).toBe(true);
      for (const f of list) {
        expect(Object.keys(f).sort()).toEqual([...FINDINGS_JSON_KEYS].sort());
        expect(f.severity).toBe(sev);
        expect(f.path === null || typeof f.path === "string").toBe(true);
        expect(f.line === null || typeof f.line === "number").toBe(true);
        expect(typeof f.title).toBe("string");
        expect(f.lens === null || typeof f.lens === "string").toBe(true);
      }
    }
  });

  it("refuses an unknown destination, exit 2", () => {
    expect(() => parseReviewArgs(["--to", "carrier-pigeon"])).toThrow(/usage: qcr review/);
  });

  it("a capped review's markdown report carries the findings written before the stop", async () => {
    const repo = mkRepo("capmd");
    rich(repo);
    const out = join(tmp, "report-capmd.md");
    const pi = fakePi("capmd", [
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":9999}}}}'`,
      "sleep 60",
    ]);
    const h = harness({ repo, piBin: pi.bin });
    expect(await runReviewCli(["--out", out], true, h.deps)).toBe(1);
    const data = jsonLine(h.lines);
    expect(data.partial).toBe(true);
    expect(Object.values(data.findings).flat()).toHaveLength(2);
    const md = readFileSync(out, "utf8");
    expect(md).not.toMatch(/No findings/);
    expect(md).toMatch(/c breaks the build/);
    expect(md).toMatch(/b is a magic number/);
  });

  it("a report that cannot be written fails the run, in the JSON and the exit status", async () => {
    const repo = mkRepo("badout");
    rich(repo);
    const out = join(tmp, "report-is-a-dir");
    mkdirSync(out);
    const h = harness({ repo, piBin: happyPi("badout").bin });
    expect(await runReviewCli(["--out", out], true, h.deps)).toBe(1);
    const data = jsonLine(h.lines);
    expect(data.ok).toBe(false);
    expect(data.report_error).toEqual(expect.any(String));
  });
});
