// The home's two switches (src/home/switches.ts) through its factory, on a
// fake pi with a fake auto-review adapter and a fake memory adapter: a key or
// a `home_*` tool starts a switch, the person answers each question (pi's
// select, scripted here), and the test asserts what was asked, in what
// order, what was asked of the outside world, and what the panel shows.
import { describe, expect, it } from "vitest";
import { createHome } from "../extensions/home.js";
import { CHOICE } from "../src/home/switches.js";
import {
  known,
  unknown,
  type AutoReviewControl,
  type AutoReviewStatus,
  type HomeAdapters,
  type Known,
  type MemoryControl,
  type MemoryState,
  type RunningRound,
  type SwitchOnAnswers,
} from "../src/home/ports.js";
import { fakePi, settle, type FakePi } from "./helpers/fake-pi.js";

/** A key's switch runs on past the key's own settle: let it finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 10; i++) await settle();
}

const NOW = Date.parse("2026-10-26T12:00:00Z");

/** The machine: what the fake adapters read and what their switches did. */
interface Machine {
  auto: AutoReviewStatus["state"];
  memory: MemoryState;
  dryRun: Known<boolean>;
  machineChecks: { ok: true; detail: string } | { ok: false; detail: string };
  running: Known<readonly RunningRound[]>;
  /** What switch-on finds and leaves: live or dry-run. */
  goesLive: boolean;
  /** Everything asked of the outside world, in order. */
  log: string[];
  answers: SwitchOnAnswers[];
}

function machine(over: Partial<Machine> = {}): Machine {
  return {
    auto: "off",
    memory: "off",
    dryRun: known(true),
    machineChecks: { ok: true, detail: "Docker 27 · 41 GB free · port 8787 is free" },
    running: known([]),
    goesLive: true,
    log: [],
    answers: [],
    ...over,
  };
}

function adaptersOver(m: Machine): HomeAdapters {
  const control: AutoReviewControl = {
    machineChecks: async () => {
      m.log.push("auto.machineChecks");
      return m.machineChecks;
    },
    dryRun: async () => m.dryRun,
    switchOn: async (answers, progress) => {
      m.log.push("auto.switchOn");
      m.answers.push(answers);
      progress?.("bringup: pulling the images");
      m.auto = m.goesLive ? "on-live" : "on-dry";
      if (answers.memory === true) m.memory = "on";
      return {
        ok: true,
        live: m.goesLive,
        detail: m.goesLive ? "Auto-review is on and posts live." : "Auto-review is on in dry-run.",
        steps: ["topology: local"],
      };
    },
    goLive: async () => {
      m.log.push("auto.goLive");
      m.auto = "on-live";
      return { ok: true, detail: "Auto-review posts live now." };
    },
    running: async () => {
      m.log.push("auto.running");
      return m.running;
    },
    switchOff: async () => {
      m.log.push("auto.switchOff");
      m.auto = "off";
      return { ok: true, detail: "the daemon is stopped; its data is kept" };
    },
  };
  const memory: MemoryControl = {
    ramCost: () => "up to 4 GB of RAM",
    switchOn: async () => {
      m.log.push("memory.switchOn");
      m.memory = "on";
      return { ok: true, detail: "Memory is on." };
    },
    switchOff: async () => {
      m.log.push("memory.switchOff");
      m.memory = "off";
      return { ok: true, detail: "Memory is off. What it learned is kept." };
    },
  };
  return {
    login: { providers: async () => known(["openai-codex"]) },
    github: {
      user: async () => known("octo"),
      openPulls: async () => known([]),
      openInBrowser: async () => ({ ok: true }),
    },
    repo: { repo: async () => known("acme/widgets") },
    clock: { now: () => NOW },
    reviews: { latest: async () => known(new Map()) },
    autoReview: {
      status: async () => known({ state: m.auto, checkedAt: NOW - 30_000 }),
      trigger: async () => known("AI review requested"),
      control,
    },
    memory: { status: async () => known(m.memory), control: memory },
    spend: { totals: async () => unknown("not yet") },
  };
}

interface Asked {
  title: string;
  options: string[];
}

/** A home whose person answers each select with the next scripted answer
 * (picked by its start, so a test names "This machine" without its detail). */
async function home(
  m: Machine,
  answers: Array<string | undefined>,
  o: { hasUI?: boolean } = {},
): Promise<{ pi: FakePi; asked: Asked[]; text: () => string }> {
  const asked: Asked[] = [];
  const pi = fakePi();
  const ui = pi.ctx.ui as unknown as {
    select: (t: string, o: string[]) => Promise<string | undefined>;
  };
  ui.select = async (title, options) => {
    asked.push({ title, options });
    const want = answers.shift();
    return want === undefined ? undefined : options.find((x) => x.startsWith(want));
  };
  if (o.hasUI === false) (pi.ctx as unknown as { hasUI: boolean }).hasUI = false;
  await createHome({
    adapters: adaptersOver(m),
    model: "openai-codex/gpt-6.1-sol",
    tools: "reviewer",
    every: () => () => {},
  })(pi.api);
  await pi.start();
  return { pi, asked, text: () => pi.render(100, 40).lines.join("\n") };
}

