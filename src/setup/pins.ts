// Setup's pin proposals, as a file: `<state home>/setup/
// pin-proposals.json` holds the reviewer-memory entries the companion
// proposes to pin, each with one line of why. The companion writes it
// (tuning.ts `proposePins`); the TUI reads it and marks those entries on its
// memory tab, where the OPERATOR pins — nothing that writes this file pins.
//
// A leaf: no runtime import of any setup sibling, so the TUI can read the
// file without reaching the rest of src/setup/ (single-shepherd S2 fence).

export const PIN_PROPOSALS_FILE = "setup/pin-proposals.json";

export interface PinProposal {
  id: string;
  ts: string;
  block: number;
  /** The entry's hash when proposed — a changed entry is not the one proposed. */
  hash: string;
  excerpt: string;
  why: string;
}

export interface PinProposalsFile {
  proposed_at: string;
  entries: PinProposal[];
}

export type PinProposalsRead = { state: "absent" } | { state: "ok"; file: PinProposalsFile } | { state: "unreadable"; error: string };

/** Read the proposals file from its text (null = absent). */
export function parsePinProposals(text: string | null): PinProposalsRead {
  if (text === null) return { state: "absent" };
  try {
    const raw = JSON.parse(text) as Partial<PinProposalsFile>;
    if (typeof raw.proposed_at !== "string" || !Array.isArray(raw.entries)) throw new Error("not {proposed_at, entries}");
    const entries = raw.entries.filter(
      (e): e is PinProposal =>
        typeof e?.id === "string" && typeof e.ts === "string" && typeof e.block === "number" && typeof e.why === "string",
    );
    return { state: "ok", file: { proposed_at: raw.proposed_at, entries } };
  } catch (err) {
    return { state: "unreadable", error: `${PIN_PROPOSALS_FILE} is not a proposals file (${String(err)})` };
  }
}

/** The key the TUI's memory tab addresses an entry by (memtab `entryKey`). */
export const proposalKey = (p: { id: string; ts: string; block: number }): string => `${p.ts}|${p.id}#${p.block}`;
