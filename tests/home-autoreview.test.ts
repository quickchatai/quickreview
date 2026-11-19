// Auto-review's honest label (src/home/autoreview.ts): every state from a
// scripted status snapshot, read the way the real adapter reads it (Docker
// for the container, the daemon's status.json for the rest), and rendered
// through the home's factory on a fake pi. Anything the home cannot read is
// Unknown — an unreadable snapshot, Docker that does not answer, and an older
// daemon's snapshot with no `poll` record — never Off and never On.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import {
  HOST_GOES_LIVE,
  HOST_STARTS_AUTO_REVIEW,
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
    const none = await composeOver({ ps: ok("") }, '[github]\ntrigger_label = ""\n').port
      .trigger!();
    expect(none.kind).toBe("unknown");
  });

  // A config.toml reads over the shipped defaults, as the daemon reads it
  // (packages/pi-plugin/src/shippedconfig.ts): a key it leaves out is the
  // shipped value the daemon runs on, never unknown.
  // MUTATION: read the config with smol-toml's `parse` in autoreview.ts
  // `readConfig` — a partial config's dry_run and trigger label read as
  // unknown, and this fails.
  it("a partial config reads the shipped dry_run and trigger label", async () => {
    const { port } = composeOver({ ps: ok("") }, '[review]\nprofile = "state-machines"\n');
    expect(await port.control!.dryRun()).toEqual(known(true));
    expect(await port.trigger!()).toEqual(known("AI review requested"));
    const live = composeOver({ ps: ok("") }, "dry_run = false\n").port;
    expect(await live.control!.dryRun()).toEqual(known(false));
  });

  // Which pull requests it picks up: the trigger the running daemon follows,
  // out of its status.json, never the config file's word (src/triggerchoice.ts).
  // With the daemon off: unknown on a host-managed install, where a stored
  // choice may stand over the file; on any other the config's word, which
  // is what it starts on.
  // MUTATION: answer the config's word while the daemon runs (skip reading
  // its status) — the home says the file's `label` while the daemon follows
  // `all`, and this fails; or answer it on a host-managed install with the
  // daemon off — the unknown case fails.
  it("says the trigger the running daemon follows, whatever the config file says", async () => {
    const HOSTED = '[github]\ntoken_source = "host"\nauth = "user"\ntrigger = "label"\n';
    const OWN = '[github]\ntrigger = "label"\n';
    const up = (config: string, followed: unknown) =>
      composeOver(
        { ps: ok(psRow("daemon", "running")), cat: ok(snapshot({ trigger: followed })) },
        config,
      ).port.pickUp!();
    for (const config of [HOSTED, OWN]) {
      expect(await up(config, "all")).toEqual(known("all"));
      expect(await up(config, "label")).toEqual(known("label"));
      // an older daemon that does not say, or says a word this release does not know
      for (const said of [undefined, null, "every"])
        expect((await up(config, said)).kind, String(said)).toBe("unknown");
    }
    // a status that cannot be read is unknown, never the file's word
    const unread = composeOver(
      { ps: ok(psRow("daemon", "running")), cat: { code: 1, stdout: "", stderr: "gone" } },
      OWN,
    );
    expect((await unread.port.pickUp!()).kind).toBe("unknown");

    // the daemon off, on a host-managed install: unknown, its status unasked
    const off = composeOver({ ps: ok(psRow("memory", "running")) }, HOSTED);
    expect((await off.port.pickUp!()).kind).toBe("unknown");
    expect(off.calls.some((c) => c.includes("cat"))).toBe(false);
    const down = composeOver({ ps: { code: 1, stdout: "", stderr: "no docker" } }, HOSTED);
    expect((await down.port.pickUp!()).kind).toBe("unknown");
    // and on an install that keeps its own credential: the config it starts on
    const own = composeOver({ ps: ok("") }, '[github]\ntrigger = "all"\n');
    expect(await own.port.pickUp!()).toEqual(known("all"));
    expect(own.calls.some((c) => c.includes("cat"))).toBe(false);
    expect(await composeOver({ ps: ok("") }).port.pickUp!()).toEqual(known("label"));
    expect(
      (await composeOver({ ps: ok("") }, '[github]\ntrigger = "every"\n').port.pickUp!()).kind,
    ).toBe("unknown");
  });
});

