import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as configModule from "../src/config.js";
import { parseConfig } from "../src/config.js";
import { cmdInstall, main } from "../src/cli.js";
const base = readFileSync(resolve(import.meta.dirname, "fixtures/config.toml"), "utf8");
const dirs: string[] = [];
function temporary() { const dir = mkdtempSync(join(tmpdir(), "qcr-cli-safety-")); dirs.push(dir); return dir; }
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const liveSlack = base.replace(/(\[slack\][\s\S]*?)enabled = false/, "$1enabled = true")
  .replace('channel = ""', 'channel = "C01EXAMPLE"').replace('slack_id = ""', 'slack_id = "U01EXAMPLE"')
  .replace(/^\[slack.users\]$/m, '[slack.users]\nU01EXAMPLE = "operator"');
it.each(["daily_turns", "per_user_daily_turns", "thread_replies_per_day", "announcements_per_hour"])("refuses malformed live Slack cap %s instead of failing open", (key) => {
  for (const value of ['"not a number"', '"20"', "nan", "inf", "-1"]) {
    const bad = liveSlack.replace(new RegExp(`^${key} = [^\\n]+`, "m"), `${key} = ${value}`);
    expect(() => parseConfig(bad), `${key} = ${value}`).toThrow(new RegExp(key));
  }
  const zero = liveSlack.replace(new RegExp(`^${key} = [^\\n]+`, "m"), `${key} = 0`);
  expect(() => parseConfig(zero)).not.toThrow();
});
it("refuses classifying the validator as an ordinary risk pass", () => {
  const text = base.replace(/^risk_passes = .*$/m, 'risk_passes = ["pass-validate"]');
  expect(() => parseConfig(text)).toThrow(/risk_passes.*pass-validate|pass-validate.*risk_passes/);
});
it("refuses trailing install arguments before moving owner files", () => {
  const root = temporary();
  writeFileSync(join(root, "config.toml"), "owner config bytes\n");
  expect(() => cmdInstall(["migrate", "--typo"], { root, env: { HOME: join(root, "home") }, log: () => {} })).toThrow(/usage/);
  expect(readFileSync(join(root, "config.toml"), "utf8")).toBe("owner config bytes\n");
  expect(existsSync(join(root, "home"))).toBe(false);
});
it("refuses trailing companion arguments before loading credentials or picking a runtime", async () => {
  vi.stubEnv("QCR_CONFIG", join(temporary(), "missing.toml"));
  await expect(main(["companion", "down", "--typo"])).rejects.toThrow(/usage: qcr companion/);
});
it("same-millisecond local drain commands retain distinct durable files", async () => {
  const root = temporary();
  vi.spyOn(configModule, "sandboxRoot").mockReturnValue(root);
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  await main(["drain", "on", "--local"]);
  await main(["drain", "off", "--local"]);
  const dir = join(root, "commands/operator");
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(2);
  expect(new Set(files.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).on))).toEqual(new Set([true, false]));
});
