#!/usr/bin/env python3
"""The local English embedder.

An OpenAI-compatible ``POST /v1/embeddings`` on loopback, serving one pinned
GGUF through the pinned llama-cpp-python in the OpenViking venv. OpenViking's
ov.conf points its ``openai`` provider at it (``api_base`` on 127.0.0.1), which
maps to the server's async embedder: a search does not run a model on the
server's one event loop, so it does not stall every other request. Nothing
leaves the machine: the model file is baked into the image at build
time, verified by sha256 there and again here, and this process binds
loopback only.

Why a server of our own rather than the engine's ``local`` provider: 0.4.15's
``local`` provider ships one model (``bge-small-zh-v1.5``, Chinese-first),
prefixes every English query with a hard-wired Chinese instruction, and runs
synchronously on the event loop. docs/memory-embeddings.md has the evaluation
behind the model choice.

The model table below is code, not a knob: a model's query/document prefixes
and its context are part of what its vectors mean, so adding one is a reviewed
change (and a ``rebuild`` for the file). ``--describe`` prints the table; the
TypeScript side (``LOCAL_EMBEDDING`` in src/config.ts) is held to it by
tests/openviking-embedder.test.ts.

Query vs document: ov.conf sets ``query_param``/``document_param``, so the
engine sends ``input_type: "query"`` or ``"passage"`` in the request body. A
query gets the model's query instruction and is cut to ``QUERY_MAX_TOKENS`` (the
~100 ms one-thread budget); a document gets the document prefix and the
model's whole context. Text past the limit is cut on a token boundary, never
mid-token, and the special tokens stay intact.

Stdlib only beside llama_cpp (which the image pins), so it runs from the
synced repo against the image's venv: ``<venv>/bin/python
scripts/openviking-embedder.py --model-path … --model-name … --sha256 …``.
"""

import argparse
import base64
import hashlib
import json
import math
import os
import signal
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# name -> spec. The name is what ov.conf's `embedding.dense.model` sends and
# what the collection's embedding record stores; the GGUF file is
# `<models dir>/<name>.gguf`.
MODELS = {
    "bge-small-en-v1.5-f16": {
        "dimension": 384,
        "context": 512,
        # BAAI's documented instruction for short-query → passage retrieval.
        "query_prefix": "Represent this sentence for searching relevant passages: ",
        "document_prefix": "",
        "license": "MIT",
        "source": "BAAI/bge-small-en-v1.5 (GGUF: CompendiumLabs/bge-small-en-v1.5-gguf)",
    },
}

# A query is cut to this many tokens: ~90 ms on one thread for the model above
# (measured, docs/memory-embeddings.md). A round's context query is ~35 tokens;
# only a session's whole-prompt recall query ever reaches the cap.
QUERY_MAX_TOKENS = 128
# Request bounds: the engine sends one text per call; anything near these is
# not this deployment talking.
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_INPUTS = 64
# A text is cut to this many characters before it is even tokenized, so one
# huge input cannot cost a long tokenize under the model lock.
MAX_TEXT_CHARS = 65536
LOOPBACK = ("127.0.0.1", "::1", "localhost")
QUERY_TYPES = ("query", "search_query")
DOCUMENT_TYPES = ("passage", "document", "search_document")
# The line the daemon's supervisor and the provisioning step wait for.
READY_PREFIX = "openviking-embedder: ready"

# Exit codes — distinct so a boot log says which kind of refusal it was.
EXIT_USAGE = 2
EXIT_MODEL_FILE = 3
EXIT_RUNTIME = 4


def log(line):
    print(f"openviking-embedder: {line}", flush=True)


