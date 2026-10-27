// /qcr-scan: the whole-repo scan, run by the plugin's own scan engine
// (src/scan/) in this pi process. No `qcr` CLI is involved: the plugin never
// runs it. The scan reads the repo pi stands in, its cases SDK sessions of this
// pi behind the bash guard (scancases.ts). Its state (the unit cut, the
// ledger, the findings) is this repo's own, under the qcr state home; the
// config is the person's qcr config when there is one, else the shipped
// defaults, and it is only read.
//
// /qcr-scan with no subcommand is the guided run: price it, ask, then start
// it in the background. The command returns once the run has started; the
// status line shows its progress, and the new findings arrive as a message
// when it ends. One scan runs per session; `/qcr-scan stop` (or the session
// ending) stops it, and the ledger keeps what finished. A repo scanned for the
// first time gets a unit cut proposed from its layout and saved, once the
// person agrees. `--preview` prices the run and starts nothing.
//
// `/qcr-scan <subcommand> …` is the scan's verb of that name, the same one
// `qcr scan <subcommand>` runs (scan/scanverbs.ts), answered here. A start
// runs in the background in this pi, like the guided one. What is the app's
// stays the app's: the scan sandbox (`login`, `doctor`, `rebuild`) and the
// triage (`dismiss`, which writes reviewer memory) are `qcr scan`'s.
//
// The guided run, waited for, is also the app's /selfimprove's first half
// (the app's src/selfimprove.ts): the scan, then the findings to the
// person's agent.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { assetRoot } from "../assetroot.js";
import { homeProfileLookup, loadOneShotConfig, stateHome } from "../homes.js";
import type { CoreConfig } from "../reviewconfig.js";
import { scanConfigOf } from "../scan/scanagents.js";
import { assembleScan, type AssembledScan } from "../scan/scanassemble.js";
import { checkoutReader, stateHomeFs } from "../scan/scanfs.js";
import type { CaseRunner, Refusal } from "../scan/scanports.js";
import { listFindings, type ScanVerbs } from "../scan/scanrender.js";
import type { ScanRun, ScanStatus } from "../scan/scanrun.js";
import {
  findingJson,
  parseScanArgs,
  runScanVerb,
  type DetachOutcome,
  type FindingJson,
} from "../scan/scanverbs.js";
import { UnitCutStore } from "../scan/unitcutstore.js";
import { PI_REFRESH_MARGIN_MS } from "../engine/auth.js";
import { splitArgs } from "./args.js";
import { borrowLogin } from "./login.js";
import { reviewProviders } from "../modelroute.js";
import { PLUGIN_CASE_MS, pluginScanCases } from "./scancases.js";
import type { PluginHost, SessionUi } from "./session.js";

/** The npm package of the QuickReview app (the `qcr` CLI). The scan does not
 * need it; /qcr-setup's checks still name it. */
export const QCR_PACKAGE = "@quickchatai/quickreview";

/** The scan subcommands, as `qcr scan` names them. */
export const SCAN_SUBCOMMANDS = [
  "preview",
  "start",
  "status",
  "stop",
  "findings",
  "matches",
  "match",
  "suggestions",
  "stage2",
  "dismiss",
  "units",
  "login",
  "doctor",
  "rebuild",
] as const;

/** The subcommands that are the app's: the scan sandbox's, and the triage's
 * dismissal (it writes reviewer memory, which the plugin has none of). */
export const APP_SUBCOMMANDS: readonly string[] = ["login", "doctor", "rebuild", "dismiss"];

export const SCAN_COMMAND_USAGE =
  "usage: /qcr-scan [--delta] [--sha REF] [--preview] | /qcr-scan <scan subcommand> …";

/** How the scan's answers name the next step here. */
export const PLUGIN_SCAN_VERBS: ScanVerbs = {
  start: (p) =>
    `/qcr-scan start --key ${p.key} --sha ${p.sha}${p.mode === "delta" ? " --delta" : ""}`,
  matches: "/qcr-scan matches",
  match: (key) => `/qcr-scan match --key ${key} OLD=NEW… — the pairs`,
  stage2Start: (key) =>
    `/qcr-scan stage2 start --key ${key} — only after you agreed to the cost. ` +
    "To run only some rows: add --rows with their ids (e.g. --rows row-1,row-3) — only runnable rows, and the run stops hard at their total.",
  status: "/qcr-scan status",
  stop: "/qcr-scan stop",
};

