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
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Dict, List

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
        """One call → {status: ok|error|invalid, verdict?, usage?, error?}."""
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": context},
                {"role": "user", "content": reviews},
            ],
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "pairwise_verdict", "schema": SCHEMA, "strict": True}},
        }
        data = json.dumps(body).encode()
        # Rate limits and upstream hiccups are retried here with backoff, so
        # running many judgments at once never spends a unit's attempts on them.
        for wait_s in (30, 60, 120, 240, None):
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
                return {"status": "error", "error": f"HTTP {e.code}: {detail}"}
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                return {"status": "error", "error": f"unreachable: {e}"}
        usage = resp.get("usage") or {}
        text = ((resp.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        try:
            return {"status": "ok", "verdict": check_verdict(json.loads(text)), "usage": usage}
        except ValueError as e:
            return {"status": "invalid", "error": str(e), "raw": text[:2000], "usage": usage}


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
        return {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": SYSTEM,
            "messages": [{"role": "user", "content": [
                # The PR context is shared by every pair on this PR: cache it
                # (1 h — a batch can take longer than the 5 min default).
                {"type": "text", "text": context, "cache_control": {"type": "ephemeral", "ttl": "1h"}},
                {"type": "text", "text": reviews},
            ]}],
            "output_config": {"effort": self.effort, "format": {"type": "json_schema", "schema": SCHEMA}},
        }

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
            msg = res.message
            usage = msg.usage.to_dict() if hasattr(msg.usage, "to_dict") else dict(msg.usage)
            if msg.stop_reason == "refusal":
                details = msg.stop_details.to_dict() if getattr(msg, "stop_details", None) else None
                out[r.custom_id] = {"status": "refused", "error": f"refusal: {details}", "usage": usage}
                continue
            if msg.stop_reason == "max_tokens":
                out[r.custom_id] = {"status": "error", "error": "max_tokens: output cut off", "usage": usage}
                continue
            text = next((b.text for b in msg.content if b.type == "text"), "")
            try:
                out[r.custom_id] = {"status": "ok", "verdict": check_verdict(json.loads(text)), "usage": usage}
            except ValueError as e:
                out[r.custom_id] = {"status": "invalid", "error": str(e), "raw": text[:2000], "usage": usage}
        return out

