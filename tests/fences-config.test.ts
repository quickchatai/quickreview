// [T4] — a config knob must have a READER, not just a parser.
//
// This is the fence the ticket names as the methodological lesson, and it is
// named after a check that gave a false all-clear. During charting, "every
// config knob is read somewhere" was run MENTION-BASED — it asked whether the
// knob's name appears in the repository — and came back clean, while six knobs
// were parsed by `src/config.ts` and consumed by nothing. A name appears in its
// own declaration. That is not evidence of use.
//
// So the search here excludes the parser. A knob is "read" only if its name
// appears somewhere that is NOT `src/config.ts`: elsewhere in `src/`, in
// `extensions/`, `scripts/`, `deploy/` or `docker/` — the places a knob can
// legitimately be consumed, including by ansible and by the entrypoint
// templates.
//
// HONEST LIMIT, stated because it changes what a pass means: this is still a
// NAME search, so a knob whose name collides with an unrelated identifier
// ("port", "version") passes without being read. It cannot under-report — a
// knob with a real reader always has its name somewhere — so what it gives is
// a floor, not a proof. Making it exact needs a resolver over the parsed
// `Config` object graph, which is a different piece of work.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? tsFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
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
   * The twelve knobs `src/config.ts` parses and nothing consumes.
   *
   * [A10] found SIX by hand; this fence, run against the wider reader
   * search above, finds twelve. Their disposition — delete the knob, or wire
   * the feature it was meant to steer — is [A10]'s cut and not this ticket's:
   * each one is a small judgement about whether the knob names a capability
   * somebody still wants. What this ticket owes is that the set is WRITTEN
   * DOWN and cannot grow quietly, which is what set equality below buys.
   *
   * A note on honesty: no per-knob reason is given, because giving twelve
   * confident reasons would mean inventing eleven of them. The list is the
   * record; the ticket that cuts them is [A10].
   *
   * MUTATION: add `rogue_knob: string;` to any `*Config` interface — this
   * fails naming it. Delete the last reader of a knob — same.
   */
  const PARSED_BUT_UNREAD: readonly string[] = [
    "app_token_file",
    "awaiting_author_stale_h",
    "awaiting_human_stale_h", // …and this one names the retired park
    "bot_token_file",
    "broadcast_verdicts",
    "embedding_dimension",
    "embedding_model",
    "queue_concurrency",
    "soft_exchange_limit",
    "ssh_dir",
    "storm_corrections",
    "tickets_effort",
  ];

  it("the knob set is large enough that the parse cannot have silently failed", () => {
    // If the interface scan breaks, `unread` is empty and everything below
    // passes while checking nothing — the exact failure this file is about.
    expect(declaredKnobs().length, "the *Config interface scan found almost nothing").toBeGreaterThan(100);
  });

  it("only the recorded knobs are parsed and never consumed", () => {
    const hay = consumerText();
    const unread = declaredKnobs()
      .filter((n) => !new RegExp(`\\b${n}\\b`).test(hay))
      .sort();

    expect(
      unread,
      "a config knob is parsed by src/config.ts and read by nothing anywhere else. Either wire it, delete it, "
        + "or — if it really is dead debt somebody has decided to keep for now — add it to PARSED_BUT_UNREAD. "
        + "If a knob DROPPED off this list, delete its entry: it now has a reader.",
    ).toEqual([...PARSED_BUT_UNREAD].sort());
  });
});
