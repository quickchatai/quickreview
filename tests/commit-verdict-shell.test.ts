// scripts/commit-verdict.sh (H1a, #5885) — the sessions' one way to
// publish a verdict or recheck-outcome file. Run for real from a scratch root
// (a copy of the script in <root>/scripts/, so its own location decides where
// verdict/ is — no env override exists to point it elsewhere).
//
// What it must guarantee: the published name only ever holds a COMPLETE JSON
// object (a rename of the staged file — the same inode, never a copy written
// in place), and it touches nothing but verdict/<name>.tmp and verdict/<name>.
import { execFile } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkBashCommand } from "../extensions/bash-guard.js";
import { RECHECK_FILE_RE } from "../src/recheck.js";
import { VERDICT_FILE_RE } from "../src/verdicts.js";

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let root: string;
let verdict: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-commit-verdict-"));
  mkdirSync(join(root, "scripts"));
  copyFileSync(
    join(repo, "scripts", "commit-verdict.sh"),
    join(root, "scripts", "commit-verdict.sh"),
  );
  verdict = join(root, "verdict");
  mkdirSync(verdict);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function commit(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const r = await run("bash", [join(root, "scripts", "commit-verdict.sh"), ...args], {
      cwd: root,
    });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code?: number; stdout?: string; stderr?: string };
    return { code: x.code ?? 1, out: x.stdout ?? "", err: x.stderr ?? "" };
  }
}

const VERDICT = JSON.stringify({
  pr: 5885,
  round_no: 2,
  verdict: "APPROVE",
  head_sha: "ddc5fa9",
  finished_at: "2026-10-07T23:01:11Z",
});

