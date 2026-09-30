// Webhook ingress — the onboarding step where the operator chooses how
// GitHub's webhooks reach their daemon (spec "Webhook
// ingress"). Four shapes, offered with their real trade-offs; the step then
// writes the configuration each one needs and verifies the RUNNING shape
// rather than trusting what it recorded.
//
// The shapes, and why none of them is a trap:
//
//   quick   cloudflared quick tunnel (the default). No account, no signup, no
//           SLA — and the hostname ROTATES on every restart. Safe because two
//           mechanisms cover it: the sidecar publishes each new hostname to
//           the shared hostname file and the daemon re-points the App's own
//           webhook URL (`[ingress] shape = "tunnel-file"`, src/webhookheal.ts),
//           and the reconcile poll is the correctness backbone regardless — a
//           webhook that never arrives costs latency, never a missed PR.
//   ngrok   Stable hostname with a reserved domain, at the price of an account
//           and free-tier caps. Same hostname-file contract, same self-heal.
//   named   The operator's own Cloudflare tunnel token and domain — a
//           permanent hostname (the VM route's default). No rotation, so no
//           self-heal: `[ingress] shape = "none"` and `[server] hostname`
//           carries the name.
//   polling No tunnel at all. The reconcile poll becomes the ONLY trigger
//           path, at `[daemon] poll_interval_s`. What degrades is stated
//           plainly in the step's own output (author-reply routing and the
//           [feedback] loop are webhook-only), and the tunnel is offered as a
//           later upgrade — re-running this step is the upgrade.
//
// The step is deliberately self-contained: it owns the `[ingress]` section of
// config.toml, the project `.env`'s COMPOSE_PROFILES line, and nothing else.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { locateSecrets } from "../../install.js";
import { CHOICE_KEYS, type IngressChoice } from "../choices.js";
import { topologyOf } from "./topology.js";
import type {
  CheckResult,
  OnboardAdapters,
  OnboardingStep,
  StepContext,
  StepReport,
} from "../engine.js";

export const INGRESS_STEP_ID = "ingress";
/** Recorded choice keys later steps (and verify) read. */
/** The daemon's webhook route — the same default `src/webhook.ts` serves and
 * `src/webhookheal.ts` re-points the App to. */
export const WEBHOOK_PATH = "/webhook";
export const INGRESS_CHOICE_KEY = CHOICE_KEYS.ingress;
export const INGRESS_HOSTNAME_KEY = CHOICE_KEYS.ingressHostname;

export type { IngressChoice };

export interface IngressOption {
  id: IngressChoice;
  headline: string;
  /** Honest trade-offs — the good and the bad, in the operator's words. */
  tradeoffs: string[];
  /** `[ingress] shape` this choice configures. */
  shape: "tunnel-file" | "none";
  /** COMPOSE_PROFILES value ("" ⇒ no sidecar at all). */
  profile: string;
  /** Secrets-dir file this choice requires, if any. */
  secret: string | null;
  /** Compose service that must be running for this choice, if any. */
  service: string | null;
}

