// The one-shot review's render step: the production review renderer applied to
// the findings record a session wrote.

import {
  postedRenderOptions,
  renderPostedReview,
  type PostedRenderConfig,
} from "../reviewrender.js";

/**
 * The bench's render step (`[review] render_outputs`): the SAME two calls the
 * live route's scripts/render-review.sh makes (src/reviewrendercli.ts
 * renderRound) — `postedRenderOptions(cfg)` then `renderPostedReview` — with
 * the case's outcome as the fallback verdict, summary and lenses line. Pinned
 * equal to the live route by tests/dedup-parity.test.ts.
 */
export function renderBenchOutputs(
  record: unknown,
  outcome: Record<string, unknown> | undefined,
  cfg: PostedRenderConfig,
): ReturnType<typeof renderPostedReview> {
  const passes = Array.isArray(outcome?.["passes"])
    ? (outcome["passes"] as Array<Record<string, unknown>>)
        .map((p) => String(p["name"] ?? ""))
        .filter((n) => n && n !== "pass-validate")
    : [];
  return renderPostedReview(
    record,
    postedRenderOptions(cfg, {
      verdict: typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null,
      summary: typeof outcome?.["summary"] === "string" ? outcome["summary"] : null,
      lensesApplied: passes.length ? passes.join(", ") : null,
    }),
  );
}
