// A local stand-in for an OpenAI-compatible chat endpoint, for the tests that put
// the REAL pi (the SDK in this process, and a `pi` CLI child) in front of the
// same provider and compare what each sent. It binds to loopback, plays scripted
// replies in request order and keeps each request's raw body, so "byte-equal"
// is read off the wire and not off an object. No model is involved and nothing
// leaves the machine.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FakeReply {
  text?: string;
  /** Tool calls the reply asks for; the stop reason becomes "tool_calls". */
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  /** Token counts the usage chunk reports. */
  usage?: { prompt: number; completion: number };
  /** Delay before the reply starts, in ms (a turn that is still running). */
  delayMs?: number;
}

export interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeOpenAI {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** Replace the script; requests past its end get a 500. */
  script(replies: FakeReply[]): void;
  close(): Promise<void>;
}

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

function chunks(reply: FakeReply, n: number): string {
  const base = {
    id: `chatcmpl-fake-${n}`,
    object: "chat.completion.chunk",
    model: "m",
    created: 1,
  };
  const out: string[] = [];
  out.push(
    sse({
      ...base,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    }),
  );
  if (reply.text)
    out.push(
      sse({
        ...base,
        choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }],
      }),
    );
  (reply.toolCalls ?? []).forEach((c, i) =>
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
        { index: 0, delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" },
      ],
    }),
  );
  const u = reply.usage ?? { prompt: 100, completion: 10 };
  out.push(
    sse({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: u.prompt,
        completion_tokens: u.completion,
        total_tokens: u.prompt + u.completion,
      },
    }),
  );
  out.push("data: [DONE]\n\n");
  return out.join("");
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const requests: RecordedRequest[] = [];
  let replies: FakeReply[] = [];
  let served = 0;
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      requests.push({
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(parts).toString("utf8"),
      });
      const reply = replies[served++];
      if (!reply) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "the fake endpoint's script is exhausted" } }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.end(chunks(reply, served));
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    script(next) {
      replies = [...next];
      served = 0;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The provider and model id the agent dir's models.json defines. */
export const FAKE_MODEL = "local/m";

/** The second model `writeFakeProvider` defines when asked for one a route can
 * land on: it reasons and has a window a review fits in, which the pick rule
 * (packages/pi-plugin/src/modelpick.ts) requires and `m` does not have. */
export const FAKE_ROUTE_MODEL = "local/r";

/** Write an agent dir holding the one custom provider, pointed at `baseUrl`.
 * `PiHost` and a `pi` child (PI_CODING_AGENT_DIR) both read this file.
 * `routable` adds `FAKE_ROUTE_MODEL` beside `m`, for a test whose sessions
 * name no model: `m` stays as it is, so what a pinned session sends is
 * unchanged, and a host with `m` alone is the "no model passes" case.
 * `apiKey` is the provider's key as models.json spells it (a literal, or a
 * `\${VARIABLE}` reference); the default is a literal. */
export function writeFakeProvider(
  agentDir: string,
  baseUrl: string,
  options: { routable?: boolean; apiKey?: string } = {},
): void {
  mkdirSync(agentDir, { recursive: true });
  const cost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          baseUrl,
          api: "openai-completions",
          apiKey: options.apiKey ?? "not-a-key",
          models: [
            {
              id: "m",
              name: "m",
              reasoning: false,
              input: ["text"],
              cost,
              contextWindow: 32000,
              maxTokens: 4000,
            },
            ...(options.routable === true
              ? [
                  {
                    id: "r",
                    name: "r",
                    reasoning: true,
                    input: ["text"],
                    cost,
                    contextWindow: 200000,
                    maxTokens: 4000,
                  },
                ]
              : []),
          ],
        },
      },
    }),
  );
}
