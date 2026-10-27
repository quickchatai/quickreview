// The setup checklist's `home_*` tools: each step's action, as the model in
// the chat calls it. The keys call the same HomeSetup methods
// (extensions/home.ts), so a key and a tool never do two different things.
import { textResult, type QcrTool } from "@quickchatai/pi-quickreview/extensions/pi-tool.js";
import type { HomeSetup } from "./setup.js";
import type { HOME_SETUP_TOOL_NAMES } from "./toolnames.js";

export type HomeSetupToolName = (typeof HOME_SETUP_TOOL_NAMES)[number];

const NO_PARAMS = { type: "object", properties: {}, additionalProperties: false } as const;

/** One definition per HOME_SETUP_TOOL_NAMES entry. */
export function setupTools(setup: HomeSetup): {
  [N in HomeSetupToolName]: QcrTool & { name: N };
} {
  return {
    home_setup_next: {
      name: "home_setup_next",
      label: "Home: next setup step",
      description:
        "Run the next step of the quickreview home's setup checklist (sign in, connect GitHub, choose a repository), as alt+n does. Answers what happened, or that setup is done.",
      parameters: NO_PARAMS,
      execute: async () => textResult(await setup.next()),
    },
    home_sign_in: {
      name: "home_sign_in",
      label: "Home: sign in",
      description:
        "Start pi's own device-code login for the provider the chat runs on. Answers with the URL and the code to enter once pi has them; the sign-in finishes in the background when the person approves it. Device-code login must be on in ChatGPT → Settings → Security.",
      parameters: NO_PARAMS,
      execute: async () => textResult(await setup.signIn()),
    },
    home_check_github: {
      name: "home_check_github",
      label: "Home: check GitHub",
      description:
        "Check again whether gh is installed and signed in. When it is not, the answer says what to run.",
      parameters: NO_PARAMS,
      execute: async () => textResult(await setup.checkGithub()),
    },
    home_choose_repo: {
      name: "home_choose_repo",
      label: "Home: choose a repository",
      description:
        "Set the repository the home reviews: owner/name or any GitHub URL of it. It is written to the qcr config's [github] repo. Without `repo`, answers the person's recently pushed repositories to choose from.",
      parameters: {
        type: "object",
        properties: {
          repo: { type: "string", description: "owner/name, or a GitHub URL of the repository." },
        },
        additionalProperties: false,
      },
      execute: async (_id, p) =>
        textResult(await setup.chooseRepo(typeof p["repo"] === "string" ? p["repo"] : undefined)),
    },
  };
}
