// "Is this ours?" — the one answer, for every credential mode.
//
// Under `[github] auth = "app"` the system posts as a GitHub App, whose
// account is a bot account: everything under its login (`<slug>[bot]`, or the
// bare slug GraphQL names the same actor by) is the system's, and a PR that
// account opened is a bot's PR.
//
// Under `auth = "installation"` the identity is the same kind: an App's bot
// account, named by `app_slug`. Only where the token comes from differs (a
// host supplies it; no App key is here), and nothing in this file asks that.
// Every rule below that is not person mode's holds for it as for "app".
//
// Under `auth = "user"` ("person mode") the system posts AS the person, on
// their own token. The login then carries two kinds of words: the person's
// own and the reviewer's. So the login alone proves nothing; the reviewer's
// content is told apart by what only it writes — one of its hidden inert
// `<!-- qcr… -->` markers, or the review footer. A comment by the same login
// without either is the person's, and is treated as a human's. And no PR is a
// bot's PR for being the person's: their own PRs are the main target.
//
// The sites that decide either question read it here: `isOwnContent` for "is
// this review or comment the reviewer's", `botAccountLogin` for "which login
// is a bot account" (PR authorship, human-comment capture).
import type { GithubAuthMode, GithubConfig } from "./reviewconfig.js";

/** What the identity rules read off `[github]`. */
export type GithubIdentity = Pick<GithubConfig, "auth" | "bot_login" | "app_slug">;

export function authMode(g: Pick<GithubConfig, "auth">): GithubAuthMode {
  return g.auth === "user" || g.auth === "installation" ? g.auth : "app";
}

/** `[github] auth = "user"`: the person's own credential, posting as them.
 * The one mode whose reviews are all COMMENTs. An App installation's token
 * read from a file is not it: what a review may say follows who posts it,
 * never where the token was read from. */
export function isPersonMode(g: Pick<GithubConfig, "auth">): boolean {
  return authMode(g) === "user";
}

/** `[github] auth = "installation"`: an App installation's identity on a
 * token its host supplies. */
export function isInstallationMode(g: Pick<GithubConfig, "auth">): boolean {
  return authMode(g) === "installation";
}

/** Is the credential the token file (`<secrets dir>/github_token`)? True of
 * the person's own token and of a host-supplied installation token: under
 * either there is no App key, App id or webhook secret to read, no App JWT,
 * and so no webhook and no App self-config. The modes are the config's
 * `TOKEN_FILE_AUTH_MODES` (reviewconfig.ts), spelled out here because this
 * module imports types only: nothing that reads the identity rules can reach
 * a runtime module through them (tests/review-history.test.ts). */
export function usesTokenFile(g: Pick<GithubConfig, "auth">): boolean {
  const mode = authMode(g);
  return mode === "user" || mode === "installation";
}

/** Every hidden marker the system writes opens `<!-- qcr-` or `<!-- qcr:`
 * (posting key, finding, round, recheck, reply, migration, escalation,
 * filing, author response). */
const OWN_MARKER_RE = /<!--\s*qcr[-:]/;
/** The review footer's fixed words (`renderedFooter`, reviewrender.ts). */
const OWN_FOOTER_RE = /\(quickreview sandbox\)/;

/** The body carries something only the reviewer writes. */
export function carriesOwnMarker(body: string | null | undefined): boolean {
  if (typeof body !== "string" || body === "") return false;
  return OWN_MARKER_RE.test(body) || OWN_FOOTER_RE.test(body);
}

/** The logins the reviewer's content is posted under. App mode: the
 * configured bot login and the App's `<slug>[bot]` (when a slug is set).
 * Person mode: the person's login alone. Never an empty string. */
export function ownLogins(g: GithubIdentity): string[] {
  const out = new Set<string>();
  if (g.bot_login) out.add(g.bot_login);
  if (!isPersonMode(g) && g.app_slug) out.add(`${g.app_slug}[bot]`);
  return [...out];
}

/** GraphQL's bare App actor, only for a matching configured bot login, and
 * never in person mode (there is no App). */
export function ownActorAlias(g: GithubIdentity): string | undefined {
  if (isPersonMode(g) || !g.app_slug) return undefined;
  return g.bot_login === `${g.app_slug}[bot]` ? g.app_slug : undefined;
}

/**
 * Is this review or comment the reviewer's own? App mode: by its login (one
 * of `ownLogins`, or the bare App actor), as it always was. Person mode: by
 * the person's login AND a marker or the footer in its body — a comment the
 * person typed themselves is a human comment.
 */
export function isOwnContent(
  g: GithubIdentity,
  author: string | null | undefined,
  body: string | null | undefined,
): boolean {
  const login = author ?? "";
  if (login === "") return false;
  if (isPersonMode(g)) return login === g.bot_login && carriesOwnMarker(body);
  return ownLogins(g).includes(login) || login === ownActorAlias(g);
}

/**
 * The login that is a BOT ACCOUNT, for the questions "is this PR a bot's PR"
 * and "is this captured comment a bot's": the App's login in app mode, and ""
 * in person mode — there the person's login is a person's, and only the
 * `[bot]`-suffixed / `Bot`-typed accounts the call sites already exclude are
 * bots.
 */
export function botAccountLogin(g: GithubIdentity): string {
  return isPersonMode(g) ? "" : g.bot_login;
}

/** The search qualifier that keeps the App's own PRs out of a search, or ""
 * when there is no App slug (person mode, or an unset slug). */
export function excludeOwnAppQualifier(g: GithubIdentity): string {
  return !isPersonMode(g) && g.app_slug ? ` -author:app/${g.app_slug}` : "";
}
