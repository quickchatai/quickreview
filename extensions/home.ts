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
//   auto-review on/off alt+a              a                    home_auto_review
//   memory on/off     alt+m               m                    home_memory
//   sign in again     alt+l               l                    home_relogin
//
// Signing in again is for a login that expired or was revoked: the login
// line says "login expired" (src/home/loginowner.ts reads the refresher's
// record, pi's own error in the chat and auto-review's pause). It is pi's
// device login, with auto-review's login refresher paused around it when it
// runs, so the box keeps one login that one process refreshes (FT-0658).
//
// The two switches ask the person every question in the home (pi's select):
// a tool starts one but cannot answer it, so the one confirm that turns
// auto-review on, and with it the go-live, is the person's (invariant 6).
//
// The review runs detached (the app's `qcr review start`, on the person's own
// pi login), writes its report to a file and never posts by itself; once it
// is done the person's posting rule (pi's settings, `quickreview.posting`)
// applies, asking with "No, keep it here" first. A review's findings go to
// the chat as the plugin's review message.
//   next setup step   alt+n               ⏎ (on the card)      home_setup_next
//   each setup step   —                   —                    home_sign_in,
//                                                              home_check_github,
//                                                              home_choose_repo
//
// On a machine that is not set up, the setup checklist (src/home/setup.ts)
// shows as a centred card (src/home/setupcard.ts) instead of the panel; when
// its last step is done the card gives way to the panel, and back again if a
// read shows a step missing once more.
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
import { piDeviceLogin } from "../src/home/devicelogin.js";
import { Relogin, RELOGIN_KEY, isLoginError } from "../src/home/loginowner.js";
import { HomeModel } from "../src/home/model.js";
import { HOME_OVERLAY, HomePanel } from "../src/home/panel.js";
import type { HomeAdapters } from "../src/home/ports.js";
import type { Ask } from "../src/home/switches.js";
import { HomeSetup, type HomeSetupPorts, type SetupUi } from "../src/home/setup.js";
import { SETUP_OVERLAY, SetupCard } from "../src/home/setupcard.js";
import { setupTools } from "../src/home/setuptools.js";
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
  /** The setup checklist's ports beyond the home's own. */
  setup?: HomeSetupPorts;
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
    let mounted: "setup" | "home" | undefined;
    let session: ExtensionContext | undefined;
    let frame = 0;
    /** The session's UI, for the switches' questions. */
    let sessionUi: Ask | undefined;
    const askOf = (ctx: ExtensionContext | undefined): Ask | undefined =>
      ctx?.hasUI ? ctx.ui : sessionUi;
    const stops: Array<() => void> = [];
    const redraw = (): void => tui?.requestRender();
    // the session's UI, for the post question; none outside the TUI
    let ui: ExtensionContext["ui"] | undefined;
    const model: HomeModel = new HomeModel({
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
      gaps: (): string[] => setup.gaps(),
      onRead: (): Promise<void> => setup.sync(),
    });
    const setup: HomeSetup = new HomeSetup({
      model,
      github: o.adapters.github,
      ports: o.setup ?? {},
      deviceLogin: () => deviceLogin(),
      onChange: redraw,
      onPhase: () => {
        if (session?.mode === "tui") mount(session);
      },
      interactive: () => session?.mode === "tui",
    });
    const deviceLogin = () =>
      o.setup?.deviceLogin ?? (session ? piDeviceLogin(session.modelRegistry) : undefined);
    const relogin = new Relogin({
      model,
      owner: o.adapters.loginOwner,
      deviceLogin,
      onChange: redraw,
    });
    const dialogs = (ctx: ExtensionContext | undefined): SetupUi | undefined =>
      ctx?.hasUI
        ? {
            select: (title, options) => ctx.ui.select(title, options),
            input: (title, placeholder) => ctx.ui.input(title, placeholder),
          }
        : undefined;
    const nextStep = (ctx: ExtensionContext | undefined): Promise<string> =>
      setup.next(dialogs(ctx));

    // The card while setup has a gap, the panel otherwise; a change of phase
    // closes the one and opens the other.
    const mount = (ctx: ExtensionContext): void => {
      const want = setup.phase();
      if (close && mounted === want) return;
      close?.();
      close = undefined;
      handle = undefined;
      mounted = want;
      const focused = (): boolean => handle?.isFocused() ?? false;
      void ctx.ui.custom<void>(
        (t, theme, _keys, done) => {
          tui = t;
          close = () => done();
          return want === "setup"
            ? new SetupCard(theme, {
                setup,
                model,
                focused,
                rows: () => t.terminal.rows,
                unfocus: () => handle?.unfocus(),
                frame: () => frame,
                next: () => void nextStep(session),
              })
            : new HomePanel(theme, {
                model,
                focused,
                rows: () => t.terminal.rows,
                unfocus: () => handle?.unfocus(),
                frame: () => frame,
                ask: () => sessionUi,
                relogin: () => void relogin.start(),
                signingAgain: () => relogin.running() !== null,
              });
        },
        {
          overlay: true,
          overlayOptions:
            want === "setup"
              ? { ...SETUP_OVERLAY }
              : { ...HOME_OVERLAY, margin: { ...HOME_OVERLAY.margin } },
          onHandle: (h) => (handle = h),
        },
      );
    };

    pi.on("session_start", (_e, ctx) => {
      session = ctx;
      model.setChatModel(ctx.model?.provider);
      ui = ctx.mode === "tui" ? ctx.ui : undefined;
      sessionUi = ctx.hasUI ? ctx.ui : undefined;
      if (ctx.mode === "tui") {
        mount(ctx);
        // the spinner turns only while a read or a setup step is in flight
        stops.push(
          every(SPIN_MS, () => {
            if (!model.busy() && !setup.busy() && relogin.running() === null) return;
            frame++;
            redraw();
          }),
        );
      }
      stops.push(every(REFRESH_MS, () => void model.refresh()));
      void model.refresh();
    });
    pi.on("model_select", (e) => model.setChatModel(e.model.provider));
    // pi's own word on the login: a reply refused for it, or one that came back
    pi.on("message_end", (e) => {
      const m = e.message as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
      if (m.role !== "assistant") return;
      if (m.stopReason === "error") {
        if (typeof m.errorMessage === "string" && isLoginError(m.errorMessage))
          model.loginFailed(m.errorMessage);
      } else if (m.stopReason !== "aborted") model.chatAnswered();
    });
    pi.on("session_shutdown", () => {
      // the session's timers and its pricing stop; a running review goes on
      model.dispose();
      relogin.close();
      ui = undefined;
      for (const stop of stops.splice(0)) stop();
      setup.close();
      close?.();
      close = undefined;
      mounted = undefined;
    });

    const key = (
      id: string,
      description: string,
      run: (ctx: ExtensionContext | undefined) => unknown,
    ): void =>
      pi.registerShortcut(id as KeyId, {
        description,
        handler: (ctx) => {
          void run(ctx);
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
    key("alt+a", "quickreview home: switch auto-review on or off", (ctx) =>
      model.switchAutoReview(askOf(ctx)),
    );
    key("alt+m", "quickreview home: switch memory on or off", (ctx) =>
      model.switchMemory(askOf(ctx)),
    );
    key(RELOGIN_KEY, "quickreview home: sign in again (an expired login)", () => relogin.start());
    pi.registerShortcut("alt+n", {
      description: "quickreview home: run the next setup step",
      handler: (ctx) => {
        void nextStep(ctx);
      },
    });

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
      home_auto_review: {
        name: "home_auto_review",
        label: "Home auto-review",
        description:
          "Switch auto-review on or off. Switching on checks this machine, then asks the person where it runs, whether to turn memory on too, and for their one confirm; switching off warns them which review is running. Every question is the person's to answer in the home: this tool cannot answer or confirm for them.",
        parameters: NO_PARAMS,
        execute: async (_id, _p, _signal, _onUpdate, ctx) =>
          textResult(await model.switchAutoReview(askOf(ctx))),
      },
      home_memory: {
        name: "home_memory",
        label: "Home memory",
        description:
          "Switch reviewer memory on or off, on its own: auto-review is not touched. The person confirms in the home, after seeing its RAM cost.",
        parameters: NO_PARAMS,
        execute: async (_id, _p, _signal, _onUpdate, ctx) =>
          textResult(await model.switchMemory(askOf(ctx))),
      },
      home_relogin: {
        name: "home_relogin",
        label: "Home sign in again",
        description:
          "Sign in again with pi's own device-code login, for the provider the chat runs on, when the login has expired or was revoked (the home's login line says \"login expired\"). When auto-review runs on this machine its login refresher is paused during the sign-in and resumes on the new login. Answers with the URL and the code to enter once pi has them; the sign-in finishes in the background when the person approves it.",
        parameters: NO_PARAMS,
        execute: async () => textResult(await relogin.start()),
      },
      ...setupTools(setup),
    };
    for (const name of HOME_TOOL_NAMES) registerQcrTool(pi, tools[name]);
  };
}
