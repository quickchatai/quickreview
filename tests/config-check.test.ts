// `qcr config check [--json] [--config-home <dir>]` — the VM updater runs it
// with the NEW image on the staged config home, before it stops anything.
// It loads the home through config.ts with all its refusals, prints EVERY
// error, and exits non-zero on any.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkConfigHome, cmdConfig } from "../src/configcheck.js";
import { main } from "../src/cli.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// The shipped example is a config the parser accepts.
const GOOD = readFileSync(join(root, "config.example.toml"), "utf8");

const withProfile = (name: string): string =>
  GOOD.replace(/^profile = ""$/m, `profile = "${name}"`);

function home(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-cfgcheck-"));
  dirs.push(d);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(d, rel)), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}

function check(h: string, json = false): { code: number; out: string[] } {
  const out: string[] = [];
  const code = cmdConfig(["check", ...(h ? ["--config-home", h] : [])], json, {
    defaultHome: () => h,
    out: (l) => out.push(l),
    root,
  });
  return { code, out };
}

describe("qcr config check", () => {
  it("exits 0 on a clean home and says so", () => {
    const h = home({ "config.toml": GOOD });
    const r = check(h);
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("config ok");
    const j = check(h, true);
    expect(j.code).toBe(0);
    expect(JSON.parse(j.out[0]!)).toEqual({ ok: true, config_home: h, errors: [] });
  });

  it("reports a RETIRED key and exits non-zero (--json carries the error)", () => {
    const h = home({ "config.toml": GOOD.replace(/^\[slack\]$/m, "[slack]\ninbound = true") });
    const r = check(h, true);
    expect(r.code).toBe(1);
    const j = JSON.parse(r.out[0]!) as {
      ok: boolean;
      errors: { where: string; message: string }[];
    };
    expect(j.ok).toBe(false);
    expect(j.errors).toHaveLength(1);
    expect(j.errors[0]!.where).toContain("config.toml");
    expect(j.errors[0]!.message).toMatch(/inbound.*retired|retired.*inbound/);
    // the text form prints it too
    const t = check(h);
    expect(t.code).toBe(1);
    expect(t.out.join("\n")).toMatch(/inbound/);
    expect(t.out.join("\n")).toContain("config check failed: 1 error(s)");
  });

  it("reports a bad value", () => {
    const h = home({ "config.toml": GOOD.replace(/^preset = ".*"$/m, 'preset = "bogus"') });
    const r = check(h, true);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.out[0]!) as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
  });

  it("reports a missing config.toml", () => {
    const h = home({ "profiles/x/profile.toml": "# x\n" });
    const r = check(h, true);
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("no config.toml in the config home");
  });

  it("reports a named profile the home does not hold, once, and one it holds that is broken", () => {
    let h = home({ "config.toml": withProfile("house") });
    let r = check(h, true);
    expect(r.code).toBe(1);
    const missing = JSON.parse(r.out[0]!) as { errors: { message: string }[] };
    expect(missing.errors).toHaveLength(1);
    expect(missing.errors[0]!.message).toContain('profile "house" not found');
    // a profile found in the HOME (never the operator's own XDG home) parses
    h = home({
      "config.toml": withProfile("house"),
      "profiles/house/profile.toml": 'extends = "default"\n',
    });
    expect(check(h).code).toBe(0);
    // …and one whose profile.toml is broken is an error naming it
    h = home({
      "config.toml": withProfile("house"),
      "profiles/house/profile.toml": 'ecosystem = "cobol"\n',
    });
    r = check(h, true);
    expect(r.code).toBe(1);
    expect(r.out[0]).toContain("cobol");
    expect(r.out[0]).toContain("profile house");
  });

  it("is wired into qcr as `config check` (exit code, --json, --config-home)", async () => {
    const h = home({ "config.toml": GOOD.replace(/^\[slack\]$/m, "[slack]\ninbound = true") });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (l: unknown) => void logs.push(String(l));
    const prev = process.exitCode;
    try {
      await main(["config", "check", "--json", "--config-home", h]);
      expect(process.exitCode).toBe(1);
      expect((JSON.parse(logs[0]!) as { ok: boolean }).ok).toBe(false);
      logs.length = 0;
      await main(["config", "check", "--json", "--config-home", home({ "config.toml": GOOD })]);
      expect(process.exitCode).toBe(0);
      expect((JSON.parse(logs[0]!) as { ok: boolean }).ok).toBe(true);
    } finally {
      console.log = orig;
      process.exitCode = prev;
    }
  });

  it("a usage error is exit 2", () => {
    expect(cmdConfig(["wat"], false, { defaultHome: () => "", out: () => {} })).toBe(2);
    expect(cmdConfig(["check", "--nope"], false, { defaultHome: () => "", out: () => {} })).toBe(2);
  });

  it("checkConfigHome is total over a missing directory", () => {
    const r = checkConfigHome({ home: join(tmpdir(), "qcr-no-such-home"), root });
    expect(r.ok).toBe(false);
  });
});
