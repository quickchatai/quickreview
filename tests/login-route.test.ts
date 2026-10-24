// extensions/login-route.ts over fake pi API objects: the model route (an
// OpenAI model on the login that exists), the login hint, and the wizard's
// open of pi's /login through the submit pi wires onto an installed editor.
// The real pi 1.4.0 behaviour (the menu opening, the switch to openai) was
// verified by hand in tmux; these pin the extension's decisions.
import { describe, expect, it } from "vitest";
import {
  LOGIN_COMMAND,
  LOGIN_WIDGET,
  loginHintLines,
  loginRouteConfigFromEnv,
  needsLogin,
  openLogin,
  registerLoginRoute,
  routeSessionModel,
  submitThroughEditor,
} from "../extensions/login-route.js";
import { registerOnboardingSession } from "../extensions/onboarding.js";

type Model = { provider: string; id: string };

/** pi's model registry, by shape, over a set of logged-in providers. */
function registry(logins: string[], models: Model[] = OPENAI_MODELS) {
  return {
    getProviderAuthStatus: (p: string) => ({ configured: logins.includes(p) }) as never,
    find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) as never,
    getAvailable: () => models.filter((m) => logins.includes(m.provider)) as never,
  };
}
const OPENAI_MODELS: Model[] = [
  { provider: "openai-codex", id: "gpt-6.1-sol" },
  { provider: "openai", id: "gpt-6.1-sol" },
];

function fakePi(logins: string[]) {
  const selected: Model[] = [];
  return {
    selected,
    setModel: async (m: Model) => {
      if (!logins.includes(m.provider)) return false;
      selected.push(m);
      return true;
    },
  };
}

describe("routeSessionModel", () => {
  it("leaves a model whose provider has a login alone (the production VM)", async () => {
    const pi = fakePi(["openai-codex", "openai"]);
    const outcome = await routeSessionModel(pi as never, {
      model: OPENAI_MODELS[0] as never,
      modelRegistry: registry(["openai-codex", "openai"]),
    });
    expect(outcome).toBe("usable");
    expect(pi.selected).toEqual([]);
  });

  // MUTATION: return "unusable" without trying the twin — this fails.
  it("moves an openai-codex model to openai when only that login exists, and back", async () => {
    const pi = fakePi(["openai"]);
    expect(
      await routeSessionModel(pi as never, {
        model: OPENAI_MODELS[0] as never,
        modelRegistry: registry(["openai"]),
      }),
    ).toBe("switched");
    expect(pi.selected).toEqual([{ provider: "openai", id: "gpt-6.1-sol" }]);
    const back = fakePi(["openai-codex"]);
    expect(
      await routeSessionModel(back as never, {
        model: OPENAI_MODELS[1] as never,
        modelRegistry: registry(["openai-codex"]),
      }),
    ).toBe("switched");
    expect(back.selected).toEqual([{ provider: "openai-codex", id: "gpt-6.1-sol" }]);
  });

  it("no login at all, a twin without the model, or no model: nothing is switched", async () => {
    const pi = fakePi([]);
    expect(
      await routeSessionModel(pi as never, {
        model: OPENAI_MODELS[0] as never,
        modelRegistry: registry([]),
      }),
    ).toBe("unusable");
    expect(
      await routeSessionModel(fakePi(["openai"]) as never, {
        model: OPENAI_MODELS[0] as never,
        modelRegistry: registry(["openai"], [OPENAI_MODELS[0]!]),
      }),
    ).toBe("unusable");
    expect(
      await routeSessionModel(pi as never, { model: undefined, modelRegistry: registry([]) }),
    ).toBe("none");
  });

  it("needs a login when no model is usable and pi has none to pick", () => {
    expect(needsLogin("usable", registry([]))).toBe(false);
    expect(needsLogin("switched", registry([]))).toBe(false);
    expect(needsLogin("unusable", registry(["openai"]))).toBe(true);
    expect(needsLogin("none", registry([]))).toBe(true);
    expect(needsLogin("none", registry(["openai"]))).toBe(false);
  });
});

/** pi's editor slot, as interactive mode drives it: an installed editor gets
 * pi's submit handler; undefined restores the default editor. */
function fakeEditorUi(o: { wiresSubmit?: boolean } = {}) {
  const submitted: string[] = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  let factory: unknown;
  let text = "";
  const ui = {
    submitted,
    widgets,
    get text() {
      return text;
    },
    getEditorComponent: () => factory as never,
    setEditorComponent: (f: unknown) => {
      factory = f;
      if (typeof f !== "function") return;
      const editor = (f as (...a: unknown[]) => { onSubmit?: (t: string) => void })(
        "tui",
        "theme",
        "kb",
      );
      if (o.wiresSubmit !== false) editor.onSubmit = (t) => submitted.push(t);
    },
    setEditorText: (t: string) => {
      text = t;
    },
    setWidget: (key: string, lines: string[] | undefined) => widgets.push([key, lines]),
  };
  return ui;
}

