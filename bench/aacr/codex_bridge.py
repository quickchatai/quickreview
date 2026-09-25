#!/usr/bin/env python3
"""A loopback OpenAI-compatible endpoint over the ChatGPT Codex backend.

The OCR baseline arm (bench/aacr/Dockerfile, target `ocr`) runs
open-code-review against the same model the production reviewer's
conversation runs (`openai-codex/gpt-6-sol`). OCR speaks the public OpenAI
APIs, NON-streaming (v1.3.x: Chat Completions only; newer: Responses too); the
only access this benchmark has to that model is the shared pi login, whose
ChatGPT Codex backend (a Responses endpoint) accepts STREAMING requests only.
This bridge sits between them, inside the sandbox, on 127.0.0.1:

  POST /v1/chat/completions   OCR <= 1.3.x: the chat request is translated to a
                              Responses request — the LEADING system messages
                              become `instructions`, a later system/developer
                              message a `developer` input item, tool calls
                              `function_call` / `function_call_output` items,
                              tools flat function tools (strict:false, the
                              Chat Completions default) — streamed upstream,
                              the SSE aggregated until `response.completed`,
                              and translated back into one chat.completion
                              (text, tool_calls, usage).
  POST /v1/responses          newer OCR: forced to stream/store:false,
                              aggregated, returned whole.
  POST /label                 {"label": "<case id>"}: tags later log rows.
  GET  /health, GET /stats    liveness; cumulative request + token counters.

What it forces, so every call is the configured model at the configured
effort whatever OCR asks for: `model`, `reasoning.effort`, `store: false`,
`stream: true`, and a `prompt_cache_key` derived from the conversation's
opening (instructions + first input item), so an agent's tool loop reuses the
backend's prompt cache the way the public API's automatic prefix caching does
— a performance/traffic measure only. What it DROPS (the backend refuses them
or they have no Responses equivalent), logged per request: sampling params
(temperature, top_p, penalties, seed, n, stop, logprobs), output caps
(max_tokens, max_completion_tokens, max_output_tokens) and the rest listed in
DROP_KEYS. Reasoning is NOT carried across turns — a Chat Completions client
never sends it back (neither does the public Chat Completions API), and
inventing continuity OCR does not have would change the arm.

Credentials: the ACCESS token and account id from the sandbox's own
refresh-disabled copy of the pi login (src/bench/auth.ts writes it; this
refuses any auth file whose refresh token is not the disabled sentinel, so it
can never be pointed at the companion's real one). The refresh token is never
read into a request. OCR itself gets only a dummy bearer for this loopback.
Headers mirror pi 0.87.1's Codex SSE transport (Authorization,
chatgpt-account-id, originator: pi, OpenAI-Beta: responses=experimental,
accept: text/event-stream) with this bridge's own User-Agent.

Stdlib only. Every upstream refusal is logged (status + error excerpt + the
request's key set, never its content) to the --log file.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import json
import os
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Iterable, List, Optional, Tuple

UPSTREAM = "https://chatgpt.com/backend-api/codex/responses"
DISABLED_REFRESH = "bench-refresh-disabled"  # = src/bench/auth.ts DISABLED_REFRESH
JWT_CLAIM = "https://api.openai.com/auth"

# Chat-completions keys with no Responses equivalent on the Codex backend, or
# sampling knobs a reasoning model refuses. Dropped and logged, never guessed.
DROP_KEYS = {
    "temperature", "top_p", "n", "stop", "presence_penalty", "frequency_penalty",
    "logit_bias", "logprobs", "top_logprobs", "seed", "user", "max_tokens",
    "max_completion_tokens", "max_output_tokens", "stream", "stream_options",
    "store", "metadata", "service_tier", "reasoning_effort", "modalities",
    "audio", "prediction", "web_search_options", "truncation", "safety_identifier",
    "prompt_cache_retention", "background", "top_k", "extra_body",
}


class BridgeError(Exception):
    def __init__(self, status: int, message: str, code: str = "bridge_error", retry_after: Optional[str] = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retry_after = retry_after


# ---- credentials ---------------------------------------------------------------

def _jwt_account(token: str) -> Optional[str]:
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims.get(JWT_CLAIM, {}).get("chatgpt_account_id")
    except Exception:  # noqa: BLE001 - an opaque token simply has no claim
        return None


def load_credentials(path: str) -> Tuple[str, str]:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    cred = data.get("openai-codex")
    if not isinstance(cred, dict) or cred.get("type") != "oauth" or not cred.get("access"):
        raise SystemExit(f"{path}: no openai-codex OAuth login")
    if cred.get("refresh") != DISABLED_REFRESH:
        raise SystemExit(
            f"{path}: refresh token is not the disabled sentinel — this bridge only reads the "
            "sandbox's refresh-disabled copy (src/bench/auth.ts), never a real login"
        )
    account = cred.get("accountId") or _jwt_account(cred["access"])
    if not account:
        raise SystemExit(f"{path}: no ChatGPT account id (accountId / JWT claim)")
    return cred["access"], account


# ---- translation ----------------------------------------------------------------

def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        out = []
        for part in content:
            if isinstance(part, dict):
                if isinstance(part.get("text"), str):
                    out.append(part["text"])
                elif isinstance(part.get("content"), (str, list)):
                    out.append(_text(part["content"]))
            elif isinstance(part, str):
                out.append(part)
        return "".join(out)
    return str(content)


def chat_to_responses(req: Dict[str, Any], model: str, effort: str, verbosity: str) -> Tuple[Dict[str, Any], List[str]]:
    """A chat-completions request → a Codex Responses body. Returns the body
    and the request keys that were dropped."""
    instructions: List[str] = []
    items: List[Dict[str, Any]] = []
    leading = True
    for msg in req.get("messages") or []:
        role = msg.get("role")
        text = _text(msg.get("content"))
        if role in ("system", "developer") and leading:
            if text:
                instructions.append(text)
            continue
        leading = False
        if role in ("system", "developer"):
            # A system message after the conversation started: the Responses
            # API's mapping for it is a developer message, in place.
            if text:
                items.append({"role": "developer", "content": [{"type": "input_text", "text": text}]})
        elif role == "assistant":
            if text:
                items.append({"role": "assistant", "content": [{"type": "output_text", "text": text}]})
            for call in msg.get("tool_calls") or []:
                fn = call.get("function") or {}
                items.append({
                    "type": "function_call",
                    "call_id": call.get("id") or "",
                    "name": fn.get("name") or "",
                    "arguments": fn.get("arguments") or "{}",
                })
        elif role == "tool":
            items.append({"type": "function_call_output", "call_id": msg.get("tool_call_id") or "", "output": text})
        else:  # user, and anything unknown the way the chat API treats it
            items.append({"role": "user", "content": [{"type": "input_text", "text": text}]})
    body: Dict[str, Any] = {
        "model": model,
        "instructions": "\n\n".join(instructions) or "You are a helpful assistant.",
        "input": items,
        "store": False,
        "stream": True,
        "reasoning": {"effort": effort},
        "text": {"verbosity": verbosity},
        "tool_choice": "auto",
        "parallel_tool_calls": True,
    }
    tools = []
    for tool in req.get("tools") or []:
        if tool.get("type") != "function":
            continue
        fn = tool.get("function") or {}
        # strict:false unless the client asked for strict — the Chat
        # Completions default. (The Responses API defaults to strict, which
        # would reject every schema not written for it.)
        entry = {"type": "function", "name": fn.get("name"), "parameters": fn.get("parameters") or {"type": "object", "properties": {}},
                 "strict": bool(fn.get("strict", False))}
        if fn.get("description"):
            entry["description"] = fn["description"]
        tools.append(entry)
    if tools:
        body["tools"] = tools
    choice = req.get("tool_choice")
    if isinstance(choice, str) and choice in ("auto", "none", "required"):
        body["tool_choice"] = choice
    elif isinstance(choice, dict) and (choice.get("function") or {}).get("name"):
        body["tool_choice"] = {"type": "function", "name": choice["function"]["name"]}
    if isinstance(req.get("parallel_tool_calls"), bool):
        body["parallel_tool_calls"] = req["parallel_tool_calls"]
    fmt = req.get("response_format")
    if isinstance(fmt, dict) and fmt.get("type") == "json_schema" and isinstance(fmt.get("json_schema"), dict):
        js = fmt["json_schema"]
        body["text"]["format"] = {"type": "json_schema", "name": js.get("name", "response"), "schema": js.get("schema", {}), "strict": bool(js.get("strict", False))}
    elif isinstance(fmt, dict) and fmt.get("type") == "json_object":
        body["text"]["format"] = {"type": "json_object"}
    body["prompt_cache_key"] = cache_key(body)
    known = {"model", "messages", "tools", "tool_choice", "parallel_tool_calls", "response_format"}
    dropped = sorted(k for k in req if k not in known)
    return body, dropped


def cache_key(body: Dict[str, Any]) -> str:
    """One key per agent conversation: its instructions and its opening input
    item never change while the tool loop appends to it."""
    first = (body.get("input") or [None])[0]
    seed = json.dumps([body.get("model"), body.get("instructions"), first], sort_keys=True, ensure_ascii=False)
    return "ocr-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:32]


def responses_passthrough(req: Dict[str, Any], model: str, effort: str, verbosity: str) -> Tuple[Dict[str, Any], List[str]]:
    """A (non-streaming) Responses request → the Codex body: forced model /
    effort / stream / store; unsupported keys dropped; system and developer
    input messages folded into `instructions` when none were given."""
    body = {k: v for k, v in req.items() if k not in DROP_KEYS}
    dropped = sorted(k for k in req if k in DROP_KEYS)
    body["model"] = model
    body["store"] = False
    body["stream"] = True
    reasoning = dict(body.get("reasoning") or {})
    reasoning["effort"] = effort
    body["reasoning"] = reasoning
    text = dict(body.get("text") or {})
    text.setdefault("verbosity", verbosity)
    body["text"] = text
    items = body.get("input")
    if isinstance(items, str):
        items = [{"role": "user", "content": [{"type": "input_text", "text": items}]}]
    items = list(items or [])
    if not body.get("instructions"):
        sys_text = [_text(i.get("content")) for i in items if isinstance(i, dict) and i.get("role") in ("system", "developer")]
        items = [i for i in items if not (isinstance(i, dict) and i.get("role") in ("system", "developer"))]
        body["instructions"] = "\n\n".join(t for t in sys_text if t) or "You are a helpful assistant."
    body["input"] = items
    # Items that reference server-side state cannot resolve with store:false.
    if "previous_response_id" in body:
        dropped.append("previous_response_id")
        del body["previous_response_id"]
    for tool in body.get("tools") or []:
        if isinstance(tool, dict) and tool.get("type") == "function":
            tool.setdefault("strict", False)
    body.setdefault("prompt_cache_key", cache_key(body))
    return body, sorted(set(dropped))


def _lines(chunks: Iterable[bytes]) -> Iterable[str]:
    """Lines from an HTTP body iterated by line (each ends in one newline) or
    in arbitrary chunks; a blank line survives either way."""
    for raw in chunks:
        text = raw.decode("utf-8", errors="replace")
        if text.endswith("\r\n"):
            text = text[:-2]
        elif text.endswith("\n"):
            text = text[:-1]
        for line in text.split("\n"):
            yield line.rstrip("\r")


def iter_sse(chunks: Iterable[bytes]) -> Iterable[Dict[str, Any]]:
    data: List[str] = []
    for line in _lines(chunks):
        if not line:
            if data:
                payload = "\n".join(data).strip()
                data = []
                if payload and payload != "[DONE]":
                    try:
                        yield json.loads(payload)
                    except json.JSONDecodeError:
                        continue
            continue
        if line.startswith("data:"):
            data.append(line[5:].lstrip())
    if data:
        payload = "\n".join(data).strip()
        if payload and payload != "[DONE]":
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                pass


def aggregate(events: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    """Fold a Responses SSE stream into the final Response object. The Codex
    backend (store:false) may complete with an empty `output`; the items are
    then taken from the `response.output_item.done` events, in output order."""
    done: Dict[int, Dict[str, Any]] = {}
    seq = 0
    for event in events:
        kind = event.get("type")
        if kind == "response.output_item.done" and isinstance(event.get("item"), dict):
            idx = event.get("output_index")
            if not isinstance(idx, int):
                idx = 10_000 + seq
            seq += 1
            done[idx] = event["item"]
        elif kind in ("response.completed", "response.done", "response.incomplete"):
            response = dict(event.get("response") or {})
            if not response.get("output"):
                response["output"] = [done[k] for k in sorted(done)]
            if kind == "response.incomplete" and not response.get("status"):
                response["status"] = "incomplete"
            return response
        elif kind == "response.failed":
            err = (event.get("response") or {}).get("error") or {}
            code = str(err.get("code") or "response_failed")
            status = 429 if "rate" in code or "quota" in code else 502
            raise BridgeError(status, str(err.get("message") or "response failed"), code)
        elif kind == "error":
            err = event.get("error") if isinstance(event.get("error"), dict) else event
            code = str(err.get("code") or err.get("type") or "stream_error")
            status = 429 if "rate" in code or "quota" in code else 502
            raise BridgeError(status, str(err.get("message") or json.dumps(err)[:500]), code)
    raise BridgeError(502, "upstream stream ended before response.completed", "incomplete_stream")


def response_to_chat(resp: Dict[str, Any], model: str) -> Dict[str, Any]:
    text: List[str] = []
    calls: List[Dict[str, Any]] = []
    for item in resp.get("output") or []:
        kind = item.get("type")
        if kind == "message":
            for part in item.get("content") or []:
                if part.get("type") in ("output_text", "refusal"):
                    text.append(part.get("text") or part.get("refusal") or "")
        elif kind == "function_call":
            calls.append({
                "id": item.get("call_id") or item.get("id") or "",
                "type": "function",
                "function": {"name": item.get("name") or "", "arguments": item.get("arguments") or "{}"},
            })
    usage = resp.get("usage") or {}
    inp = int(usage.get("input_tokens") or 0)
    out = int(usage.get("output_tokens") or 0)
    cached = int((usage.get("input_tokens_details") or {}).get("cached_tokens") or 0)
    reasoning = int((usage.get("output_tokens_details") or {}).get("reasoning_tokens") or 0)
    incomplete = (resp.get("incomplete_details") or {}).get("reason")
    finish = "tool_calls" if calls else ("length" if incomplete == "max_output_tokens" else "stop")
    message: Dict[str, Any] = {"role": "assistant", "content": "".join(text) if text else None}
    if calls:
        message["tool_calls"] = calls
    return {
        "id": "chatcmpl-" + str(resp.get("id") or int(time.time() * 1000)),
        "object": "chat.completion",
        "created": int(resp.get("created_at") or time.time()),
        "model": resp.get("model") or model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": {
            "prompt_tokens": inp,
            "completion_tokens": out,
            "total_tokens": int(usage.get("total_tokens") or inp + out),
            "prompt_tokens_details": {"cached_tokens": cached},
            "completion_tokens_details": {"reasoning_tokens": reasoning},
        },
    }


# ---- the server -----------------------------------------------------------------

class Bridge:
    def __init__(self, a: argparse.Namespace):
        self.a = a
        self.lock = threading.Lock()
        self.gate = threading.Semaphore(a.max_inflight)
        self.stats: Dict[str, Any] = {
            "requests": 0, "ok": 0, "errors": 0, "upstream_refusals": 0,
            "input_tokens": 0, "cached_tokens": 0, "output_tokens": 0, "reasoning_tokens": 0,
            "by_status": {}, "dropped_keys": {},
            "model": a.model, "effort": a.effort, "verbosity": a.verbosity,
        }
        self.log_handle = open(a.log, "a", encoding="utf-8") if a.log else None
        self.label = ""

    def log(self, row: Dict[str, Any]) -> None:
        row = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "label": self.label, **row}
        line = json.dumps(row, ensure_ascii=False)
        with self.lock:
            if self.log_handle:
                self.log_handle.write(line + "\n")
                self.log_handle.flush()
        if row.get("error"):
            print(f"bridge: {line[:600]}", file=sys.stderr, flush=True)

    def call(self, body: Dict[str, Any]) -> Dict[str, Any]:
        token, account = load_credentials(self.a.auth)
        data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(self.a.upstream, data=data, method="POST", headers={
            "Authorization": f"Bearer {token}",
            "chatgpt-account-id": account,
            "originator": "pi",
            "OpenAI-Beta": "responses=experimental",
            "accept": "text/event-stream",
            "content-type": "application/json",
            "User-Agent": "qcr-bench-ocr-bridge/2 (open-code-review baseline; pi-login access token)",
        })
        with self.gate:
            try:
                resp = urllib.request.urlopen(req, timeout=self.a.read_timeout)
            except urllib.error.HTTPError as e:
                detail = e.read(4000).decode("utf-8", errors="replace")
                raise BridgeError(e.code, f"upstream HTTP {e.code}: {detail}", "upstream_http", e.headers.get("retry-after")) from None
            except (urllib.error.URLError, socket.timeout, ConnectionError, http.client.HTTPException) as e:
                raise BridgeError(502, f"upstream unreachable: {e}", "upstream_unreachable") from None
            try:
                return aggregate(iter_sse(resp))
            except (socket.timeout, ConnectionError, http.client.HTTPException) as e:
                raise BridgeError(502, f"upstream stream broke: {e}", "stream_broken") from None
            finally:
                resp.close()

    def count(self, status: int, dropped: List[str], resp: Optional[Dict[str, Any]], refused: bool) -> None:
        with self.lock:
            s = self.stats
            s["requests"] += 1
            s["by_status"][str(status)] = s["by_status"].get(str(status), 0) + 1
            for k in dropped:
                s["dropped_keys"][k] = s["dropped_keys"].get(k, 0) + 1
            if resp is None:
                s["errors"] += 1
                if refused:
                    s["upstream_refusals"] += 1
                return
            s["ok"] += 1
            u = resp.get("usage") or {}
            s["input_tokens"] += int(u.get("input_tokens") or 0)
            s["output_tokens"] += int(u.get("output_tokens") or 0)
            s["cached_tokens"] += int((u.get("input_tokens_details") or {}).get("cached_tokens") or 0)
            s["reasoning_tokens"] += int((u.get("output_tokens_details") or {}).get("reasoning_tokens") or 0)


def make_handler(bridge: Bridge):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # noqa: D401 - the JSON log is the access log
            pass

        def _send(self, code: int, obj: Dict[str, Any], retry_after: Optional[str] = None) -> None:
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            if retry_after:
                self.send_header("retry-after", retry_after)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send(200, {"ok": True, "model": bridge.a.model, "effort": bridge.a.effort})
            elif self.path == "/stats":
                with bridge.lock:
                    self._send(200, json.loads(json.dumps(bridge.stats)))
            else:
                self._send(404, {"error": {"message": "not found"}})

        def do_POST(self):
            path = self.path.split("?", 1)[0].rstrip("/")
            started = time.monotonic()
            try:
                raw = self.rfile.read(int(self.headers.get("content-length", "0") or 0))
                req = json.loads(raw or b"{}")
            except (ValueError, json.JSONDecodeError):
                self._send(400, {"error": {"message": "bad JSON", "type": "invalid_request_error"}})
                return
            if path == "/label":
                with bridge.lock:
                    bridge.label = str(req.get("label") or "")[:200]
                self._send(200, {"ok": True, "label": bridge.label})
                return
            if path.endswith("/chat/completions"):
                kind = "chat"
                body, dropped = chat_to_responses(req, bridge.a.model, bridge.a.effort, bridge.a.verbosity)
            elif path.endswith("/responses"):
                kind = "responses"
                body, dropped = responses_passthrough(req, bridge.a.model, bridge.a.effort, bridge.a.verbosity)
            else:
                self._send(404, {"error": {"message": f"no route {path}"}})
                return
            row: Dict[str, Any] = {
                "route": kind, "asked_model": req.get("model"), "model": body["model"],
                "effort": bridge.a.effort, "items": len(body.get("input") or []),
                "tools": len(body.get("tools") or []), "dropped": dropped,
            }
            try:
                resp = bridge.call(body)
            except BridgeError as e:
                refused = e.code == "upstream_http" and 400 <= e.status < 500
                bridge.count(e.status, dropped, None, refused)
                row.update(status=e.status, ms=int((time.monotonic() - started) * 1000), error=str(e)[:2000], code=e.code)
                if refused:
                    row["request_keys"] = sorted(body.keys())
                    row["item_types"] = sorted({str(i.get("type") or i.get("role")) for i in body.get("input") or [] if isinstance(i, dict)})
                bridge.log(row)
                etype = "rate_limit_error" if e.status == 429 else "api_error"
                self._send(e.status, {"error": {"message": str(e)[:2000], "type": etype, "code": e.code}}, e.retry_after)
                return
            bridge.count(200, dropped, resp, False)
            usage = resp.get("usage") or {}
            usage_keys = ("input_tokens", "input_tokens_details", "output_tokens", "output_tokens_details", "total_tokens")
            row.update(status=200, ms=int((time.monotonic() - started) * 1000), response_status=resp.get("status"),
                       served_model=resp.get("model"), out_items=[i.get("type") for i in resp.get("output") or []],
                       usage={k: usage[k] for k in usage_keys if k in usage})
            bridge.log(row)
            self._send(200, response_to_chat(resp, body["model"]) if kind == "chat" else {**resp, "object": "response"})

    return Handler


# ---- self-test (run at image build: no network, no credentials) ------------------

def _self_test() -> None:
    import tempfile

    chat = {
        "model": "whatever", "max_completion_tokens": 58888, "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "SYS"},
            {"role": "user", "content": "review this"},
            {"role": "assistant", "content": "", "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "file_read", "arguments": "{\"path\":\"a.go\"}"}}]},
            {"role": "tool", "tool_call_id": "call_1", "content": "package a"},
        ],
        "tools": [{"type": "function", "function": {"name": "file_read", "description": "read", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}}}],
    }
    body, dropped = chat_to_responses(chat, "gpt-6-sol", "medium", "medium")
    assert body["model"] == "gpt-6-sol" and body["stream"] is True and body["store"] is False, body
    assert body["instructions"] == "SYS" and body["reasoning"] == {"effort": "medium"}, body
    assert [i.get("type") or i.get("role") for i in body["input"]] == ["user", "function_call", "function_call_output"], body["input"]
    assert body["input"][1]["call_id"] == "call_1" and body["input"][2]["output"] == "package a"
    assert body["tools"] == [{"type": "function", "name": "file_read", "parameters": {"type": "object", "properties": {"path": {"type": "string"}}}, "strict": False, "description": "read"}], body["tools"]
    assert dropped == ["max_completion_tokens", "temperature"], dropped
    # One cache key per conversation: the tool loop's growth does not change it,
    # a different conversation gets another.
    longer = dict(chat, messages=chat["messages"] + [{"role": "assistant", "content": "done"}])
    assert chat_to_responses(longer, "gpt-6-sol", "medium", "medium")[0]["prompt_cache_key"] == body["prompt_cache_key"]
    other = dict(chat, messages=[{"role": "system", "content": "SYS"}, {"role": "user", "content": "other file"}])
    assert chat_to_responses(other, "gpt-6-sol", "medium", "medium")[0]["prompt_cache_key"] != body["prompt_cache_key"]
    # Only LEADING system messages are instructions; a later one stays in place.
    mid = {"messages": [{"role": "system", "content": "A"}, {"role": "system", "content": "B"}, {"role": "user", "content": "u"}, {"role": "system", "content": "C"}]}
    mbody, _ = chat_to_responses(mid, "m", "medium", "medium")
    assert mbody["instructions"] == "A\n\nB" and mbody["input"][-1] == {"role": "developer", "content": [{"type": "input_text", "text": "C"}]}, mbody

    sse = [
        b'event: response.created\n', b'data: {"type":"response.created","response":{"id":"r1"}}\n', b'\n',
        b'data: {"type":"response.output_item.done","output_index":1,"item":{"type":"function_call","call_id":"call_9","name":"task_done","arguments":"{}"}}\n', b'\n',
        b'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","summary":[]}}\n', b'\n',
        b'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":100,"input_tokens_details":{"cached_tokens":40},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":5},"total_tokens":107}}}\n', b'\n',
    ]
    resp = aggregate(iter_sse(sse))
    assert [i["type"] for i in resp["output"]] == ["reasoning", "function_call"], resp
    out = response_to_chat(resp, "gpt-6-sol")
    msg = out["choices"][0]["message"]
    assert out["choices"][0]["finish_reason"] == "tool_calls" and msg["content"] is None
    assert msg["tool_calls"] == [{"id": "call_9", "type": "function", "function": {"name": "task_done", "arguments": "{}"}}]
    assert out["usage"]["prompt_tokens"] == 100 and out["usage"]["completion_tokens"] == 7 and out["usage"]["prompt_tokens_details"]["cached_tokens"] == 40

    text = aggregate(iter_sse([b'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","content":[{"type":"output_text","text":"[]"}]}}\n\n',
                               b'data: {"type":"response.completed","response":{"status":"completed","usage":{}}}\n\n']))
    assert response_to_chat(text, "m")["choices"][0]["message"]["content"] == "[]"

    for failing, status in ((b'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_exceeded","message":"slow down"}}}\n\n', 429),
                            (b'data: {"type":"response.failed","response":{"error":{"code":"server_error","message":"x"}}}\n\n', 502),
                            (b'data: {"type":"response.output_text.delta","delta":"x"}\n\n', 502)):
        try:
            aggregate(iter_sse([failing]))
        except BridgeError as e:
            assert e.status == status, (failing, e.status)
        else:
            raise AssertionError(f"no error for {failing!r}")

    rbody, rdropped = responses_passthrough({"model": "x", "input": [{"role": "system", "content": "S"}, {"role": "user", "content": "u"}], "max_output_tokens": 5, "temperature": 0}, "gpt-6-sol", "medium", "medium")
    assert rbody["instructions"] == "S" and len(rbody["input"]) == 1 and rbody["stream"] is True and rdropped == ["max_output_tokens", "temperature"], (rbody, rdropped)
    assert rbody["prompt_cache_key"].startswith("ocr-") and rbody["model"] == "gpt-6-sol"

    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "auth.json")
        with open(p, "w") as f:
            json.dump({"openai-codex": {"type": "oauth", "access": "a.b.c", "refresh": "REAL", "accountId": "acc"}}, f)
        try:
            load_credentials(p)
        except SystemExit:
            pass
        else:
            raise AssertionError("a real refresh token must be refused")
        with open(p, "w") as f:
            json.dump({"openai-codex": {"type": "oauth", "access": "a.b.c", "refresh": DISABLED_REFRESH, "accountId": "acc"}}, f)
        assert load_credentials(p) == ("a.b.c", "acc")
    print("codex_bridge self-test: ok")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--model", default="gpt-6-sol")
    ap.add_argument("--effort", default="medium")
    ap.add_argument("--verbosity", default="medium", help="text.verbosity; the public API default is medium")
    ap.add_argument("--auth", default=os.path.join(os.environ.get("PI_CODING_AGENT_DIR", "/tmp/pi-agent"), "auth.json"))
    ap.add_argument("--upstream", default=UPSTREAM)
    ap.add_argument("--log", default="")
    ap.add_argument("--max-inflight", type=int, default=16)
    ap.add_argument("--read-timeout", type=int, default=600)
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        _self_test()
        return
    load_credentials(a.auth)  # refuse to start on a wrong/real auth file
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(Bridge(a)))
    srv.daemon_threads = True
    print(f"codex bridge on 127.0.0.1:{a.port} → {a.upstream} ({a.model}, effort {a.effort}, verbosity {a.verbosity})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
