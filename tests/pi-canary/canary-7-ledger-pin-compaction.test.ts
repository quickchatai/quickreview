// Canary 7 [P2.7]: pi honours what a session_before_compact hook returns.
//
// ledger-pin's whole value is that its { compaction } result REPLACES pi's
// default summary. pi ignores any field it does not read, so a bump that
// renames the result keys, moves the hook or stops copying the result into the
// session would silently drop the pinned ledger. This runs the shipped
// extension against a real AgentSession compaction (the summariser is the
// faux provider) and reads the outcome back from the session's own entries.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import ledgerPin, { LEDGER_ENTRY_TYPE, PIN_CLOSE, PIN_OPEN } from "../../extensions/ledger-pin.js";
import { type Rig, createRig, useOfflineGuard } from "./harness.js";

useOfflineGuard();

const LEDGER = [
  "LEDGER PR #42 @ abc1234",
  "F1 [P1/0.9][delivery] a.py:3 — null deref → open thread:9",
  "SETTLED: T1: conceded",
].join("\n");

let rig: Rig;
let scratch: string;

beforeEach(async () => {
  rig = await createRig();
  scratch = mkdtempSync(join(tmpdir(), "canary7-"));
  vi.stubEnv("QCR_PR", "42");
  vi.stubEnv("QCR_SESSION_NAME", "pr-42");
  vi.stubEnv("QCR_PR_META", "PR #42 — canary");
  vi.stubEnv("QCR_LEDGER_FILE", join(scratch, "pr-42.md"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rig.close();
  rmSync(scratch, { recursive: true, force: true });
});

/** Three long turns, the middle one carrying the ledger, so there is history to cut. */
async function fillHistory(session: Awaited<ReturnType<Rig["open"]>>): Promise<void> {
  const filler = "word ".repeat(400);
  rig.faux.setResponses([
    fauxAssistantMessage(`first ${filler}`),
    fauxAssistantMessage(`second ${filler}\n\n${LEDGER}`),
    fauxAssistantMessage(`third ${filler}`),
  ]);
  for (const p of ["one", "two", "three"]) await session.prompt(`${p} ${filler}`);
}

/** Any further request (the summariser's) answers with a recognisable summary. */
function summariserSays(text: string): void {
  rig.faux.appendResponses(Array.from({ length: 4 }, () => () => fauxAssistantMessage(text)));
}

describe("[canary 7] a session_before_compact result is honoured", () => {
  it("ledger-pin's { compaction } replaces pi's summary, with the ledger pinned verbatim", async () => {
    const session = await rig.open({ extensionFactories: [ledgerPin], keepRecentTokens: 300 });
    await fillHistory(session);
    summariserSays("PI DEFAULT SUMMARY");

    const result = await session.compact();

    // The pinned block is in what pi stored, so it was the hook's result that pi used.
    expect(result.summary).toContain("PI DEFAULT SUMMARY");
    expect(result.summary).toContain(PIN_OPEN);
    expect(result.summary).toContain(PIN_CLOSE);
    expect(result.summary).toContain(LEDGER);
    expect(result.summary).toContain("PR #42 — canary");

    const entries = session.sessionManager.getEntries();
    const compaction = entries.find((e) => e.type === "compaction");
    expect(compaction, "pi appended a compaction entry").toBeDefined();
    expect((compaction as unknown as { summary: string }).summary).toBe(result.summary);

    // ledger-pin also archived the ledger as a custom entry, which never reaches the model.
    const archived = entries.find(
      (e) =>
        e.type === "custom" &&
        (e as unknown as { customType: string }).customType === LEDGER_ENTRY_TYPE,
    ) as unknown as { data: { pr: number; ledger: string } } | undefined;
    expect(archived?.data.pr).toBe(42);
    expect(archived?.data.ledger).toBe(LEDGER);

    // The summary is what the model sees next: the rebuilt context carries it.
    const context = JSON.stringify(session.messages);
    expect(context).toContain(PIN_OPEN);
    // And the snapshot file ledger-pin keeps for archival was written.
    expect(readFileSync(join(scratch, "pr-42.md"), "utf8")).toContain("LEDGER PR #42");
  });

  it("without a ledger for its own PR the hook stays out of the way: pi's own summary stands", async () => {
    const session = await rig.open({ extensionFactories: [ledgerPin], keepRecentTokens: 300 });
    rig.faux.setResponses(
      ["a", "b", "c"].map((t) => fauxAssistantMessage(`${t} ${"word ".repeat(400)}`)),
    );
    for (const p of ["one", "two", "three"]) await session.prompt(`${p} ${"word ".repeat(400)}`);
    summariserSays("PI DEFAULT SUMMARY");

    const result = await session.compact();

    expect(result.summary).toContain("PI DEFAULT SUMMARY");
    expect(result.summary).not.toContain(PIN_OPEN);
  });

  it("{ cancel: true } from a hook stops the compaction", async () => {
    const session = await rig.open({
      keepRecentTokens: 300,
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", () => ({ cancel: true }));
        },
      ],
    });
    await fillHistory(session);
    summariserSays("PI DEFAULT SUMMARY");
    const callsBefore = rig.faux.state.callCount;

    await expect(session.compact()).rejects.toThrow(/cancel/i);

    expect(session.sessionManager.getEntries().some((e) => e.type === "compaction")).toBe(false);
    expect(rig.faux.state.callCount, "no summariser request was made").toBe(callsBefore);
  });

  it("an in-memory session manager is enough (no file is needed for the hook to run)", async () => {
    const session = await rig.open({
      sessionManager: SessionManager.inMemory(rig.dir),
      extensionFactories: [ledgerPin],
      keepRecentTokens: 300,
    });
    await fillHistory(session);
    summariserSays("PI DEFAULT SUMMARY");
    expect((await session.compact()).summary).toContain(PIN_OPEN);
  });
});
