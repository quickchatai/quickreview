"""The pairwise judge: one prompt, one JSON schema, two clients.

One judgment is ONE model call with everything up front and no tools
: the system instructions, then the shared PR context (the same
bytes for every pair on that PR, so both providers can cache it), then
Review A and Review B. Both judges get byte-identical prompts.

  gpt    gpt-6.1-sol at xhigh through ext_judge.py (the codex bridge) in the
         judge container `judge-gpt.sh` starts — Chat Completions with a strict
         json_schema response_format, on loopback.
  opus   claude-opus-5-5 at xhigh through the Message Batches API (official
         `anthropic` SDK, run under `uv run --with`), output_config.format
         json_schema. The key is read from bench/aacr/claude.env
         (ANTHROPIC_API_KEY=…) and handed to the client in memory — never
         argv, never the process environment.

"One call" is checked, not assumed: the request bodies are built by
`chat_body` and `opus_params`, which refuse anything carrying a tool key,
more than the one prompt, or no json_schema format; an answer counts only
when it is one plain final message (GPT: one choice, no tool calls,
finish_reason "stop"; Opus: stop_reason "end_turn", one text block, no tool
block). Every answer records `turns: 1` and its finish or stop reason.
"""
from __future__ import annotations

import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Dict, List

CATEGORIES = ("recall", "precision", "finding_quality", "writing")
WINNERS = ("A", "B", "tie")

SYSTEM = """You are judging two code reviews of the same pull request, written by two different automated reviewers. Decide which review is better, overall and in four categories, and explain why.

You get, in order: the pull request's title and description; its diff; the files it touches as they are at the head commit (line-numbered; a file too large for the prompt appears as its diff with wide context); the benchmark's golden comments, which are the issues the benchmark's authors expect a good review of this PR to raise; then Review A and Review B. You have no tools. Everything you may rely on is in this message, so read the code itself whenever a claim depends on it, and take as long as you need.

How to weigh the evidence:
- The golden comments are a strong reference, not ground truth. A golden comment can be wrong, trivial or incomplete, and the golden set can miss real defects. You may decide that a finding outside the golden set is a real defect, or that a golden comment is mistaken, but only by pointing at the code in this message (file, line, what it does). Without that evidence, defer to the golden set.
- A finding that matches no golden comment is not a false positive by default. Check its claim against the code. It is a false positive when the code shows the claim is wrong, when the failure it describes cannot happen, or when it is noise a maintainer would not want to read. It is a valid extra finding when the code bears it out and it matters.
- Judge what each review says, not how much it says. More findings, longer text and confident tone earn nothing on their own. Several comments about one root cause count as one finding, and the repetition costs attention.
- The reviews have been rewritten into one neutral format. Severity labels appear only where a review stated one. Do not guess which tool wrote which review, and do not let the order (A first, B second) influence you.

The four categories:
- recall: which review catches more of the real defects that matter: the golden comments it raises, plus real defects the golden set lacks. Weigh by severity; missing a serious defect costs far more than missing a minor one.
- precision: which review spends less of the author's attention on findings that are wrong, unreachable or not worth raising. Consider both the share and the absolute number of such findings.
- finding_quality: for the findings that are real, which review states them better: a correct severity, a precise location, a concrete failure scenario, the root cause rather than a symptom, and a fix the author can act on.
- writing: which review a developer can read and act on faster: clear, concise, well organised, no padding, findings and summary body together.

Overall: which review a maintainer of this repository would rather have received on this pull request. Catching the serious defects and not wasting the author's time matter most; finding quality next; writing can decide a close call.

Use "tie" in a category or overall when the difference is too small to matter, or when the reviews are better in offsetting ways you cannot rank. Do not use it to avoid a hard call.

For each category write your reasoning first, then the winner. In overall.explanation write an account someone can read without the reviews open: the decisive differences, with the specific findings involved (by file and line, and by golden comment number), any golden comment you judged wrong and why, and any real defect both reviews missed."""