const stubEditor = () => ({}) as never;

describe("submitThroughEditor", () => {
  // MUTATION: drop the restore — the installed editor stays and this fails.
  it("submits through pi's own handler and restores the editor that was there", async () => {
    const ui = fakeEditorUi();
    const before = ui.getEditorComponent();
    expect(submitThroughEditor(ui as never, "/login", stubEditor)).toBe(true);
    expect(ui.getEditorComponent()).toBe(before);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.submitted).toEqual(["/login"]);
  });

  it("is false, submitting nothing, when pi wires no handler", async () => {
    const ui = fakeEditorUi({ wiresSubmit: false });
    expect(submitThroughEditor(ui as never, "/login", stubEditor)).toBe(false);
    await Promise.resolve();
    expect(ui.submitted).toEqual([]);
  });
});

describe("openLogin", () => {
  it("submit: pi's login menu opens, and the hint says how to reopen it", async () => {
    const ui = fakeEditorUi();
    expect(openLogin(ui as never, "submit")).toBe("submitted");
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.submitted).toEqual([LOGIN_COMMAND]);
    expect(ui.widgets).toEqual([[LOGIN_WIDGET, loginHintLines(true)]]);
  });

  it("prefill, or a submit pi did not wire: /login waits on the input line", () => {
    for (const [ui, open] of [
      [fakeEditorUi(), "prefill"],
      [fakeEditorUi({ wiresSubmit: false }), "submit"],
    ] as const) {
      expect(openLogin(ui as never, open)).toBe("prefilled");
      expect(ui.text).toBe(LOGIN_COMMAND);
      expect(ui.widgets).toEqual([[LOGIN_WIDGET, loginHintLines(false)]]);
    }
  });

  it("the hint names every OpenAI login pi 1.4 offers", () => {
    const text = loginHintLines(true).join("\n");
    expect(text).toContain("Any OpenAI login works");
    expect(text).toContain('"OpenAI Codex (legacy)"');
    expect(text).toContain("Sign in with ChatGPT");
    expect(text).toContain('"Sign in with an API key"');
  });

  it("the env shim opens the menu only when asked", () => {
    expect(loginRouteConfigFromEnv({ QCR_LOGIN_OPEN: "submit" })).toEqual({ open: "submit" });
    expect(loginRouteConfigFromEnv({})).toEqual({ open: "prefill" });
  });
});

/** A pi that records its handlers, for driving the registered events. */
function eventPi(logins: string[]) {
  const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
  const base = fakePi(logins);
  return {
    ...base,
    handlers,
    on: (event: string, h: (e: unknown, ctx: unknown) => unknown) => handlers.set(event, h),
  };
}

describe("registerLoginRoute", () => {
  it("a session with no login opens the login and clears the hint once a model is picked", async () => {
    const pi = eventPi([]);
    registerLoginRoute(pi as never, { open: "submit" });
    const ui = fakeEditorUi();
    const ctx = { hasUI: true, ui, model: undefined, modelRegistry: registry([]) };
    await pi.handlers.get("session_start")!({}, ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.submitted).toEqual([LOGIN_COMMAND]);
    pi.handlers.get("model_select")!({}, ctx);
    expect(ui.widgets.at(-1)).toEqual([LOGIN_WIDGET, undefined]);
  });

  it("a logged-in session shows nothing; a headless one never touches a UI", async () => {
    const pi = eventPi(["openai-codex"]);
    registerLoginRoute(pi as never, { open: "submit" });
    const ui = fakeEditorUi();
    await pi.handlers.get("session_start")!(
      {},
      { hasUI: true, ui, model: OPENAI_MODELS[0], modelRegistry: registry(["openai-codex"]) },
    );
    await pi.handlers.get("session_start")!(
      {},
      { hasUI: false, ui, model: undefined, modelRegistry: registry([]) },
    );
    expect(ui.widgets).toEqual([]);
    expect(ui.submitted).toEqual([]);
  });

  it("routes the model before every prompt, so a login made mid-session is used", async () => {
    const pi = eventPi(["openai"]);
    registerLoginRoute(pi as never, { open: "prefill" });
    const result = await pi.handlers.get("input")!(
      { text: "hi" },
      { hasUI: true, model: OPENAI_MODELS[0], modelRegistry: registry(["openai"]) },
    );
    expect(result).toEqual({ action: "continue" });
    expect(pi.selected).toEqual([{ provider: "openai", id: "gpt-6.1-sol" }]);
  });

  it("the onboarding session registers it with the menu opened (the Boxes entry point)", async () => {
    const pi = eventPi([]);
    registerOnboardingSession(pi as never);
    expect([...pi.handlers.keys()].sort()).toEqual(["input", "model_select", "session_start"]);
    const ui = fakeEditorUi();
    await pi.handlers.get("session_start")!(
      {},
      { hasUI: true, ui, model: undefined, modelRegistry: registry([]) },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(ui.submitted).toEqual([LOGIN_COMMAND]);
  });
});
