// pi's own device-code login, for the home's setup checklist
// (src/home/setup.ts): the same login pi's /login runs, on the pi the chat
// runs in, so the credential lands where pi keeps it (its auth file, under
// its own lock) and the chat can use it at once, with no restart.
//
// pi 1.4.0 runs a login through its model runtime, `runtime.login(provider,
// "oauth", interaction)`, which drives the provider's own flow and then
// stores the credential. An extension reaches that runtime as
// `ctx.modelRegistry.runtime`: the registry is the facade pi hands
// extensions, and the plugin already reaches its runtime for a refresh
// (packages/pi-plugin/extensions/quickreview.ts hostAuth). VERIFY-ON-PIN: the
// field and the method are pi's internals, so a pi without them makes this
// port answer "unavailable", and the card points at pi's own /login instead.
//
// The openai-codex flow first asks which method: the interaction answers it
// with the device-code option, so the code appears with no prompt. Any other
// question pi's flow asks is refused, with /login named for it.
import type { DeviceCode, DeviceLoginPort, LoginFailureKind, LoginOutcome } from "./setup.js";

/** pi's login interaction, by the shape pi 1.4.0 hands a provider's flow. */
interface AuthPrompt {
  type: string;
  message?: string;
  options?: ReadonlyArray<{ id: string; label?: string }>;
}
type AuthEvent =
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: string; message?: string };

interface LoginRuntime {
  login(
    provider: string,
    type: "oauth",
    interaction: {
      signal: AbortSignal;
      prompt(p: AuthPrompt): Promise<string>;
      notify(e: AuthEvent): void;
    },
  ): Promise<unknown>;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A device login that ended in an error, as a person reads it. */
export function loginFailure(
  err: unknown,
  aborted: boolean,
): {
  kind: LoginFailureKind;
  why: string;
} {
  const why = message(err);
  if (aborted || /login cancelled/i.test(why)) return { kind: "cancelled", why };
  if (/timed out|expired|expir/i.test(why)) return { kind: "expired", why };
  if (/not enabled/i.test(why)) return { kind: "not_enabled", why };
  if (/denied|rejected|declined|access_denied/i.test(why)) return { kind: "denied", why };
  return { kind: "failed", why };
}

/** The runtime behind pi's registry facade, when this pi has one. */
function runtimeOf(registry: unknown): LoginRuntime | null {
  const runtime = (registry as { runtime?: { login?: unknown } } | null | undefined)?.runtime;
  return typeof runtime?.login === "function" ? (runtime as LoginRuntime) : null;
}

/** The device login of the pi whose `ctx.modelRegistry` is `registry`. */
export function piDeviceLogin(registry: unknown): DeviceLoginPort {
  return {
    login: async ({ provider, signal, onCode }): Promise<LoginOutcome> => {
      const runtime = runtimeOf(registry);
      if (runtime === null)
        return {
          ok: false,
          kind: "unavailable",
          why: "this pi offers no device login to the home: type /login to sign in with pi's own menu",
        };
      try {
        await runtime.login(provider, "oauth", {
          signal,
          prompt: async (p) => {
            const device =
              p.type === "select" ? p.options?.find((o) => /device/i.test(o.id)) : undefined;
            if (device) return device.id;
            throw new Error(
              `pi's login asked "${p.message ?? p.type}", which the home does not answer: type /login to sign in with pi's own menu`,
            );
          },
          notify: (e) => {
            if (e.type === "device_code" && "userCode" in e) {
              const code: DeviceCode = {
                userCode: e.userCode,
                verificationUri: e.verificationUri,
                ...(e.expiresInSeconds !== undefined
                  ? { expiresInSeconds: e.expiresInSeconds }
                  : {}),
              };
              onCode(code);
            }
          },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, ...loginFailure(err, signal.aborted) };
      }
    },
  };
}
