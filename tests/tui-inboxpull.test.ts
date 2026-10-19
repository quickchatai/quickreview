// The TUI's pull of the bot's companion inbox (src/tui/inboxpull.ts): items the
// bot leaves for the retired overseer's duties reach the companion's inject dir
// and the alerts feed over the TUI's one runner, and are acked back.
//
// The "bot" here is the real CompanionInbox writing a real directory, and the
// runner executes the real `sh -c` script of each argv against it (the docker
// prefix stripped, as the local transport would run it), so the list and ack
// scripts are exercised, not mirrored. The "faux companion" reads the inject
// dir with the inject-bridge's own `pendingFiles`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pendingFiles } from "../extensions/inject-bridge.js";
import { CompanionInbox, companionInboxDir } from "../src/companioninbox.js";
import type { TuiConfig } from "../src/config.js";
import { AlertConsumer, AlertPolicy, parseAlert } from "../src/tui/alerts.js";
import {
  InboxPuller,
  inboxAlert,
  inboxAlertName,
  inboxInjectName,
  inboxInjectText,
  pullCompanionInbox,
} from "../src/tui/inboxpull.js";
import {
  INBOX_PULL_MAX,
  inboxAckArgv,
  inboxDirFor,
  inboxListArgv,
  type RemoteResult,
  type SshRunner,
} from "../src/tui/remote.js";

let root: string;
let injectDir: string;
let alertsDir: string;
let bot: CompanionInbox;
let cfg: TuiConfig;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "qcr-inboxpull-"));
  injectDir = join(root, "local", "inject", "companion");
  alertsDir = join(root, "local", "alerts");
  bot = new CompanionInbox({ root, now: clock() });
  // The sandbox root IS the bot's root here: the scripts run on this machine.
  cfg = {
    ssh_host: "my-vm",
    container: "quickreview-sandbox",
    sudo_docker: true,
    remote_sandbox_root: root,
    remote_state_dir: join(root, "state"),
    msg_timeout_s: 30,
    target: "local",
  } as unknown as TuiConfig;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A clock that ticks a second per call, so created_at orders items. */
function clock(): () => Date {
  let t = Date.parse("2026-10-19T10:00:00.000Z");
  return () => new Date((t += 1000));
}

/** Runs the argv's `sh -c <script>` on this machine, whatever docker prefix it
 * carries; records every argv. `failAck` makes the ack fail without running. */
function localRunner(opts: { failAck?: boolean } = {}): {
  ssh: SshRunner;
  argvs: string[][];
} {
  const argvs: string[][] = [];
  const ssh: SshRunner = async (_host, argv) => {
    argvs.push(argv);
    const at = argv.indexOf("sh");
    if (opts.failAck && argv.some((a) => a.includes("rm -f"))) {
      return { ok: false, stdout: "", stderr: "ssh: connection reset", code: 255 };
    }
    const r = spawnSync("sh", ["-c", argv[at + 2]!], { encoding: "utf8" });
    return {
      ok: r.status === 0,
      stdout: r.stdout,
      stderr: r.stderr,
      code: r.status,
    } satisfies RemoteResult;
  };
  return { ssh, argvs };
}

const deps = (ssh: SshRunner) => ({ cfg, ssh, injectDir, alertsDir });

describe("the argv", () => {
  it("lists and acks inside the container, the same argv over ssh and locally", () => {
    const list = inboxListArgv(cfg);
    expect(list.slice(0, 5)).toEqual(["sudo", "docker", "exec", "quickreview-sandbox", "sh"]);
    expect(list[5]).toBe("-c");
    expect(list[6]).toContain(inboxDirFor(cfg));
    expect(inboxDirFor(cfg)).toBe(`${root}/inject/companion-inbox`);
    expect(inboxDirFor(cfg)).toBe(companionInboxDir(root));
    const ack = inboxAckArgv(cfg, ["anomaly-0123456789abcdef", "eod-2026-10-19"]);
    expect(ack[6]).toContain("rm -f -- 'anomaly-0123456789abcdef.json' 'eod-2026-10-19.json'");
  });

  it("an ack names only ids of the bot's own shape", () => {
    for (const bad of ["../x", "a b", "A", "x;rm -rf /", "", "x'y", "-rf"]) {
      expect(() => inboxAckArgv(cfg, [bad]), bad).toThrow(/not an inbox item id/);
    }
  });

  it("the list is bounded", () => {
    expect(inboxListArgv(cfg)[6]).toContain(`-lt ${INBOX_PULL_MAX}`);
  });
});

