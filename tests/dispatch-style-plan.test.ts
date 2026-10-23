// The persisted pass policy is the one actually dispatched: the repo's written
// style guide is found only after the worktree is prepared, and it can add
// pass-style to the plan. The round row (lenses, pass_plan, addable_passes)
// must carry that plan, or verdicts.ts audits a planned style pass as an
// unplanned addition (missing_reason / wrong_tier → pass_plan_mismatch).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@quickchatai/pi-quickreview/src/styleguide.js", async (orig) => ({
  ...(await orig<typeof import("@quickchatai/pi-quickreview/src/styleguide.js")>()),
  findStyleGuide: () => ["AGENTS.md:10-40"],
}));

import { parseConfig, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import type { GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { StateStore } from "../src/state.js";
import type { RoundOrder, SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const cfg: Config = parseConfig(
  readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
);

const noop = async (): Promise<GateResult> => ({ executed: false, dryRunFile: "x" });

describe("the persisted round plan includes the repo style guide's pass-style", () => {
  it(
    "rounds.lenses, pass_plan and addable_passes match the dispatched order",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const store = new StateStore(":memory:");
      store.upsertPr({
        number: 51,
        state: "queued",
        head_sha: "sha51",
        title: "PR 51",
        author: "alice",
        trigger_ts: "2026-09-30T09:00:00Z",
        trigger_provenance: null,
        stale_recheck: 0,
        migration_gate: 0,
      });
      const files: PrFileEntry[] = [
        { filename: "app/service.py", additions: 12, deletions: 1, status: "modified" },
      ];
      const adapter: DispatchAdapter = {
        listPrFiles: async () => files,
        getPr: async () => ({ base_ref: "master" }),
        addLabel: noop,
        removeLabel: noop,
        deleteTeamReviewRequest: noop,
        createReview: noop,
      };
      const orders: RoundOrder[] = [];
      const hooks: SessionHooks = {
        async dispatchRound(order) {
          orders.push(order);
        },
        async inject() {},
        async archiveAndClose() {},
      };

      await dispatchOnce({ cfg, store, adapter, hooks });

      const order = orders[0]!;
      expect(order.lenses).toContain("pass-style");
      const round = store.roundsFor(51)[0]!;
      expect(round.lenses.split(",")).toEqual(order.lenses);
      expect(JSON.parse(round.pass_plan!)).toEqual(order.pass_plan);
      const addable = JSON.parse(round.addable_passes!) as Array<{ lens: string }>;
      expect(addable.map((a) => a.lens)).toEqual(order.addable_lenses);
      expect(addable.map((a) => a.lens)).not.toContain("pass-style");
    },
  );
});
