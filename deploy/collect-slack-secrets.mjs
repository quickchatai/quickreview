#!/usr/bin/env node
// Interactive wizard: set up the Slack concierge end to end — create
// the app, collect the two tokens into the secrets dir, pick the ONE channel,
// build the [slack.users] identity map, and patch config.toml.
//
// Tokens are read with hidden input and NEVER printed back. Re-run any time —
// existing files are kept unless you choose to replace them.
//
//   node deploy/collect-slack-secrets.mjs               # fill in what is missing
//   node deploy/collect-slack-secrets.mjs --force       # offer to replace existing tokens too
//   node deploy/collect-slack-secrets.mjs --no-verify   # skip every network call (offline)
//   node deploy/collect-slack-secrets.mjs --config PATH # patch a different config.toml
//                                        (default: the install locator's answer)
//   node deploy/collect-slack-secrets.mjs --secrets-dir PATH   # override the secrets dir
//   QC_SECRETS_DIR=/tmp/sec node deploy/collect-slack-secrets.mjs   # same, via env
//
// WHY NODE, NOT BASH (deploy/collect-secrets.sh is bash):
//   that wizard only writes flat files. This one also makes read-only Slack Web
//   API calls (JSON) and surgically patches config.toml (comment-preserving text
//   editing). Both are miserable in bash. It is still a *standalone* script:
//   ESM, Node 26+ (supported), global fetch, zero imports outside node: — no npm deps, so
//   it runs before/without an install. The visual language deliberately mirrors
//   collect-secrets.sh (bold/ok/bad/info, same colours, hidden input).
//
// WHAT IT NEVER DOES: deploy, start a container, start the daemon, touch
// `dry_run`, or flip `enabled` behind your back. Slack calls are read-only
// (auth.test, apps.connections.open, conversations.info, users.list) — it never
// posts, never joins, never mutates anything in Slack.

import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- pure helpers
// Everything below the `export` keyword is covered by tests/slack-setup-wizard.test.ts.

/** ANSI helpers — same palette as deploy/collect-secrets.sh. */
export const bold = (s) => `[1m${s}[0m`;
export const okMark = "[32m✔[0m";
export const badMark = "[31m✘[0m";

/**
 * Never reveal a token. Shows the prefix up to the first `-` plus a 3-char tail
 * hint and the length — enough to tell two pastes apart, useless to an attacker.
 */
export function maskToken(value) {
  const v = String(value ?? "");
  if (v === "") return "(empty)";
  const dash = v.indexOf("-");
  const head = dash > 0 ? v.slice(0, dash + 1) : v.slice(0, 2);
  if (v.length <= head.length + 6) return `${"*".repeat(v.length)} (${v.length} chars)`;
  return `${head}…${v.slice(-3)} (${v.length} chars)`;
}

/**
 * Accept a raw channel id, a Slack permalink, or an archives URL (query string
 * and all). Reject `#name` loudly — config.toml needs the id, not the name.
 * Returns { ok: true, id } or { ok: false, reason }.
 */
export function parseChannelId(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") return { ok: false, reason: "empty — paste a channel id (C…) or a Slack link" };
  const idRe = /^[CG][A-Z0-9]{5,}$/;

  if (raw.startsWith("#")) {
    return {
      ok: false,
      reason:
        `"${raw}" is a channel NAME. config.toml needs the channel ID (starts with C). ` +
        "In Slack: open the channel → click its name → About → scroll to the bottom → " +
        "“Channel ID”, or use Copy link and paste that here.",
    };
  }

  const bare = raw.toUpperCase();
  if (idRe.test(bare)) return { ok: true, id: bare };

  if (/^https?:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: `not a usable Slack link: ${raw}` };
    }
    const seg = url.pathname.split("/").filter(Boolean);
    const i = seg.indexOf("archives");
    const candidates = [];
    if (i !== -1 && seg[i + 1]) candidates.push(seg[i + 1]);
    for (const key of ["cid", "channel", "channel_id"]) {
      const q = url.searchParams.get(key);
      if (q) candidates.push(q);
    }
    for (const c of candidates) {
      const up = String(c).toUpperCase();
      if (idRe.test(up)) return { ok: true, id: up };
    }
    return {
      ok: false,
      reason:
        "that link has no channel id in it — use the channel's “Copy link” " +
        "(it looks like https://…/archives/C0ABCDEFG/p1712345678000100)",
    };
  }

  return {
    ok: false,
    reason:
      `"${raw}" is not a channel id. Ids look like C0ABCDEFG (8–11 chars, C then ` +
      "capitals/digits). Channel → About → bottom, or Copy link and paste the URL.",
  };
}

/** Slack member id, as accepted for legacy_owner_slack_id / [slack.users] keys. */
export function parseUserId(input) {
  const raw = String(input ?? "")
    .trim()
    .toUpperCase();
  if (/^[UW][A-Z0-9]{5,}$/.test(raw)) return { ok: true, id: raw };
  return {
    ok: false,
    reason:
      `"${String(input ?? "").trim()}" is not a Slack member id. Ids look like U01AB2CD3EF ` +
      "(profile → ⋮ → Copy member ID).",
  };
}