describe("pullCompanionInbox", () => {
  it("an empty or absent inbox pulls nothing", async () => {
    const { ssh } = localRunner();
    expect(await pullCompanionInbox(deps(ssh))).toEqual({ delivered: [], skipped: 0 });
    expect(existsSync(injectDir)).toBe(false);
  });

  it("an anomaly and an EOD item reach the faux companion and the alerts feed, then are acked", async () => {
    bot.add("anomaly", "[anomaly] verdict_malformed on PR #7\n\nround 2 wrote no verdict");
    bot.add("login", "pi login expired on the bot; run /login");
    await bot.eodWriter()("EOD sweep for 2026-10-19\n\nRun today's end-of-day sweep.", "2026-10-19");
    await bot.heartbeatWriter()("daily heartbeat: all quiet", "2026-10-19");
    const { ssh } = localRunner();

    const res = await pullCompanionInbox(deps(ssh));
    expect(res.error).toBeUndefined();
    expect(res.delivered.map((i) => i.class)).toEqual(["anomaly", "login", "eod", "heartbeat"]);

    // The faux companion: what the unmodified inject-bridge would offer pi, in order.
    const pending = pendingFiles(injectDir);
    expect(pending).toHaveLength(4);
    const texts = pending.map((f) => readFileSync(join(injectDir, f), "utf8"));
    expect(texts[0]).toContain("[companion inbox · anomaly · ");
    expect(texts[0]).toContain("verdict_malformed on PR #7");
    expect(texts[1]).toContain("login alert");
    expect(texts[2]).toContain("[companion inbox · EOD sweep · eod-2026-10-19 · ");
    expect(texts[2]).toContain("Run today's end-of-day sweep.");
    expect(texts[3]).toContain("heartbeat");

    // The alerts feed: an anomaly and a login alert are alerts, the rest notices.
    const alerts = readdirSync(alertsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseAlert(readFileSync(join(alertsDir, f), "utf8"), f));
    expect(alerts.every((a) => a.ok)).toBe(true);
    expect(alerts.map((a) => (a.ok ? a.alert.tier : "?"))).toEqual([
      "alert",
      "alert",
      "notice",
      "notice",
    ]);

    // The bot's side is acked.
    expect(bot.list()).toEqual([]);
    expect(readdirSync(companionInboxDir(root))).toEqual([]);

    // And a second pull has nothing.
    expect((await pullCompanionInbox(deps(ssh))).delivered).toEqual([]);
  });

  it("the alert feed routes: a login alert notifies, an EOD sweep only reaches the status line", async () => {
    bot.add("login", "pi login expired on the bot; run /login");
    await bot.eodWriter()("EOD sweep for 2026-10-19", "2026-10-19");
    const { ssh } = localRunner();
    await pullCompanionInbox(deps(ssh));
    const notices: string[] = [];
    const notified: string[][] = [];
    const consumer = new AlertConsumer(alertsDir, new AlertPolicy(20), {
      notice: (t) => notices.push(t),
      badge: () => {},
      notify: (title, body) => notified.push([title, body]),
    });
    consumer.scanOnce();
    expect(notices).toHaveLength(2);
    expect(notified).toHaveLength(1);
    expect(notified[0]![0]).toContain("pi login expired");
  });

  it("a failed ack leaves the item pending, and the next pull delivers nothing twice", async () => {
    bot.add("anomaly", "[anomaly] something happened");
    const flaky = localRunner({ failAck: true });
    const first = await pullCompanionInbox(deps(flaky.ssh));
    expect(first.delivered).toHaveLength(1);
    expect(first.error).toMatch(/ack failed/);
    expect(bot.list()).toHaveLength(1);
    expect(pendingFiles(injectDir)).toHaveLength(1);

    const ok = localRunner();
    const second = await pullCompanionInbox(deps(ok.ssh));
    expect(second.error).toBeUndefined();
    expect(second.delivered).toHaveLength(1);
    // Still exactly one inject file and one alert: the names are the item's.
    expect(pendingFiles(injectDir)).toHaveLength(1);
    expect(readdirSync(alertsDir).filter((f) => f.endsWith(".json"))).toHaveLength(1);
    expect(bot.list()).toEqual([]);
  });

  it("an item the companion already consumed is not delivered again", async () => {
    const item = bot.add("anomaly", "[anomaly] consumed already");
    mkdirSync(join(injectDir, ".done"), { recursive: true });
    writeFileSync(join(injectDir, ".done", inboxInjectName(item)), "x");
    const { ssh } = localRunner();
    await pullCompanionInbox(deps(ssh));
    expect(pendingFiles(injectDir)).toEqual([]);
    expect(bot.list()).toEqual([]);
  });

  it("a line that is not an item is skipped and never acked", async () => {
    bot.add("anomaly", "[anomaly] real");
    writeFileSync(join(companionInboxDir(root), "broken.json"), "{not json\n");
    writeFileSync(
      join(companionInboxDir(root), "alien.json"),
      `${JSON.stringify({ id: "alien", class: "deploy", text: "x", created_at: "t" })}\n`,
    );
    const { ssh } = localRunner();
    const res = await pullCompanionInbox(deps(ssh));
    expect(res.delivered).toHaveLength(1);
    expect(res.skipped).toBe(2);
    expect(readdirSync(companionInboxDir(root)).sort()).toEqual(["alien.json", "broken.json"]);
  });

  it("reads at most INBOX_PULL_MAX items per pull", async () => {
    for (let i = 0; i < INBOX_PULL_MAX + 5; i++) bot.add("anomaly", `[anomaly] number ${i}`);
    const { ssh } = localRunner();
    const first = await pullCompanionInbox(deps(ssh));
    expect(first.delivered).toHaveLength(INBOX_PULL_MAX);
    const second = await pullCompanionInbox(deps(ssh));
    expect(second.delivered).toHaveLength(5);
  });

  it("a listing that fails is an error and writes nothing", async () => {
    const down: SshRunner = async () => ({ ok: false, stdout: "", stderr: "ssh: no route", code: 255 });
    const res = await pullCompanionInbox(deps(down));
    expect(res.error).toContain("no route");
    expect(existsSync(injectDir)).toBe(false);
  });

  it("an item text is the bot's, verbatim, and is never run", async () => {
    const hostile = "$(touch /tmp/pwned) `id` ; rm -rf /";
    bot.add("anomaly", hostile);
    const { ssh } = localRunner();
    await pullCompanionInbox(deps(ssh));
    const [file] = pendingFiles(injectDir);
    expect(readFileSync(join(injectDir, file!), "utf8")).toContain(hostile);
  });
});

