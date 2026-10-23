import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
it("a local relay failure with no matching cause points at the local docker, not ssh", () => {
  const { cfg } = forward.parseArgs(["run", "--local"], {});
  const cause = forward.relayFailureCause(cfg, "something unexpected") as {
    key: string;
    remedy: string;
  };
  expect(cause.key).toBe("unknown");
  expect(cause.remedy).not.toContain("ssh");
  expect(cause.remedy).toContain("docker");
});
it("an explicit --stats-file rides the installed unit", () => {
  const { cfg } = forward.parseArgs(["install", "--stats-file", "/custom/stats.json"], {});
  expect(forward.unitText(cfg, {})).toContain("--stats-file /custom/stats.json");
});
it("the docker network is created with the gateway the listener binds, and the unit passes it on", () => {
  const { cfg } = forward.parseArgs(
    ["install", "--subnet", "10.9.0.0/24", "--gateway", "10.9.0.5"],
    {},
  );
  const home = mkdtempSync(join(tmpdir(), "forward-gw-"));
  const calls: string[][] = [];
  try {
    forward.install(cfg, {
      home,
      execute: (_bin: string, args: string[]) => {
        calls.push(args);
        return { status: args[1] === "inspect" ? 1 : 0, stdout: "", stderr: "" };
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const create = calls.find((a) => a[0] === "network" && a[1] === "create");
  expect(create).toEqual(expect.arrayContaining(["--gateway", "10.9.0.5"]));
  expect(forward.unitText(cfg, {})).toMatch(/ensure-network .*--gateway 10\.9\.0\.5/);
});
it("readKeys reads a keys file exactly as the TUI's parseKeysEnv does", async () => {
  const { parseKeysEnv } = await import("../src/tui/memory.js");
  const text = [
    'OPENVIKING_COMPANION_KEY="unmatched',
    "OPENVIKING_REVIEWER_KEY='paired'",
    'OPENVIKING_API_KEY="first"',
    "OPENVIKING_API_KEY=",
    "",
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "forward-keys-"));
  try {
    const path = join(dir, "keys.env");
    writeFileSync(path, text);
    expect(forward.readKeys(path)).toEqual(parseKeysEnv(text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