def sha256_of(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def l2(vector):
    norm = math.sqrt(sum(x * x for x in vector))
    return [x / norm for x in vector] if norm > 0 else list(vector)


class RequestError(Exception):
    def __init__(self, status, message, code="invalid_request_error"):
        super().__init__(message)
        self.status = status
        self.code = code


class Model:
    """One llama context and the lock that serializes it. llama-cpp releases
    the GIL inside a decode, so `/health` keeps answering while a long
    embedding runs; two embeddings never share the context at once."""

    def __init__(self, llama, name, spec, query_max_tokens):
        self.llm = llama
        self.name = name
        self.spec = spec
        self.query_max_tokens = min(query_max_tokens, spec["context"])
        self.lock = threading.Lock()

    def count(self, text):
        return len(self.llm.tokenize(text.encode("utf-8"), add_bos=True, special=False))

    def fit(self, text, max_tokens):
        """`(text, tokens, truncated)` with `tokens <= max_tokens`: the longest
        character prefix that fits, found by bisection — model-agnostic, and
        it keeps the special tokens the tokenizer adds."""
        text = text[:MAX_TEXT_CHARS]
        n = self.count(text)
        if n <= max_tokens:
            return text, n, False
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.count(text[:mid]) <= max_tokens:
                lo = mid
            else:
                hi = mid - 1
        cut = text[:lo].rstrip()  # whitespace at the cut edge carries nothing
        return cut, self.count(cut), True

    def embed(self, texts, is_query):
        prefix = self.spec["query_prefix"] if is_query else self.spec["document_prefix"]
        limit = self.query_max_tokens if is_query else self.spec["context"]
        vectors, tokens, truncated = [], 0, 0
        with self.lock:
            for text in texts:
                fitted, n, cut = self.fit(prefix + text, limit)
                raw = self.llm.embed(fitted, normalize=False, truncate=True)
                if raw and isinstance(raw[0], list):
                    raise RequestError(500, "the model returned per-token vectors (no pooling)", "server_error")
                if len(raw) != self.spec["dimension"]:
                    raise RequestError(
                        500,
                        f"the model returned {len(raw)} dims, not {self.spec['dimension']}",
                        "server_error",
                    )
                vectors.append(l2([float(x) for x in raw]))
                tokens += n
                truncated += 1 if cut else 0
        return vectors, tokens, truncated


def parse_request(body, model):
    """The validated request: `(texts, is_query, encoding)`. Raises
    RequestError with the status the client should see."""
    try:
        req = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RequestError(400, f"the body is not JSON: {exc}")
    if not isinstance(req, dict):
        raise RequestError(400, "the body must be a JSON object")
    name = req.get("model")
    if name != model.name:
        raise RequestError(
            404,
            f"model {name!r} is not served here — this embedder serves {model.name!r} only",
            "model_not_found",
        )
    raw = req.get("input")
    if isinstance(raw, str):
        texts = [raw]
    elif isinstance(raw, list) and raw and all(isinstance(t, str) for t in raw):
        texts = raw
    else:
        raise RequestError(400, "input must be a string or a non-empty list of strings (token arrays are not accepted)")
    if len(texts) > MAX_INPUTS:
        raise RequestError(400, f"at most {MAX_INPUTS} inputs per request")
    kind = req.get("input_type")
    if kind is None or (isinstance(kind, str) and kind.lower() in DOCUMENT_TYPES):
        is_query = False
    elif isinstance(kind, str) and kind.lower() in QUERY_TYPES:
        is_query = True
    else:
        raise RequestError(400, f"input_type {kind!r} is neither a query ({', '.join(QUERY_TYPES)}) nor a document ({', '.join(DOCUMENT_TYPES)})")
    dims = req.get("dimensions")
    if dims is not None and dims != model.spec["dimension"]:
        raise RequestError(400, f"dimensions={dims!r}: this model has exactly {model.spec['dimension']}")
    encoding = req.get("encoding_format") or "float"
    if encoding not in ("float", "base64"):
        raise RequestError(400, f"encoding_format {encoding!r} is not float or base64")
    return texts, is_query, encoding


def encode(vector, encoding):
    if encoding == "base64":
        # The OpenAI SDK's default: little-endian float32, base64.
        return base64.b64encode(struct.pack(f"<{len(vector)}f", *vector)).decode("ascii")
    return vector


def make_handler(model, describe):
    class Handler(BaseHTTPRequestHandler):
        server_version = "qcr-embedder"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # one line per refusal, none per request
            pass

        def send_json(self, status, payload):
            data = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def send_error_json(self, status, message, code):
            self.send_json(status, {"error": {"message": message, "type": code, "code": code}})

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path == "/health":
                self.send_json(200, {"status": "ok", **describe})
            elif path in ("/v1/models", "/models"):
                self.send_json(200, {"object": "list", "data": [{"id": model.name, "object": "model", "owned_by": "local"}]})
            else:
                self.send_error_json(404, f"no route {path}", "not_found")

        def do_POST(self):
            path = self.path.split("?", 1)[0]
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                length = -1
            if length < 0 or length > MAX_BODY_BYTES:
                # The body is not read, so this connection cannot carry another
                # request: close it rather than parse the rest as one.
                self.close_connection = True
                self.send_error_json(413, f"the body must be at most {MAX_BODY_BYTES} bytes", "invalid_request_error")
                return
            # Read the body before any answer: on a kept-alive connection an
            # unread body would be parsed as the next request.
            body = self.rfile.read(length)
            if path not in ("/v1/embeddings", "/embeddings"):
                self.send_error_json(404, f"no route {path}", "not_found")
                return
            try:
                texts, is_query, encoding = parse_request(body, model)
                vectors, tokens, truncated = model.embed(texts, is_query)
            except RequestError as exc:
                log(f"refused ({exc.status}): {exc}")
                self.send_error_json(exc.status, str(exc), exc.code)
                return
            except Exception as exc:  # noqa: BLE001 — any model failure is a 500, never a hung or dead server
                log(f"embedding failed: {exc}")
                self.send_error_json(500, f"embedding failed: {exc}", "server_error")
                return
            self.send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {"object": "embedding", "index": i, "embedding": encode(v, encoding)}
                        for i, v in enumerate(vectors)
                    ],
                    "model": model.name,
                    "usage": {"prompt_tokens": tokens, "total_tokens": tokens},
                    "truncated_inputs": truncated,
                },
            )

    return Handler


