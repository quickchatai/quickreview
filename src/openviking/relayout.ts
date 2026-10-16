// `qcr memory relayout` — the operator's one-off move of a flat store into
// the memory layout (`src/memory/layout.ts`). The plan is `src/memory/relayout.ts`
// (pure); this is the run: one COMPLETE read, the plan printed, and — only
// with `--apply` — the plan carried out through `OpenVikingStore.relocate`
// (one batch-write per directory, hash preconditions, never a delete), then a
// second complete read to show what is left. Never run automatically: the
// daemon has no caller of this module, and the command needs the operator's
// keys file.
import { planRelayout, type RelayoutAction, type RelayoutPlan } from "../memory/relayout.js";
import type { OpenVikingStore, RelocateItem, RelocateReport } from "./store.js";

/** The writes a plan needs: every move, retirement and in-place rewrite. */
export function relocateItemsOf(plan: RelayoutPlan): RelocateItem[] {
  const out: RelocateItem[] = [];
  for (const a of plan.actions) {
    if (a.kind === "move")
      out.push({
        id: a.id,
        expect: a.expect,
        to: a.to,
        text: a.text,
        ...(a.toExpect !== undefined ? { toExpect: a.toExpect } : {}),
      });
    else if (a.kind === "retire" || a.kind === "rewrite")
      out.push({ id: a.id, expect: a.expect, text: a.text });
  }
  return out;
}

/** Writes still owed by a plan (what a finished relayout reads as zero). */
export function pendingWrites(plan: RelayoutPlan): number {
  return relocateItemsOf(plan).length;
}

function actionLine(a: RelayoutAction): string {
  switch (a.kind) {
    case "move":
      return `  move    ${a.id} → ${a.to}   ${a.why}${a.note ? ` — ${a.note}` : ""}`;
    case "retire":
      return `  retire  ${a.id}   ${a.why}`;
    case "rewrite":
      return `  rewrite ${a.id}   ${a.why} (header fixed in place)${a.note ? ` — ${a.note}` : ""}`;
    case "blocked":
      return `  BLOCKED ${a.id} → ${a.to}   ${a.why}`;
    case "stay":
      return `  stay    ${a.id}   ${a.why}`;
    case "skip":
      return `  skip    ${a.id}   ${a.why}`;
  }
}

/** The plan as the operator reads it: every entry, then the totals. */
export function renderRelayoutPlan(plan: RelayoutPlan, root: string): string[] {
  const order: Record<RelayoutAction["kind"], number> = {
    blocked: 0,
    retire: 1,
    move: 2,
    rewrite: 3,
    stay: 4,
    skip: 5,
  };
  const actions = [...plan.actions].sort((a, b) =>
    order[a.kind] !== order[b.kind] ? order[a.kind] - order[b.kind] : a.id < b.id ? -1 : 1,
  );
  const moves = Object.entries(plan.movesTo)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([area, n]) => `${area} ${n}`)
    .join(", ");
  const c = plan.counts;
  return [
    `relayout plan for ${root} (${plan.actions.length} entries read)`,
    ...actions.map(actionLine),
    `summary: move ${c.move}${moves ? ` (${moves})` : ""}, retire ${c.retire}, rewrite ${c.rewrite}, ` +
      `stay ${c.stay}, skip ${c.skip}, blocked ${c.blocked}`,
  ];
}

export interface RelayoutOutcome {
  ok: boolean;
  /** Why nothing was planned (a store that could not be read whole). */
  refused?: string;
  plan?: RelayoutPlan;
  report?: RelocateReport;
  /** The plan of the read AFTER an apply — what is still owed. */
  after?: RelayoutPlan;
}

