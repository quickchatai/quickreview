// The home's two switches, as the person meets them: the questions, in
// order, and what each answer does. A key and the `home_auto_review` /
// `home_memory` tools both start them (extensions/home.ts), and every
// question is asked of the person in the home: a tool can start a switch but
// can never answer for them, so the one confirm is always theirs.
//
// Auto-review on:   machine checks → where it runs → the memory offer (when
//                   memory is off) → one confirm → the steps
//                   (src/home/switchon.ts), the go-live handed that confirm
// Auto-review off:  a warning naming the running round → stop at once, data
//                   kept, memory untouched
// Memory:           its RAM cost → on or off, auto-review untouched
import type {
  AutoReviewControl,
  AutoReviewStatus,
  HomeAdapters,
  Known,
  MemoryControl,
  MemoryState,
  Slot,
} from "./ports.js";
import { known } from "./ports.js";
import { runningWarning } from "./autoreview.js";

/** How a switch asks the person: pi's own select. */
export interface Ask {
  select(title: string, options: string[]): Promise<string | undefined>;
}

/** The answers the person picks from, each its own words. */
export const CHOICE = {
  cancel: "Cancel",
  turnOn: "Turn on auto-review",
  here: "This machine",
  elsewhere: "Another server, over ssh (advanced)",
  notNow: "Not now",
  memoryOn: "Turn on memory",
  keepOn: "Keep it on",
  switchOff: "Switch it off",
  goLive: "Go live",
} as const;

/** What the switches need of the home's model. */
export interface SwitchHost {
  autoReview(): Slot<AutoReviewStatus>;
  memory(): Slot<MemoryState>;
  /** The trigger label, when known. */
  trigger(): string | null;
  repo(): string | null;
  say(text: string, kind?: "info" | "ok" | "warn"): void;
  /** Show this in the slot until released, whatever a refresh reads. */
  hold(slot: "autoReview", v: Known<AutoReviewStatus>): void;
  hold(slot: "memory", v: Known<MemoryState>): void;
  release(slot: "autoReview" | "memory"): void;
  refresh(): Promise<string>;
}

const NEEDS_PERSON =
  "this switch asks the person in the home, and no one can answer here; nothing changed";

/** What auto-review picks up: the trigger label (unknown when it can't be
 * read) or a review request. */
export function pickUpPhrase(trigger: string | null): string {
  return trigger === null
    ? "pull requests with the trigger label (which one is unknown) or a review request"
    : `pull requests labelled "${trigger}" or with a review request`;
}

/** The same, as a sentence. */
export function pickUpLine(trigger: string | null): string {
  return `It picks up ${pickUpPhrase(trigger)}.`;
}

/** Is auto-review, as last read, something to switch off? */
function isOn(s: Slot<AutoReviewStatus>): boolean {
  return s.kind === "known" && s.value.state !== "off";
}

export async function switchAutoReview(
  host: SwitchHost,
  adapters: HomeAdapters,
  ask: Ask | undefined,
): Promise<string> {
  const control = adapters.autoReview.control;
  if (!control) return "auto-review can't be switched from this home";
  if (!ask) return NEEDS_PERSON;
  return isOn(host.autoReview())
    ? switchOff(host, control, ask)
    : switchOn(host, adapters, control, ask);
}

async function switchOn(
  host: SwitchHost,
  adapters: HomeAdapters,
  control: AutoReviewControl,
  ask: Ask,
): Promise<string> {
  // 1. the machine checks, before anything is asked
  host.say("Checking this machine: Docker, disk, ports…");
  const checks = await control.machineChecks();
  if (!checks.ok) {
    host.say(`Auto-review can't run on this machine yet: ${checks.detail}`, "warn");
    return `machine checks failed: ${checks.detail}`;
  }
  // 2. where it runs
  const where = await ask.select("Where should auto-review run?", [
    `${CHOICE.here} — ${checks.detail}`,
    CHOICE.elsewhere,
  ]);
  if (where === undefined) return cancelled(host);
  if (where === CHOICE.elsewhere) {
    host.say(
      'Auto-review on another server is set up in the advanced steps: Advanced (alt+x), "Auto-review on another server, over ssh". Nothing changed here.',
    );
    return "another server: the advanced steps set it up";
  }
  // 3. the memory offer, when memory is off
  let memory: boolean | null = null;
  const mem = host.memory();
  const memoryControl = adapters.memory.control;
  if (memoryControl && mem.kind === "known" && mem.value === "off") {
    const m = await ask.select(
      `Turn on memory too? Reviews learn this repository. It uses ${memoryControl.ramCost()}.`,
      [CHOICE.notNow, CHOICE.memoryOn],
    );
    if (m === undefined) return cancelled(host);
    memory = m === CHOICE.memoryOn;
  }
  // 4. the one confirm
  const dry = await control.dryRun();
  const repo = host.repo() ?? "your repository";
  const picks = pickUpPhrase(host.trigger());
  const posture =
    dry.kind === "known" && !dry.value
      ? `Auto-review reviews ${picks} in ${repo}, and posts each review to GitHub.`
      : `Auto-review goes live: it reviews ${picks} in ${repo}, and posts each review to GitHub under your name.`;
  const go = await ask.select(
    `${posture} It keeps running, across reboots, until you switch it off.`,
    [CHOICE.cancel, CHOICE.turnOn],
  );
  if (go !== CHOICE.turnOn) return cancelled(host);
  // the steps
  host.hold("autoReview", known({ state: "starting" }));
  if (memory === true) host.hold("memory", known("starting"));
  host.say("Starting auto-review…");
  let outcome;
  try {
    outcome = await control.switchOn({ memory, confirmed: true }, (l) => host.say(l));
  } catch (err) {
    outcome = { ok: false, live: null, detail: String(err), steps: [] as string[] };
  } finally {
    host.release("autoReview");
    host.release("memory");
  }
  await host.refresh();
  if (outcome.ok) host.say(`${outcome.detail} ${pickUpLine(host.trigger())}`, "ok");
  else host.say(`Auto-review did not start: ${outcome.detail}`, "warn");
  return outcome.ok
    ? `${outcome.detail}\n${outcome.steps.join("\n")}`
    : `auto-review did not start: ${outcome.detail}\n${outcome.steps.join("\n")}`;
}

