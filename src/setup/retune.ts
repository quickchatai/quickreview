// The post-scan re-tune: after a scan the companion applies profile changes
// itself and reports what changed and why. It changes the profile through the SAME
// tool the interview does (tuning.ts `profileApply` — the priority table,
// the companion's emphasis, a drafted style guide; staged, checked with the
// daemon's own loaders, written into the config home, a commit asked for),
// and adds three things a re-tune owes the operator:
//
//   * it FOLLOWS A SCAN. There must be a finished scan run (the latest, or
//     the one named) and a finished setup interview on record — a re-tune
//     adjusts what setup wrote, from what the scan found; it is not a second
//     way to set a profile up.
//   * EVERY CHANGE HAS A REASON. Each priority, emphasis or guide that moves
//     needs the companion's `why`, and a reason for something that does not
//     move is refused — the report can never say more, or less, than
//     happened. What each change moved in the RESOLVED profile (before vs
//     after, through the extends chain) is computed here, never asserted.
//   * IT IS RECORDED. A write appends the report to `<state home>/setup/
//     retunes.json` (retunelog.ts) and refreshes the portrait facts, so the
//     next re-tune reads what this scan found; the deploy tab reads the log
//     to say which re-tune is "profile changed, not deployed". A re-tune
//     reaches PR reviews ONLY on the operator's deploy — nothing here ships.
//
// A preview (the default) writes nothing, the log included.
import { PROFILES_DIR } from "../install.js";
import { STYLE_LENS } from "../lenstuning.js";
import type { Refusal } from "./engine.js";
import { CONCERNS, parsePriorities, TABLE_KEYS, unansweredConcerns } from "./interview.js";
import { checkProfile, DRAFTED_GUIDE_FILE, readProfileFile, writeTarget } from "./profile.js";
import {
  RETUNES_FILE,
  RETUNES_KEPT,
  RETUNES_VERSION,
  parseRetunes,
  type RetuneChange,
  type RetuneRecord,
} from "./retunelog.js";
import { finishedRuns } from "./scanrun.js";
import {
  draftedGuideBytes,
  parseEmphasis,
  profileApply,
  readRecord,
  recoverProfileWrite,
  type ApplyResult,
  type TuningDeps,
} from "./tuning.js";

export const RETUNE_REASON_MAX = 500;
/** The reason key for a drafted style guide's change. */
export const GUIDE_REASON = "style_guide";

export interface RetuneInput {
  /** The finished scan run it follows; the latest when omitted. */
  scan?: unknown;
  priorities?: unknown;
  emphasis?: unknown;
  style_guide?: unknown;
  drop_style_guide?: unknown;
  /** {concern | lens | "style_guide": why} — one per change, none spare. */
  reasons?: unknown;
  write?: unknown;
}

export interface RetuneDeps extends TuningDeps {
  /** Re-assemble the portrait facts (engine.portraitAssemble) after a write. */
  refreshPortrait: () => { ok: true; key: string } | Refusal;
}

export interface RetuneResult {
  ok: true;
  written: boolean;
  profile: string;
  scan: RetuneRecord["scan"];
  changes: RetuneChange[];
  diff: ApplyResult["diff"];
  commit: { id: string } | null;
  /** The record appended to the log (a write that moved a file or not). */
  record: RetuneRecord | null;
  /** What the live config names ("" = none) — a profile it does not name is
   * not what PR rounds use, deployed or not. */
  config_names: string | null;
}

const show = (v: unknown): string =>
  v === undefined || v === null || v === ""
    ? "(unset)"
    : typeof v === "string"
      ? v
      : JSON.stringify(v);

/** One lens's resolved keys before vs after, as effect lines. */
function lensEffects(
  lens: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const out: string[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    const text = (v: unknown): string =>
      k === "emphasis" && typeof v === "string"
        ? JSON.stringify(v.length > 60 ? `${v.slice(0, 59)}…` : v)
        : show(v);
    out.push(`${lens}: ${k} ${text(before[k])} → ${text(after[k])}`);
  }
  return out;
}

