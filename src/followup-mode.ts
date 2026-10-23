import { REVIEW_DEFAULTS, type CoreConfig } from "./reviewconfig.js";

/** Production and replay admit delta follow-ups under the same knob/default. */
export function deltaFollowUpEnabled(cfg: Pick<CoreConfig, "review">): boolean {
  return (cfg.review.follow_up ?? REVIEW_DEFAULTS.follow_up) === "delta";
}
