// `qcr review` and the bench under profile overrides (src/profileoverrides.ts):
// a user profile and the repo's `.qcr/` on the base commit replace shipped
// agents and prompts; the JSON, the terminal, the markdown report say the run
// is customised; an uncustomised run feeds the model exactly what it always
// did; the bench refuses a customised profile unless it is allowed to.
// pi is a fake shell script: no model, no network.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freshStateHomePerTest } from "./helpers/fresh-state-home.js";
import {
  chmodSync,
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

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { runReviewCli } = await import("../src/reviewcli.js");
const { contextFor, benchCustomisation, buildBenchAgents, runFingerprint } =
  await import("../src/bench/runner.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "profile-overrides-review-"));
const cfgHome = join(tmp, "cfg-home");
vi.stubEnv("QCR_CONFIG_HOME", cfgHome);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
freshStateHomePerTest();

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

const put = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const shipped = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
/** A shipped agent with a marker line under its frontmatter. */
const marked = (rel: string, marker: string): string =>
  shipped(rel).replace(/\n---\n/, `\n---\n${marker}\n`);

/** main with one file, `feature` adding two lines; `qcr` files go on main (the
 * base) and `headQcr` files on feature (the PR head). */
function mkRepo(name: string, qcr: Record<string, string>, headQcr: Record<string, string> = {}) {
  const repo = join(tmp, name);
  put(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, "init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(qcr)) put(join(repo, ".qcr", rel), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "checkout", "-q", "-b", "feature");
  put(join(repo, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n");
  for (const [rel, text] of Object.entries(headQcr)) put(join(repo, ".qcr", rel), text);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "add b and c");
  writeFileSync(join(repo, ".git", "qcr-review.json"), JSON.stringify({ auto_limit_usd: 1000 }));
  return repo;
}

function mkRoot(): string {
  const root = join(tmp, "root");
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

const record = JSON.stringify({
  findings: [
    {
      path: "src/a.ts",
      line: 3,
      severity: "P0",
      title: "c breaks the build",
      disposition: "posted",
    },
  ],
  verdict: "REQUEST_CHANGES",
});
const outcome = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });

/** A fake pi that keeps what the run fed it: the lens agents of its private
 * agent dir and the system prompt file. */
function spyPi(name: string): { bin: string; seen: string } {
  const seen = join(tmp, `${name}-seen`);
  const bin = join(tmp, `${name}-pi`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      `mkdir -p ${JSON.stringify(seen)}`,
      `cp -r "$PI_CODING_AGENT_DIR/agents" ${JSON.stringify(seen)}/`,
      'sd=""; sp=""; prev=""; for a in "$@"; do',
      '  [ "$prev" = "--session-dir" ] && sd="$a"; [ "$prev" = "--system-prompt" ] && sp="$a"; prev="$a"',
      "done",
      `[ -n "$sp" ] && cp "$sp" ${JSON.stringify(seen)}/system-prompt.md`,
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":1,"output":1,"cost":{"total":0.25}}}}'`,
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, seen };
}

let root: string;
let ctx: ReturnType<typeof contextFor>;
beforeAll(() => {
  root = mkRoot();
  ctx = contextFor(root, "");
});
beforeEach(() => rmSync(cfgHome, { recursive: true, force: true }));

function harness(repo: string, piBin: string, profile = "") {
  const lines: string[] = [];
  const deps = {
    cwd: repo,
    out: (l: string) => lines.push(l),
    confirm: null,
    root,
    agentDir: join(tmp, "agent"),
    cfg: { ...ctx.cfg, review: { ...ctx.cfg.review, profile } },
    ecosystem: ctx.ecosystem,
    piBin,
    runsDir: join(tmp, `runs-${Math.random().toString(36).slice(2)}`),
    timeoutMs: 10 * 60_000,
    warn: () => {},
  };
  return { deps, lines };
}

function userProfile(name: string, files: Record<string, string>): void {
  const p = join(cfgHome, "profiles", name);
  put(join(p, "profile.toml"), 'extends = "default"\n');
  for (const [rel, text] of Object.entries(files)) put(join(p, rel), text);
}

const agentFiles = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

describe("qcr review under profile overrides", () => {
  it("a user profile and the repo's base-commit .qcr/ replace agents; the run says it is customised", async () => {
    userProfile("mine", {
      "agents/pass-security.md": marked("agents/pass-security.md", "USER-SEC"),
    });
    const repo = mkRepo(
      "both",
      {
        "agents/pass-delivery.md": marked("agents/pass-delivery.md", "BASE-DELIVERY"),
        "agents/pass-security.md": marked("agents/pass-security.md", "REPO-SEC-LOSES"),
        "prompts/conversation-system.md": `BASE-CONVERSATION\n${shipped("prompts/conversation-system.md")}`,
        "profile.toml": 'dry_run = false\n[github]\nsecrets_dir = "/steal"\n',
        "extensions/bash-guard.ts": "export default {};\n",
      },
      { "agents/pass-delivery.md": marked("agents/pass-delivery.md", "HEAD-DELIVERY") },
    );
    const pi = spyPi("both");
    const h = harness(repo, pi.bin, "mine");
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines.at(-1)!);
    expect(o.ok).toBe(true);
    expect(o.customised).toBe(true);
    expect(o.overrides.map((x: { path: string; origin: string }) => [x.path, x.origin])).toEqual([
      ["agents/pass-delivery.md", "repo"],
      ["agents/pass-security.md", "user"],
      ["prompts/conversation-system.md", "repo"],
    ]);
    // what the model was fed: the user's security, the BASE's delivery, never the head's
    const agents = agentFiles(join(pi.seen, "agents"));
    const sec = Object.entries(agents).filter(([f]) => f.startsWith("pass-security--"));
    const del = Object.entries(agents).filter(([f]) => f.startsWith("pass-delivery--"));
    expect(sec.length).toBeGreaterThan(0);
    for (const [, t] of sec) {
      expect(t).toContain("USER-SEC");
      expect(t).not.toContain("REPO-SEC-LOSES");
    }
    expect(del.length).toBeGreaterThan(0);
    for (const [, t] of del) {
      expect(t).toContain("BASE-DELIVERY");
      expect(t).not.toContain("HEAD-DELIVERY");
    }
    expect(readFileSync(join(pi.seen, "system-prompt.md"), "utf8")).toContain("BASE-CONVERSATION");
    // what a repo may not set is dropped and reported, and the gate is untouched
    const said = (o.warnings as string[]).join("\n");
    expect(said).toMatch(/profile: .*"dry_run" is guarded/);
    expect(said).toMatch(/profile: .*extensions\/bash-guard\.ts/);
    expect(h.deps.cfg.dry_run).toBe(ctx.cfg.dry_run);
  });

  it("the terminal and the markdown report carry the customised line, the report last", async () => {
    userProfile("mine", {
      "agents/pass-security.md": marked("agents/pass-security.md", "USER-SEC"),
    });
    const repo = mkRepo("note", {});
    const report = join(tmp, "note-report.md");
    const h = harness(repo, spyPi("note").bin, "mine");
    expect(await runReviewCli(["--out", report], false, h.deps)).toBe(0);
    expect(h.lines.join("\n")).toMatch(
      /Customised: this review ran with 1 shipped file replaced by a profile: agents\/pass-security\.md \(user profile\)/,
    );
    const md = readFileSync(report, "utf8").trimEnd().split("\n");
    expect(md.at(-1)).toMatch(/^> Customised: .*agents\/pass-security\.md/);
  });

  it("with no replacement the run is uncustomised and the model is fed the stock agents", async () => {
    const repo = mkRepo("stock", {});
    const pi = spyPi("stock");
    const h = harness(repo, pi.bin);
    expect(await runReviewCli(["--out", join(tmp, "stock-report.md")], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines.at(-1)!);
    expect(o.customised).toBe(false);
    expect(o.overrides).toEqual([]);
    expect(h.lines.join("\n")).not.toMatch(/Customised/);
    expect(readFileSync(join(tmp, "stock-report.md"), "utf8")).not.toMatch(/Customised/);
    // byte-identical to what the bench builds for the same config
    buildBenchAgents(root, h.deps.cfg, join(tmp, "stock-expected"));
    expect(agentFiles(join(pi.seen, "agents"))).toEqual(agentFiles(join(tmp, "stock-expected")));
    expect(readFileSync(join(pi.seen, "system-prompt.md"), "utf8")).not.toMatch(/BASE-/);
  });

  it("a .qcr/ the PR adds does not review that PR", async () => {
    const repo = mkRepo(
      "headonly",
      {},
      { "agents/pass-security.md": marked("agents/pass-security.md", "HEAD-ONLY") },
    );
    const pi = spyPi("headonly");
    const h = harness(repo, pi.bin);
    expect(await runReviewCli([], true, h.deps)).toBe(0);
    const o = JSON.parse(h.lines.at(-1)!);
    expect(o.customised).toBe(false);
    for (const t of Object.values(agentFiles(join(pi.seen, "agents"))))
      expect(t).not.toContain("HEAD-ONLY");
  });
});

describe("the bench under profile overrides", () => {
  const bench = (profile: string, allow: boolean) => benchCustomisation(root, profile, allow);

  it("an uncustomised run's inputs are unchanged", () => {
    const stock = join(tmp, "bench-stock");
    const viaCustomisation = join(tmp, "bench-via");
    buildBenchAgents(root, ctx.cfg, stock);
    const b = bench("", false);
    expect(b.readFile).toBeUndefined();
    expect(b.custom).toEqual({ customised: false, overrides: [] });
    buildBenchAgents(root, ctx.cfg, viaCustomisation, b);
    expect(agentFiles(viaCustomisation)).toEqual(agentFiles(stock));
    // the fingerprint of an uncustomised run carries no new field
    const plain = runFingerprint(ctx.cfg, "");
    expect(runFingerprint(ctx.cfg, "", "", b.custom)).toEqual(plain);
    expect(plain).not.toHaveProperty("customised");
    expect(plain).not.toHaveProperty("profile_overrides");
  });

  it("a profile that replaces a shipped file is refused unless flagged", () => {
    userProfile("mine", {
      "agents/pass-security.md": marked("agents/pass-security.md", "USER-SEC"),
    });
    expect(() => bench("mine", false)).toThrow(
      /profile "mine" replaces shipped files.*agents\/pass-security\.md.*--allow-customised/,
    );
    const b = bench("mine", true);
    expect(b.custom.customised).toBe(true);
    expect(b.readFile).toBeTypeOf("function");
    // flagged: the run is served the replacement and its fingerprint says so
    const out = join(tmp, "bench-custom");
    buildBenchAgents(root, { ...ctx.cfg, review: { ...ctx.cfg.review, profile: "mine" } }, out, b);
    const secs = Object.entries(agentFiles(out)).filter(([f]) => f.startsWith("pass-security--"));
    expect(secs.length).toBeGreaterThan(0);
    for (const [, t] of secs) expect(t).toContain("USER-SEC");
    const fp = runFingerprint(ctx.cfg, "mine", "", b.custom);
    expect(fp.customised).toBe(true);
    expect(fp.profile_overrides?.map((x) => x.path)).toEqual(["agents/pass-security.md"]);
    expect(fp).not.toEqual(runFingerprint(ctx.cfg, "mine"));
  });

  it("a byte-identical copy of a shipped agent does not make the bench run customised", () => {
    userProfile("copy", { "agents/pass-security.md": shipped("agents/pass-security.md") });
    expect(bench("copy", false).custom.customised).toBe(false);
  });
});