describe("switching auto-review on", () => {
  // MUTATION: ask the confirm before the memory offer, or skip the machine checks — this fails.
  it("runs the machine checks, asks where, offers memory, then one confirm, in that order", async () => {
    const m = machine();
    const h = await home(m, [CHOICE.here, CHOICE.notNow, CHOICE.turnOn]);
    const said = await h.pi.tool("home_auto_review");
    expect(m.log).toEqual(["auto.machineChecks", "auto.switchOn"]);
    expect(h.asked.map((a) => a.title)).toEqual([
      "Where should auto-review run?",
      "Turn on memory too? Reviews learn this repository. It uses up to 4 GB of RAM.",
      expect.stringMatching(
        /^Auto-review goes live: it reviews pull requests labelled "AI review requested" or with a review request in acme\/widgets, and posts each review to GitHub under your name\. It keeps running, across reboots, until you switch it off\.$/,
      ),
    ]);
    expect(h.asked[0]!.options).toEqual([
      `${CHOICE.here} — Docker 27 · 41 GB free · port 8787 is free`,
      CHOICE.elsewhere,
    ]);
    // the confirm offers Cancel first: the go-live is never the default
    expect(h.asked[2]!.options).toEqual([CHOICE.cancel, CHOICE.turnOn]);
    expect(m.answers).toEqual([{ memory: false, confirmed: true }]);
    expect(said).toMatch(/Auto-review is on and posts live\./);
    expect(h.text()).toMatch(/● Auto-review on · live/);
    expect(h.text()).toMatch(/picks up pull requests labelled "AI review requested"/);
  });

  // MUTATION: call control.switchOn before the confirm's answer is read — this fails.
  it("changes nothing unless the person confirms, at every question", async () => {
    for (const script of [
      [undefined],
      [CHOICE.here, undefined],
      [CHOICE.here, CHOICE.notNow, CHOICE.cancel],
      [CHOICE.here, CHOICE.notNow, undefined],
    ]) {
      const m = machine();
      const h = await home(m, [...script]);
      expect(await h.pi.tool("home_auto_review")).toMatch(/cancelled: nothing changed/);
      expect(m.log).toEqual(["auto.machineChecks"]);
      expect(h.text()).toMatch(/○ Auto-review off/);
    }
  });

  it("stops at failed machine checks, before asking anything", async () => {
    const m = machine({ machineChecks: { ok: false, detail: "docker not runnable (exit 127)" } });
    const h = await home(m, []);
    expect(await h.pi.tool("home_auto_review")).toMatch(
      /machine checks failed: docker not runnable/,
    );
    expect(h.asked).toEqual([]);
    expect(m.log).toEqual(["auto.machineChecks"]);
  });

  it("another server goes to the advanced steps and switches nothing here", async () => {
    const m = machine();
    const h = await home(m, [CHOICE.elsewhere]);
    expect(await h.pi.tool("home_auto_review")).toMatch(/advanced steps/);
    expect(m.log).toEqual(["auto.machineChecks"]);
  });

  it("offers memory only while it is off, and passes the person's yes on", async () => {
    const on = machine({ memory: "on" });
    const h1 = await home(on, [CHOICE.here, CHOICE.turnOn]);
    await h1.pi.tool("home_auto_review");
    expect(h1.asked.map((a) => a.title)).not.toContainEqual(expect.stringMatching(/memory/));
    expect(on.answers).toEqual([{ memory: null, confirmed: true }]);

    const off = machine();
    const h2 = await home(off, [CHOICE.here, CHOICE.memoryOn, CHOICE.turnOn]);
    await h2.pi.tool("home_auto_review");
    expect(off.answers).toEqual([{ memory: true, confirmed: true }]);
    expect(h2.text()).toMatch(/● Memory on/);
  });

  it("on a machine already live, the confirm does not claim to go live", async () => {
    const m = machine({ dryRun: known(false) });
    const h = await home(m, [CHOICE.here, CHOICE.notNow, CHOICE.turnOn]);
    await h.pi.tool("home_auto_review");
    expect(h.asked[2]!.title).toMatch(/^Auto-review reviews pull requests/);
  });

  it("a go-live the go-live step refuses leaves it on in dry-run, and says so", async () => {
    const m = machine({ goesLive: false });
    const h = await home(m, [CHOICE.here, CHOICE.notNow, CHOICE.turnOn]);
    expect(await h.pi.tool("home_auto_review")).toMatch(/dry-run/);
    expect(h.text()).toMatch(/● Auto-review on · dry-run/);
  });

  // MUTATION: let switchAutoReview run without asking when there is no UI — this fails.
  it("a tool cannot answer for the person: with no one to ask, nothing changes", async () => {
    const m = machine();
    const h = await home(m, [], { hasUI: false });
    expect(await h.pi.tool("home_auto_review")).toMatch(/asks the person in the home/);
    expect(m.log).toEqual([]);
    // and the tool takes no confirm of its own
    expect(h.pi.tools.get("home_auto_review")!.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("the key and the panel's own key run the same switch", async () => {
    const m = machine();
    const h = await home(m, [CHOICE.here, CHOICE.notNow, CHOICE.turnOn]);
    expect(h.text()).toMatch(/○ Auto-review off\s+alt\+a turns it on/);
    await h.pi.key("alt+a");
    await drain();
    expect(m.log).toEqual(["auto.machineChecks", "auto.switchOn"]);

    const m2 = machine();
    const h2 = await home(m2, [CHOICE.here, CHOICE.notNow, CHOICE.turnOn]);
    await h2.pi.key("f2");
    await h2.pi.input("a");
    await drain();
    expect(m2.log).toEqual(["auto.machineChecks", "auto.switchOn"]);
  });
});

describe("switching auto-review off", () => {
  // MUTATION: leave the running round out of the warning — this fails.
  it("warns, naming the running round, then stops", async () => {
    const m = machine({ auto: "on-live", running: known([{ pr: 12, round: 2 }]) });
    const h = await home(m, [CHOICE.switchOff]);
    expect(h.text()).toMatch(/● Auto-review on · live/);
    const said = await h.pi.tool("home_auto_review");
    expect(h.asked).toEqual([
      {
        title:
          "Switch auto-review off? A review of #12 is running and will be stopped. All its data is kept, so switching it on again is quick.",
        options: [CHOICE.keepOn, CHOICE.switchOff],
      },
    ]);
    expect(m.log).toEqual(["auto.running", "auto.switchOff"]);
    expect(said).toMatch(/auto-review is off/);
    expect(h.text()).toMatch(/○ Auto-review off/);
  });

  it("keeps it on when the person says so", async () => {
    const m = machine({ auto: "on-live" });
    const h = await home(m, [CHOICE.keepOn]);
    await h.pi.tool("home_auto_review");
    expect(m.log).toEqual(["auto.running"]);
  });

  it("says it does not know what runs when it cannot read it, and still asks", async () => {
    const m = machine({ auto: "broken", running: unknown("docker exec failed") });
    const h = await home(m, [CHOICE.switchOff]);
    await h.pi.tool("home_auto_review");
    expect(h.asked[0]!.title).toMatch(
      /Whether a review is running is unknown \(docker exec failed\); one that is will be stopped\./,
    );
    expect(m.log).toContain("auto.switchOff");
  });

  it("a second switch-on after it is off is the same short sequence, with its data kept", async () => {
    const m = machine({ auto: "on-live", memory: "on" });
    const h = await home(m, [CHOICE.switchOff, CHOICE.here, CHOICE.turnOn]);
    await h.pi.tool("home_auto_review");
    await h.pi.tool("home_auto_review");
    expect(m.log).toEqual([
      "auto.running",
      "auto.switchOff",
      "auto.machineChecks",
      "auto.switchOn",
    ]);
    expect(h.text()).toMatch(/● Auto-review on · live/);
  });

  it("from dry-run the person can go live instead, through the same confirm", async () => {
    const m = machine({ auto: "on-dry" });
    const h = await home(m, [CHOICE.goLive, CHOICE.goLive]);
    await h.pi.tool("home_auto_review");
    expect(h.asked[0]!.options).toEqual([CHOICE.keepOn, CHOICE.goLive, CHOICE.switchOff]);
    expect(h.asked[1]!.options).toEqual([CHOICE.cancel, CHOICE.goLive]);
    expect(m.log).toEqual(["auto.running", "auto.goLive"]);
  });
});

describe("the memory switch, on its own", () => {
  it("shows its RAM cost while off, and turns on after the person's yes", async () => {
    const m = machine();
    const h = await home(m, [CHOICE.memoryOn]);
    expect(h.text()).toMatch(/○ Memory off · up to 4 GB of RAM · alt\+m/);
    await h.pi.tool("home_memory");
    expect(h.asked[0]!.title).toMatch(/It uses up to 4 GB of RAM\.$/);
    expect(m.log).toEqual(["memory.switchOn"]);
    expect(h.text()).toMatch(/● Memory on/);
  });

  // MUTATION: make switchOff stop memory too — this fails.
  it("switching auto-review off leaves memory as it was", async () => {
    const m = machine({ auto: "on-live", memory: "on" });
    const h = await home(m, [CHOICE.switchOff]);
    await h.pi.tool("home_auto_review");
    expect(m.log.filter((l) => l.startsWith("memory."))).toEqual([]);
    expect(m.memory).toBe("on");
    expect(h.text()).toMatch(/● Memory on/);
  });

  it("switching memory never touches auto-review", async () => {
    const m = machine({ auto: "on-live", memory: "on" });
    const h = await home(m, [CHOICE.switchOff]);
    await h.pi.key("alt+m");
    await drain();
    expect(m.log).toEqual(["memory.switchOff"]);
    expect(h.text()).toMatch(/● Auto-review on · live/);
    expect(h.text()).toMatch(/○ Memory off/);
  });

  it("changes nothing on Not now", async () => {
    const m = machine();
    const h = await home(m, [CHOICE.notNow]);
    expect(await h.pi.tool("home_memory")).toMatch(/nothing changed/);
    expect(m.log).toEqual([]);
  });
});
