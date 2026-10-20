#!/usr/bin/env node
// The rehearsal's one outside world (P8.20a): a scripted OpenAI-compatible model and a
// scripted GitHub REST API, in one process on the rehearsal's internal network, and a
// log of every request either one served. Nothing else is reachable from the containers
// (the network is `--internal`), so this log IS the network capture: a request to any
// other host never gets here, and fails in the container where the checks see it.
//
//   node stub.mjs <fixture.json> <tls-dir> <log.jsonl>
//
//   :443   (QCR_STUB_HTTPS_PORT) HTTPS as api.github.com (the daemon's, mint-token.sh's and git's GitHub; the CA is
//          handed to the containers as a file, so no code path is changed for the rehearsal)
//   :8080  (QCR_STUB_HTTP_PORT) HTTP, the model: POST /v1/chat/completions (what pi's `local` provider speaks),
//          and the admin routes: GET /admin/requests, POST /admin/mode, POST /admin/reset
//
// The model plays a PLAYBOOK, chosen by the admin `mode` and read off each request: it keeps
// no per-request script, so a worker that is killed and replaced, or a lens leaf that asks
// out of order, still gets the answer its turn needs.
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [fixturePath, tlsDir, logPath] = process.argv.slice(2);
if (!fixturePath || !tlsDir || !logPath) {
  console.error("usage: stub.mjs <fixture.json> <tls-dir> <log.jsonl>");
  process.exit(2);
}
// The ports are the rehearsal network's (443 as api.github.com, 8080 as the model); a test moves them.
const HTTPS_PORT = Number(process.env["QCR_STUB_HTTPS_PORT"] ?? 443);
const HTTP_PORT = Number(process.env["QCR_STUB_HTTP_PORT"] ?? 8080);
const HOST = process.env["QCR_STUB_HOST"] ?? "0.0.0.0";
const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const log = (rec) => appendFileSync(logPath, JSON.stringify({ t: Date.now(), ...rec }) + "\n");

// ---------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------

// What the admin route can change: whether the PR carries the trigger label, and its head.
const gh = { triggered: false, head: fx.head_sha };

const pr = () => ({
  number: fx.pr,
  title: fx.title,
  body: "Adds rate limiting to the API.\n\nBounds the retry loop.",
  state: "open",
  draft: false,
  merged: false,
  comments: 0,
  user: { login: fx.author },
  head: { sha: gh.head, ref: "feat/rate-limit", repo: { full_name: fx.repo } },
  base: { sha: fx.base_sha, ref: "master", repo: { full_name: fx.repo } },
  labels: gh.triggered ? [{ name: fx.trigger_label }] : [],
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-20T00:00:00Z",
  html_url: `https://github.com/${fx.repo}/pull/${fx.pr}`,
  mergeable: true,
  requested_reviewers: [],
  requested_teams: [],
});
const issueItem = () => ({ ...pr(), pull_request: { url: "x" }, labels: pr().labels });

