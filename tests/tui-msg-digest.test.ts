import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  deliverMessage,
  InjectSender,
  injectFileName,
  injectProbeArgv,
  injectWriteArgv,
  installMessageHooks,
  isValidSessionName,
  messageRoute,
  type DeliveryState,
} from "../src/tui/msg.js";
import {
  currentDigestFile,
  digestCatArgv,
  digestKeys,
  digestListArgv,
  digestToday,
  parseDigestList,
  renderDigestTab,
  SshDigestFetcher,
  styleDigestLine,
  type DigestState,
} from "../src/tui/digesttab.js";
import { stripAnsi } from "../src/tui/paint.js";
import type { ControlRequest, ControlSender } from "../src/tui/livecontrol.js";
import type { PrRuntime } from "../src/state.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";
import { learningRig, settle } from "./helpers/tui-rig.js";

const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
const fail = (): RemoteResult => ({ ok: false, stdout: "", stderr: "", code: 1 });

function fakeStreams() {
  const out = new EventEmitter() as any;
  let buf = "";
  out.columns = 100;
  out.rows = 24;
  out.write = (s: string) => ((buf += s), true);
  const input = new EventEmitter() as any;
  input.isTTY = false;
  input.resume = () => {};
  input.pause = () => {};
  input.setRawMode = () => {};
  return {
    out,
    input,
    written: () => buf,
    type: (s: string | Buffer) => input.emit("data", Buffer.from(s)),
  };
}

// ---- inject path construction / escaping -----------------------------------

describe("quick-message inject writes", () => {
  it("accepts only the daemon's session names", () => {
    expect(isValidSessionName("pr-5012")).toBe(true);
    expect(isValidSessionName("overseer")).toBe(false);
    expect(isValidSessionName("main")).toBe(true);
    expect(isValidSessionName("pr-5012; rm -rf /")).toBe(false);
    expect(isValidSessionName("../overseer")).toBe(false);
  });

  it("builds an atomic tmp+mv write with the text riding stdin only", () => {
    const argv = injectWriteArgv(TUI_DEFAULTS, "pr-5012", "f.md");
    expect(argv.slice(0, 5)).toEqual(["sudo", "docker", "exec", "-i", "quickreview-sandbox"]);
    const script = argv[argv.length - 1]!;
    expect(script).toContain("cat > /opt/quickreview/sandbox/inject/pr-5012/.f.md.tmp");
    expect(script).toContain(
      "mv /opt/quickreview/sandbox/inject/pr-5012/.f.md.tmp /opt/quickreview/sandbox/inject/pr-5012/f.md",
    );
  });

  it("probes the bridge's .done archive for consumption", () => {
    const script = injectProbeArgv(TUI_DEFAULTS, "pr-7", "f.md")[
      injectProbeArgv(TUI_DEFAULTS, "pr-7", "f.md").length - 1
    ]!;
    expect(script).toContain("/opt/quickreview/sandbox/inject/pr-7/.done/f.md");
    expect(script).toContain("echo consumed");
  });

  it("names inject files with a sortable timestamp and .md suffix", () => {
    const name = injectFileName(new Date("2026-08-13T21:30:00.123Z"), 3);
    expect(name).toBe("2026-08-13T21-30-00-123Z-tui-0003.md");
  });
});

// ---- delivery confirmation lifecycle ---------------------------------------

