// ssh-master bootstrap + the triple-Ctrl-C kill chord — the two halves of
// "the TUI can always connect and can always be exited".
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { TripleCtrlC } from "../src/tui/chord.js";
import { ensureSshMaster, masterCheckArgv, masterConnectArgv, type SyncSsh } from "../src/tui/connect.js";

describe("TripleCtrlC", () => {
  it("fires only on three bare Ctrl-C presses inside the window", () => {
    let t = 0;
    const k = new TripleCtrlC(() => t);
    const ctrlC = Buffer.from([0x03]);
    expect(k.feed(ctrlC)).toBe(false);
    t += 300;
    expect(k.feed(ctrlC)).toBe(false);
    t += 300;
    expect(k.feed(ctrlC)).toBe(true);
  });

  it("does not fire across the window or when other bytes interleave", () => {
    let t = 0;
    const k = new TripleCtrlC(() => t);
    const ctrlC = Buffer.from([0x03]);
    expect(k.feed(ctrlC)).toBe(false);
    t += 2000; // window expired — restart the count
    expect(k.feed(ctrlC)).toBe(false);
    t += 100;
    expect(k.feed(Buffer.from("x"))).toBe(false); // resets
    t += 100;
    expect(k.feed(ctrlC)).toBe(false);
    t += 100;
    expect(k.feed(ctrlC)).toBe(false);
    // multi-byte chunks containing 0x03 (paste, mouse reports) never count
    expect(k.feed(Buffer.from([0x03, 0x03, 0x03]))).toBe(false);
  });
});

// (A "triple Ctrl-C inside a hung attach" test lived here. The full-screen
// attach — and with it the only pty the TUI ever held — was retired
// 2026-09-02, so there is no hung attach to escape from; the board's own
// Ctrl-C ×3 hatch is pinned in tests/cmdbar.test.ts.)

describe("ensureSshMaster", () => {
  const record = (checkStatus: number, connectStatus: number) => {
    const calls: Array<{ argv: string[]; interactive: boolean }> = [];
    const ssh: SyncSsh = (argv, interactive) => {
      calls.push({ argv, interactive });
      const status = argv[0] === "-O" ? checkStatus : connectStatus;
      return { status, stderr: status === 0 ? "" : "kex_exchange_identification: Connection closed" };
    };
    return { calls, ssh };
  };

  it("is a no-op when the master socket is alive", () => {
    const { calls, ssh } = record(0, 0);
    const said: string[] = [];
    expect(ensureSshMaster(TUI_DEFAULTS, ssh, (l) => said.push(l)).kind).toBe("alive");
    expect(calls).toEqual([{ argv: masterCheckArgv(TUI_DEFAULTS), interactive: false }]);
    expect(said).toEqual([]);
  });

  it("runs one interactive connect (native passphrase prompt) when it is not", () => {
    const { calls, ssh } = record(255, 0);
    const said: string[] = [];
    expect(ensureSshMaster(TUI_DEFAULTS, ssh, (l) => said.push(l)).kind).toBe("connected");
    expect(calls[1]).toEqual({ argv: masterConnectArgv(TUI_DEFAULTS), interactive: true });
    expect(said[0]).toContain("passphrase");
  });

  it("reports failure with the ssh stderr and points at the s key", () => {
    const { ssh } = record(255, 255);
    const said: string[] = [];
    const res = ensureSshMaster(TUI_DEFAULTS, ssh, (l) => said.push(l));
    expect(res.kind).toBe("failed");
    expect(res.detail).toContain("kex_exchange_identification");
    expect(said.some((l) => l.includes("press s"))).toBe(true);
  });
});
