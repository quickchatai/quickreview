// `qcr scan login`'s login, run inside the companion image (`docker exec` into
// the running companion, or a throwaway container over its pi home volume):
// straight into pi's own OAuth login for one provider — the
// `modelRuntime.login(provider, "oauth", { signal, prompt, notify },
// { getDeviceId })` call pi's interactive /login makes — over the terminal
// instead of pi's TUI. The URL or device code pi sends is printed, a prompt is
// answered from the terminal, and the credential is written by pi's own
// runtime into the pi home's auth.json (pi's file storage, under its lock).
// Then `pi auth check --provider <p> --json` verifies it, and the token's life
// is printed. pi has no login command of its own (`pi auth` only prints and
// checks), and a "/login" initial message goes to the model, not to pi's
// command handler, hence this script.
//
// pi is imported from its global install (the image's pinned package); the
// run's flow (`piLogin`) takes the runtime, the terminal and the check as
// ports.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

/** pi's login prompt (pi-ai `AuthPrompt`). */
export type LoginPrompt = { signal?: AbortSignal } & (
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | {
      type: "select";
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    }
);

/** pi's login event (pi-ai `AuthEvent`). */
export type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

export interface LoginInteraction {
  signal?: AbortSignal;
  prompt(prompt: LoginPrompt): Promise<string>;
  notify(event: LoginEvent): void;
}

/** The part of pi's `ModelRuntime` a login needs. */
export interface LoginRuntime {
  login(
    providerId: string,
    type: "oauth",
    interaction: LoginInteraction,
    options?: { getDeviceId?: () => string },
  ): Promise<unknown>;
}

export interface LoginIo {
  out(line: string): void;
  ask(question: string, o: { secret: boolean; signal?: AbortSignal }): Promise<string>;
}

/** `pi auth check --json`'s answer. */
export interface AuthCheckResult {
  status: string;
  provider?: string;
  reason?: string;
  authType?: string;
}

/** The provider a model spec logs in to; openai-codex when none is named. */
export function loginProvider(model: string): string {
  const p = model.trim().split("/")[0] ?? "";
  return model.includes("/") && p !== "" ? p : "openai-codex";
}

export function parseLoginArgs(argv: readonly string[]): { provider: string } {
  const i = argv.indexOf("--provider");
  const provider = i >= 0 ? argv[i + 1]?.trim() : undefined;
  if (!provider) throw new Error("usage: scanlogin.js --provider <provider>");
  return { provider };
}

