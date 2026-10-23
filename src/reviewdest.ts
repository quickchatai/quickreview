// Where a local review's result goes (`qcr review`): the terminal, a markdown
// file, or JSON back to the agent. The repo's own default is kept in the review
// home (src/reviewstore.ts: shared by its worktrees, never tracked, never
// global); a flag overrides it for one run. Posting to a PR (src/reviewpost.ts) is offered, and
// accepted, only for a target that has a PR.

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

/** The destinations a person can be asked to pick. `pr`: the target is a PR,
 * the only target that can be posted to. */
export function destinationChoices(target: { pr: boolean }): DestinationChoice[] {
  return [
    { value: "terminal", label: "print in the terminal" },
    { value: "file", label: "write a markdown report" },
    { value: "json", label: "JSON for a coding agent" },
    ...(target.pr
      ? [{ value: "pr" as const, label: "post to the PR as a comment-only review" }]
      : []),
  ];
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