describe("InjectSender", () => {
  function senderWith(sshResponses: Array<RemoteResult>, timeoutS = 30) {
    const calls: string[][] = [];
    const ssh: SshRunner = async (_h, argv) => {
      calls.push(argv);
      return sshResponses.shift() ?? fail();
    };
    let clock = 0;
    const states: Array<[DeliveryState, string]> = [];
    const sender = new InjectSender(
      { ...TUI_DEFAULTS, remote_sandbox_root: "/opt/quickreview/sandbox", msg_timeout_s: timeoutS },
      ssh,
      () => new Date(clock),
      async (ms) => {
        clock += ms;
      },
    );
    return { sender, calls, states, record: (s: DeliveryState, l: string) => states.push([s, l]) };
  }

  it("goes pending → delivered when the bridge consumes the file", async () => {
    const { sender, states, record } = senderWith([ok(""), ok("pending\n"), ok("consumed\n")]);
    await sender.send("main", "check send_batch too", record);
    expect(states.map(([s]) => s)).toEqual(["pending", "delivered"]);
    expect(states[1]![1]).toBe("✓ msg main delivered");
  });

  it("reports undelivered when the write itself fails", async () => {
    const { sender, states, record } = senderWith([fail()]);
    await sender.send("main", "x", record);
    expect(states.map(([s]) => s)).toEqual(["pending", "undelivered"]);
    expect(states[1]![1]).toContain("write failed");
    expect(states[1]![1]).toContain("exit 1"); // no stderr: the exit code
  });

  it("names the failed write's cause, one line, control bytes stripped", async () => {
    const { sender, states, record } = senderWith([
      {
        ok: false,
        stdout: "",
        stderr: "Error: No such container\u001b[2J\nquickreview-sandbox",
        code: 1,
      },
    ]);
    await sender.send("main", "x", record);
    expect(states[1]![1]).toBe(
      "✖ msg main undelivered (write failed: Error: No such container[2J quickreview-sandbox)",
    );
  });

  // The bridge consumes nothing while its session is busy, so a file still
  // pending at the timeout will be delivered later: queued, never lost.
  it("times out to queued while the file is still pending — never silent", async () => {
    const probes = Array.from({ length: 20 }, () => ok("pending\n"));
    const { sender, states, record } = senderWith([ok(""), ...probes], 10);
    await sender.send("main", "x", record);
    expect(states[states.length - 1]).toEqual([
      "queued",
      "⧗ msg main queued — will deliver when the session is idle; do not re-send",
    ]);
  });

  it("times out to unconfirmed when no probe saw the file pending", async () => {
    const { sender, states, record } = senderWith([ok(""), ok("missing\n")], 4);
    await sender.send("main", "x", record);
    expect(states[states.length - 1]![0]).toBe("unconfirmed");
    expect(states[states.length - 1]![1]).toContain("check the session before re-sending");
  });

  it("refuses a PR session: nothing reads a PR's inject directory (P9.6)", async () => {
    const { sender, states, calls, record } = senderWith([ok(""), ok("consumed\n")]);
    await sender.send("pr-5012", "x", record);
    expect(states).toEqual([
      ["undelivered", "✖ msg pr-5012 undelivered (a PR's message goes by the control route)"],
    ]);
    expect(calls).toEqual([]); // nothing ever hit ssh
  });

  it("refuses to build paths from a bad session name", async () => {
    const { sender, states, calls, record } = senderWith([]);
    await sender.send("pr-1; whoami", "x", record);
    expect(states).toEqual([["undelivered", "✖ msg pr-1; whoami undelivered (bad session name)"]]);
    expect(calls).toEqual([]); // nothing ever hit ssh
  });
});

// ---- the input box flow through the App ------------------------------------

// The action channel's message verbs read the sender's LAST word: delivered,
// queued and unconfirmed resolve with their label; only a definite
// non-delivery (undelivered, no sender) rejects — a failed
// result file asks the companion to re-send, and a queued message re-sent is
// delivered twice.
// MUTATION: reject on any state but delivered — the queued case goes red.
describe("deliverMessage — the outcome the action result carries", () => {
  it("resolves on delivered or queued, rejects on definite non-delivery", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    let final: DeliveryState = "delivered";
    installMessageHooks(app, {
      send: async (session, _text, onState) => {
        onState("pending", `→ msg ${session} pending…`);
        if (final === ("pending" as DeliveryState)) throw new Error("ssh died");
        onState(
          final,
          final === "delivered"
            ? `✓ msg ${session} delivered`
            : final === "queued"
              ? `⧗ msg ${session} queued — will deliver when the session is idle; do not re-send`
              : `✖ msg ${session} undelivered (write failed)`,
        );
      },
    });
    await expect(deliverMessage(app, "main", "hi")).resolves.toBe("✓ msg main delivered");
    final = "queued";
    await expect(deliverMessage(app, "overseer", "hi")).resolves.toMatch(
      /overseer queued .* do not re-send/,
    );
    final = "undelivered";
    await expect(deliverMessage(app, "overseer", "hi")).rejects.toThrow(
      /overseer undelivered \(write failed/,
    );
    final = "pending";
    await expect(deliverMessage(app, "main", "hi")).resolves.toMatch(/unconfirmed \(ssh died\)/);
    expect(app.view.noticeLine).toContain("ssh died");
    app.hooks.sendMessage = undefined;
    await expect(deliverMessage(app, "main", "hi")).rejects.toThrow(/not wired/);
  });
});

describe("message delivery after a transport exception", () => {
  it("a successful write followed by a throwing probe remains unconfirmed and is not offered for resend", async () => {
    const streams = fakeStreams();
    let writes = 0;
    const ssh: SshRunner = async (_host, _args, opts) => {
      if (opts?.stdin !== undefined) {
        writes++;
        return ok("");
      }
      throw new Error("probe connection lost");
    };
    const app = new App(TUI_DEFAULTS, ssh, streams.out, streams.input);
    installMessageHooks(
      app,
      new InjectSender(
        TUI_DEFAULTS,
        ssh,
        () => new Date(0),
        async () => {},
      ),
    );
    await expect(deliverMessage(app, "main", "one author reply")).resolves.toMatch(
      /unconfirmed.*probe connection lost/,
    );
    expect(writes).toBe(1);
    expect(app.view.noticeLine).toContain("do not re-send");
  });
});

