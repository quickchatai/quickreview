// The canary suite's own guarantees : it is offline (proved by a guard
// that is itself proved to catch an attempt), it runs the pinned pi, every
// canary file is guarded, and `npm run canary:pi` and the CI step exist.
import net from "node:net";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createRig, installOfflineGuard, useOfflineGuard } from "./harness.js";

useOfflineGuard();

const ROOT = join(import.meta.dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("the canary suite is offline", () => {
  it("the guard catches fetch and TCP connects, and lets unix sockets through", async () => {
    const inner = installOfflineGuard();
    try {
      await expect(fetch("https://api.example.invalid/v1")).rejects.toThrow(/offline canary/);
      expect(() => net.connect({ host: "provider.example.invalid", port: 443 })).toThrow(
        /offline canary/,
      );
      expect(() => net.connect(8080, "127.0.0.1")).toThrow(/offline canary/);
      const sock = net.connect({ path: join(ROOT, "no-such.sock") });
      sock.on("error", () => {});
      sock.destroy();
    } finally {
      inner.restore();
    }
    expect(inner.log.attempts).toEqual([
      "fetch https://api.example.invalid/v1",
      "connect provider.example.invalid:443",
      "connect 127.0.0.1:8080",
    ]);
  });

  it("a full faux round trip makes no network attempt and only the faux provider answers", async () => {
    const guard = installOfflineGuard();
    const rig = await createRig();
    try {
      const session = await rig.open();
      rig.faux.setResponses([fauxAssistantMessage("hello")]);
      await session.prompt("hi");
      expect(session.getLastAssistantText()).toBe("hello");
      expect(session.model?.provider).toBe("faux");
      expect(rig.faux.state.callCount).toBe(1);
    } finally {
      rig.close();
      guard.restore();
    }
    expect(guard.log.attempts).toEqual([]);
  });

  it("pi runs offline: PI_OFFLINE and PI_TELEMETRY are set before any session", () => {
    expect(process.env.PI_OFFLINE).toBe("1");
    expect(process.env.PI_TELEMETRY).toBe("0");
  });

  it("every canary file installs the offline guard", () => {
    const files = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      expect(readFileSync(join(import.meta.dirname, f), "utf8"), f).toMatch(
        /useOfflineGuard\((\{[^}]*\})?\);/,
      );
    }
  });
});

describe("the canaries run against the pinned pi", () => {
  it("the installed pi and pi-ai are the exact versions package.json pins", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"]) {
      const installed = JSON.parse(read(`node_modules/${name}/package.json`)) as {
        version: string;
      };
      expect(installed.version, name).toBe(pkg.dependencies[name]);
    }
  });
});

describe("npm run canary:pi and the CI requirement", () => {
  it("canary:pi runs exactly this directory", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["canary:pi"]).toBe("vitest run tests/pi-canary");
  });

  it("ci.yml runs canary:pi whenever the pi dependencies changed", () => {
    const ci = read(".github/workflows/ci.yml");
    const step =
      /- name: pi canaries[^\n]*\n\s+if: steps\.pi\.outputs\.changed == 'true'\n\s+run: [^\n]*npm run canary:pi/;
    expect(ci).toMatch(step);
    // The detection step compares both the declared and the resolved pin of both packages.
    expect(ci).toContain("id: pi");
    for (const needle of [
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "package-lock.json",
      "package.json",
    ])
      expect(ci, needle).toContain(needle);
  });
});
