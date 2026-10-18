// The one-shot review runner (src/oneshot.ts): one `pi -p --mode json` main
// session with the production round order on stdin, the findings rendered by
// the production review renderer, one `--continue` when outputs are missing.
// It takes a prepared tree, a file list, a target description and an output
// dir, and knows nothing about bench cases. pi is a fake shell script: no
// network, no model.

import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

vi.stubEnv(
  "QCR_CONFIG",
  resolve(dirname(fileURLToPath(import.meta.url)), "fixtures", "config.toml"),
);

const { runOneShot, onLfLines } = await import("../src/oneshot.js");
const { benchConfig } = await import("../src/bench/runner.js");
const { ecosystemFor } = await import("../src/ecosystem.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "oneshot-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const FINDING = {
  path: "src/a.ts",
  line: 2,
  severity: "important",
};

/** A production-shaped root without the checkout's own wt/ and state/. */
function mkRoot(name: string): string {
  const root = join(tmp, name);
  mkdirSync(root);
  for (const e of readdirSync(ROOT))
    if (!["wt", ".git", "state"].includes(e)) symlinkSync(join(ROOT, e), join(root, e));
  return root;
}

function mkTree(name: string): string {
  const tree = join(tmp, name);
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
  return tree;
}

/** A fake pi: reads the prompt, records its argv and stdin, persists a
 * session, usage in the event stream, and writes the output files. */
function fakePi(name: string, script: string[]): { bin: string; calls: string; stdin: string } {
  const calls = join(tmp, `${name}.calls`);
  const stdin = join(tmp, `${name}.stdin`);
  const bin = join(tmp, `${name}-pi`);
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `cat > ${JSON.stringify(stdin)}`,
      `echo "$*" >> ${JSON.stringify(calls)}`,
      'sd=""; prev=""; for a in "$@"; do [ "$prev" = "--session-dir" ] && sd="$a"; prev="$a"; done',
      'mkdir -p "$sd"; echo \'{"type":"session"}\' > "$sd/s.jsonl"; cd="$(dirname "$sd")"',
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"input":100,"output":10,"cacheRead":5,"cost":{"total":0.25}}}}'`,
      ...script,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return { bin, calls, stdin };
}

const target = {
  repo: "example-org/example-app",
  number: 7,
  title: "Add b",
  body: null,
  headSha: "a".repeat(40),
  baseRef: "main",
  baseSha: "b".repeat(40),
  mergeBase: "b".repeat(40),
};

const files = [{ filename: "src/a.ts", additions: 1, deletions: 0, status: "modified" }];

const record = JSON.stringify({ findings: [FINDING], verdict: "REQUEST_CHANGES" });
const outcome = JSON.stringify({ verdict: "REQUEST_CHANGES", passes: [] });

