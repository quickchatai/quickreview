// ledger-pin: the extension mirrors only the session's own PR ledger. A
// session that quotes a sibling review's header must not persist that ledger
// over its own, and the overseer never carries a PR ledger. Filter is on
// QCR_PR; missing or garbage QCR_PR fails safe (no mirror).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "../extensions/cli/ledger-pin.js";
import { extractLedger, parseOwnPr } from "../extensions/ledger-pin.js";

/** A handler as the fake pi records it. */
type PiEventHandler = (event: Record<string, unknown>) => unknown;

const snapshotFault = vi.hoisted(() => ({ active: false }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (snapshotFault.active && String(args[0]).includes("ledger.md")) {
        fs.writeFileSync(args[0], "partial");
        throw new Error("disk full during snapshot write");
      }
      return fs.writeFileSync(...args);
    },
  };
});

const OWN = "LEDGER PR #42 @ abc123def\n- fact: own session state\n- next: reply to author";
const SIBLING = "LEDGER PR #5288 @ 8c2edc01\n- fact: sibling session state";

describe("parseOwnPr", () => {
  it.each(["0", "9007199254740992", "9".repeat(400)])("refuses invalid PR identity %s", (raw) => {
    expect(parseOwnPr(raw)).toBeUndefined();
  });
  it("parses a plain digit string (with surrounding whitespace)", () => {
    expect(parseOwnPr("42")).toBe(42);
    expect(parseOwnPr(" 5288 ")).toBe(5288);
  });

  it("returns undefined for missing/empty/garbage values", () => {
    expect(parseOwnPr(undefined)).toBeUndefined();
    expect(parseOwnPr("")).toBeUndefined();
    expect(parseOwnPr("   ")).toBeUndefined();
    expect(parseOwnPr("#42")).toBeUndefined();
    expect(parseOwnPr("42abc")).toBeUndefined();
    expect(parseOwnPr("banana")).toBeUndefined();
    expect(parseOwnPr("-1")).toBeUndefined();
  });
});

describe("extractLedger", () => {
  it("returns the own-PR block", () => {
    expect(extractLedger([`chatter\n\n${OWN}`], 42)).toBe(OWN);
  });

  it("keeps a ledger whole when it sits in a longer fence and quotes a three-backtick block", () => {
    const body = `${OWN}\n\`\`\`ts\nconst x = 1;\n\`\`\`\n- later: commitment after the quote`;
    const text = `before\n\n\`\`\`\`\n${body}\n\`\`\`\`\nafter`;
    expect(extractLedger([text], 42)).toBe(body);
  });

  it("ignores a sibling block even when it appears AFTER the own block (same text)", () => {
    const ignored: number[] = [];
    const out = extractLedger([`${OWN}\n\n${SIBLING}`], 42, (pr) => ignored.push(pr));
    expect(out).toBe(OWN);
    expect(ignored).toEqual([5288]);
  });

  it("ignores a sibling block in a later text entry", () => {
    const ignored: number[] = [];
    const out = extractLedger([OWN, SIBLING], 42, (pr) => ignored.push(pr));
    expect(out).toBe(OWN);
    expect(ignored).toEqual([5288]);
  });

  it("returns undefined when only sibling blocks are present", () => {
    const ignored: number[] = [];
    expect(extractLedger([SIBLING], 42, (pr) => ignored.push(pr))).toBeUndefined();
    expect(ignored).toEqual([5288]);
  });

  it("with no own PR (overseer / garbage QCR_PR) every block is ignored", () => {
    const ignored: number[] = [];
    expect(extractLedger([OWN, SIBLING], undefined, (pr) => ignored.push(pr))).toBeUndefined();
    expect(ignored).toEqual([42, 5288]);
  });

  it("skips the format's example: a header whose head is a <placeholder> (#6114, 2026-10-22)", () => {
    const example =
      "LEDGER PR #42 @ <head-sha>\nF1 [P1/0.9][delivery] path/file.py:123 — <claim> → open thread:<id>";
    // the example after the real block does not replace it
    expect(extractLedger([`${OWN}\n\n${example}`], 42)).toBe(OWN);
    expect(extractLedger([OWN, example], 42)).toBe(OWN);
    // and alone it is no ledger
    expect(extractLedger([example], 42)).toBeUndefined();
  });

  it("picks the LAST own-PR block when several are present", () => {
    const newer = "LEDGER PR #42 @ ffff9999\n- fact: newer state";
    expect(extractLedger([`${OWN}\n\n${newer}`], 42)).toBe(newer);
  });
});

