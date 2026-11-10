// pi-ai's faux provider prices every message at zero (it replaces the usage of
// whatever it is scripted with), so a test of the dollar cap or the spend cannot
// use it as it is. This wraps one so each finished assistant message carries a
// price the test chooses, the way a real provider's final message carries its
// cost. Nothing else about the faux changes.
//
// It also holds the one faux model a route can land on (`ROUTABLE_FAUX_MODEL`),
// for the tests whose sessions name no model.
import {
  createAssistantMessageEventStream,
  fauxProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type FauxModelDefinition,
  type FauxProviderHandle,
  type RegisterFauxProviderOptions,
} from "@earendil-works/pi-ai";

function priced(
  inner: AssistantMessageEventStream,
  price: (message: AssistantMessage) => number,
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream();
  void (async () => {
    for await (const event of inner) {
      // The message is built per response, so its usage object is the response's own.
      if (event.type === "done") event.message.usage.cost.total = price(event.message);
      out.push(event);
    }
    out.end(await inner.result());
  })();
  return out;
}

/** A faux model the pick rule accepts (packages/pi-plugin/src/modelpick.ts):
 * it reasons, and a review fits its window. pi-ai's own faux model does not
 * reason, so a host whose only provider is a plain faux has no route. A test
 * that reaches a session with no model of its own registers this one. */
export const ROUTABLE_FAUX_MODEL: FauxModelDefinition = {
  id: "faux-reasoner-1",
  name: "Faux Reasoner 1",
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 16_384,
};

/** Faux provider options with the routable model first, so `getModel()` (the
 * provider's first model) is the one an unpinned session runs on. Models the
 * caller lists come after it. */
export function routableFauxOptions(
  options: RegisterFauxProviderOptions = {},
): RegisterFauxProviderOptions {
  return { ...options, models: [ROUTABLE_FAUX_MODEL, ...(options.models ?? [])] };
}

/** A faux provider whose first model the pick rule accepts. */
export function routableFaux(options?: RegisterFauxProviderOptions): FauxProviderHandle {
  return fauxProvider(routableFauxOptions(options));
}

export interface PricedFauxOptions extends RegisterFauxProviderOptions {
  /** Put `ROUTABLE_FAUX_MODEL` first: for a test whose sessions name no model. */
  routable?: boolean;
}

export function pricedFaux(
  price: (message: AssistantMessage) => number,
  options: PricedFauxOptions = {},
): FauxProviderHandle {
  const { routable, ...fauxOptions } = options;
  const faux = fauxProvider(routable === true ? routableFauxOptions(fauxOptions) : fauxOptions);
  const provider = {
    ...faux.provider,
    stream: (...a: Parameters<typeof faux.provider.stream>) =>
      priced(faux.provider.stream(...a), price),
    streamSimple: (...a: Parameters<typeof faux.provider.streamSimple>) =>
      priced(faux.provider.streamSimple(...a), price),
  } as typeof faux.provider;
  return { ...faux, provider };
}
