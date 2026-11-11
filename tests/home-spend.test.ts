// The home's spend line (src/home/spend.ts): today's and this month's review
// cost, summed from the home's own review runs and auto-review's recorded
// costs, and Unknown whenever either source cannot be read (invariant 9).
// Driven through the home's factory on a fake pi, as the person sees it,
// and then each real source over its own seam: a scratch registry for the
// home's runs, a fake Docker for the daemon's status.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import type { ProcessResult, ProcessRunner } from "../src/onboard/engine.js";
import {
  known,
  unknown,
  type HomeAdapters,
  type Known,
  type SpendPort,
} from "../src/home/ports.js";
import {
  composeAutoSpend,
  registryCosts,
  snapshotSpend,
  spendPort,
  type AutoSpend,
  type Cost,
} from "../src/home/spend.js";
import { fakePi, settle } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const NOW = Date.parse("2026-10-27T15:00:00Z");
const TODAY = Date.parse("2026-10-27T09:30:00Z");
const EARLIER = Date.parse("2026-10-03T12:00:00Z");
const LAST_MONTH = Date.parse("2026-09-30T23:00:00Z");

function adapters(spend: SpendPort): HomeAdapters {
  return {
    login: { providers: async () => known(["openai-codex"]) },
    github: {
      user: async () => known("octo"),
      openPulls: async () => known([]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known("acme/widgets") },
    clock: { now: () => NOW },
    reviews: idleReviews(),
    autoReview: { status: async () => known({ state: "off" as const }) },
    memory: { status: async () => known("off" as const) },
    spend,
  };
}

async function openHome(spend: SpendPort) {
  const pi = fakePi();
  await createHome({
    adapters: adapters(spend),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
    after: () => () => {},
  })(pi.api);
  await pi.start();
  await settle();
  return {
    pi,
    text: () => pi.render(100, 40).lines.join("\n"),
    status: async () => JSON.parse(await pi.tool("home_status")) as Record<string, unknown>,
  };
}

const sources = (
  home: () => Promise<Known<readonly Cost[]>>,
  auto: () => Promise<Known<AutoSpend>>,
): SpendPort => spendPort({ home, auto }, () => NOW);

describe("the spend line, through the home", () => {
  // MUTATION: drop the auto-review half from spendPort's sum — this fails.
  it("sums the home's runs and auto-review's costs, for today and this month", async () => {
    const h = await openHome(
      sources(
        async () =>
          known([
            { at: TODAY, usd: 1 },
            { at: EARLIER, usd: 2 },
            { at: LAST_MONTH, usd: 9 },
          ]),
        async () => known({ today: 0.75, month: 1.25, todayUnknown: 0, monthUnknown: 0 }),
      ),
    );
    expect(h.text()).toContain("$1.75 today · $4.25 this month");
    expect((await h.status())["spend"]).toEqual({
      today: 1.75,
      month: 4.25,
      todayUnknown: 0,
      monthUnknown: 0,
    });
  });

  // A review whose cost is not known (a model pi has no price for) is never
  // $0 inside the sum: both halves count theirs, and the line says them.
  // MUTATION: skip a null cost in spendPort's loop as it skips a non-finite
  // one - the home's own unknown reviews vanish and this fails.
  it("says the reviews with no known cost beside each sum, from both halves", async () => {
    const h = await openHome(
      sources(
        async () =>
          known([
            { at: TODAY, usd: 1 },
            { at: TODAY, usd: null },
            { at: EARLIER, usd: null },
            { at: LAST_MONTH, usd: null },
          ]),
        async () => known({ today: 0.75, month: 1.25, todayUnknown: 1, monthUnknown: 3 }),
      ),
    );
    expect(h.text()).toContain(
      "$1.75 + 2 rounds unknown today · $2.25 + 5 rounds unknown this month",
    );
    expect((await h.status())["spend"]).toEqual({
      today: 1.75,
      month: 2.25,
      todayUnknown: 2,
      monthUnknown: 5,
    });
  });

  it("a day on which nothing has a price reads unknown, never $0.00", async () => {
    const h = await openHome(
      sources(
        async () => known([{ at: TODAY, usd: null }]),
        async () => known({ today: 0, month: 0, todayUnknown: 0, monthUnknown: 0 }),
      ),
    );
    expect(h.text()).toContain("unknown (1 round) today · unknown (1 round) this month");
    expect(h.text()).not.toMatch(/\$0\.00 today/);
  });

  // Invariant 9, second half: an older daemon's snapshot has no count. That
  // is an unknown count, not a zero, and the home's own half is not passed
  // off as the whole: the sum is said as it is, and the published field is
  // null, never absent and never a number.
  // MUTATION: treat a null count as 0 in spendPort's `plus` - the line says
  // "+ 1 round unknown" and the status says 1, and this fails.
  it("an unknown count from auto-review leaves the total count unknown: the sum alone, and null in the status", async () => {
    const h = await openHome(
      sources(
        async () =>
          known([
            { at: TODAY, usd: 1 },
            { at: TODAY, usd: null },
          ]),
        async () => known({ today: 0.75, month: 1.25, todayUnknown: null, monthUnknown: null }),
      ),
    );
    expect(h.text()).toContain("$1.75 today · $2.25 this month");
    expect(h.text()).not.toContain("rounds unknown");
    expect((await h.status())["spend"]).toEqual({
      today: 1.75,
      month: 2.25,
      todayUnknown: null,
      monthUnknown: null,
    });
  });

  it("a machine where nothing was reviewed yet spends $0.00, said as a measured zero", async () => {
    const h = await openHome(
      sources(
        async () => known([]),
        async () => known({ today: 0, month: 0, todayUnknown: 0, monthUnknown: 0 }),
      ),
    );
    expect(h.text()).toContain("$0.00 today · $0.00 this month");
  });

  // MUTATION: return the home's half alone when auto-review's is unknown — this fails.
  it.each([
    ["the home's runs", "home"],
    ["auto-review's costs", "auto"],
  ] as const)("reads Unknown when %s can't be read, never a zero", async (_name, broken) => {
    const h = await openHome(
      sources(
        async () => (broken === "home" ? unknown("the registry is unreadable") : known([])),
        async () =>
          broken === "auto"
            ? unknown("Docker did not answer")
            : known({ today: 2, month: 3, todayUnknown: 0, monthUnknown: 0 }),
      ),
    );
    expect(h.text()).toContain("spend unknown");
    expect(h.text()).not.toMatch(/\$\d+\.\d\d today/);
    expect((await h.status())["spend"]).toBeNull();
  });

  it("a source that throws reads Unknown too", async () => {
    const h = await openHome(
      sources(
        async () => {
          throw new Error("boom");
        },
        async () => known({ today: 0, month: 0, todayUnknown: 0, monthUnknown: 0 }),
      ),
    );
    expect(h.text()).toContain("spend unknown");
  });
});

// ---- the home's half: the detached registry --------------------------------

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function registry(): string {
  const d = mkdtempSync(join(tmpdir(), "qcr-spend-"));
  dirs.push(d);
  return d;
}

/** One run in the registry: its record, and its exit and result once over. */
function run(
  home: string,
  id: string,
  o: { started: number; ended?: number; exit?: number; cost?: number | null },
): void {
  const dir = join(home, "runs", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      run_id: id,
      key: `pr:acme/widgets#${id}`,
      label: `PR acme/widgets#1`,
      argv: [],
      pid: 4242,
      started_at: o.started,
    }),
  );
  if (o.exit !== undefined)
    writeFileSync(join(dir, "exit.json"), JSON.stringify({ code: o.exit, at: o.ended }));
  if (o.cost !== undefined)
    writeFileSync(
      join(dir, "output.jsonl"),
      `${JSON.stringify({ ok: o.exit === 0, ...(o.cost === null ? {} : { cost_usd: o.cost }) })}\n`,
    );
}