function lifeOf(expires: number, now: number): string {
  const ms = expires - now;
  if (ms <= 0) return "expired";
  const m = Math.floor(ms / 60_000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m % 60}m`;
}

function eventLines(e: LoginEvent): string[] {
  switch (e.type) {
    case "auth_url":
      return [
        ...(e.instructions ? [e.instructions] : []),
        "Open this address in a browser:",
        `  ${e.url}`,
      ];
    case "device_code":
      return [
        `Open ${e.verificationUri} and enter the code ${e.userCode}`,
        "Waiting for authentication…",
      ];
    case "info":
      return [
        e.message,
        ...(e.links ?? []).map((l) => `  ${l.label ? `${l.label}: ` : ""}${l.url}`),
      ];
    case "progress":
      return [e.message];
  }
}

/** Log in to `provider` through pi's runtime, then verify with `check`.
 * Never prints a token. Exit code: 0 logged in and ready, else 1. */
export async function piLogin(o: {
  runtime: LoginRuntime;
  provider: string;
  io: LoginIo;
  getDeviceId: () => string;
  check: (provider: string) => Promise<AuthCheckResult>;
  now?: () => number;
  signal?: AbortSignal;
}): Promise<number> {
  const { io } = o;
  io.out(`Logging pi in to ${o.provider}…`);
  const interaction: LoginInteraction = {
    ...(o.signal ? { signal: o.signal } : {}),
    notify: (e) => {
      for (const l of eventLines(e)) io.out(l);
    },
    prompt: async (p) => {
      const signal = p.signal;
      if (p.type === "select") {
        io.out(p.message);
        p.options.forEach((opt, i) =>
          io.out(`  ${i + 1}. ${opt.label}${opt.description ? ` — ${opt.description}` : ""}`),
        );
        const a = (
          await io.ask(`Choose 1-${p.options.length}: `, {
            secret: false,
            ...(signal ? { signal } : {}),
          })
        ).trim();
        const byNumber = p.options[Number(a) - 1];
        const chosen = byNumber ?? p.options.find((x) => x.id === a);
        if (!chosen) throw new Error("Login cancelled");
        return chosen.id;
      }
      return io.ask(p.message, { secret: p.type === "secret", ...(signal ? { signal } : {}) });
    },
  };
  let credential: unknown;
  try {
    credential = await o.runtime.login(o.provider, "oauth", interaction, {
      getDeviceId: o.getDeviceId,
    });
  } catch (err) {
    io.out(`Login to ${o.provider} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const expires = (credential as { expires?: unknown } | null)?.expires;
  const now = (o.now ?? Date.now)();
  io.out(
    typeof expires === "number"
      ? `Logged in to ${o.provider}: access token good for ${lifeOf(expires, now)} (until ${new Date(expires).toISOString()}).`
      : `Logged in to ${o.provider}.`,
  );
  let checked: AuthCheckResult;
  try {
    checked = await o.check(o.provider);
  } catch (err) {
    io.out(`pi auth check failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (checked.status !== "ready") {
    io.out(
      `pi auth check: ${o.provider} is ${checked.status}${checked.reason ? ` (${checked.reason})` : ""}`,
    );
    return 1;
  }
  io.out(`pi auth check: ${o.provider} is ready (${checked.authType ?? "oauth"}).`);
  return 0;
}

// ---- the real ports, inside the image --------------------------------------------

/** pi's package dir in the global install. */
function piPackageDir(): string {
  const pkg = "@earendil-works/pi-coding-agent";
  const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  const dir = join(root, pkg);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`pi is not installed at ${dir}`);
  return dir;
}

function terminalIo(): LoginIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    ask: (question, o) =>
      new Promise<string>((resolve, reject) => {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
          terminal: true,
        });
        if (o.secret) {
          // Echo nothing of what is typed.
          const w = rl as unknown as { _writeToOutput?: (s: string) => void };
          w._writeToOutput = (s: string) => {
            if (s.includes(question)) process.stdout.write(s);
          };
        }
        const onAbort = (): void => {
          rl.close();
          process.stdout.write("\n");
          reject(new Error("Login cancelled"));
        };
        o.signal?.addEventListener("abort", onAbort, { once: true });
        rl.question(question.endsWith(" ") ? question : `${question} `, (answer) => {
          o.signal?.removeEventListener("abort", onAbort);
          rl.close();
          if (o.secret) process.stdout.write("\n");
          resolve(answer);
        });
      }),
  };
}

function piAuthCheck(provider: string): Promise<AuthCheckResult> {
  const r = spawnSync("pi", ["auth", "check", "--provider", provider, "--json"], {
    encoding: "utf8",
  });
  const last = (r.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return Promise.resolve(JSON.parse(last) as AuthCheckResult);
  } catch {
    return Promise.resolve({
      status: "unreadable",
      reason: (r.stderr ?? "").trim().split("\n").pop() || `exit ${r.status}`,
    });
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const { provider } = parseLoginArgs(argv);
  const pi = (await import(pathToFileURL(join(piPackageDir(), "dist", "index.js")).href)) as {
    ModelRuntime: { create(o: Record<string, unknown>): Promise<LoginRuntime> };
    SettingsManager: {
      create(
        cwd: string,
        agentDir?: string,
      ): { getOrCreateDeviceId(): string; flush(): Promise<void> };
    };
    getAgentDir(): string;
  };
  const runtime = await pi.ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const settings = pi.SettingsManager.create(process.cwd(), pi.getAgentDir());
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    return await piLogin({
      runtime,
      provider,
      io: terminalIo(),
      getDeviceId: () => settings.getOrCreateDeviceId(),
      check: piAuthCheck,
      signal: controller.signal,
    });
  } finally {
    await settings.flush();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`scan login: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
