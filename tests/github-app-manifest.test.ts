// The GitHub App manifest ↔ code coherence test.
//
// deploy/github-app-manifest.json is what a new operator registers their App
// from, so it must never drift from what the code actually needs. Same
// discipline as the tests/openviking.test.ts pin mirrors:
//
//   * the manifest's `default_events` must EQUAL the event set the webhook
//     receiver accepts (the `case` labels of interpretEvent in src/webhook.ts,
//     read from the source) — a new subscription cannot land without the
//     manifest following, and a dropped handler cannot leave a stale event;
//   * every event maps to the App permission GitHub requires for delivering
//     it, and the manifest must grant at least read there;
//   * every MutationKind in packages/pi-plugin/src/gate.ts maps to the permission its REST/
//     GraphQL/git path writes through, and the manifest must grant write
//     there — the Record<MutationKind, …> makes a NEW kind a compile error
//     until it is mapped.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_SELF_CONFIG_KINDS,
  MUTATION_KINDS,
  type AppSelfConfigKind,
  type MutationKind,
} from "@quickchatai/pi-quickreview/src/gate.js";
import { parseConfig } from "../src/config.js";
import { DEFAULT_WEBHOOK_PATH } from "../src/webhook.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(resolve(root, "deploy/github-app-manifest.json"), "utf8"),
) as {
  name: string;
  hook_attributes: { url: string; active: boolean };
  default_permissions: Record<string, string>;
  default_events: string[];
};
const webhookSrc = readFileSync(resolve(root, "src/webhook.ts"), "utf8");
// The TRACKED config.example.toml (full-validation-clean per the
// publishability lint). The operator's live config.toml lives in the
// install's config home and is never read by a test.
const cfg = parseConfig(readFileSync(resolve(root, "config.example.toml"), "utf8"));

/** The events src/webhook.ts actually accepts: the `case "<event>"` labels of
 * interpretEvent's switch. The slice ends at the next top-level function so
 * the per-event ACTION switches (case "labeled", …) never leak in. */
function handledWebhookEvents(): string[] {
  const start = webhookSrc.indexOf("export function interpretEvent");
  expect(start).toBeGreaterThan(-1);
  const end = webhookSrc.indexOf("\nfunction ", start);
  expect(end).toBeGreaterThan(start);
  const body = webhookSrc.slice(start, end);
  return [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1] as string);
}

/** GitHub App permission each webhook event requires for delivery. */
const EVENT_PERMISSION: Record<string, string> = {
  pull_request: "pull_requests",
  pull_request_review: "pull_requests",
  pull_request_review_comment: "pull_requests",
  issue_comment: "issues",
  check_suite: "checks",
  workflow_run: "actions",
  push: "contents",
};

/** The permission each gated mutation writes through (src/github.ts REST and
 * GraphQL paths; push_branch is the improvements git push, rule 4's one
 * sanctioned branch family). A new MutationKind fails to compile until it is
 * added here — which is the point. The app-self-config class is
 * excluded by type: those routes are authed by the App JWT and address the
 * App's own configuration, so no installation permission grants them; a new
 * kind still has to be classified one way or the other to compile. */
const KIND_WRITE_PERMISSION: Record<Exclude<MutationKind, AppSelfConfigKind>, string> = {
  add_label: "issues", // POST /issues/{n}/labels
  remove_label: "issues", // DELETE /issues/{n}/labels/{label}
  delete_team_review_request: "pull_requests", // DELETE /pulls/{n}/requested_reviewers
  // Escalation needs no wider App permission: this is a POST on the same
  // route the DELETE above uses, and both are Pull requests: write — which the
  // manifest grants for create_review anyway.
  request_reviewer: "pull_requests", // POST /pulls/{n}/requested_reviewers
  create_review: "pull_requests", // POST /pulls/{n}/reviews
  create_review_comment_reply: "pull_requests", // POST /pulls/{n}/comments/{id}/replies
  resolve_own_review_thread: "pull_requests", // GraphQL resolveReviewThread
  create_issue_comment: "issues", // POST /issues/{n}/comments
  create_issue: "issues", // POST /issues
  create_pull: "pull_requests", // POST /pulls
  push_branch: "contents", // git push origin …:refs/heads/bot/improve-*
  supersede_own_review: "pull_requests", // own-review supersession (owner+state guarded)
};

