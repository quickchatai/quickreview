// login-route — a CLI pi keeps the model it started on while that model has a
// credential, runs on the review's route when it has none, and says how to
// sign in when there is no route at all.
//
// Loaded by every CLI pi Quickreview starts for a person: the onboarding
// wizard (registered by extensions/onboarding.ts, which opens the login for
// the person), the home (extensions/home.ts registers the route step alone:
// its setup card owns the sign-in), the companion, a takeover and a debug
// round (the env shim extensions/cli/login-route.ts). An SDK session needs
// none of this: PiHost resolves its own route (packages/pi-plugin/src/engine/pisdk.ts).
//
// Three behaviours, each on pi's own API:
//   - Model route. On session_start and before every prompt (the `input`
//     event, which pi runs before it checks the model's credential), a session
//     whose model has a credential is left alone: pi's own saved default, the
//     model a resumed session last ran on, or the model its launcher pinned.
//     A session with no usable model is moved by the rule every review route
//     uses (packages/pi-plugin/src/modelroute.ts `resolveRoute`), over pi's
//     own registry: first the model it names on another provider that serves
//     the same id, else the route's model. pi.setModel does not persist the
//     move to settings, and the person is told once where the session runs.
//   - Login hint. When there is no route, a widget says what to do, and pi's
//     input line holds `/login`, so one Enter opens pi's login. The widget
//     clears once a model is selected (`model_select`). A pi that runs over a
//     borrowed copy of a login (`prompt: false`: a takeover, a debug round) is
//     told why there is no model and where to sign in instead: a login made
//     there would be thrown away with the copy.
//   - Open (the wizard only). pi runs `/login` only from its editor's submit
//     (an extension cannot call the command), and the one public way to reach
//     that submit is an editor component: pi wires its own submit handler
//     onto every editor an extension installs. So the login is opened by
//     installing a stock CustomEditor for an instant, submitting `/login`
//     through the handler pi gave it, and restoring the editor that was there.
//     When that wiring is not found, the prefilled `/login` is the fallback.
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  registryInventory,
  textResolver,
  type RouteRegistry,
} from "@quickchatai/pi-quickreview/extensions/route-registry.js";
import { readModelChoice } from "@quickchatai/pi-quickreview/src/modelchoice.js";
import {
  refusalText,
  resolveRoute,
  routeNoticeLines,
  type ModelChoice,
  type ModelRoute,
  type ProviderInventory,
  type RouteInput,
  type RouteRefusal,
} from "@quickchatai/pi-quickreview/src/modelroute.js";

/** The widget key the hint is shown under. */
export const LOGIN_WIDGET = "qcr-login";

/** The command the hint prefills and the wizard submits: pi's own login,
 * with every provider it offers. */
export const LOGIN_COMMAND = "/login";

/** What the person reads above the input line while there is no model to run
 * on: that any provider's login works, then how to (re)open pi's menu.
 * `opened` says whether the menu is on screen. */
export function loginHintLines(opened: boolean): string[] {
  return [
    "Quickreview needs a model login.",
    `${LOGIN_COMMAND} lists every provider pi supports: sign in, or paste an API key.`,
    "A provider key already in the environment counts too.",
    opened
      ? `pi's login menu is open below. Closed it? Type ${LOGIN_COMMAND} and press Enter.`
      : `Press Enter to open pi's login menu (${LOGIN_COMMAND} is on the input line).`,
  ];
}

/** The widest line the refusal widget writes. */
const REFUSAL_WIDTH = 96;

