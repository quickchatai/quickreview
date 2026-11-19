// The trigger label's definition, made sure of by the running daemon
// (src/triggerlabel.ts) through the gate's `create_label`. No host verb and
// no walk writes it: the daemon asks once when it starts and once after each
// change of the trigger it follows, never at every poll.
//
// The ensurer is driven over a fake adapter; the daemon is driven with a
// fake GitHub at the HTTP level under the real GitHubAdapter and a real
// MutationGate (so dry-run is the gate's own decision), and a real in-memory
// store.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MutationGate, type GateResult } from "@quickchatai/pi-quickreview/src/gate.js";
import type { TokenMinter } from "@quickchatai/pi-quickreview/src/githubAuth.js";
import type { GithubTrigger } from "@quickchatai/pi-quickreview/src/reviewconfig.js";
import { loadConfig, type Config } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import { GitHubAdapter, type PrRef } from "../src/github.js";
import { labelSpecs } from "../src/onboard/steps/githubapp.js";
import { StateStore } from "../src/state.js";
import {
  TRIGGER_LABEL_LOOK,
  triggerLabelEnsurer,
  type TriggerLabelSpec,
} from "../src/triggerlabel.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const LABEL = "AI review requested";

describe("the ensurer", () => {
  const fake = (o: { present?: boolean; create?: () => Promise<GateResult> } = {}) => {
    const calls: string[] = [];
    return {
      calls,
      adapter: {
        hasLabel: async (name: string) => {
          calls.push(`has ${name}`);
          return o.present === true;
        },
        createLabel: async (label: TriggerLabelSpec) => {
          calls.push(`create ${label.name}`);
          return o.create ? o.create() : { executed: true };
        },
      },
    };
  };

  // MUTATION: drop the `trigger === followed` early return — the label is
  // read again at every pass, and this fails.
  it("asks once at the first call, and again only after the trigger changed", async () => {
    const gh = fake();
    let trigger: GithubTrigger = "label";
    const ensure = triggerLabelEnsurer({
      adapter: gh.adapter,
      trigger: () => trigger,
      name: LABEL,
      log: () => {},
    });
    expect(await ensure()).toBe("created");
    expect(await ensure()).toBeNull();
    expect(await ensure()).toBeNull();
    expect(gh.calls).toEqual([`has ${LABEL}`, `create ${LABEL}`]);
    // under `all` there is no label to need
    trigger = "all";
    expect(await ensure()).toBe("not_needed");
    expect(gh.calls).toHaveLength(2);
    // back to label: asked once more
    trigger = "label";
    expect(await ensure()).toBe("created");
    expect(await ensure()).toBeNull();
    expect(gh.calls).toHaveLength(4);
  });

  it("a label already there is left as it is: nothing is created", async () => {
    const gh = fake({ present: true });
    const ensure = triggerLabelEnsurer({
      adapter: gh.adapter,
      trigger: () => "label",
      name: LABEL,
      log: () => {},
    });
    expect(await ensure()).toBe("present");
    expect(gh.calls).toEqual([`has ${LABEL}`]);
  });

  it("an unknown trigger asks nothing, and the first pass that reads it decides", async () => {
    const gh = fake();
    let trigger: GithubTrigger | undefined;
    const ensure = triggerLabelEnsurer({
      adapter: gh.adapter,
      trigger: () => {
        if (trigger === undefined) throw new Error("the store did not answer");
        return trigger;
      },
      name: LABEL,
      log: () => {},
    });
    expect(await ensure()).toBeNull();
    expect(gh.calls).toEqual([]);
    trigger = "label";
    expect(await ensure()).toBe("created");
  });

  it("a failure is told once, never thrown, and not retried at every pass", async () => {
    const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
    const logs: string[] = [];
    const gh = fake({
      create: async () => {
        throw new Error("POST /repos/o/r/labels → 403: Resource not accessible by integration");
      },
    });
    const ensure = triggerLabelEnsurer({
      adapter: gh.adapter,
      trigger: () => "label",
      name: LABEL,
      log: (l) => logs.push(l),
      logEvent: (kind, data) => events.push({ kind, data }),
    });
    expect(await ensure()).toBe("failed");
    expect(await ensure()).toBeNull();
    expect(gh.calls).toHaveLength(2);
    expect(events).toEqual([
      { kind: "trigger_label_failed", data: { label: LABEL, outcome: "failed" } },
    ]);
    expect(logs.join("\n")).toMatch(/403/);
  });

  it("an adapter with no label calls is asked nothing", async () => {
    const ensure = triggerLabelEnsurer({
      adapter: {},
      trigger: () => "label",
      name: LABEL,
      log: () => {},
    });
    expect(await ensure()).toBe("unsupported");
  });

  // The look a label is created with is the wizard's own for the same label.
  it("creates it with the look the wizard's label step gives it", () => {
    const wizard = labelSpecs(null, {}).find((l) => l.name === LABEL);
    expect(wizard).toEqual({ name: LABEL, ...TRIGGER_LABEL_LOOK });
  });
});