describe("a receipt preceding a sender exception", () => {
  it.each(["delivered", "queued", "undelivered"] as const)(
    "preserves the known %s outcome",
    async (state) => {
      const streams = fakeStreams();
      const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
      installMessageHooks(app, {
        send: async (_session, _text, report) => {
          report(state, `known ${state}`);
          throw new Error("late transport exception");
        },
      });
      expect(await app.hooks.sendMessage!("main", "once", app)).toEqual({
        state,
        label: `known ${state}`,
      });
    },
  );
});

describe("quick-message input box", () => {
  it("m opens the box, typing edits, ⏎ hands the verbatim text to the control route", async () => {
    const streams = fakeStreams();
    const sshOk: SshRunner = async () => ok("");
    const app = new App(TUI_DEFAULTS, sshOk, streams.out, streams.input);
    const injected: string[] = [];
    const sent: ControlRequest[] = [];
    installMessageHooks(
      app,
      {
        send: async (session) => {
          injected.push(session);
        },
      },
      {
        async send(req) {
          sent.push(req);
          return { state: "handled", label: `✓ ${req.kind} #${req.pr} delivered` };
        },
      },
    );
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: [{ number: 5012, state: "reviewing", title: "t", head_sha: "x", stale_recheck: 0 }],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    const running = app.run();
    streams.type("m");
    expect(app.view.inputBox?.target).toBe("#5012 (a message to its session)");
    streams.type("hi");
    streams.type(Buffer.from("\x1b\r")); // Alt-⏎ newline
    streams.type("there");
    streams.type("\r");
    await settle();
    expect(sent).toEqual([{ kind: "message", pr: 5012, text: "hi\nthere" }]);
    expect(injected).toEqual([]); // a PR's message is never an inject file (P9.6)
    expect(app.view.inputBox).toBeUndefined();
    expect(app.view.noticeLine).toBe("✓ message #5012 delivered");
    streams.type("q");
    streams.type("y"); // q asks before it quits
    await running;
  });

  it("Esc cancels and preserves the draft until board navigation", async () => {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => fail(), streams.out, streams.input);
    installMessageHooks(app, { send: async () => {} });
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: [
        { number: 1, state: "reviewing", title: "a", head_sha: "x", stale_recheck: 0 },
        { number: 2, state: "reviewing", title: "b", head_sha: "x", stale_recheck: 0 },
      ],
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    const running = app.run();
    streams.type("m");
    streams.type("draft");
    streams.type(Buffer.from("\x1b")); // Esc
    expect(app.view.inputBox).toBeUndefined();
    streams.type("m"); // reopen: draft preserved
    expect(app.view.inputBox?.text).toBe("draft");
    streams.type(Buffer.from("\x1b"));
    streams.type("j"); // board navigation drops the draft
    streams.type("m");
    expect(app.view.inputBox?.text).toBe("");
    streams.type(Buffer.from("\x1b"));
    streams.type("q");
    streams.type("y"); // q asks before it quits
    await running;
  });
});

// ---- digest tab -------------------------------------------------------------

