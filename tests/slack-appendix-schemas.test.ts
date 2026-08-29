// drift correction, kept honest in both directions.
//
// The seeded overseer prompt advertises command schemas that `validateCommand`
// rejects (`flag-owner-legacy {reason}`, `file-improvement-pr {branch, rationale}`).
// The seed is unmodifiable (hard rule 6), so the correction lives in the
// non-seeded `prompts/slack-overseer-appendix.md`. This test pins the appendix
// to the CODE: field lists are derived by probing the real `validateCommand`
// (never by reading the appendix or the seed), then compared set-for-set.
//
// It fails if either side drifts: a new/renamed field in src/commands.ts that
// the appendix doesn't document, or an appendix entry the validator won't take.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMAND_WHITELIST, validateCommand, type CommandName } from "../src/commands.js";
import { buildInjectBody, SLACK_INJECT_MARKER } from "../src/slack/router.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appendix = readFileSync(join(repoRoot, "prompts/slack-overseer-appendix.md"), "utf8");

/**
 * the safety valve was renamed `flag-owner-legacy` → `flag-owner`. The
 * appendix is frozen prose until the reseed and still documents the
 * legacy spelling; `validateCommand` folds that spelling to the current name,
 * so this test compares through the same fold the code applies. When
 * lands and the appendix says `flag-owner`, this map goes empty — the code's
 * own alias (tests/legacy-acceptance.test.ts) stays either way.
 */
const LEGACY_DOC_NAMES: Record<string, string> = { "flag-owner-legacy": "flag-owner" };
/** The spelling the appendix uses for a whitelisted command. */
const docNameFor = (command: string): string =>
  Object.entries(LEGACY_DOC_NAMES).find(([, canonical]) => canonical === command)?.[0] ?? command;

/**
 * Field names to probe. A superset of everything any command takes, plus the
 * two stale spellings and a control that no command may accept — so a field
 * added to src/commands.ts without being added here still can't slip past
 * silently (the control assertions below would have to change).
 */
const CANDIDATE_FIELDS = [
  "pr",
  "reason",
  "message",
  "branch",
  "title",
  "body",
  "slug",
  "rationale",
  "target",
  "note",
  "thread",
  "text",
  "on",
  "comment_id",
  "channel",
  "__control_never_valid__",
] as const;

/**
 * Derive a command's accepted field set from the validator itself: a field is
 * accepted iff probing it does NOT produce the strict unknown-field rejection.
 * (Type/format complaints mean the field IS in the schema.)
 */
function acceptedFields(command: CommandName | string): string[] {
  return CANDIDATE_FIELDS.filter((field) => {
    const res = validateCommand({ command, [field]: "probe" });
    return !(res.ok === false && res.reason.startsWith("unknown field(s)"));
  }).sort();
}

/** Parse the appendix's schema bullets: "- `name {a, b}` — prose". */
function appendixSchemas(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const line of appendix.split("\n")) {
    const m = /^-\s+`([a-z][a-z0-9_-]*)\s*\{([^}]*)\}`/.exec(line.trim());
    const name = m?.[1];
    const raw = m?.[2];
    if (name === undefined || raw === undefined) continue;
    const fields = raw
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
      .sort();
    out.set(name, fields);
  }
  return out;
}

const documented = appendixSchemas();

describe("slack overseer appendix — corrected command schemas", () => {
  it("the probe harness is sound: the control field is never accepted", () => {
    for (const command of COMMAND_WHITELIST) {
      expect(acceptedFields(command), `${command} accepted the control field`).not.toContain(
        "__control_never_valid__",
      );
    }
  });

  it("documents every whitelisted command, and nothing that isn't whitelisted", () => {
    // Documented names are folded exactly as validateCommand folds them, so a
    // legacy spelling in the frozen appendix still counts as its command.
    expect([...documented.keys()].map((k) => LEGACY_DOC_NAMES[k] ?? k).sort()).toEqual([...COMMAND_WHITELIST].sort());
  });

  it.each([...COMMAND_WHITELIST])("%s: appendix field list matches validateCommand", (command) => {
    const actual = acceptedFields(command);
    const docName = docNameFor(command);
    expect(
      documented.get(docName),
      `prompts/slack-overseer-appendix.md documents '${docName}' as ` +
        `{${documented.get(docName)?.join(", ") ?? "<missing>"}} but src/commands.ts accepts ` +
        `{${actual.join(", ")}}. Update the appendix (it is non-seeded and ours to edit).`,
    ).toEqual(actual);
  });

  it("names each command and each of its required fields in prose form too", () => {
    for (const command of COMMAND_WHITELIST) {
      const docName = docNameFor(command);
      expect(appendix, `appendix never mentions '${docName}'`).toContain(docName);
      for (const field of acceptedFields(command)) {
        expect(appendix, `appendix never mentions field '${field}' (of ${command})`).toContain(field);
      }
    }
  });

  // ---- the two drifts, pinned from both ends ------------------------

  it("the safety valve takes 'message', not the seeded 'reason' — under both spellings", () => {
    expect(acceptedFields("flag-owner")).toEqual(["message"]);
    // The legacy spelling inherits the exact same strict schema.
    expect(acceptedFields("flag-owner-legacy")).toEqual(["message"]);
    expect(validateCommand({ command: "flag-owner-legacy", reason: "x" })).toEqual({
      ok: false,
      reason: "unknown field(s): reason",
    });
    expect(documented.get("flag-owner-legacy")).toEqual(["message"]);
    // The stale schema must not be advertised anywhere in the appendix.
    expect(/flag-owner-legacy\s*\{[^}]*\breason\b/.test(appendix)).toBe(false);
  });

  it("file-improvement-pr takes branch/title/body/slug, not the seeded 'rationale'", () => {
    expect(acceptedFields("file-improvement-pr")).toEqual(["body", "branch", "slug", "title"]);
    expect(validateCommand({ command: "file-improvement-pr", branch: "b", rationale: "why" })).toEqual({
      ok: false,
      reason: "unknown field(s): rationale",
    });
    expect(documented.get("file-improvement-pr")).toEqual(["body", "branch", "slug", "title"]);
    expect(/file-improvement-pr\s*\{[^}]*\brationale\b/.test(appendix)).toBe(false);
  });

  it("states that unknown fields are rejected outright", () => {
    expect(appendix.toLowerCase()).toMatch(/unknown field/);
    expect(appendix.toLowerCase()).toMatch(/reject/);
  });

  it("documents slack_reply with no channel field — the channel is unrepresentable", () => {
    expect(documented.get("slack_reply")).toEqual(["text", "thread"]);
    expect(validateCommand({ command: "slack_reply", thread: "1712345678.123456", text: "hi", channel: "C1" })).toEqual({
      ok: false,
      reason: "unknown field(s): channel",
    });
  });

  it("carries no unfinished slice placeholder", () => {
    expect(appendix).not.toMatch(/land in slice S5|<!-- S3: confirm path -->|TODO/);
  });
});

