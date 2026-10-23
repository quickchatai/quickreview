// Where a local review's result goes: shown to the person, saved as files,
// JSON back to an agent, or posted to the PR. The same rules hold for every
// surface that runs a review (`qcr review` in a terminal, the pi plugin's
// /review in a session):
//
//   - flags (`--to`, `--json`, `--out`) decide, when given;
//   - else the repo's saved default, when it has one;
//   - else an interactive run asks, every time; the person may keep the
//     answer as the repo's default, which then skips the question;
//   - else (piped, `--json`, CI, pi's print mode) the result is printed.
//
// `planDestinations` is that rule; `destinationMenu` is the question. The
// repo's default is kept in the review home (packages/pi-plugin/src/reviewstore.ts: shared by
// its worktrees, never tracked, never global), whose path every caller
// passes. Posting to a PR (packages/pi-plugin/src/reviewpost.ts) is offered,
// and accepted, only for a target that has a PR.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TerminalFinding } from "./localreview.js";
import { openReviewStoreIn } from "./reviewstore.js";

export type Destination = "terminal" | "file" | "json" | "pr";

export const DESTINATIONS: readonly Destination[] = ["terminal", "file", "json", "pr"];

/** What a non-interactive run with no default does: print, and hand the agent JSON. */
export const FALLBACK_DESTINATIONS: readonly Destination[] = ["terminal", "json"];

/** The keys of one finding in the JSON (and the facts of one markdown bullet). */
export const FINDINGS_JSON_KEYS = ["path", "line", "severity", "title", "lens"] as const;

export interface DestinationChoice {
  value: Destination;
  label: string;
}

/** Where the person reads a result: a terminal (`qcr review`), or a pi
 * session (the plugin's /review), where "terminal" is the session itself and
 * a saved report carries its JSON beside the markdown. */
export type DestinationSurface = "terminal" | "session";

/** The destinations a person can be asked to pick. `pr`: the target is a PR,
 * the only target that can be posted to. */
export function destinationChoices(
  target: { pr: boolean },
  surface: DestinationSurface = "terminal",
): DestinationChoice[] {
  const post = target.pr
    ? [{ value: "pr" as const, label: "post to the PR as a comment-only review" }]
    : [];
  if (surface === "session")
    return [
      { value: "terminal", label: "show it in this session" },
      { value: "file", label: "save it as markdown and JSON" },
      ...post,
    ];
  return [
    { value: "terminal", label: "print in the terminal" },
    { value: "file", label: "write a markdown report" },
    { value: "json", label: "JSON for a coding agent" },
    ...post,
  ];
}

/** One answer to the destination question: where this run's result goes, and
 * whether the repo keeps it as its default (which skips the question next time). */
export interface DestinationPick {
  destinations: Destination[];
  remember: boolean;
}

export interface DestinationMenuItem {
  label: string;
  pick: DestinationPick;
}

/** What a run with nobody to ask prints, per surface: the CLI its text and
 * the JSON (an agent reads the last line), a session its markdown. `--json`
 * prints the JSON alone on both. */
export function printDestinations(surface: DestinationSurface, json: boolean): Destination[] {
  if (json) return ["json"];
  return surface === "session" ? ["terminal"] : [...FALLBACK_DESTINATIONS];
}

/** The question an interactive run asks each time: every destination for this
 * run, then each again to keep as this repo's default. Posting also shows the
 * review where the person is, so a post is never the only copy they see. */
export function destinationMenu(
  target: { pr: boolean },
  surface: DestinationSurface = "terminal",
): DestinationMenuItem[] {
  const choices = destinationChoices(target, surface);
  const dests = (c: DestinationChoice): Destination[] =>
    c.value === "pr" ? ["pr", "terminal"] : [c.value];
  return [
    ...choices.map((c) => ({ label: c.label, pick: { destinations: dests(c), remember: false } })),
    ...choices.map((c) => ({
      label: `${c.label}, and always do this in this repo`,
      pick: { destinations: dests(c), remember: true },
    })),
  ];
}

/** How a run's destinations are settled, before it starts. */
export type DestinationPlan =
  | {
      kind: "fixed";
      destinations: Destination[];
      /** flags: `--to`/`--json`/`--out`; saved: the repo's default; print:
       * nobody to ask. */
      source: "flags" | "saved" | "print";
    }
  | { kind: "ask"; menu: DestinationMenuItem[] };