/** `text` in lines no wider than `width`, broken at spaces. */
function wrapped(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w !== "")) {
    if (line !== "" && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === "" ? word : `${line} ${word}`;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** What a pi on a borrowed copy of a login reads when it has no model to run
 * on: why, in the words every surface uses for that refusal
 * (modelroute.ts `refusalText`), and that pi's own login is not the way here. */
export function borrowedRefusalLines(refusal: RouteRefusal): string[] {
  return [
    ...wrapped(`No model for this session: ${refusalText(refusal, "app")}`, REFUSAL_WIDTH),
    ...wrapped(
      `This pi runs on a copy of the login, so a sign-in made here with ${LOGIN_COMMAND} would be thrown away with it.`,
      REFUSAL_WIDTH,
    ),
  ];
}

/** How a pi opens the login when it needs one. */
export type LoginOpen = "submit" | "prefill";

export interface LoginRouteConfig {
  /** "submit" opens pi's login menu; "prefill" leaves `/login` on the input
   * line for one Enter. */
  open: LoginOpen;
  /** False for a pi that runs over a borrowed copy of a login (a takeover, a
   * debug round): with no model to run on it prints the refusal and neither
   * opens nor prefills `/login`. Omitted: true. */
  prompt?: boolean;
  /** The pi agent dir whose remembered model choice the route honours
   * (packages/pi-plugin/src/modelchoice.ts). Omitted: no choice is read. */
  agentDir?: string;
}

/** The config the env describes: QCR_LOGIN_OPEN=submit opens the menu, =none
 * is a pi on a borrowed login (no prompt at all), anything else prefills.
 * `agentDir` is the running pi's own agent dir, which its shim knows. */
export function loginRouteConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  agentDir?: string,
): LoginRouteConfig {
  const open = env["QCR_LOGIN_OPEN"];
  return {
    open: open === "submit" ? "submit" : "prefill",
    ...(open === "none" ? { prompt: false } : {}),
    ...(agentDir !== undefined ? { agentDir } : {}),
  };
}

/** What the model route did. */
export type ModelRouteOutcome =
  /** The session's model has a credential: it is kept. */
  | { kind: "usable" }
  /** The session had no usable model and now runs on `route`. `from` is the
   * `provider/id` it was on, or null when it had none. */
  | { kind: "moved"; route: ModelRoute; from: string | null }
  /** There is no model to run on, and why. */
  | { kind: "refused"; refusal: RouteRefusal }
  /** pi's registry could not be read: nothing is moved and nothing is said. */
  | { kind: "unknown" };

/** What the route reads of pi's registry: the inventory's facade, and the
 * lookup that gives `pi.setModel` its model. */
type Registry = RouteRegistry & Pick<ExtensionContext["modelRegistry"], "find">;

export interface ModelRouteOptions {
  /** The remembered choice, read only when a route is needed. Omitted: none. */
  choice?: () => ModelChoice | undefined;
}

/**
 * Keep the session on a model that has a credential: the one it is on when
 * its provider has one, else the route's.
 *
 * A session's model with no credential is first asked for as a pin, which is
 * what it is (pi itself starts only on a model it has a credential for, so a
 * model without one was named by the launcher from the config): the rule moves
 * it to another credentialed provider that serves the same id, when that is
 * not a guess. Where it cannot, and for a session with no model at all, the
 * route is resolved with nothing pinned.
 *
 * VERIFY-ON-PIN (pi 1.4.0): ModelRegistry.getAvailable() lists a provider's
 * models only when the provider has a credential (a stored login, a stored or
 * runtime key, an environment key), and the extension pi.setModel returns
 * false, switching nothing, for a provider without one.
 */
export async function routeSessionModel(
  pi: Pick<ExtensionAPI, "setModel">,
  ctx: { model: Model<Api> | undefined; modelRegistry: Registry },
  o: ModelRouteOptions = {},
): Promise<ModelRouteOutcome> {
  const model = ctx.model;
  const registry = ctx.modelRegistry;
  let inventory: ProviderInventory[] | undefined;
  try {
    if (model !== undefined && registry.getAvailable().some((m) => m.provider === model.provider))
      return { kind: "usable" };
    inventory = registryInventory(registry);
  } catch {
    return { kind: "unknown" };
  }
  if (inventory.length === 0) return { kind: "refused", refusal: { code: "no-credential" } };

  // The route carries ids, not models: pi's object for an id its catalog
  // does not hold (a stated choice of a custom id) is kept for setModel.
  const custom = new Map<string, Model<Api>>();
  const parse = textResolver(registry);
  const resolveText: RouteInput["resolveText"] = (text) => {
    const r = parse(text);
    if (r.model !== undefined && r.custom === true)
      custom.set(`${r.model.provider}/${r.model.id}`, r.model as Model<Api>);
    return r;
  };
  const choice = o.choice?.();
  const input: RouteInput = {
    inventory,
    skipped: [],
    resolveText,
    ...(choice !== undefined ? { choice } : {}),
  };
  const from = model !== undefined ? `${model.provider}/${model.id}` : null;
  let result = resolveRoute(input);
  if (model !== undefined && from !== null) {
    const same = resolveRoute({ ...input, pin: { text: from, from: "config" } });
    if (same.ok && same.route.modelId === model.id) result = same;
  }
  if (!result.ok) return { kind: "refused", refusal: result.refusal };
  const route = result.route;
  const target = registry.find(route.provider, route.modelId) ?? custom.get(route.spec);
  if (target === undefined || !(await pi.setModel(target)))
    return { kind: "refused", refusal: { code: "no-credential" } };
  return { kind: "moved", route, from };
}

/** What a session that was moved is told, once: the line every surface uses
 * to name a route and why (modelroute.ts `routeNoticeLines`), after the model
 * it left when the route names another. */
export function movedLines(moved: { route: ModelRoute; from: string | null }): string[] {
  const lines = routeNoticeLines(moved.route, "app");
  return moved.from !== null && moved.route.movedFrom === null
    ? [`${moved.from}, the model this session was on, has no credential here.`, ...lines]
    : lines;
}

type EditorUi = Pick<ExtensionUIContext, "setEditorComponent" | "getEditorComponent">;
type MakeEditor = Parameters<ExtensionUIContext["setEditorComponent"]>[0] & {};

/**
 * Submit `text` through pi's own editor submit, as if typed and Entered. pi
 * runs its built-in commands (`/login` among them) only from that handler, and
 * hands it to every editor component an extension installs: so a stock editor
 * is installed, its handler taken, and the previous editor (pi's default, or
 * another extension's) restored before anything renders. Returns false, having
 * submitted nothing, when pi did not wire a handler.
 *
 * VERIFY-ON-PIN (pi 1.4.0, interactive-mode.js setCustomEditorComponent):
 * `newEditor.onSubmit = this.defaultEditor.onSubmit` runs synchronously inside
 * setEditorComponent, and setEditorComponent(undefined) restores the default
 * editor with its text.
 */
export function submitThroughEditor(
  ui: EditorUi,
  text: string,
  makeEditor: MakeEditor = (tui, theme, keybindings) => new CustomEditor(tui, theme, keybindings),
): boolean {
  let made: { onSubmit?: (text: string) => void } | undefined;
  const previous = ui.getEditorComponent();
  try {
    ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = makeEditor(tui, theme, keybindings);
      made = editor;
      return editor;
    });
  } catch {
    made = undefined;
  }
  const submit = made?.onSubmit;
  ui.setEditorComponent(previous);
  if (typeof submit !== "function") return false;
  void Promise.resolve()
    .then(() => submit(text))
    .catch(() => undefined);
  return true;
}

