// The unit cut, rendered: the saved cut, a draft and the cut's status, worded
// for the setup belt's tools or the `qcr scan units` / `/qcr-scan units` verbs.
import { displayRoot } from "./facts.js";
import type { CutStatus, CutView } from "./unitcutstore.js";

export function renderCut(title: string, v: CutView): string {
  const rows = v.units.map((u) => {
    const split =
      u.cases === null
        ? " — case coverage UNKNOWN"
        : u.cases.length > 1
          ? ` — split into ${u.cases.length} cases (${u.cases.map((c) => `${c.id}: ${c.files}f/${c.lines}l`).join(", ")})`
          : "";
    const over = u.cases?.some((c) => c.over_budget)
      ? " [a file alone exceeds one case — a scan reads it in line ranges]"
      : "";
    return `  - ${u.name} [${u.kind}] ${u.roots.map(displayRoot).join(", ")}: ${u.files ?? "UNKNOWN"} files, ${u.reviewable ?? "UNKNOWN"} reviewable, ${u.lines ?? "UNKNOWN"} lines${split}${over}${u.note ? ` — ${u.note}` : ""}`;
  });
  const lines = [`${title}:`, ...rows];
  if (v.ignored.length > 0)
    lines.push(`  ignored: ${v.ignored.join(", ")} (${v.ignored_files ?? "UNKNOWN"} files)`);
  for (const e of v.errors) lines.push(`  ✗ ${e}`);
  for (const b of v.blocking_save) lines.push(`  ! ${b}`);
  return lines.join("\n");
}

/** How a rendering names the save that makes a draft the cut — the tool, or
 * the `qcr scan units` verb. */
export interface CutVerbs {
  save: string;
}
export const CUT_TOOL_VERBS: CutVerbs = { save: "setup_unit_cut_save" };
export const CUT_CLI_VERBS: CutVerbs = { save: "qcr scan units save" };

/** A stored or adjusted draft, and that it is not in use until saved. */
export function renderDraft(
  title: string,
  draft: CutView,
  verbs: CutVerbs = CUT_TOOL_VERBS,
): string {
  return `${renderCut(title, draft)}\n\nNot in use until ${verbs.save}.`;
}

export function renderStatus(s: CutStatus): string {
  const out: string[] = [];
  for (const p of s.problems) out.push(`✗ ${p}`);
  if (s.saved) {
    const stale =
      s.saved.blocking_save.length > 0 ? " — STALE against the repo now, see the ! lines" : "";
    out.push(
      renderCut(
        `Saved unit cut (saved ${s.saved.saved_at}${s.saved.head ? ` at ${s.saved.head.slice(0, 12)}` : ""})${stale}`,
        s.saved,
      ),
    );
  } else if (s.cut_file_unreadable) {
    out.push(
      "Saved unit cut: UNKNOWN — the cut file could not be read (see above); nothing will overwrite it.",
    );
  } else {
    out.push("No saved unit cut yet.");
  }
  if (s.draft)
    out.push(
      renderCut(
        `Draft (${s.draft.source}, updated ${s.draft.updated_at}) — not in use until saved`,
        s.draft,
      ),
    );
  if (s.has_previous)
    out.push("The cut before the saved one is kept as `previous` in the state home.");
  return out.join("\n\n");
}
