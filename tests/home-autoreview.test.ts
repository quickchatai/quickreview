// Auto-review's honest label (src/home/autoreview.ts): every state from a
// scripted status snapshot, read the way the real adapter reads it (Docker
// for the container, the daemon's status.json for the rest), and rendered
// through the home's factory on a fake pi. Anything the home cannot read is
// Unknown — an unreadable snapshot, Docker that does not answer, and an older
// daemon's snapshot with no `poll` record — never Off and never On.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import {
  autoReviewLabel,
  composeAutoReview,
  runningRounds,
  runningWarning,
  type AutoReviewReading,
} from "../src/home/autoreview.js";
import {
  known,
  unknown,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
} from "../src/home/ports.js";
import type { OnboardAdapters, ProcessResult } from "../src/onboard/engine.js";
import { fakePi } from "./helpers/fake-pi.js";
import { idleReviews } from "./helpers/fake-reviews.js";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const ago = (s: number): string => new Date(NOW - s * 1000).toISOString();

/** A current daemon's status.json, polling every 300 s, healthy, dry-run. */
function snapshot(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    written_at: ago(20),
    heartbeat: ago(20),
    dry_run: true,
    prs: [],
    running_rounds: 0,
    total_spend_usd: 0,
    poll: { last_at: ago(60), ok: true, interval_s: 300 },
    ...over,
  });
}

const running = (text: string | null): AutoReviewReading => ({
  container: known("running"),
  snapshot: known(text),
  now: NOW,
});

const label = (r: AutoReviewReading) => {
  const k = autoReviewLabel(r);
  return k.kind === "known" ? k.value : { unknown: k.why };
};

describe("the label, from scripted snapshots", () => {
  it("on: a heartbeat within two poll intervals and a clean last poll; dry_run says which", () => {
    expect(label(running(snapshot()))).toEqual({ state: "on-dry", checkedAt: NOW - 60_000 });
    expect(label(running(snapshot({ dry_run: false })))).toMatchObject({ state: "on-live" });
  });

  it("off: the daemon's container is not running, whatever an old snapshot said", () => {
    expect(label({ container: known("stopped"), snapshot: known(null), now: NOW })).toEqual({
      state: "off",
    });
  });

  it("starting: the daemon runs and its first poll has not ended", () => {
    expect(
      label(running(snapshot({ poll: { last_at: null, ok: null, interval_s: 300 } }))),
    ).toEqual({ state: "starting" });
  });

  it("paused: the login it reviews on expired, from pi_auth_expired or the refresher", () => {
    expect(label(running(snapshot({ pi_auth_expired: { last_at: ago(5), hits: 3 } })))).toEqual({
      state: "paused-login",
      cause: "login expired",
    });
    const refresher = (login: Record<string, unknown>): string =>
      snapshot({ login_refresh: { state: "supervised", running: true, restarts: 0, login } });
    expect(
      label(
        running(refresher({ expires_at: ago(60), last_error: "invalid_grant", paused: false })),
      ),
    ).toMatchObject({ state: "paused-login", cause: "login expired" });
    expect(label(running(refresher({ paused: true })))).toMatchObject({
      state: "paused-login",
      cause: "a login is in progress",
    });
    // a future expiry is no pause
    expect(
      label(
        running(
          refresher({ expires_at: new Date(NOW + 3_600_000).toISOString(), last_error: null }),
        ),
      ),
    ).toMatchObject({ state: "on-dry" });
  });

  it("broken carries the pipeline's cause, then the provider's", () => {
    const pipeline = {
      healthy: false,
      failed_loud: 1,
      causes: [
        {
          key: "i1",
          pr: 12,
          since: ago(600),
          stage: "pre_fanout",
          detail: "lens fan-out never started",
          next_action: "retry",
        },
      ],
    };
    expect(label(running(snapshot({ pipeline })))).toMatchObject({
      state: "broken",
      cause: "#12: lens fan-out never started",
    });
    expect(
      label(running(snapshot({ provider: { healthy: false, detail: "rate limited for 2h" } }))),
    ).toMatchObject({ state: "broken", cause: "rate limited for 2h" });
  });

  it("broken: a failed last poll, with its error", () => {
    expect(
      label(
        running(
          snapshot({
            poll: { last_at: ago(30), ok: false, error: "GitHub 502", interval_s: 300 },
          }),
        ),
      ),
    ).toMatchObject({ state: "broken", cause: "the last poll failed: GitHub 502" });
  });

  // MUTATION: drop the heartbeat age check in autoReviewLabel — this fails.
  it("broken: a heartbeat older than two poll intervals, or a poll that stopped finishing", () => {
    expect(label(running(snapshot({ heartbeat: ago(601), written_at: ago(601) })))).toMatchObject({
      state: "broken",
      cause: "no heartbeat for 10m",
    });
    expect(label(running(snapshot({ heartbeat: ago(599) })))).toMatchObject({ state: "on-dry" });
    expect(
      label(running(snapshot({ poll: { last_at: ago(1500), ok: true, interval_s: 300 } }))),
    ).toMatchObject({ state: "broken", cause: "no poll has finished for 25m" });
  });

  it("broken: a container that keeps restarting", () => {
    expect(
      label({ container: known("restarting"), snapshot: known(null), now: NOW }),
    ).toMatchObject({ state: "broken" });
  });

  // MUTATION: read a snapshot with no `poll` as on — this fails.
  it("unknown: an older daemon's snapshot with no poll record, never on", () => {
    const old = JSON.parse(snapshot()) as Record<string, unknown>;
    delete old["poll"];
    expect(label(running(JSON.stringify(old)))).toEqual({
      unknown: "its status has no poll record (an older daemon)",
    });
  });

  it("unknown: an unreadable snapshot, Docker that does not answer, or no status yet", () => {
    expect(label(running("{not json"))).toEqual({
      unknown: "its status.json is not readable JSON",
    });
    expect(
      label({ container: known("running"), snapshot: unknown("permission denied"), now: NOW }),
    ).toEqual({ unknown: "can't read the daemon's status: permission denied" });
    expect(
      label({
        container: unknown("Cannot connect to the Docker daemon"),
        snapshot: known(null),
        now: NOW,
      }),
    ).toEqual({
      unknown: "can't ask Docker whether the daemon runs: Cannot connect to the Docker daemon",
    });
    expect(label(running(null))).toEqual({
      unknown: "the daemon runs but has written no status yet",
    });
    expect(label(running(snapshot({ dry_run: "maybe" })))).toMatchObject({
      unknown: expect.any(String),
    });
  });
});

