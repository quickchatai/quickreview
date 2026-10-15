// The pluggable issue sink, exercised at the seam with fakes for
// all three kinds. No live GitHub anywhere:
//   * wayfinder — against a temp tracker dir, exactly as the auto-filer tests
//     do (byte-compatible ticket format is autofile.test.ts's job; here the
//     adapter's report/stamp contract is pinned);
//   * github    — a fake ssh runner captures the command file, which must
//     validate against the daemon's own schema (src/commands.ts), and the
//     daemon's answer (queued result JSON) decides filed/refused/stamp;
//   * none      — inert.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateCommand } from "../src/commands.js";
import { parseConfig, type TuiConfig } from "../src/config.js";
import type { MemoryOp, MemoryStore } from "../src/memory/store.js";
import type { MemoryEntry } from "../src/tui/memory.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import {
  buildIssueSink,
  GithubIssueSink,
  issueBodyFor,
  issueTitleFor,
  NoneIssueSink,
  ticketProjection,
  WayfinderIssueSink,
} from "../src/tui/issuesink.js";
import { memoryKey } from "../src/tui/autofile.js";

const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id: "reviewer:experiences/20260820T090142-a1b2c3d4.md",
  ts: "2026-08-20 09:01:42",
  day: "2026-08-20",
  block: 0,
  text: "#bug #operations [[stale-recheck-cleanup]] PR #5180 lingering stale_recheck can misclassify the next re-review.",
  tags: ["bug", "operations"],
  links: ["stale-recheck-cleanup"],
  pinned: false,
  hash: "sha256:" + "a".repeat(64),
  ...over,
});

function recordingStore(ok = true): MemoryStore & { ops: MemoryOp[] } {
  const ops: MemoryOp[] = [];
  return {
    ops,
    read: async () => [],
    search: async () => [],
    apply: async (op) => {
      ops.push(op);
      return ok ? { ok: true, message: "updated" } : { ok: false, message: "refused: stale hash" };
    },
  };
}

const NOW_ISO = "2026-08-29T12:00:00.000Z";
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function tracker(): string {
  const root = mkdtempSync(join(tmpdir(), "sink-tracker-"));
  roots.push(root);
  mkdirSync(join(root, ".ids"), { recursive: true });
  mkdirSync(join(root, "efforts/review-sandbox/tickets"), { recursive: true });
  return root;
}

describe("wayfinder sink", () => {
  it("files an unfiled defect and stamps filed= back through the store", async () => {
    const root = tracker();
    const store = recordingStore();
    const sink = new WayfinderIssueSink(
      { root, effort: "review-sandbox", parent: "FT-0026" },
      store,
    );
    const report = await sink.file([entry()], NOW_ISO);
    expect(report.refused).toBeUndefined();
    expect(report.filed).toHaveLength(1);
    expect(report.filed[0]!.id).toMatch(/^FT-\d{4}$/);
    expect(report.filed[0]!.key).toBe(memoryKey(entry()));
    const tickets = readdirSync(join(root, "efforts/review-sandbox/tickets"));
    expect(tickets).toHaveLength(1);
    expect(
      readFileSync(join(root, "efforts/review-sandbox/tickets", tickets[0]!), "utf8"),
    ).toContain("by qcr-tui");
    expect(store.ops[0]).toMatchObject({ op: "edit" });
    expect((store.ops[0] as { text: string }).text).toContain(`filed=${report.filed[0]!.id}`);
  });

  it("skips entries already stamped, and quiet-skips a broken tracker (refusal-free, throw-free)", async () => {
    const root = tracker();
    const sink = new WayfinderIssueSink(
      { root, effort: "review-sandbox", parent: "FT-0026" },
      recordingStore(),
    );
    const stamped = entry({ text: "#bug filed=FT-0001 already filed defect." });
    expect(await sink.file([stamped], NOW_ISO)).toEqual({ filed: [] });

    const dead = new WayfinderIssueSink({
      root: join(root, "no-such-tracker"),
      effort: "e",
      parent: "FT-0001",
    });
    await expect(dead.file([entry()], NOW_ISO)).resolves.toEqual({ filed: [] });
  });
});

// ---- github sink ------------------------------------------------------------

const tuiCfg = {
  ssh_host: "my-vm",
  container: "quickreview-sandbox",
  sudo_docker: true,
  remote_sandbox_root: "/opt/quickreview/sandbox",
  remote_state_dir: "/opt/quickreview/state",
  msg_timeout_s: 30,
} as unknown as TuiConfig;

