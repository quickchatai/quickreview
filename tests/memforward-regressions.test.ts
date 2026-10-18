import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
const forward = await import("../scripts/companion-memory-forward.mjs");
it("installed unit retains explicit upstream and listener settings", () => {
  const { cfg } = forward.parseArgs(
    [
      "install",
      "--remote-host",
      "10.0.0.2",
      "--remote-port",
      "1234",
      "--bind",
      "127.0.0.2,127.0.0.3",
    ],
    {},
  );
  const unit = forward.unitText(cfg, {});
  expect(unit).toContain("--remote-host 10.0.0.2");
  expect(unit).toContain("--remote-port 1234");
  expect(unit).toContain("--bind 127.0.0.2,127.0.0.3");
});
it("systemd preserves paths with spaces and permits the selected local sudo transport", () => {
  const { cfg } = forward.parseArgs(["install", "--local", "--identity", "/keys/my key"], {});
  expect(forward.unitText(cfg, {})).toContain(' --identity "/keys/my key"');
  expect(forward.unitText(cfg, {})).toContain("NoNewPrivileges=no");
  expect(forward.unitText({ ...cfg, sudo: false }, {})).toContain("NoNewPrivileges=yes");
});
it("write verification also detects a failed read permission", async () => {
  const methods: string[] = [];
  const report = await forward.runVerify({
    base: "http://localhost",
    keys: { companion: "c", reviewer: "r" },
    write: true,
    log: () => {},
    fetchFn: async (_url, init) => {
      methods.push(init?.method ?? "GET");
      const own =
        init?.headers?.Authorization === `Bearer ${init?.headers?.["X-OpenViking-User"]?.[0]}`;
      return { status: own ? (init?.method === "GET" ? 403 : 200) : 403, json: async () => ({}) };
    },
  });
  expect(methods.filter((x) => x === "GET")).toHaveLength(4);
  expect(methods.filter((x) => x === "POST")).toHaveLength(4);
  expect(report.failed).toBeGreaterThan(0);
});
it("reinstall applies the rewritten unit to an already-running service", () => {
  const home = mkdtempSync(join(tmpdir(), "forward-unit-"));
  const calls: string[][] = [];
  try {
    const { cfg } = forward.parseArgs(["install", "--local", "--no-sudo"], {});
    const code = forward.install(cfg, {
      home,
      execute: (_bin: string, args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: "198.51.100.1\n", stderr: "" };
      },
    });
    expect(code).toBe(0);
    expect(calls).toContainEqual(["--user", "restart", `${cfg.unit}.service`]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
it("uninstall reports a rejected shutdown", () => {
  const { cfg } = forward.parseArgs(["uninstall"], {});
  expect(forward.uninstall(cfg, () => ({ status: 1, stdout: "", stderr: "denied" }))).toBe(1);
});