describe("the running round, for switch-off's warning", () => {
  it("names the PR of each running round", () => {
    const text = snapshot({
      prs: [
        { number: 12, state: "reviewing", current_round: { round_no: 2 } },
        { number: 7, state: "tracked" },
      ],
    });
    expect(runningRounds(text)).toEqual(known([{ pr: 12, round: 2 }]));
    expect(runningWarning(runningRounds(text))).toBe(
      "A review of #12 is running and will be stopped.",
    );
    expect(
      runningWarning(
        known([
          { pr: 3, round: 1 },
          { pr: 4, round: 1 },
          { pr: 5, round: 2 },
        ]),
      ),
    ).toBe("Reviews of #3, #4 and #5 are running and will be stopped.");
    expect(runningWarning(known([]))).toBe("Nothing is running now.");
    expect(runningWarning(unknown("docker failed"))).toMatch(/unknown \(docker failed\)/);
  });
});

// ---- the real adapter over a fake Docker ----------------------------------

interface DockerScript {
  ps: ProcessResult;
  cat?: ProcessResult;
}

function composeOver(
  script: DockerScript,
  config = 'dry_run = true\n[github]\ntrigger_label = "AI review requested"\n',
) {
  const calls: string[][] = [];
  const runner = {
    run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
      calls.push([cmd, ...args]);
      if (args.includes("ps")) return script.ps;
      if (args.includes("cat")) return script.cat ?? { code: 1, stdout: "", stderr: "no cat" };
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const port = composeAutoReview({
    root: "/app",
    configPath: () => "/cfg/config.toml",
    runner,
    stepAdapters: () => ({}) as OnboardAdapters,
    now: () => NOW,
    read: () => config,
  });
  return { port, calls };
}

const ok = (stdout: string): ProcessResult => ({ code: 0, stdout, stderr: "" });
const psRow = (service: string, state: string): string =>
  JSON.stringify({ Service: service, State: state });

describe("the real adapter reads this machine's stack", () => {
  it("reads status.json from inside the daemon's container while it runs", async () => {
    const { port, calls } = composeOver({
      ps: ok(psRow("daemon", "running")),
      cat: ok(snapshot({ dry_run: false })),
    });
    expect(await port.status()).toMatchObject(known({ state: "on-live" }));
    expect(calls).toContainEqual([
      "docker",
      "compose",
      "--project-directory",
      "/app",
      "exec",
      "-T",
      "daemon",
      "cat",
      "/opt/qcr/state/status.json",
    ]);
  });

  it("a stopped daemon is off and its status is never read", async () => {
    const { port, calls } = composeOver({ ps: ok(psRow("memory", "running")) });
    expect(await port.status()).toEqual(known({ state: "off" }));
    expect(calls.some((c) => c.includes("cat"))).toBe(false);
  });

  it("Docker that cannot answer is unknown, never off", async () => {
    const down: ProcessResult = {
      code: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
    };
    const { port } = composeOver({ ps: down });
    const s = await port.status();
    expect(s.kind).toBe("unknown");
  });

  it("says the trigger label from the config, and unknown when it has none", async () => {
    expect(await composeOver({ ps: ok("") }).port.trigger!()).toEqual(known("AI review requested"));
    const none = await composeOver({ ps: ok("") }, "dry_run = true\n").port.trigger!();
    expect(none.kind).toBe("unknown");
  });
});

// ---- through the home -----------------------------------------------------

function adapters(
  auto: () => Promise<Known<AutoReviewStatus>>,
  trigger?: Known<string>,
): HomeAdapters {
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
    autoReview: { status: auto, ...(trigger ? { trigger: async () => trigger } : {}) },
    memory: { status: async () => known("off" as const) },
    spend: { totals: async () => unknown("not yet") },
  };
}