describe("digest tab", () => {
  it("builds read-only ls/cat argv inside the container", () => {
    expect(digestListArgv(TUI_DEFAULTS).join(" ")).toContain(
      "ls '/opt/quickreview/sandbox/digest'",
    );
    expect(digestCatArgv(TUI_DEFAULTS, "2026-08-13.md").join(" ")).toContain(
      "cat '/opt/quickreview/sandbox/digest/2026-08-13.md'",
    );
  });

  it("parses and sorts the digest listing, ignoring foreign files", () => {
    expect(parseDigestList("2026-08-12.md\njunk.txt\n2026-08-13.md\n")).toEqual([
      "2026-08-12.md",
      "2026-08-13.md",
    ]);
  });

  it("a failed listing is UNDEFINED, an empty directory is an empty list — the two are different facts", async () => {
    const dead = new SshDigestFetcher(TUI_DEFAULTS, async () => fail());
    expect(await dead.list()).toBeUndefined();
    const empty = new SshDigestFetcher(TUI_DEFAULTS, async () => ok(""));
    expect(await empty.list()).toEqual([]);
  });

  it("pages older/newer through currentDigestFile", () => {
    const st: DigestState = {
      files: ["2026-08-11.md", "2026-08-12.md", "2026-08-13.md"],
      back: 0,
      scroll: 0,
    };
    expect(currentDigestFile(st)).toBe("2026-08-13.md");
    st.back = 2;
    expect(currentDigestFile(st)).toBe("2026-08-11.md");
  });

  it("offers a page key only when there is a page that way", () => {
    const files = ["2026-08-11.md", "2026-08-12.md"];
    expect(digestKeys({ files, back: 0, scroll: 0 }).bar.map((b) => b.key)).toEqual(["["]);
    expect(digestKeys({ files, back: 1, scroll: 0 }).bar.map((b) => b.key)).toEqual(["]"]);
    expect(digestKeys({ files: [], back: 0, scroll: 0 }).bar).toEqual([]);
    expect(digestKeys({ back: 0, scroll: 0 }).bar).toEqual([]);
  });

  it("tags only the immediately preceding day as yesterday", () => {
    const render = (file: string, today: string) =>
      renderDigestTab({ files: [file], back: 0, scroll: 0, content: "x" }, true, today, 100, 24)
        .lines.map(stripAnsi)
        .join("\n");
    expect(render("2026-02-28.md", "2026-03-01")).toContain("digest 2026-02-28 (yesterday)");
    expect(render("2025-12-31.md", "2026-01-01")).toContain("digest 2025-12-31 (yesterday)");
    const old = render("2026-07-01.md", "2026-08-13");
    expect(old).toContain("digest 2026-07-01");
    expect(old).not.toContain("(yesterday)");
    expect(render("2026-08-13.md", "2026-08-13")).not.toContain("(yesterday)");
  });

  // One full-width column, with no awaiting-you panel, attach hint or click
  // zone — a document is read, not chosen from.
  it("styles headings and renders one full-width column with the yesterday tag", () => {
    expect(stripAnsi(styleDigestLine("# Reviews"))).toBe("Reviews");
    const st: DigestState = {
      files: ["2026-08-12.md"],
      back: 0,
      scroll: 0,
      content: "# Reviews\n6 PRs · 9 rounds",
    };
    const frame = renderDigestTab(st, true, "2026-08-13", 100, 24);
    const text = frame.lines.map(stripAnsi).join("\n");
    expect(text).toContain("digest 2026-08-12 (yesterday)");
    expect(text).toContain("1 days");
    expect(text).toContain("Reviews");
    expect(text).not.toContain("AWAITING YOU");
    expect(text).toContain("[3 digest]");
    expect(frame.zones).toEqual([]);
    // No interior divider: the body is one box row across the whole width.
    const body = frame.lines.map(stripAnsi)[2]!;
    expect(body.slice(1, -1)).not.toContain("│");
  });

  it("paints no carriage return or terminal control from the document", () => {
    const st: DigestState = {
      files: ["2026-08-12.md"],
      back: 0,
      scroll: 0,
      content: "# Reviews\r\nline two\x1b[2Jtail\r\n",
    };
    const painted = renderDigestTab(st, true, "2026-08-13", 100, 24).lines.join("\n");
    expect(painted).not.toContain("\r");
    expect(painted).not.toContain("\x1b[2J");
    expect(stripAnsi(painted)).toContain("line two");
  });

  it("says which of the three empties it is: not listed, could not list, none written", () => {
    const unread = stripAnsi(
      renderDigestTab({ back: 0, scroll: 0 }, false, "2026-08-13", 100, 24).lines.join("\n"),
    );
    expect(unread).toContain("digest — ── — days");
    expect(unread).toContain("not read yet — listing digest/ on the VM");
    const failed = stripAnsi(
      renderDigestTab(
        { back: 0, scroll: 0, listError: "the digest directory could not be listed over ssh" },
        false,
        "2026-08-13",
        100,
        24,
      ).lines.join("\n"),
    );
    expect(failed).toContain(
      "could not read — the digest directory could not be listed over ssh · r retries",
    );
    expect(failed).not.toContain("none yet");
    const none = stripAnsi(
      renderDigestTab({ files: [], back: 0, scroll: 0 }, false, "2026-08-13", 100, 24).lines.join(
        "\n",
      ),
    );
    expect(none).toContain("0 days");
    expect(none).toContain("none yet — the EOD sweep writes digest/<date>.md once a day");
    expect(none).not.toContain("18:00");
  });

  it("names the CONFIGURED sweep schedule, never a fixed one", () => {
    const none = stripAnsi(
      renderDigestTab({ files: [], back: 0, scroll: 0 }, false, "2026-08-13", 100, 24, {
        time: "07:30",
        timezone: "UTC",
      }).lines.join("\n"),
    );
    expect(none).toContain("the EOD sweep writes digest/<date>.md at 07:30 UTC");
    expect(none).not.toContain("Warsaw");
  });

  it("counts 'yesterday' in the sweep's zone, not in UTC", () => {
    // 00:30 in Warsaw on the 14th is still the 13th in UTC.
    const now = new Date("2026-08-13T22:30:00Z");
    const eod = { time: "18:00", timezone: "Europe/Warsaw" };
    expect(digestToday(now, eod)).toBe("2026-08-14");
    expect(digestToday(now)).toBe("2026-08-13");
    const frame = renderDigestTab(
      { files: ["2026-08-13.md"], back: 0, scroll: 0, content: "# day" },
      false,
      digestToday(now, eod),
      100,
      24,
      eod,
    );
    expect(stripAnsi(frame.lines.join("\n"))).toContain("(yesterday)");
  });

  it("an existing digest directory that cannot be listed is a failed read, not an empty one", () => {
    const script = digestListArgv(TUI_DEFAULTS).at(-1)!;
    expect(script).toBe(
      "if [ -e '/opt/quickreview/sandbox/digest' ]; then ls '/opt/quickreview/sandbox/digest'; fi",
    );
    expect(script).not.toContain("|| true");
  });

  it("the installed tab pages with [ / ] and scrolls with j/k — and a boundary key is neither consumed nor offered", async () => {
    const rig = learningRig();
    rig.app.tab = "digest";
    const tab = rig.app.hooks.tabs.digest!;
    tab.screen(rig.app, 100, 24);
    await settle();
    expect(rig.learning.store.digest.files).toEqual(["2026-08-19.md", "2026-08-20.md"]);
    expect(stripAnsi(tab.screen(rig.app, 100, 24).render())).toContain("digest 2026-08-20.md");
    expect(tab.key(rig.app, { kind: "newer" })).toBe(false); // already on the newest
    expect(rig.app.registeredKeys().has("]")).toBe(false);
    expect(tab.key(rig.app, { kind: "older" })).toBe(true);
    await settle();
    expect(rig.learning.store.digest.back).toBe(1);
    expect(stripAnsi(tab.screen(rig.app, 100, 24).render())).toContain("digest 2026-08-19.md");
    expect(rig.app.registeredKeys().has("]")).toBe(true);
    expect(rig.app.registeredKeys().has("[")).toBe(false);
    tab.key(rig.app, { kind: "down" });
    tab.key(rig.app, { kind: "down", arrow: true });
    expect(rig.learning.store.digest.scroll).toBe(2);
    tab.key(rig.app, { kind: "up" });
    expect(rig.learning.store.digest.scroll).toBe(1);
  });

  it("a failed CONTENT read is unreadable, never 'loading' forever — and r asks again", async () => {
    let dead = true;
    const rig = learningRig({
      digestFetcher: {
        list: async () => ["2026-08-20.md"],
        read: async (f) => (dead ? undefined : `# digest ${f}`),
      },
    });
    rig.app.tab = "digest";
    const tab = rig.app.hooks.tabs.digest!;
    tab.screen(rig.app, 100, 24);
    await settle();
    let screen = stripAnsi(tab.screen(rig.app, 100, 24).render());
    expect(screen).not.toContain("loading 2026-08-20.md");
    expect(screen).toContain("could not read — 2026-08-20.md could not be read over ssh");
    dead = false;
    tab.key(rig.app, { kind: "refresh" });
    await settle();
    screen = stripAnsi(tab.screen(rig.app, 100, 24).render());
    expect(screen).toContain("digest 2026-08-20");
    expect(screen).not.toContain("could not read");
  });

  it("a slow read for a day paged away from never lands under another day's heading", async () => {
    const pending = new Map<string, (text: string) => void>();
    const rig = learningRig({
      digestFetcher: {
        list: async () => ["2026-08-18.md", "2026-08-19.md", "2026-08-20.md"],
        read: (f) => new Promise((res) => pending.set(f, res)),
      },
    });
    rig.app.tab = "digest";
    const tab = rig.app.hooks.tabs.digest!;
    tab.screen(rig.app, 100, 24);
    await settle();
    pending.get("2026-08-20.md")!("# body of 2026-08-20");
    await settle();
    tab.key(rig.app, { kind: "older" }); // → 08-19, read A in flight
    tab.key(rig.app, { kind: "older" }); // → 08-18, read B in flight
    pending.get("2026-08-18.md")!("# body of 2026-08-18");
    await settle();
    pending.get("2026-08-19.md")!("# body of 2026-08-19"); // A lands LAST
    await settle();
    const screen = stripAnsi(tab.screen(rig.app, 100, 24).render());
    expect(screen).toContain("digest 2026-08-18");
    expect(screen).toContain("body of 2026-08-18");
    expect(screen).not.toContain("body of 2026-08-19");
  });

  it("paged away and back, a stale read of the same day never overwrites the fresh one", async () => {
    const pending: Array<[string, (text: string | undefined) => void]> = [];
    const rig = learningRig({
      digestFetcher: {
        list: async () => ["2026-08-19.md", "2026-08-20.md"],
        read: (f) => new Promise((res) => pending.push([f, res])),
      },
    });
    rig.app.tab = "digest";
    const tab = rig.app.hooks.tabs.digest!;
    tab.screen(rig.app, 100, 24);
    await settle();
    pending.shift()![1]("# body of 2026-08-20");
    await settle();
    tab.key(rig.app, { kind: "older" }); // → 08-19, read A in flight
    tab.key(rig.app, { kind: "newer" }); // → 08-20, read B in flight
    tab.key(rig.app, { kind: "older" }); // → 08-19, read C in flight
    const [a, b, c] = pending.splice(0);
    expect([a![0], b![0], c![0]]).toEqual(["2026-08-19.md", "2026-08-20.md", "2026-08-19.md"]);
    c![1]("# fresh body of 2026-08-19");
    await settle();
    a![1](undefined); // the stale read of the SAME day fails last
    b![1]("# body of 2026-08-20");
    await settle();
    const screen = stripAnsi(tab.screen(rig.app, 100, 24).render());
    expect(screen).toContain("fresh body of 2026-08-19");
    expect(screen).not.toContain("could not read");
  });

  it("a refresh that finds a newer day never shows the old day's text under its heading", async () => {
    let files = ["2026-08-19.md"];
    const pending = new Map<string, (text: string) => void>();
    const rig = learningRig({
      digestFetcher: {
        list: async () => files,
        read: (f) => new Promise((res) => pending.set(f, res)),
      },
    });
    rig.app.tab = "digest";
    const tab = rig.app.hooks.tabs.digest!;
    tab.screen(rig.app, 100, 24);
    await settle();
    pending.get("2026-08-19.md")!("# body of 2026-08-19");
    await settle();
    files = ["2026-08-19.md", "2026-08-20.md"]; // today's digest lands
    tab.key(rig.app, { kind: "refresh" });
    await settle(); // listed; today's read still in flight
    const screen = stripAnsi(tab.screen(rig.app, 100, 24).render());
    expect(screen).toContain("digest 2026-08-20");
    expect(screen).not.toContain("body of 2026-08-19");
    expect(screen).toContain("loading 2026-08-20.md");
  });

  it("the paint that asks for the listing is written before the listing starts", async () => {
    let lists = 0;
    const rig = learningRig({
      digestFetcher: {
        list: async () => ((lists += 1), ["2026-08-20.md"]),
        read: async () => "# d",
      },
    });
    rig.app.tab = "digest";
    rig.app.hooks.tabs.digest!.screen(rig.app, 100, 24);
    expect(lists).toBe(0); // nothing external inside the paint
    await settle();
    expect(lists).toBe(1);
  });

  it("a failed listing on the installed tab says so and r asks again", async () => {
    let dead = true;
    const rig = learningRig({
      digestFetcher: {
        list: async () => (dead ? undefined : ["2026-08-20.md"]),
        read: async () => "# d",
      },
    });
    rig.app.tab = "digest";
    const tab = rig.app.hooks.tabs.digest!;
    tab.screen(rig.app, 100, 24);
    await settle();
    expect(stripAnsi(tab.screen(rig.app, 100, 24).render())).toContain("could not read");
    dead = false;
    tab.key(rig.app, { kind: "refresh" });
    await settle();
    expect(stripAnsi(tab.screen(rig.app, 100, 24).render())).toContain("digest 2026-08-20");
  });
});