export const INGRESS_OPTIONS: readonly IngressOption[] = [
  {
    id: "quick",
    headline: "Cloudflare quick tunnel (default) — no account, nothing to sign up for",
    tradeoffs: [
      "no account, no credential, no DNS: it works within seconds of `docker compose up`",
      "the *.trycloudflare.com hostname ROTATES on every tunnel restart — the daemon re-points the App's webhook URL itself, so this costs you nothing to operate",
      "no SLA and no support: Cloudflare can drop a quick tunnel at any time. The reconcile poll still triggers every review, so an outage costs webhook latency, not correctness",
      "not for a permanent installation you advertise — for that, pick the named tunnel",
    ],
    shape: "tunnel-file",
    profile: "quick-tunnel",
    secret: null,
    service: "tunnel-quick",
  },
  {
    id: "ngrok",
    headline: "ngrok — a stable hostname, at the price of an account",
    tradeoffs: [
      "needs an ngrok account and an authtoken; with a reserved domain the hostname never changes",
      "free tier caps: roughly 20,000 requests a month and 1 GB of transfer, 1 online agent, and rate limits (about 120 requests/minute). A busy repo can exhaust that — the paid tier lifts it",
      "without a reserved domain the hostname still rotates; the same self-heal covers it",
      "the authtoken lives in a FILE in your secrets dir (never a command line): <secrets>/ngrok_authtoken",
    ],
    shape: "tunnel-file",
    profile: "ngrok",
    secret: "ngrok_authtoken",
    service: "tunnel-ngrok",
  },
  {
    id: "named",
    headline: "Named Cloudflare tunnel — your own domain (what the VM route uses)",
    tradeoffs: [
      "a permanent hostname on a domain you own, with Cloudflare's SLA behind it",
      "needs a Cloudflare account, a zone, and a tunnel connector token (the secrets wizard collects it as `tunnel_token`)",
      "no rotation, so no webhook self-heal is needed or enabled",
      "the same token works on either topology: this compose sidecar, or cloudflared on a VM via the Ansible route",
    ],
    shape: "none",
    profile: "named-tunnel",
    secret: "tunnel_token",
    service: "tunnel-named",
  },
  {
    id: "polling",
    headline: "Polling only — no tunnel, nothing exposed",
    tradeoffs: [
      "nothing to install, nothing reachable from the internet: the daemon only makes outbound calls",
      "the reconcile poll becomes the ONLY trigger path, so a review starts up to one poll interval late ([daemon] poll_interval_s, 300s by default)",
      "what degrades, plainly: author replies do not route to the PR's session (the ping-pong path is webhook-driven), the [feedback] tuning loop never sees a comment, and the CI-completed retry of a withheld approval waits for the next sweep",
      "it is not a dead end — re-run this step later and pick a tunnel; nothing else has to change",
    ],
    shape: "none",
    profile: "",
    secret: null,
    service: null,
  },
];

export function optionFor(choice: string): IngressOption | null {
  return INGRESS_OPTIONS.find((o) => o.id === choice) ?? null;
}

/** The offer text — what the guide reads out when no choice was made yet. */
export function renderOptions(): string {
  return INGRESS_OPTIONS.map((o) =>
    [`${o.id}: ${o.headline}`, ...o.tradeoffs.map((t) => `    - ${t}`)].join("\n"),
  ).join("\n");
}

// ---- small deterministic file surgery ---------------------------------------
// The wizard never rewrites a file it does not own end to end: it patches the
// ONE section (or the ONE key) that is its business and leaves every comment
// and every other value byte-identical.

/** `<sandbox root>` — the engine's contract is stateDir = `<root>/state`. */
export function sandboxRootOf(adapters: OnboardAdapters): string {
  return dirname(adapters.paths.stateDir);
}

/** Where the [ingress] block goes when the file has none yet: just before
 * [daemon], which is where config.example.toml documents it. */
const INGRESS_ANCHOR = /^\[daemon\]/m;

/** The section body (header line included) for a choice. */
export function ingressBlock(option: IngressOption): string {
  if (option.shape === "none") {
    return [
      "[ingress]",
      "# Written by the onboarding wizard.",
      `# Chosen shape: ${option.id} — a stable hostname needs no webhook self-heal.`,
      'shape = "none"',
      "",
    ].join("\n");
  }
  return [
    "[ingress]",
    "# Written by the onboarding wizard.",
    `# Chosen shape: ${option.id} — the tunnel sidecar publishes its assigned`,
    "# hostname to hostname_file and the daemon re-points the App's own webhook",
    "# URL when it changes (the one mutation class that executes in dry-run).",
    'shape = "tunnel-file"',
    'hostname_file = ""',
    "debounce_ms = 3000",
    "sweep_interval_s = 300",
    "",
  ].join("\n");
}

/** Replace `[section]`…(next top-level table) with `body`; insert before the
 * anchor (or append) when the section does not exist. Commented-out template
 * blocks (`#[ingress]`) are left exactly as they are — they are documentation. */