/**
 * Shape check for the two tokens. `kind` is "bot" (xoxb-) or "app" (xapp-).
 * The wrong-slot case gets its own message — pasting the app token at step 2 is
 * the single most common mistake.
 */
export function tokenLooksValid(kind, value) {
  const v = String(value ?? "").trim();
  const want = kind === "bot" ? "xoxb-" : "xapp-";
  const other = kind === "bot" ? "xapp-" : "xoxb-";
  const otherName =
    kind === "bot"
      ? "the APP-LEVEL token (step 3, Basic Information → App-Level Tokens)"
      : "the BOT token (step 2, OAuth & Permissions → Bot User OAuth Token)";
  if (v === "") return { ok: false, reason: "nothing pasted" };
  if (/\s/.test(v)) return { ok: false, reason: "contains whitespace — paste one unbroken string" };
  if (v.startsWith(other)) {
    return {
      ok: false,
      reason: `that is ${otherName} — it starts ${other}, this step needs one starting ${want}`,
    };
  }
  if (!v.startsWith(want)) return { ok: false, reason: `must start with ${want}` };
  if (v.length < 24) return { ok: false, reason: `suspiciously short (${v.length} chars)` };
  return { ok: true };
}

/** GitHub logins: 1–39 chars, alphanumeric or single hyphens, no leading/trailing hyphen. */
export function looksLikeGithubLogin(value) {
  const v = String(value ?? "").trim();
  return /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/.test(v);
}

/** The [slack.users] table body: `U… = "login"` lines, one per entry, in order. */
export function renderUsersTable(users) {
  const entries = users instanceof Map ? [...users.entries()] : Object.entries(users ?? {});
  return entries.map(([id, login]) => `${id} = ${JSON.stringify(String(login))}`).join("\n");
}

/** Human-readable summary of what step 6 is about to write. */
export function renderSlackValues(values) {
  const users =
    values.users instanceof Map ? Object.fromEntries(values.users) : (values.users ?? {});
  const n = Object.keys(users).length;
  const lines = [
    `  channel           ${values.channel || "(empty)"}${values.channelName ? `  (#${values.channelName})` : ""}`,
    `  channel_kind      ${values.channel_kind}`,
    `  legacy_owner_slack_id  ${values.legacy_owner_slack_id || "(empty)"}`,
    `  [slack.users]     ${n} ${n === 1 ? "entry" : "entries"}`,
  ];
  for (const [id, login] of Object.entries(users)) {
    lines.push(`      ${id} → ${login}${id === values.legacy_owner_slack_id ? "   (tier-M)" : ""}`);
  }
  return lines.join("\n");
}

/**
 * Read back the [slack] scalars + users map from config.toml text (no TOML dep).
 * `legacy_owner_slack_id` is the owner's Slack id resolved as the daemon resolves it:
 * `[owner] slack_id` when set, else the legacy `[slack] legacy_owner_slack_id`.
 * `owner_id_conflict` is true when both are set and differ — a config the
 * daemon refuses to load.
 */
export function readSlackValues(text) {
  const section = sliceSection(String(text ?? ""), "[slack]");
  const ownerSection = sliceSection(String(text ?? ""), "[owner]");
  const scalarIn = (body, key) => {
    const m = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
    return m ? (m[1] ?? m[2]) : "";
  };
  const scalar = (key) => scalarIn(section.body, key);
  const ownerId = scalarIn(ownerSection.body, "slack_id").trim();
  const legacyId = scalar("legacy_owner_slack_id").trim();
  const enabledM = section.body.match(/^\s*enabled\s*=\s*(true|false)/m);
  const usersSection = sliceSection(String(text ?? ""), "[slack.users]");
  /** @type {Record<string, string>} */
  const users = {};
  for (const line of usersSection.body.split("\n")) {
    const m = line.match(
      /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z\d_-]+))\s*=\s*(?:"([^"]*)"|'([^']*)')/,
    );
    if (m) users[m[1] ?? m[2] ?? m[3]] = m[4] ?? m[5];
  }
  return {
    enabled: enabledM ? enabledM[1] === "true" : false,
    channel: scalar("channel"),
    channel_kind: scalar("channel_kind") || "public",
    legacy_owner_slack_id: ownerId || legacyId,
    owner_id_conflict: ownerId !== "" && legacyId !== "" && ownerId !== legacyId,
    users,
  };
}

/** Locate a TOML table: everything between its header line and the next `[`. */
function sectionHeaderMatches(line, header) {
  return line.replace(/#.*$/, "").trim() === header;
}

function sliceSection(text, header) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => sectionHeaderMatches(l, header));
  if (start === -1) return { start: -1, end: -1, body: "" };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end, body: lines.slice(start + 1, end).join("\n") };
}

const isKvLine = (l) => !/^\s*#/.test(l) && /^\s*(?:"[^"]*"|'[^']*'|[A-Za-z\d_-]+)\s*=/.test(l);

