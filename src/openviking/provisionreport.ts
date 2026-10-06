// The boot provisioning report, read by the daemon (S1).
//
// `scripts/openviking-provision.mjs` runs in the entrypoint BEFORE the daemon
// exists, and until it said what it found only in the boot log: a
// reviewer key that does not authenticate, a user it could not create, a user
// it had to CREATE (which means the server lost it — the key the server minted
// for the new user is discarded, by design, so every distributed copy of the
// old key is now wrong). Nobody reads a boot log. The script now writes
// `state/openviking/provision.json`; the daemon reads it once at boot, puts it
// in status.json `memory.provision`, and wakes `memory_provision_failed` when
// it says anything is wrong. The "never mint, never rotate" rule is unchanged:
// a recreated user is SURFACED, loudly, never repaired here.
//
// The report carries no key — the script never writes one anywhere.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_WAKE, type ProvisionSummary } from "../memory/health.js";

/** Where the script writes its report, relative to the sandbox root (the
 * script resolves the same path from its own location — see
 * `provisionReportPath` in `scripts/openviking-provision.mjs`). */
export function provisionReportPath(root: string): string {
  return join(root, "state", "openviking", "provision.json");
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** A file that could not be READ still has an identity: what stat says, or
 * the error itself — so the once-per-report mark holds for it too. */
function unreadIdentity(path: string, err: unknown): string {
  try {
    const st = statSync(path);
    return `stat:${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return `error:${(err as NodeJS.ErrnoException).code ?? "unknown"}`;
  }
}

/** Read and classify the report. Total: a missing file is `absent`, a file
 * that is not a report is `unreadable` — never a throw, never "ok". Every
 * report that exists carries an `id` (a fingerprint of its bytes), which is
 * what makes the wake fire ONCE per report — a file with no parseable `at`
 * included, which would otherwise wake again on every daemon restart. */
export function readProvisionReport(path: string): ProvisionSummary {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : {
          state: "unreadable",
          id: unreadIdentity(path, err),
          errors: [String((err as Error).message ?? err)],
        };
  }
  const id = `sha256:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}`;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch (err) {
    return { state: "unreadable", id, errors: [`provision.json is not a report: ${String(err)}`] };
  }
  if (typeof body["ok"] !== "boolean") {
    return { state: "unreadable", id, errors: ["provision.json carries no ok verdict"] };
  }
  return {
    state: body["ok"] === true ? "ok" : "failed",
    id,
    ...(typeof body["at"] === "string" ? { at: body["at"] } : {}),
    created: strings(body["created"]),
    failed: strings(body["failed"]),
    ...(typeof body["reviewer"] === "string" ? { reviewer: body["reviewer"] } : {}),
    errors: strings(body["errors"]),
  };
}

/**
 * The wake a report calls for, or null. Wakes on a failed report, an
 * unreadable one, and — even when the report says ok — on any user the boot
 * had to CREATE: on a running install a user only goes missing when the store
 * lost it, and the server's fresh key for it was discarded (never replace a
 * distributed key), so whoever holds the old key is now locked out.
 */
export function provisionWake(
  s: ProvisionSummary,
): { kind: string; detail: string; message: string } | null {
  if (s.state === "absent") return null;
  const created = s.created ?? [];
  if (s.state === "ok" && created.length === 0) return null;
  const errors = s.errors ?? [];
  const what =
    s.state === "unreadable"
      ? "the boot provisioning report could not be read"
      : s.state === "failed"
        ? "boot provisioning FAILED"
        : `boot provisioning had to CREATE ${created.join(", ")}`;
  const detail = [
    what,
    ...(created.length > 0 && s.state !== "ok" ? [`created: ${created.join(", ")}`] : []),
    ...((s.failed ?? []).length > 0 ? [`not ensured: ${s.failed!.join(", ")}`] : []),
    ...(s.reviewer && s.reviewer !== "reach" ? [`reviewer key: ${s.reviewer}`] : []),
    ...errors.slice(0, 4),
  ].join("; ");
  return {
    kind: MEMORY_WAKE.provision,
    detail,
    message: [
      `MEMORY PROVISIONING — ${what}${s.at ? ` (report ${s.at})` : ""}.`,
      ...errors.slice(0, 6).map((e) => `  ${e}`),
      ...(created.length > 0
        ? [
            `A user that had to be created (${created.join(", ")}) means the server lost it: the key it minted for the new user was discarded on purpose (keys are never rotated from here), so every distributed copy of the OLD key no longer authenticates. Re-mint and re-distribute through the onboarding memory step (docs/companion-memory-access.md) — on a first install this is expected once.`,
          ]
        : []),
      "Rounds are not blocked; memory degrades until this is fixed. The report rides status.json `memory.provision`.",
    ].join("\n"),
  };
}

/** The event that marks a report as already woken on (its payload's `id`). */
export const PROVISION_WOKEN_EVENT = "memory_provision_woken";

/** The slice of `StateStore` the boot step writes through — structural, so
 * the step is tested against a real `StateStore(":memory:")`. */
export interface ProvisionWakeStore {
  logAnomaly(
    kind: string,
    pr: number | null,
    roundNo: number | null,
    detail: string,
    injectMessage?: string,
  ): void;
  logEvent(kind: string, pr: number | null, payload?: unknown): void;
  lastEventPayload(kind: string): Record<string, unknown> | null;
}

/**
 * The daemon's boot step over this boot's report: raise `memory_provision_failed`
 * through the anomaly funnel when the report calls for it — ONCE per report.
 * The report's `id` is the key (its timestamp is not enough: a file that cannot
 * be parsed has none), recorded in `memory_provision_woken`, so a daemon
 * restart inside the same container never repeats a wake for the same file.
 * Returns whether it woke.
 */
export function raiseProvisionWake(store: ProvisionWakeStore, s: ProvisionSummary): boolean {
  const wake = provisionWake(s);
  if (!wake) return false;
  const key = s.id ?? s.at ?? null;
  if (key !== null && store.lastEventPayload(PROVISION_WOKEN_EVENT)?.["id"] === key) return false;
  store.logAnomaly(wake.kind, null, null, wake.detail, wake.message);
  store.logEvent(PROVISION_WOKEN_EVENT, null, { id: key, at: s.at ?? null, state: s.state });
  return true;
}