export function patchTomlSection(toml: string, section: string, body: string): string {
  const header = new RegExp(`^\\[${section}\\][^\\n]*\\n`, "m");
  const start = header.exec(toml);
  if (start?.index !== undefined) {
    const from = start.index;
    const rest = toml.slice(from + start[0].length);
    const nextTable = /^\[[^\n]*\]/m.exec(rest);
    const to = from + start[0].length + (nextTable?.index ?? rest.length);
    return `${toml.slice(0, from)}${body}${toml.slice(to)}`;
  }
  const anchor = INGRESS_ANCHOR.exec(toml);
  if (anchor?.index !== undefined)
    return `${toml.slice(0, anchor.index)}${body}\n${toml.slice(anchor.index)}`;
  return `${toml.replace(/\n*$/, "\n")}\n${body}`;
}

/** Read a bare `key = "value"` (or unquoted scalar) out of one table.
 * Indentation is valid TOML before a header or a key, and the loader
 * (smol-toml) accepts it — so this does too, or a reader here disagrees with
 * the daemon about the same file. */
export function readTomlKey(toml: string, section: string, key: string): string | null {
  const header = new RegExp(`^[ \\t]*\\[${section}\\][^\\n]*\\n`, "m").exec(toml);
  if (header?.index === undefined) return null;
  const rest = toml.slice(header.index + header[0].length);
  const nextTable = /^[ \t]*\[[^\n]*\]/m.exec(rest);
  const body = rest.slice(0, nextTable?.index ?? rest.length);
  const line = new RegExp(`^[ \\t]*${key}\\s*=\\s*(.+)$`, "m").exec(body);
  if (!line?.[1]) return null;
  return tomlScalarText(line[1]);
}

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\u001b",
  '"': '"',
  "\\": "\\",
};

/** One value's text as the loader reads it: a quoted string ends at its
 * closing quote (a `#` inside it is part of the value, not a comment), a
 * basic string's escapes are decoded, and only a bare scalar has a trailing
 * comment stripped. */
