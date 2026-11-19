// Canary 16: the pack-first rewrite, over the request pi REALLY builds.
//
// A lens reads its group's warm-up from the provider's cache only when its
// request repeats the warm-up's, part for part, up to the end of the pack.
// Which items pi puts in a request's input, and where, is pi's to decide, and
// a fake payload in a unit test knows nothing of it: pi began declaring the
// tools in the input, at its head, the rewrite went on putting the pack first,
// and from then on the declarations sat after the pack in a warm-up and after
// the lens body in a lens. Every lens of every packed group then read 0 tokens
// of its warm-up, with every test green.
//
// So this runs pi-ai's own request builder for every API of the pack's
// family, for a warm-up and for two lenses with tools, sends each through the
// rewrite, and holds the property itself. Nothing is sent: the payload hook
// keeps the request and ends it there (the offline guard holds that).
//
// MUTATION: in packFirstPayload put the pack ahead of the whole input
// (`[pack, ...input]`, both forms) - the last two tests fail.
// MUTATION: in packFirstPayload leave the closing message out of a lens's
// input - the last two tests fail.
import { describe, expect, it } from "vitest";
import { Type, type Api, type Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  PACK_FIRST_APIS,
  packFirstPayload,
  prefixDifference,
  prefixDigest,
} from "@quickchatai/pi-quickreview/src/engine/lens/leaf-cache.js";
import { WARMUP_REPLY_TASK } from "@quickchatai/pi-quickreview/src/engine/lens/cache-run.js";
import { useOfflineGuard } from "./harness.js";

useOfflineGuard();

const PACK = "# PR CONTEXT PACK\n\nthe diff, then the files\n";
const BASE = "You are pi, a coding agent.\n\n<cwd>\n/work\n</cwd>";
/** pi's system prompt with a lens body appended: the body in an addendum. */
const withBody = (body: string): string =>
  `You are pi, a coding agent.\n\n<addendum>\n${body}\n\n</addendum>\n\n<cwd>\n/work\n</cwd>`;

const TOOLS = [
  {
    name: "read",
    description: "Read a file.",
    parameters: Type.Object({ path: Type.String() }),
  },
  {
    name: "bash",
    description: "Run a command.",
    parameters: Type.Object({ command: Type.String() }),
  },
];

/** A login token of the shape the API reads its account from: made here, never a real one. */
const token = (): string =>
  [
    "h",
    Buffer.from(
      JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "canary" } }),
    ).toString("base64"),
    "s",
  ].join(".");

/** One model of each API in the pack-first family, from pi's own catalog. */
function familyModels(): Model<Api>[] {
  const found = new Map<string, Model<Api>>();
  for (const provider of getBuiltinProviders())
    for (const model of getBuiltinModels(provider) as Model<Api>[])
      if (PACK_FIRST_APIS.has(model.api) && !found.has(model.api)) found.set(model.api, model);
  return [...found.values()];
}

/** The request pi builds for one turn, as the provider hook sees it. */
async function piRequest(
  model: Model<Api>,
  systemPrompt: string,
  prompt: string,
): Promise<unknown> {
  let captured: unknown;
  await completeSimple(
    model,
    {
      systemPrompt,
      messages: [{ role: "user", content: prompt, timestamp: 0 }],
      tools: TOOLS,
    },
    {
      apiKey: token(),
      sessionId: "cache-group",
      onPayload: (payload) => {
        captured = payload;
        throw new Error("canary: the request is kept, never sent");
      },
    },
  );
  expect(captured, "pi built a request").toBeDefined();
  return captured;
}

type Sent = Record<string, unknown>;

/** The request's conversation. */
const conversation = (sent: Sent): unknown[] => sent["input"] as unknown[];
/** The request without its conversation. */
const around = (sent: Sent): string => {
  const { input: _input, ...other } = sent;
  return JSON.stringify(other);
};

describe("canary 16: pi's real request, pack-first", () => {
  it("pi's catalog has a model for every API of the family", () => {
    expect(
      familyModels()
        .map((m) => m.api)
        .sort(),
    ).toEqual([...PACK_FIRST_APIS].sort());
  });

  for (const model of familyModels()) {
    const requests = async (): Promise<{ warm: Sent; a: Sent; b: Sent }> => {
      const bodyA = "You are pass-a. Report findings.";
      const bodyB = "You are pass-b. A different charter, of another length altogether.";
      return {
        // A warm-up's whole prompt is the message that closes the pack, as the
        // runner sends it (WARMUP_REPLY_TASK).
        warm: packFirstPayload(await piRequest(model, BASE, WARMUP_REPLY_TASK), "", PACK) as Sent,
        a: packFirstPayload(
          await piRequest(model, withBody(bodyA), "Task: Task file: /a.md."),
          bodyA,
          PACK,
        ) as Sent,
        b: packFirstPayload(
          await piRequest(model, withBody(bodyB), "Task: Task file: /b.md."),
          bodyB,
          PACK,
        ) as Sent,
      };
    };

    it(`${model.api}: the rewrite applies to the request pi builds`, async () => {
      const { warm, a, b } = await requests();
      for (const sent of [warm, a, b]) expect(sent, "rewritten, not sent as it came").toBeDefined();
    });

    it(`${model.api}: each lens repeats the warm-up up to the end of the pack`, async () => {
      const { warm, a, b } = await requests();
      const digest = (sent: Sent) => prefixDigest(sent, PACK)!;
      const packAt = digest(warm).packAt;
      expect(packAt).toBeGreaterThanOrEqual(0);
      expect(prefixDifference(digest(warm), digest(a))).toBeUndefined();
      expect(prefixDifference(digest(warm), digest(b))).toBeUndefined();
      // The same, on the requests themselves and not their hashes: everything
      // ahead of the item that holds the pack, and everything around the
      // conversation (the system prompt, the tools, the settings).
      const ahead = (sent: Sent) => JSON.stringify(conversation(sent).slice(0, packAt));
      for (const lens of [a, b]) {
        expect(ahead(lens)).toBe(ahead(warm));
        expect(around(lens)).toBe(around(warm));
      }
    });

    it(`${model.api}: after what it shares with the warm-up a lens holds its body first`, async () => {
      const { warm, a } = await requests();
      // The items a warm-up shares: through the pack, and the message that
      // closes it where the request carries one.
      const shared = prefixDigest(warm, PACK)!.input.length;
      const kinds = (sent: Sent, from: number) =>
        conversation(sent)
          .slice(from)
          .map((item) => (item as { type?: string }).type ?? (item as { role?: string }).role);
      const body = conversation(a)[shared];
      expect(JSON.stringify(body)).toContain("You are pass-a. Report findings.");
      expect((body as { role: string }).role).toBe("developer");
      // The body is nowhere ahead of the pack's end: not in the system prompt.
      expect(around(a)).not.toContain("You are pass-a.");
      // The request has no breakpoint to mark the pack's end, so a lens
      // EXTENDS its warm-up: the warm-up's conversation, whole, then the
      // lens's body and task.
      expect(conversation(warm)).toHaveLength(shared);
      expect(JSON.stringify(conversation(a).slice(0, shared))).toBe(
        JSON.stringify(conversation(warm)),
      );
      expect(kinds(a, shared)).toEqual(["developer", "user"]);
    });
  }
});
