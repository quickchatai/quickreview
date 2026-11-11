// extensions/login-route.ts over fake pi API objects: the model route (a
// session keeps a model that has a credential and is moved by the review's
// rule when it has none, whatever the provider), the login hint, the refusal
// a pi on a borrowed login prints in its place, and the wizard's open of pi's
// /login through the submit pi wires onto an installed editor. The registry is
// a fake by shape; the inventory and the rule over it are the real ones
// (packages/pi-plugin/extensions/route-registry.ts, src/modelroute.ts). The
// providers are made up: no rule here knows a real one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterAll, describe, expect, it } from "vitest";
import { writeModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  LOGIN_COMMAND,
  LOGIN_WIDGET,
  borrowedRefusalLines,
  loginHintLines,
  loginRouteConfigFromEnv,
  movedLines,
  openLogin,
  registerLoginRoute,
  registerModelRoute,
  routeSessionModel,
  submitThroughEditor,
} from "../extensions/login-route.js";
import { createHome } from "../extensions/home.js";
import { registerOnboardingSession } from "../extensions/onboarding.js";
import { known, unknown, type HomeAdapters } from "../src/home/ports.js";
import { fakePi as fakeHomePi } from "./helpers/fake-pi.js";

interface Model {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  contextWindow: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** A model the pick rule accepts: it reasons and a review fits its window. */
const model = (provider: string, id: string, o: Partial<Model> = {}): Model => ({
  provider,
  id,
  name: id,
  api: "made-up",
  reasoning: true,
  contextWindow: 200_000,
  cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  ...o,
});

// Two logins of one vendor (`north`, `north-legacy`: one family, the text
// before the first dash) that serve the same id, and two unrelated providers.
const NORTH = model("north", "large-3");
const NORTH_LEGACY = model("north-legacy", "large-3");
const SOUTH_OLD = model("south", "pro-4");
const SOUTH = model("south", "pro-5");
const EAST = model("east", "max-2");
const MODELS: Model[] = [NORTH, NORTH_LEGACY, SOUTH_OLD, SOUTH, EAST];

const NAMES: Record<string, string> = {
  north: "North",
  "north-legacy": "North (legacy)",
  south: "South",
  east: "East",
};

/** pi's model registry, by shape, over the providers that have a credential. */
function registry(logins: string[], models: Model[] = MODELS) {
  return {
    getAll: () => models as never,
    getAvailable: () => models.filter((m) => logins.includes(m.provider)) as never,
    find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id) as never,
    getProviderAuthStatus: (p: string) =>
      logins.includes(p) ? { configured: true, source: "stored" } : { configured: false },
    getProvider: () => undefined,
    getProviderDisplayName: (p: string) => NAMES[p] ?? p,
    isUsingOAuth: () => true,
  };
}

function fakePi(logins: string[]) {
  const selected: Array<{ provider: string; id: string }> = [];
  return {
    selected,
    setModel: async (m: Model) => {
      if (!logins.includes(m.provider)) return false;
      selected.push({ provider: m.provider, id: m.id });
      return true;
    },
  };
}

const route = async (logins: string[], session: Model | undefined, models: Model[] = MODELS) => {
  const pi = fakePi(logins);
  const outcome = await routeSessionModel(pi as never, {
    model: session as never,
    modelRegistry: registry(logins, models),
  });
  return { outcome, selected: pi.selected };
};

