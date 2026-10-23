// The local English embedder service,
// scripts/openviking-embedder.py, RUN: a real python process on a loopback
// port, with a fake `llama_cpp` module on its path in place of the pinned
// llama-cpp-python (no model, no network). What is pinned:
//
//   * its model table and the TypeScript side agree (LOCAL_EMBEDDING);
//   * it refuses to serve anything but the pinned file of a known model, on
//     anything but loopback;
//   * it speaks the OpenAI embeddings contract the engine's client uses —
//     float and the SDK's default base64, a 404 for another model, input_type
//     telling a query (the model's instruction, the query token budget) from a
//     document (no prefix, the model's whole context);
//   * the boot scripts and the daemon start it with the SAME argv, and the
//     boot's start helper never spawns it when a file it needs is missing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_EMBEDDING, OPENVIKING_DEFAULTS, resolveOpenVikingPaths } from "../src/config.js";
import { localEmbedderArgv, localEmbedderSpec } from "../src/openviking/embedder.js";
// Plain JS, dependency-free; `tsconfig.tests.json` sets allowJs so these call
// sites are type-checked against its JSDoc.
import * as provision from "../scripts/openviking-provision.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "openviking-embedder.py");
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

let dir: string;
let modelFile: string;
let modelSha: string;
let fakeLog: string;

const FAKE_LLAMA = `
import hashlib, json, os
DIM = int(os.environ.get("FAKE_LLAMA_DIM", "384"))
# What embed() actually returns, when a test wants it to disagree with n_embd()
# or to come back unpooled (one vector per token).
VEC_DIM = int(os.environ.get("FAKE_LLAMA_VEC_DIM", str(DIM)))
PER_TOKEN = os.environ.get("FAKE_LLAMA_PER_TOKEN") == "1"
LOG = os.environ.get("FAKE_LLAMA_LOG")

def _log(entry):
    if LOG:
        with open(LOG, "a") as fh:
            fh.write(json.dumps(entry) + "\\n")

class Llama:
    def __init__(self, model_path, embedding, n_ctx, n_batch, n_ubatch, n_threads, n_threads_batch, verbose):
        _log({"init": {"model_path": model_path, "embedding": embedding, "n_ctx": n_ctx, "n_batch": n_batch,
                       "n_ubatch": n_ubatch, "n_threads": n_threads, "n_threads_batch": n_threads_batch}})

    def n_embd(self):
        return DIM

    # One token per whitespace-separated word, plus the two specials.
    def tokenize(self, text, add_bos=True, special=False):
        return list(range(len(text.decode("utf-8").split()) + (2 if add_bos else 0)))

    def embed(self, text, normalize=False, truncate=True):
        _log({"embed": text})
        h = hashlib.sha256(text.encode("utf-8")).digest()
        v = [((h[i % 32] / 255.0) - 0.5) + i * 0.001 for i in range(VEC_DIM)]
        return [v, v] if PER_TOKEN else v
`;

interface Running {
  child: ChildProcess;
  port: number;
  base: string;
  out: () => string;
}

/** Start the real script; resolve once it prints its ready line (or exits). */
function startServer(extra: string[] = [], env: Record<string, string> = {}): Promise<Running> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(
      "python3",
      [
        SCRIPT,
        "--model-path",
        modelFile,
        "--model-name",
        LOCAL_EMBEDDING.model,
        "--sha256",
        modelSha,
        "--port",
        "0",
        ...extra,
      ],
      {
        env: { ...process.env, PYTHONPATH: dir, FAKE_LLAMA_LOG: fakeLog, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    const onData = (chunk: Buffer): void => {
      out += chunk.toString();
      const m = /openviking-embedder: ready — .* on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m)
        resolveP({ child, port: Number(m[1]), base: `http://127.0.0.1:${m[1]}`, out: () => out });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => rejectP(new Error(`exited ${code} before ready:\n${out}`)));
  });
}

/** Run the script to its exit (a refusal) and return code + output. Only for
 * a run that REFUSES: one that starts serving would hold until the timeout. */