describe("the files an item becomes", () => {
  it("names are the item's own, so a re-pull lands on them", () => {
    const item = bot.add("eod", "sweep", { id: "eod-2026-10-19" });
    expect(inboxInjectName(item)).toBe("2026-10-19T10-00-01-000Z-inbox-eod-2026-10-19.md");
    expect(inboxAlertName(item)).toBe("2026-10-19T10-00-01-000Z-inbox-eod-2026-10-19.json");
    expect(inboxInjectText(item)).toBe(
      "[companion inbox · EOD sweep · eod-2026-10-19 · 2026-10-19T10:00:01.000Z]\n\nsweep\n",
    );
  });

  it("an alert's title fits the status line", () => {
    const item = bot.add("anomaly", `[anomaly] ${"x".repeat(200)}`);
    const alert = inboxAlert(item);
    expect((alert["title"] as string).length).toBeLessThanOrEqual(60);
    expect(alert["cause"]).toBe(`inbox:${item.id}`);
    expect(parseAlert(JSON.stringify(alert), "f.json").ok).toBe(true);
  });
});

describe("InboxPuller", () => {
  it("pulls at most once per gap, never overlaps, and reports a failure once per run", async () => {
    bot.add("anomaly", "[anomaly] one");
    const lines: string[] = [];
    let t = 1_000_000;
    let calls = 0;
    let fail = false;
    const real = localRunner();
    const ssh: SshRunner = async (h, argv, o) => {
      calls++;
      return fail ? { ok: false, stdout: "", stderr: "ssh: down", code: 255 } : real.ssh(h, argv, o);
    };
    const puller = new InboxPuller(deps(ssh), (l) => lines.push(l), () => t, 20_000);

    await puller.tick();
    expect(lines.some((l) => l.includes("1 new (anomaly)"))).toBe(true);
    const afterFirst = calls;
    await puller.tick(); // inside the gap
    expect(calls).toBe(afterFirst);

    fail = true;
    t += 20_000;
    await puller.tick();
    t += 20_000;
    await puller.tick();
    expect(lines.filter((l) => l.startsWith("✖ companion inbox")).length).toBe(1);

    fail = false;
    t += 20_000;
    await puller.tick();
    fail = true;
    t += 20_000;
    await puller.tick();
    expect(lines.filter((l) => l.startsWith("✖ companion inbox")).length).toBe(2);
  });
});
