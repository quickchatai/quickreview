// The offline resume rehearsal: a PR's existing session JSONL is resumed by
// the bot worker (src/botworker.ts, the real one) on pi-ai's faux provider, in the
// worker rig's world (a fake daemon on a real socket, a production-shaped root).
// Nothing reaches a provider: the model is the faux, and the offline guard of the
// test file fails on any connection attempt.
//
// The JSONL is never touched: it is COPIED into the world's session dir and the
// worker resumes the copy. What the rehearsal records per file:
//   - parse time: our own JSON pass over the file (resumecheck.ts) and pi's
//     SessionManager.open + buildSessionContext, which is what a worker pays
//     before its first request;
//   - the id is kept, the file is the same file, nothing new appears beside it,
//     and every earlier line is byte-for-byte what it was (append-only);
//   - the one request the round sends: the provider's cache key (it must be the
//     header's id), the history it replays, and its system message and tool
//     schemas hashed against those of a session BORN in the same world (the
//     cache prefix a resumed round shares with a fresh one);
//   - how the stored system message compares to the one the worker sends, per
//     section (preamble, project_context, cwd): the prefix the old interactive
//     session cached against.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { closeSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { EXIT, runBotWorker } from "../../src/botworker.js";
import { OPENVIKING_TOOL_NAMES } from "../../src/engine/botsdk.js";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { REVIEWER_STUB } from "@quickchatai/pi-quickreview/src/reviewerstub.js";
import { createCapabilityFd, ipcEnv, runDirOf } from "../../src/ipc/capability.js";
import { inspectSessionJsonl, type JsonlFacts } from "../../src/resumecheck.js";
import { FakeDaemon, buildWorld, type World } from "./worker-rig.js";

const sha = (v: unknown): string =>
  createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex")
    .slice(0, 16);

/** What one request to the provider carried that the prompt cache is keyed on. */
export interface RequestShape {
  /** The provider's session id (its cache key). */
  sessionId: string | undefined;
  /** Section name -> sha of its text, of the first (system) message. */
  sections: Record<string, string>;
  /** The system message's own sha, whole. */
  system: string;
  /** Tool names in order, and the sha of their schemas. */
  tools: string[];
  toolsSha: string;
  /** Messages in the request, the system message included. */
  messages: number;
  /** Roles of the messages past the history pi replays from the file, and the
   * names of the tools a system message among them adds. */
  tail: string[];
  tailTools: string[];
}

export type SectionVerdict = "same" | "differs" | "stored-only" | "sent-only";

export interface RehearsalRow {
  source: string;
  pr: number | null;
  file: string;
  facts: JsonlFacts;
  /** pi's SessionManager.open + buildSessionContext. */
  openMs: number;
  /** Messages pi replays from the file (its own count, the system message included). */
  replayed: number;
  exit: number;
  workerMs: number;
  resumed: boolean;
  idKept: boolean;
  fileKept: boolean;
  appendOnly: boolean;
  newFiles: string[];
  providerRequests: number;
  cacheKeyIsId: boolean;
  /** The history the request replays equals pi's replay plus the order. */
  historyKept: boolean;
  sent: RequestShape | null;
  /** The sent request's system sections against the stored system message's. */
  sectionsVsStored: Record<string, SectionVerdict>;
  /** The sent system message and tool schemas against a session born in this world. */
  systemVsBorn: "same" | "differs";
  toolsVsBorn: "same" | "differs";
  /** Tools the old file advertises (and its model may still call) that the worker's
   * session does not register: the native lens pair, once the engine's replace it. */
  staleTools: string[];
  /** Tools the worker adds after the replayed history (a tail system message). */
  addedTools: string[];
  problems: string[];
}

const REPO = resolve(import.meta.dirname, "..", "..");
/** The reviewer stub the release image carries. */
const STUB = readFileSync(join(REPO, REVIEWER_STUB), "utf8");

const SYSTEM_PROMPT = "You are the reviewer of this PR.\n";

interface Captured {
  shapes: RequestShape[];
}