function replaceScalar(line, key, value) {
  const re = new RegExp(`^(\\s*${key}\\s*=\\s*)("(?:[^"\\\\]|\\\\.)*"|'[^']*')(.*)$`);
  const m = line.match(re);
  if (!m) return line;
  const head = `${m[1]}${JSON.stringify(String(value))}`;
  // Keep a trailing comment in its original column when the new value still
  // fits; the comment text itself is never altered.
  const trailing = m[3].match(/^(\s+)(#.*)$/);
  if (trailing) {
    const column = line.length - trailing[2].length;
    const pad = " ".repeat(Math.max(1, column - head.length));
    return `${head}${pad}${trailing[2]}`;
  }
  return `${head}${m[3]}`;
}

/**
 * Set `enabled = true` in [slack]: an existing assignment is rewritten, an
 * absent one is inserted right after the section header.
 */
export function enableSlack(text) {
  const src = String(text ?? "");
  const sec = sliceSection(src, "[slack]");
  if (sec.start === -1) throw new Error("config.toml has no [slack] section — nothing to enable");
  const lines = src.split("\n");
  let found = false;
  for (let i = sec.start + 1; i < sec.end; i++) {
    if (/^\s*enabled\s*=/.test(lines[i])) {
      found = true;
      lines[i] = lines[i].replace(/^(\s*enabled\s*=\s*)(true|false)/, "$1true");
    }
  }
  if (!found) lines.splice(sec.start + 1, 0, "enabled = true");
  return lines.join("\n");
}

/**
 * Surgically patch config.toml: only `channel`, `channel_kind`,
 * `legacy_owner_slack_id`, the [slack.users] table body and a nonempty
 * `[owner] slack_id` (kept equal to `legacy_owner_slack_id`) change. Every comment,
 * every other key, and the whole [slack.policy] / [slack.policy.causes] block
 * survive byte-identical. `enabled` is deliberately NOT touched here.
 * Idempotent: patch(patch(t)) === patch(t).
 */
export function patchConfigToml(text, values) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const slack = sliceSection(src, "[slack]");
  if (slack.start === -1) throw new Error("config.toml has no [slack] section — nothing to patch");

  const out = lines.slice();
  for (let i = slack.start + 1; i < slack.end; i++) {
    if (values.channel !== undefined) out[i] = replaceScalar(out[i], "channel", values.channel);
    if (values.channel_kind !== undefined)
      out[i] = replaceScalar(out[i], "channel_kind", values.channel_kind);
    if (values.legacy_owner_slack_id !== undefined) {
      out[i] = replaceScalar(out[i], "legacy_owner_slack_id", values.legacy_owner_slack_id);
    }
  }

  const missing = ["channel", "channel_kind", "legacy_owner_slack_id"]
    .filter(
      (key) =>
        values[key] !== undefined &&
        !lines
          .slice(slack.start + 1, slack.end)
          .some((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)),
    )
    .map((key) => `${key} = ${JSON.stringify(String(values[key]))}`);
  out.splice(slack.end, 0, ...missing);

  // A set `[owner] slack_id` wins over the legacy key at load, and the two
  // differing is a load error — so a set canonical id follows the same value.
  const owner = sliceSection(out.join("\n"), "[owner]");
  if (String(values.legacy_owner_slack_id ?? "").trim() !== "" && owner.start !== -1) {
    for (let i = owner.start + 1; i < owner.end; i++) {
      const m = out[i].match(/^\s*slack_id\s*=\s*(?:"([^"]*)"|'([^']*)')/);
      if (m && (m[1] ?? m[2]).trim() !== "") {
        out[i] = replaceScalar(out[i], "slack_id", values.legacy_owner_slack_id);
      }
    }
  }

  if (values.users !== undefined) {
    const entries = renderUsersTable(values.users)
      .split("\n")
      .filter((l) => l !== "");
    const uStart = out.findIndex((l) => sectionHeaderMatches(l, "[slack.users]"));
    if (uStart === -1) {
      out.splice(sliceSection(out.join("\n"), "[slack]").end, 0, "[slack.users]", ...entries, "");
    } else {
      let uEnd = out.length;
      for (let i = uStart + 1; i < out.length; i++) {
        if (/^\s*\[/.test(out[i])) {
          uEnd = i;
          break;
        }
      }
      const section = out.slice(uStart + 1, uEnd);
      const keep = section.filter((l) => !isKvLine(l));
      let trailingBlanks = 0;
      while (keep.length > 0 && keep[keep.length - 1].trim() === "") {
        keep.pop();
        trailingBlanks++;
      }
      const rebuilt = [...keep, ...entries, ...Array(trailingBlanks).fill("")];
      out.splice(uStart + 1, uEnd - (uStart + 1), ...rebuilt);
    }
  }

  return out.join("\n");
}

/** Minimal unified-ish diff (LCS), enough to review a surgical patch. */
export function diffLines(beforeText, afterText, context = 2) {
  const a = String(beforeText ?? "").split("\n");
  const b = String(afterText ?? "").split("\n");
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push([" ", a[i++], j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  while (i < n) ops.push(["-", a[i++]]);
  while (j < m) ops.push(["+", b[j++]]);

  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, k) => {
    if (op[0] === " ") return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++)
      keep[x] = true;
  });
  const lines = [];
  let gap = false;
  ops.forEach((op, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap && lines.length > 0) lines.push("  …");
    gap = false;
    lines.push(`${op[0]} ${op[1]}`);
  });
  return lines.join("\n");
}