// ---- `?` help on a non-board tab ---------------------------------------------

describe("? help on a non-board tab", () => {
  const framePlain = (app: App): string =>
    ((app as unknown as { lastFrame?: { lines: string[] } }).lastFrame?.lines ?? [])
      .map(stripAnsi)
      .join("\n");

  it("paints the KEYS overlay on [3] digest, and the key that dismisses it is the one it swallows", async () => {
    const rig = learningRig();
    const running = rig.app.run();
    rig.streams.type("3");
    expect(rig.app.tab).toBe("digest");
    expect(framePlain(rig.app)).not.toContain("KEYS");
    rig.streams.type("?");
    expect(rig.app.view.help).toBe(true);
    // The bar advertises `? help` on every tab; pressing it must SHOW help —
    // a flag set with nothing painted made the next keystroke vanish unseen.
    expect(framePlain(rig.app)).toContain("KEYS");
    rig.streams.type("j");
    expect(rig.app.view.help).toBe(false);
    expect(framePlain(rig.app)).not.toContain("KEYS");
    rig.app.quit();
    await running;
  });

  it("a click while the overlay covers a tab dismisses help and never reaches the tab's hidden zones", async () => {
    const rig = learningRig();
    const running = rig.app.run();
    rig.streams.type("3");
    const tabs = (rig.app as unknown as { hooks: { tabs: Record<string, { click?: unknown }> } })
      .hooks.tabs;
    let clicks = 0;
    tabs["digest"]!.click = () => {
      clicks++;
      return true;
    };
    rig.streams.type("?");
    expect(framePlain(rig.app)).toContain("KEYS");
    rig.streams.type("\x1b[<0;10;6M");
    expect(clicks).toBe(0);
    expect(rig.app.view.help).toBe(false);
    expect(framePlain(rig.app)).not.toContain("KEYS");
    rig.streams.type("\x1b[<0;10;6M");
    expect(clicks).toBe(1);
    rig.app.quit();
    await running;
  });
});

