// login-route — a pi that has no usable model login says so, and opens pi's
// own /login; a pi whose model names one OpenAI provider while the person
// logged in with the other runs the same model on the login that exists.
//
// Loaded by every CLI pi Quickreview starts for a person: the onboarding
// wizard (registered by extensions/onboarding.ts, which opens the login for
// the person), the companion, a takeover and a debug round (the env shim
// extensions/cli/login-route.ts, which prefills it). An SDK session needs none
// of this: PiHost routes its model the same way (packages/pi-plugin/src/engine/pisdk.ts).
//
// Three behaviours, each on pi's own API:
//   - Model route. On session_start and before every prompt (the `input`
//     event, which pi runs before it checks the model's credential), a model
//     whose provider has no credential is switched to its OpenAI twin when the
//     twin has one and serves the same id (packages/pi-plugin/src/modelroute.ts).
//     The provider the spec names always wins when its login exists, so an
//     install that works today is untouched. pi.setModel does not persist the
//     switch to settings.
//   - Login hint. When no usable model is left, a widget says exactly what to
//     do, and pi's input line holds `/login`, so one Enter opens pi's login.
//     The widget clears once a model is selected (`model_select`).
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
import { routeProvider, twinProvider } from "@quickchatai/pi-quickreview/src/modelroute.js";

/** The widget key the hint is shown under. */
export const LOGIN_WIDGET = "qcr-login";

/** The command the hint prefills and the wizard submits: pi's own login,
 * with every provider it offers. */
export const LOGIN_COMMAND = "/login";

/** What the person reads above the input line while no model is usable:
 * which logins work and how to reach them in pi's menu (pi 1.4.0's labels),
 * then how to (re)open the menu. `opened` says whether the menu is on screen. */
export function loginHintLines(opened: boolean): string[] {
  return [
    "Quickreview needs a model login before it can do anything. Any OpenAI login works:",
    '  - "Sign in with an account", then "OpenAI" (Sign in with ChatGPT) or "OpenAI Codex (legacy)";',
    '  - "Sign in with an API key", then type openai, pick "OpenAI" and paste your key (sk-...).',
    opened
      ? `pi's login menu is open below. Closed it? Type ${LOGIN_COMMAND} and press Enter.`
      : `Press Enter to open pi's login menu (${LOGIN_COMMAND} is on the input line).`,
  ];
}

/** How a pi opens the login when it needs one. */
export type LoginOpen = "submit" | "prefill";

export interface LoginRouteConfig {
  /** "submit" opens pi's login menu; "prefill" leaves `/login` on the input
   * line for one Enter. */
  open: LoginOpen;
}

/** The config the env describes: QCR_LOGIN_OPEN=submit, else prefill. */
export function loginRouteConfigFromEnv(env: NodeJS.ProcessEnv): LoginRouteConfig {
  return { open: env.QCR_LOGIN_OPEN === "submit" ? "submit" : "prefill" };
}

/** What the model route did. */
export type ModelRouteOutcome =
  /** The current model's provider has a credential. */
  | "usable"
  /** The model was moved to its OpenAI twin, whose login exists. */
  | "switched"
  /** There is a model, and neither it nor a twin has a credential. */
  | "unusable"
  /** There is no model at all. */
  | "none";

type Registry = Pick<
  ExtensionContext["modelRegistry"],
  "find" | "getAvailable" | "getProviderAuthStatus"
>;

function hasCredential(registry: Registry, provider: string): boolean {
  try {
    return registry.getProviderAuthStatus(provider).configured;
  } catch {
    return false;
  }
}

/**
 * Keep the session's model on a login that exists: the model as it is when its
 * provider has a credential, else its OpenAI twin when that has one.
 *
 * VERIFY-ON-PIN (pi 1.4.0): ModelRegistry.getProviderAuthStatus(p).configured
 * covers a stored login, a stored or runtime key and an environment key, and
 * the extension pi.setModel returns false (switching nothing) for a provider
 * without a credential.
 */
export async function routeSessionModel(
  pi: Pick<ExtensionAPI, "setModel">,
  ctx: { model: Model<Api> | undefined; modelRegistry: Registry },
): Promise<ModelRouteOutcome> {
  const model = ctx.model;
  if (!model) return "none";
  const registry = ctx.modelRegistry;
  if (hasCredential(registry, model.provider)) return "usable";
  if (twinProvider(model.provider) === undefined) return "unusable";
  const provider = routeProvider(model.provider, model.id, {
    hasCredential: (p) => hasCredential(registry, p),
    hasModel: (p, id) => registry.find(p, id) !== undefined,
  });
  if (provider === model.provider) return "unusable";
  const twin = registry.find(provider, model.id);
  if (twin && (await pi.setModel(twin))) return "switched";
  return "unusable";
}

/** Does this pi need a login: no usable model, and none pi could pick? */
export function needsLogin(outcome: ModelRouteOutcome, registry: Registry): boolean {
  if (outcome === "usable" || outcome === "switched") return false;
  if (outcome === "unusable") return true;
  try {
    return registry.getAvailable().length === 0;
  } catch {
    return true;
  }
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

/** Register the model route and the login hint on `pi`. Exported so a host that
 * builds its own onboarding extension (over `toolDefinitions`) gets the same
 * first-run login as the onboarding wizard. */
export function registerLoginRoute(pi: ExtensionAPI, config: LoginRouteConfig): void {
  if (typeof pi.on !== "function") return;
  let shown = false;
  pi.on("session_start", async (_event, ctx) => {
    const outcome = await routeSessionModel(pi, ctx);
    if (!ctx.hasUI || !needsLogin(outcome, ctx.modelRegistry)) return;
    shown = true;
    openLogin(ctx.ui, config.open);
  });
  // pi checks the model's credential after this event, so a login made inside
  // the session (its default model stays the spec's provider) is routed here.
  pi.on("input", async (_event, ctx) => {
    await routeSessionModel(pi, ctx);
    return { action: "continue" };
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