// A host-managed install (`[github] token_source = "host"`): its host starts
// auto-review and takes it live through its own verbs, so the home's switch
// runs no step of either. The port refuses, in words, before it builds a
// checklist: `stepAdapters` throwing is what proves no step was reached.
describe("the switch on a host-managed install", () => {
  const HOSTED = '[github]\nrepo = "acme/widgets"\nauth = "user"\ntoken_source = "host"\n';
  const hosted = (config = HOSTED) => {
    const calls: string[][] = [];
    const port = composeAutoReview({
      root: "/app",
      configPath: () => "/cfg/config.toml",
      runner: {
        run: async (cmd: string, args: string[]): Promise<ProcessResult> => {
          calls.push([cmd, ...args]);
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      stepAdapters: () => {
        throw new Error("a step was reached");
      },
      now: () => NOW,
      read: () => config,
    });
    return { control: port.control!, calls };
  };

  // MUTATION: drop the `hostManaged()` check in control.switchOn — the walk
  // is built (stepAdapters throws), and this fails.
  it("switch-on refuses, in words, and runs no step and no command", async () => {
    const { control, calls } = hosted();
    const out = await control.switchOn({ memory: null, confirmed: true });
    expect(out).toEqual({ ok: false, live: null, detail: HOST_STARTS_AUTO_REVIEW, steps: [] });
    expect(out.detail).toMatch(/started by your host/);
    expect(calls).toEqual([]);
  });

  // MUTATION: drop the `hostManaged()` check in control.goLive or
  // control.proofRound — the go-live step's checklist is built, and this fails.
  it("the proof round and the go-live refuse the same way: the go-live step is never reached", async () => {
    const { control, calls } = hosted();
    expect(await control.proofRound(7)).toEqual({ ok: false, detail: HOST_GOES_LIVE });
    expect(await control.goLive({ confirmed: true })).toEqual({
      ok: false,
      detail: HOST_GOES_LIVE,
    });
    expect(HOST_GOES_LIVE).toMatch(/from your host/);
    expect(calls).toEqual([]);
  });

  it("switch-off stays: the daemon can still be stopped from the home", async () => {
    const { control, calls } = hosted();
    expect((await control.switchOff()).ok).toBe(true);
    expect(calls).toEqual([["docker", "compose", "--project-directory", "/app", "stop", "daemon"]]);
  });

  it("an install that keeps its own credential walks the steps as before", async () => {
    const { control } = hosted('[github]\nrepo = "acme/widgets"\n');
    await expect(control.switchOn({ memory: null, confirmed: true })).rejects.toThrow(
      /a step was reached/,
    );
    await expect(control.goLive({ confirmed: true })).rejects.toThrow(/a step was reached/);
  });
});

// ---- through the home -----------------------------------------------------

function adapters(
  auto: () => Promise<Known<AutoReviewStatus>>,
  trigger?: Known<string>,
  pickUp: Known<"label" | "all"> = known("label"),
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
    autoReview: {
      status: auto,
      ...(trigger ? { trigger: async () => trigger, pickUp: async () => pickUp } : {}),
    },
    memory: { status: async () => known("off" as const) },
    spend: { totals: async () => unknown("not yet") },
  };
}

async function panelFor(
  reading: AutoReviewReading,
  trigger?: Known<string>,
  o: { pickUp?: Known<"label" | "all">; width?: number } = {},
): Promise<string> {
  const pi = fakePi();
  await createHome({
    adapters: adapters(async () => autoReviewLabel(reading), trigger, o.pickUp),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
  })(pi.api);
  await pi.start();
  return pi.render(o.width ?? 100, 40).lines.join("\n");
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

  // The home's narrowest column is 74: each line is said whole there.
  // MUTATION: drop the `all` branch of pickUpPhrase — the home says the
  // label alone under `all`, and this fails. Or answer the label wording
  // when the rule cannot be read — this fails. Or drop the labelled and
  // review-requested ones from the dry-run wording under `all` (say it
  // takes nothing by itself): they are taken in dry-run as under `label`
  // (src/reconcile.ts), and this fails.
  it("under `all`: the labelled and review-requested ones in dry-run and nothing else, every open pull request once posting, and unknown when which cannot be read, at 74 columns", async () => {
    const flat = (t: string): string => t.replace(/[│\s]+/g, " ");
    const practice = await panelFor(running(snapshot()), known("AI review requested"), {
      pickUp: known("all"),
      width: 74,
    });
    expect(practice).toMatch(/Auto-review on · dry-run/);
    expect(flat(practice)).toMatch(
      /picks up only labelled "AI review requested" or review-requested pull requests until posting, as practice reviews; then every open non-draft one once, and new ones/,
    );
    const live = await panelFor(
      running(snapshot({ dry_run: false })),
      known("AI review requested"),
      { pickUp: known("all"), width: 74 },
    );
    expect(live).toMatch(/Auto-review on · live/);
    expect(flat(live)).toMatch(
      /picks up every open pull request that is not a draft, each once, then new ones, and again any labelled "AI review requested" or with a review request/,
    );
    expect(live).not.toMatch(/practice/);
    // switched off, the posture is not the status's to say: both halves
    const off = await panelFor(
      { container: known("stopped"), snapshot: known(null), now: NOW },
      known("AI review requested"),
      { pickUp: known("all"), width: 74 },
    );
    expect(flat(off)).toMatch(
      /picks up labelled "AI review requested" or review-requested pull requests; once posting, also every open non-draft one once, and new ones \(in dry-run nothing else\)/,
    );
    const unread = await panelFor(running(snapshot()), known("AI review requested"), {
      pickUp: unknown("the daemon is not running"),
      width: 74,
    });
    expect(unread).toMatch(
      / {2}picks up labelled pull requests or every one \(which is unknown\)\s*│/,
    );
    expect(unread).not.toMatch(/labelled "AI review requested"/);
    for (const text of [practice, live, off, unread]) expect(text).not.toContain("…");
  });
});