_VERDICT = {
    "type": "object",
    "properties": {
        "reasoning": {"type": "string"},
        "winner": {"type": "string", "enum": list(WINNERS)},
    },
    "required": ["reasoning", "winner"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "categories": {
            "type": "object",
            "properties": {c: _VERDICT for c in CATEGORIES},
            "required": list(CATEGORIES),
            "additionalProperties": False,
        },
        "overall": {
            "type": "object",
            "properties": {
                "explanation": {"type": "string"},
                "winner": {"type": "string", "enum": list(WINNERS)},
            },
            "required": ["explanation", "winner"],
            "additionalProperties": False,
        },
    },
    "required": ["categories", "overall"],
    "additionalProperties": False,
}

CLOSING = "Judge the two reviews now, following the instructions."


def reviews_text(review_a: str, review_b: str) -> str:
    return f"{review_a}\n\n{review_b}\n\n{CLOSING}"


def prompt_sha(context: str, reviews: str) -> str:
    """The judgment's prompt identity: the instructions, the shared PR
    context and the two reviews, exactly the texts both judges are sent."""
    h = hashlib.sha256()
    for part in (SYSTEM, context, reviews):
        h.update(part.encode())
        h.update(b"\0")
    return h.hexdigest()


# Request keys that would let a judge call a tool or run a loop. A judge
# request carrying one is refused before it is sent.
TOOL_KEYS = ("tools", "tool_choice", "functions", "function_call", "parallel_tool_calls")


def chat_body(model: str, context: str, reviews: str) -> dict:
    """The GPT judge's Chat Completions request: one turn, no tools."""
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": context},
            {"role": "user", "content": reviews},
        ],
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "pairwise_verdict", "schema": SCHEMA, "strict": True}},
    }
    check_chat_body(body)
    return body


def check_chat_body(body: dict) -> None:
    bad = [k for k in TOOL_KEYS if k in body]
    if bad:
        raise ValueError(f"a judge request must carry no tools: {bad}")
    roles = [m.get("role") for m in body.get("messages") or []]
    if roles != ["system", "user", "user"]:
        raise ValueError(f"a judge request is one turn (system, context, reviews), got roles {roles}")
    if (body.get("response_format") or {}).get("type") != "json_schema":
        raise ValueError("a judge request must ask for the json_schema format")


def parse_chat_response(resp: object) -> dict:
    """A Chat Completions response → {status: ok|error|invalid, verdict?,
    usage, turns, finish_reason, error?}. Only one plain final message
    counts: one choice, no tool call, finish_reason "stop"."""
    if not isinstance(resp, dict):
        return {"status": "invalid", "error": "response is not a JSON object"}
    usage = resp.get("usage") or {}
    choices = resp.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        n = len(choices) if isinstance(choices, list) else 0
        return {"status": "invalid", "error": f"expected exactly one choice, got {n}", "usage": usage}
    finish = choices[0].get("finish_reason")
    message = choices[0].get("message") or {}
    text = message.get("content") or ""

    def ans(status: str, **extra: Any) -> dict:
        return {"status": status, "turns": 1, "finish_reason": finish, "usage": usage, **extra}

    if message.get("tool_calls") or message.get("function_call"):
        return ans("invalid", error="the answer asked for a tool call")
    if finish == "length":
        return ans("error", error="finish_reason length: output cut off", raw=text[:2000])
    if finish != "stop":
        return ans("invalid", error=f"finish_reason {finish!r}, not 'stop'", raw=text[:2000])
    try:
        return ans("ok", verdict=check_verdict(json.loads(text)))
    except ValueError as e:
        return ans("invalid", error=str(e), raw=text[:2000])


def check_verdict(obj: object) -> dict:
    """The verdict exactly as the schema has it, or ValueError."""
    if not isinstance(obj, dict):
        raise ValueError("verdict is not an object")
    cats = obj.get("categories")
    overall = obj.get("overall")
    if not isinstance(cats, dict) or not isinstance(overall, dict):
        raise ValueError("verdict lacks categories/overall")
    out = {"categories": {}, "overall": {}}
    for c in CATEGORIES:
        v = cats.get(c)
        if not isinstance(v, dict) or v.get("winner") not in WINNERS:
            raise ValueError(f"category {c}: no valid winner")
        out["categories"][c] = {"winner": v["winner"], "reasoning": str(v.get("reasoning") or "")}
    if overall.get("winner") not in WINNERS:
        raise ValueError("overall: no valid winner")
    out["overall"] = {"winner": overall["winner"], "explanation": str(overall.get("explanation") or "")}
    return out