describe("routeSessionModel", () => {
  // MUTATION: drop the `usable` return and resolve a route for every session —
  // pi is asked to switch a session that had a usable model and this fails.
  it("keeps a model whose provider has a credential, whichever provider and model it is", async () => {
    for (const session of [NORTH_LEGACY, SOUTH_OLD, EAST]) {
      const r = await route(["north", "north-legacy", "south", "east"], session);
      expect(r.outcome, session.provider).toEqual({ kind: "usable" });
      expect(r.selected).toEqual([]);
    }
  });

  // MUTATION: drop the pin attempt (resolve with nothing pinned only) — the
  // session lands on south's newer model instead of its own and this fails.
  it("runs the model it names on another login of the same vendor that serves it", async () => {
    const r = await route(["north", "south"], NORTH_LEGACY);
    expect(r.selected).toEqual([{ provider: "north", id: "large-3" }]);
    expect(r.outcome).toMatchObject({
      kind: "moved",
      from: "north-legacy/large-3",
      route: { spec: "north/large-3", movedFrom: "north-legacy", providerName: "North" },
    });
    const back = await route(["north-legacy"], NORTH);
    expect(back.selected).toEqual([{ provider: "north-legacy", id: "large-3" }]);
  });

  // MUTATION: return "refused" when no other provider serves the id — a
  // session whose provider lost its login stays unusable and this fails.
  it("moves a session with no usable model to the route's model, for any provider", async () => {
    const lone = await route(["south"], EAST);
    expect(lone.selected).toEqual([{ provider: "south", id: "pro-5" }]);
    expect(lone.outcome).toMatchObject({
      kind: "moved",
      from: "east/max-2",
      route: { spec: "south/pro-5", source: "only-credential", movedFrom: null },
    });
    const other = await route(["east"], SOUTH);
    expect(other.selected).toEqual([{ provider: "east", id: "max-2" }]);
    // No model at all (pi found none when it started): the route's.
    const none = await route(["east"], undefined);
    expect(none.selected).toEqual([{ provider: "east", id: "max-2" }]);
    expect(none.outcome).toMatchObject({ kind: "moved", from: null });
  });

  it("honours the remembered choice among several logins", async () => {
    const pi = fakePi(["south", "east"]);
    const outcome = await routeSessionModel(
      pi as never,
      { model: undefined, modelRegistry: registry(["south", "east"]) },
      { choice: () => ({ provider: "east", model: null, via: "use", no_estimate_ok: [] }) },
    );
    expect(pi.selected).toEqual([{ provider: "east", id: "max-2" }]);
    expect(outcome).toMatchObject({ kind: "moved", route: { source: "choice" } });
  });

  it("is refused, moving nothing, with no credential or no model the rule accepts", async () => {
    const bare = await route([], NORTH);
    expect(bare.outcome).toEqual({ kind: "refused", refusal: { code: "no-credential" } });
    expect(bare.selected).toEqual([]);
    expect((await route([], undefined)).outcome).toEqual({
      kind: "refused",
      refusal: { code: "no-credential" },
    });
    // A credential whose only model does not reason: nothing to run a review on.
    const small = [NORTH, model("south", "mini-1", { reasoning: false })];
    const weak = await route(["south"], NORTH, small);
    expect(weak.outcome).toEqual({
      kind: "refused",
      refusal: { code: "no-model", providers: ["south"] },
    });
    expect(weak.selected).toEqual([]);
  });

  it("a pi that refuses the switch leaves the session refused, not moved", async () => {
    const pi = { setModel: async () => false };
    const outcome = await routeSessionModel(pi as never, {
      model: EAST as never,
      modelRegistry: registry(["south"]),
    });
    expect(outcome).toEqual({ kind: "refused", refusal: { code: "no-credential" } });
  });

  // MUTATION: catch the registry's error as "no credential" — a pi whose
  // registry cannot be read is told to sign in and this fails.
  it("a registry that cannot be read is unknown: nothing is moved or refused", async () => {
    const broken = {
      ...registry(["south"]),
      getAvailable: () => {
        throw new Error("the registry is not ready");
      },
    };
    for (const session of [EAST, undefined]) {
      const pi = fakePi(["south"]);
      expect(
        await routeSessionModel(pi as never, { model: session as never, modelRegistry: broken }),
      ).toEqual({ kind: "unknown" });
      expect(pi.selected).toEqual([]);
    }
    expect(
      await routeSessionModel(fakePi([]) as never, {
        model: EAST as never,
        modelRegistry: undefined as never,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("says where a moved session runs, and what it left", async () => {
    const same = await route(["north"], NORTH_LEGACY);
    if (same.outcome.kind !== "moved") throw new Error("not moved");
    expect(movedLines(same.outcome)).toEqual([
      "model: large-3 runs on North: north-legacy, which the config names, has no credential here",
    ]);
    const other = await route(["south"], EAST);
    if (other.outcome.kind !== "moved") throw new Error("not moved");
    expect(movedLines(other.outcome)).toEqual([
      "east/max-2, the model this session was on, has no credential here.",
      "model: south/pro-5 (the provider pi has a credential for)",
    ]);
    const none = await route(["south"], undefined);
    if (none.outcome.kind !== "moved") throw new Error("not moved");
    expect(movedLines(none.outcome)).toEqual([
      "model: south/pro-5 (the provider pi has a credential for)",
    ]);
  });
});

/** pi's editor slot, as interactive mode drives it: an installed editor gets
 * pi's submit handler; undefined restores the default editor. */
function fakeEditorUi(o: { wiresSubmit?: boolean } = {}) {
  const submitted: string[] = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  const notes: string[] = [];
  let factory: unknown;
  let text = "";
  const ui = {
    submitted,
    widgets,
    notes,
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
    notify: (message: string) => notes.push(message),
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

  // MUTATION: write "Any OpenAI login works" back into loginHintLines — the
  // hint names a provider pi knows and this fails.
  it("the hint names no provider: any login pi offers works", () => {
    for (const opened of [true, false]) {
      const lines = loginHintLines(opened);
      expect(lines.slice(0, 3)).toEqual([
        "Quickreview needs a model login.",
        "/login lists every provider pi supports: sign in, or paste an API key.",
        "A provider key already in the environment counts too.",
      ]);
      const text = lines.join("\n").toLowerCase();
      for (const provider of getBuiltinProviders())
        expect(text, provider).not.toMatch(
          new RegExp(
            `(^|[^a-z0-9])${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
          ),
        );
      expect(text).not.toContain("chatgpt");
      expect(text).not.toContain("sk-");
    }
  });

  it("the env shim opens the menu only when asked, and never on a borrowed login", () => {
    expect(loginRouteConfigFromEnv({ QCR_LOGIN_OPEN: "submit" })).toEqual({ open: "submit" });
    expect(loginRouteConfigFromEnv({})).toEqual({ open: "prefill" });
    expect(loginRouteConfigFromEnv({ QCR_LOGIN_OPEN: "none" })).toEqual({
      open: "prefill",
      prompt: false,
    });
    expect(loginRouteConfigFromEnv({ QCR_LOGIN_OPEN: "submit" }, "/pi/agent")).toEqual({
      open: "submit",
      agentDir: "/pi/agent",
    });
  });
});

/** A pi that records its handlers, for driving the registered events. */
function eventPi(logins: string[]) {
  const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>();
  const base = fakePi(logins);
  return {
    ...base,
    handlers,
    on: (event: string, h: (e: unknown, ctx: unknown) => unknown) =>
      handlers.set(event, [...(handlers.get(event) ?? []), h]),
    emit: async (event: string, payload: unknown, ctx: unknown) => {
      let last: unknown;
      for (const h of handlers.get(event) ?? []) last = await h(payload, ctx);
      return last;
    },
  };
}

const settleSubmit = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("registerLoginRoute", () => {
  const dir = mkdtempSync(join(tmpdir(), "login-route-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a session with no login opens the login and clears the hint once a model is picked", async () => {
    const pi = eventPi([]);
    registerLoginRoute(pi as never, { open: "submit" });
    const ui = fakeEditorUi();
    const ctx = { hasUI: true, ui, model: undefined, modelRegistry: registry([]) };
    await pi.emit("session_start", {}, ctx);
    await settleSubmit();
    expect(ui.submitted).toEqual([LOGIN_COMMAND]);
    await pi.emit("model_select", {}, ctx);
    expect(ui.widgets.at(-1)).toEqual([LOGIN_WIDGET, undefined]);
  });

  it("a logged-in session shows nothing; a headless one never touches a UI", async () => {
    const pi = eventPi(["south"]);
    registerLoginRoute(pi as never, { open: "submit" });
    const ui = fakeEditorUi();
    await pi.emit(
      "session_start",
      {},
      { hasUI: true, ui, model: SOUTH_OLD, modelRegistry: registry(["south"]) },
    );
    await pi.emit(
      "session_start",
      {},
      { hasUI: false, ui, model: undefined, modelRegistry: registry([]) },
    );
    // A headless session is still routed: only its UI is left alone.
    await pi.emit(
      "session_start",
      {},
      { hasUI: false, ui, model: EAST, modelRegistry: registry(["south"]) },
    );
    expect(pi.selected).toEqual([{ provider: "south", id: "pro-5" }]);
    expect(ui.widgets).toEqual([]);
    expect(ui.submitted).toEqual([]);
    expect(ui.notes).toEqual([]);
  });

  it("routes the model before every prompt, so a login made mid-session is used, and says so", async () => {
    const pi = eventPi(["north"]);
    registerLoginRoute(pi as never, { open: "prefill" });
    const ui = fakeEditorUi();
    const result = await pi.emit(
      "input",
      { text: "hi" },
      { hasUI: true, ui, model: NORTH_LEGACY, modelRegistry: registry(["north"]) },
    );
    expect(result).toEqual({ action: "continue" });
    expect(pi.selected).toEqual([{ provider: "north", id: "large-3" }]);
    expect(ui.notes).toEqual([
      "model: large-3 runs on North: north-legacy, which the config names, has no credential here",
    ]);
    // A prompt with nothing to run on is pi's to refuse: no hint mid-session.
    const bare = eventPi([]);
    registerLoginRoute(bare as never, { open: "submit" });
    const quiet = fakeEditorUi();
    await bare.emit(
      "input",
      { text: "hi" },
      { hasUI: true, ui: quiet, model: undefined, modelRegistry: registry([]) },
    );
    await settleSubmit();
    expect([quiet.widgets, quiet.submitted, quiet.text]).toEqual([[], [], ""]);
  });

  // MUTATION: ignore `prompt` in registerLoginRoute's onRefused — /login is
  // prefilled on the borrowed copy and this fails.
  it("on a borrowed login no /login opens: the refusal is printed in its place", async () => {
    for (const open of ["submit", "prefill"] as const) {
      const pi = eventPi([]);
      registerLoginRoute(pi as never, { open, prompt: false });
      const ui = fakeEditorUi();
      const ctx = { hasUI: true, ui, model: NORTH, modelRegistry: registry([]) };
      await pi.emit("session_start", {}, ctx);
      await settleSubmit();
      expect(ui.submitted).toEqual([]);
      expect(ui.text).toBe("");
      expect(ui.widgets).toEqual([[LOGIN_WIDGET, borrowedRefusalLines({ code: "no-credential" })]]);
      await pi.emit("model_select", {}, ctx);
      expect(ui.widgets.at(-1)).toEqual([LOGIN_WIDGET, undefined]);
    }
    const text = borrowedRefusalLines({ code: "no-credential" }).join(" ");
    expect(text).toContain("pi has no model credential");
    expect(text).toContain("`qcr login`");
    expect(text).toContain("would be thrown away");
    for (const line of borrowedRefusalLines({ code: "no-model", providers: ["south", "east"] }))
      expect(line.length).toBeLessThanOrEqual(96);
  });

  it("reads the remembered choice from the agent dir it is given, and only then", async () => {
    expect(writeModelChoice(dir, { provider: "east", model: null, via: "use" })).toEqual({
      ok: true,
    });
    const logins = ["south", "east"];
    const told = eventPi(logins);
    registerLoginRoute(told as never, { open: "prefill", agentDir: dir });
    await told.emit(
      "session_start",
      {},
      { hasUI: false, model: undefined, modelRegistry: registry(logins) },
    );
    expect(told.selected).toEqual([{ provider: "east", id: "max-2" }]);
    // No agent dir in the config: no choice is read, and the order decides.
    const untold = eventPi(logins);
    registerLoginRoute(untold as never, { open: "prefill" });
    await untold.emit(
      "session_start",
      {},
      { hasUI: false, model: undefined, modelRegistry: registry(logins) },
    );
    expect(untold.selected).toEqual([{ provider: "south", id: "pro-5" }]);
  });

  it("the onboarding session registers it with the menu opened (the Boxes entry point)", async () => {
    const pi = eventPi([]);
    registerOnboardingSession(pi as never);
    expect([...pi.handlers.keys()].sort()).toEqual(["input", "model_select", "session_start"]);
    const ui = fakeEditorUi();
    await pi.emit(
      "session_start",
      {},
      { hasUI: true, ui, model: undefined, modelRegistry: registry([]) },
    );
    await settleSubmit();
    expect(ui.submitted).toEqual([LOGIN_COMMAND]);
  });
});

describe("registerModelRoute (the route step alone, as the home registers it)", () => {
  it("moves a session with no usable model and says so, with no hint of its own", async () => {
    const pi = eventPi(["south"]);
    registerModelRoute(pi as never);
    expect([...pi.handlers.keys()].sort()).toEqual(["input", "session_start"]);
    const ui = fakeEditorUi();
    await pi.emit(
      "session_start",
      {},
      { hasUI: true, ui, model: EAST, modelRegistry: registry(["south"]) },
    );
    expect(pi.selected).toEqual([{ provider: "south", id: "pro-5" }]);
    expect(ui.notes).toHaveLength(1);
    expect(ui.notes[0]).toContain("model: south/pro-5");
    expect([ui.widgets, ui.submitted, ui.text]).toEqual([[], [], ""]);
  });

  it("with no route it shows nothing: the sign-in is its host's", async () => {
    const pi = eventPi([]);
    const refused: unknown[] = [];
    registerModelRoute(pi as never, { onRefused: (_ctx, refusal) => refused.push(refusal) });
    const ui = fakeEditorUi();
    await pi.emit(
      "session_start",
      {},
      { hasUI: true, ui, model: undefined, modelRegistry: registry([]) },
    );
    await settleSubmit();
    expect(refused).toEqual([{ code: "no-credential" }]);
    expect([ui.widgets, ui.submitted, ui.text, ui.notes]).toEqual([[], [], "", []]);
  });
});

describe("the home registers the route step (extensions/home.ts)", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-route-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A home on a machine that is set up, with nothing to review: only the
   * session's model matters here. */
  const adapters = (): HomeAdapters => {
    const no = async (): Promise<{ ok: false; why: string }> => ({ ok: false, why: "not here" });
    return {
      login: { providers: async () => known(["south", "east"]) },
      github: {
        user: async () => known("octo"),
        openPulls: async () => known([]),
        openInBrowser: async () => ({ ok: true }),
      },
      repo: { repo: async () => known("acme/widgets") },
      clock: { now: () => 0 },
      reviews: {
        latest: async () => known(new Map()),
        autoRounds: async () => known(new Map()),
        preview: no,
        start: no,
        stop: no,
        post: no,
        status: async () => unknown("not here"),
        runs: async () => known([]),
        dryRun: async () => known(true),
      },
      autoReview: { status: async () => unknown("not here") },
      memory: { status: async () => unknown("not here") },
      spend: { totals: async () => unknown("not here") },
    };
  };

  async function openHome(session: Model | undefined, logins: string[], agentDir?: string) {
    const pi = fakeHomePi();
    const selected: Array<{ provider: string; id: string }> = [];
    Object.assign(pi.ctx, { model: session, modelRegistry: registry(logins) });
    Object.assign(pi.api, {
      setModel: async (m: Model) => {
        selected.push({ provider: m.provider, id: m.id });
        return true;
      },
    });
    await createHome({
      adapters: adapters(),
      model: "",
      tools: "reviewer",
      every: () => () => {},
      after: () => () => {},
      ...(agentDir !== undefined ? { agentDir } : {}),
    })(pi.api);
    await pi.start();
    return { pi, selected };
  }

  // MUTATION: drop registerModelRoute from createHome — a chat whose model has
  // no credential stays on it and this fails.
  it("a chat whose model has no credential runs on the route's model, and is told", async () => {
    const h = await openHome(EAST, ["south"]);
    expect(h.selected).toEqual([{ provider: "south", id: "pro-5" }]);
    expect(h.pi.notes.some((n) => n.includes("model: south/pro-5"))).toBe(true);
    // before every prompt too: the handler is pi's `input`
    expect(h.pi.handlers.get("input")).toHaveLength(1);
  });

  it("a chat on a model that has a credential keeps it, whatever the review would run on", async () => {
    const h = await openHome(SOUTH_OLD, ["south", "east"]);
    expect(h.selected).toEqual([]);
    expect(h.pi.notes.filter((n) => n.startsWith("model:"))).toEqual([]);
  });

  it("honours the choice remembered in the agent dir the launch names", async () => {
    expect(writeModelChoice(dir, { provider: "east", model: null, via: "use" })).toEqual({
      ok: true,
    });
    expect((await openHome(undefined, ["south", "east"], dir)).selected).toEqual([
      { provider: "east", id: "max-2" },
    ]);
    expect((await openHome(undefined, ["south", "east"])).selected).toEqual([
      { provider: "south", id: "pro-5" },
    ]);
  });
});