describe("input box mouse occlusion on a tab", () => {
  it.each([18, 30])(
    "does not dispatch clicks or wheels under the painted box at %s rows",
    async (rows) => {
      const rig = learningRig();
      (rig.streams.out as unknown as { rows: number }).rows = rows;
      const running = rig.app.run();
      try {
        rig.streams.type("3");
        const tab = (
          rig.app as unknown as {
            hooks: { tabs: Record<string, { click?: () => boolean; key: () => boolean }> };
          }
        ).hooks.tabs["digest"]!;
        let clicks = 0;
        let wheels = 0;
        tab.click = () => {
          clicks++;
          return true;
        };
        tab.key = () => {
          wheels++;
          return true;
        };
        rig.app.promptInput("edit visible draft", "preserve", () => {});
        const frame = (rig.app as unknown as { lastFrame: { lines: string[] } }).lastFrame;
        const target = frame.lines.findIndex((line) => stripAnsi(line).includes("MSG →"));
        expect(target).toBeGreaterThan(0);
        for (const y of [target, target + 1, target + 2, target + 3]) {
          rig.streams.type(`\x1b[<0;10;${y}M`);
          rig.streams.type(`\x1b[<65;10;${y}M`);
        }
        expect(clicks).toBe(0);
        expect(wheels).toBe(0);
        expect(rig.app.view.inputBox?.text).toBe("preserve");
        rig.streams.type("\x1b[<0;10;6M");
        expect(clicks).toBe(1); // visible tab content still answers
      } finally {
        rig.app.quit();
        await running;
      }
    },
  );
});

