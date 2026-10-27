// The `home_*` tools of "Tune to this repo" (src/home/tune.ts) and Advanced
// (src/home/advanced.ts): the same methods the t / x keys and alt+t / alt+x
// call (extensions/home.ts), so a key and a tool never do two different
// things. Every question stays the person's: a tool starts a tune or opens a
// choice, and the home asks.
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { textResult, type QcrTool } from "@quickchatai/pi-quickreview/extensions/pi-tool.js";
import {
  ADVANCED_ROUTES,
  type AdvancedAsk,
  type AdvancedRoute,
  type HomeAdvanced,
} from "./advanced.js";
import type { HomeTune } from "./tune.js";
import type { HOME_ADVANCED_TOOL_NAMES } from "./toolnames.js";

export type HomeAdvancedToolName = (typeof HOME_ADVANCED_TOOL_NAMES)[number];

const NO_PARAMS = { type: "object", properties: {}, additionalProperties: false } as const;

export interface AdvancedToolsHost {
  tune: HomeTune;
  advanced: HomeAdvanced;
  /** Hand the chat's agent a message as the person (Setup's brief). */
  tellAgent: (text: string) => void;
  /** Who answers the home's questions for a tool call; undefined: nobody. */
  ask: (ctx: ExtensionToolContext | undefined) => AdvancedAsk | undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const isRoute = (v: unknown): v is AdvancedRoute =>
  typeof v === "string" && (ADVANCED_ROUTES as readonly string[]).includes(v);

/** One definition per HOME_ADVANCED_TOOL_NAMES entry. */
export function advancedTools(h: AdvancedToolsHost): {
  [N in HomeAdvancedToolName]: QcrTool & { name: N };
} {
  return {
    home_tune: {
      name: "home_tune",
      label: "Home: tune to this repo",
      description:
        "Run Setup for the home's repository: a survey of a checkout of it, its review history, and an interview with the person here in the chat, which writes the repo profile (.qcr/). It hands you the Setup brief as the person's next message, and the tune stays open until you write the profile's last file. Nothing requires it: reviews run on the default profile until then.",
      parameters: NO_PARAMS,
      execute: async () => textResult(await h.tune.tune(h.tellAgent)),
    },
    home_tune_write: {
      name: "home_tune_write",
      label: "Home: write a profile file",
      description:
        "While Setup runs (home_tune), write one file of the repo profile into the checkout's .qcr/: `profile.toml`, or `addenda/<nn>-<rule-id>.md`. Show the person the file in the chat first: the home asks them, and writes it only on their yes. The tune stays open through every file: pass `last: true` with the profile's final one.",
      parameters: {
        type: "object",
        properties: {
          file: {
            type: "string",
            description: "The file, relative to .qcr/: profile.toml or addenda/<nn>-<rule-id>.md.",
          },
          content: { type: "string", description: "The whole file." },
          last: {
            type: "boolean",
            description: "True for the profile's final file: the tune ends with it.",
          },
        },
        required: ["file", "content"],
        additionalProperties: false,
      },
      execute: async (_id, p, _signal, _onUpdate, ctx) =>
        textResult(
          await h.tune.write(str(p["file"]), str(p["content"]), h.ask(ctx), p["last"] === true),
        ),
    },
    home_advanced: {
      name: "home_advanced",
      label: "Home: advanced",
      description:
        "Open the home's Advanced choices: a GitHub App (a bot identity) instead of the person's own account, webhooks through a tunnel instead of polling, auto-review on another server over ssh, Slack, and dry-run or live. `choice` opens one directly. Every question is the person's to answer in the home: this tool cannot answer or confirm for them.",
      parameters: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: [...ADVANCED_ROUTES],
            description: "The choice to open; omit to let the person pick.",
          },
        },
        additionalProperties: false,
      },
      execute: async (_id, p, _signal, _onUpdate, ctx) =>
        textResult(
          await h.advanced.open(h.ask(ctx), isRoute(p["choice"]) ? p["choice"] : undefined),
        ),
    },
  };
}