async function panelFor(reading: AutoReviewReading, trigger?: Known<string>): Promise<string> {
  const pi = fakePi();
  await createHome({
    adapters: adapters(async () => autoReviewLabel(reading), trigger),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
  })(pi.api);
  await pi.start();
  return pi.render(100, 40).lines.join("\n");
}

describe("the status line renders every label from a snapshot", () => {
  it.each<[string, AutoReviewReading, RegExp]>([
    ["on, live", running(snapshot({ dry_run: false })), /● Auto-review on · live\s+checked 1m ago/],
    ["on, dry-run", running(snapshot()), /● Auto-review on · dry-run\s+checked 1m ago/],
    ["off", { container: known("stopped"), snapshot: known(null), now: NOW }, /○ Auto-review off/],
    [
      "starting",
      running(snapshot({ poll: { last_at: null, ok: null, interval_s: 300 } })),
      /Auto-review starting/,
    ],
    [
      "paused: login",
      running(snapshot({ pi_auth_expired: { last_at: ago(5), hits: 1 } })),
      /‖ Auto-review paused · login expired/,
    ],
    [
      "broken, with the poll's error",
      running(
        snapshot({ poll: { last_at: ago(30), ok: false, error: "GitHub 502", interval_s: 300 } }),
      ),
      /✗ Auto-review stopped · the last poll failed: GitHub 502/,
    ],
    ["unknown: unreadable", running("garbage"), /\? Auto-review unknown · can't read its status/],
    [
      "unknown: an old snapshot with no poll",
      running(JSON.stringify({ ...JSON.parse(snapshot()), poll: undefined })),
      /\? Auto-review unknown · can't read its status/,
    ],
  ])("%s", async (_name, reading, line) => {
    expect(await panelFor(reading)).toMatch(line);
  });

  it("home_status reports an unknown label as null, with why", async () => {
    const pi = fakePi();
    await createHome({
      adapters: adapters(async () => autoReviewLabel(running("garbage"))),
      model: "openai-codex/gpt-6.1-sol",
      tools: "reviewer",
      every: () => () => {},
    })(pi.api);
    await pi.start();
    const s = JSON.parse(await pi.tool("home_status")) as Record<string, unknown>;
    expect(s["auto_review"]).toBeNull();
    expect(s["auto_review_unknown_because"]).toBe("its status.json is not readable JSON");
  });

  it("says what auto-review picks up: the trigger label or a review request", async () => {
    const text = await panelFor(running(snapshot()), known("AI review requested"));
    expect(text).toMatch(
      /picks up pull requests labelled "AI review requested" or with a review request/,
    );
    const unread = await panelFor(running(snapshot()), unknown("no config"));
    expect(unread).toMatch(
      /picks up pull requests with the trigger label \(which one is unknown\) or a review request/,
    );
  });
});
