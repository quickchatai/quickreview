// Factory parity (Phase 3): an extension's default export (the env shim) and
// its `createX(config)` factory must leave pi in the same state. Both run
// through pi's own extension loader, so what is compared is what pi records:
// the event handlers, tools, commands, flags and shortcuts an extension
// registered. Functions cannot be compared, so a case may add a `probe` that
// calls the registered tools (and handlers) and compares what comes back, and
// `resolved` to compare the config each side resolves.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DefaultResourceLoader,
  SettingsManager,
  type Extension,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export interface ParityCase<C> {
  /** Absolute path of the extension file, its default export being the shim. */
  shimPath: string;
  /** The env the shim reads; `undefined` unsets a name. */
  env: Record<string, string | undefined>;
  /** The config the factory is built from. */
  config: C;
  factory: (config: C) => ExtensionFactory;
  /** The resolved config each side ends up with, when the extension has one. */
  resolved?: { fromEnv: (env: NodeJS.ProcessEnv) => unknown; fromConfig: (config: C) => unknown };
  /** Drives the registered extension and returns something comparable. */
  probe?: (ext: Extension) => Promise<unknown>;
}

/** What pi recorded for one loaded extension, minus functions and paths. */
export interface Registration {
  events: Record<string, number>;
  tools: unknown[];
  commands: unknown[];
  flags: unknown[];
  shortcuts: string[];
}

const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

export function registrationOf(ext: Extension): Registration {
  const byName = <T>(m: Map<string, T>) => [...m.keys()].sort();
  return {
    events: Object.fromEntries(
      [...ext.handlers]
        .map(([k, v]) => [k, v.length] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    tools: byName(ext.tools).map((n) => {
      const {
        execute: _e,
        renderCall: _c,
        renderResult: _r,
        ...rest
      } = ext.tools.get(n)!.definition;
      return plain(rest);
    }),
    commands: byName(ext.commands).map((n) => {
      const c = ext.commands.get(n)!;
      return plain({ name: c.name, description: c.description });
    }),
    flags: byName(ext.flags).map((n) => plain(ext.flags.get(n))),
    shortcuts: byName(ext.shortcuts),
  };
}

/** Run `fn` with `env` applied to process.env, then put every touched name back. */
export async function withEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export interface Loaded {
  registration: Registration;
  resolved: unknown;
  probe: unknown;
}

/** Loads exactly one extension through pi's resource loader: nothing is
 * discovered from the (empty, throwaway) cwd and agent dir. */
async function loadOne(
  source: { path: string } | { factory: ExtensionFactory },
): Promise<Extension> {
  const dir = mkdtempSync(join(tmpdir(), "qcr-parity-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...("path" in source
        ? { additionalExtensionPaths: [source.path] }
        : { extensionFactories: [source.factory] }),
    });
    await loader.reload();
    const res = loader.getExtensions();
    if (res.errors.length)
      throw new Error(`extension failed to load: ${JSON.stringify(res.errors)}`);
    if (res.extensions.length !== 1)
      throw new Error(`expected 1 extension, got ${res.extensions.length}`);
    return res.extensions[0]!;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The shim, loaded from its file by pi's loader with `env` in place. */
export async function loadShim<C>(c: ParityCase<C>): Promise<Loaded> {
  return withEnv(c.env, async () => {
    const ext = await loadOne({ path: c.shimPath });
    return {
      registration: registrationOf(ext),
      resolved: plain(c.resolved?.fromEnv(process.env)),
      probe: plain(await c.probe?.(ext)),
    };
  });
}

/** The factory, built from `config` and loaded inline. */
export async function loadFactory<C>(c: ParityCase<C>): Promise<Loaded> {
  const ext = await loadOne({ factory: c.factory(c.config) });
  return {
    registration: registrationOf(ext),
    resolved: plain(c.resolved?.fromConfig(c.config)),
    probe: plain(await c.probe?.(ext)),
  };
}
