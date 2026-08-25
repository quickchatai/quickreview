import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isActionableTicket,
  parseTrackerTicket,
  readEffortTickets,
} from "../src/tui/trackertickets.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ticket(id: string, status: string, title: string, updated: string): string {
  return `# ${title}

Id: ${id}
Effort: review-feedback-loop
Type: task
Status: ${status}
Role: ready-for-human
Category: —
Labels: wayfinder:task
Assignee: —
Blocked-by: —
Parent: FT-0189
Spec: —
Branch: —
PR: —
Created: 2026-08-25T00:00:00Z by companion
Updated: ${updated}
Claimed: —
Closed: —

## Question

Read the full evidence and decide what to do.
`;
}

describe("read-only feedback ticket projection", () => {
  it("parses the tracker header and preserves the complete body", () => {
    const parsed = parseTrackerTicket(ticket("FT-0300", "open", "Settle feedback", "2026-08-25T18:00:00Z"));
    expect(parsed).toMatchObject({
      id: "FT-0300",
      title: "Settle feedback",
      status: "open",
      role: "ready-for-human",
    });
    expect(parsed!.body).toContain("Read the full evidence");
    expect(isActionableTicket(parsed!)).toBe(true);
  });

  it("lists actionable tickets first and tolerates unrelated files", () => {
    const root = mkdtempSync(join(tmpdir(), "qcr-feedback-tickets-"));
    roots.push(root);
    const dir = join(root, "efforts/review-feedback-loop/tickets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "FT-0300-open.md"), ticket("FT-0300", "open", "Open feedback", "2026-08-25T17:00:00Z"));
    writeFileSync(join(dir, "FT-0299-done.md"), ticket("FT-0299", "resolved", "Done feedback", "2026-08-25T18:00:00Z"));
    writeFileSync(join(dir, "README.md"), "not a ticket");

    const tickets = readEffortTickets(root);
    expect(tickets.map((t) => t.id)).toEqual(["FT-0300", "FT-0299"]);
    expect(tickets[0]!.path).toContain("FT-0300-open.md");
  });
});
