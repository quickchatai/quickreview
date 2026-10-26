// home — the app's home: the panel at the top right of the app's own pi, and
// the `home_*` tools. Loaded by a bare `qcr` (src/home/launch.ts) through its
// env shim, extensions/cli/home.ts, beside the plugin; a factory over explicit
// options, so it reads no process state.
//
// Every action is one HomeModel method (src/home/model.ts), called by a key
// and by a tool alike:
//
//   action            key, while typing   key, panel focused   tool
//   move the cursor   alt+j / alt+k       j / k, ↓ / ↑         home_move
//   select a PR       (hover, click)      (hover, click)       home_select
//   open it on GitHub alt+o               o                    home_open_pr
//   read it all again alt+u               u                    home_refresh
//   review it         alt+r               ⏎, r                 home_review_pr
//   show its review   alt+r (reviewed)    ⏎ (reviewed)         home_show_review
//   stop its review   alt+s               s                    home_stop_review
//   what it shows     —                   —                    home_status
//
// The review runs detached (the app's `qcr review start`, on the person's own
// pi login), writes its report to a file and never posts by itself; once it
// is done the person's posting rule (pi's settings, `quickreview.posting`)
// applies, asking with "No, keep it here" first. A review's findings go to
// the chat as the plugin's review message.
//
// f2 or a click focuses the panel for its plain keys, and Esc gives the
// editor back: the panel never takes the keyboard by itself (nonCapturing).
// The first frame is drawn before any port is read; each read lands into it.
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { KeyId, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import {
  registerQcrTool,
  textResult,
  type QcrTool,
} from "@quickchatai/pi-quickreview/extensions/pi-tool.js";
import { REVIEW_MESSAGE } from "@quickchatai/pi-quickreview/src/plugin/review.js";
import { readQuickReviewSettings } from "@quickchatai/pi-quickreview/src/plugin/settings.js";
import type { HomeToolSet } from "../src/config.js";
import { HomeModel } from "../src/home/model.js";
import { HOME_OVERLAY, HomePanel } from "../src/home/panel.js";
import type { HomeAdapters } from "../src/home/ports.js";
import { HOME_TOOL_NAMES } from "../src/home/toolnames.js";

type HomeToolName = (typeof HOME_TOOL_NAMES)[number];

export interface HomeOptions {
  adapters: HomeAdapters;
  /** The model the home was launched on, `provider/id`. */
  model: string;
  /** The tool set it was launched with, shown on the login line. */
  tools: HomeToolSet;
  /** Run `fn` every `ms` until the returned stop is called. */
  every?: (ms: number, fn: () => void) => () => void;
  /** Run `fn` once after `ms`; the returned function cancels it. */
  after?: (ms: number, fn: () => void) => () => void;
}

/** How often the home reads its sources again by itself. */
export const REFRESH_MS = 60_000;
const SPIN_MS = 100;

const realEvery = (ms: number, fn: () => void): (() => void) => {
  const t = setInterval(fn, ms);
  t.unref?.();
  return () => clearInterval(t);
};

const realAfter = (ms: number, fn: () => void): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

const NO_PARAMS = { type: "object", properties: {}, additionalProperties: false } as const;
const PR_PARAM = {
  type: "integer",
  minimum: 1,
  description: "The pull request's number.",
} as const;

export function createHome(o: HomeOptions): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    const every = o.every ?? realEvery;
    let tui: TUI | undefined;
    let handle: OverlayHandle | undefined;
    let close: (() => void) | undefined;
    let frame = 0;
    const stops: Array<() => void> = [];
    const redraw = (): void => tui?.requestRender();
    // the session's UI, for the post question; none outside the TUI
    let ui: ExtensionContext["ui"] | undefined;
    const model = new HomeModel({
      adapters: o.adapters,
      model: o.model,
      tools: o.tools,
      onChange: redraw,
      after: o.after ?? realAfter,
      ask: async (question, options) => ui?.select(question, options),
      send: (m) =>
        pi.sendMessage({
          customType: REVIEW_MESSAGE,
          content: m.content,
          display: true,
          details: m.details,
        }),
      postingRule: () => {
        try {
          return readQuickReviewSettings(pi.getSettings()).settings.posting;
        } catch {
          return "ask";
        }
      },
    });

    const mount = (ctx: ExtensionContext): void => {
      if (close) return;
      void ctx.ui.custom<void>(
        (t, theme, _keys, done) => {
          tui = t;
          close = () => done();
          return new HomePanel(theme, {
            model,
            focused: () => handle?.isFocused() ?? false,
            rows: () => t.terminal.rows,
            unfocus: () => handle?.unfocus(),
            frame: () => frame,
          });
        },
        {
          overlay: true,
          overlayOptions: { ...HOME_OVERLAY, margin: { ...HOME_OVERLAY.margin } },
          onHandle: (h) => (handle = h),
        },
      );
    };

    pi.on("session_start", (_e, ctx) => {
      model.setChatModel(ctx.model?.provider);
      ui = ctx.mode === "tui" ? ctx.ui : undefined;
      if (ctx.mode === "tui") {
        mount(ctx);
        // the spinner turns only while a read is in flight
        stops.push(
          every(SPIN_MS, () => {
            if (!model.busy()) return;
            frame++;
            redraw();
          }),
        );
      }
      stops.push(every(REFRESH_MS, () => void model.refresh()));
      void model.refresh();
    });
    pi.on("model_select", (e) => model.setChatModel(e.model.provider));
    pi.on("session_shutdown", () => {
      // the session's timers and its pricing stop; a running review goes on
      model.dispose();
      ui = undefined;
      for (const stop of stops.splice(0)) stop();
      close?.();
      close = undefined;
    });

    const key = (id: string, description: string, run: () => unknown): void =>
      pi.registerShortcut(id as KeyId, {
        description,
        handler: () => {
          void run();
        },
      });
    key("alt+j", "quickreview home: next pull request", () => model.move(1));
    key("alt+k", "quickreview home: previous pull request", () => model.move(-1));
    key("alt+o", "quickreview home: open the pull request on GitHub", () => model.openPr());
    key("alt+u", "quickreview home: read everything again", () => model.refresh());
    key("alt+r", "quickreview home: review the pull request, or show its review", () =>
      model.enter(),
    );
    key("alt+s", "quickreview home: stop the pull request's review", () => model.stopReview());
    key("f2", "quickreview home: focus the panel", () => handle?.focus());

    // one definition per HOME_TOOL_NAMES entry: a name without one does not compile
    const tools: { [N in HomeToolName]: QcrTool & { name: N } } = {
      home_status: {
        name: "home_status",
        label: "Home status",
        description:
          "Read what the quickreview home shows: the repository, the logins, auto-review, memory, spend and the open pull requests (To review, Reviewed). A value that could not be read is null.",
        parameters: NO_PARAMS,
        execute: () => textResult(JSON.stringify(model.status(), null, 1)),
      },
      home_refresh: {
        name: "home_refresh",
        label: "Home refresh",
        description:
          "Read the home's sources again: the logins, the repository and its open pull requests.",
        parameters: NO_PARAMS,
        execute: async () => textResult(await model.refresh()),
      },
      home_move: {
        name: "home_move",
        label: "Home move",
        description:
          "Move the home's selection through its pull request lists: 1 is the next row, -1 the previous.",
        parameters: {
          type: "object",
          properties: { by: { type: "integer", description: "Rows to move; negative moves up." } },
          required: ["by"],
          additionalProperties: false,
        },
        execute: (_id, p) => textResult(model.move(Number(p["by"]))),
      },
      home_select: {
        name: "home_select",
        label: "Home select",
        description: "Select one open pull request in the home's lists, by number.",
        parameters: {
          type: "object",
          properties: { pr: PR_PARAM },
          required: ["pr"],
          additionalProperties: false,
        },
        execute: (_id, p) => textResult(model.select(Number(p["pr"]))),
      },
      home_open_pr: {
        name: "home_open_pr",
        label: "Home open PR",
        description:
          "Open a pull request on GitHub in the person's browser: the one given, or the home's selected one.",
        parameters: { type: "object", properties: { pr: PR_PARAM }, additionalProperties: false },
        execute: async (_id, p) =>
          textResult(await model.openPr(typeof p["pr"] === "number" ? p["pr"] : undefined)),
      },
      home_review_pr: {
        name: "home_review_pr",
        label: "Home review PR",
        description:
          "Review a pull request with QuickReview in the background: the one given, or the home's selected one. It previews the price, starts the review and returns at once; the home shows its progress and findings, and nothing is posted to GitHub unless the person's posting rule says so.",
        parameters: { type: "object", properties: { pr: PR_PARAM }, additionalProperties: false },
        execute: async (_id, p) =>
          textResult(await model.review(typeof p["pr"] === "number" ? p["pr"] : undefined)),
      },
      home_show_review: {
        name: "home_show_review",
        label: "Home show review",
        description:
          "Put a reviewed pull request's findings in the chat: the one given, or the home's selected one.",
        parameters: { type: "object", properties: { pr: PR_PARAM }, additionalProperties: false },
        execute: (_id, p) =>
          textResult(model.showReview(typeof p["pr"] === "number" ? p["pr"] : undefined)),
      },
      home_stop_review: {
        name: "home_stop_review",
        label: "Home stop review",
        description:
          "Stop the running QuickReview review of a pull request: the one given, or the home's selected one.",
        parameters: { type: "object", properties: { pr: PR_PARAM }, additionalProperties: false },
        execute: async (_id, p) =>
          textResult(await model.stopReview(typeof p["pr"] === "number" ? p["pr"] : undefined)),
      },
    };
    for (const name of HOME_TOOL_NAMES) registerQcrTool(pi, tools[name]);
  };
}
