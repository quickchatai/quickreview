#!/usr/bin/env node
// The offline CPU and RSS gate [P2.11]: can N review sessions share ONE node
// event loop on a 2-vCPU host?
//
// The in-process SDK runtime (src/engine/sdkruntime.ts) puts every lens
// session on the same JS thread, which is why CPU forced the 10-08 cut. This
// measures what that costs:
//
//   sdk   N faux sessions in this process (sdkRuntime over PiHost).
//
// (The process-runtime arm this once measured it against is retired with the
// runtime; its results stay in docs/cpu-gate.md.) It runs under `taskset -c 0,1` (the host's two vCPUs). The workload is one
// long lens-shaped turn per session: a short thought, then a read or bash tool
// call, over and over (the real tools run, on a real file tree), every response
// streamed at pi-ai's faux pacing. No model, no network: each cell asserts it
// made no connection attempt. Cost: $0.
//
// What it records per cell, over a steady window after every session streams:
// event-loop lag p50/p99/max of THIS process (a 10 ms timer, lag = how late it
// fired), RSS (summed over the process and its descendants; PSS beside it,
// since the node binary's pages are shared), CPU as a share of the pinned
// cores, and abort latency (abort() to the turn settling) one session at a
// time and all at once.
//
// What it does NOT measure: provider TLS and SSE parsing (the faux hands over
// parsed messages), and real pi's own startup. Real sessions cost more CPU per
// token than these, so a pass here is a floor, not a promise (see
// docs/cpu-gate.md).
//
// Usage (after `npm run build`; dist/ must exist):
//   node scripts/cpu-gate.mjs                      the gate: 8, 12, 20 sessions on sdk
//   node scripts/cpu-gate.mjs --sessions 12 --modes sdk --window 10
//   node scripts/cpu-gate.mjs --md out.md --json out.json
// Exit status: 1 when the sdk cell at the gate size misses --limit-ms (D6:
// p99 lag <= 200 ms at 12 sessions), 2 on a harness failure.
import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const DIST = join(ROOT, "dist", "src", "engine");
const MODEL = "faux/m";
const TICK_MS = 10;
const CLK_TCK = 100; // getconf CLK_TCK on every Linux this runs on

// ---- plain helpers ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The nearest-rank percentile of a list of numbers (q in 0..1). */
export function percentile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Lag of a timer loop: each sample is how many ms late the tick fired. */
export function startLagSampler() {
  /** @type {Record<string, number[]>} */
  const samples = {};
  let phase = "startup";
  let stopped = false;
  let expected = performance.now() + TICK_MS;
  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    (samples[phase] ??= []).push(Math.max(0, now - expected));
    expected = performance.now() + TICK_MS;
    setTimeout(tick, TICK_MS);
  };
  setTimeout(tick, TICK_MS);
  return {
    phase: (name) => {
      phase = name;
    },
    stop: () => {
      stopped = true;
      return samples;
    },
  };
}

export function lagStats(values) {
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p99: percentile(values, 0.99),
    max: values.length ? Math.max(...values) : 0,
    over200: values.filter((v) => v > 200).length,
  };
}

const num = (s) => Number(s);

/** pid -> { ppid, ticks } for every process, from /proc. */
function procTable() {
  const table = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(num(name), { ppid: num(rest[1]), ticks: num(rest[11]) + num(rest[12]) });
    } catch {
      // gone between readdir and read
    }
  }
  return table;
}

/** This process and everything under it. */
function familyPids(root = process.pid) {
  const table = procTable();
  const out = [root];
  for (let i = 0; i < out.length; i++)
    for (const [pid, p] of table) if (p.ppid === out[i] && !out.includes(pid)) out.push(pid);
  return { pids: out, table };
}

function readKb(pid, file, key) {
  try {
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(
      readFileSync(`/proc/${pid}/${file}`, "utf8"),
    );
    return m ? num(m[1]) : 0;
  } catch {
    return 0;
  }
}

