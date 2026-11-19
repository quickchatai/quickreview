// The home's two switches, as the person meets them: the questions, in
// order, and what each answer does. A key and the `home_auto_review` /
// `home_memory` tools both start them (extensions/home.ts), and every
// question is asked of the person in the home: a tool can start a switch but
// can never answer for them, so the one confirm is always theirs.
//
// Auto-review on:   machine checks → where it runs → the memory offer (when
//                   memory is off) → one confirm → the steps
//                   (src/home/switchon.ts): it comes up in dry-run
// Go live:          the proof round (one real pull request reviewed in
//                   dry-run, its review shown) → one more confirm → the
//                   go-live step. From switch-off's question while in
//                   dry-run, or Advanced's "Dry-run or live"
// Auto-review off:  a warning naming the running round → stop at once, data
//                   kept, memory untouched
// Memory:           its RAM cost → on or off, auto-review untouched
//
// On a host-managed install (`[github] token_source = "host"`) switching
// auto-review on and going live are the host's: the home asks nothing, runs
// nothing and says whose it is. Switching it off stays, with no "Go live"
// among its answers.
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
import { HOST_STARTS_AUTO_REVIEW, runningWarning } from "./autoreview.js";

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
  proofRound: "Review it now, in dry-run",
} as const;

/** What the switches need of the home's model. */
export interface SwitchHost {
  autoReview(): Slot<AutoReviewStatus>;
  memory(): Slot<MemoryState>;
  /** The trigger label, when known. */
  trigger(): string | null;
  /** Which pull requests it picks up by itself, when known. */
  pickUp(): "label" | "all" | null;
  repo(): string | null;
  /** The selected pull request: the proof round's, when one is needed. */
  selected(): number | null;
  say(text: string, kind?: "info" | "ok" | "warn"): void;
  /** Show this in the slot until released, whatever a refresh reads. */
  hold(slot: "autoReview", v: Known<AutoReviewStatus>): void;
  hold(slot: "memory", v: Known<MemoryState>): void;
  release(slot: "autoReview" | "memory"): void;
  refresh(): Promise<string>;
}

const NEEDS_PERSON =
  "this switch asks the person in the home, and no one can answer here; nothing changed";

/** What auto-review picks up, as the install says it now. */
export interface PickUp {
  /** Which pull requests it takes by itself (src/triggerchoice.ts); null
   * when that cannot be read. */
  rule: "label" | "all" | null;
  /** The trigger label; null when it cannot be read. */
  label: string | null;
  /** It runs in dry-run (true) or posts (false); null or left out when that
   * cannot be read. Under `all` it decides what is taken: in dry-run nothing
   * is taken by itself (src/reconcile.ts). */
  dryRun?: boolean | null;
}

/** Every open pull request, as `all` takes them once it posts. */
const EVERY_OPEN = "every open pull request that is not a draft, each once, then new ones";

/** What auto-review picks up: the labelled ones (the label unknown when it
 * can't be read) and a review request; under `all`, every open pull request
 * that is not a draft once it posts, and nothing by itself while it is in
 * dry-run, where a practice review is asked for; and when which of the two
 * cannot be read, it says so rather than naming one. */
export function pickUpPhrase(p: PickUp): string {
  if (p.rule === "all")
    return p.dryRun === true
      ? `nothing by itself in dry-run (a practice review is asked for); once posting, ${EVERY_OPEN}`
      : p.dryRun === false
        ? EVERY_OPEN
        : `${EVERY_OPEN}, once posting (nothing by itself in dry-run)`;
  if (p.rule === null) return "labelled pull requests or every one (which is unknown)";
  return p.label === null
    ? "pull requests with the trigger label (which one is unknown) or a review request"
    : `pull requests labelled "${p.label}" or with a review request`;
}

/** The same, as a sentence. */
export function pickUpLine(p: PickUp): string {
  return `It picks up ${pickUpPhrase(p)}.`;
}

/** Switch-on's confirm, on what it reviews and whether it posts. */
function switchOnPosture(p: PickUp, repo: string, dry: Known<boolean>): string {
  const goLive = "Going live is its own step later: one review you read, then one more confirm.";
  const everyOpenIn = `every open pull request in ${repo} that is not a draft, each once, then new ones`;
  if (p.rule === "all")
    return dry.kind === "unknown"
      ? `Auto-review reviews ${everyOpenIn}, once it posts; while in dry-run it reviews nothing by itself. Whether it posts to GitHub is unknown: ${dry.why}.`
      : !dry.value
        ? `Auto-review reviews ${everyOpenIn}, and posts each review to GitHub.`
        : `Auto-review starts in dry-run, and while in it, it reviews nothing in ${repo} by itself: a practice review is asked for, and it records what it would post instead of posting it. Once it posts, it reviews ${EVERY_OPEN}. ${goLive}`;
  const picks = pickUpPhrase(p);
  return dry.kind === "unknown"
    ? `Auto-review reviews ${picks} in ${repo}. Whether it posts to GitHub is unknown: ${dry.why}.`
    : !dry.value
      ? `Auto-review reviews ${picks} in ${repo}, and posts each review to GitHub.`
      : `Auto-review starts in dry-run: it reviews ${picks} in ${repo}, and records what it would post instead of posting it. ${goLive}`;
}