type HintUi = Pick<ExtensionUIContext, "setWidget" | "setEditorText"> & EditorUi;

/** Show the hint and open (or prefill) pi's login. Returns how it was opened. */
export function openLogin(ui: HintUi, open: LoginOpen): "submitted" | "prefilled" {
  if (open === "submit" && submitThroughEditor(ui, LOGIN_COMMAND)) {
    ui.setWidget(LOGIN_WIDGET, loginHintLines(true), { placement: "aboveEditor" });
    return "submitted";
  }
  ui.setWidget(LOGIN_WIDGET, loginHintLines(false), { placement: "aboveEditor" });
  ui.setEditorText(LOGIN_COMMAND);
  return "prefilled";
}

export interface ModelRouteStep extends ModelRouteOptions {
  /** Told when a session starts with no model to run on. Omitted: nothing is said. */
  onRefused?: (ctx: ExtensionContext, refusal: RouteRefusal) => void;
  /** Told of every prompt before it is routed: its text, and where it came
   * from (pi's `input` event). A host that opened pi's login for the person
   * learns here that they are back at the editor. Omitted: nothing is told. */
  onInput?: (input: { text: string; source: string }) => void;
}

/**
 * The route step alone: a session with no usable model is moved to the
 * route's, at its start and before every prompt, and told where it runs. A
 * host with a sign-in of its own (the home's setup card) registers this and
 * no hint.
 */
export function registerModelRoute(pi: ExtensionAPI, step: ModelRouteStep = {}): void {
  if (typeof pi.on !== "function") return;
  const apply = async (ctx: ExtensionContext): Promise<ModelRouteOutcome> => {
    const outcome = await routeSessionModel(pi, ctx, step);
    if (outcome.kind === "moved" && ctx.hasUI)
      ctx.ui.notify(movedLines(outcome).join("\n"), "info");
    return outcome;
  };
  pi.on("session_start", async (_event, ctx) => {
    const outcome = await apply(ctx);
    if (outcome.kind === "refused") step.onRefused?.(ctx, outcome.refusal);
  });
  // pi checks the model's credential after this event, so a login made inside
  // the session is routed here before its first prompt.
  pi.on("input", async (event, ctx) => {
    step.onInput?.({ text: event.text, source: event.source });
    await apply(ctx);
    return { action: "continue" };
  });
}

/** Register the model route and the login hint on `pi`. Exported so a host that
 * builds its own onboarding extension (over `toolDefinitions`) gets the same
 * first-run login as the onboarding wizard. */
export function registerLoginRoute(pi: ExtensionAPI, config: LoginRouteConfig): void {
  if (typeof pi.on !== "function") return;
  const agentDir = config.agentDir;
  let shown = false;
  registerModelRoute(pi, {
    ...(agentDir !== undefined ? { choice: () => readModelChoice(agentDir).choice } : {}),
    onRefused: (ctx, refusal) => {
      if (!ctx.hasUI) return;
      shown = true;
      if (config.prompt === false)
        ctx.ui.setWidget(LOGIN_WIDGET, borrowedRefusalLines(refusal), {
          placement: "aboveEditor",
        });
      else openLogin(ctx.ui, config.open);
    },
  });
  pi.on("model_select", (_event, ctx) => {
    if (!shown || !ctx.hasUI) return;
    shown = false;
    ctx.ui.setWidget(LOGIN_WIDGET, undefined);
  });
}

/** The factory, for a pi that loads the route by path (its shim) or a host
 * that composes factories. */
export function createLoginRoute(config: LoginRouteConfig): ExtensionFactory {
  return (pi) => registerLoginRoute(pi, config);
}
