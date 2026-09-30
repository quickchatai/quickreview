// setup-triage — the TRIAGE half of the companion's scan tool belt.
// Not an extension of its own: extensions/setup.ts registers these beside the
// setup_* and scan_* tools. The companion judges — what the operator decided
// about a finding, which effort its work belongs in, what recurs across the
// repo — and these tools act; every rule and refusal is ScanTriage's
// (src/setup/triage.ts).
//
//   - scan_dismiss: dismiss a finding with the operator's reason — an
//     unpinned `#scan` memory note, so PR rounds stop raising it;
//   - scan_promote: file ONE ticket for a finding in the effort that fits
//     (the issue tracker, or a markdown file in the state home without one),
//     fingerprint-stamped — never twice;
//   - scan_close_fixed: close the tickets of promoted findings a re-scan found
//     fixed (it also runs at every scan run's end and after scan_match — this
//     is the retry);
//   - scan_memory: write recurring patterns and per-unit hotspots of a scan
//     as `#scan` memory, capped per scan; individual findings never.
//
// Convention (setup.ts): every tool answers a refusal as its result, never a
// throw.
import type { PiToolDefinition, PiToolResult } from "@earendil-works/pi-coding-agent";
import type { Refusal } from "../src/setup/engine.js";
import { MAX_PATTERNS_PER_SCAN, MEMORY_TEXT_MAX, REASON_MAX, type ScanTriage } from "../src/setup/triage.js";

function text(t: string, details?: Record<string, unknown>): PiToolResult {
  return details ? { content: [{ type: "text", text: t }], details } : { content: [{ type: "text", text: t }] };
}

function refused(what: string, r: Refusal): PiToolResult {
  return text(`${what} refused:\n${r.errors.map((e) => `✗ ${e}`).join("\n")}`);
}

const FP_PARAM = {
  type: "string",
  description: "The finding's fingerprint as scan_findings shows it (the first 12 characters are enough).",
} as const;