describe("runOneShot", () => {
  it("runs one pi session end to end and returns findings, the rendered review and the cost", async () => {
    const pi = fakePi("happy", [
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);
    const outDir = join(tmp, "out-happy");
    const r = await runOneShot({
      root: mkRoot("root-happy"),
      agentDir: join(tmp, "agent"),
      tree: mkTree("tree-happy"),
      files,
      target,
      outDir,
      cfg: benchConfig(""),
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      piBin: pi.bin,
    });
    const calls = readFileSync(pi.calls, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/-p/);
    expect(calls[0]).toMatch(/--mode json/);
    expect(calls[0]).not.toMatch(/--continue/);
    // The production round order went in on stdin, naming the target.
    expect(readFileSync(pi.stdin, "utf8")).toMatch(/example-org\/example-app/);
    expect(r.continued).toBe(false);
    expect(r.error).toBeUndefined();
    expect(r.outcome).toMatchObject({ verdict: "REQUEST_CHANGES" });
    expect((r.findings as { findings: unknown[] }).findings).toHaveLength(1);
    expect(typeof r.review).toBe("string");
    expect(r.review).toBe(readFileSync(join(outDir, "review.md"), "utf8"));
    expect(r.usage).toMatchObject({ input: 100, output: 10, cacheRead: 5 });
    expect(r.costUsd).toBeCloseTo(0.25);
    expect(r.plannedLenses.length).toBeGreaterThan(0);
  });

  it("gets one --continue when the outcome is there but the findings record is not", async () => {
    const pi = fakePi("retry", [
      'case "$*" in',
      `  *--continue*) printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json" ;;`,
      `  *) printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json" ;;`,
      "esac",
    ]);
    const outDir = join(tmp, "out-retry");
    const r = await runOneShot({
      root: mkRoot("root-retry"),
      agentDir: join(tmp, "agent"),
      tree: mkTree("tree-retry"),
      files,
      target,
      outDir,
      cfg: benchConfig(""),
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      piBin: pi.bin,
    });
    const calls = readFileSync(pi.calls, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(/--continue/);
    expect(r.continued).toBe(true);
    expect((r.findings as { findings: unknown[] }).findings).toHaveLength(1);
    expect(existsSync(join(outDir, "review.md"))).toBe(true);
  });

  it("a pi that dies before any message is an error, not a continuation", async () => {
    const bin = join(tmp, "dead-pi");
    writeFileSync(bin, "#!/bin/sh\ncat >/dev/null\necho '429 rate limit' >&2\nexit 1\n");
    chmodSync(bin, 0o755);
    const r = await runOneShot({
      root: mkRoot("root-dead"),
      agentDir: join(tmp, "agent"),
      tree: mkTree("tree-dead"),
      files,
      target,
      outDir: join(tmp, "out-dead"),
      cfg: benchConfig(""),
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      piBin: bin,
    });
    expect(r.continued).toBe(false);
    expect(r.error).toMatch(/nothing to continue/);
    expect(r.findings).toBeUndefined();
    expect(r.review).toBeNull();
  });

  it("stops hard once pi's own spend reaches capUsd, with no continuation", async () => {
    const pi = fakePi("capped", [
      `echo '{"type":"message_end","message":{"role":"assistant","usage":{"cost":{"total":5}}}}'`,
      "sleep 60",
    ]);
    const t0 = Date.now();
    const r = await runOneShot({
      root: mkRoot("root-capped"),
      agentDir: join(tmp, "agent"),
      tree: mkTree("tree-capped"),
      files,
      target,
      outDir: join(tmp, "out-capped"),
      cfg: benchConfig(""),
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      piBin: pi.bin,
      capUsd: 1,
    });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.capped).toBe(true);
    expect(r.continued).toBe(false);
    expect(readFileSync(pi.calls, "utf8").trim().split("\n")).toHaveLength(1);
    expect(r.costUsd).toBeGreaterThanOrEqual(5);
  });

  it("counts the cost of an event whose JSON holds U+2028 and U+2029 toward capUsd", async () => {
    // JSON leaves U+2028/U+2029 unescaped inside strings; a splitter that
    // breaks on them cuts the event in two and neither half parses.
    const pi = fakePi("capped-ls", [
      `printf '{"type":"message_end","message":{"role":"assistant","content":"a\u2028b\u2029c","usage":{"cost":{"total":5}}}}\\n'`,
      "sleep 60",
    ]);
    const t0 = Date.now();
    const r = await runOneShot({
      root: mkRoot("root-capped-ls"),
      agentDir: join(tmp, "agent"),
      tree: mkTree("tree-capped-ls"),
      files,
      target,
      outDir: join(tmp, "out-capped-ls"),
      cfg: benchConfig(""),
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      piBin: pi.bin,
      capUsd: 1,
    });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(r.capped).toBe(true);
  });

  it("a run under capUsd is not capped", async () => {
    const pi = fakePi("uncapped", [
      `printf '%s' ${JSON.stringify(record)} > "$cd/findings-record.json"`,
      `printf '%s' ${JSON.stringify(outcome)} > "$cd/outcome.json"`,
    ]);
    const r = await runOneShot({
      root: mkRoot("root-uncapped"),
      agentDir: join(tmp, "agent"),
      tree: mkTree("tree-uncapped"),
      files,
      target,
      outDir: join(tmp, "out-uncapped"),
      cfg: benchConfig(""),
      ecosystem: ecosystemFor("none"),
      timeoutMs: 10 * 60_000,
      piBin: pi.bin,
      capUsd: 1,
    });
    expect(r.capped).toBe(false);
  });
});

describe("onLfLines", () => {
  async function split(chunks: Array<string | Buffer>): Promise<string[]> {
    const input = new PassThrough();
    const out: string[] = [];
    const ended = new Promise((res) => input.once("end", res));
    onLfLines(input, (l) => out.push(l));
    for (const c of chunks) input.write(c);
    input.end();
    await ended;
    return out;
  }

  it("splits on LF only: U+2028, U+2029 and a bare CR stay inside the line", async () => {
    expect(await split(["a\u2028b\u2029c\rd\ne\n"])).toEqual(["a\u2028b\u2029c\rd", "e"]);
  });

  it("drops one CR before the LF and delivers a last unterminated line", async () => {
    expect(await split(["x\r\ny\n\nz"])).toEqual(["x", "y", "", "z"]);
  });

  it("joins a line and a multibyte character cut across chunks", async () => {
    const b = Buffer.from("h\u00e9llo\u2028w\n");
    expect(await split([b.subarray(0, 2), b.subarray(2, 9), b.subarray(9)])).toEqual([
      "h\u00e9llo\u2028w",
    ]);
  });
});