/**
 * Preview or write a post-scan re-tune. Refused when: there is no config
 * home, no finished scan run (or the named one is not one), no finished
 * setup interview on record, the profile does not load now, nothing given
 * would change, a change has no reason, or a reason names no change — and
 * whatever `profileApply` refuses.
 */
export function retune(deps: RetuneDeps, input: RetuneInput): RetuneResult | Refusal {
  if (!deps.profiles)
    return { ok: false, errors: ["this assembly has no config home to write profiles to"] };
  const recovered = recoverProfileWrite(deps, input.write === true);
  if (!recovered.ok) return recovered;
  if (recovered.recovered) {
    const portrait = deps.refreshPortrait();
    const saved = parseRetunes(deps.state.read(RETUNES_FILE));
    if (saved.state === "ok") {
      const last = saved.retunes.at(-1);
      if (
        last?.portrait &&
        "error" in last.portrait &&
        last.portrait.error === "portrait refresh pending"
      ) {
        last.portrait = portrait.ok ? { key: portrait.key } : { error: portrait.errors.join("; ") };
        deps.state.write(
          RETUNES_FILE,
          `${JSON.stringify({ version: RETUNES_VERSION, retunes: saved.retunes }, null, 2)}\n`,
        );
      }
    }
  }
  const runs = finishedRuns(deps.state);
  if (runs.error !== null) return { ok: false, errors: [runs.error] };
  if (runs.runs.length === 0)
    return {
      ok: false,
      errors: ["no finished scan run yet — a re-tune follows a scan; run one first"],
    };
  const wanted = typeof input.scan === "string" ? input.scan.trim() : "";
  const run = wanted === "" ? runs.runs[0]! : runs.runs.find((r) => r.id === wanted);
  if (!run)
    return {
      ok: false,
      errors: [
        `${JSON.stringify(wanted)} is not a finished scan run (latest: ${runs.runs[0]!.id})`,
      ],
    };

  const rec = readRecord(deps.state);
  if (rec.state === "unreadable") return { ok: false, errors: [rec.error] };
  if (
    rec.state === "absent" ||
    rec.record.goals === null ||
    unansweredConcerns(rec.record.priorities).length > 0
  ) {
    return {
      ok: false,
      errors: [
        "no finished setup interview on record — a re-tune adjusts the profile setup wrote; run setup (the `setup` skill) first",
      ],
    };
  }
  const record = rec.record;
  const profile = record.profile;
  const before = checkProfile(deps.profiles, profile);
  if (!before.ok) {
    return {
      ok: false,
      errors: [
        `profile "${profile}" does not load now — fix it first (setup_profile_validate says why):`,
        ...before.errors,
      ],
    };
  }

  const pr = parsePriorities(input.priorities);
  if (!pr.ok) return pr;
  const em = parseEmphasis(input.emphasis);
  if (!em.ok) return em;
  const guide = input.drop_style_guide === true ? null : input.style_guide;

  // What would actually move — each a change that needs a reason.
  const changes: Array<Omit<RetuneChange, "why" | "effects"> & { key: string }> = [];
  for (const [concern, p] of Object.entries(pr.priorities)) {
    if (record.priorities[concern] !== p)
      changes.push({
        key: concern,
        input: `priority ${concern}`,
        from: record.priorities[concern] ?? "(unset)",
        to: p,
      });
  }
  for (const [lens, text] of Object.entries(em.emphasis)) {
    const was = before.summary.lenses[lens]?.emphasis;
    if ((was ?? null) !== text)
      changes.push({ key: lens, input: `emphasis ${lens}`, from: show(was), to: show(text) });
  }
  if (guide !== undefined) {
    const where = writeTarget(deps.profiles, profile);
    let current = "";
    try {
      current = where.ok ? readProfileFile(where.dir, DRAFTED_GUIDE_FILE) : "";
    } catch {
      current = "";
    }
    const currentGuide = before.summary.lenses[STYLE_LENS]?.guide;
    const pointed = currentGuide === DRAFTED_GUIDE_FILE;
    const hasGuide = typeof currentGuide === "string" && currentGuide !== "";
    if (
      guide === null
        ? hasGuide
        : typeof guide !== "string" || !pointed || current !== draftedGuideBytes(guide)
    ) {
      changes.push({
        key: GUIDE_REASON,
        input: "style guide",
        from: pointed
          ? "the drafted guide"
          : hasGuide
            ? `the guide ${currentGuide}`
            : "(none drafted)",
        to:
          guide === null
            ? "(none drafted)"
            : pointed
              ? "a revised drafted guide"
              : "a drafted guide",
      });
    }
  }
  if (changes.length === 0) {
    return {
      ok: false,
      errors: ["nothing to re-tune — every value given is what the profile already says"],
    };
  }

  // Every change has its reason, and every reason its change.
  const reasons = (
    typeof input.reasons === "object" && input.reasons !== null && !Array.isArray(input.reasons)
      ? input.reasons
      : {}
  ) as Record<string, unknown>;
  const errors: string[] = [];
  const why = new Map<string, string>();
  for (const c of changes) {
    const r = reasons[c.key];
    if (typeof r !== "string" || r.trim() === "")
      errors.push(
        `no reason for ${c.input} (${c.from} → ${c.to}) — give \`reasons.${c.key}\`: what the scan found that calls for it`,
      );
    else if (r.length > RETUNE_REASON_MAX)
      errors.push(`the reason for ${c.input} is over ${RETUNE_REASON_MAX} characters`);
    else why.set(c.key, r.replace(/\s+/g, " ").trim());
  }
  for (const k of Object.keys(reasons)) {
    if (!changes.some((c) => c.key === k))
      errors.push(
        `a reason for "${k}", but nothing about it changes — the report says only what happened`,
      );
  }
  if (errors.length > 0) return { ok: false, errors };

  const write = input.write === true;
  // The log is read BEFORE anything is written: one this version cannot read
  // refuses the write rather than being replaced.
  let prior: RetuneRecord[] = [];
  if (write) {
    let log;
    try {
      log = parseRetunes(deps.state.read(RETUNES_FILE));
    } catch (err) {
      log = {
        state: "unreadable" as const,
        error: `${RETUNES_FILE} cannot be read: ${String(err)}`,
      };
    }
    if (log.state === "unreadable")
      return {
        ok: false,
        errors: [`${log.error} — nothing was written; move it aside to re-tune`],
      };
    if (log.state === "ok") prior = log.retunes;
  }
  const applyInput = {
    profile,
    priorities: pr.priorities,
    emphasis: em.emphasis,
    ...(guide !== undefined ? { style_guide: guide } : {}),
  };
  // Only the lenses a CHANGED priority names are re-decided: the recorded
  // answers are re-applied to nothing else, so an operator's direct edit of
  // another lens's setting is neither reset nor left out of the report.
  const decide = new Set(
    changes
      .filter((c) => c.input.startsWith("priority "))
      .flatMap((c) => CONCERNS.find((x) => x.name === c.key)?.lenses ?? []),
  );
  const opts = {
    message: `qcr setup: re-tune profile ${profile} after scan ${run.id} (${changes.map((c) => `${c.input} ${c.to}`).join(", ")})`,
    decide,
  };
  // Staged first, whatever `write` says: an emphasis "removed" that the
  // profile only INHERITS (from its base) stays resolved after the write, so
  // the report would claim a change that never happened. Refused before
  // anything lands.
  const staged = profileApply(deps, { ...applyInput, write: false }, opts);
  if (!staged.ok) return staged;
  // The same holds for dropping a drafted guide the profile inherits: the
  // child's own key goes, the base's guide still resolves.
  const phantom = changes.filter(
    (c) =>
      (c.input.startsWith("emphasis ") &&
        lensEffects(c.key, before.summary.lenses[c.key] ?? {}, staged.summary.lenses[c.key] ?? {}, [
          "emphasis",
        ]).length === 0) ||
      (c.key === GUIDE_REASON &&
        guide === null &&
        staged.summary.lenses[STYLE_LENS]?.guide === before.summary.lenses[STYLE_LENS]?.guide),
  );
  if (phantom.length > 0) {
    return {
      ok: false,
      errors: phantom.map((c) =>
        c.key === GUIDE_REASON
          ? `${c.input}: ${c.from} → ${c.to} would not change what the reviewer resolves — that guide is inherited from the profile's base, which a re-tune does not edit; give a replacement guide instead`
          : `${c.input}: ${c.from} → ${c.to} would not change what the reviewer resolves — that emphasis is inherited from the profile's base, which a re-tune does not edit; give replacement text instead`,
      ),
    };
  }
  // What each validated change moves in the resolved profile.
  const after = staged.summary.lenses;
  const lenses = [
    ...new Set([...Object.keys(before.summary.lenses), ...Object.keys(after)]),
  ].sort();
  const report: RetuneChange[] = changes.map((c) => {
    let effects: string[] = [];
    if (c.input.startsWith("priority ")) {
      const named = CONCERNS.find((x) => x.name === c.key)?.lenses ?? [];
      effects = lenses
        .filter((l) => named.includes(l))
        .flatMap((l) => lensEffects(l, before.summary.lenses[l] ?? {}, after[l] ?? {}, TABLE_KEYS));
    } else if (c.input.startsWith("emphasis ")) {
      effects = lensEffects(c.key, before.summary.lenses[c.key] ?? {}, after[c.key] ?? {}, [
        "emphasis",
      ]);
    } else {
      effects = lensEffects(
        STYLE_LENS,
        before.summary.lenses[STYLE_LENS] ?? {},
        after[STYLE_LENS] ?? {},
        ["guide"],
      );
      const guideDiff = staged.diff.find((d) => d.file === DRAFTED_GUIDE_FILE);
      if (guideDiff)
        effects.push(
          `${STYLE_LENS}: ${DRAFTED_GUIDE_FILE} ${guideDiff.lines.length} line(s) changed`,
        );
    }
    return { input: c.input, from: c.from, to: c.to, why: why.get(c.key)!, effects };
  });

  const scan = { run: run.id, sha: run.sha, mode: run.mode };
  let entry: RetuneRecord | null = null;
  const stateWrites = (commit: { id: string } | null): Record<string, string> => {
    const at = deps.clock().toISOString();
    entry = {
      id: `retune-${at.replace(/[-:.]/g, "")}`,
      at,
      profile,
      scan,
      changes: report,
      files: staged.diff.map((d) => `${PROFILES_DIR}/${profile}/${d.file}`),
      commit: commit?.id ?? null,
      portrait: { error: "portrait refresh pending" },
    };
    return {
      [RETUNES_FILE]: `${JSON.stringify({ version: RETUNES_VERSION, retunes: [...prior, entry].slice(-RETUNES_KEPT) }, null, 2)}\n`,
    };
  };
  const applied = write
    ? profileApply(deps, { ...applyInput, write: true }, { ...opts, stateWrites })
    : staged;
  if (!applied.ok) return applied;
  if (write && entry !== null) {
    const portrait = deps.refreshPortrait();
    // The report itself is already durable; refreshing this ancillary field
    // can fail without losing what changed or why.
    const recorded = entry as RetuneRecord;
    recorded.portrait = portrait.ok ? { key: portrait.key } : { error: portrait.errors.join("; ") };
    deps.state.write(
      RETUNES_FILE,
      `${JSON.stringify({ version: RETUNES_VERSION, retunes: [...prior, recorded].slice(-RETUNES_KEPT) }, null, 2)}\n`,
    );
  }
  return {
    ok: true,
    written: applied.written,
    profile,
    scan,
    changes: report,
    diff: applied.diff,
    commit: applied.commit,
    record: entry,
    config_names: applied.config_names,
  };
}