/** A scan finding as the scan's `--json` lists it. */
export type ScanFinding = FindingJson;

/** The guided run's options. */
export interface ScanOptions {
  delta: boolean;
  sha?: string;
  /** Price it, start nothing. */
  preview?: boolean;
}

/** `/qcr-scan`'s arguments: the guided run's flags, or a subcommand. */
export function parseScanCommand(
  line: string,
): { kind: "guided"; o: ScanOptions } | { kind: "pass"; argv: string[] } | { error: string } {
  const a = splitArgs(line);
  if (a.length > 0 && (SCAN_SUBCOMMANDS as readonly string[]).includes(a[0]!))
    return { kind: "pass", argv: a };
  const o: ScanOptions = { delta: false };
  for (let i = 0; i < a.length; i++) {
    const w = a[i]!;
    const next = a[i + 1];
    if (w === "--delta") o.delta = true;
    else if (w === "--preview") o.preview = true;
    else if (w === "--sha" && next !== undefined && !next.startsWith("--")) {
      o.sha = next;
      i++;
    } else if (w === "--sandbox")
      return {
        error: `the scan sandbox is the app's (qcr scan, [scan] sandbox): here the scan runs in this pi, its cases behind the bash guard\n${SCAN_COMMAND_USAGE}`,
      };
    else return { error: `unknown argument ${w}\n${SCAN_COMMAND_USAGE}` };
  }
  return { kind: "guided", o };
}

/** This repo's own scan state home, under the person's qcr state home: the
 * repo's directory name and a hash of its real path, so two repos never share
 * a unit cut, a ledger or a findings store. */
export function repoScanHome(env: NodeJS.ProcessEnv, cwd: string): string {
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // a cwd that cannot be resolved keys on its spelling
  }
  const name = basename(real).replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
  return join(stateHome(env), "repos", `${name}-${hash}`);
}

/** Where this repo's scan keeps its state: `QCR_STATE_HOME` when the person
 * set one, else the repo's own home under the qcr state home. */
export function scanStateHome(host: Pick<PluginHost, "env" | "cwd">): string {
  return host.env["QCR_STATE_HOME"]?.trim()
    ? stateHome(host.env)
    : repoScanHome(host.env, host.cwd);
}

/** The seams a test replaces. */
export interface ScanCommandDeps {
  /** The core's data root. */
  root: () => string;
  /** The case runner a run's cases go to. Default: SDK sessions of this pi. */
  cases: (o: Parameters<typeof pluginScanCases>[0]) => CaseRunner;
}

export const SCAN_DEPS: ScanCommandDeps = { root: assetRoot, cases: pluginScanCases };

/** The scan engine of one repo in this session. */
interface RepoScan extends AssembledScan {
  /** The host the latest command came from: the cases borrow its login. */
  host: PluginHost;
  units: UnitCutStore;
  /** The config as it reads now, or why it cannot be read. */
  config: () => { ok: true; cfg: CoreConfig } | Refusal;
  log: (line: string) => void;
}

/** A session's scans: one engine per repo (so a run started here is the one
 * every later `/qcr-scan` sees), and at most one run in flight. */
export class ScanSessions {
  private readonly engines = new Map<string, RepoScan>();
  private current: { label: string; done: Promise<void> } | null = null;

  /** What is being scanned now; null when nothing is. */
  get running(): string | null {
    return this.current?.label ?? null;
  }

  /** Resolves once no scan runs. */
  async idle(): Promise<void> {
    while (this.current !== null) await this.current.done;
  }

  /** Hold `done` as the run in flight until it settles. */
  hold(label: string, done: Promise<void>): void {
    const entry = { label, done };
    this.current = entry;
    void done.finally(() => {
      if (this.current === entry) this.current = null;
    });
  }

  /** The engine of the repo `host` stands in, built on first use. */
  engine(host: PluginHost, deps: ScanCommandDeps): RepoScan {
    const home = scanStateHome(host);
    const known = this.engines.get(home);
    if (known) {
      known.host = host;
      return known;
    }
    const built = buildRepoScan(host, home, deps);
    this.engines.set(home, built);
    return built;
  }
}

/** The sessions a caller with none of its own shares (the app's /selfimprove). */
const SHARED_SESSIONS = new ScanSessions();

