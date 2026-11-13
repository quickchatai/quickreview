// On-demand state-machine review: a maintainer's PR label or
// `@<bot> state-machines` comment, or the operator's
// `qcr review-now <pr> --state-machines`.
//
// It is the security request's machinery (src/securityrequest.ts) under a
// second kind: one row in `pr_review_requests` (kind `state-machines`), with
// its own label (`[state_machines] label`), its own command switch
// (`[state_machines] command`) and its own serving. While the row stands,
// every round of the PR plans the whole state-machine family
// (packages/pi-plugin/src/planner.ts, `PlanSecurityInputs.stateRequest`); a
// request never plans a lens the profile switched off. Who may ask, how a
// request waits for a running round, and what withdraws it are the security
// request's rules, unchanged. A PR may carry both requests at once.
import type { ReviewRequestKind } from "./securityrequest.js";

/** The `pr_review_requests` kind a state-machine request is recorded under. */
export const STATE_REQUEST_KIND = "state-machines";

/** The hidden marker on the acknowledgement, so it reads as the reviewer's
 * own content (packages/pi-plugin/src/identity.ts) on every route. */
export const STATE_ACK_MARKER = "<!-- qcr-state-machines-request -->";

/** The state-machine request, as a `ReviewRequestKind`. The command is
 * `@<bot> state-machines`, and `state-machine`, `state machines` and
 * `statemachines` are read as the same word. */
export const STATE_REQUEST: ReviewRequestKind = {
  kind: STATE_REQUEST_KIND,
  commandWord: "state[- ]?machines?",
  commandName: "state-machines",
  commandKey: "[state_machines] command",
  ackMarker: STATE_ACK_MARKER,
  ackTitle: "State-machine review requested",
  ackBody: "The next review round of this pull request runs the state-machine lenses.",
};
