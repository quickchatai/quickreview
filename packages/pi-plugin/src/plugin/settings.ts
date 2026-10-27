// The person's own QuickReview defaults, read from pi's settings (the
// `quickreview` key of pi's settings.json, global and project merged as pi
// merges them). Per-repo rules live in the repo's profile; the plugin reads
// no app config for these.
//
//   {
//     "quickreview": {
//       "posting": "ask",     // after a PR review: "ask" (the default),
//                             // "never" or "always"
//       "preset": "quick"     // the preset a bare /qcr-review runs under
//     }
//   }
import { isPresetName, REVIEW_PRESET_NAMES, type ReviewPresetName } from "./args.js";

/** What happens after a PR review: ask (No offered first), never post, or
 * always post. A post is one comment-only review through the gate. */
export type PostingRule = "ask" | "never" | "always";

export const POSTING_RULES: readonly PostingRule[] = ["ask", "never", "always"];

export interface QuickReviewSettings {
  posting: PostingRule;
  preset: ReviewPresetName | null;
}

export const DEFAULT_SETTINGS: QuickReviewSettings = { posting: "ask", preset: null };

/** The `quickreview` key of pi's settings, as the plugin's settings. A value
 * it does not know keeps the default and says so; nothing is ever posted on
 * a misspelling. */
export function readQuickReviewSettings(all: unknown): {
  settings: QuickReviewSettings;
  warnings: string[];
} {
  const warnings: string[] = [];
  const raw =
    typeof all === "object" && all !== null
      ? (all as Record<string, unknown>)["quickreview"]
      : undefined;
  if (raw === undefined) return { settings: { ...DEFAULT_SETTINGS }, warnings };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return {
      settings: { ...DEFAULT_SETTINGS },
      warnings: ['pi settings: "quickreview" is not an object; the defaults stand'],
    };
  const r = raw as Record<string, unknown>;
  const settings: QuickReviewSettings = { ...DEFAULT_SETTINGS };
  if (r["posting"] !== undefined) {
    if ((POSTING_RULES as readonly unknown[]).includes(r["posting"]))
      settings.posting = r["posting"] as PostingRule;
    else
      warnings.push(
        `pi settings: quickreview.posting is ${JSON.stringify(r["posting"])}, not one of ${POSTING_RULES.join(", ")}; it stays "ask"`,
      );
  }
  if (r["preset"] !== undefined) {
    if (typeof r["preset"] === "string" && isPresetName(r["preset"])) settings.preset = r["preset"];
    else
      warnings.push(
        `pi settings: quickreview.preset is ${JSON.stringify(r["preset"])}, not one of ${REVIEW_PRESET_NAMES.join(", ")}; no preset applies`,
      );
  }
  return { settings, warnings };
}
