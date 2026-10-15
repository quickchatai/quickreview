// Deferred posting: a review POST GitHub answers 5xx is either confirmed from
// the marker GitHub already holds, or handed to the daemon as a `deferred`
// receipt beside an outbox job with the exact payload — and the script exits 0.
// Part of the guards-shell suite: the real session posting scripts, here in
// LIVE mode, against the rig's loopback stub, whose every POST answers 500.
// The token comes from a pre-seeded mint-token cache; nothing leaves the host.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { HEAD, exec, root, useGuardsShellRig } from "./helpers/guards-shell-rig.js";

const s = useGuardsShellRig();

function goLive(): Record<string, string> {
  const cfg = readFileSync(join(s.dir, "config.toml"), "utf8").replace(
    "dry_run = true",
    "dry_run = false",
  );
  writeFileSync(join(s.dir, "config.toml"), cfg);
  writeFileSync(join(s.dir, "secrets", "app_id"), "4242\n");
  writeFileSync(join(s.dir, "secrets", "app.pem"), "not a key — the cached token is used\n");
  const runtime = join(s.dir, "runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(
    join(runtime, "quickreview-token-4242.json"),
    JSON.stringify({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }),
  );
  return {
    XDG_RUNTIME_DIR: runtime,
    QCR_EXPECTED_HEAD: HEAD,
    QCR_ROUND_NO: "3",
    QCR_POSTING_RECEIPT_DIR: join(s.dir, "receipts"),
  };
}

const key = `v1:5180:3:${HEAD}`;
const receipt = () =>
  JSON.parse(readFileSync(join(s.dir, "receipts", "pr-5180-round-3.json"), "utf8"));
const job = () =>
  JSON.parse(readFileSync(join(s.dir, "receipts", "pr-5180-round-3.outbox.json"), "utf8"));

function landed(state: string): void {
  (s.reviews as unknown[]).push({
    id: 9001,
    user: { login: "example-review[bot]" },
    state,
    commit_id: HEAD,
    body: `Automated review body.\n\n<!-- qcr-post:${key} -->`,
    submitted_at: "2026-10-15T10:00:00Z",
  });
}

describe("a review POST GitHub answers 5xx", () => {
  it.each([
    ["post-review.sh", ["5180", "REQUEST_CHANGES"], "CHANGES_REQUESTED", "REQUEST_CHANGES"],
    ["approve-pr.sh", ["5180"], "APPROVED", "APPROVE"],
  ] as const)(
    "%s: the marker is on GitHub → the receipt is confirmed from it",
    async (script, args, ghState, event) => {
      const env = goLive();
      landed(ghState);
      const res = await s.run(script, [...args, s.bodyFile()], env);
      // approve-pr.sh then clears triggers, which the stub refuses (500):
      // the receipt is what this case is about.
      if (script === "post-review.sh") expect(res.ok).toBe(true);
      expect(res.out).toMatch(/the (review|approval) landed \(marker found\)/);
      expect(receipt()).toMatchObject({
        status: "confirmed",
        posting_key: key,
        gh_review_id: 9001,
        actual_event: event,
      });
    },
  );

  it.each([
    ["post-review.sh", ["5180", "REQUEST_CHANGES"], "REQUEST_CHANGES"],
    ["approve-pr.sh", ["5180"], "APPROVE"],
  ] as const)(
    "%s: no marker → a deferred handoff with the exact payload, exit 0",
    async (script, args, event) => {
      const env = goLive();
      const res = await s.run(script, [...args, s.bodyFile()], env);
      expect(res.ok).toBe(true);
      expect(res.out).toContain("posting deferred");
      expect(res.out).toContain("Do NOT run the posting script again");
      const r = receipt();
      expect(r).toMatchObject({ status: "deferred", posting_key: key, actual_event: event });
      expect(Date.parse(r.deferred_at)).not.toBeNaN();
      expect(r.defer_reason).toContain("500");
      const j = job();
      expect(j).toMatchObject({
        status: "pending",
        mode: "live",
        deferred_at: r.deferred_at,
        payload: { commit_id: HEAD, event },
      });
      expect(j.payload.body).toContain(`<!-- qcr-post:${key} -->`);
      // The handoff IS the payload the receipt was prepared for.
      expect(createHash("sha256").update(JSON.stringify(j.payload)).digest("hex")).toBe(
        j.payload_sha256,
      );
      // No review exists, so nothing claims the head.
      expect(existsSync(s.dbPath)).toBe(false);
      expect(existsSync(join(s.dir, "receipts", "pr-5180-round-3.json.lock"))).toBe(false);

      // A second run of the script never POSTs again: deferred is the daemon's.
      const again = await s.run(script, [...args, s.bodyFile()], env);
      expect(again.ok).toBe(true);
      expect(again.out).toContain("deferred to the daemon");
      expect(again.out).not.toContain("POST /repos");
      expect(receipt().status).toBe("deferred");
    },
  );

  it("posting-receipt.py refuses a deferral that is not this attempt's prepared payload", async () => {
    const dir = join(s.dir, "receipts");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "pr-5180-round-3.json");
    const py = join(root, "scripts", "posting-receipt.py");
    const args = [path, key, "5180", "3", HEAD, "COMMENT", "COMMENT"];
    await exec("python3", [py, "prepare", ...args, '{"event":"COMMENT"}']);
    await expect(
      exec("python3", [py, "defer", ...args, '{"event":"OTHER"}', "500"]),
    ).rejects.toThrow(/does not match the prepared attempt/);
    expect(JSON.parse(readFileSync(path, "utf8")).status).toBe("prepared");
  });
});