/** One complete read of the store, or why there is none. */
async function completeRead(
  store: Pick<OpenVikingStore, "invalidate" | "sweep">,
): Promise<{ ok: true; plan: RelayoutPlan } | { ok: false; why: string }> {
  store.invalidate();
  const sweep = await store.sweep();
  if (sweep.unread.length > 0) {
    const more = sweep.unread.length > 3 ? ` (+${sweep.unread.length - 3} more)` : "";
    return {
      ok: false,
      why: `the store could not be read whole — ${sweep.unread.slice(0, 3).join("; ")}${more}`,
    };
  }
  return { ok: true, plan: planRelayout({ entries: sweep.entries, retired: sweep.retired }) };
}

/**
 * Plan — and with `apply`, carry out — the relayout of one namespace.
 * Refuses to plan over a partial read: an adjudication it did not see would
 * leave a superseded note live, and a destination it did not see could be
 * written over. Total: every failure is in the outcome and the log, never a
 * throw.
 */
export async function runRelayout(
  store: Pick<OpenVikingStore, "invalidate" | "sweep" | "relocate" | "uriOf">,
  opts: { apply: boolean; log: (line: string) => void },
): Promise<RelayoutOutcome> {
  const root = store.uriOf("").replace(/\/+$/, "");
  const first = await completeRead(store);
  if (!first.ok) {
    opts.log(`relayout refused: ${first.why}. Nothing was planned or written.`);
    return { ok: false, refused: first.why };
  }
  for (const line of renderRelayoutPlan(first.plan, root)) opts.log(line);
  const items = relocateItemsOf(first.plan);
  // A BLOCKED move is owed work no re-run will do: the store is not laid out
  // while one stands, and no outcome may say it is.
  const blockedFirst = blockedNote(first.plan);
  if (!opts.apply) {
    opts.log(
      items.length === 0
        ? (blockedFirst ?? "nothing to do — the store is already laid out.")
        : `plan only — ${items.length} write(s)${blockedFirst ? `; ${blockedFirst}` : ""}. Re-run with --apply to carry it out.`,
    );
    return { ok: first.plan.counts.blocked === 0, plan: first.plan };
  }
  if (items.length === 0) {
    opts.log(blockedFirst ?? "nothing to do — the store is already laid out.");
    return { ok: first.plan.counts.blocked === 0, plan: first.plan, after: first.plan };
  }
  const report = await store.relocate(items);
  for (const b of report.batches)
    opts.log(`  batch ${b.ok ? "ok    " : "FAILED"} ${b.root} (${b.ops} op(s)): ${b.message}`);
  const failed = report.results.filter((r) => !r.ok);
  for (const r of failed) opts.log(`  not done: ${r.id}${r.to ? ` → ${r.to}` : ""} — ${r.message}`);
  const applied = `applied ${report.results.length - failed.length}/${report.results.length}`;
  const second = await completeRead(store);
  if (!second.ok) {
    opts.log(`${applied}; the re-read failed: ${second.why}`);
    return { ok: false, plan: first.plan, report };
  }
  const left = pendingWrites(second.plan);
  const blocked = second.plan.counts.blocked;
  for (const a of second.plan.actions) if (a.kind === "blocked") opts.log(actionLine(a));
  const blockedAfter = blockedNote(second.plan);
  opts.log(
    left === 0 && failed.length === 0 && blocked === 0
      ? `done — ${report.results.length} write(s) applied; the store is laid out (a re-run plans nothing).`
      : [
          applied,
          ...(left > 0 ? [`${left} write(s) still owed — re-run --apply`] : []),
          ...(blockedAfter ? [blockedAfter] : []),
          ...(left === 0 && blocked === 0 ? ["a re-read plans nothing more"] : []),
        ].join("; ") + ".",
  );
  return {
    ok: left === 0 && failed.length === 0 && blocked === 0,
    plan: first.plan,
    report,
    after: second.plan,
  };
}

/** The operator's sentence for a plan's blocked moves, or null when none. */
function blockedNote(plan: RelayoutPlan): string | null {
  const n = plan.counts.blocked;
  return n === 0
    ? null
    : `${n} move(s) BLOCKED (listed above) — the store is NOT laid out until each is resolved by hand`;
}