// ---- the daemon ---------------------------------------------------------------

const pr = (number: number): PrRef => ({
  number,
  title: `PR ${number}`,
  author: "someone",
  head_sha: `head${number}`,
  base_ref: "main",
  body: "",
  updated_at: "2026-11-19T09:00:00Z",
  state: "open",
  draft: false,
  merged: false,
  labels: [],
});

/** GitHub's label endpoints, as the daemon's adapter calls them: a set of
 * label names, and what a create answers. Every request is recorded. */
function fakeGitHub(o: { labels?: string[]; createAnswers422?: boolean } = {}) {
  const labels = new Set(o.labels ?? []);
  const calls: string[] = [];
  const answer = (status: number, body: unknown): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(),
      json: async () => body,
      text: async () => JSON.stringify(body),
    }) as unknown as Response;
  const fetchFn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? "GET";
    const path = decodeURIComponent(u.pathname);
    calls.push(`${method} ${path}`);
    const m = /^\/repos\/[^/]+\/[^/]+\/labels(?:\/(.+))?$/.exec(path);
    if (m === null) return answer(404, { message: "Not Found" });
    if (method === "GET")
      return m[1] !== undefined && labels.has(m[1])
        ? answer(200, { name: m[1] })
        : answer(404, { message: "Not Found" });
    if (method === "POST") {
      const sent = JSON.parse(init.body as string) as { name: string };
      if (o.createAnswers422 === true || labels.has(sent.name))
        return answer(422, {
          message: "Validation Failed",
          errors: [{ resource: "Label", code: "already_exists", field: "name" }],
        });
      labels.add(sent.name);
      return answer(201, sent);
    }
    return answer(405, { message: "Method Not Allowed" });
  }) as unknown as typeof fetch;
  return { fetchFn, calls, labels };
}

const minter = {
  appJwt: () => "jwt.fake.token",
  installationToken: async () => "ghs_installation",
  invalidate: () => {},
} as unknown as TokenMinter;

/** The daemon's adapter: no pull request carries a label, and the label
 * calls are the real adapter's over the fake GitHub, through a real gate. */
function adapterFor(cfg: Config, dryrunDir: string, github: ReturnType<typeof fakeGitHub>) {
  let real!: GitHubAdapter;
  const gate = new MutationGate(cfg.dry_run, dryrunDir, (intent) => real.executeMutation(intent));
  real = new GitHubAdapter(cfg, minter, gate, github.fetchFn, "https://api.github.test", {
    sleep: async () => {},
    random: () => 0.5,
  });
  const dry = async (): Promise<GateResult> => ({ executed: false });
  return {
    searchLabelTriggered: async () => [],
    searchTeamTriggered: async () => [],
    searchAwaitingEscalationReviewer: async () => [],
    listOpenPrs: async () => [pr(101)],
    getPr: async () => pr(101),
    stalenessScan: async () => [],
    listBotReviewComments: async () => [],
    getRequestedReviewers: async () => ({ users: [], teams: [] }),
    listPrFiles: async () => [],
    addLabel: dry,
    removeLabel: dry,
    deleteTeamReviewRequest: dry,
    requestEscalationReview: async () => ({ skipped: null, result: await dry() }),
    createReview: dry,
    hasLabel: (name: string) => real.hasLabel(name),
    createLabel: (label: TriggerLabelSpec) => real.createLabel(label),
  } as unknown as DaemonAdapter;
}