/** The scan engine over `home` for the repo `host` stands in. */
function buildRepoScan(host: PluginHost, home: string, deps: ScanCommandDeps): RepoScan {
  const env: NodeJS.ProcessEnv = { ...host.env, HOME: host.home };
  const root = deps.root();
  const logFile = join(home, "scan", "plugin.log");
  const log = (line: string): void => {
    try {
      mkdirSync(join(home, "scan"), { recursive: true });
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // a diagnostics line that cannot be kept never costs the scan
    }
  };
  const profiles = homeProfileLookup(env);
  const config = (): { ok: true; cfg: CoreConfig } | Refusal => {
    try {
      const loaded = loadOneShotConfig({ root, env, warn: log });
      return { ok: true, cfg: scanConfigOf(loaded.cfg, root, profiles) };
    } catch (err) {
      return {
        ok: false,
        errors: [
          `the config or its profile cannot be read: ${err instanceof Error ? err.message : String(err)}`,
        ],
      };
    }
  };
  // The engine outlives one command: its cases read the latest command's host.
  let repo: RepoScan | null = null;
  const units = new UnitCutStore({
    repo: checkoutReader(host.cwd),
    state: stateHomeFs(home),
    clock: () => new Date(),
  });
  const assembled = assembleScan({
    home,
    reviewedRepo: host.cwd,
    root,
    config,
    profiles,
    unitCut: units,
    cases: ({ agentsDir, transcriptDir, stop }) =>
      deps.cases({
        host: () => repo?.host ?? host,
        root,
        home,
        // the configuration the latest start built its agents from
        providers: () => {
          const c = config();
          return c.ok ? reviewProviders(c.cfg) : [];
        },
        agentsDir,
        transcriptDir,
        stop,
      }),
    log,
  });
  repo = { ...assembled, host, units, config, log };
  return repo;
}

const usd = (n: number | null): string => (n === null ? "an unknown price" : `$${n.toFixed(2)}`);

const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
};

/** The status line for the run in flight: its cases, what it spent against
 * its hard stop, and the time since it started. */
export function scanStatusLine(run: ScanRun | null, startedAt: number, now: number): string {
  const since = elapsed(now - startedAt);
  if (run === null) return `QuickReview: scanning… ${since}`;
  const done = run.cases.filter((c) => c.status === "done" || c.status === "failed").length;
  const found = run.cases.reduce((n, c) => n + c.findings, 0);
  return (
    `QuickReview: scanning ${done}/${run.cases.length} case${run.cases.length === 1 ? "" : "s"}` +
    ` · ${usd(run.spent_usd)} of ${usd(run.cap_usd)}` +
    `${found > 0 ? ` · ${found} finding${found === 1 ? "" : "s"}` : ""} · ${since}`
  );
}

/** The findings as markdown, worst first as the scan lists them. */
export function renderScanFindings(findings: readonly ScanFinding[], total: number): string {
  if (findings.length === 0) return "No new findings.";
  const lines = [`${total} new finding${total === 1 ? "" : "s"}:`, ""];
  for (const f of findings) {
    const r = f.range;
    const at = r.end !== r.start ? `${r.start}-${r.end}` : `${r.start}`;
    lines.push(
      `- ${f.severity ? `**${f.severity}** ` : ""}\`${f.file}:${at}\` — ${f.claim}${f.lens ? ` _(${f.lens})_` : ""} \`${f.fingerprint}\``,
    );
  }
  return lines.join("\n");
}

/** What a guided run ended with. */
export type GuidedScan =
  | { ok: true; sha: string | null; findings: ScanFinding[]; total: number }
  | { ok: false; error: string };

/** A refusal that says the repo has no unit cut yet. */
const NO_CUT = /no saved unit cut/;

/** Price the run (proposing the first unit cut when there is none), ask, and
 * start it: the started run, or why there is none. With `o.preview` the price
 * is the answer, and nothing starts. */
async function priceAndStart(
  host: PluginHost,
  ui: SessionUi,
  o: ScanOptions,
  engine: RepoScan,
): Promise<
  { ok: true; run: ScanRun } | { ok: true; preview: string } | { ok: false; error: string }