const MB = 1024;

function familyMemory() {
  const { pids } = familyPids();
  let rss = 0;
  let pss = 0;
  for (const pid of pids) {
    rss += readKb(pid, "status", "VmRSS");
    pss += readKb(pid, "smaps_rollup", "Pss");
  }
  return { rssMb: rss / MB, pssMb: pss / MB, processes: pids.length };
}

/** CPU ticks of the pinned cores (all work) and of this family (ours). */
function cpuSnapshot(cpus) {
  const { pids, table } = familyPids();
  const per = new Map();
  for (const pid of pids) {
    const t = table.get(pid)?.ticks ?? 0;
    per.set(pid, t);
  }
  let busy = 0;
  for (const line of readFileSync("/proc/stat", "utf8").split("\n")) {
    const m = /^cpu(\d+) (.*)$/.exec(line);
    if (!m || !cpus.includes(num(m[1]))) continue;
    const f = m[2].split(" ").map(num);
    // user nice system idle iowait irq softirq steal
    busy += f[0] + f[1] + f[2] + f[5] + f[6] + f[7];
  }
  return { per, busy };
}

/** Ticks we used between two snapshots, counting only processes alive at both
 * ends (a bash that came and went is in neither). */
function ourTicks(a, b) {
  let d = 0;
  for (const [pid, t] of b.per) if (a.per.has(pid)) d += t - a.per.get(pid);
  return d;
}

export function parseCpuList(list) {
  const out = [];
  for (const part of list.split(",")) {
    const [a, b] = part.split("-").map(num);
    for (let i = a; i <= (b ?? a); i++) out.push(i);
  }
  return out;
}

function allowedCpus() {
  const m = /^Cpus_allowed_list:\s+(\S+)/m.exec(readFileSync("/proc/self/status", "utf8"));
  return parseCpuList(m ? m[1] : "0");
}

// ---- offline guard ------------------------------------------------------------

/** Record (and refuse) every fetch and TCP connect; unix sockets stay legal. */
function installOfflineGuard() {
  const attempts = [];
  globalThis.fetch = (input) => {
    attempts.push(`fetch ${typeof input === "string" ? input : String(input?.url ?? input)}`);
    return Promise.reject(new Error("offline gate: fetch refused"));
  };
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const unix =
      typeof first === "string" ? Number.isNaN(Number(first)) : first?.path !== undefined;
    if (!unix) {
      attempts.push(`connect ${JSON.stringify(first)}`);
      throw new Error("offline gate: connect refused");
    }
    return realConnect.apply(this, args);
  };
  return attempts;
}

// ---- the workload -------------------------------------------------------------

const FILES = 8;

/** A tree for the sessions' read tool: a few files of source-file size. */
function makeTree(dir) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < FILES; i++) {
    const lines = Array.from(
      { length: 160 },
      (_, n) => `export const v${i}_${n} = compute(${n}, "the quick brown fox ${i}");`,
    );
    writeFileSync(join(dir, `f${i}.ts`), lines.join("\n") + "\n");
  }
}

/**
 * The scripted model: a response FACTORY reads the transcript, so it holds for
 * any interleaving of sessions on one shared provider. A step is a short
 * thought plus one tool call (alternately read and bash); after `steps` of
 * them the turn ends with a long answer. Steps are set high enough that no
 * turn finishes inside the window.
 */
async function fauxFixtures(tps, steps) {
  const { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } =
    await import("@earendil-works/pi-ai");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }], tokensPerSecond: tps });
  const reply = (context) => {
    let done = 0;
    for (let i = context.messages.length - 1; i >= 0; i--) {
      if (context.messages[i].role === "user") break;
      if (context.messages[i].role === "assistant") done++;
    }
    if (done >= steps)
      return fauxAssistantMessage(
        "Findings: the change is sound. ".repeat(40), // ~300 tokens
      );
    const file = `f${done % FILES}.ts`;
    const call =
      done % 2 === 0
        ? fauxToolCall("read", { path: file })
        : fauxToolCall("bash", { command: `grep -c compute ${file}; wc -l ${file}` });
    return fauxAssistantMessage(
      [fauxText(`Checking ${file} for the invariant the change relies on, step ${done}.`), call],
      { stopReason: "toolUse" },
    );
  };
  return { faux, reply };
}