describe("the running daemon makes sure of the trigger label", () => {
  let root: string;
  let store: StateStore;
  let dryrunDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "qcr-trigger-label-"));
    for (const d of ["state", "state/dryrun", "verdict", "inject"])
      mkdirSync(join(root, d), { recursive: true });
    dryrunDir = join(root, "state", "dryrun");
    store = new StateStore(":memory:");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const daemonOn = (cfg: Config, github: ReturnType<typeof fakeGitHub>) =>
    createDaemon({
      cfg,
      root,
      store,
      adapter: adapterFor(cfg, dryrunDir, github),
      listen: false,
      log: () => {},
      hooks: { async inject() {}, async dispatchRound() {}, async archiveAndClose() {} },
    });
  const configured = (o: { dryRun: boolean; host?: boolean }): Config => {
    const loaded = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
    return {
      ...loaded,
      dry_run: o.dryRun,
      github: {
        ...loaded.github,
        trigger: "label" as const,
        ...(o.host === true ? { token_source: "host" as const } : {}),
      },
    };
  };
  const posts = (github: ReturnType<typeof fakeGitHub>): string[] =>
    github.calls.filter((c) => c.startsWith("POST "));
  const failures = (): number =>
    (
      store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE kind = 'trigger_label_failed' " +
            "OR (kind = 'daemon_error' AND payload LIKE '%\"what\":\"trigger label\"%')",
        )
        .get() as { n: number }
    ).n;

  // MUTATION: put "create_label" in APP_SELF_CONFIG_KINDS (or call the
  // executor around the gate in createLabel) — a practice-mode daemon
  // creates the label at GitHub, and this fails.
  it(
    "in dry-run it creates nothing: the gate records the request",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const github = fakeGitHub();
      const daemon = daemonOn(configured({ dryRun: true }), github);
      await daemon.reconcile();
      await daemon.reconcile();
      expect(posts(github)).toEqual([]);
      expect(github.labels.size).toBe(0);
      // one read, one recorded request, for the whole run
      expect(github.calls).toEqual([`GET /repos/example-org/example-app/labels/${LABEL}`]);
      expect(readdirSync(dryrunDir).filter((f) => f.includes("create_label"))).toHaveLength(1);
      expect(failures()).toBe(0);
    },
  );

  // MUTATION: drop the `ensureTriggerLabel` guard from the daemon's
  // reconcile pass — a live daemon on `label` never creates the label, and
  // this fails.
  it(
    "live, it creates the label once, and not at every poll",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const github = fakeGitHub();
      const daemon = daemonOn(configured({ dryRun: false }), github);
      await daemon.reconcile();
      await daemon.reconcile();
      await daemon.reconcile();
      expect(posts(github)).toEqual(["POST /repos/example-org/example-app/labels"]);
      expect([...github.labels]).toEqual([LABEL]);
      expect(github.calls.filter((c) => c.startsWith("GET "))).toHaveLength(1);
      expect(failures()).toBe(0);
    },
  );

  it(
    "a label that is already there is read and left alone",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const github = fakeGitHub({ labels: [LABEL] });
      const daemon = daemonOn(configured({ dryRun: false }), github);
      await daemon.reconcile();
      expect(posts(github)).toEqual([]);
      expect(failures()).toBe(0);
    },
  );

  // MUTATION: drop the 422 `already_exists` case from GitHubAdapter.createLabel
  // — a label another process made between the read and the create reads as a
  // failure, and this fails.
  it("GitHub's 422 `already_exists` is success", { timeout: HEAVY_TIMEOUT_MS }, async () => {
    const github = fakeGitHub({ createAnswers422: true });
    const daemon = daemonOn(configured({ dryRun: false }), github);
    await daemon.reconcile();
    await daemon.reconcile();
    expect(posts(github)).toHaveLength(1);
    expect(failures()).toBe(0);
  });

  it(
    "a host's change of the trigger asks again, once; under `all` nothing is asked",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const github = fakeGitHub();
      store.setTriggerChoice("all", "set-trigger-1.json");
      const daemon = daemonOn(configured({ dryRun: false, host: true }), github);
      await daemon.reconcile();
      expect(github.calls).toEqual([]);
      store.setTriggerChoice("label", "set-trigger-2.json");
      await daemon.reconcile();
      await daemon.reconcile();
      expect(posts(github)).toEqual(["POST /repos/example-org/example-app/labels"]);
    },
  );
});