it("keeps digest failures visible after scrolling a long document", () => {
  const st: DigestState = {
    files: ["2026-08-13.md"],
    back: 0,
    scroll: 900,
    contentError: "read failed",
  };
  expect(
    renderDigestTab(st, true, "2026-08-13", 100, 24).lines.map(stripAnsi).join("\n"),
  ).toContain("read failed");
  expect(st.scroll).toBe(900); // preserve document position through failed refreshes
});

it("quotes apostrophes in configured inject paths", () => {
  const cfg = { ...TUI_DEFAULTS, remote_sandbox_root: "/opt/operator's sandbox" };
  for (const argv of [injectWriteArgv(cfg, "main", "f.md"), injectProbeArgv(cfg, "main", "f.md")])
    expect(argv.at(-1)).toContain("operator'\\''s sandbox");
});

it("probes consumption after a lost write acknowledgement", async () => {
  let calls = 0;
  const sender = new InjectSender(
    { ...TUI_DEFAULTS, msg_timeout_s: 3 },
    async () =>
      ++calls === 1
        ? { ok: false, stdout: "", stderr: "connection lost", code: 255 }
        : ok("consumed"),
    () => new Date(0),
    async () => {},
  );
  const states: DeliveryState[] = [];
  await sender.send("main", "hello", (state) => states.push(state));
  expect(states.at(-1)).toBe("delivered");
});

// ---- which route a message to a PR takes, by its runtime -------------------