> {
  const { scan } = engine;
  ui.status("QuickReview: pricing the scan…");
  try {
    const previewArgs = { ...(o.sha ? { sha: o.sha } : {}), delta: o.delta };
    let pv = await scan.preview(previewArgs);
    if (!pv.ok && pv.errors.some((e) => NO_CUT.test(e))) {
      // First scan of this repo: a scan reads by unit, and the cut is
      // proposed from the repo's layout (no model, no cost), then saved.
      const how = "`/qcr-scan units propose`, then `/qcr-scan units save`";
      if (!ui.interactive)
        return {
          ok: false,
          error: `this repo has no unit cut yet: a scan reads by unit. Save one with ${how}.`,
        };
      if (
        !(await ui.confirm(
          "QuickReview scan",
          "This repo has no unit cut yet: a scan reads the repo unit by unit. Propose one from the repo's layout and save it? (No model runs for this.)",
          host.shutdown,
        ))
      )
        return { ok: false, error: `the scan was not started: it needs a unit cut (${how})` };
      const proposed = engine.units.propose();
      if (!proposed.ok) return { ok: false, error: `units propose: ${proposed.errors.join("; ")}` };
      const saved = engine.units.save();
      if (!saved.ok) return { ok: false, error: `units save: ${saved.errors.join("; ")}` };
      pv = await scan.preview(previewArgs);
    }
    if (!pv.ok) return { ok: false, error: pv.errors.join("; ") };
    const p = pv.preview;
    if (p.blockers.length > 0)
      return { ok: false, error: `the scan cannot start: ${p.blockers.join("; ")}` };
    const what =
      `Scan ${p.files} files of ${host.cwd}` +
      `${p.mode === "delta" ? " (the files changed since the last scan)" : ""} for about ` +
      `${p.estimate_usd === null ? "the price of a calibration run" : usd(p.estimate_usd)}; it stops hard at ${usd(p.cap_usd)}.`;
    if (o.preview)
      return {
        ok: true,
        preview: `${what}\n\nStart it with \`${PLUGIN_SCAN_VERBS.start(p)}\`, or \`/qcr-scan\`.`,
      };
    if (!ui.interactive)
      return {
        ok: false,
        error: `${what} A scan spends money, and nobody here can confirm it: run /qcr-scan in an interactive pi.`,
      };
    // The login before anything is paid for: pi's /login is the fix.
    const cfg = engine.config();
    if (cfg.ok) {
      const borrowed = await borrowLogin({
        providers: reviewProviders(cfg.cfg),
        host: host.auth,
        needMs: PLUGIN_CASE_MS,
        marginMs: PI_REFRESH_MARGIN_MS,
      });
      if (!borrowed.ok)
        return { ok: false, error: borrowed.error.replaceAll("/qcr-review", "/qcr-scan") };
    }
    if (!(await ui.confirm("QuickReview scan", `${what} Start it?`, host.shutdown)))
      return { ok: false, error: "the scan was not started" };
    const started = await scan.start({ key: p.key, sha: p.sha, delta: p.mode === "delta" });
    if (!started.ok) return { ok: false, error: started.errors.join("; ") };
    return { ok: true, run: started.run };
  } finally {
    ui.status(undefined);
  }
}

/** Wait for the run in flight to end, the status line ticking; `stop` (or the
 * session ending) stops it. The new findings, or why there are none. */
async function followRun(
  host: PluginHost,
  ui: SessionUi,
  engine: RepoScan,
  stop?: AbortSignal,
): Promise<GuidedScan> {
  const { scan } = engine;
  const startedAt = Date.now();
  const halt = (): void => void scan.stop();
  for (const s of [stop, host.shutdown]) {
    if (s?.aborted) halt();
    else s?.addEventListener("abort", halt, { once: true });
  }
  const tick = (): void => {
    // a stop asked for from outside this pi (`qcr scan stop`, the TUI's tab)
    try {
      scan.consumeStopRequest();
    } catch (err) {
      engine.log(`scan: a stop request could not be read: ${String(err)}`);
    }
    ui.status(scanStatusLine(scan.status().run, startedAt, Date.now()));
  };
  tick();
  const ticker = setInterval(tick, 1000);
  ticker.unref?.();
  let s: ScanStatus;
  try {
    await scan.idle();
    s = scan.status();
  } finally {
    clearInterval(ticker);
    for (const sig of [stop, host.shutdown]) sig?.removeEventListener("abort", halt);
    ui.status(undefined);
  }
  if (stop?.aborted || host.shutdown.aborted)
    return { ok: false, error: "the scan was stopped: what finished is in the ledger" };
  const run = s.run;
  if (run !== null && run.display !== "complete")
    ui.notify(
      `the scan ended ${run.display}${run.problems.length ? `: ${run.problems.slice(-1)[0]}` : ""}; its findings so far follow`,
      "warning",
    );
  const listed = listFindings(engine.findings, { state: "new" });
  if (!listed.ok) return { ok: false, error: listed.error };
  return {
    ok: true,
    sha: run?.sha ?? null,
    findings: listed.findings.map(findingJson),
    total: listed.findings.length,
  };
}