function sessionSpec(i, dir, tree) {
  const sdir = join(dir, `s${i}`);
  mkdirSync(sdir, { recursive: true });
  return {
    cwd: tree,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: sdir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    model: MODEL,
    tools: ["read", "bash"],
    sessionFile: join(sdir, "session.jsonl"),
    eventsFile: join(sdir, "events.jsonl"),
    stderrFile: join(sdir, "stderr.log"),
    limits: { timeoutMs: 15 * 60_000 },
  };
}

// ---- one cell (a mode at a session count), in its own process ------------------

async function cellMain(mode, n, opts) {
  const attempts = installOfflineGuard();
  const dir = mkdtempSync(join(os.tmpdir(), `cpu-gate-${mode}-${n}-`));
  const tree = join(dir, "tree");
  makeTree(tree);
  const cpus = allowedCpus();
  const lag = startLagSampler();
  /** @type {{ dispose(): Promise<void>, abort(): Promise<void>, prompt(t: string): Promise<unknown>, ready: boolean }[]} */
  const sessions = [];
  let host;
  let runtime;
  const firstEvent = new Set();
  let abortStarted = false;
  let finishedEarly = 0;
  const cleanup = async () => {
    await Promise.all(sessions.map((s) => s.dispose().catch(() => {})));
    host?.dispose();
    rmSync(dir, { recursive: true, force: true });
  };

  if (mode === "sdk") {
    const { PiHost } = await import(pathToFileURL(join(DIST, "pisdk.js")).href);
    const { sdkRuntime } = await import(pathToFileURL(join(DIST, "sdkruntime.js")).href);
    const { faux, reply } = await fauxFixtures(opts.tps, opts.steps);
    faux.appendResponses(Array.from({ length: n * (opts.steps + 8) }, () => reply));
    host = await PiHost.create({
      agentDir: join(dir, "agent"),
      settings: { compaction: { enabled: false }, retry: { enabled: false } },
      configureModels: (r) => {
        r.registerNativeProvider(faux.provider);
      },
    });
    runtime = sdkRuntime(host);
  }

  // ---- start every session at once (a lens wave) ----
  const turns = [];
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const s = await runtime.create(sessionSpec(i, dir, tree));
      sessions.push(s);
      // "Streaming" = a tool has run: the session is past its start-up.
      s.subscribe((e) => {
        if (e.type === "tool_execution_end") firstEvent.add(i);
      });
      turns.push(
        s.prompt("Review the change. Read the files you need.").then((r) => {
          if (!abortStarted) finishedEarly++;
          return { r, settledAt: performance.now() };
        }),
      );
    }),
  );
  const deadline = performance.now() + 60_000;
  while (firstEvent.size < n && performance.now() < deadline) await sleep(50);
  const startupMs = performance.now() - startedAt;
  const startedAll = firstEvent.size === n;

  // ---- warm-up, then the steady window ----
  lag.phase("warmup");
  await sleep(opts.warmup * 1000);
  lag.phase("steady");
  const memPeak = { rssMb: 0, pssMb: 0, processes: 0 };
  const sampleMem = () => {
    const m = familyMemory();
    memPeak.rssMb = Math.max(memPeak.rssMb, m.rssMb);
    memPeak.pssMb = Math.max(memPeak.pssMb, m.pssMb);
    memPeak.processes = Math.max(memPeak.processes, m.processes);
  };
  const c0 = cpuSnapshot(cpus);
  const w0 = performance.now();
  const memTimer = setInterval(sampleMem, 250);
  await sleep(opts.window * 1000);
  clearInterval(memTimer);
  sampleMem();
  const c1 = cpuSnapshot(cpus);
  const windowS = (performance.now() - w0) / 1000;

  // ---- abort one at a time, then all at once ----
  /** Abort a session; resolves with ms from the call to the turn settling. */
  const abortTimed = async (idx) => {
    const settled = turns[idx].then((x) => x.settledAt);
    const t = performance.now();
    await sessions[idx].abort();
    return (await settled) - t;
  };
  abortStarted = true;
  lag.phase("abort-one");
  const abortOne = [];
  for (let k = 0; k < Math.min(3, n); k++) {
    abortOne.push(await abortTimed(k));
    await sleep(500);
  }
  lag.phase("abort-all");
  const rest = Array.from({ length: n - abortOne.length }, (_, k) => k + abortOne.length);
  const abortAll = await Promise.all(rest.map((idx) => abortTimed(idx)));
  const samples = lag.stop();

  const results = await Promise.all(turns);
  const aborted = results.filter((x) => x.r.code !== 0).length;
  const violations = attempts.length;
  await cleanup();

  const ticks = ourTicks(c0, c1);
  const out = {
    mode,
    sessions: n,
    cpus: cpus.join(","),
    startup: {
      ms: Math.round(startupMs),
      allStreaming: startedAll,
      lag: lagStats(samples["startup"] ?? []),
    },
    steady: {
      windowS: Math.round(windowS * 10) / 10,
      lag: lagStats(samples["steady"] ?? []),
      rssMb: Math.round(memPeak.rssMb),
      pssMb: Math.round(memPeak.pssMb),
      processes: memPeak.processes,
      // CPU used by us / by everything on the pinned cores, as a share of those cores
      ourCpuPct: Math.round((ticks / CLK_TCK / (windowS * cpus.length)) * 1000) / 10,
      pinnedBusyPct:
        Math.round(((c1.busy - c0.busy) / CLK_TCK / (windowS * cpus.length)) * 1000) / 10,
    },
    abort: {
      oneMs: abortOne.map(Math.round),
      allMaxMs: Math.round(Math.max(0, ...abortAll)),
      allP50Ms: Math.round(percentile(abortAll, 0.5)),
      lagOne: lagStats(samples["abort-one"] ?? []),
      lagAll: lagStats(samples["abort-all"] ?? []),
      settledAborted: aborted,
    },
    turnsFinishedBeforeAbort: finishedEarly,
    offlineViolations: violations,
  };
  process.stdout.write("RESULT " + JSON.stringify(out) + "\n");
  process.exit(0);
}

