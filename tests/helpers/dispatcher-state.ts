// Saves and restores the process-global HTTP state a dispatcher test changes:
// undici's global dispatcher, fetch, PiHost's own marker, PI_CODING_AGENT and the process title.
// Test files get their own worker, but tests inside one file share it, so each
// starts from "no dispatcher installed by PiHost, not inside a CLI pi", which
// means Node's own default dispatcher. Node creates that lazily on the first
// fetch and fails any fetch when the slot is left empty, so `prime()` makes one
// before the first test and `reset()` puts it back.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { UNDICI_GLOBAL_DISPATCHER } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";

const INSTALLED_BY_PIHOST = Symbol.for("qcr.pisdk.dispatcher");
/** undici 8 keeps the real dispatcher in slot 2 and a v1 wrapper of it in slot 1. */
const UNDICI_SLOT_2 = Symbol.for("undici.globalDispatcher.2");

export interface DispatcherState {
  /** Make Node create its default dispatcher (one loopback fetch), then record
   * the process's state. Call from beforeAll, after the offline guard's. */
  prime(): Promise<void>;
  reset(): void;
  restore(): void;
}

export function saveDispatcherState(): DispatcherState {
  const g = globalThis as Record<symbol, unknown>;
  let saved:
    | {
        slot1: unknown;
        slot2: unknown;
        marker: unknown;
        fetch: typeof fetch;
        cli?: string;
        title: string;
      }
    | undefined;
  const need = (): NonNullable<typeof saved> => {
    if (!saved) throw new Error("call prime() in beforeAll first");
    return saved;
  };
  return {
    async prime() {
      const server = createServer((_req, res) => res.end("ok"));
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      try {
        await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text();
      } finally {
        server.closeAllConnections();
        server.close();
      }
      saved = {
        slot1: g[UNDICI_GLOBAL_DISPATCHER],
        slot2: g[UNDICI_SLOT_2],
        marker: g[INSTALLED_BY_PIHOST],
        fetch: globalThis.fetch,
        cli: process.env["PI_CODING_AGENT"],
        title: process.title,
      };
    },
    reset() {
      const s = need();
      g[UNDICI_GLOBAL_DISPATCHER] = s.slot1;
      g[UNDICI_SLOT_2] = s.slot2;
      g[INSTALLED_BY_PIHOST] = undefined;
      globalThis.fetch = s.fetch;
      delete process.env["PI_CODING_AGENT"];
      process.title = s.title;
    },
    restore() {
      const s = need();
      g[UNDICI_GLOBAL_DISPATCHER] = s.slot1;
      g[UNDICI_SLOT_2] = s.slot2;
      g[INSTALLED_BY_PIHOST] = s.marker;
      globalThis.fetch = s.fetch;
      if (s.cli === undefined) delete process.env["PI_CODING_AGENT"];
      else process.env["PI_CODING_AGENT"] = s.cli;
      process.title = s.title;
    },
  };
}
