import { createHash } from "node:crypto";
import type { FileOutcome } from "./improvements.js";
import type { StateStore } from "./state.js";

/** Only the watcher supplies delivery identity; payload bytes bind its meaning. */
export function commandEffectKey(
  kind: string,
  deliveryKey: string | undefined,
  payload: unknown,
): string | undefined {
  return deliveryKey
    ? createHash("sha256")
        .update(JSON.stringify([kind, deliveryKey, payload]))
        .digest("hex")
    : undefined;
}

function previous(result: string | null): FileOutcome {
  return result === null
    ? {
        ok: false,
        reason:
          "command outcome unknown after interrupted delivery; submit a fresh command to retry",
      }
    : (JSON.parse(result) as FileOutcome);
}

/** A bounded grant, its charge, and its accepted result commit together. */
export function atomicCommandEffect(
  store: StateStore,
  key: string | undefined,
  perform: () => FileOutcome,
): FileOutcome {
  return store.db.transaction(() => {
    if (key) {
      const receipt = store.commandEffectReceipt(key);
      if (receipt) return previous(receipt.result);
      store.reserveCommandEffect(key);
    }
    const outcome = perform();
    if (key) store.settleCommandEffect(key, outcome);
    return outcome;
  })();
}

/** Never replay an uncertain process mutation against a replacement session. */
export async function asyncCommandEffect(
  store: StateStore,
  key: string | undefined,
  perform: () => Promise<FileOutcome>,
): Promise<FileOutcome> {
  if (!key) return perform();
  if (!store.reserveCommandEffect(key)) return previous(store.commandEffectReceipt(key)!.result);
  const outcome = await perform();
  store.settleCommandEffect(key, outcome);
  return outcome;
}
