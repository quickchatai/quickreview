// What the plugin shows of a review in a pi session, in a module of its own:
// the custom message type and the post question's answers. A host that only
// shows a review (the app's home) imports this and never the review's
// runtime.

/** The custom message type the review is shown as. */
export const REVIEW_MESSAGE = "qcr-review";

/** The answers the post question offers: No first, as pi's own confirm
 * would start on Yes. */
export const KEEP_IT_HERE = "No, keep it here";
export const postAnswer = (dryRun: boolean): string =>
  dryRun
    ? "Yes, post it (dry run: the review is recorded, not sent)"
    : "Yes, post it as a comment-only review";