describe("msg.ts routes a PR message by status.json runtime", () => {
  /** An App whose snapshot gives each PR a runtime; both senders record. */
  function routed(
    runtimes: Record<number, PrRuntime | undefined>,
    controlState = "handled" as const,
  ) {
    const streams = fakeStreams();
    const app = new App(TUI_DEFAULTS, async () => ok(""), streams.out, streams.input);
    const tmux: Array<[string, string]> = [];
    const control: ControlRequest[] = [];
    const controlSender: ControlSender = {
      async send(req, onState) {
        control.push(req);
        onState("pending", `→ ${req.kind} #${req.pr} pending…`);
        const label =
          controlState === "handled"
            ? `✓ ${req.kind} #${req.pr} delivered`
            : `✖ ${req.kind} #${req.pr} refused (x)`;
        onState(controlState, label);
        return { state: controlState, label };
      },
    };
    installMessageHooks(
      app,
      {
        send: async (session, text, onState) => {
          tmux.push([session, text]);
          onState("delivered", `✓ msg ${session} delivered`);
        },
      },
      controlSender,
    );
    app.view.snapshot = {
      written_at: "",
      dry_run: true,
      prs: Object.entries(runtimes).map(([n, runtime]) => ({
        number: Number(n),
        state: "reviewing" as const,
        title: "t",
        head_sha: "x",
        stale_recheck: 0,
        ...(runtime !== undefined ? { runtime } : {}),
      })),
      running_rounds: 0,
      total_spend_usd: 0,
      heartbeat: "",
    };
    return { app, tmux, control };
  }

  it("the route is a function of the runtime alone, and there is no tmux route (P9.6)", () => {
    expect(messageRoute(undefined)).toBe("control");
    expect(messageRoute("tmux")).toBe("control");
    expect(messageRoute("a runtime a later daemon invents")).toBe("control");
    for (const r of ["worker", "answer", "idle"]) expect(messageRoute(r), r).toBe("control");
    for (const r of ["debug", "takeover"]) expect(messageRoute(r), r).toBe("terminal");
  });

  it("a runtime=tmux PR, and one with no runtime at all, go by the control route: the daemon decides", async () => {
    const { app, tmux, control } = routed({ 1: "tmux", 2: undefined });
    expect((await app.hooks.sendMessage!("pr-1", "hello", app))?.state).toBe("delivered");
    expect((await app.hooks.sendMessage!("pr-2", "hello", app))?.state).toBe("delivered");
    expect(control).toEqual([
      { kind: "message", pr: 1, text: "hello" },
      { kind: "message", pr: 2, text: "hello" },
    ]);
    expect(tmux).toEqual([]); // no inject file nothing would read
  });

  it("a runtime=worker, answer or idle PR gets `message` on the control route, not a tmux write", async () => {
    const { app, tmux, control } = routed({ 3: "worker", 4: "answer", 5: "idle" });
    for (const n of [3, 4, 5]) {
      const out = await app.hooks.sendMessage!(`pr-${n}`, `to ${n}`, app);
      expect(out).toEqual({ state: "delivered", label: `✓ message #${n} delivered` });
    }
    expect(control).toEqual([
      { kind: "message", pr: 3, text: "to 3" },
      { kind: "message", pr: 4, text: "to 4" },
      { kind: "message", pr: 5, text: "to 5" },
    ]);
    expect(control.every((c) => c.may_post === undefined)).toBe(true); // posting is the operator's explicit mark only
    expect(tmux).toEqual([]);
  });

  it("a refusal on the control route is an undelivered message", async () => {
    const { app } = routed({ 5: "idle" }, "refused" as never);
    const out = await app.hooks.sendMessage!("pr-5", "x", app);
    expect(out?.state).toBe("undelivered");
    expect(app.view.noticeLine).toContain("refused");
  });

  it("a runtime=debug or takeover PR gets no `message` and the pointer to its pi pane", async () => {
    const { app, tmux, control } = routed({ 6: "debug", 7: "takeover" });
    for (const [n, rt] of [
      [6, "debug"],
      [7, "takeover"],
    ] as const) {
      const out = await app.hooks.sendMessage!(`pr-${n}`, "hi", app);
      expect(out?.state).toBe("undelivered");
      expect(out?.label).toBe(
        `✖ msg pr-${n} not sent: #${n} runs inside pi (${rt}) — focus its pane (⏎) and type in pi`,
      );
      expect(app.view.noticeLine).toBe(out?.label);
    }
    expect(control).toEqual([]);
    expect(tmux).toEqual([]);
    await expect(deliverMessage(app, "pr-6", "hi")).rejects.toThrow(/focus its pane/);
  });

  it("the overseer and main sessions are untouched: always the inject path", async () => {
    const { app, tmux, control } = routed({ 3: "worker" });
    await app.hooks.sendMessage!("overseer", "hi", app);
    await app.hooks.sendMessage!("main", "hi", app);
    expect(tmux.map(([s]) => s)).toEqual(["overseer", "main"]);
    expect(control).toEqual([]);
  });
});
