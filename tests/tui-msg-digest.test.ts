import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import { App } from "../src/tui/app.js";
import {
  InjectSender,
  injectFileName,
  injectProbeArgv,
  injectWriteArgv,
  installMessageHooks,
  isValidSessionName,
  type DeliveryState,
} from "../src/tui/msg.js";
import {
  currentDigestFile,
  digestCatArgv,
  digestKeys,
  digestListArgv,
  parseDigestList,
  renderDigestTab,
  SshDigestFetcher,
  styleDigestLine,
  type DigestState,
} from "../src/tui/digesttab.js";
import { stripAnsi } from "../src/tui/paint.js";
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
    expect(isValidSessionName("overseer")).toBe(true);
    expect(isValidSessionName("main")).toBe(true);
    expect(isValidSessionName("pr-5012; rm -rf /")).toBe(false);
    expect(isValidSessionName("../overseer")).toBe(false);
  });

  it("builds an atomic tmp+mv write with the text riding stdin only", () => {
    const argv = injectWriteArgv(TUI_DEFAULTS, "pr-5012", "f.md");
    expect(argv.slice(0, 5)).toEqual(["sudo", "docker", "exec", "-i", "quickreview-sandbox"]);
    const script = argv[argv.length - 1]!;
    expect(script).toContain("cat > '/opt/quickreview/sandbox/inject/pr-5012/.f.md.tmp'");
    expect(script).toContain(
      "mv '/opt/quickreview/sandbox/inject/pr-5012/.f.md.tmp' '/opt/quickreview/sandbox/inject/pr-5012/f.md'",
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
      { ...TUI_DEFAULTS, msg_timeout_s: timeoutS },
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
    await sender.send("pr-5012", "check send_batch too", record);
    expect(states.map(([s]) => s)).toEqual(["pending", "delivered"]);
    expect(states[1]![1]).toBe("✓ msg pr-5012 delivered");
  });

  it("reports undelivered when the write itself fails", async () => {
    const { sender, states, record } = senderWith([fail()]);
    await sender.send("pr-5012", "x", record);
    expect(states.map(([s]) => s)).toEqual(["pending", "undelivered"]);
    expect(states[1]![1]).toContain("write failed");
  });

  it("times out to undelivered (session down?) — never silent", async () => {
    const probes = Array.from({ length: 20 }, () => ok("pending\n"));
    const { sender, states, record } = senderWith([ok(""), ...probes], 10);
    await sender.send("pr-5012", "x", record);
    expect(states[states.length - 1]).toEqual([
      "undelivered",
      "✖ msg pr-5012 undelivered (session down?)",
    ]);
  });

  it("refuses to build paths from a bad session name", async () => {
    const { sender, states, calls, record } = senderWith([]);
    await sender.send("pr-1; whoami", "x", record);
    expect(states).toEqual([["undelivered", "✖ msg pr-1; whoami undelivered (bad session name)"]]);
    expect(calls).toEqual([]); // nothing ever hit ssh
  });
});

// ---- the input box flow through the App ------------------------------------

describe("quick-message input box", () => {
  it("m opens the box, typing edits, ⏎ hands the verbatim text to the sender", async () => {
    const streams = fakeStreams();
    const sshOk: SshRunner = async () => ok("");
    const app = new App(TUI_DEFAULTS, sshOk, streams.out, streams.input);
    const sent: Array<[string, string]> = [];
    installMessageHooks(app, {
      send: async (session, text, onState) => {
        sent.push([session, text]);
        onState("delivered", `✓ msg ${session} delivered`);
      },
    });
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
    expect(app.view.inputBox?.target).toBe("#5012 (pi session pr-5012)");
    streams.type("hi");
    streams.type(Buffer.from("\x1b\r")); // Alt-⏎ newline
    streams.type("there");
    streams.type("\r");
    expect(sent).toEqual([["pr-5012", "hi\nthere"]]);
    expect(app.view.inputBox).toBeUndefined();
    expect(app.view.noticeLine).toBe("✓ msg pr-5012 delivered");
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
    expect(digestListArgv(TUI_DEFAULTS).join(" ")).toContain("ls '/opt/quickreview/sandbox/digest'");
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
    expect(none).toContain("none yet — the EOD sweep writes digest/<date>.md at 18:00");
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