const mutations = [];
function github(req, res, body) {
  const url = new URL(req.url, "https://api.github.com");
  const p = url.pathname;
  const json = (x, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(x));
  };
  const repo = `/repos/${fx.repo}`;
  const m = req.method;
  log({ kind: "github", method: m, path: req.url, from: req.socket.remoteAddress });
  if (m === "GET" && p === "/app/installations") return json([{ id: 1 }]);
  if (m === "POST" && p === "/app/installations/1/access_tokens")
    return json(
      { token: "ghs_rehearsal", expires_at: new Date(Date.now() + 3600e3).toISOString() },
      201,
    );
  if (m === "GET" && p === "/app") return json({ slug: fx.app_slug, id: 1 });
  if (m === "GET" && p === "/app/hook/config")
    return json({
      url: "https://review.example.test/webhook",
      content_type: "json",
      insecure_ssl: "0",
    });
  if (m === "GET" && p === "/app/hook/deliveries") return json([]);
  if (m === "GET" && p === "/search/issues") {
    const q = url.searchParams.get("q") ?? "";
    const label = gh.triggered && q.includes("label:") && !q.includes("team-review-requested");
    return json({
      total_count: label ? 1 : 0,
      incomplete_results: false,
      items: label ? [issueItem()] : [],
    });
  }
  if (m === "GET" && p === repo)
    return json({ full_name: fx.repo, default_branch: "master", private: true });
  if (m === "GET" && p === `${repo}/pulls`)
    return json(url.searchParams.get("page") > 1 ? [] : [pr()]);
  if (m === "GET" && p === `${repo}/pulls/${fx.pr}`) return json(pr());
  if (m === "GET" && p === `${repo}/pulls/${fx.pr}/files`)
    return json(url.searchParams.get("page") > 1 ? [] : fx.files);
  if (m === "GET" && p === `${repo}/pulls/${fx.pr}/requested_reviewers`)
    return json({ users: [], teams: [] });
  if (m === "GET" && /\/(reviews|comments)$/.test(p)) return json([]);
  if (m === "GET" && /\/check-runs$/.test(p))
    return json({
      total_count: 1,
      check_runs: [
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          started_at: "2026-10-20T00:00:00Z",
          completed_at: "2026-10-20T00:01:00Z",
          app: { slug: "ci" },
        },
      ],
    });
  if (m === "GET" && /\/status$/.test(p))
    return json({ state: "success", total_count: 0, statuses: [] });
  if (m === "GET" && p.startsWith(`${repo}/compare/`))
    return json({
      status: "ahead",
      files: fx.files,
      commits: [],
      merge_base_commit: { sha: fx.base_sha },
    });
  if (m === "GET" && p.startsWith(`${repo}/issues`)) return json([]);
  if (m === "POST" && p === "/graphql")
    return json({
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false } } },
        },
      },
    });
  if (m !== "GET") {
    // A mutation reaching GitHub is a failure of the rehearsal: dry_run must have caught it.
    mutations.push({ method: m, path: req.url });
    log({ kind: "github-mutation", method: m, path: req.url });
    return json({ message: "the rehearsal refuses every mutation" }, 403);
  }
  log({ kind: "github-unmodelled", method: m, path: req.url });
  return json({ message: "Not Found (unmodelled by the rehearsal stub)" }, 404);
}

// ---------------------------------------------------------------------------------------
// The login's OAuth refresh (auth.openai.com), as pi-ai's openai-codex refresh speaks it
// ---------------------------------------------------------------------------------------

let refreshes = 0;
/** POST /oauth/token with grant_type=refresh_token: a new access token (a JWT carrying the
 * account id pi-ai reads out of it) and a ROTATED refresh token. Anything else is a 404. */
function oauth(req, res, raw) {
  const url = new URL(req.url, "https://auth.openai.com");
  log({ kind: "oauth", method: req.method, path: url.pathname, from: req.socket.remoteAddress });
  const form = new URLSearchParams(raw);
  if (
    req.method !== "POST" ||
    url.pathname !== "/oauth/token" ||
    form.get("grant_type") !== "refresh_token"
  ) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unmodelled by the rehearsal stub" }));
    return;
  }
  refreshes++;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/=+$/, "");
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "rehearsal-account" } };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      access_token: `${b64({ alg: "none" })}.${b64(claims)}.rehearsal`,
      refresh_token: `rehearsal-refresh-token-${refreshes}`,
      expires_in: 10 * 24 * 3600,
    }),
  );
}

// ---------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------

const state = { mode: "round", requests: 0, hold: {}, bySession: new Map() };
const requests = [];