def parse_args(argv):
    p = argparse.ArgumentParser(description="Loopback OpenAI-compatible embeddings over one pinned GGUF.")
    p.add_argument("--model-path", help="the GGUF file baked into the image")
    p.add_argument("--model-name", help="the name ov.conf sends; must be in the model table")
    p.add_argument("--sha256", help="the pinned sha256 of the GGUF; refused on mismatch")
    p.add_argument("--dimension", type=int, help="optional: refused unless it equals the table's dimension")
    p.add_argument("--host", default="127.0.0.1", help="loopback only")
    p.add_argument("--port", type=int, default=1934, help="0 picks a free port (tests)")
    p.add_argument("--threads", type=int, default=1)
    p.add_argument("--query-max-tokens", type=int, default=QUERY_MAX_TOKENS)
    p.add_argument("--describe", action="store_true", help="print the model table as JSON and exit")
    return p.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    if args.describe:
        print(json.dumps({"models": MODELS, "query_max_tokens": QUERY_MAX_TOKENS}, indent=2, ensure_ascii=False))
        return 0
    if args.host not in LOOPBACK:
        log(f"REFUSED: --host {args.host} is not loopback — this server never listens beyond the container")
        return EXIT_USAGE
    if not args.model_path or not args.model_name or not args.sha256:
        log("REFUSED: --model-path, --model-name and --sha256 are all required")
        return EXIT_USAGE
    spec = MODELS.get(args.model_name)
    if spec is None:
        log(f"REFUSED: unknown model {args.model_name!r} — this embedder knows {', '.join(sorted(MODELS))}")
        return EXIT_USAGE
    if args.dimension is not None and args.dimension != spec["dimension"]:
        log(f"REFUSED: {args.model_name} has {spec['dimension']} dims, not {args.dimension}")
        return EXIT_USAGE
    if not 1 <= args.threads <= 16:
        log(f"REFUSED: --threads {args.threads} is outside 1..16")
        return EXIT_USAGE
    if not 1 <= args.query_max_tokens <= spec["context"]:
        log(f"REFUSED: --query-max-tokens {args.query_max_tokens} is outside 1..{spec['context']}")
        return EXIT_USAGE
    if not os.path.isfile(args.model_path):
        log(f"REFUSED: the model file {args.model_path} does not exist — it is baked into the image; rebuild it (scripts/deploy.sh rebuild)")
        return EXIT_MODEL_FILE
    actual = sha256_of(args.model_path)
    if actual != args.sha256.lower():
        log(f"REFUSED: {args.model_path} has sha256 {actual}, the pin says {args.sha256.lower()} — not serving an unpinned model")
        return EXIT_MODEL_FILE
    try:
        from llama_cpp import Llama  # the image pins it in the OpenViking venv
    except (ImportError, OSError) as exc:  # OSError: the shared library failed to load
        log(f"REFUSED: llama_cpp cannot be imported ({exc}) — run this with the OpenViking venv's python")
        return EXIT_RUNTIME
    ctx = spec["context"]
    try:
        llama = Llama(
            model_path=args.model_path,
            embedding=True,
            n_ctx=ctx,
            n_batch=ctx,
            n_ubatch=ctx,
            n_threads=args.threads,
            n_threads_batch=args.threads,
            verbose=False,
        )
        model = Model(llama, args.model_name, spec, args.query_max_tokens)
        if llama.n_embd() != spec["dimension"]:
            raise RuntimeError(f"the file embeds {llama.n_embd()} dims, the table says {spec['dimension']}")
        model.embed(["ok"], True)  # self-check: pooled, the right size
    except Exception as exc:  # noqa: BLE001 — whatever stops the model loading is a refusal to serve
        log(f"REFUSED: could not load {args.model_path}: {exc}")
        return EXIT_RUNTIME
    describe = {
        "model": args.model_name,
        "dimension": spec["dimension"],
        "context": ctx,
        "query_max_tokens": model.query_max_tokens,
        "threads": args.threads,
        "sha256": actual,
    }
    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(model, describe))
    except OSError as exc:
        log(f"REFUSED: cannot listen on {args.host}:{args.port}: {exc}")
        return EXIT_RUNTIME
    server.daemon_threads = True

    def stop(signum, _frame):
        log(f"stopping on signal {signum}")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    host, port = server.server_address[:2]
    log(
        f"ready — {args.model_name} ({spec['dimension']} dims, sha256 verified, "
        f"{args.threads} thread{'s' if args.threads != 1 else ''}) on {host}:{port}"
    )
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