const NOW = new Date("2026-08-29T12:00:00.000Z");

/** Records calls; answers each result probe from the queue. */
function runner(results: string[]): {
  ssh: SshRunner;
  calls: Array<{ argv: string[]; stdin?: string }>;
} {
  const calls: Array<{ argv: string[]; stdin?: string }> = [];
  const ssh: SshRunner = async (_host, argv, opts) => {
    calls.push({ argv, ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) });
    const isProbe = argv.some((a) => a.includes("result.json"));
    const stdout = isProbe ? (results.shift() ?? "pending") : "";
    return { ok: true, stdout, stderr: "", code: 0 } satisfies RemoteResult;
  };
  return { ssh, calls };
}

function githubSink(ssh: SshRunner, store?: MemoryStore): GithubIssueSink {
  return new GithubIssueSink(
    tuiCfg,
    ssh,
    store,
    () => NOW,
    async () => {},
  );
}

describe("github sink", () => {
  it("writes a file-issue command the daemon's OWN schema accepts, on stdin, atomically", async () => {
    const { ssh, calls } = runner(['{"ok":true,"issue":123}']);
    const report = await githubSink(ssh, recordingStore()).file([entry()], NOW_ISO);
    expect(report).toMatchObject({ filed: [{ id: "#123" }] });

    const write = calls[0]!;
    const payload = JSON.parse(write.stdin!) as Record<string, unknown>;
    // The exact bytes written are re-validated against src/commands.ts — the
    // TUI-side sink can never produce a command the whitelist rejects.
    const valid = validateCommand(payload);
    expect(valid.ok).toBe(true);
    expect(payload["command"]).toBe("file-issue");
    expect(String(payload["title"])).toContain("Auto-filed defect:");
    expect(String(payload["title"])).not.toContain("#bug"); // tags are not title material
    expect(String(payload["body"])).toContain(`Memory-key: ${memoryKey(entry())}`);
    expect(String(payload["body"])).toContain("lingering stale_recheck");
    // tmp+mv into the operator command dir — the unwedge write
    // idiom: this is the TUI filing on the operator's behalf, not a session.
    const script = write.argv[write.argv.length - 1]!;
    expect(script).toContain("cd -P '/opt/quickreview/sandbox/commands/operator'");
    expect(script).toContain(".tmp' && mv ");
  });

  it("stamps filed=#<issue> only after the daemon's receipt", async () => {
    const store = recordingStore();
    const { ssh } = runner(['{"ok":true,"issue":123}']);
    await githubSink(ssh, store).file([entry()], NOW_ISO);
    expect(store.ops).toHaveLength(1);
    expect((store.ops[0] as { text: string }).text).toContain("filed=#123");
  });

  it("a daemon refusal (cap, dedup) is a refusal-as-answer: surfaced, not stamped", async () => {
    const store = recordingStore();
    const { ssh } = runner(['{"ok":false,"reason":"issue cap reached for today (3)"}']);
    const report = await githubSink(ssh, store).file([entry()], NOW_ISO);
    expect(report.filed).toEqual([]);
    expect(report.refused).toContain("issue cap reached");
    expect(store.ops).toHaveLength(0);
  });

  it("a refusal's reason is untrusted result-dir text: control bytes stripped, one line", async () => {
    const store = recordingStore();
    const { ssh } = runner([
      JSON.stringify({ ok: false, reason: "cap\u001b[2J\u001b]0;x\u0007\nreached\u009b" }),
    ]);
    const report = await githubSink(ssh, store).file([entry()], NOW_ISO);
    expect(report.refused).toBe("cap[2J]0;x reached");
  });

  it("dry-run receipt (no issue number) still stamps — the intent is on record and the cap was spent", async () => {
    const store = recordingStore();
    const { ssh } = runner(['{"ok":true,"issue":null,"dry_run":true}']);
    const report = await githubSink(ssh, store).file([entry()], NOW_ISO);
    expect(report.filed).toEqual([{ id: "dry-run intent", key: memoryKey(entry()) }]);
    expect((store.ops[0] as { text: string }).text).toContain("filed=dry-run");
  });

  it("skips already-filed entries without touching the channel, and never throws on a dead ssh", async () => {
    const { ssh, calls } = runner([]);
    const stamped = entry({ text: "#bug filed=#99 already filed defect." });
    expect(await githubSink(ssh, recordingStore()).file([stamped], NOW_ISO)).toEqual({ filed: [] });
    expect(calls).toHaveLength(0);

    const deadSsh: SshRunner = async () => ({
      ok: false,
      stdout: "",
      stderr: "no route",
      code: 255,
    });
    const report = await githubSink(deadSsh, recordingStore()).file([entry()], NOW_ISO);
    expect(report.filed).toEqual([]);
    expect(report.refused).toContain("command write failed");
    expect(report.refused).toContain("no route"); // the cause, not a guess at one
  });

  it("title/body derivation strips the header run and keeps the entry verbatim in the body", () => {
    const e = entry({
      text: "#bug #ops pr=5180 [[some-link]] The verdict watcher drops digit-string rounds.",
    });
    expect(issueTitleFor(e)).toBe(
      "Auto-filed defect: The verdict watcher drops digit-string rounds.",
    );
    expect(issueBodyFor(e)).toContain("## Flagged entry");
    expect(issueBodyFor(e)).toContain(e.text);
  });
});

