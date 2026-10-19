// [T4] — a config knob must have a reader, not just a parser.
//
// A mention-based check — does the knob's name appear in the repository? —
// gives a false all-clear: a name appears in its own declaration, which is
// not evidence of use.
//
// So the search here excludes the parser. A knob is "read" only if its name
// appears somewhere that is NOT `src/config.ts`: elsewhere in `src/`, in
// `extensions/`, `scripts/`, `deploy/` or `docker/` — the places a knob can
// legitimately be consumed, including by ansible and by the entrypoint
// templates.
//
// Limits, stated because they change what a pass means. Both are
// over-permissive, never under: a knob with a real reader always has its name
// somewhere, so this is a floor and not a proof.
//
//   1. It is a NAME search, so a knob whose name collides with an unrelated
//      identifier ("port", "version") passes without being read.
//   2. Comments are stripped from `src/**` only. A knob named in a shell or
//      ansible comment therefore counts as read — the same shape as limit 1,
//      hiding the same thing.
//
// Making it exact needs a resolver over the parsed `Config` object graph,
// which is a different piece of work.
//
// These compound with [T9]'s. That one calls a key "documented" if its
// character appears anywhere in the help text; this one calls a knob "read"
// if its name appears anywhere outside the parser. Independently reasonable
// over-permissive limits in fences that never mention each other can together
// let a degenerate `return true` pass. When a fence here is loosened, check
// what else is already loose.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const ROOT = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? tsFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
  );
}

function allFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*)/.test(l))
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Every property declared on a `*Config` interface in src/config.ts. */
function declaredKnobs(): string[] {
  const cfg = stripComments(readFileSync(join(ROOT, "src", "config.ts"), "utf8"));
  const names = new Set<string>();
  for (const m of cfg.matchAll(/(?:export\s+)?interface\s+\w*Config\s*\{([\s\S]*?)\n\}/g)) {
    for (const p of m[1]!.matchAll(/^\s{2,}(\w+)\??\s*:/gm)) names.add(p[1]!);
  }
  return [...names];
}

/** Everything that could legitimately consume a knob, minus the parser. */
function consumerText(): string {
  const parts: string[] = [];
  for (const f of tsFiles(join(ROOT, "src"))) {
    if (f.endsWith("/config.ts")) continue;
    parts.push(stripComments(readFileSync(f, "utf8")));
  }
  for (const dir of ["extensions", "scripts", "deploy", "docker"]) {
    for (const f of allFiles(join(ROOT, dir))) {
      if (/\.(png|jpg|jpeg|ico|gz|pem|lock)$/.test(f)) continue;
      parts.push(readFileSync(f, "utf8"));
    }
  }
  return parts.join("\n");
}

describe("[T4] every config knob has a reader, not just a parser", () => {
  /**
   * The nine knobs `src/config.ts` parses and nothing consumes.
   *
   * Their disposition — delete the knob, or wire the feature it was meant to
   * steer — is a separate judgement per knob about whether it names a
   * capability somebody still wants. What this fence owes is that the set is
   * written down and cannot grow quietly, which is what set equality below
   * buys. No per-knob reason is given; the list is the record.
   *
   * MUTATION: add `rogue_knob: string;` to any `*Config` interface — this
   * fails naming it. Delete the last reader of a knob — same.
   */
  const PARSED_BUT_UNREAD: readonly string[] = [
    "awaiting_author_stale_h",
    "broadcast_verdicts",
    // The Slack router read it to drop a stale backlog message; inbound turns are
    // retired (every admitted message is `dropped_no_overseer`), so it is
    // accepted for an older config and read by nothing.
    "catchup_max_age_s",
    "queue_concurrency",
    "soft_exchange_limit",
    "ssh_dir",
    "storm_corrections",
    "tickets_effort",
  ];

  it("the knob set is large enough that the parse cannot have silently failed", () => {
    // If the interface scan breaks, `unread` is empty and everything below
    // passes while checking nothing — the exact failure this file is about.
    expect(
      declaredKnobs().length,
      "the *Config interface scan found almost nothing",
    ).toBeGreaterThan(100);
  });

  it("only the recorded knobs are parsed and never consumed", { timeout: HEAVY_TIMEOUT_MS }, () => {
    const hay = consumerText();
    const unread = declaredKnobs()
      .filter((n) => !new RegExp(`\\b${n}\\b`).test(hay))
      .sort();

    expect(
      unread,
      "the parsed-but-unread knob set no longer matches the record. EXTRA means a knob is parsed by " +
        "src/config.ts and read by nothing anywhere else — wire it, delete it, or add it to PARSED_BUT_UNREAD " +
        "with why it is being kept. MISSING means a recorded knob either gained a reader or was deleted; " +
        "either way its entry goes.",
    ).toEqual([...PARSED_BUT_UNREAD].sort());
  });
});