/** The Slack app manifest, public or private variant. */
export function manifestYaml(kind = "public") {
  const priv = kind === "private";
  return `_metadata:
  major_version: 2
  minor_version: 1
display_information:
  name: quickreview-concierge
  description: Review-system overseer in Slack (one channel, thread-per-PR)
features:
  bot_user:
    display_name: quickreview
    always_online: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - channels:history
      - channels:read
      - users:read
      ${priv ? "- groups:history" : "# - groups:history    # only if the channel is private"}
      ${priv ? "- groups:read" : "# - groups:read       # only if the channel is private"}
settings:
  socket_mode_enabled: true
  event_subscriptions:
    bot_events:
      - message.channels
      ${priv ? "- message.groups" : "# - message.groups    # only if the channel is private"}
  org_deploy_enabled: false
  token_rotation_enabled: false
`;
}

/**
 * The same conditions the daemon checks at boot (src/config.ts checkSlackShape +
 * the token-file check). Returns [{ ok, label, hint }].
 */
export function finalChecks(state) {
  const users = state.users instanceof Map ? Object.fromEntries(state.users) : (state.users ?? {});
  const id = String(state.legacy_owner_slack_id ?? "").trim();
  return [
    {
      ok: String(state.channel ?? "").trim() !== "",
      label: "channel is set",
      hint: "re-run the wizard and complete step 4",
    },
    {
      ok: state.channel_kind === "public" || state.channel_kind === "private",
      label: 'channel_kind is "public" or "private"',
      hint: "re-run the wizard and complete step 4",
    },
    {
      ok: id !== "",
      label: "legacy_owner_slack_id is set",
      hint: "re-run the wizard and complete step 5",
    },
    {
      ok: id !== "" && Object.prototype.hasOwnProperty.call(users, id),
      label: "legacy_owner_slack_id is a key in [slack.users]",
      hint: "boot fails otherwise — the owner's id must be in the identity map",
    },
    {
      ok: state.owner_id_conflict !== true,
      label: "[owner] slack_id and legacy [slack] legacy_owner_slack_id agree",
      hint: "boot fails otherwise — set `[owner] slack_id` only and empty the legacy key",
    },
    {
      ok: state.botTokenOk === true,
      label: "slack_bot_token file present and non-empty",
      hint: "re-run the wizard and complete step 2",
    },
    {
      ok: state.appTokenOk === true,
      label: "slack_app_token file present and non-empty",
      hint: "re-run the wizard and complete step 3",
    },
  ];
}

/** ~-expansion, the same rule src/config.ts uses. */
export function expandHome(p, home = homedir()) {
  const s = String(p ?? "");
  if (s === "~") return home;
  if (s.startsWith("~/")) return join(home, s.slice(2));
  return s;
}

/** [github].secrets_dir out of config.toml text (no TOML dependency here), as
 * written — "" when unset, which leaves the choice to the install locator. */
export function readSecretsDir(text) {
  const gh = sliceSection(String(text ?? ""), "[github]");
  const m = gh.body.match(/^\s*secrets_dir\s*=\s*(?:"([^"]*)"|'([^']*)')/m);
  return m ? (m[1] ?? m[2]) : "";
}

/**
 * Absolute paths of the two Slack token files, resolved as the daemon resolves
 * them: `[slack] bot_token_file` / `app_token_file` (default `slack_bot_token`
 * / `slack_app_token`), a bare name under `secretsDir`, an absolute or
 * ~-rooted name taken as given.
 */