describe("none sink", () => {
  it("is inert: no filings, no refusals, nothing touched", async () => {
    await expect(new NoneIssueSink().file()).resolves.toEqual({ filed: [] });
  });
});

// ---- config → sink wiring ---------------------------------------------------

const fixture = (): string =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures/config.toml"), "utf8");

const withSink = (toml: string): string =>
  fixture().replace(/\[sink\][\s\S]*?(?=\n\[backfill\])/, `${toml}\n`);
/** The fixture with a tracker configured, as an operator who uses one sets it. */
const withTracker = (toml: string): string =>
  withSink(toml).replace(/^\[companion\]\n/m, '[companion]\ntracker_dir = "/host/tracker"\n');

describe("buildIssueSink / ticketProjection", () => {
  const ssh: SshRunner = async () => ({ ok: true, stdout: "", stderr: "", code: 0 });

  it("the fixture's kind = none builds the inert sink and no projection effort ⇒ no projection", () => {
    const cfg = parseConfig(fixture());
    expect(cfg.sink.kind).toBe("none");
    expect(buildIssueSink(cfg, ssh).kind).toBe("none");
    expect(ticketProjection(cfg)).toBeUndefined();
  });

  it("an absent [sink] section defaults to none — unconfigured = off", () => {
    const cfg = parseConfig(fixture().replace(/\[sink\][\s\S]*?(?=\n\[backfill\])/, ""));
    expect(cfg.sink.kind).toBe("none");
    expect(buildIssueSink(cfg, ssh).kind).toBe("none");
  });

  it("wayfinder: root defaults from [companion] tracker_dir, and the projection follows the config", () => {
    const cfg = parseConfig(
      withTracker(
        '[sink]\nkind = "wayfinder"\neffort = "review-sandbox"\nparent = "FT-0026"\ntickets_effort = "review-feedback-loop"',
      ),
    );
    expect(cfg.companion.tracker_dir).toBe("/host/tracker");
    expect(cfg.sink.root).toBe(cfg.companion.tracker_dir);
    expect(buildIssueSink(cfg, ssh).kind).toBe("wayfinder");
    expect(ticketProjection(cfg)).toEqual({
      root: cfg.companion.tracker_dir,
      effort: "review-feedback-loop",
    });
    // tickets_effort empty ⇒ the projection reads the filer's effort.
    const same = parseConfig(
      withTracker('[sink]\nkind = "wayfinder"\neffort = "review-sandbox"\nparent = "FT-0026"'),
    );
    expect(ticketProjection(same)!.effort).toBe("review-sandbox");
  });

  it("a wayfinder sink missing effort/parent is refused at parse — loud at boot, never a silent no-op", () => {
    expect(() =>
      parseConfig(withTracker('[sink]\nkind = "wayfinder"\nparent = "FT-0026"')),
    ).toThrow(/non-empty `effort`/);
    expect(() => parseConfig(withTracker('[sink]\nkind = "wayfinder"\neffort = "e"'))).toThrow(
      /non-empty `parent`/,
    );
    // With no tracker configured anywhere, a wayfinder sink has nowhere to write.
    expect(() =>
      parseConfig(withSink('[sink]\nkind = "wayfinder"\neffort = "e"\nparent = "FT-0026"')),
    ).toThrow(/requires a `root`/);
    expect(() => parseConfig(withSink('[sink]\nkind = "carrier-pigeon"'))).toThrow(/kind must be/);
  });

  it("github: builds the command-channel sink (no wayfinder keys required)", () => {
    const cfg = parseConfig(withSink('[sink]\nkind = "github"'));
    expect(buildIssueSink(cfg, ssh).kind).toBe("github");
  });
});