/**
 * Price, ask, start, wait, list: the guided scan, waited for to its end. The
 * person confirms the price; with nobody to ask, nothing is started. Esc (or
 * the session ending) stops the run.
 */
export async function guidedScan(
  host: PluginHost,
  ui: SessionUi,
  o: ScanOptions,
  opts: { sessions?: ScanSessions; deps?: ScanCommandDeps } = {},
): Promise<GuidedScan> {
  const sessions = opts.sessions ?? SHARED_SESSIONS;
  if (sessions.running !== null)
    return { ok: false, error: `QuickReview is already scanning ${sessions.running}` };
  const engine = sessions.engine(host, opts.deps ?? SCAN_DEPS);
  const started = await priceAndStart(host, ui, { ...o, preview: false }, engine);
  if (!started.ok) return started;
  if (!("run" in started)) return { ok: false, error: "the scan was not started" };
  const stop = new AbortController();
  const offEscape = ui.onEscape(() => stop.abort());
  const done = followRun(host, ui, engine, stop.signal);
  sessions.hold(
    host.cwd,
    done.then(() => undefined),
  );
  try {
    return await done;
  } finally {
    offEscape();
  }
}

/** Show `text` where the person reads it: print mode's stdout, else the session. */
function say(ui: SessionUi, text: string): void {
  if (ui.mode === "print") ui.print(text);
  else ui.show(text);
}

const fail = (ui: SessionUi, message: string): void => {
  if (ui.mode === "print") ui.print(`✗ ${message}`);
  ui.notify(message, "error");
};

/** Follow a started run in the background: the findings arrive as a message. */
function inBackground(
  host: PluginHost,
  ui: SessionUi,
  engine: RepoScan,
  sessions: ScanSessions,
): void {
  const done = followRun(host, ui, engine).then(
    (r) => {
      if (!r.ok) return fail(ui, r.error);
      say(ui, renderScanFindings(r.findings, r.total));
    },
    (err: unknown) => fail(ui, err instanceof Error ? err.message : String(err)),
  );
  sessions.hold(host.cwd, done);
}

/**
 * /qcr-scan. The guided run starts in the background and the command returns
 * (pi's print mode, where nobody can confirm a price, starts nothing); a
 * subcommand is answered here. Never throws: every refusal reaches the person.
 */
export async function runScanCommand(
  line: string,
  host: PluginHost,
  ui: SessionUi,
  o: { sessions?: ScanSessions; deps?: ScanCommandDeps } = {},
): Promise<void> {
  const sessions = o.sessions ?? SHARED_SESSIONS;
  const deps = o.deps ?? SCAN_DEPS;
  const cmd = parseScanCommand(line);
  if ("error" in cmd) return fail(ui, cmd.error);
  let engine: RepoScan;
  try {
    engine = sessions.engine(host, deps);
  } catch (err) {
    return fail(ui, err instanceof Error ? err.message : String(err));
  }
  if (cmd.kind === "pass") return passThrough(cmd.argv, host, ui, engine, sessions);
  if (!cmd.o.preview && sessions.running !== null)
    return ui.notify(
      `QuickReview is already scanning ${sessions.running}: one scan runs at a time. Its findings arrive here; /qcr-scan stop stops it.`,
      "warning",
    );
  const r = await priceAndStart(host, ui, cmd.o, engine);
  if (!r.ok) return fail(ui, r.error);
  if ("preview" in r) return say(ui, r.preview);
  inBackground(host, ui, engine, sessions);
  ui.notify(
    `QuickReview is scanning ${host.cwd} in the background (${r.run.cases.length} case${r.run.cases.length === 1 ? "" : "s"}, hard stop ${usd(r.run.cap_usd)}). Keep chatting: the findings arrive here; /qcr-scan stop stops it.`,
    "info",
  );
}