/** A faux provider whose every answer is "ok" and which records each request. */
function capturingFaux(replayed: number): {
  faux: ReturnType<typeof fauxProvider>;
  captured: Captured;
} {
  const faux = fauxProvider();
  const captured: Captured = { shapes: [] };
  faux.setResponses(
    Array.from({ length: 8 }, () => (ctx: unknown, options: { sessionId?: string } | undefined) => {
      captured.shapes.push(shapeOf(ctx as FauxContext, options?.sessionId, replayed));
      return fauxAssistantMessage("ok");
    }),
  );
  return { faux, captured };
}

interface FauxContext {
  messages: Array<{
    role: string;
    sections?: Record<string, string>;
    toolsAdded?: Array<{ name: string }>;
    toolsRemoved?: string[];
  }>;
}

function shapeOf(ctx: FauxContext, sessionId: string | undefined, replayed: number): RequestShape {
  const first = ctx.messages[0];
  const sections: Record<string, string> = {};
  if (first?.role === "system" && first.sections)
    for (const [name, text] of Object.entries(first.sections)) sections[name] = sha(text);
  return {
    sessionId,
    sections,
    system: sha(first ?? null),
    // pi 1.3 carries the tool schemas in the system message (toolsAdded), not beside it.
    tools: (first?.toolsAdded ?? []).map((t) => t.name),
    toolsSha: sha(first?.toolsAdded ?? []),
    messages: ctx.messages.length,
    tail: ctx.messages.slice(replayed).map((m) => m.role),
    tailTools: ctx.messages
      .slice(replayed)
      .flatMap((m) => (m.role === "system" ? (m.toolsAdded ?? []).map((t) => t.name) : [])),
  };
}

/** One round of the real worker over `sessionDir`, on the faux. Returns what it did. */
async function runWorker(
  world: World,
  daemon: FakeDaemon,
  captured: Captured,
  faux: ReturnType<typeof fauxProvider>,
  pr: number,
  id: string,
): Promise<{ code: number; ms: number; ready: Record<string, unknown> }> {
  const session = `pr-${pr}`;
  const spec = world.spec(id, `ROUND ORDER for ${session}\n`, {
    pr,
    session,
    compact: false,
    env: {
      ...world.spec(id, "x").env,
      QCR_PR: String(pr),
      QCR_SESSION_NAME: session,
      OPENVIKING_PEER_ID: session,
    },
  });
  writeFileSync(join(world.dir, "system.md"), SYSTEM_PROMPT);
  daemon.command(spec);
  const fd = createCapabilityFd(runDirOf(world.dir), daemon.caps.get(id)!);
  const hosts: PiHost[] = [];
  const t0 = performance.now();
  try {
    const code = await runBotWorker(
      { command: id, mode: "round" },
      {
        env: {
          PATH: process.env["PATH"],
          ...ipcEnv({ socketPath: daemon.sock, commandId: id, generation: 1, capFdIndex: fd }),
        },
        connect: () => daemon.connect(id),
        makeHost: async (o) => {
          const host = await PiHost.create({
            agentDir: o.agentDir,
            settings: { compaction: { enabled: false }, retry: { enabled: false } },
            configureModels: (r) => {
              r.registerNativeProvider(faux.provider);
            },
          });
          hosts.push(host);
          return host;
        },
        // Memory off: a rehearsal is not about a server.
        openViking: (c) => ({ ...c, config: { ...c.config, enabled: false } }),
      },
    );
    // The worker's last events are on the wire; the fake daemon reads them a tick later.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const ready = daemon.of("ready").at(-1)?.body ?? {};
    return { code, ms: performance.now() - t0, ready };
  } finally {
    closeSync(fd);
    for (const h of hosts) h.dispose();
    void captured;
  }
}

/** The shape of a session born in a world of its own, which every resumed round is
 * compared to. */
export async function bornReference(pr = 7): Promise<RequestShape> {
  const world = buildWorld("rehearsal-born-");
  const daemon = new FakeDaemon();
  await daemon.start();
  try {
    const { faux, captured } = capturingFaux(0);
    const { code } = await runWorker(world, daemon, captured, faux, pr, "born-1");
    if (code !== EXIT.ok || captured.shapes.length === 0)
      throw new Error(`the born reference round failed (exit ${code})`);
    return captured.shapes[0]!;
  } finally {
    await daemon.stop();
    rmSync(world.dir, { recursive: true, force: true });
  }
}

const prOfFile = (file: string): number | null => {
  const m = /(?:^|\/)pr-(\d+)(?:\/|$)/.exec(file);
  return m ? Number(m[1]) : null;
};