describe("the home's runs", () => {
  it("counts each run that ended with a cost, at the time it ended", async () => {
    const home = registry();
    run(home, "a", { started: TODAY - 60_000, ended: TODAY, exit: 0, cost: 1.1 });
    run(home, "b", { started: EARLIER, ended: EARLIER + 1000, exit: 1, cost: 0.4 }); // failed, still spent
    run(home, "c", { started: NOW - 1000 }); // running: its cost is not in yet
    // Finished, and its result names no cost: not free, unknown.
    run(home, "d", { started: TODAY, ended: TODAY + 1000, exit: 0, cost: null });
    // Failed with no cost named: nothing says a review ran, so nothing to add.
    run(home, "e", { started: TODAY, ended: TODAY + 2000, exit: 1, cost: null });
    const costs = await registryCosts(home, { now: () => NOW, alive: () => true })();
    expect(costs.kind).toBe("known");
    if (costs.kind !== "known") return;
    // MUTATION: skip a finished run whose result names no cost in
    // registryCosts - run d drops out and this fails.
    expect([...costs.value].sort((a, b) => a.at - b.at)).toEqual([
      { at: EARLIER + 1000, usd: 0.4 },
      { at: TODAY, usd: 1.1 },
      { at: TODAY + 1000, usd: null },
    ]);
  });

  it("a registry with no runs yet is a known nothing", async () => {
    expect(await registryCosts(join(registry(), "never-made"), { now: () => NOW })()).toEqual(
      known([]),
    );
  });
});

// ---- auto-review's half: the daemon's status ------------------------------

const snap = (o: Record<string, unknown>): string =>
  JSON.stringify({ written_at: "2026-10-27T14:59:30.000Z", dry_run: true, ...o });