// ---- the origin header, pinned to what buildInjectBody actually emits -------
//
// This is the one artifact that joins the daemon to the model, and the model is
// told to TRUST it. Documenting a shape the code never emits teaches the model
// to trust a shape an attacker can forge in message text (`quoteUserText`
// hardens the table form only). So the appendix is generated-against-code here:
// a real sample is built, and every field it emits must appear as a table row.

/** A sample envelope, from the real builder. */
const sample = buildInjectBody({
  event: {
    event_id: "Ev0PARITY",
    type: "message",
    channel: "C0CONCIERGE",
    ts: "1712345678.123456",
    user: "U0ALICE",
    text: "any news on #1234?",
    event_ts: "1712345678.123456",
  },
  threadTs: "1712345678.123456",
  threadPr: 1234,
  displayName: "Alice Nowak",
  githubLogin: "alice-gh",
  tier: "author",
  authorizedPrs: [1234],
  receivedAt: new Date("2026-08-17T09:12:33.000Z"),
});

/** Field names of the emitted header table, in emission order. */
function emittedFields(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^\| ([a-z_]+) \| (.*) \|$/.exec(line);
    if (!m?.[1] || m[1] === "field") continue;
    out.push(m[1]);
  }
  return out;
}

/** Field names the appendix documents as table rows. */
function documentedFields(): string[] {
  return appendix
    .split("\n")
    .map((l) => /^\| ([a-z_]+) \|/.exec(l.trim())?.[1])
    .filter((f): f is string => f !== undefined && f !== "field" && f !== "---");
}

describe("slack overseer appendix — the origin header", () => {
  it("documents the MARKER and the literal table header row, not a colon list", () => {
    expect(appendix).toContain(SLACK_INJECT_MARKER);
    expect(appendix).toContain("| field | value |");
    expect(appendix).toContain("| --- | --- |");
    // The pre-fix appendix taught `source: slack` colon lines. Nothing emits that.
    expect(appendix).not.toMatch(/^\s*source:\s*slack\s*$/m);
    expect(appendix).not.toMatch(/^\s*event_id:\s/m);
  });

  it("documents exactly the fields buildInjectBody emits, in the same order", () => {
    const emitted = emittedFields(sample);
    expect(emitted).toEqual([
      "source",
      "event_id",
      "channel",
      "thread",
      "thread_pr",
      "slack_user",
      "display_name",
      "github_login",
      "tier",
      "authorized_prs",
      "received_at",
    ]);
    expect(
      documentedFields(),
      "prompts/slack-overseer-appendix.md must document the header table exactly as " +
        "buildInjectBody emits it — the model is told to trust this shape.",
    ).toEqual(emitted);
  });

  it("documents the em-dash empty-value convention the builder uses", () => {
    const dashed = buildInjectBody({
      event: { event_id: "E", type: "message", channel: "C", ts: "1.1", user: "U", text: "", event_ts: "1.1" },
      threadTs: "1.1",
      threadPr: null,
      displayName: "U",
      githubLogin: null,
      tier: "anyone",
      authorizedPrs: [],
      receivedAt: new Date("2026-08-17T09:12:33.000Z"),
    });
    expect(dashed).toContain("| thread_pr | — |");
    expect(dashed).toContain("| github_login | — |");
    expect(dashed).toContain("| authorized_prs | — |");
    expect(appendix).toContain("—");
  });

  it("documents only tiers the router can actually inject", () => {
    // A user-less event is dropped before injection (G3), so `ignored` never
    // reaches the model and must not be advertised as a tier it might see.
    // the router now injects `owner` where the appendix's frozen
    // prose still spells the top tier `owner_legacy`; the prose catches up in the
    // reseed. `system` is daemon-stamped only (OriginStore.writeLocal)
    // and never injectable, so it must not appear either.
    const tierRow = appendix.split("\n").find((l) => l.trim().startsWith("| tier |"));
    expect(tierRow).toBeDefined();
    expect(tierRow).toContain("anyone");
    expect(tierRow).toContain("author");
    expect(tierRow).toContain("owner_legacy"); // legacy spelling of `owner`, frozen until
    expect(tierRow).not.toContain("ignored");
    expect(tierRow).not.toContain("system");
  });

  it("keeps the never-finished check", () => {
    expect(appendix).not.toMatch(/land in slice S5|<!-- S3: confirm path -->|TODO/);
  });
});
