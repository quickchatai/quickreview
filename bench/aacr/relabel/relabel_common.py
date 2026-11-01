"""Shared plumbing of the two labelling passes (martian_tiers.py, lost_credit.py).

A pass builds every model request deterministically from the published data, writes them to a
requests file (`--dry-run` stops there and prints the count, the token estimate and the cost),
and `--run` sends exactly those requests through the Message Batches API, the same route and
the same key file as the Elo judge's Opus client (bench/aacr/elo/elo_judge.py): `bench/aacr/claude.env`
holding `ANTHROPIC_API_KEY=...`, read into memory, never argv or the environment. The answers
become a small JSONL label file; a pass's `--compute` turns labels plus published data into the
paper's numbers with no model call.

`--labeller gpt` (the default) sends the same requests to gpt-6.1-sol instead, through the Elo
judge's GPT endpoint (`bench/aacr/elo/judge-gpt.sh start`, the codex bridge on loopback, on the
ChatGPT login): each request becomes one Chat Completions turn (the system prompt, the one user
message, a strict json_schema answer, no tools), answers are kept per request so a cut-off run
resumes, and the bridge pins the model and the effort. `--labeller opus` keeps the Batch API route.

Pinned for every request: the model (claude-opus-5-5), the effort (`output_config.effort`), the
prompt file's bytes (its sha256 is in every request and label row), a json_schema answer format,
one user message, no tools. Claude Opus 5.5 takes no sampling parameters (temperature, top_p and
top_k are rejected), so the effort level is the pinned setting in their place; any ordering the
passes randomise uses a fixed seed.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional

HERE = Path(__file__).resolve().parent
AACR = HERE.parent
sys.path.insert(0, str(AACR / "recompute"))
sys.path.insert(0, str(AACR / "elo"))
import elo_data  # noqa: E402  (the judges' token estimate, an upper bound)
import elo_judge  # noqa: E402  (the Opus client's key reader and request checks)
import release as RL  # noqa: E402  (the label files as the release carries them, and their check)

MODEL = "claude-opus-5-5"
EFFORT = "high"
GPT_MODEL = "gpt-6.1-sol"
GPT_EFFORT = "xhigh"  # judge-gpt.sh's default, the Elo judge's effort
GPT_URL = "http://127.0.0.1:8790"
MAX_TOKENS = 32000
SEED = 20261030
ENV_FILE = AACR / "claude.env"
# $ per million tokens. Claude Opus 5.5: $4 input / $20 output standard, half on the Batch API
# (the Elo judge's OPUS_BATCH_USD). gpt-6.1-sol at API prices (the Elo judge's GPT_API_USD), what
# the same calls would cost on the API; on the ChatGPT login the GPT judge uses they bill quota.
OPUS_STANDARD_USD = {"input": 4.0, "output": 20.0}
OPUS_BATCH_USD = {"input": 2.0, "output": 10.0}
GPT_API_USD = {"input": 2.0, "output": 10.0}


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def load_prompt(path: Path) -> str:
    return path.read_text()


def rng(*parts: str) -> random.Random:
    """A seeded generator per unit: the same unit always gets the same order."""
    return random.Random(f"{SEED}:" + ":".join(parts))


def params(system: str, user: str, schema: dict) -> dict:
    p = {
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system,
        "messages": [{"role": "user", "content": [{"type": "text", "text": user}]}],
        "output_config": {"effort": EFFORT, "format": {"type": "json_schema", "schema": schema}},
    }
    elo_judge.check_opus_params(p)  # one user message, no tools, a json_schema format
    return p


def custom_id(prefix: str, key: str) -> str:
    return f"{prefix}-{hashlib.sha256(key.encode()).hexdigest()[:24]}"


def write_requests(path: Path, rows: List[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")


def read_jsonl(path: Path) -> List[dict]:
    with open(path) as f:
        return [json.loads(x) for x in f if x.strip()]


def estimate(rows: List[dict], out_per_request: Callable[[dict], int]) -> dict:
    """Token and dollar estimate of a requests file. Input: elo_data.tokens (chars/3, an upper
    bound) over the system prompt and the user message. Output: the pass's own per-request
    allowance, which includes adaptive thinking (billed as output)."""
    tin = sum(elo_data.tokens(r["params"]["system"]) + elo_data.tokens(r["params"]["messages"][0]["content"][0]["text"])
              for r in rows)
    tout = sum(out_per_request(r) for r in rows)

    def usd(p):
        return (tin * p["input"] + tout * p["output"]) / 1e6

    return {"requests": len(rows), "input_tokens_est": tin, "output_tokens_est": tout,
            "usd_opus_batch": usd(OPUS_BATCH_USD), "usd_opus_standard": usd(OPUS_STANDARD_USD),
            "usd_gpt61_api_equivalent": usd(GPT_API_USD), "model": MODEL, "effort": EFFORT,
            "estimate_rule": elo_data.ESTIMATE_RULE}


def print_estimate(name: str, path: Path, est: dict) -> None:
    print(f"{name}: {est['requests']} requests written to {path}")
    print(f"  input  ~{est['input_tokens_est']:,} tokens ({est['estimate_rule']}, an upper bound)")
    print(f"  output ~{est['output_tokens_est']:,} tokens (allowance incl. adaptive thinking)")
    print(f"  {est['model']} at effort {est['effort']}: ${est['usd_opus_batch']:.2f} on the Batch API "
          f"(${est['usd_opus_standard']:.2f} at standard prices)")
    print(f"  alternative gpt-6.1-sol: ${est['usd_gpt61_api_equivalent']:.2f} at API prices "
          f"(quota, not dollars, on the ChatGPT login)")


def parse_message(msg) -> dict:
    """A succeeded batch message -> {status, answer?, usage, stop_reason}: one plain final answer
    (stop_reason end_turn, one text block, no tool block) that parses as JSON."""
    usage = elo_judge._plain(getattr(msg, "usage", None))
    stop = getattr(msg, "stop_reason", None)
    blocks = list(getattr(msg, "content", None) or [])
    kinds = [getattr(b, "type", None) for b in blocks]
    texts = [b.text for b in blocks if getattr(b, "type", None) == "text"]
    base = {"usage": usage, "stop_reason": stop}
    if stop != "end_turn" or len(texts) != 1 or any(k not in ("text", "thinking", "redacted_thinking") for k in kinds):
        return {**base, "status": "invalid", "error": f"stop_reason {stop!r}, blocks {kinds}"}
    try:
        return {**base, "status": "ok", "answer": json.loads(texts[0])}
    except ValueError as e:
        return {**base, "status": "invalid", "error": f"not JSON: {e}"}


def run_batch(rows: List[dict], state: Path, env_file: Path = ENV_FILE, poll_s: int = 60,
              log: Callable[[str], None] = print) -> Dict[str, dict]:
    """Send the requests as one Message Batch (resumable: the batch id is kept in `state`), wait
    for it, and return {custom_id: parse_message(...)}. Needs the anthropic SDK
    (`uv run --no-project --with anthropic==1.15.0 python3 ...`, the Elo judge's pin)."""
    try:
        import anthropic
    except ImportError:
        raise SystemExit("--run needs the anthropic SDK: uv run --no-project --with anthropic==1.15.0 "
                         "--with pyarrow python3 ...") from None
    client = anthropic.Anthropic(api_key=elo_judge.read_anthropic_key(env_file), max_retries=4)
    want = sorted(r["custom_id"] for r in rows)
    st = json.loads(state.read_text()) if state.exists() else {}
    if st.get("ids") != want:
        batch = client.messages.batches.create(requests=[{"custom_id": r["custom_id"], "params": r["params"]} for r in rows])
        st = {"batch_id": batch.id, "ids": want, "submitted_at": time.time()}
        state.write_text(json.dumps(st))
        log(f"submitted batch {batch.id} with {len(rows)} requests")
    while True:
        b = client.messages.batches.retrieve(st["batch_id"])
        if b.processing_status == "ended":
            break
        rc = b.request_counts
        log(f"batch {st['batch_id']}: {b.processing_status} (processing {rc.processing}, succeeded {rc.succeeded}, "
            f"errored {rc.errored})")
        time.sleep(poll_s)
    out: Dict[str, dict] = {}
    for r in client.messages.batches.results(st["batch_id"]):
        if r.result.type != "succeeded":
            out[r.custom_id] = {"status": "error", "error": f"{r.result.type}: {getattr(r.result, 'error', None)}"}
        else:
            out[r.custom_id] = parse_message(r.result.message)
    return out


def labeller(name: str) -> dict:
    """The model and effort a label row records for `--labeller`."""
    return {"model": GPT_MODEL, "effort": GPT_EFFORT} if name == "gpt" else {"model": MODEL, "effort": EFFORT}


def chat_body(p: dict) -> dict:
    """An Opus request's params as one Chat Completions turn for the GPT bridge: the same system
    prompt, the same user message, the same schema (strict), no tools."""
    body = {
        "model": GPT_MODEL,
        "messages": [{"role": "system", "content": p["system"]},
                     {"role": "user", "content": p["messages"][0]["content"][0]["text"]}],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "label", "schema": p["output_config"]["format"]["schema"],
                                            "strict": True}},
    }
    bad = [k for k in elo_judge.TOOL_KEYS if k in body]
    if bad:
        raise ValueError(f"a labelling request must carry no tools: {bad}")
    return body