# ---- gpt-6.1-sol via the judge container's bridge ----------------------------------

class GptJudge:
    name = "gpt"

    def __init__(self, url: str, model: str, effort: str, timeout_s: int = 3600):
        self.url = url.rstrip("/")
        self.model = model
        self.effort = effort
        self.timeout_s = timeout_s

    def health(self) -> dict:
        with urllib.request.urlopen(f"{self.url}/health", timeout=5) as r:
            return json.loads(r.read())

    def judge(self, context: str, reviews: str) -> dict:
        """One call → {status: ok|error|invalid, verdict?, usage?, error?,
        turns, finish_reason, http_attempts}."""
        data = json.dumps(chat_body(self.model, context, reviews)).encode()
        # Rate limits and upstream hiccups are retried here with backoff, so
        # running many judgments at once never spends a unit's attempts on them.
        # Each retry resends the same single turn; `http_attempts` counts them,
        # so the bridge log's request count can be reconciled with the rows.
        attempts = 0
        for wait_s in (30, 60, 120, 240, None):
            attempts += 1
            req = urllib.request.Request(f"{self.url}/v1/chat/completions", data=data,
                                         headers={"content-type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=self.timeout_s) as r:
                    resp = json.loads(r.read())
                break
            except urllib.error.HTTPError as e:
                detail = e.read(800).decode("utf-8", "replace")
                if e.code in (429, 500, 502, 503, 504) and wait_s is not None:
                    time.sleep(wait_s)
                    continue
                return {"status": "error", "error": f"HTTP {e.code}: {detail}", "http_attempts": attempts}
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                return {"status": "error", "error": f"unreachable: {e}", "http_attempts": attempts}
            except ValueError as e:
                return {"status": "invalid", "error": f"response is not JSON: {e}", "http_attempts": attempts}
        return {**parse_chat_response(resp), "http_attempts": attempts}


# ---- claude-opus-5-5 via the Message Batches API ---------------------------------------

def read_anthropic_key(env_file: Path) -> str:
    if not env_file.is_file() or env_file.is_symlink():
        raise SystemExit(f"the Opus judge needs ANTHROPIC_API_KEY=<key> in {env_file} (a regular file)")
    for line in env_file.read_text().splitlines():
        if line.startswith("ANTHROPIC_API_KEY="):
            key = line.split("=", 1)[1].strip().strip('"').strip("'")
            if key:
                return key
    raise SystemExit(f"{env_file} has no ANTHROPIC_API_KEY= line (an OAuth token cannot use the Batches API)")


def opus_params(model: str, max_tokens: int, effort: str, context: str, reviews: str) -> dict:
    """The Opus judge's Messages request: the same three texts as the GPT
    judge's, one user turn, no tools."""
    params = {
        "model": model,
        "max_tokens": max_tokens,
        "system": SYSTEM,
        "messages": [{"role": "user", "content": [
            # The PR context is shared by every pair on this PR: cache it
            # (1 h — a batch can take longer than the 5 min default).
            {"type": "text", "text": context, "cache_control": {"type": "ephemeral", "ttl": "1h"}},
            {"type": "text", "text": reviews},
        ]}],
        "output_config": {"effort": effort, "format": {"type": "json_schema", "schema": SCHEMA}},
    }
    check_opus_params(params)
    return params


def check_opus_params(params: dict) -> None:
    bad = [k for k in TOOL_KEYS if k in params]
    if bad:
        raise ValueError(f"a judge request must carry no tools: {bad}")
    msgs = params.get("messages") or []
    if len(msgs) != 1 or msgs[0].get("role") != "user":
        raise ValueError(f"a judge request is exactly one user message, got {[m.get('role') for m in msgs]}")
    if ((params.get("output_config") or {}).get("format") or {}).get("type") != "json_schema":
        raise ValueError("a judge request must ask for the json_schema format")


def _plain(obj: object) -> dict:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return dict(obj)
    if hasattr(obj, "to_dict"):
        return obj.to_dict()
    return dict(vars(obj))


# Content blocks a plain single-turn answer may hold beside its one text block.
_OPUS_QUIET_BLOCKS = ("thinking", "redacted_thinking")


def parse_opus_message(msg: object) -> dict:
    """A succeeded batch message → {status: ok|error|refused|invalid, verdict?,
    usage, turns, stop_reason, error?}. Only one plain final message counts:
    stop_reason "end_turn", exactly one text block, no tool block."""
    usage = _plain(getattr(msg, "usage", None))
    stop = getattr(msg, "stop_reason", None)
    blocks = list(getattr(msg, "content", None) or [])
    kinds = [getattr(b, "type", None) for b in blocks]
    text = next((b.text for b in blocks if getattr(b, "type", None) == "text"), "")

    def ans(status: str, **extra: Any) -> dict:
        return {"status": status, "turns": 1, "stop_reason": stop, "usage": usage, **extra}

    if stop == "refusal":
        details = _plain(getattr(msg, "stop_details", None)) or None
        return ans("refused", error=f"refusal: {details}")
    if stop in ("max_tokens", "model_context_window_exceeded"):
        return ans("error", error=f"{stop}: output cut off", raw=text[:2000])
    tool_blocks = [k for k in kinds if k and ("tool_use" in k or "tool_result" in k)]
    if stop != "end_turn" or tool_blocks:
        return ans("invalid", error=f"stop_reason {stop!r}, blocks {kinds}: not one plain final answer",
                   raw=text[:2000])
    other = [k for k in kinds if k != "text" and k not in _OPUS_QUIET_BLOCKS]
    if kinds.count("text") != 1 or other:
        return ans("invalid", error=f"expected exactly one text block, got blocks {kinds}", raw=text[:2000])
    try:
        return ans("ok", verdict=check_verdict(json.loads(text)))
    except ValueError as e:
        return ans("invalid", error=str(e), raw=text[:2000])


class OpusJudge:
    name = "opus"

    def __init__(self, env_file: Path, model: str, effort: str, max_tokens: int = 128000):
        try:
            import anthropic  # noqa: F401 - run under `uv run --with anthropic==…` (README)
        except ImportError:
            raise SystemExit("the Opus judge needs the anthropic SDK: run elo.py under "
                             "`uv run --with anthropic==<version> python3 …` (bench/aacr/elo/README.md)") from None
        import anthropic
        self.client = anthropic.Anthropic(api_key=read_anthropic_key(env_file), max_retries=4)
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens

    def params(self, context: str, reviews: str) -> dict:
        return opus_params(self.model, self.max_tokens, self.effort, context, reviews)

    def live(self, context: str, reviews: str) -> dict:
        """One judgment as a live (streamed) Messages call, the same single
        turn as a batch request: full price, minutes instead of hours."""
        import anthropic
        try:
            with self.client.messages.stream(**self.params(context, reviews)) as stream:
                msg = stream.get_final_message()
        except anthropic.APIError as e:
            return {"status": "error", "error": f"{type(e).__name__}: {str(e)[:800]}"}
        return parse_opus_message(msg)

    def submit(self, requests: List[dict]) -> str:
        """requests: [{custom_id, params}] → batch id."""
        batch = self.client.messages.batches.create(requests=requests)
        return batch.id

    def status(self, batch_id: str) -> str:
        return self.client.messages.batches.retrieve(batch_id).processing_status

    def wait(self, batch_id: str, poll_s: int = 60, log: Callable[[str], None] = print) -> None:
        while True:
            b = self.client.messages.batches.retrieve(batch_id)
            if b.processing_status == "ended":
                return
            rc = b.request_counts
            log(f"opus batch {batch_id}: {b.processing_status} (processing {rc.processing}, "
                f"succeeded {rc.succeeded}, errored {rc.errored})")
            time.sleep(poll_s)

    def results(self, batch_id: str) -> Dict[str, dict]:
        out: Dict[str, dict] = {}
        for r in self.client.messages.batches.results(batch_id):
            res = r.result
            if res.type != "succeeded":
                err = getattr(res, "error", None)
                out[r.custom_id] = {"status": "error", "error": f"{res.type}: {err}"}
                continue
            out[r.custom_id] = parse_opus_message(res.message)
        return out