/** Resume one JSONL, in a scratch world, and record what happened. `file` is only
 * read; `born` is the reference from `bornReference`. */
export async function rehearseFile(
  file: string,
  source: string,
  born: RequestShape,
): Promise<RehearsalRow> {
  const pr = prOfFile(file);
  const facts = inspectSessionJsonl(file, { stub: STUB });
  const world = buildWorld("rehearsal-resume-");
  const daemon = new FakeDaemon();
  await daemon.start();
  const problems: string[] = [];
  try {
    mkdirSync(world.sessionDir, { recursive: true });
    const copy = join(world.sessionDir, basename(file));
    copyFileSync(file, copy);
    const before = readFileSync(copy, "utf8");

    // pi's own parse, as the worker's first act on the file.
    const t0 = performance.now();
    let context: { messages: unknown[] } = { messages: [] };
    try {
      context = SessionManager.open(copy, world.sessionDir, world.root).buildSessionContext();
    } catch (e) {
      problems.push(`pi cannot open it: ${String(e).slice(0, 120)}`);
    }
    const openMs = performance.now() - t0;
    const stored = (context.messages[0] as { sections?: Record<string, string> } | undefined)
      ?.sections;

    const { faux, captured } = capturingFaux(context.messages.length);
    const { code, ms, ready } = await runWorker(world, daemon, captured, faux, pr ?? 7, "resume-1");
    const sent = captured.shapes[0] ?? null;
    const after = readFileSync(copy, "utf8");
    const files = readdirSync(world.sessionDir).filter((f) => f.endsWith(".jsonl"));
    const newFiles = files.filter((f) => f !== basename(file));
    const id = facts.header?.id ?? null;

    const sectionsVsStored: Record<string, SectionVerdict> = {};
    if (sent && stored)
      for (const name of new Set([...Object.keys(stored), ...Object.keys(sent.sections)])) {
        const was = stored[name];
        const now = sent.sections[name];
        sectionsVsStored[name] =
          was === undefined
            ? "sent-only"
            : now === undefined
              ? "stored-only"
              : sha(was) === now
                ? "same"
                : "differs";
      }
    const storedTools = facts.system?.tools ?? [];
    const row: RehearsalRow = {
      source,
      pr,
      file: basename(file),
      facts,
      openMs,
      replayed: context.messages.length,
      exit: code,
      workerMs: ms,
      resumed: ready["resumed"] === true,
      idKept: id !== null && ready["session_id"] === id,
      fileKept: ready["session_file"] === copy,
      appendOnly: after.startsWith(before),
      newFiles,
      providerRequests: captured.shapes.length,
      cacheKeyIsId: id !== null && sent?.sessionId === id,
      // The request replays pi's history, then the round order (one more turn).
      historyKept: sent !== null && sent.messages > context.messages.length,
      sent,
      sectionsVsStored,
      systemVsBorn: sent && sent.system === born.system ? "same" : "differs",
      toolsVsBorn: sent && sent.toolsSha === born.toolsSha ? "same" : "differs",
      staleTools: storedTools.filter(
        (t) => !born.tools.includes(t) && !(OPENVIKING_TOOL_NAMES as readonly string[]).includes(t),
      ),
      addedTools: sent?.tailTools ?? [],
      problems,
    };
    if (code !== EXIT.ok) problems.push(`worker exit ${code}`);
    if (facts.header === null) problems.push("no session header");
    if (facts.badLines > 0) problems.push(`${facts.badLines} line(s) that are not JSON`);
    if (!row.resumed) problems.push("the worker did not resume the file");
    if (!row.idKept) problems.push("the session id was not kept");
    if (!row.fileKept) problems.push("the worker resumed another file");
    if (!row.appendOnly) problems.push("an earlier line changed");
    if (newFiles.length > 0) problems.push(`new JSONL beside it: ${newFiles.join(", ")}`);
    if (row.providerRequests !== 1)
      problems.push(`${row.providerRequests} provider requests, not 1`);
    if (!row.cacheKeyIsId) problems.push("the provider cache key is not the header id");
    if (!row.historyKept) problems.push("the request does not replay the file's history");
    return row;
  } finally {
    await daemon.stop();
    rmSync(world.dir, { recursive: true, force: true });
  }
}