function tomlScalarText(value: string): string {
  const v = value.trim();
  if (v.startsWith("'") && !v.startsWith("'''")) {
    const end = v.indexOf("'", 1);
    return end === -1 ? v.slice(1) : v.slice(1, end);
  }
  if (v.startsWith('"') && !v.startsWith('"""')) {
    let out = "";
    for (let i = 1; i < v.length; i++) {
      const c = v[i]!;
      if (c === '"') return out;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const esc = v[i + 1] ?? "";
      const width = esc === "u" ? 4 : esc === "U" ? 8 : 0;
      if (width > 0) {
        const code = Number.parseInt(v.slice(i + 2, i + 2 + width), 16);
        out += Number.isNaN(code) ? "" : String.fromCodePoint(code);
        i += 1 + width;
      } else {
        out += TOML_ESCAPES[esc] ?? esc;
        i += 1;
      }
    }
    return out;
  }
  return v.replace(/\s*#.*$/, "").trim();
}

/** Set `key = "value"` inside an existing table, preserving everything else.
 * Returns null when the table (or the key) is not there to patch — the caller
 * turns that into a plain red check rather than inventing structure. */
export function setTomlKey(
  toml: string,
  section: string,
  key: string,
  value: string,
): string | null {
  // Indentation is accepted exactly as readTomlKey accepts it: a key this
  // misses would be written a second time, and the loader rejects duplicates.
  const header = new RegExp(`^[ \\t]*\\[${section}\\][^\\n]*\\n`, "m").exec(toml);
  if (header?.index === undefined) return null;
  const bodyStart = header.index + header[0].length;
  const rest = toml.slice(bodyStart);
  const nextTable = /^[ \t]*\[[^\n]*\]/m.exec(rest);
  const bodyEnd = bodyStart + (nextTable?.index ?? rest.length);
  const body = toml.slice(bodyStart, bodyEnd);
  const line = new RegExp(`^([ \\t]*)${key}\\s*=\\s*[^\\n]*$`, "m");
  const replacement = `${key} = ${JSON.stringify(value)}`;
  const patched = line.test(body)
    ? body.replace(line, (_m, indent: string) => `${indent}${replacement}`)
    : `${replacement}\n${body}`;
  return `${toml.slice(0, bodyStart)}${patched}${toml.slice(bodyEnd)}`;
}

/** `KEY=value` in a dotenv file: replace the line or append it. */
export function setEnvKey(text: string, key: string, value: string): string {
  const line = new RegExp(`^${key}=.*$`, "m");
  if (line.test(text)) return text.replace(line, `${key}=${value}`);
  const base = text === "" || text.endsWith("\n") ? text : `${text}\n`;
  return `${base}${key}=${value}\n`;
}

export function readEnvKey(text: string, key: string): string | null {
  const m = new RegExp(`^${key}=(.*)$`, "m").exec(text);
  return m ? (m[1] ?? "").trim() : null;
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${path.split("/").at(-1)}.onboard.tmp`);
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** The operator's secrets dir: config.toml's value when it has one, else the
 * install locator's answer. */
export function secretsDirOf(configToml: string | null): string {
  const configured = configToml ? readTomlKey(configToml, "github", "secrets_dir") : null;
  return locateSecrets({ configured }).path;
}

/** A hostname the operator typed: bare, lowercase, no scheme or path. */
export function normalizeHostname(raw: unknown): string | null {
  const text = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  return /^[a-z0-9]([a-z0-9-]{0,62})?(\.[a-z0-9]([a-z0-9-]{0,62})?)+$/.test(text) ? text : null;
}

// ---- the running shape ------------------------------------------------------

export interface RunningService {
  service: string;
  state: string;
}

/** `docker compose ps --format json` is an ARRAY on some versions and
 * newline-delimited objects on others. Total: garbage parses to []. */
export function parseComposePs(stdout: string): RunningService[] {
  const rows: RunningService[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    const row = value as Record<string, unknown>;
    const service =
      typeof row.Service === "string" ? row.Service : typeof row.Name === "string" ? row.Name : "";
    if (service !== "")
      rows.push({ service, state: typeof row.State === "string" ? row.State : "" });
  };
  const text = stdout.trim();
  if (text === "") return rows;
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      for (const row of parsed) push(row);
      return rows;
    }
    push(parsed);
    return rows;
  } catch {
    for (const line of text.split("\n")) {
      try {
        push(JSON.parse(line) as unknown);
      } catch {
        /* not a JSON line — ignore */
      }
    }
    return rows;
  }
}

function isUp(row: RunningService | undefined): boolean {
  return row !== undefined && /running|up/i.test(row.state);
}

// ---- the step ---------------------------------------------------------------

const CHOICE_IDS = INGRESS_OPTIONS.map((o) => o.id);

function chosen(ctx: StepContext): IngressChoice | null {
  const raw = ctx.input.choice ?? ctx.choices[INGRESS_CHOICE_KEY];
  const id = String(raw ?? "")
    .trim()
    .toLowerCase();
  return (CHOICE_IDS as string[]).includes(id) ? (id as IngressChoice) : null;
}

/**
 * The recommended default differs by topology, and saying so is the honest
 * part. On a laptop the quick tunnel wins: no account, and the daemon
 * re-points its own rotating hostname. On a server the named tunnel wins: the
 * playbook installs cloudflared there from your token, and a permanent
 * installation deserves a permanent hostname. Every option stays selectable on
 * both — on the server route the ones the playbook does not install mean "you
 * front the daemon's port yourself", which the inventory step spells out.
 */
export function recommendedIngressFor(topology: string): IngressChoice {
  return topology === "vm" ? "named" : "quick";
}

function offerCheck(topology: string): CheckResult {
  const recommended = recommendedIngressFor(topology);
  return {
    name: "choice",
    ok: false,
    detail:
      `pick one of ${CHOICE_IDS.join(" | ")} and call this step again with it (choice: "<id>").\n` +
      (topology === "vm"
        ? `On the server route the recommended answer is "${recommended}" — the deploy installs cloudflared on that machine from ` +
          "your tunnel token, and an always-on installation deserves a hostname that never rotates. The others stay available: " +
          "polling needs no ingress at all, and quick/ngrok mean you run that tunnel on the server yourself.\n"
        : `On this machine the recommended answer is "${recommended}" — no account, nothing to sign up for, and the daemon ` +
          "re-points its own webhook URL when the hostname rotates.\n") +
      renderOptions(),
  };
}

export function ingressStep(): OnboardingStep {
  return {
    id: INGRESS_STEP_ID,
    title: "Webhook ingress: how GitHub reaches your daemon",
    explain:
      "GitHub delivers webhooks to an HTTPS URL, so your daemon needs one. Offer the four shapes with their real " +
      "trade-offs — quick tunnel (the default: no account, rotating hostname the daemon re-points itself), ngrok " +
      "(stable hostname, free-tier caps), a named Cloudflare tunnel (your own domain), or polling-only (no tunnel; " +
      "the reconcile poll triggers reviews, and author-reply routing plus the feedback loop go quiet). The recommended " +
      "answer depends on where the reviewer lives: the quick tunnel on this computer, the named tunnel on a server (the " +
      "deploy installs cloudflared there). Call the tool with no arguments first to read the options out, then again with " +
      "the operator's pick.",
    order: 50,
    parameters: {
      type: "object",
      properties: {
        choice: {
          type: "string",
          enum: CHOICE_IDS,
          description:
            "The ingress shape the operator picked. Omit to have the step list the options and their trade-offs.",
        },
        hostname: {
          type: "string",
          description:
            "The public hostname. Required for the named Cloudflare tunnel (your domain); optional for ngrok (a reserved domain). Ignored otherwise.",
        },
      },
    },

    async run(ctx): Promise<StepReport> {
      const choice = chosen(ctx);
      if (choice === null)
        return { ok: false, checks: [offerCheck(String(ctx.choices[CHOICE_KEYS.topology] ?? ""))] };
      const option = optionFor(choice)!;
      const root = sandboxRootOf(ctx.adapters);
      const checks: CheckResult[] = [
        { name: "choice", ok: true, detail: `${option.id} — ${option.headline}` },
        { name: "trade-offs", ok: true, detail: option.tradeoffs.map((t) => `• ${t}`).join("\n") },
      ];

      // 1. the hostname, where the shape has one the operator must supply.
      const hostname = normalizeHostname(ctx.input.hostname ?? ctx.choices[INGRESS_HOSTNAME_KEY]);
      if (choice === "named" && hostname === null) {
        checks.push({
          name: "hostname",
          ok: false,
          detail:
            'a named Cloudflare tunnel needs the public hostname it serves — re-run with hostname: "review.example.com"',
        });
        return { ok: false, checks };
      }

      // 2. the credential, where the shape needs one. Read from the secrets
      // dir, never from an argument: the wizard must not carry a token.
      const configPath = ctx.adapters.paths.configPath;
      const configToml = readFileOrNull(configPath);
      const secretsDir = secretsDirOf(configToml);
      if (option.secret) {
        const file = join(secretsDir, option.secret);
        const present = existsSync(file) && readFileSync(file, "utf8").trim() !== "";
        checks.push({
          name: "credential",
          ok: present,
          detail: present
            ? `${file} present — the sidecar reads it from the read-only secrets mount and passes it in the environment, never on a command line`
            : `${file} is missing or empty. Create it with:\n    (umask 077; printf %s '<token>' > ${file})\n` +
              (option.secret === "tunnel_token"
                ? "  (`bash deploy/collect-secrets.sh` collects this one interactively.)"
                : ""),
        });
      }

      // 3. config.toml's [ingress] section — the daemon's half of the contract.
      if (configToml === null) {
        checks.push({
          name: "config",
          ok: false,
          detail: `${configPath} does not exist yet — create it (cp config.example.toml config.toml) and run this step again`,
        });
        return { ok: false, checks };
      }
      let patched = patchTomlSection(configToml, "ingress", ingressBlock(option));
      if (hostname !== null) {
        const withHost = setTomlKey(patched, "server", "hostname", hostname);
        if (withHost === null) {
          checks.push({
            name: "server-hostname",
            ok: false,
            detail: "config.toml has no [server] table to write the hostname into",
          });
          return { ok: false, checks };
        }
        patched = withHost;
        checks.push({
          name: "server-hostname",
          ok: true,
          detail: `[server] hostname = "${hostname}"`,
        });
      }
      writeAtomic(configPath, patched);
      checks.push({
        name: "config",
        ok: true,
        detail:
          option.shape === "tunnel-file"
            ? '[ingress] shape = "tunnel-file" — the daemon watches the hostname file and re-points the App webhook URL when the tunnel rotates'
            : '[ingress] shape = "none" — no webhook self-heal (this hostname does not rotate)',
      });

      // 4. the compose profile — which sidecar (if any) comes up with the stack.
      const envPath = join(root, ".env");
      const envText = readFileOrNull(envPath) ?? "";
      writeAtomic(envPath, setEnvKey(envText, "COMPOSE_PROFILES", option.profile));
      checks.push({
        name: "compose-profile",
        ok: true,
        detail:
          option.profile === ""
            ? `${envPath}: COMPOSE_PROFILES= (empty) — \`docker compose up\` brings up the daemon alone, no sidecar`
            : `${envPath}: COMPOSE_PROFILES=${option.profile} — \`docker compose up\` also starts the ${option.service} sidecar`,
      });

      ctx.recordChoice(CHOICE_KEYS.ingress, choice);
      if (hostname !== null) {
        ctx.recordChoice(CHOICE_KEYS.ingressHostname, hostname);
        // The public endpoint, for the ONE reader of it: the App step puts it
        // in the manifest instead of the artifact's placeholder. Only a
        // hostname the operator owns is stable enough to record — a rotating
        // tunnel's URL is the daemon's own self-heal to keep current.
        ctx.recordChoice(CHOICE_KEYS.webhookUrl, `https://${hostname}${WEBHOOK_PATH}`);
      }
      return {
        ok: checks.every((c) => c.ok),
        checks,
        data: { choice, profile: option.profile, shape: option.shape, hostname },
      };
    },

    async verify(ctx): Promise<StepReport> {
      const recorded = String(ctx.data.choice ?? ctx.choices[INGRESS_CHOICE_KEY] ?? "");
      const option = optionFor(recorded);
      if (option === null) {
        return {
          ok: false,
          checks: [
            {
              name: "choice",
              ok: false,
              detail: "no ingress shape recorded — run the ingress step",
            },
          ],
        };
      }
      const root = sandboxRootOf(ctx.adapters);
      const checks: CheckResult[] = [
        { name: "choice", ok: true, detail: `${option.id} — ${option.headline}` },
      ];

      // Reality, not the record: what does config.toml actually say?
      const configToml = readFileOrNull(ctx.adapters.paths.configPath);
      const shape =
        configToml === null ? null : (readTomlKey(configToml, "ingress", "shape") ?? "none");
      checks.push(
        configToml === null
          ? {
              name: "config",
              ok: false,
              detail: `${ctx.adapters.paths.configPath} is gone — re-run the ingress step after restoring it`,
            }
          : shape === option.shape
            ? { name: "config", ok: true, detail: `[ingress] shape = "${shape}"` }
            : {
                name: "config",
                ok: false,
                detail: `[ingress] shape is "${shape}" but the ${option.id} shape needs "${option.shape}" — re-run the ingress step`,
              },
      );

      if (option.secret) {
        const file = join(secretsDirOf(configToml), option.secret);
        const present = existsSync(file) && readFileSync(file, "utf8").trim() !== "";
        checks.push({
          name: "credential",
          ok: present,
          detail: present
            ? `${file} present`
            : `${file} is missing or empty — the ${option.id} tunnel cannot start without it`,
        });
      }

      const hostname = normalizeHostname(ctx.data.hostname ?? ctx.choices[INGRESS_HOSTNAME_KEY]);
      if (option.id === "named") {
        const configured =
          configToml === null
            ? null
            : normalizeHostname(readTomlKey(configToml, "server", "hostname"));
        checks.push(
          configured !== null && (hostname === null || configured === hostname)
            ? { name: "server-hostname", ok: true, detail: `[server] hostname = "${configured}"` }
            : {
                name: "server-hostname",
                ok: false,
                detail: `[server] hostname is ${JSON.stringify(configured ?? "")} — the named tunnel serves ${JSON.stringify(hostname ?? "your domain")}`,
              },
        );
      }

      // The compose profile only means anything on the compose topology.
      if (topologyOf(ctx.choices) === "vm") {
        checks.push({
          name: "compose-profile",
          ok: true,
          detail: "VM topology — ingress runs on the server, not as a compose sidecar",
        });
      } else {
        const envText = readFileOrNull(join(root, ".env")) ?? "";
        const profile = readEnvKey(envText, "COMPOSE_PROFILES") ?? "";
        checks.push(
          profile === option.profile
            ? {
                name: "compose-profile",
                ok: true,
                detail: `COMPOSE_PROFILES=${profile === "" ? "(empty — no sidecar)" : profile}`,
              }
            : {
                name: "compose-profile",
                ok: false,
                detail: `.env has COMPOSE_PROFILES=${JSON.stringify(profile)} but the ${option.id} shape needs ${JSON.stringify(option.profile)} — re-run the ingress step`,
              },
        );
        checks.push(...(await runningShapeChecks(ctx, root, option)));
      }

      return { ok: checks.every((c) => c.ok), checks };
    },
  };
}