/**
 * The destination rule (this file's header), shared by every surface. A saved
 * default that posts does not apply to a target with no PR; what is left of
 * it does, and an empty remainder is no default.
 */
export function planDestinations(o: {
  /** What the flags asked for (`--to`, `--out` as "file"); empty: nothing. */
  explicit: readonly Destination[];
  /** `--json`: the result is printed as JSON, nothing is asked. */
  json: boolean;
  /** Somebody can be asked (a TTY, a pi session with dialogs). */
  interactive: boolean;
  /** The repo's saved default (`loadDefaultDestinationsIn`), or null. */
  saved: readonly Destination[] | null;
  target: { pr: boolean };
  surface: DestinationSurface;
}): DestinationPlan {
  const explicit = [...(o.json ? (["json"] as const) : []), ...o.explicit].filter(
    (d, i, a) => a.indexOf(d) === i,
  );
  if (explicit.length > 0) return { kind: "fixed", destinations: explicit, source: "flags" };
  const saved = (o.saved ?? []).filter((d) => o.target.pr || d !== "pr");
  if (saved.length > 0) return { kind: "fixed", destinations: saved, source: "saved" };
  if (o.interactive) return { kind: "ask", menu: destinationMenu(o.target, o.surface) };
  return { kind: "fixed", destinations: printDestinations(o.surface, false), source: "print" };
}

/** `terminal,json` → the list; throws on a word that is not a destination. */
export function parseDestinations(spec: string): Destination[] {
  const out: Destination[] = [];
  for (const w of spec.split(",").map((s) => s.trim())) {
    if (!(DESTINATIONS as readonly string[]).includes(w))
      throw new Error(`unknown destination ${w || "(empty)"}: use ${DESTINATIONS.join(", ")}`);
    if (!out.includes(w as Destination)) out.push(w as Destination);
  }
  return out;
}

/** The repo's saved destinations under the review home `home`; null when none
 * are saved, or when there is no home (nothing is remembered). */
export function loadDefaultDestinationsIn(home: string | null, cwd: string): Destination[] | null {
  const path = home === null ? null : (openReviewStoreIn(home, cwd)?.destinationPath() ?? null);
  if (path === null || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { destinations?: unknown };
    if (!Array.isArray(raw.destinations)) return null;
    const ok = raw.destinations.filter((d): d is Destination =>
      (DESTINATIONS as readonly unknown[]).includes(d),
    );
    return ok.length > 0 ? ok : null;
  } catch {
    return null;
  }
}

/** Keep the choice for this repo under the review home `home`. False when
 * `cwd` is not in a git repo, or there is no home. */
export function saveDefaultDestinationsIn(
  home: string | null,
  cwd: string,
  d: readonly Destination[],
): boolean {
  const path = home === null ? null : (openReviewStoreIn(home, cwd)?.destinationPath() ?? null);
  if (path === null) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ destinations: d }, null, 2) + "\n");
  return true;
}

/** The markdown report: the same findings the JSON carries, worst first. One
 * bullet per finding. */
export function renderMarkdown(
  meta: { title: string; verdict: string | null; notes: readonly string[] },
  groups: Record<string, TerminalFinding[]>,
): string {
  const count = Object.values(groups).reduce((n, l) => n + l.length, 0);
  const out = [`# ${meta.title}`, ""];
  if (meta.verdict) out.push(`Verdict: ${meta.verdict}`, "");
  out.push(count > 0 ? `${count} finding${count === 1 ? "" : "s"}.` : "No findings.", "");
  for (const [sev, list] of Object.entries(groups)) {
    out.push(`## ${sev} (${list.length})`, "");
    for (const f of list) {
      const where = f.path
        ? `\`${f.path}${f.line !== null ? `:${f.line}` : ""}\``
        : "(no location)";
      out.push(`- ${where} — ${f.title}${f.lens ? ` _(${f.lens})_` : ""}`);
    }
    out.push("");
  }
  for (const n of meta.notes) out.push(`> ${n}`);
  return out.join("\n").trimEnd() + "\n";
}