export function triageToolDefinitions(triage: ScanTriage): PiToolDefinition[] {
  const dismiss: PiToolDefinition = {
    name: "scan_dismiss",
    label: "Dismiss a scan finding",
    description:
      "Dismiss a scan finding on the operator's word, with THEIR reason (at most " +
      `${REASON_MAX} characters). It stays dismissed across re-scans, and an unpinned #scan note of what was dismissed and why ` +
      "goes to reviewer memory so PR rounds stop raising it. Refused for a promoted finding (settle it on its ticket) and a fixed one.",
    promptSnippet: "Dismiss a scan finding with a reason",
    parameters: {
      type: "object",
      properties: { fingerprint: FP_PARAM, reason: { type: "string", description: "Why it is not a problem — the operator's reason." } },
      required: ["fingerprint", "reason"],
    },
    execute: async (_id, params) => {
      const r = await triage.dismiss({ fingerprint: params?.fingerprint, reason: params?.reason });
      if (!r.ok) return refused("Dismiss", r);
      const fp = r.finding.fingerprint.slice(0, 12);
      const mem = r.memory === "written" ? "the memory note is written" : `the memory note was NOT written (${r.memory.problem}) — dismiss it again later to retry`;
      return text(`${fp} ${r.again ? "re-dismissed" : "dismissed"}: ${mem}.`, { fingerprint: r.finding.fingerprint, memory: r.memory === "written" });
    },
  };
  const promote: PiToolDefinition = {
    name: "scan_promote",
    label: "Promote a scan finding",
    description:
      "Promote a scan finding on the operator's word: file ONE ticket for it in the tracker effort its work belongs in (you pick the " +
      "effort that fits; an unknown one is refused with the list). Without an issue tracker it becomes one markdown file in the state " +
      "home. The ticket is stamped with the fingerprint and never filed twice — a finding that has one goes back onto it. Optional: " +
      "a title (one line) and a note (your context for whoever picks it up). A re-scan that finds it fixed closes the ticket. " +
      "Promotion defaults to CONFIRMED findings (the scan's skeptic traced a concrete scenario): a likely, doubtful or unjudged one is " +
      "refused unless you pass `unconfirmed: true` — only when the operator explicitly asked to promote that one.",
    promptSnippet: "File a ticket for a scan finding",
    parameters: {
      type: "object",
      properties: {
        fingerprint: FP_PARAM,
        effort: { type: "string", description: "The tracker effort the ticket goes in (ignored by the markdown fallback beyond being recorded)." },
        title: { type: "string" },
        note: { type: "string" },
        unconfirmed: {
          type: "boolean",
          description: "true only on the operator's explicit word: promote a finding the skeptic did not confirm (likely, doubtful or unknown).",
        },
      },
      required: ["fingerprint", "effort"],
    },
    execute: async (_id, params) => {
      const r = await triage.promote({
        fingerprint: params?.fingerprint,
        effort: params?.effort,
        title: params?.title,
        note: params?.note,
        unconfirmed: params?.unconfirmed,
      });
      if (!r.ok) return refused("Promote", r);
      const fp = r.finding.fingerprint.slice(0, 12);
      const where = r.sink === "markdown" ? `the markdown file ${r.ref} in the state home` : r.ref;
      const line = r.existing
        ? `${fp} is promoted onto its existing ticket ${where} — nothing new was filed` +
          (r.closed ? ` (that ticket was closed as fixed at ${r.closed.sha.slice(0, 12)}; it came back — reopen it by hand if it is real)` : "")
        : `${fp} promoted: filed as ${where}.`;
      return text(line, { fingerprint: r.finding.fingerprint, ref: r.ref, sink: r.sink, existing: r.existing });
    },
  };
  const closeFixed: PiToolDefinition = {
    name: "scan_close_fixed",
    label: "Close fixed findings' tickets",
    description:
      "Close the ticket of every promoted finding a re-scan found fixed, with the scan's sha. Runs on its own at every scan run's end " +
      "and after scan_match; call it to retry the ones that were refused (a claimed ticket stays open for whoever claimed it).",
    promptSnippet: "Close tickets of fixed scan findings",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      const r = await triage.closeFixed();
      const out: string[] = [];
      if (r.closed.length === 0 && r.problems.length === 0) out.push("Nothing to close: no promoted finding is fixed with its ticket still open.");
      for (const c of r.closed) out.push(`Closed ${c.ref} (${c.fingerprint.slice(0, 12)}) — fixed at ${c.sha.slice(0, 12)}.`);
      for (const p of r.problems) out.push(`✗ ${p}`);
      return text(out.join("\n"), { closed: r.closed.length, problems: r.problems.length });
    },
  };
  const memory: PiToolDefinition = {
    name: "scan_memory",
    label: "Write scan memory",
    description:
      "Write what a scan taught about the repo into reviewer memory as unpinned #scan entries: recurring PATTERNS (each with how many " +
      `times it recurs, at least 2; at most ${MAX_PATTERNS_PER_SCAN} per scan) and per-unit HOTSPOTS (one per unit per scan — where the code ` +
      `is fragile). One line each, at most ${MEMORY_TEXT_MAX} characters. Individual findings NEVER become memory: text that anchors to ` +
      "one line (path:line), quotes a finding's claim or carries its fingerprint is refused. A scan = the runs at one sha; `run` " +
      "defaults to the latest finished one. Refused whole if any item is bad or the cap would be exceeded.",
    promptSnippet: "Write a scan's patterns and hotspots to memory",
    parameters: {
      type: "object",
      properties: {
        run: { type: "string", description: "A scan run id (default: the latest finished run)." },
        patterns: {
          type: "array",
          items: { type: "object", properties: { text: { type: "string" }, occurrences: { type: "number" } }, required: ["text", "occurrences"] },
        },
        hotspots: {
          type: "array",
          items: { type: "object", properties: { unit: { type: "string" }, text: { type: "string" } }, required: ["unit", "text"] },
        },
      },
    },
    execute: async (_id, params) => {
      const r = await triage.writeMemory({ run: params?.run, patterns: params?.patterns, hotspots: params?.hotspots });
      if (!r.ok) return refused("Scan memory", r);
      const out = [
        `Written for the scan at ${r.sha.slice(0, 12)} (run ${r.run}): ${r.written.patterns} pattern(s), ${r.written.hotspots} hotspot(s).`,
        `Left for this scan: ${r.left.patterns} pattern(s); units without a hotspot: ${r.left.units_without_hotspot.join(", ") || "none"}.`,
        ...r.problems.map((p) => `✗ ${p}`),
      ];
      return text(out.join("\n"), { written: r.written, left_patterns: r.left.patterns });
    },
  };
  return [dismiss, promote, closeFixed, memory];
}