function runToExit(
  args: string[],
  env: Record<string, string> = {},
): { code: number | null; out: string } {
  const r = spawnSync("python3", [SCRIPT, ...args], {
    env: { ...process.env, PYTHONPATH: dir, FAKE_LLAMA_LOG: fakeLog, ...env },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Headers only, with the given Content-Length and NO body: what the server
 * answers, and whether it closed the socket on its own. */
function rawPost(port: number, length: string): Promise<{ head: string; closedByServer: boolean }> {
  return new Promise((resolveP, rejectP) => {
    const sock = connect(port, "127.0.0.1");
    let data = "";
    const timer = setTimeout(() => {
      sock.destroy();
      resolveP({ head: data, closedByServer: false });
    }, 5_000);
    sock.on("connect", () =>
      sock.write(
        `POST /v1/embeddings HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n`,
      ),
    );
    sock.on("data", (d: Buffer) => (data += d.toString()));
    sock.on("end", () => {
      clearTimeout(timer);
      resolveP({ head: data, closedByServer: true });
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
  });
}

async function post(base: string, body: unknown, path = "/v1/embeddings") {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as EmbedAnswer };
}

/** What the service answers — the OpenAI embeddings envelope, or an error. */
interface EmbedAnswer {
  data: Array<{ index: number; embedding: number[] | string }>;
  model: string;
  usage: { prompt_tokens: number };
  truncated_inputs: number;
  error: { code: string };
}

const embedLog = (): string[] =>
  readFileSync(fakeLog, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as { embed?: string })
    .filter((e) => typeof e.embed === "string")
    .map((e) => e.embed as string);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-embedder-"));
  writeFileSync(join(dir, "llama_cpp.py"), FAKE_LLAMA);
  modelFile = join(dir, `${LOCAL_EMBEDDING.model}.gguf`);
  writeFileSync(modelFile, "not really a gguf — the fake llama never reads it\n");
  modelSha = createHash("sha256").update(readFileSync(modelFile)).digest("hex");
  fakeLog = join(dir, "llama.log");
  writeFileSync(fakeLog, "");
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the model table", () => {
  it("--describe carries LOCAL_EMBEDDING's model at its dimension, with a query budget inside its context", () => {
    const r = spawnSync("python3", [SCRIPT, "--describe"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const table = JSON.parse(r.stdout) as {
      models: Record<string, { dimension: number; context: number; query_prefix: string }>;
      query_max_tokens: number;
    };
    const spec = table.models[LOCAL_EMBEDDING.model];
    expect(spec).toBeDefined();
    expect(spec!.dimension).toBe(LOCAL_EMBEDDING.dimension);
    expect(spec!.query_prefix).toBe(QUERY_PREFIX);
    expect(table.query_max_tokens).toBeLessThanOrEqual(spec!.context);
  });
});

describe("refusals — it never serves an unpinned model, or beyond loopback", () => {
  const base = (): string[] => [
    "--model-path",
    modelFile,
    "--model-name",
    LOCAL_EMBEDDING.model,
    "--sha256",
    modelSha,
    "--port",
    "0",
  ];

  it("a non-loopback host", () => {
    const r = runToExit([...base(), "--host", "0.0.0.0"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/is not loopback/);
  });

  it("a model the table does not know", () => {
    const r = runToExit([
      "--model-path",
      modelFile,
      "--model-name",
      "nomic-embed-text-v1.5",
      "--sha256",
      modelSha,
    ]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/unknown model 'nomic-embed-text-v1\.5'/);
  });

  it("a dimension the model does not have", () => {
    const r = runToExit([...base(), "--dimension", "512"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/has 384 dims, not 512/);
  });

  it("a file whose sha256 is not the pin", () => {
    const r = runToExit([...base().slice(0, 4), "--sha256", "0".repeat(64)]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/the pin says 0{64} — not serving an unpinned model/);
  });

  it("a missing file — and says the image carries it", () => {
    const r = runToExit([
      "--model-path",
      join(dir, "absent.gguf"),
      "--model-name",
      LOCAL_EMBEDDING.model,
      "--sha256",
      modelSha,
    ]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/does not exist — it is baked into the image; rebuild it/);
  });

  it("missing required flags", () => {
    expect(runToExit(["--port", "0"]).code).toBe(2);
  });

  // The ranges the daemon and the config already bound.
  it("threads outside 1..16 and a query budget outside 1..context", () => {
    for (const t of ["0", "17"]) {
      const r = runToExit([...base(), "--threads", t]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(new RegExp(`--threads ${t} is outside 1\\.\\.16`));
    }
    for (const q of ["0", "513"]) {
      const r = runToExit([...base(), "--query-max-tokens", q]);
      expect(r.code).toBe(2);
      expect(r.out).toMatch(new RegExp(`--query-max-tokens ${q} is outside 1\\.\\.512`));
    }
  });
});

// The checks that stop a wrong-shaped vector reaching the
// 384-dim collection. Each is reached by the start-up self-check, so a file
// that would answer wrongly never serves at all.
describe("model-shape self-checks — a wrong-shaped vector never serves", () => {
  const base = (): string[] => [
    "--model-path",
    modelFile,
    "--model-name",
    LOCAL_EMBEDDING.model,
    "--sha256",
    modelSha,
    "--port",
    "0",
  ];

  it("a file whose model embeds another dimension than the table's", () => {
    const r = runToExit(base(), { FAKE_LLAMA_DIM: "512" });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/the file embeds 512 dims, the table says 384/);
  });

  it("a model that answers unpooled, per-token vectors", () => {
    const r = runToExit(base(), { FAKE_LLAMA_PER_TOKEN: "1" });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/per-token vectors/);
  });

  it("a model whose vector is not n_embd long", () => {
    const r = runToExit(base(), { FAKE_LLAMA_VEC_DIM: "383" });
    expect(r.code).toBe(4);
    expect(r.out).toMatch(/returned 383 dims, not 384/);
  });
});

describe("serving the OpenAI embeddings contract", () => {
  let server: Running;
  beforeAll(async () => {
    server = await startServer(["--threads", "1"]);
  });
  afterAll(async () => {
    if (!server) return;
    const exited = new Promise<number | null>((r) => server.child.on("exit", (code) => r(code)));
    server.child.kill("SIGTERM");
    expect(await exited).toBe(0);
  });

  it("loads the model with its whole context as the batch, on the threads it was given", () => {
    const init = readFileSync(fakeLog, "utf8")
      .split("\n")
      .filter((l) => l.includes('"init"'))
      .map((l) => (JSON.parse(l) as { init: Record<string, unknown> }).init)
      .at(-1)!;
    expect(init).toMatchObject({
      model_path: modelFile,
      embedding: true,
      n_ctx: 512,
      n_batch: 512,
      n_ubatch: 512,
      n_threads: 1,
      n_threads_batch: 1,
    });
  });

  it("/health names the model, its dimension and the verified sha256", async () => {
    const res = await fetch(`${server.base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: "ok",
      model: LOCAL_EMBEDDING.model,
      dimension: LOCAL_EMBEDDING.dimension,
      sha256: modelSha,
      threads: 1,
      query_max_tokens: 128,
    });
  });

  it("a document: no prefix, a unit vector of the model's dimension", async () => {
    const r = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: "pinned lesson about migrations",
      input_type: "passage",
      encoding_format: "float",
    });
    expect(r.status).toBe(200);
    const v = r.body.data[0]!.embedding as number[];
    expect(v).toHaveLength(LOCAL_EMBEDDING.dimension);
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    expect(r.body.model).toBe(LOCAL_EMBEDDING.model);
    expect(r.body.usage.prompt_tokens).toBe(6);
    expect(embedLog().at(-1)).toBe("pinned lesson about migrations");
  });

  it("a query: the model's retrieval instruction in front", async () => {
    const r = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: "migration renumbering",
      input_type: "query",
      encoding_format: "float",
    });
    expect(r.status).toBe(200);
    expect(embedLog().at(-1)).toBe(`${QUERY_PREFIX}migration renumbering`);
  });

  it("no input_type is a document (the engine's symmetric default)", async () => {
    await post(server.base, { model: LOCAL_EMBEDDING.model, input: "plain text" });
    expect(embedLog().at(-1)).toBe("plain text");
  });

  it("base64 — the OpenAI SDK's default — decodes to the same little-endian float32 vector", async () => {
    const req = { model: LOCAL_EMBEDDING.model, input: "same text", input_type: "query" };
    const asFloat = await post(server.base, { ...req, encoding_format: "float" });
    const asB64 = await post(server.base, { ...req, encoding_format: "base64" });
    const buf = Buffer.from(asB64.body.data[0]!.embedding as string, "base64");
    expect(buf.length).toBe(LOCAL_EMBEDDING.dimension * 4);
    const decoded = Array.from({ length: LOCAL_EMBEDDING.dimension }, (_, i) =>
      buf.readFloatLE(i * 4),
    );
    const expected = asFloat.body.data[0]!.embedding as number[];
    decoded.forEach((x, i) => expect(x).toBeCloseTo(expected[i]!, 5));
  });

  it("a long query is cut to the query budget on a token boundary; a document gets the whole context", async () => {
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(" ");
    const q = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: words,
      input_type: "query",
    });
    expect(q.status).toBe(200);
    expect(q.body.usage.prompt_tokens).toBeLessThanOrEqual(128);
    expect(q.body.usage.prompt_tokens).toBeGreaterThan(120);
    expect(q.body.truncated_inputs).toBe(1);
    const sent = embedLog().at(-1)!;
    expect(sent.startsWith(QUERY_PREFIX)).toBe(true);
    expect(sent.endsWith(" ")).toBe(false);
    const d = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: words,
      input_type: "passage",
    });
    expect(d.body.usage.prompt_tokens).toBeLessThanOrEqual(512);
    expect(d.body.usage.prompt_tokens).toBeGreaterThan(500);
    expect(d.body.truncated_inputs).toBe(1);
  });

  it("an input cut at the character limit counts as truncated even when its prefix fits the token budget", async () => {
    const r = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: "x".repeat(70000),
      input_type: "passage",
    });
    expect(r.status).toBe(200);
    expect(r.body.truncated_inputs).toBe(1);
  });

  it("a list of inputs answers one vector per input, in order", async () => {
    const r = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: ["a", "b", "c"],
      encoding_format: "float",
    });
    expect(r.body.data.map((d) => d.index)).toEqual([0, 1, 2]);
  });

  it("refuses another model with 404 model_not_found — a misconfigured ov.conf is loud", async () => {
    const r = await post(server.base, { model: "text-embedding-3-small", input: "x" });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("model_not_found");
  });

  it("refuses what the engine never sends: token arrays, a foreign dimension, an unknown input_type, a bad encoding, no JSON", async () => {
    const m = LOCAL_EMBEDDING.model;
    expect((await post(server.base, { model: m, input: [[1, 2, 3]] })).status).toBe(400);
    expect((await post(server.base, { model: m, input: [] })).status).toBe(400);
    expect((await post(server.base, { model: m, input: "x", dimensions: 512 })).status).toBe(400);
    expect((await post(server.base, { model: m, input: "x", input_type: "classify" })).status).toBe(
      400,
    );
    expect(
      (await post(server.base, { model: m, input: "x", encoding_format: "int8" })).status,
    ).toBe(400);
    expect((await post(server.base, "{not json")).status).toBe(400);
    expect((await post(server.base, { model: m, input: "x" }, "/v1/other")).status).toBe(404);
  });

  // The request bounds.
  it("more than 64 inputs in one request is refused", async () => {
    const r = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: Array.from({ length: 65 }, () => "x"),
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/at most 64 inputs/);
    const ok = await post(server.base, {
      model: LOCAL_EMBEDDING.model,
      input: Array.from({ length: 64 }, () => "x"),
    });
    expect(ok.status).toBe(200);
  });

  it("an oversize or invalid Content-Length is a 413 — the body is never read, and the connection closes", async () => {
    for (const length of ["5000000", "-1", "abc"]) {
      const answer = await rawPost(server.port, length);
      expect(answer.head, length).toMatch(/^HTTP\/1\.[01] 413 /);
      // The server closed the connection itself (nothing was sent after the
      // headers, so only the server can have ended it).
      expect(answer.closedByServer, length).toBe(true);
    }
    // …and it still serves.
    expect((await post(server.base, { model: LOCAL_EMBEDDING.model, input: "x" })).status).toBe(
      200,
    );
  });

  it("also answers on /embeddings and lists its one model", async () => {
    expect(
      (await post(server.base, { model: LOCAL_EMBEDDING.model, input: "x" }, "/embeddings")).status,
    ).toBe(200);
    const models = (await (await fetch(`${server.base}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(models.data.map((d) => d.id)).toEqual([LOCAL_EMBEDDING.model]);
  });
});

describe("one argv for the boot scripts and the daemon", () => {
  const cfg = resolveOpenVikingPaths({ ...OPENVIKING_DEFAULTS });

  it("the daemon's localEmbedderArgv == the boot's embedderArgv for the same spec", () => {
    const spec = localEmbedderSpec(cfg, "/opt/quickreview/sandbox");
    expect(spec).toEqual({
      python: "/opt/openviking/venv/bin/python",
      script: "/opt/quickreview/sandbox/scripts/openviking-embedder.py",
      model: LOCAL_EMBEDDING.model,
      file: cfg.local_embedder_file,
      sha256: cfg.local_embedder_sha256,
      port: 1934,
      threads: 1,
    });
    expect(provision.embedderArgv(spec)).toEqual(localEmbedderArgv(spec));
    expect(localEmbedderArgv(spec)).toContain("127.0.0.1");
  });

  it("embedderSpecFromFlags: none ⇒ null (hosted), a partial set ⇒ an error, all seven ⇒ the spec", () => {
    expect(provision.embedderSpecFromFlags(new Map())).toBeNull();
    expect(
      provision.embedderSpecFromFlags(new Map([["embedder-model", LOCAL_EMBEDDING.model]])),
    ).toMatch(/needs --embedder-python/);
    const full = new Map([
      ["embedder-python", "/v/bin/python"],
      ["embedder-script", "/s/openviking-embedder.py"],
      ["embedder-model", LOCAL_EMBEDDING.model],
      ["embedder-file", cfg.local_embedder_file],
      ["embedder-sha256", cfg.local_embedder_sha256],
      ["embedder-port", "1934"],
      ["embedder-threads", "1"],
    ]);
    expect(provision.embedderSpecFromFlags(full)).toEqual({
      python: "/v/bin/python",
      script: "/s/openviking-embedder.py",
      model: LOCAL_EMBEDDING.model,
      file: cfg.local_embedder_file,
      sha256: cfg.local_embedder_sha256,
      port: 1934,
      threads: 1,
    });
    expect(provision.embedderSpecFromFlags(new Map([...full, ["embedder-port", "nope"]]))).toMatch(
      /not a port/,
    );
    // parseArgs carries it.
    expect(
      provision.parseArgs([
        "--embedder-python",
        "/v/bin/python",
        "--embedder-script",
        "/s/e.py",
        "--embedder-model",
        LOCAL_EMBEDDING.model,
        "--embedder-file",
        "/m.gguf",
        "--embedder-sha256",
        "a".repeat(64),
        "--embedder-port",
        "1934",
        "--embedder-threads",
        "1",
      ]).embedder,
    ).toMatchObject({ port: 1934, threads: 1 });
  });

  it("startEmbedder never spawns over a missing model file — it says the image predates it", async () => {
    const lines: string[] = [];
    let spawned = 0;
    const r = await provision.startEmbedder(
      {
        python: "/v/bin/python",
        script: "/s/e.py",
        model: LOCAL_EMBEDDING.model,
        file: "/opt/openviking/models/x.gguf",
        sha256: "a".repeat(64),
        port: 1,
        threads: 1,
      },
      {
        log: (l: string) => lines.push(l),
        exists: (p: string) => !p.endsWith(".gguf"),
        spawnFn: () => {
          spawned += 1;
          throw new Error("must not spawn");
        },
      },
    );
    expect(spawned).toBe(0);
    expect(r).toMatchObject({ child: null, ready: false });
    expect(lines.join("\n")).toMatch(
      /model file .* does not exist — .*scripts\/deploy\.sh rebuild/,
    );
  });

  // Both boot children are unref'd. If the stop's grace timer were unref'd
  // too, node would exit while awaiting the server's stop, the embedder's
  // SIGTERM would never be sent, and the boot would leave an unsupervised
  // embedder on the daemon's port.
  it("sequential stops of two unref'd children both run — node does not exit mid-stop", () => {
    const script = join(dir, "two-stops.mjs");
    writeFileSync(
      script,
      [
        `import { spawn } from "node:child_process";`,
        `import * as prov from ${JSON.stringify(join(root, "scripts", "openviking-provision.mjs"))};`,
        `const kid = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });`,
        `const server = kid();`,
        `const embedder = kid();`,
        `server.unref(); embedder.unref();`,
        `console.log("pids " + server.pid + " " + embedder.pid);`,
        `console.log("server " + (await prov.stopServerChild(server, { graceMs: 5000 })));`,
        `console.log("embedder " + (await prov.stopServerChild(embedder, { graceMs: 5000 })));`,
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 30_000 });
    const pids = /pids (\d+) (\d+)/.exec(r.stdout);
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(r.stdout).toMatch(/server (terminated|killed)/);
      expect(r.stdout).toMatch(/embedder (terminated|killed)/);
    } finally {
      // Never leave a child behind, whatever the outcome.
      for (const pid of pids ? [Number(pids[1]), Number(pids[2])] : [])
        if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  });

  it("startEmbedder runs the REAL service and waits until it serves; stopServerChild ends it", async () => {
    const lines: string[] = [];
    // A free port, chosen by the OS.
    const probe = await startServer();
    const port = probe.port;
    const gone = new Promise((r) => probe.child.on("exit", r));
    probe.child.kill("SIGTERM");
    await gone;
    const r = await provision.startEmbedder(
      {
        python: "python3",
        script: SCRIPT,
        model: LOCAL_EMBEDDING.model,
        file: modelFile,
        sha256: modelSha,
        port,
        threads: 1,
      },
      {
        log: (l: string) => lines.push(l),
        readyTimeoutMs: 20_000,
        exists: () => true,
        spawnFn: (cmd, args, opts) =>
          spawn(cmd, args, { ...opts, env: { ...process.env, PYTHONPATH: dir } }),
      },
    );
    expect(r.ready).toBe(true);
    expect(lines.join("\n")).toMatch(new RegExp(`serving on http://127\\.0\\.0\\.1:${port}`));
    expect(await provision.stopServerChild(r.child)).toMatch(/terminated|already-exited/);
  });
});