// ---- the orchestrator ---------------------------------------------------------

function runCell(mode, n, opts) {
  return new Promise((res, rej) => {
    const args = [
      "-c",
      opts.cpus,
      process.execPath,
      join(HERE, "cpu-gate.mjs"),
      "--cell",
      mode,
      String(n),
      "--tps",
      String(opts.tps),
      "--steps",
      String(opts.steps),
      "--window",
      String(opts.window),
      "--warmup",
      String(opts.warmup),
    ];
    const child = spawn("taskset", args, {
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", rej);
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith("RESULT "));
      if (!line) return rej(new Error(`${mode}:${n} produced no result (exit ${code})\n${out}`));
      res(JSON.parse(line.slice(7)));
    });
  });
}

const f1 = (v) => (Math.round(v * 10) / 10).toString();

export function markdownTables(cells, meta) {
  const rows = cells.map((c) => {
    const l = c.steady.lag;
    return (
      `| ${c.mode} | ${c.sessions} | ${f1(l.p50)} | ${f1(l.p99)} | ${f1(l.max)} | ${l.over200} | ` +
      `${c.steady.rssMb} | ${c.steady.pssMb} | ${c.steady.processes} | ${c.steady.ourCpuPct} | ${c.steady.pinnedBusyPct} |`
    );
  });
  const rows2 = cells.map(
    (c) =>
      `| ${c.mode} | ${c.sessions} | ${c.startup.ms} | ${f1(c.startup.lag.p99)} | ${f1(c.startup.lag.max)} | ` +
      `${c.abort.oneMs.join(" / ")} | ${c.abort.allP50Ms} | ${c.abort.allMaxMs} | ${f1(c.abort.lagAll.max)} |`,
  );
  return [
    `Steady window ${meta.window} s after ${meta.warmup} s of warm-up, pinned to cpus ${meta.cpus}, ` +
      `faux pace ${meta.tps} tokens/s per session, load average at start ${meta.loadavg}.`,
    "",
    "| runtime | sessions | lag p50 ms | lag p99 ms | lag max ms | ticks >200 ms | RSS MB | PSS MB | procs | our CPU % | pinned busy % |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "| runtime | sessions | start-up ms | start-up lag p99 | start-up lag max | abort one, ms (3 probes) | abort all p50 | abort all max | lag max during abort all |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows2,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  const o = {
    sessions: [8, 12, 20],
    modes: ["sdk"],
    window: 15,
    warmup: 3,
    tps: 100,
    steps: 400,
    cpus: "0,1",
    limitMs: 200,
    gateSessions: 12,
    md: null,
    json: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === "--sessions") o.sessions = v().split(",").map(num);
    else if (a === "--modes") o.modes = v().split(",");
    else if (a === "--window") o.window = num(v());
    else if (a === "--warmup") o.warmup = num(v());
    else if (a === "--tps") o.tps = num(v());
    else if (a === "--steps") o.steps = num(v());
    else if (a === "--cpus") o.cpus = v();
    else if (a === "--limit-ms") o.limitMs = num(v());
    else if (a === "--gate-sessions") o.gateSessions = num(v());
    else if (a === "--md") o.md = v();
    else if (a === "--json") o.json = v();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--cell") {
    const o = parseArgs(argv.slice(3));
    return cellMain(argv[1], num(argv[2]), o);
  }
  const opts = parseArgs(argv);
  if (spawnSync("taskset", ["--version"]).error)
    throw new Error("taskset is not installed: the gate cannot pin the cores");
  try {
    readFileSync(join(DIST, "sdkruntime.js"));
  } catch {
    throw new Error("dist/ is not built: run `npm run build` first");
  }
  const loadavg = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
  const cells = [];
  for (const n of opts.sessions)
    for (const mode of opts.modes) {
      process.stderr.write(`cell ${mode} x${n} ...\n`);
      cells.push(await runCell(mode, n, opts));
    }
  const md = markdownTables(cells, { ...opts, loadavg });
  process.stdout.write(md + "\n");
  if (opts.md) writeFileSync(opts.md, md + "\n");
  if (opts.json) writeFileSync(opts.json, JSON.stringify({ opts, loadavg, cells }, null, 2) + "\n");
  const bad = cells.filter((c) => c.offlineViolations > 0 || !c.startup.allStreaming);
  for (const c of bad)
    process.stderr.write(
      `INVALID cell ${c.mode} x${c.sessions}: offline violations ${c.offlineViolations}, all streaming ${c.startup.allStreaming}\n`,
    );
  if (bad.length) return 2;
  const gate = cells.find((c) => c.mode === "sdk" && c.sessions === opts.gateSessions);
  if (!gate) return 0;
  const p99 = gate.steady.lag.p99;
  const verdict = p99 <= opts.limitMs ? "PASS" : "FAIL";
  process.stdout.write(
    `GATE ${verdict}: sdk x${gate.sessions} p99 lag ${f1(p99)} ms (limit ${opts.limitMs} ms)\n`,
  );
  return verdict === "PASS" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code ?? 0),
    (e) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
