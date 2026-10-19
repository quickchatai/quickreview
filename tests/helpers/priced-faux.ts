// pi-ai's faux provider prices every message at zero (it replaces the usage of
// whatever it is scripted with), so a test of the dollar cap or the spend cannot
// use it as it is. This wraps one so each finished assistant message carries a
// price the test chooses, the way a real provider's final message carries its
// cost. Nothing else about the faux changes.
import {
  createAssistantMessageEventStream,
  fauxProvider,
  type AssistantMessage,
  type AssistantMessageEventStream,
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

export function pricedFaux(
  price: (message: AssistantMessage) => number,
  options?: RegisterFauxProviderOptions,
): FauxProviderHandle {
  const faux = fauxProvider(options);
  const provider = {
    ...faux.provider,
    stream: (...a: Parameters<typeof faux.provider.stream>) =>
      priced(faux.provider.stream(...a), price),
    streamSimple: (...a: Parameters<typeof faux.provider.streamSimple>) =>
      priced(faux.provider.streamSimple(...a), price),
  } as typeof faux.provider;
  return { ...faux, provider };
}
