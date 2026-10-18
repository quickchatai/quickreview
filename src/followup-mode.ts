import { REVIEW_DEFAULTS, type Config } from "./config.js";

/** Production and replay admit delta follow-ups under the same knob/default. */
export function deltaFollowUpEnabled(cfg: Config): boolean {
  return (cfg.review.follow_up ?? REVIEW_DEFAULTS.follow_up) === "delta";
}