describe("auto-review's recorded costs", () => {
  it("are the snapshot's day and month", () => {
    expect(
      snapshotSpend(
        snap({
          today_spend_usd: 0.5,
          month_spend_usd: 7,
          today_unknown_spend_rounds: 1,
          month_unknown_spend_rounds: 4,
        }),
        NOW,
      ),
    ).toEqual(known({ today: 0.5, month: 7, todayUnknown: 1, monthUnknown: 4 }));
  });

  // MUTATION: default a missing month_unknown_spend_rounds to 0 — this fails.
  it("an older daemon's snapshot, with no unknown-round counts, has unknown counts: null, never zero", () => {
    expect(snapshotSpend(snap({ today_spend_usd: 0.5, month_spend_usd: 7 }), NOW)).toEqual(
      known({ today: 0.5, month: 7, todayUnknown: null, monthUnknown: null }),
    );
  });

  // MUTATION: default a missing month_spend_usd to 0 — this fails.
  it("an older daemon's snapshot, with no month, is unknown", () => {
    const r = snapshotSpend(snap({ today_spend_usd: 0.5 }), NOW);
    expect(r.kind).toBe("unknown");
  });

  it("a snapshot from an earlier day adds nothing today; from an earlier month, nothing at all", () => {
    expect(
      snapshotSpend(
        snap({
          written_at: "2026-10-20T10:00:00Z",
          today_spend_usd: 4,
          month_spend_usd: 6,
          today_unknown_spend_rounds: 2,
          month_unknown_spend_rounds: 3,
        }),
        NOW,
      ),
    ).toEqual(known({ today: 0, month: 6, todayUnknown: 0, monthUnknown: 3 }));
    expect(
      snapshotSpend(
        snap({ written_at: "2026-09-29T10:00:00Z", today_spend_usd: 4, month_spend_usd: 6 }),
        NOW,
      ),
    ).toEqual(known({ today: 0, month: 0, todayUnknown: 0, monthUnknown: 0 }));
  });

  it("unreadable text is unknown", () => {
    expect(snapshotSpend("{not json", NOW).kind).toBe("unknown");
  });
});

/** A fake Docker: `ps` says whether the daemon runs, `exec cat` gives its
 * status, `volume ls` whether its state volume exists. */
function docker(o: {
  running?: boolean;
  status?: string;
  volume?: boolean;
  missing?: boolean;
  psFails?: boolean;
}): ProcessRunner & { calls: string[] } {
  const calls: string[] = [];
  const res = (code: number, stdout = "", stderr = ""): ProcessResult => ({ code, stdout, stderr });
  return {
    calls,
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      if (o.missing) return res(1, "", "spawn docker ENOENT");
      if (args.includes("ps"))
        return o.psFails
          ? res(1, "", "Cannot connect to the Docker daemon")
          : res(0, o.running ? JSON.stringify({ Service: "daemon", State: "running" }) : "");
      if (args.includes("exec")) return res(0, o.status ?? "");
      if (args[0] === "volume") return res(0, o.volume ? "quickreview_qcr-state\n" : "");
      if (args[0] === "--version") return res(0, "Docker version 27");
      return res(1, "", `unexpected: ${line}`);
    },
  };
}

describe("auto-review's costs on this machine's stack", () => {
  it("are read from the running daemon's status", async () => {
    const d = docker({
      running: true,
      status: snap({
        today_spend_usd: 0.25,
        month_spend_usd: 3.5,
        today_unknown_spend_rounds: 0,
        month_unknown_spend_rounds: 2,
      }),
    });
    expect(await composeAutoSpend({ root: "/app", runner: d })(NOW)).toEqual(
      known({ today: 0.25, month: 3.5, todayUnknown: 0, monthUnknown: 2 }),
    );
    expect(d.calls.some((c) => c.includes("exec -T daemon cat /opt/qcr/state/status.json"))).toBe(
      true,
    );
  });

  // MUTATION: answer a stopped daemon's costs as zero — this fails.
  it("a daemon that is off, with its data kept, is unknown: its costs are in its volume", async () => {
    const r = await composeAutoSpend({ root: "/app", runner: docker({ volume: true }) })(NOW);
    expect(r.kind).toBe("unknown");
  });

  it("a stack never brought up, or no Docker at all, recorded nothing", async () => {
    const nothing = known({ today: 0, month: 0, todayUnknown: 0, monthUnknown: 0 });
    expect(await composeAutoSpend({ root: "/app", runner: docker({}) })(NOW)).toEqual(nothing);
    expect(
      await composeAutoSpend({ root: "/app", runner: docker({ missing: true }) })(NOW),
    ).toEqual(nothing);
  });

  it("Docker that does not answer is unknown", async () => {
    const r = await composeAutoSpend({ root: "/app", runner: docker({ psFails: true }) })(NOW);
    expect(r.kind).toBe("unknown");
  });
});