/** `/qcr-scan <subcommand> …`: the scan's verb, answered in the session. */
async function passThrough(
  argv: readonly string[],
  host: PluginHost,
  ui: SessionUi,
  engine: RepoScan,
  sessions: ScanSessions,
): Promise<void> {
  const verb = argv[0]!;
  if (APP_SUBCOMMANDS.includes(verb))
    return fail(
      ui,
      verb === "dismiss"
        ? "a dismissal writes reviewer memory, which is the app's: run `qcr scan dismiss` with the QuickReview app"
        : `qcr scan ${verb} is the scan sandbox's, which is the app's: here the scan runs in this pi, its cases behind the bash guard`,
    );
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const starts = verb === "start" || (verb === "stage2" && argv[1] === "start");
  if (starts && sessions.running !== null)
    return fail(ui, `QuickReview is already scanning ${sessions.running}: /qcr-scan stop stops it`);
  // Esc, or the session ending, ends a wait (`status --wait`) and stops a
  // foreground start's run.
  const halt = new AbortController();
  const onShutdown = (): void => halt.abort();
  host.shutdown.addEventListener("abort", onShutdown, { once: true });
  if (host.shutdown.aborted) halt.abort();
  const offEscape = ui.onEscape(() => halt.abort());
  const out: string[] = [];
  let code: number;
  try {
    code = await runScanVerb(rest, json, {
      scan: engine.scan,
      findings: engine.findings,
      settingsOf: engine.settingsOf,
      triage: null,
      afterMatch: null,
      home: engine.home,
      driverLog: join(engine.home, "scan", "plugin.log"),
      out: (l) => out.push(l),
      // A start runs here, in the background, like the guided one.
      detach: async (args): Promise<DetachOutcome> => {
        if (sessions.running !== null)
          return {
            ok: false,
            errors: [
              `QuickReview is already scanning ${sessions.running}: /qcr-scan stop stops it`,
            ],
          };
        const parsed = parseScanArgs(args);
        const r =
          parsed.verb === "start"
            ? await engine.scan.start({
                key: parsed.key,
                ...(parsed.sha ? { sha: parsed.sha } : {}),
                delta: parsed.delta,
              })
            : parsed.verb === "stage2-start"
              ? await engine.scan.startStage2({
                  key: parsed.key,
                  ...(parsed.rows ? { rows: parsed.rows } : {}),
                })
              : ({ ok: false, errors: [`not a start: ${args.join(" ")}`] } as Refusal);
        if (!r.ok) return r;
        inBackground(host, ui, engine, sessions);
        return { ok: true, run: r.run, log: join(engine.home, "scan", "plugin.log") };
      },
      // A foreground start runs here and is waited for: it is the session's
      // run in flight like a background one, Esc and the session ending stop
      // it, and a stop asked for from outside this pi is answered.
      onStart: (r) => {
        if (r.ok) sessions.hold(host.cwd, engine.scan.idle());
      },
      watchStops: (scan) => {
        const stopRun = (): void => void scan.stop();
        if (halt.signal.aborted) stopRun();
        else halt.signal.addEventListener("abort", stopRun, { once: true });
        const ticker = setInterval(() => {
          try {
            scan.consumeStopRequest();
          } catch (err) {
            engine.log(`scan: a stop request could not be read: ${String(err)}`);
          }
        }, 1000);
        ticker.unref?.();
        return () => {
          clearInterval(ticker);
          halt.signal.removeEventListener("abort", stopRun);
        };
      },
      sleep: (ms) =>
        new Promise((resolve, reject) => {
          if (halt.signal.aborted) return reject(new Error("stopped waiting"));
          const t = setTimeout(resolve, ms);
          halt.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(t);
              reject(new Error("stopped waiting"));
            },
            { once: true },
          );
        }),
      now: () => Date.now(),
      units: engine.units,
      verbs: PLUGIN_SCAN_VERBS,
      cutVerbs: { save: "/qcr-scan units save" },
    });
  } catch (err) {
    code = 1;
    out.push(err instanceof Error ? err.message : String(err));
  } finally {
    offEscape();
    host.shutdown.removeEventListener("abort", onShutdown);
  }
  say(ui, `\`\`\`text\n$ /qcr-scan ${argv.join(" ")}\n${out.join("\n").trimEnd()}\n\`\`\``);
  if (code !== 0) ui.notify(`/qcr-scan ${verb} ended ${code}`, "error");
}