const pickUpOf = (host: SwitchHost, dryRun: boolean | null = null): PickUp => ({
  rule: host.pickUp(),
  label: host.trigger(),
  dryRun,
});

/** Is auto-review, as last read, something to switch off? */
function isOn(s: Slot<AutoReviewStatus>): boolean {
  return s.kind === "known" && s.value.state !== "off";
}

export async function switchAutoReview(
  host: SwitchHost,
  adapters: HomeAdapters,
  ask: Ask | undefined,
): Promise<string> {
  const hosted = adapters.hostManaged?.() === true;
  // the host's to start: no machine check runs and nothing is asked
  if (hosted && !isOn(host.autoReview())) {
    host.say(`${HOST_STARTS_AUTO_REVIEW}. Nothing changed.`);
    return `auto-review is not switched on from this home: ${HOST_STARTS_AUTO_REVIEW}`;
  }
  const control = adapters.autoReview.control;
  if (!control) return "auto-review can't be switched from this home";
  if (!ask) return NEEDS_PERSON;
  return isOn(host.autoReview())
    ? switchOff(host, control, ask, { goLive: !hosted })
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
  // 4. the one confirm: it comes up in dry-run unless the config is live
  const dry = await control.dryRun();
  const repo = host.repo() ?? "your repository";
  const posture = switchOnPosture(pickUpOf(host), repo, dry);
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
  if (outcome.ok)
    host.say(
      `${outcome.detail} ${pickUpLine(pickUpOf(host, outcome.live === null ? null : !outcome.live))}`,
      "ok",
    );
  else host.say(`Auto-review did not start: ${outcome.detail}`, "warn");
  return outcome.ok
    ? `${outcome.detail}\n${outcome.steps.join("\n")}`
    : `auto-review did not start: ${outcome.detail}\n${outcome.steps.join("\n")}`;
}

async function switchOff(
  host: SwitchHost,
  control: AutoReviewControl,
  ask: Ask,
  o: { goLive: boolean } = { goLive: true },
): Promise<string> {
  const a = host.autoReview();
  // going live is offered from dry-run, where it is the home's to offer
  const dry = o.goLive && a.kind === "known" && a.value.state === "on-dry";
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

/** What going live needs of the home. */
export interface GoLiveHost {
  say(text: string, kind?: "info" | "ok" | "warn"): void;
  refresh(): Promise<string>;
  /** The selected pull request, for a proof round. */
  selected(): number | null;
}

/**
 * Go live, from dry-run: a proof round first, then one more confirm, then
 * the go-live step (which re-checks the proof against the daemon's own
 * state). The proof round is the wizard's: the daemon reviews one real pull
 * request now, in dry-run, and the person reads what it would have posted.
 * A proof already recorded stands; the go-live step judges it.
 */
export async function goLive(
  host: GoLiveHost,
  control: AutoReviewControl,
  ask: Ask,
): Promise<string> {
  let proven = (await control.proof())?.pr ?? null;
  if (proven === null) {
    const pr = host.selected();
    if (pr === null) {
      const said =
        "Going live needs a proof round first: one pull request reviewed in dry-run, which you read before anything posts. Select a pull request, then choose Go live again.";
      host.say(said, "warn");
      return "not live: no proof round yet, and no pull request is selected";
    }
    const run = await ask.select(
      `Going live needs a proof round first: auto-review reviews #${pr} now, in dry-run, and shows you what it would post. Nothing is posted.`,
      [CHOICE.cancel, CHOICE.proofRound],
    );
    if (run !== CHOICE.proofRound) return cancelled(host);
    host.say(`Reviewing #${pr} in dry-run: the proof round…`);
    let r;
    try {
      r = await control.proofRound(pr, (l) => host.say(l));
    } catch (err) {
      r = { ok: false as const, detail: String(err) };
    }
    if (!r.ok) {
      host.say(`The proof round did not finish: ${r.detail}`, "warn");
      return `not live: the proof round did not finish: ${r.detail}`;
    }
    host.say(r.detail, "ok");
    proven = pr;
  }
  const go = await ask.select(
    `Go live? You have read the review of #${proven}. Auto-review then posts each review to GitHub under your name.`,
    [CHOICE.cancel, CHOICE.goLive],
  );
  if (go !== CHOICE.goLive) return cancelled(host);
  const r = await control.goLive({ confirmed: true });
  await host.refresh();
  host.say(r.ok ? r.detail : `Not live: ${r.detail}`, r.ok ? "ok" : "warn");
  return r.ok ? r.detail : `not live: ${r.detail}`;
}

function cancelled(host: Pick<SwitchHost, "say">): string {
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