const sse = (d) => `data: ${JSON.stringify(d)}\n\n`;
function stream(reply, n) {
  const base = {
    id: `chatcmpl-rehearsal-${n}`,
    object: "chat.completion.chunk",
    model: "m",
    created: 1,
  };
  const out = [
    sse({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
  ];
  if (reply.text)
    out.push(
      sse({
        ...base,
        choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }],
      }),
    );
  (reply.tools ?? []).forEach((c, i) =>
    out.push(
      sse({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: c.id,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ),
  );
  out.push(
    sse({
      ...base,
      choices: [
        { index: 0, delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" },
      ],
    }),
  );
  out.push(
    sse({
      ...base,
      choices: [],
      usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 },
    }),
  );
  out.push("data: [DONE]\n\n");
  return out.join("");
}

const textOf = (c) =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((p) => (typeof p === "string" ? p : (p.text ?? ""))).join("")
      : "";

/** A round's order (the main session's first message), as against a lens leaf's task. */
const ROUND_ORDER_RE = /Review round|qcr-round|Round order/;

/** The conversation's shape, read off one request: its latest user turn, the tool results
 * after it, the tool names it was offered. */
function shape(body) {
  const msgs = body.messages ?? [];
  let lastUser = -1;
  for (let i = msgs.length - 1; i >= 0; i--)
    if (msgs[i].role === "user") {
      lastUser = i;
      break;
    }
  // A worker that took a round over (src/botworker.ts continuationText) adds a user turn that
  // points back at the round order: the playbook reads that order, and counts its steps from it.
  if (lastUser > 0 && /stopped before the round finished/.test(textOf(msgs[lastUser].content))) {
    for (let i = lastUser - 1; i >= 0; i--)
      if (msgs[i].role === "user" && ROUND_ORDER_RE.test(textOf(msgs[i].content))) {
        lastUser = i;
        break;
      }
  }
  const user = lastUser >= 0 ? textOf(msgs[lastUser].content) : "";
  const tail = msgs.slice(lastUser + 1);
  const results = tail.filter((m) => m.role === "tool").map((m) => textOf(m.content));
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const system = msgs
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  return { user, results, tools, system, nTail: tail.filter((m) => m.role === "assistant").length };
}

const bash = (id, command) => ({ tools: [{ id, name: "bash", args: { command } }] });

const AGENT_RE = /\b(pass-[a-z0-9-]+?)--((?:sol|terra|luna)-(?:high|med|low))\b/g;

/** The round's planned lenses, as the agents to call: the order's "Pass plan for this round"
 * table, one row per lens (its "lens to call" column), and nothing else the order names (a
 * later round's order also lists the raise-to tiers and the sweep's own plan). An order with
 * no such table (a test's) gives every agent it names. */
function plannedAgents(user) {
  const at = user.indexOf("**Pass plan for this round**");
  if (at >= 0) {
    const rows = [];
    for (const line of user.slice(at).split("\n").slice(1)) {
      if (rows.length > 0 && !line.startsWith("|")) break;
      const m = /^\|\s*pass-[a-z0-9-]+\s*\|\s*`([^`]+)`/.exec(line);
      if (m && new RegExp(AGENT_RE.source).test(m[1])) rows.push(m[1]);
    }
    if (rows.length > 0) return rows;
  }
  return [...new Set([...user.matchAll(AGENT_RE)].map((m) => `${m[1]}--${m[2]}`))];
}

/** The round the main session plays: join the wave, run the validator, write the verdict and the
 * review body, commit the verdict, post through the shim, say done. The pr, round, head and the
 * planned passes come off the round order (the plan table names every agent as `pass-x--tier`). */
function playRound(s) {
  const pr = /PR #?(\d+)/.exec(s.user)?.[1] ?? String(fx.pr);
  const round =
    /<!-- qcr-round: pr-\d+ round-(\d+) -->/.exec(s.user)?.[1] ??
    /QCR_ROUND_NO=(\d+)/.exec(s.user)?.[1] ??
    "1";
  const head = /QCR_EXPECTED_HEAD=([0-9a-f]{7,40})/.exec(s.user)?.[1] ?? gh.head;
  const agents = plannedAgents(s.user);
  const validator = agents.find((a) => a.startsWith("pass-validate"));
  const passes = agents.map((a) => {
    const [name, tier] = a.split("--");
    return {
      name,
      tier,
      findings: 0,
      ...(name === "pass-validate"
        ? { survived: 0, killed: 0, downgraded: 0, merged: 0, folded: 0 }
        : {}),
    };
  });
  const verdict = JSON.stringify({
    pr: Number(pr),
    round_no: Number(round),
    verdict: "REQUEST_CHANGES",
    head_sha: gh.head,
    summary: "The retry loop is unbounded.",
    passes,
    finished_at: new Date().toISOString(),
  });
  const canWrite = s.tools.includes("write");
  const reviewFile = `state/pr-${pr}-round-${round}-review.md`;
  const verdictFile = `verdict/pr-${pr}-round-${round}.json.tmp`;
  const findingsFile = `state/findings/pr-${pr}-round-${round}.json`;
  const findings = JSON.stringify({ pr: Number(pr), round_no: Number(round), findings: [] });
  const steps = [
    // Join the wave the engine launched at round start (rule 9): the permit broker's use.
    () => ({ tools: [{ id: "c0", name: "lens_wave", args: {} }] }),
    // A burst of parallel passes (admin `burst` = how many, `burstMs` = how long each answer takes):
    // more than the permit ceiling at once, to show the ceiling and the grant stagger on the wire.
    ...(Number(state.hold.burst) > 0
      ? [
          () => ({
            tools: [
              {
                id: "cb",
                name: "lens",
                args: {
                  tasks: Array.from({ length: Number(state.hold.burst) }, (_, i) => ({
                    agent:
                      agents.find((a) => a.startsWith("pass-baseline")) ??
                      "pass-baseline--sol-high",
                    task: `Burst ${i + 1}: reply NONE.`,
                  })),
                },
              },
            ],
          }),
        ]
      : []),
    ...(validator
      ? [
          () => ({
            tools: [
              {
                id: "cv",
                name: "lens",
                args: {
                  agent: validator,
                  task: "Validate the candidate findings of this round. There are none: reply NONE.",
                },
              },
            ],
          }),
        ]
      : []),
    // The model stages the review body and the verdict with its write tool, as the round template
    // tells it to. A pi without one (the debug round's) writes them by bash, the same verdict
    // (bash-guard once threw on its `[{...}]`: findings.md, F2).
    () =>
      canWrite
        ? {
            tools: [
              {
                id: "c1",
                name: "write",
                args: { path: reviewFile, content: "Please bound the retries.\n" },
              },
            ],
          }
        : bash("c1", `printf 'Please bound the retries.\\n' > ${reviewFile}`),
    () =>
      canWrite
        ? { tools: [{ id: "c1b", name: "write", args: { path: verdictFile, content: verdict } }] }
        : bash("c1b", `printf '%s' '${verdict}' > ${verdictFile}`),
    () => bash("c2", `scripts/commit-verdict.sh pr-${pr}-round-${round}.json`),
    () =>
      bash(
        "c3",
        `QCR_EXPECTED_HEAD=${head} QCR_ROUND_NO=${round} scripts/post-review.sh ${pr} REQUEST_CHANGES state/pr-${pr}-round-${round}-review.md`,
      ),
    // The findings record the round templates ask for (src/findingsrecord.ts): none raised.
    () =>
      canWrite
        ? { tools: [{ id: "c4", name: "write", args: { path: findingsFile, content: findings } }] }
        : bash("c4", `printf '%s' '${findings}' > ${findingsFile}`),
  ];
  // The closing words carry the ledger block ledger-pin mirrors (src/ledgercheck.ts reads its header).
  return steps[s.nTail]
    ? steps[s.nTail]()
    : {
        text: `round done\n\nLEDGER PR #${pr} @ ${head}\nR${round}: REQUEST_CHANGES, the retry loop is unbounded.`,
      };
}

function reply(body, ip) {
  const s = shape(body);
  const mode = state.mode;
  const record = {
    kind: "model",
    mode,
    ip,
    tools: s.tools.length,
    toolNames: s.tools.join(","),
    user: s.user.slice(0, 160),
    nTail: s.nTail,
    system: s.system.slice(0, 80),
  };
  state.requests++;
  // A leaf (a lens or the validator) is a session with no lens tool and no post shim: it
  // answers its task at once, with the "nothing found" the lens grammar allows.
  const isLeaf = !ROUND_ORDER_RE.test(s.user);
  let r;
  if (mode === "hold") r = { text: "holding", delayMs: 600_000 };
  else if (mode === "slow")
    r =
      s.nTail === 0 ? { text: "slow", delayMs: Number(state.hold.ms ?? 60_000) } : { text: "done" };
  else if (mode === "fail") r = { error: 500 };
  else if (mode === "answer") r = { text: "Answer from the rehearsal stub." };
  else if (mode === "answer_post")
    r =
      s.nTail === 0
        ? bash(
            "a1",
            // The operator's "answer the author": a reply on the thread (admin `comment` = its id).
            // The command's exit status is the tool result's, which is what the worker counts a post by.
            `printf 'Operator-requested reply.\\n' > state/pr-${fx.pr}-answer-reply.md && scripts/reply-thread.sh ${fx.pr} ${Number(state.hold.comment ?? 9001)} state/pr-${fx.pr}-answer-reply.md`,
          )
        : {
            text: `reply attempt: ${s.results[0] ?? "(no result)"}`
              .replace(/\s+/g, " ")
              .slice(0, 600),
          };
  else if (isLeaf && mode === "round")
    r = {
      text: "NONE",
      delayMs: s.user.startsWith("Task: Burst")
        ? Number(state.hold.burstMs ?? 0)
        : Number(state.hold.leafMs ?? 0),
    };
  else if (mode === "round") r = playRound(s);
  else r = { text: "ok" };
  log({
    ...record,
    reply: r.error ? `error ${r.error}` : r.tools ? `tool ${r.tools[0].name}` : "text",
  });
  return r;
}

function model(req, res, raw) {
  if (req.method === "POST" && req.url === "/admin/mode") {
    Object.assign(state, { mode: JSON.parse(raw).mode ?? state.mode, hold: JSON.parse(raw) });
    log({ kind: "admin", mode: state.mode });
    res.writeHead(200).end("{}");
    return;
  }
  if (req.method === "POST" && req.url === "/admin/github") {
    Object.assign(gh, JSON.parse(raw));
    log({ kind: "admin", github: gh });
    res.writeHead(200).end("{}");
    return;
  }
  if (req.method === "GET" && req.url === "/admin/requests") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: state.requests, mutations }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
    const body = JSON.parse(raw);
    requests.push(body);
    const r = reply(body, req.socket.remoteAddress);
    if (r.error) {
      res.writeHead(r.error, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "the rehearsal stub is told to fail" } }));
      return;
    }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(stream(r, state.requests));
    }, r.delayMs ?? 0);
    return;
  }
  log({ kind: "model-unmodelled", method: req.method, path: req.url });
  res.writeHead(404).end("{}");
}

const collect = (handler) => (req, res) => {
  const parts = [];
  req.on("data", (c) => parts.push(c));
  req.on("end", () => handler(req, res, Buffer.concat(parts).toString("utf8")));
};

httpsServer(
  { key: readFileSync(join(tlsDir, "leaf.key")), cert: readFileSync(join(tlsDir, "leaf.crt")) },
  collect((req, res, raw) =>
    /^auth\.openai\.com(:\d+)?$/.test(req.headers.host ?? "")
      ? oauth(req, res, raw)
      : github(req, res, raw),
  ),
).listen(HTTPS_PORT, HOST, () => log({ kind: "up", port: HTTPS_PORT }));
httpServer(collect(model)).listen(HTTP_PORT, HOST, () => log({ kind: "up", port: HTTP_PORT }));