def parse_chat(resp: object) -> dict:
    """A Chat Completions response -> {status, answer?, usage, finish_reason}: one choice, no tool
    call, finish_reason stop, content that parses as JSON."""
    if not isinstance(resp, dict) or not isinstance(resp.get("choices"), list) or len(resp["choices"]) != 1:
        return {"status": "invalid", "error": "expected exactly one choice"}
    ch = resp["choices"][0] or {}
    msg = ch.get("message") or {}
    base = {"usage": resp.get("usage") or {}, "finish_reason": ch.get("finish_reason")}
    if msg.get("tool_calls") or msg.get("function_call"):
        return {**base, "status": "invalid", "error": "the answer asked for a tool call"}
    if ch.get("finish_reason") != "stop":
        return {**base, "status": "error", "error": f"finish_reason {ch.get('finish_reason')!r}"}
    try:
        return {**base, "status": "ok", "answer": json.loads(msg.get("content") or "")}
    except ValueError as e:
        return {**base, "status": "invalid", "error": f"not JSON: {e}"}


def run_gpt(rows: List[dict], state: Path, url: str = GPT_URL, workers: int = 6,
            log: Callable[[str], None] = print) -> Dict[str, dict]:
    """Send each request to the GPT bridge, `workers` at a time. Every ok answer is appended to
    `state` (JSONL) as it lands, so a re-run sends only what is missing. Rate limits and upstream
    errors are retried with backoff, as the Elo judge does."""
    import urllib.error
    import urllib.request
    from concurrent.futures import ThreadPoolExecutor

    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/health", timeout=5) as r:
            r.read()
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f"gpt labeller not reachable at {url} ({e}); start it: bench/aacr/elo/judge-gpt.sh start") from None
    done: Dict[str, dict] = {}
    if state.exists():
        for x in read_jsonl(state):
            done[x["custom_id"]] = x["result"]
    todo = [r for r in rows if r["custom_id"] not in done]
    log(f"gpt labeller: {len(done)} answers kept, {len(todo)} to send")

    def one(r: dict) -> tuple:
        data = json.dumps(chat_body(r["params"])).encode()
        for wait_s in (30, 60, 120, 240, None):
            req = urllib.request.Request(f"{url.rstrip('/')}/v1/chat/completions", data=data,
                                         headers={"content-type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=3600) as resp:
                    return r["custom_id"], parse_chat(json.loads(resp.read()))
            except urllib.error.HTTPError as e:
                if e.code in (429, 500, 502, 503, 504) and wait_s is not None:
                    time.sleep(wait_s)
                    continue
                return r["custom_id"], {"status": "error", "error": f"HTTP {e.code}: {e.read(400).decode('utf-8', 'replace')}"}
            except (urllib.error.URLError, TimeoutError, ConnectionError, ValueError) as e:
                if wait_s is not None:
                    time.sleep(wait_s)
                    continue
                return r["custom_id"], {"status": "error", "error": f"unreachable: {e}"}
        return r["custom_id"], {"status": "error", "error": "retries spent"}

    state.parent.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(max_workers=workers) as ex, open(state, "a") as f:
        for n, (cid, res) in enumerate(ex.map(one, todo), 1):
            done[cid] = res
            if res["status"] == "ok":
                f.write(json.dumps({"custom_id": cid, "result": res}) + "\n")
                f.flush()
            log(f"  {n}/{len(todo)} {cid}: {res['status']}")
    return done


def write_labels(path: Path, rows: Iterable[dict]) -> int:
    rows = sorted(rows, key=lambda r: json.dumps(r.get("key"), sort_keys=True))
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    return len(rows)


def compute_labels(arg: Optional[str], root: Path, name: str) -> tuple:
    """The label file a `--compute` reads: `--labels` when given, else the one the release carries
    (`analysis/relabel/` of the unpacked archive). Its rows must record a model and the sha256 of the
    prompt file beside it; anything else stops the compute. Returns (path, summary)."""
    path = Path(arg) if arg else root / RL.DIR / f"{name}.labels.jsonl"
    prompt = path.parent / f"{name}.prompt.md"
    for f in (path, prompt):
        if not f.exists():
            raise SystemExit(f"no {f.name} at {f.parent}: the release carries it in the analysis volume ({RL.DIR}/)")
    rows = RL.read_rows(path)
    errs = RL.check_rows(rows, prompt.read_text(), f"{path.name} ")
    if errs:
        raise SystemExit(f"{len(errs)} label rows fail the check: " + "; ".join(errs[:5]))
    return path, {"rows": len(rows), "model": sorted({r["model"] for r in rows}),
                  "effort": sorted({str(r.get("effort")) for r in rows}), "prompt_sha256": RL.sha256(prompt.read_text())}


def work_dir(arg: Optional[str], name: str) -> Path:
    return Path(arg or os.path.join(os.environ.get("TMPDIR", "."), "relabel", name)).resolve()


def f2(p: float, r: float) -> float:
    return 5 * p * r / (4 * p + r) if p + r else 0.0