describe("commit-verdict.sh", () => {
  it("publishes a complete staged verdict by RENAME: same inode, staged name gone", async () => {
    const staged = join(verdict, "pr-5885-round-2.json.tmp");
    writeFileSync(staged, VERDICT);
    const ino = statSync(staged).ino;

    const r = await commit("pr-5885-round-2.json");

    expect(r.code).toBe(0);
    expect(r.out).toContain("published verdict/pr-5885-round-2.json");
    expect(readFileSync(join(verdict, "pr-5885-round-2.json"), "utf8")).toBe(VERDICT);
    expect(statSync(join(verdict, "pr-5885-round-2.json")).ino).toBe(ino);
    expect(existsSync(staged)).toBe(false);
  });

  it("publishes a recheck outcome file the same way", async () => {
    const name = "pr-5850-recheck-8693fde76890.json";
    expect(RECHECK_FILE_RE.test(name)).toBe(true);
    writeFileSync(join(verdict, `${name}.tmp`), '{"pr":5850,"outcome":"uphold"}');
    expect((await commit(name)).code).toBe(0);
    expect(existsSync(join(verdict, name))).toBe(true);
  });

  it("replaces an older file of the same name (a re-run of the same round)", async () => {
    writeFileSync(join(verdict, "pr-1-round-1.json"), '{"old":true}');
    writeFileSync(join(verdict, "pr-1-round-1.json.tmp"), '{"new":true}');
    expect((await commit("pr-1-round-1.json")).code).toBe(0);
    expect(readFileSync(join(verdict, "pr-1-round-1.json"), "utf8")).toBe('{"new":true}');
  });

  it("refuses a half-written or non-object staged file and publishes NOTHING", async () => {
    for (const bad of ['{"pr": 5885, "round_no": 2, "verdi', "", "[1,2]", '"text"', "{} {}"]) {
      writeFileSync(join(verdict, "pr-2-round-1.json.tmp"), bad);
      const r = await commit("pr-2-round-1.json");
      expect(r.code, JSON.stringify(bad)).not.toBe(0);
      expect(r.err).toContain("nothing was published");
      expect(existsSync(join(verdict, "pr-2-round-1.json"))).toBe(false);
      expect(existsSync(join(verdict, "pr-2-round-1.json.tmp"))).toBe(true); // left to fix
    }
  });

  it("accepts exactly what the daemon's JSON.parse accepts: NaN, Infinity and -Infinity are refused", async () => {
    // Python's json.load takes these by default; JSON.parse throws on them, so
    // a file published with one would be malformed to the watcher.
    for (const bad of [
      '{"pr": 6, "round_no": 1, "spend": NaN}',
      '{"pr": 6, "round_no": 1, "spend": Infinity}',
      '{"pr": 6, "round_no": 1, "spend": -Infinity}',
    ]) {
      expect(() => JSON.parse(bad), bad).toThrow();
      writeFileSync(join(verdict, "pr-6-round-1.json.tmp"), bad);
      const r = await commit("pr-6-round-1.json");
      expect(r.code, bad).not.toBe(0);
      expect(r.err).toContain("nothing was published");
      expect(existsSync(join(verdict, "pr-6-round-1.json"))).toBe(false);
    }
    // …while every ordinary number still passes.
    const fine = '{"pr": 6, "round_no": 1, "spend": 1e-3, "n": -0, "big": 12345678901234567890}';
    expect(() => JSON.parse(fine)).not.toThrow();
    writeFileSync(join(verdict, "pr-6-round-1.json.tmp"), fine);
    expect((await commit("pr-6-round-1.json")).code).toBe(0);
  });

  it("refuses when nothing is staged", async () => {
    const r = await commit("pr-3-round-1.json");
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("nothing staged");
  });

  it("takes only the two verdict-file names — no path, no traversal, no other file", async () => {
    writeFileSync(join(root, "config.toml.tmp"), "{}");
    for (const name of [
      "../config.toml",
      "verdict/pr-1-round-1.json",
      "pr-1-round-1.json/../../config.toml",
      "notes.json",
      "pr-1-round-x.json",
      "pr-1-recheck-zzzzzzzzzzzz.json",
      "pr-1-round-1.json.tmp",
      "",
    ]) {
      const r = await commit(name);
      expect(r.code, name).not.toBe(0);
      expect(r.err, name).toContain("usage");
    }
    expect((await commit("pr-1-round-1.json", "extra")).code).not.toBe(0);
    expect(existsSync(join(root, "config.toml"))).toBe(false);
  });

  it("every name it accepts is one a daemon watcher consumes", () => {
    const accepted = /^pr-[0-9]+-(round-[0-9]+|recheck-[0-9a-fA-F]{7,40})\.json$/;
    const script = readFileSync(join(repo, "scripts", "commit-verdict.sh"), "utf8");
    expect(script).toContain(accepted.source);
    for (const name of ["pr-5885-round-2.json", "pr-5850-recheck-8693fde7.json"]) {
      expect(accepted.test(name)).toBe(true);
      expect(VERDICT_FILE_RE.test(name) || RECHECK_FILE_RE.test(name), name).toBe(true);
    }
  });

  it("refuses a symlinked staged file and a directory at the published name", async () => {
    writeFileSync(join(root, "elsewhere.json"), "{}");
    symlinkSync(join(root, "elsewhere.json"), join(verdict, "pr-4-round-1.json.tmp"));
    expect((await commit("pr-4-round-1.json")).err).toContain("symlink");
    expect(existsSync(join(verdict, "pr-4-round-1.json"))).toBe(false);

    writeFileSync(join(verdict, "pr-5-round-1.json.tmp"), "{}");
    mkdirSync(join(verdict, "pr-5-round-1.json"));
    const r = await commit("pr-5-round-1.json");
    expect(r.code).not.toBe(0);
    expect(existsSync(join(verdict, "pr-5-round-1.json.tmp"))).toBe(true);
  });

  it("is a sanctioned script in the sessions' exec policy (every spelling the templates use)", () => {
    for (const form of [
      "scripts/commit-verdict.sh pr-5885-round-2.json",
      "bash scripts/commit-verdict.sh pr-5885-round-2.json",
      "./scripts/commit-verdict.sh pr-5850-recheck-8693fde76890.json",
    ]) {
      const r = checkBashCommand(form);
      expect(r.allowed, `${form} — ${r.reason ?? ""}`).toBe(true);
    }
    // `mv` itself stays off the allowlist: the script is the only rename.
    expect(checkBashCommand("mv verdict/a.tmp verdict/a.json").allowed).toBe(false);
  });
});