async function switchOff(host: SwitchHost, control: AutoReviewControl, ask: Ask): Promise<string> {
  const a = host.autoReview();
  const dry = a.kind === "known" && a.value.state === "on-dry";
  const warning = runningWarning(await control.running());
  const answer = await ask.select(
    `Switch auto-review off? ${warning} All its data is kept, so switching it on again is quick.`,
    [CHOICE.keepOn, ...(dry ? [CHOICE.goLive] : []), CHOICE.switchOff],
  );
  if (answer === CHOICE.goLive) return goLive(host, control, ask);
  if (answer !== CHOICE.switchOff) return cancelled(host);
  const r = await control.switchOff();
  await host.refresh();
  if (!r.ok) {
    host.say(`Couldn't switch auto-review off: ${r.detail}`, "warn");
    return `couldn't switch auto-review off: ${r.detail}`;
  }
  host.say("Auto-review is off. Its data is kept, and memory is as it was.", "ok");
  return `auto-review is off (${r.detail}). ${warning}`;
}

async function goLive(host: SwitchHost, control: AutoReviewControl, ask: Ask): Promise<string> {
  const go = await ask.select(
    "Go live? Auto-review then posts each review to GitHub under your name.",
    [CHOICE.cancel, CHOICE.goLive],
  );
  if (go !== CHOICE.goLive) return cancelled(host);
  const r = await control.goLive({ confirmed: true });
  await host.refresh();
  host.say(r.ok ? r.detail : `Not live: ${r.detail}`, r.ok ? "ok" : "warn");
  return r.ok ? r.detail : `not live: ${r.detail}`;
}

function cancelled(host: SwitchHost): string {
  host.say("Nothing changed.");
  return "cancelled: nothing changed";
}

export async function switchMemory(
  host: SwitchHost,
  adapters: HomeAdapters,
  ask: Ask | undefined,
): Promise<string> {
  const control: MemoryControl | undefined = adapters.memory.control;
  if (!control) return "memory can't be switched from this home";
  if (!ask) return NEEDS_PERSON;
  const s = host.memory();
  if (s.kind === "known" && s.value !== "off") {
    const a = await ask.select("Switch memory off? What it learned is kept.", [
      CHOICE.keepOn,
      CHOICE.switchOff,
    ]);
    if (a !== CHOICE.switchOff) return cancelled(host);
    const r = await control.switchOff();
    await host.refresh();
    host.say(r.ok ? r.detail : `Couldn't switch memory off: ${r.detail}`, r.ok ? "ok" : "warn");
    return r.ok ? "memory is off" : `couldn't switch memory off: ${r.detail}`;
  }
  const a = await ask.select(
    `Turn on memory? Reviews remember this repository's conventions and past findings. It uses ${control.ramCost()}.`,
    [CHOICE.notNow, CHOICE.memoryOn],
  );
  if (a !== CHOICE.memoryOn) return cancelled(host);
  host.hold("memory", known("starting"));
  let r;
  try {
    r = await control.switchOn((l) => host.say(l));
  } catch (err) {
    r = { ok: false as const, detail: String(err) };
  } finally {
    host.release("memory");
  }
  await host.refresh();
  host.say(r.ok ? r.detail : `Memory did not start: ${r.detail}`, r.ok ? "ok" : "warn");
  return r.ok ? "memory is on" : `memory did not start: ${r.detail}`;
}