export function slackTokenPaths(text, secretsDir, home = homedir()) {
  const section = sliceSection(String(text ?? ""), "[slack]");
  const pathOf = (key, fallback) => {
    const m = section.body.match(new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
    const name = expandHome(m ? (m[1] ?? m[2]) : fallback, home);
    return isAbsolute(name) ? name : join(secretsDir, name);
  };
  return {
    bot: pathOf("bot_token_file", "slack_bot_token"),
    app: pathOf("app_token_file", "slack_app_token"),
  };
}

// -------------------------------------------------------------------- runtime
// Below this line: I/O, prompts and network. Not covered by unit tests. It all
// lives inside main(), which runs only when this file is executed directly —
// importing the module (as the tests do) must never open a prompt.

// RUNTIME-BEGIN
async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const valueOf = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };

  if (flag("--help") || flag("-h")) {
    process.stdout.write(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .filter((l) => l.startsWith("//"))
        .map((l) => l.replace(/^\/\/ ?/, ""))
        .join("\n") + "\n",
    );
    process.exit(0);
  }

  const FORCE = flag("--force");
  const VERIFY = !flag("--no-verify");
  // The default is the install locator's answer ($QCR_CONFIG, else the
  // install's config home) — asked of its shell mirror, so this script builds
  // no config path of its own.
  const CONFIG_PATH = resolve(
    valueOf("--config", "") ||
      execFileSync(
        "bash",
        ["-c", '. "$1/scripts/install-locator.sh" && qcr_locate_config "$1"', "locate", REPO],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      ).trim(),
  );

  const out = (s = "") => process.stdout.write(`${s}\n`);
  const title = (s) => out(`\n${bold(s)}`);
  const ok = (s) => out(`  ${okMark} ${s}`);
  const bad = (s) => out(`  ${badMark} ${s}`);
  const info = (s) => out(`  · ${s}`);
  const para = (s) => out(`    ${s}`);

  let muted = false;
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  rl._writeToOutput = function (str) {
    if (!muted) this.output.write(str);
  };
  // Own line queue rather than rl.question(): with piped (non-TTY) stdin
  // readline emits every buffered line at once, and question() would keep only
  // the first. Queueing makes the wizard scriptable (`printf … | node …`).
  let stdinClosed = false;
  const queued = [];
  let waiting = null;
  rl.on("line", (line) => {
    if (waiting) {
      const resolve_ = waiting;
      waiting = null;
      resolve_(line);
    } else {
      queued.push(line);
    }
  });
  rl.on("close", () => {
    stdinClosed = true;
    if (waiting) {
      const resolve_ = waiting;
      waiting = null;
      resolve_(null);
    }
  });

  process.on("SIGINT", () => {
    out("\n  · interrupted — nothing half-written; re-run any time");
    process.exit(130);
  });

  const exhausted = () => stdinClosed && queued.length === 0;

  function readLine() {
    if (queued.length > 0) return Promise.resolve(queued.shift());
    if (stdinClosed) return Promise.resolve(null);
    return new Promise((res) => {
      waiting = res;
    });
  }

  async function ask(label, fallback = "") {
    if (exhausted()) return fallback;
    process.stdout.write(label);
    const answer = await readLine();
    if (answer === null) return fallback;
    return String(answer).trim();
  }

  async function askHidden(label) {
    if (exhausted()) return "";
    process.stdout.write(label);
    muted = true;
    try {
      const answer = await readLine();
      return answer === null ? "" : String(answer).trim();
    } finally {
      muted = false;
      process.stdout.write("\n");
    }
  }

  async function confirm(label, def = false) {
    const suffix = def ? "[Y/n]" : "[y/N]";
    const a = (await ask(`  ${label} ${suffix} `)).toLowerCase();
    if (a === "") return def;
    return a === "y" || a === "yes";
  }

  // ---- secrets dir -----------------------------------------------------------

  const configText = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
  if (!configText) {
    bad(`no config.toml at ${CONFIG_PATH} — pass --config <path>`);
    process.exit(1);
  }
  // --secrets-dir, then $QC_SECRETS_DIR, else the install locator's answer
  // (its shell mirror, as for the config above): the configured
  // [github] secrets_dir, else <config home>/secrets.
  const SECRETS_DIR = resolve(
    expandHome(
      valueOf("--secrets-dir", "") ||
        process.env.QC_SECRETS_DIR ||
        execFileSync(
          "bash",
          [
            "-c",
            '. "$1/scripts/install-locator.sh" && qcr_locate_secrets "$2"',
            "locate",
            REPO,
            readSecretsDir(configText),
          ],
          { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
        ).trim(),
    ),
  );
  const { bot: BOT_FILE, app: APP_FILE } = slackTokenPaths(configText, SECRETS_DIR);

  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(SECRETS_DIR, 0o700);
  } catch {
    /* not ours to chmod — fine */
  }

  function statusOf(path) {
    try {
      const st = statSync(path);
      if (st.size === 0) return "MISSING (empty file)";
      const when = new Date(st.mtimeMs).toISOString().slice(0, 16).replace("T", " ");
      return `present (${st.size} bytes, ${when})`;
    } catch {
      return "MISSING";
    }
  }

  const filePresent = (p) => {
    try {
      return readFileSync(p, "utf8").trim() !== "";
    } catch {
      return false;
    }
  };

  /**
   * Back up config.toml ONCE per run. Steps 6 and 7 both write, and a per-write
   * backup would leave `.bak` holding step 6's output — i.e. "before the last
   * write", not "before the wizard". This keeps the undo target honest.
   */
  let configBackedUp = false;
  function backupConfigOnce() {
    if (configBackedUp) return;
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    configBackedUp = true;
  }

  /** Save a secret: umask 077, tmp file + rename, chmod 600, never echoed. */
  function saveSecret(path, value) {
    const prev = process.umask(0o077);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, value, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } finally {
      process.umask(prev);
    }
  }

  /** Mirror of the bash wizard's `want`: skip existing files unless --force. */
  async function want(path, label) {
    if (!filePresent(path)) return true;
    if (!FORCE) {
      info(`${label} already present — keeping it (re-run with --force to replace)`);
      return false;
    }
    return await confirm(`${label} exists — replace it?`, false);
  }

  // ---- read-only Slack calls -------------------------------------------------

  async function slackCall(method, token, params = {}, httpMethod = "GET") {
    const url = new URL(`https://slack.com/api/${method}`);
    if (httpMethod === "GET")
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    try {
      const res = await fetch(url, {
        method: httpMethod,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(httpMethod === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: httpMethod === "POST" ? new URLSearchParams(params).toString() : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return data;
    } catch (err) {
      return {
        ok: false,
        error: `network_error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const SLACK_ERROR_HELP = {
    invalid_auth:
      "Slack rejected the token outright — it is wrong, revoked, or from another workspace. Copy it again from the app page.",
    not_authed: "no token reached Slack — the paste was probably truncated.",
    account_inactive: "the token belongs to a deactivated app/user.",
    token_revoked: "this token was revoked (re-installing the app revokes the previous bot token).",
    missing_scope:
      "the token is valid but the app lacks a scope — re-check the manifest, then re-install.",
    channel_not_found:
      "no channel with that id is visible to this bot. Wrong id, wrong workspace, or a private channel the bot was never invited to.",
    not_in_channel: "the bot is not a member of that channel — /invite @quickreview there.",
  };
  const explain = (code) => SLACK_ERROR_HELP[code] ?? `Slack said: ${code}`;

  // ---- step 0 — overview -----------------------------------------------------

  title("Slack concierge setup");
  info(`config      ${CONFIG_PATH}`);
  info(`secrets     ${SECRETS_DIR}`);
  if (!VERIFY) info("--no-verify: every Slack API call is skipped (offline run)");
  out();
  out(`  ${"slack_bot_token".padEnd(18)}${statusOf(BOT_FILE)}`);
  out(`  ${"slack_app_token".padEnd(18)}${statusOf(APP_FILE)}`);
  const current = readSlackValues(configText);
  out();
  info(`[slack] enabled          ${current.enabled}`);
  info(`[slack] channel          ${current.channel || "(empty)"}`);
  info(`[slack] channel_kind     ${current.channel_kind}`);
  info(`[slack] legacy_owner_slack_id ${current.legacy_owner_slack_id || "(empty)"}`);
  info(`[slack.users]            ${Object.keys(current.users).length} entries`);
  out();
  para("This wizard collects the two Slack tokens, picks the one channel, builds the");
  para("identity map and patches config.toml. It never deploys, never starts anything,");
  para("and never touches dry_run. Ctrl-C is safe at any point.");

  // ---- step 1 — create the Slack app ----------------------------------------

  title("Step 1 — create the Slack app");
  para("Go to https://api.slack.com/apps → “Create New App” → “From an app manifest”");
  para("→ pick the workspace → choose YAML → paste the manifest below → Next → Create.");
  out();
  para("If the app already exists you can skip this; the manifest can be re-applied later");
  para("under the app's “App Manifest” page (a scope change means re-installing, which");
  para("mints a NEW bot token — then re-run this wizard with --force).");
  out();
  out(
    manifestYaml("public")
      .split("\n")
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  para("PRIVATE channel variant: add `groups:history` to the bot scopes and");
  para("`message.groups` to the bot events — otherwise Socket Mode delivers nothing");
  para("from a private channel. Step 4 tells you which one you need.");
  out();
  if (
    await confirm(
      "write the manifest to a file you can open instead of copying from the terminal?",
      true,
    )
  ) {
    const manifestPath = join(REPO, "state", "slack-app-manifest.yaml");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, manifestYaml("public"));
    writeFileSync(join(REPO, "state", "slack-app-manifest-private.yaml"), manifestYaml("private"));
    ok(`wrote ${manifestPath} (and …-private.yaml) — state/ is gitignored`);
  }
  await ask("  press Enter when the app exists … ");

  // ---- step 2 — bot token ----------------------------------------------------

  title("Step 2 — the bot token (xoxb-…)");
  para("In the app: OAuth & Permissions → “Install to Workspace” → Allow → copy the");
  para("“Bot User OAuth Token” at the top of that page. It starts with xoxb-.");
  para("This is the token the daemon uses for every Web API call.");

  let botToken = filePresent(BOT_FILE) ? readFileSync(BOT_FILE, "utf8").trim() : "";
  if (await want(BOT_FILE, "slack_bot_token")) {
    for (;;) {
      const v = await askHidden(
        "  paste the bot token (input hidden, Enter to submit; empty to skip): ",
      );
      if (v === "") {
        info("skipped slack_bot_token");
        break;
      }
      const shape = tokenLooksValid("bot", v);
      if (!shape.ok) {
        bad(shape.reason);
        if (exhausted()) break;
        continue;
      }
      if (VERIFY) {
        const res = await slackCall("auth.test", v, {}, "POST");
        if (!res.ok) {
          bad(`auth.test failed — ${explain(res.error)}`);
          if (exhausted()) break;
          continue;
        }
        ok(`auth.test: workspace “${res.team}”, bot user ${res.user} (${res.user_id})`);
      }
      saveSecret(BOT_FILE, v);
      botToken = v;
      ok(`slack_bot_token saved — ${maskToken(v)}`);
      break;
    }
  }

  // ---- step 3 — app-level token ---------------------------------------------

  title("Step 3 — the app-level token (xapp-…)");
  para("DIFFERENT token, different page: Basic Information → App-Level Tokens →");
  para("“Generate Token and Scopes” → name it anything → add the scope connections:write");
  para("→ Generate → copy it. It starts with xapp- and is used ONLY to open the socket.");

  if (await want(APP_FILE, "slack_app_token")) {
    for (;;) {
      const v = await askHidden(
        "  paste the app-level token (input hidden, Enter to submit; empty to skip): ",
      );
      if (v === "") {
        info("skipped slack_app_token");
        break;
      }
      const shape = tokenLooksValid("app", v);
      if (!shape.ok) {
        bad(shape.reason);
        if (exhausted()) break;
        continue;
      }
      if (VERIFY) {
        const res = await slackCall("apps.connections.open", v, {}, "POST");
        if (!res.ok) {
          bad(`apps.connections.open failed — ${explain(res.error)}`);
          if (res.error === "missing_scope")
            para("the app-level token needs the connections:write scope");
          if (exhausted()) break;
          continue;
        }
        ok("apps.connections.open: ok — Socket Mode will connect (URL not dialled)");
      }
      saveSecret(APP_FILE, v);
      ok(`slack_app_token saved — ${maskToken(v)}`);
      break;
    }
  }

  // ---- step 4 — the channel --------------------------------------------------

  title("Step 4 — the ONE channel (the step people get wrong)");
  para("The concierge lives in exactly one channel. The bot MUST BE INVITED to it:");
  para("without membership Socket Mode delivers nothing, the daemon looks perfectly");
  para("healthy, and it is simply deaf. /invite @quickreview in that channel.");
  out();
  para("Paste the channel ID (C…) or the channel's “Copy link” URL.");
  para("Find the id: channel name → About → scroll to the bottom.");

  let channel = current.channel;
  let channelName = "";
  let channelKind = current.channel_kind || "public";

  for (;;) {
    const raw = await ask(`  channel id or link${channel ? ` [${channel}]` : ""}: `);
    if (raw === "" && channel) {
      info(`keeping ${channel}`);
      break;
    }
    const parsed = parseChannelId(raw);
    if (!parsed.ok) {
      bad(parsed.reason);
      if (exhausted()) break;
      continue;
    }
    channel = parsed.id;
    if (!VERIFY) {
      channelKind = (await confirm("is that a PRIVATE channel?", channelKind === "private"))
        ? "private"
        : "public";
      ok(`channel ${channel} (${channelKind}) — not verified (--no-verify)`);
      break;
    }
    if (!botToken) {
      bad("no bot token available to verify the channel — skipping the check");
      break;
    }
    let verified = false;
    for (;;) {
      const res = await slackCall("conversations.info", botToken, { channel });
      if (!res.ok) {
        bad(`conversations.info failed — ${explain(res.error)}`);
        break;
      }
      channelName = res.channel?.name ?? "";
      channelKind = res.channel?.is_private ? "private" : "public";
      ok(`#${channelName} — ${channelKind}`);
      if (res.channel?.is_member) {
        ok("the bot IS a member of this channel");
        verified = true;
        break;
      }
      bad("the bot is NOT a member — Socket Mode will deliver NOTHING from here");
      para(`remedy: open #${channelName} in Slack and type:   /invite @quickreview`);
      // Spent input ends the re-check: an empty answer would otherwise take
      // the [Y/n] default and poll Slack forever.
      if (exhausted() || !(await confirm("re-check now?", true))) break;
    }
    if (verified || exhausted()) break;
    if (!(await confirm("use a different channel?", false))) break;
  }

  if (channelKind === "private") {
    out();
    bad("PRIVATE channel — three consequences:");
    para(
      "1. the manifest needs `groups:history` and `groups:read` (bot scope) and `message.groups` (bot event);",
    );
    para("2. applying that manifest means re-installing, which mints a NEW bot token and");
    para("   revokes the current one;");
    para("3. after re-installing, re-run this wizard with --force and redo step 2.");
  }

  // ---- step 5 — identity map -------------------------------------------------

  title("Step 5 — the identity map ([slack.users])");
  para("[slack.users] maps Slack member id → GitHub login. It is the ONLY source of");
  para("identity: someone listed here is known by their GitHub login; the owner's id");
  para("must be a key. Slack is outbound-only today — inbound messages are not answered.");
  para("legacy_owner_slack_id is the single tier-M identity and MUST also be a key in the");
  para("map — the daemon refuses to boot otherwise.");

  const users = new Map(Object.entries(current.users));
  let directory = null;

  async function loadDirectory() {
    if (directory || !VERIFY || !botToken) return directory;
    const members = [];
    let cursor = "";
    for (let page = 0; page < 10; page++) {
      const res = await slackCall("users.list", botToken, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!res.ok) {
        bad(`users.list failed — ${explain(res.error)}`);
        return null;
      }
      for (const m of res.members ?? []) {
        if (m.deleted || m.is_bot || m.id === "USLACKBOT") continue;
        members.push({
          id: m.id,
          name: m.profile?.real_name || m.real_name || m.name || m.id,
          handle: m.name ?? "",
        });
      }
      cursor = res.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    directory = members;
    return directory;
  }

  /** Ask for one Slack member id: by directory search or a pasted U…. */
  async function askSlackId(label) {
    for (;;) {
      const dir = await loadDirectory();
      const hint = dir ? "type part of a name to search, or paste a U… id" : "paste the U… id";
      const raw = await ask(`  ${label} (${hint}, empty to stop): `);
      if (raw === "") return null;
      const parsed = parseUserId(raw);
      if (parsed.ok) return parsed.id;
      if (!dir) {
        bad(parsed.reason);
        if (exhausted()) return null;
        continue;
      }
      const needle = raw.toLowerCase();
      const hits = dir
        .filter(
          (m) => m.name.toLowerCase().includes(needle) || m.handle.toLowerCase().includes(needle),
        )
        .slice(0, 15);
      if (hits.length === 0) {
        bad(`no member matches “${raw}”`);
        if (exhausted()) return null;
        continue;
      }
      hits.forEach((m, i) =>
        out(`    ${String(i + 1).padStart(2)}. ${m.id} — ${m.name} (@${m.handle})`),
      );
      const pick = await ask("  number (Enter to search again): ");
      const idx = Number.parseInt(pick, 10);
      if (Number.isInteger(idx) && idx >= 1 && idx <= hits.length) return hits[idx - 1].id;
      if (exhausted()) return null;
    }
  }

  async function askLogin(forId) {
    for (;;) {
      const login = await ask(`  GitHub login for ${forId}: `);
      if (login === "") return null;
      if (looksLikeGithubLogin(login)) return login;
      bad("that does not look like a GitHub login (letters/digits and single hyphens, ≤ 39 chars)");
      if (exhausted()) return null;
    }
  }

  out();
  para("First: your own identity (tier-M).");
  let legacyOwnerSlackId = current.legacy_owner_slack_id;
  {
    const id = await askSlackId(
      `your Slack member id${legacyOwnerSlackId ? ` [${legacyOwnerSlackId}]` : ""}`,
    );
    if (id) legacyOwnerSlackId = id;
    if (legacyOwnerSlackId) {
      const existing = users.get(legacyOwnerSlackId);
      const login =
        existing && !FORCE ? existing : ((await askLogin(legacyOwnerSlackId)) ?? existing);
      if (login) {
        users.delete(legacyOwnerSlackId);
        const rest = [...users.entries()];
        users.clear();
        users.set(legacyOwnerSlackId, login);
        for (const [k, v] of rest) users.set(k, v);
        ok(`${legacyOwnerSlackId} → ${login} (tier-M)`);
      } else {
        bad("no GitHub login — legacy_owner_slack_id must be a key in [slack.users] or boot fails");
      }
    }
  }

  while (!exhausted() && (await confirm("add a teammate?", false))) {
    const id = await askSlackId("their Slack member id");
    if (!id) break;
    const login = await askLogin(id);
    if (!login) break;
    users.set(id, login);
    ok(`${id} → ${login}`);
  }

  // ---- step 6 — patch config.toml -------------------------------------------

  title("Step 6 — write config.toml");
  const values = {
    channel,
    channel_kind: channelKind,
    legacy_owner_slack_id: legacyOwnerSlackId,
    users,
    channelName,
  };
  out(renderSlackValues(values));
  const patched = patchConfigToml(configText, values);
  out();
  if (patched === configText) {
    info("config.toml already says exactly this — nothing to write");
  } else {
    out(diffLines(configText, patched, 2));
    out();
    para("Only these lines change. Comments, [slack.policy], [slack.policy.causes] and");
    para("`enabled` are untouched.");
    if (await confirm("apply this patch?", true)) {
      backupConfigOnce();
      const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
      writeFileSync(tmp, patched);
      renameSync(tmp, CONFIG_PATH);
      ok(`config.toml written (backup: ${CONFIG_PATH}.bak)`);
    } else {
      info("config.toml left alone");
    }
  }

  // ---- step 7 — enabling -----------------------------------------------------

  title("Step 7 — enabling the concierge");
  para("`enabled = true` is a deliberate act: with it on, a missing token file is a HARD");
  para("startup error, never a silent read-only mode. And flipping it here changes only");
  para("your laptop's config — the VM still runs the old one until you deploy.");
  const nowText = readFileSync(CONFIG_PATH, "utf8");
  if (readSlackValues(nowText).enabled) {
    info("[slack] enabled is already true");
  } else if (await confirm("set enabled = true now?", false)) {
    const flipped = enableSlack(nowText);
    backupConfigOnce();
    const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
    writeFileSync(tmp, flipped);
    renameSync(tmp, CONFIG_PATH);
    ok("enabled = true");
  } else {
    info("left disabled — re-run this wizard (or edit the one line) when you are ready");
  }

  // ---- step 8 — final check --------------------------------------------------

  title("Step 8 — boot readiness (the same conditions the daemon checks)");
  const finalText = readFileSync(CONFIG_PATH, "utf8");
  const finalValues = readSlackValues(finalText);
  const checks = finalChecks({
    ...finalValues,
    botTokenOk: filePresent(BOT_FILE),
    appTokenOk: filePresent(APP_FILE),
  });
  for (const c of checks) {
    if (c.ok) ok(c.label);
    else {
      bad(c.label);
      para(c.hint);
    }
  }
  out();
  if (checks.every((c) => c.ok)) {
    ok("Slack setup is complete.");
  } else {
    bad("not ready yet — re-run this wizard to fill the gaps.");
  }
  out();
  para("This wizard does NOT deploy and does NOT start anything. The VM daemon is");
  para("intentionally stopped. When you are ready, ship the config home with a release:");
  out();
  out(`    ${bold("./scripts/deploy.sh release <version>")}`);
  out();

  rl.close();
}
// RUNTIME-END

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