describe("github-app-manifest ↔ webhook handler", () => {
  it("the manifest's event list EQUALS the handler's accepted event set", () => {
    const handled = handledWebhookEvents();
    // Sanity on the extraction itself: the seven known events, no duplicates.
    expect(handled.length).toBe(new Set(handled).size);
    expect(new Set(handled)).toEqual(
      new Set([
        "pull_request",
        "pull_request_review_comment",
        "issue_comment",
        "pull_request_review",
        "check_suite",
        "workflow_run",
        "push",
      ]),
    );
    expect(new Set(manifest.default_events)).toEqual(new Set(handled));
  });

  it("keeps default_events sorted, so diffs stay one-line", () => {
    expect(manifest.default_events).toEqual([...manifest.default_events].sort());
  });

  it("grants the delivery permission every subscribed event requires", () => {
    for (const event of manifest.default_events) {
      const perm = EVENT_PERMISSION[event];
      expect(
        perm,
        `no known permission mapping for event "${event}" — add it to EVENT_PERMISSION`,
      ).toBeDefined();
      expect(["read", "write"], `event "${event}" needs ${perm}: read`).toContain(
        manifest.default_permissions[perm!],
      );
    }
  });
});

describe("github-app-manifest ↔ mutation gate", () => {
  it("grants write on the permission behind every MutationKind", () => {
    const selfConfig = APP_SELF_CONFIG_KINDS as readonly string[];
    for (const kind of MUTATION_KINDS) {
      if (selfConfig.includes(kind)) continue; // JWT-authed; see below
      const perm = KIND_WRITE_PERMISSION[kind as Exclude<MutationKind, AppSelfConfigKind>];
      expect(
        manifest.default_permissions[perm],
        `kind "${kind}" writes through ${perm} and needs write`,
      ).toBe("write");
    }
  });

  it("the app-self-config class needs NO installation permission — it rides the App JWT", () => {
    // PATCH /app/hook/config is an App-level route: the installation the
    // manifest describes grants nothing there, and nothing extra is asked for.
    for (const kind of APP_SELF_CONFIG_KINDS) {
      expect(Object.keys(KIND_WRITE_PERMISSION)).not.toContain(kind);
    }
    expect(Object.keys(manifest.default_permissions).sort()).not.toContain("app_hook_config");
  });
});

describe("github-app-manifest read surface", () => {
  it("carries the read-only permissions the adapter and scripts consult", () => {
    // GET /commits/{ref}/check-runs — src/github.ts listChecks, scripts/guards.sh guard 4.
    expect(manifest.default_permissions.checks).toBe("read");
    // GET /commits/{ref}/status — the legacy commit-status half of the same CI gate.
    expect(manifest.default_permissions.statuses).toBe("read");
    // workflow_run deliveries (the recheck trigger) require Actions read.
    expect(manifest.default_permissions.actions).toBe("read");
    // Mandatory for every App; also the repo/compare reads.
    expect(manifest.default_permissions.metadata).toBe("read");
  });

  it("grants members read while the review-team trigger is configured", () => {
    // searchTeamTriggered's `team-review-requested:` qualifier, the
    // requested_reviewers team reads/DELETE and the review_requested payload's
    // requested_team all need org team visibility (Organization members read).
    if (cfg.github.review_team) expect(manifest.default_permissions.members).toBe("read");
  });

  it("declares no permission the code has no use for", () => {
    expect(Object.keys(manifest.default_permissions).sort()).toEqual([
      "actions",
      "checks",
      "contents",
      "issues",
      "members",
      "metadata",
      "pull_requests",
      "statuses",
    ]);
  });
});

describe("github-app-manifest webhook endpoint", () => {
  it("points at the /webhook path the server actually serves", () => {
    expect(webhookSrc).toContain("deps.path ?? DEFAULT_WEBHOOK_PATH");
    expect(new URL(manifest.hook_attributes.url).pathname).toBe(DEFAULT_WEBHOOK_PATH);
    expect(manifest.hook_attributes.active).toBe(true);
  });

  it("ships a placeholder host, never a private one", () => {
    expect(manifest.hook_attributes.url).not.toMatch(/quickchat/i);
  });
});
