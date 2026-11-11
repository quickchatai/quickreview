// Canary 12: pi's default model per provider, read without a deep import.
//
// VERIFY-ON-PIN: the pick rule guards its "newest version" against pi's own
// default for the provider (packages/pi-plugin/src/modelpick.ts). pi does not
// export that table, and the core may not import a file of pi's by path (a
// running pi may be a bundle). `piDefaultModelId` asks pi's root export
// `resolveCliModel` for an id no provider has and reads which model pi cloned
// for the answer. That leans on a behaviour pi does not document, so this
// canary holds it against the table itself, which a test may deep-import:
// for every built-in provider with chat models, the probe names exactly the
// id the table names, when the provider's catalog holds that id.
//
// When this fails after a pi bump, the probe reports "unread" at run time,
// the guard has no reference and a route says so; nothing refuses. Fix the
// probe, or accept the unguarded pick knowingly.
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { piDefaultModelId } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { useOfflineGuard } from "./harness.js";

useOfflineGuard();

const root = join(import.meta.dirname, "..", "..");
const { defaultModelPerProvider } = (await import(
  pathToFileURL(
    join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js"),
  ).href
)) as { defaultModelPerProvider: Record<string, string | undefined> };

const chatModels = (provider: string): Model<Api>[] =>
  getBuiltinModels(provider as Parameters<typeof getBuiltinModels>[0]) as Model<Api>[];

describe("[canary 12] pi's per-provider default, through resolveCliModel", () => {
  // MUTATION: return `{ unread: false }` for every provider from
  // piDefaultModelId — every row with a default differs and this fails.
  it("names the table's id for every built-in provider with chat models", () => {
    const providers = [...getBuiltinProviders()].sort().filter((p) => chatModels(p).length > 0);
    // The table is not empty and not a stranger to the catalog: most providers have a row.
    expect(providers.length).toBeGreaterThan(20);
    const read = Object.fromEntries(
      providers.map((p) => [p, piDefaultModelId(p, chatModels(p))] as const),
    );
    const table = Object.fromEntries(
      providers.map((p) => {
        const id = defaultModelPerProvider[p];
        const held = id !== undefined && chatModels(p).some((m) => m.id === id);
        return [p, held ? { id, unread: false } : { unread: false }] as const;
      }),
    );
    expect(read).toEqual(table);
    expect(Object.values(table).filter((row) => "id" in row).length).toBeGreaterThan(20);
  });

  it("is the same whatever order the provider's models come in", () => {
    for (const p of getBuiltinProviders()) {
      const models = chatModels(p);
      if (models.length < 2) continue;
      expect(piDefaultModelId(p, [...models].reverse()), p).toEqual(piDefaultModelId(p, models));
    }
  });

  // A provider pi names no default for (a custom `models.json` provider) is
  // normal: no id, and not "unread". pi falls back to the provider's first
  // model there, which the probe must not take for a default, even when the
  // provider has only one model.
  it("names no default, and is not unread, for a provider outside pi's table", () => {
    const base = chatModels("deepseek")[0]!;
    const one = [{ ...base, provider: "qcr-canary-custom", id: "only" }];
    const two = [...one, { ...base, provider: "qcr-canary-custom", id: "other" }];
    expect(piDefaultModelId("qcr-canary-custom", one)).toEqual({ unread: false });
    expect(piDefaultModelId("qcr-canary-custom", two)).toEqual({ unread: false });
    expect(piDefaultModelId("qcr-canary-custom", [])).toEqual({ unread: false });
  });

  it("does not change the models it is handed", () => {
    const models = chatModels("deepseek");
    const before = JSON.stringify(models);
    piDefaultModelId("deepseek", models);
    expect(JSON.stringify(models)).toBe(before);
    expect(Object.getOwnPropertySymbols(models[0]!)).toEqual([]);
  });
});