describe("activate (mirror path)", () => {
  let dir: string | undefined;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = ["QCR_PR", "QCR_SESSION_NAME", "QCR_LEDGER_FILE", "QCR_PR_META"];

  function setup(env: Record<string, string | undefined>): {
    fire: (event: Record<string, unknown>) => void;
    snapshot: string;
  } {
    dir = mkdtempSync(join(tmpdir(), "qcr-ledger-pin-"));
    const snapshot = join(dir, "ledger.md");
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(env)) {
      if (v !== undefined) process.env[k] = v;
    }
    process.env.QCR_LEDGER_FILE = snapshot;
    const handlers = new Map<string, PiEventHandler>();
    const pi = { on: (event: string, handler: PiEventHandler) => handlers.set(event, handler) };
    activate(pi as unknown as ExtensionAPI);
    const fire = (event: Record<string, unknown>): void => {
      void handlers.get("turn_end")?.(event);
    };
    return { fire, snapshot };
  }

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    snapshotFault.active = false;
    vi.restoreAllMocks();
  });

  it("retries the same ledger after a transient publication failure", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fire, snapshot } = setup({ QCR_PR: "42", QCR_SESSION_NAME: "pr-42" });
    mkdirSync(snapshot);
    fire({ text: OWN });
    rmSync(snapshot, { recursive: true });
    fire({ text: OWN });
    expect(readFileSync(snapshot, "utf8").trim()).toBe(OWN);
  });

  it("keeps the prior durable snapshot intact when a replacement write fails", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fire, snapshot } = setup({ QCR_PR: "42", QCR_SESSION_NAME: "pr-42" });
    fire({ text: OWN });
    snapshotFault.active = true;
    fire({ text: OWN + "\n- fact: new" });
    snapshotFault.active = false;
    expect(readFileSync(snapshot, "utf8").trim()).toBe(OWN);
    fire({ text: OWN + "\n- fact: new" });
    expect(readFileSync(snapshot, "utf8").trim()).toBe(OWN + "\n- fact: new");
  });

  it("mirrors the session's own PR block", () => {
    const { fire, snapshot } = setup({ QCR_PR: "42", QCR_SESSION_NAME: "pr-42" });
    fire({ text: `intro\n\n${OWN}` });
    expect(readFileSync(snapshot, "utf8").trim()).toBe(OWN);
  });

  it("does not let a sibling block appearing after the own block overwrite it", () => {
    const debug = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fire, snapshot } = setup({ QCR_PR: "42", QCR_SESSION_NAME: "pr-42" });
    fire({ text: OWN });
    fire({ text: `quoting the sibling review for format:\n\n${SIBLING}` });
    expect(readFileSync(snapshot, "utf8").trim()).toBe(OWN);
    expect(debug.mock.calls.flat().join("\n")).toContain("ignoring LEDGER PR #5288");
  });

  it("overseer (no QCR_PR) mirrors no PR ledger, ever", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fire, snapshot } = setup({ QCR_SESSION_NAME: "overseer" });
    fire({ text: OWN });
    fire({ text: SIBLING });
    expect(existsSync(snapshot)).toBe(false);
  });

  it("garbage QCR_PR fails safe: nothing mirrored", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { fire, snapshot } = setup({ QCR_PR: "banana", QCR_SESSION_NAME: "pr-banana" });
    fire({ text: OWN });
    expect(existsSync(snapshot)).toBe(false);
  });
});