/**
 * The "is it actually like that" half of verify: ask Docker what is running
 * and, for a capturing tunnel, read the published hostname back through the
 * DAEMON's own path — proving the shared volume is wired where the watcher
 * looks. A stack that is not up yet is a note, not a failure: bring-up is a
 * later step, and this step must not hold the checklist hostage to it.
 */
async function runningShapeChecks(
  ctx: StepContext,
  root: string,
  option: IngressOption,
): Promise<CheckResult[]> {
  const ps = await ctx.adapters.runner.run("docker", [
    "compose",
    "--project-directory",
    root,
    "ps",
    "--format",
    "json",
  ]);
  if (ps.code !== 0) {
    return [
      {
        name: "running",
        ok: true,
        detail: `could not inspect the running stack (docker compose ps exited ${ps.code}) — configuration checked only`,
      },
    ];
  }
  const rows = parseComposePs(ps.stdout);
  const daemonUp = isUp(rows.find((r) => r.service === "daemon"));
  const sidecar =
    option.service === null ? undefined : rows.find((r) => r.service === option.service);
  const strays = rows.filter(
    (r) => r.service.startsWith("tunnel-") && r.service !== option.service && isUp(r),
  );

  const checks: CheckResult[] = [];
  if (strays.length > 0) {
    checks.push({
      name: "running",
      ok: false,
      detail: `${strays.map((s) => s.service).join(", ")} still running though the ${option.id} shape does not use it — \`docker compose down\` then \`docker compose up -d\``,
    });
  }
  if (!daemonUp) {
    checks.push({
      name: "running",
      ok: true,
      detail: "the stack is not up yet — configuration checked only (bring-up is a later step)",
    });
    return checks;
  }
  if (option.service === null) {
    if (strays.length === 0)
      checks.push({
        name: "running",
        ok: true,
        detail: "daemon up, no tunnel sidecar — the polling shape, as chosen",
      });
    return checks;
  }
  if (!isUp(sidecar)) {
    checks.push({
      name: "running",
      ok: false,
      detail: `the daemon is up but ${option.service} is ${sidecar ? sidecar.state : "not running"} — start it with \`docker compose up -d\` (COMPOSE_PROFILES=${option.profile})`,
    });
    return checks;
  }
  checks.push({ name: "running", ok: true, detail: `daemon and ${option.service} both running` });

  if (option.shape !== "tunnel-file") return checks;
  // The contract itself, end to end: what the sidecar wrote is what the
  // daemon's watcher reads (src/webhookheal.ts, <root>/state/ingress/hostname).
  const cat = await ctx.adapters.runner.run("docker", [
    "compose",
    "--project-directory",
    root,
    "exec",
    "-T",
    "daemon",
    "cat",
    "/opt/quickreview/state/ingress/hostname",
  ]);
  const published = cat.code === 0 ? normalizeHostname(cat.stdout) : null;
  checks.push(
    published !== null
      ? {
          name: "hostname-file",
          ok: true,
          detail: `the daemon reads ${published} from /opt/quickreview/state/ingress/hostname — the App's webhook URL is re-pointed there`,
        }
      : {
          name: "hostname-file",
          ok: false,
          detail:
            "no hostname published yet at /opt/quickreview/state/ingress/hostname — a tunnel that just started needs a few seconds; " +
            `otherwise check \`docker compose logs ${option.service}\``,
        },
  );
  return checks;
}
