// Security facts: deterministic checks over the repository's files that a
// model reading the diff cannot settle — "is it really in force". Computed by
// the daemon, rendered into the security family's task files, never posted.
//
// Seven checks, cheapest first:
//
//   removed-guard            a removed line carrying a guard marker that the
//                            same file does not add back       (diff only)
//   role-enum-shift          a role or permission list whose member order or
//                            values changed                    (diff only)
//   unique-without-index     an added uniqueness check in code with no unique
//                            constraint on that column in the schema files
//   unattached-security-group  a Terraform security group the PR touches that
//                            nothing attaches
//   compose-port-ufw         a deploy compose file publishing a port on every
//                            interface in a repository that configures ufw
//                            (Docker's published ports bypass ufw)
//   networkpolicy-selector   a NetworkPolicy whose podSelector matches no
//                            workload template's labels
//   route-inventory          route registrations in the changed directories
//                            and route-like files
//
// Honest unknown. A check that could not run says `unknown` and why — no io,
// a listing or read that failed, templated manifests, a reference passed
// through a module — and never "clear". `clear` covers only what its check
// read, and a check whose subject the PR does not touch (no Terraform, no
// compose file) says so as `clear` with that reason, which needs no read.
//
// No new dependency: everything is a line parser over text the host reads
// through read-only git (`git show <sha>:<path>`, `git ls-tree`). Nothing is
// rendered or executed — no terraform, helm or YAML library. Pure: the host
// passes the I/O in; `null` io runs the two diff-only checks alone.

import type { PrFileEntry } from "./githubcore.js";
import { codePath } from "./codespan.js";
import { globMatcher } from "./glob.js";
import { parseHunkHeader } from "./hunkheader.js";

export type SecFactCheck =
  | "removed-guard"
  | "role-enum-shift"
  | "unique-without-index"
  | "unattached-security-group"
  | "compose-port-ufw"
  | "networkpolicy-selector"
  | "route-inventory";

export interface SecurityFact {
  check: SecFactCheck;
  status: "found" | "clear" | "unknown";
  /** The family lens the fact speaks to. */
  lens: string;
  file?: string;
  /** A head line in `file` (a removed line names its base line in `detail`
   * instead, since it has no head line). */
  line?: number;
  /** One sentence, author-controlled pieces already rendered as code spans. */
  detail: string;
  /** For a list-shaped fact (the route inventory): one rendered entry each. */
  items?: string[];
}

export interface SecurityFactsIo {
  /** A file's text at the PR head, or null when it cannot be read. */
  readHead(path: string): string | null;
  /** A file's text at the PR base, or null when it cannot be read. */
  readBase(path: string): string | null;
  /** Every path at the PR head, or null when the listing failed. */
  listHead(): readonly string[] | null;
}

/** The lens each check speaks to. */
export const SEC_FACT_LENS: Readonly<Record<SecFactCheck, string>> = {
  "removed-guard": "pass-sec-authn-coverage",
  "role-enum-shift": "pass-sec-privesc",
  "unique-without-index": "pass-sec-toctou",
  "unattached-security-group": "pass-sec-infra",
  "compose-port-ufw": "pass-sec-infra",
  "networkpolicy-selector": "pass-sec-infra",
  "route-inventory": "pass-sec-authn-coverage",
};

/** The checks, cheapest first — the order facts are computed and rendered. */
export const SEC_FACT_CHECKS: readonly SecFactCheck[] = [
  "removed-guard",
  "role-enum-shift",
  "unique-without-index",
  "unattached-security-group",
  "compose-port-ufw",
  "networkpolicy-selector",
  "route-inventory",
];

/** The most files any one check reads from the repository. */
export const SECURITY_FACTS_MAX_FILES = 400;
/** The most routes the inventory lists. */
export const ROUTE_INVENTORY_MAX_ENTRIES = 200;
/** The most `found` facts one check reports; the rest are counted. */
const MAX_FOUND_PER_CHECK = 10;

export const SECURITY_FACTS_HEADING =
  "Security facts (computed from the repository, not by a model)";

// ---------------------------------------------------------------------------
// Paths and patches

const DOC_RE =
  /\.(?:md|markdown|txt|rst|adoc)$|(?:^|\/)docs?\/|(?:^|\/)(?:LICENSE|COPYING|NOTICE)[^/]*$/i;
const TEST_RE =
  /(?:^|\/)(?:tests?|__tests__|specs?|testdata|fixtures?|e2e)\/|[._-](?:test|spec)\.[A-Za-z]+$|(?:^|\/)test_[^/]+\.py$|_test\.go$/i;
const BINARY_RE =
  /\.(?:png|jpe?g|gif|webp|ico|bmp|svg|pdf|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|jar|war|class|so|dylib|dll|exe|bin|wasm|mp[34]|mov|webm|lock)$/i;
const CODE_RE = /\.(?:py|rb|js|mjs|cjs|jsx|ts|tsx|go|java|kt|kts|scala|cs|php|ex|exs|rs|swift)$/;
const YAML_RE = /\.ya?ml$/i;
const TF_RE = /\.tf$/;

function isProse(path: string): boolean {
  return DOC_RE.test(path);
}
function isTest(path: string): boolean {
  return TEST_RE.test(path);
}

interface DiffLine {
  kind: "+" | "-" | " ";
  text: string;
  /** The head line for "+" and " ", the base line for "-". */
  line: number;
}
export interface Hunk {
  /** The text after the `@@ … @@` header (git's enclosing-scope hint). */
  scope: string;
  lines: DiffLine[];
}

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldN = 0;
  let newN = 0;
  for (const raw of patch.split("\n")) {
    const h = parseHunkHeader(raw);
    if (h) {
      cur = { scope: raw.replace(/^@@[^@]*@@\s?/, ""), lines: [] };
      hunks.push(cur);
      oldN = h.old_start;
      newN = h.new_start;
      continue;
    }
    if (!cur || raw === "" || raw.startsWith("\\")) continue;
    if (raw[0] === "+") cur.lines.push({ kind: "+", text: raw.slice(1), line: newN++ });
    else if (raw[0] === "-") cur.lines.push({ kind: "-", text: raw.slice(1), line: oldN++ });
    else {
      cur.lines.push({ kind: " ", text: raw.slice(1), line: newN++ });
      oldN++;
    }
  }
  return hunks;
}

/** A whole-line comment in the common languages (a `#[attr]` or a C#
 * `[Attribute]` is not one). */
const COMMENT_RE = /^\s*(?:#(?!\[)|\/\/|\/\*|\*|--\s|<!--)/;

/** A line of author code as a short code span. */
function snippet(text: string): string {
  const t = text.trim();
  return codePath(t.length > 120 ? `${t.slice(0, 117)}...` : t);
}

/** PR files the diff-only checks read: patched, not prose, not tests. A
 * deleted file with no patch is unread only for a check that reads what a
 * deletion takes away (`removedUnread`): to the others it changes nothing. */
function patchedFiles(
  files: readonly PrFileEntry[],
  opts: { removedUnread?: boolean } = {},
): {
  patched: { file: PrFileEntry; hunks: Hunk[] }[];
  unread: string[];
} {
  const patched: { file: PrFileEntry; hunks: Hunk[] }[] = [];
  const unread: string[] = [];
  for (const f of files) {
    if (isProse(f.filename) || isTest(f.filename) || BINARY_RE.test(f.filename)) continue;
    if (f.patch === undefined) {
      if (f.status !== "removed" || opts.removedUnread) unread.push(f.filename);
      continue;
    }
    patched.push({ file: f, hunks: parsePatch(f.patch) });
  }
  return { patched, unread };
}

function unreadFact(check: SecFactCheck, unread: readonly string[]): SecurityFact {
  const shown = unread
    .slice(0, 5)
    .map((p) => codePath(p))
    .join(", ");
  const more = unread.length > 5 ? ` and ${unread.length - 5} more` : "";
  return {
    check,
    status: "unknown",
    lens: SEC_FACT_LENS[check],
    detail: `${unread.length} changed file(s) came without a patch, so their lines could not be read: ${shown}${more}`,
  };
}

function fact(
  check: SecFactCheck,
  status: SecurityFact["status"],
  detail: string,
  at: { file?: string; line?: number } = {},
): SecurityFact {
  return {
    check,
    status,
    lens: SEC_FACT_LENS[check],
    ...(at.file !== undefined ? { file: at.file } : {}),
    ...(at.line !== undefined ? { line: at.line } : {}),
    detail,
  };
}

/** At most `MAX_FOUND_PER_CHECK` found facts, the last one counting the rest. */
function capFound(found: SecurityFact[]): SecurityFact[] {
  if (found.length <= MAX_FOUND_PER_CHECK) return found;
  const kept = found.slice(0, MAX_FOUND_PER_CHECK);
  const last = kept[kept.length - 1]!;
  kept[kept.length - 1] = {
    ...last,
    detail: `${last.detail} (and ${found.length - MAX_FOUND_PER_CHECK} more like it, not listed)`,
  };
  return kept;
}

/** Repository files for an io check: the head listing filtered, capped. */
type Listing = { paths: string[]; capped: boolean } | null;
function listFiles(io: SecurityFactsIo, keep: (path: string) => boolean): Listing {
  let all: readonly string[] | null;
  try {
    all = io.listHead();
  } catch {
    all = null;
  }
  if (all === null) return null;
  const paths = all.filter(keep);
  return {
    paths: paths.slice(0, SECURITY_FACTS_MAX_FILES),
    capped: paths.length > SECURITY_FACTS_MAX_FILES,
  };
}

/** Read each path at the head; the ones that failed are listed apart. */
function readAll(
  io: SecurityFactsIo,
  paths: readonly string[],
): { texts: Map<string, string>; failed: string[] } {
  const texts = new Map<string, string>();
  const failed: string[] = [];
  for (const p of paths) {
    let text: string | null;
    try {
      text = io.readHead(p);
    } catch {
      text = null;
    }
    if (text === null) failed.push(p);
    else texts.set(p, text);
  }
  return { texts, failed };
}

const NO_IO = "the repository files were not available to read";
const NO_LISTING = "the repository's file listing could not be read";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// removed-guard

/** A line that only imports a name: Python `import`/`from … import`, an ES
 * `import`, a CommonJS `require`, PHP/Rust `use`, Ruby `require`, C#
 * `using`. Dropping an unused import of a guard is a cleanup, never a
 * removed guard; the guard's removal is its decorator, middleware or call
 * line.
 *
 * Both patterns run over diff lines a pull request's author wrote, inside
 * the daemon's own loop, so each admits one parse of a line: no two
 * quantifiers may compete for the same characters. */
const IMPORT_LINE_RE =
  /^\s*(?:import\b|from\s+[\w.]+\s+import\b|(?:const|let|var)\s+(?:\{[^}]*\}|[\w$]+)\s*=\s*require\s*\(|use\s+[\w\\:]+|require(?:_relative)?\s*(?:\(\s*)?["']|using\s+[\w.]+\s*;)/;
/** A member line inside a multi-line import (`login_required,`, `)`,
 * `} from './auth';`): names (an `as` alias is two more names) separated by
 * spaces or one comma, then the closing bracket. Each name and its
 * separator is taken whole, an atomic group (`(?=(…))\1`), because a
 * repeated `[\w.$]+` that may split anywhere backtracks exponentially on a
 * long name followed by a non-member character (`from a.long.module
 * import (`). */
const IMPORT_MEMBER_RE =
  /^\s*(?:(?=([\w.$]+\s*,?\s*))\1)*(?:[)}]\s*(?:from\s+["'][^"'\n]*["']\s*)?(?:;\s*)?)?$/;

/**
 * Which of `lines` (one side of a diff, in order) belong to an import
 * statement — the opener and, for a bracketed multi-line import, each
 * member line after it up to the closing bracket. A line that is not an
 * import member ends the statement and is judged on its own, so a removed
 * import opener never hides a removed decorator further down.
 */
export function importLineMask(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let close: ")" | "}" | null = null;
  for (const line of lines) {
    if (close !== null && IMPORT_MEMBER_RE.test(line)) {
      out.push(true);
      if (line.includes(close)) close = null;
      continue;
    }
    close = null;
    const isImport = IMPORT_LINE_RE.test(line);
    out.push(isImport);
    if (!isImport) continue;
    if (line.lastIndexOf("(") > line.lastIndexOf(")")) close = ")";
    else if (line.lastIndexOf("{") > line.lastIndexOf("}")) close = "}";
  }
  return out;
}

/** `lines` without the ones `importLineMask` marks. */
function withoutImports<T>(lines: readonly T[], text: (l: T) => string): T[] {
  const mask = importLineMask(lines.map(text));
  return lines.filter((_, i) => !mask[i]);
}

/** Guard markers: an authentication or authorisation check, or certificate
 * verification, whose removal leaves something unguarded. */
const GUARD_MARKERS: readonly { name: string; re: RegExp }[] = [
  { name: "login_required", re: /\blogin_required\b/ },
  { name: "permission_required", re: /\bpermission_required\b/ },
  { name: "permission_classes", re: /\bpermission_classes\b/ },
  { name: "authentication_classes", re: /\bauthentication_classes\b/ },
  { name: "IsAuthenticated", re: /\bIs(?:Authenticated|AdminUser)\w*/ },
  { name: "@UseGuards", re: /@UseGuards\b/ },
  { name: "@PreAuthorize", re: /@(?:PreAuthorize|PostAuthorize|Secured|RolesAllowed)\b/ },
  { name: "[Authorize]", re: /\[Authorize\b/ },
  { name: "authorize", re: /\b(?:load_and_)?authorize(?:_resource\b|!|\(|\s+[@:\w])/ },
  { name: "requireAuth", re: /\brequire_?(?:auth\w*|login|admin|role|permission)s?\b/i },
  {
    name: "before_action :authenticate",
    re: /\b(?:before_action|before_filter|prepend_before_action)\s+:(?:authenticate|authorize|require_login|ensure_\w*(?:auth|admin|login))/,
  },
  { name: "*_required", re: /\b(?:auth|jwt|fresh_jwt|token|admin|staff_member)_required\b/ },
  { name: "requires_auth", re: /\brequires_auth\w*/ },
  { name: "ensureAuthenticated", re: /\b(?:ensure|is)Authenticated\b|\bpassport\.authenticate\b/ },
  { name: "auth middleware", re: /\b\w*[Aa]uth\w*[Mm]iddleware\b/ },
  {
    name: ".authenticated()",
    re: /\.(?:authenticated|hasRole|hasAnyRole|hasAuthority|hasAnyAuthority)\(/,
  },
  { name: "has_permission", re: /\b(?:check|has|requires?)_?[Pp]erm(?:ission)?s?\b/ },
  // A keyword argument (`get(url, verify=ca)`, or `verify=ca,` on a line of
  // its own), never a variable named verify (`const verify = createVerify()`).
  {
    name: "verify=",
    re: /(?:[(,]\s*verify\s*=|^\s*verify=)(?!=)(?!\s*(?:False|false|0)\b)/,
  },
];

function removedGuard(files: readonly PrFileEntry[]): SecurityFact[] {
  // A deleted file is the most direct removal of all: every guard it held is
  // gone, with nothing added back.
  const { patched, unread } = patchedFiles(files, { removedUnread: true });
  const found: SecurityFact[] = [];
  for (const { file, hunks } of patched) {
    const deleted = file.status === "removed";
    const lines = hunks.flatMap((h) => h.lines).filter((l) => !COMMENT_RE.test(l.text));
    // Import lines count on neither side: a dropped unused import is not a
    // removed guard, and a re-ordered one does not put a removed one back.
    const side = (kind: "+" | "-") =>
      withoutImports(
        lines.filter((l) => l.kind === kind),
        (l) => l.text,
      );
    const minus = side("-");
    const plus = side("+");
    for (const marker of GUARD_MARKERS) {
      const removed = minus.filter((l) => marker.re.test(l.text));
      if (removed.length === 0) continue;
      const added = plus.filter((l) => marker.re.test(l.text)).length;
      if (removed.length <= added) continue;
      const first = removed[0]!;
      found.push(
        fact(
          "removed-guard",
          "found",
          deleted
            ? `deletes the file; its base line ${first.line} carried ${snippet(first.text)}${removed.length > 1 ? ` (and ${removed.length - 1} more \`${marker.name}\` line(s))` : ""}`
            : added === 0
              ? `removes ${snippet(first.text)} (base line ${first.line}) and adds no \`${marker.name}\` back in this file`
              : `removes ${removed.length} \`${marker.name}\` line(s) and adds back ${added}; the first removed is ${snippet(first.text)} (base line ${first.line})`,
          { file: file.filename },
        ),
      );
    }
  }
  const out = capFound(found);
  if (unread.length) out.push(unreadFact("removed-guard", unread));
  if (out.length === 0)
    out.push(
      fact(
        "removed-guard",
        "clear",
        `no guard marker is removed without a re-add, across ${patched.length} patched file(s)`,
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// role-enum-shift

/** A role or permission list's declaration: a type named for roles, or a
 * collection named for them (`class Role(Enum)`, `enum UserRole`,
 * `ALLOWED_ROLES = [`, `type Role int`). */
const ROLE_DECL_RE =
  /\b(?:enum|class|interface|type|object)\s+\w*(?:Role|Permission|Privilege|Scope|AccessLevel|Grant|Authority)\w*|\b\w*(?:ROLES|PERMISSIONS|PRIVILEGES|SCOPES|GRANTS|[rR]oles|[pP]ermissions|[sS]copes)\b\s*(?::[^=\n]*)?=/;
const ROLE_WORD_RE =
  /^(?:admin|administrator|owner|superuser|super_?admin|editor|viewer|member|guest|staff|moderator|maintainer|reader|writer|read|write|manager|operator|root|auditor)$/i;

/** The list members a line declares: quoted words in a list literal, an
 * enum member with a value (`ADMIN = 1`, `Admin: "admin",`), or a bare enum
 * member (`Admin,`) — `bare` true for the last, whose value is its position. */
function membersOf(text: string): { members: string[]; bare: boolean } {
  const t = text.trim();
  if (t === "" || COMMENT_RE.test(t)) return { members: [], bare: false };
  const single = /^["']([\w:.-]+)["']\s*,?\s*[\])]?\s*,?$/.exec(t);
  if (single) return { members: [single[1]!], bare: false };
  if (/[[({]/.test(t) && /["'][\w:.-]+["']\s*,\s*["']/.test(t))
    return { members: [...t.matchAll(/["']([\w:.-]+)["']/g)].map((m) => m[1]!), bare: false };
  const valued = /^([A-Z][A-Za-z0-9_]*)(?:\s+[A-Z]\w*)?\s*(?:=|:)\s*([^=,;{}]+?)\s*[,;]?$/.exec(t);
  if (valued) return { members: [`${valued[1]}=${valued[2]!.replace(/\s+/g, "")}`], bare: false };
  const bare = /^([A-Z][A-Za-z0-9_]*)\s*,?$/.exec(t);
  if (bare) return { members: [bare[1]!], bare: true };
  return { members: [], bare: false };
}

function memberName(m: string): string {
  return m
    .split("=")[0]!
    .replace(/^(?:ROLE|Role|PERM|Perm|Permission|PERMISSION)_?/, "")
    .toLowerCase();
}

function sameSeq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function roleEnumShift(files: readonly PrFileEntry[]): SecurityFact[] {
  const { patched, unread } = patchedFiles(files);
  const found: SecurityFact[] = [];
  for (const { file, hunks } of patched) {
    if (file.status === "removed") continue;
    for (const hunk of hunks) {
      const parsed = hunk.lines.map((l) => ({ l, ...membersOf(l.text) }));
      const context = `${hunk.scope}\n${hunk.lines.map((l) => l.text).join("\n")}`;
      const changed = parsed.filter((p) => p.l.kind !== " ").flatMap((p) => p.members);
      const roleish =
        ROLE_DECL_RE.test(context) || changed.some((m) => ROLE_WORD_RE.test(memberName(m)));
      if (!roleish) continue;
      const before = parsed.filter((p) => p.l.kind === "-").flatMap((p) => p.members);
      const after = parsed.filter((p) => p.l.kind === "+").flatMap((p) => p.members);
      const at = parsed.find((p) => p.l.kind === "+" && p.members.length)?.l;
      const where = at ? { file: file.filename, line: at.line } : { file: file.filename };
      if (before.length > 0 && !sameSeq(before, after)) {
        // Appending new members after the old ones keeps every old value.
        if (sameSeq(before, after.slice(0, before.length))) continue;
        const sameSet =
          before.length === after.length && [...before].sort().join() === [...after].sort().join();
        const list = (xs: readonly string[]) =>
          xs
            .slice(0, 8)
            .map((x) => codePath(x))
            .join(", ") + (xs.length > 8 ? ", ..." : "");
        found.push(
          fact(
            "role-enum-shift",
            "found",
            sameSet
              ? `a role or permission list changes member order: before ${list(before)}; after ${list(after)}`
              : `a role or permission list changes in place: removed ${list(before.filter((m) => !after.includes(m))) || "none"}; added ${list(after.filter((m) => !before.includes(m))) || "none"}`,
            where,
          ),
        );
        continue;
      }
      // A bare member inserted before an existing bare member shifts the
      // implicit value of every member after it.
      const insertAt = parsed.findIndex((p) => p.bare && p.l.kind === "+");
      if (insertAt < 0) continue;
      const shifted = parsed.slice(insertAt + 1).find((p) => p.bare && p.l.kind === " ");
      if (!shifted) continue;
      const inserted = parsed[insertAt]!;
      found.push(
        fact(
          "role-enum-shift",
          "found",
          `${codePath(inserted.members[0]!)} is inserted before ${codePath(shifted.members[0]!)} in a role or permission enum with implicit values, which shifts the value of every member after it`,
          { file: file.filename, line: inserted.l.line },
        ),
      );
    }
  }
  const out = capFound(found);
  if (unread.length) out.push(unreadFact("role-enum-shift", unread));
  if (out.length === 0)
    out.push(
      fact(
        "role-enum-shift",
        "clear",
        `no role or permission list changes member order or values, across ${patched.length} patched file(s)`,
      ),
    );
  return out;
}

// ---------------------------------------------------------------------------
// unique-without-index

/** Uniqueness checks in code: group 1 is the column. `needsCreate`: the
 * shape is an ordinary read unless the same file also adds a create — an
 * existence check (`.filter(user=…).exists()`, `exists?(…)`) is the most
 * common read there is, and only a check-then-insert is the race. The
 * `get_or_create` and `validates … uniqueness` shapes always create. */
const UNIQUE_CHECKS: readonly { shape: string; re: RegExp; needsCreate: boolean }[] = [
  {
    shape: ".filter(...).exists() then create",
    re: /\.filter\(\s*(\w+?)(?:__i?exact)?\s*=[^\n]*\)\s*\.exists\(\)/,
    needsCreate: true,
  },
  {
    shape: "exists?(...) then create",
    re: /\bexists\?\(\s*:?(\w+)\s*(?::|=>)/,
    needsCreate: true,
  },
  {
    shape: "validates ... uniqueness",
    re: /\bvalidates\s+:(\w+)\b[^\n]*\buniqueness\b/,
    needsCreate: false,
  },
  {
    shape: "validates_uniqueness_of",
    re: /\bvalidates_uniqueness_of\s+:(\w+)/,
    needsCreate: false,
  },
  {
    shape: "get_or_create(...)",
    re: /\b(?:get_or_create|update_or_create)\(\s*(\w+?)(?:__i?exact)?\s*=/,
    needsCreate: false,
  },
  {
    shape: "findOne(...) then create",
    re: /\b(?:findOne|findFirst|findOneBy)\(\s*\{\s*(?:where\s*:\s*\{\s*)?(\w+)\b/,
    needsCreate: true,
  },
  { shape: "find_by(...) then create", re: /\bfind_by\(\s*:?(\w+)\s*(?::|=>)/, needsCreate: true },
  {
    shape: "filter_by(...).first() then create",
    re: /\.filter_by\(\s*(\w+)\s*=[^\n]*\)\s*\.(?:first|one_or_none)\(\)/,
    needsCreate: true,
  },
];
const CREATE_RE = /\b(?:create|insert|save|add)\w*\s*\(|\bnew\s+[A-Z]\w*\(/i;
const KEY_COLUMNS = new Set(["id", "pk", "uuid", "where"]);

export const SCHEMA_PATH_RE =
  /(?:^|\/)(?:migrations?|migrate|alembic|db|database|schemas?|models?|entities|entity|prisma)(?:\/|\.[A-Za-z]+$)|\.sql$|\.prisma$/i;
const SCHEMA_EXT_RE = /\.(?:py|rb|ts|js|mjs|cjs|go|java|kt|cs|php|ex|exs|scala|sql|prisma)$/;

/**
 * `UNIQUE INDEX|KEY …(… col …)`: a bracket opened within 200 characters of
 * the keyword, with no `;` before it, whose contents name the column (`c`,
 * already escaped). Scanned rather than matched by one pattern, because
 * `\(\s*[^)]*\bcol\b[^)]*\)` over many brackets and many mentions of the
 * column is polynomial in a file a pull request's author can write: each
 * mention is found once, and each bracket asks only whether one falls
 * inside it.
 */
function uniqueKeyOn(text: string, c: string): boolean {
  const at: number[] = [];
  const end: number[] = [];
  for (const m of text.matchAll(new RegExp(`\\b${c}\\b`, "gi"))) {
    at.push(m.index);
    end.push(m.index + m[0].length);
  }
  if (at.length === 0) return false;
  // The first mention starting at or after `pos`.
  const firstFrom = (pos: number): number => {
    let lo = 0;
    let hi = at.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  let searchedFrom = -1;
  let close = -1;
  for (const m of text.matchAll(/\bunique\s+(?:index|key)\b/gi)) {
    const from = m.index + m[0].length;
    for (let o = from; o <= from + 200 && o < text.length; o++) {
      const ch = text[o];
      if (ch === ";") break;
      if (ch !== "(") continue;
      // No `)` lies between a search start and the `)` it found, so one
      // search answers every bracket opened in that span.
      if (!(searchedFrom >= 0 && searchedFrom <= o + 1 && (close < 0 || o + 1 <= close))) {
        searchedFrom = o + 1;
        close = text.indexOf(")", o + 1);
      }
      if (close < 0) break;
      const i = firstFrom(o + 1);
      if (i < at.length && end[i]! <= close) return true;
    }
  }
  return false;
}

/** Whether `text` declares a unique constraint or unique index on `col`. */
export function hasUniqueConstraint(text: string, col: string): boolean {
  const c = escapeRe(col);
  const wide: RegExp[] = [
    new RegExp(`UniqueConstraint\\(\\s*(?:fields\\s*=\\s*)?[\\[(]?[^)\\]]{0,300}?['"]${c}['"]`),
    new RegExp(`unique_together\\s*=\\s*[\\s\\S]{0,300}?['"]${c}['"]`),
    new RegExp(`\\bunique\\s*\\(\\s*[^)]*\\b${c}\\b`, "i"),
    new RegExp(
      `add_index\\s*\\(?\\s*:\\w+\\s*,\\s*(?:\\[[^\\]]*:${c}\\b[^\\]]*\\]|:${c}\\b)[^\\n]*unique:\\s*true`,
    ),
    new RegExp(
      `\\bt\\.index\\s*\\(?\\s*(?:\\[[^\\]]*["':]${c}\\b|["':]${c}\\b)[^\\n]*unique:\\s*true`,
    ),
    new RegExp(`@@unique\\(\\s*(?:fields:\\s*)?\\[[^\\]]*\\b${c}\\b`),
    new RegExp(`\\.unique\\(\\s*\\[?[^)]*['"]${c}['"]`),
  ];
  if (wide.some((re) => re.test(text)) || uniqueKeyOn(text, c)) return true;
  // The column's own declaration: its line plus a decorator line above it,
  // and the rest of a bracket it opens (a field call or object over lines).
  const UNIQUE_TOKEN =
    /\bunique\s*[=:]\s*(?:True|true)\b|@unique\b|\.unique\(\)|\bUNIQUE\b|\bunique:\s*true/;
  const named = new RegExp(`(?:^|[^\\w.])${c}\\b\\s*[:=(]|\\b${c}\\b\\s+\\w`);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!named.test(line)) continue;
    let window = line;
    const above = lines[i - 1];
    if (above !== undefined && /^\s*(?:@|#\[|\[)/.test(above)) window = `${above}\n${window}`;
    let depth = 0;
    for (const ch of line) depth += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
    for (let j = i + 1; depth > 0 && j < Math.min(lines.length, i + 13); j++) {
      const next = lines[j]!;
      window += `\n${next}`;
      for (const ch of next) depth += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
    }
    if (UNIQUE_TOKEN.test(window)) return true;
  }
  return false;
}

/** The model a uniqueness check's line queries: `User.objects.filter`,
 * `User.exists?`, `prisma.user.findFirst`, `session.query(User)`,
 * `userRepository.findOneBy`, … Group 1 is the model or its client name. */
const MODEL_HINTS: readonly RegExp[] = [
  /\bquery\(\s*([A-Z]\w*)\s*\)/,
  /\b([A-Z]\w*)\s*\.\s*(?:objects|query)\s*\./,
  /\bprisma\s*\.\s*(\w+)\s*\./,
  /\b(\w+?)(?:Repository|Repo)\s*\.\s*find/,
  /\b([A-Z]\w*)\s*\.\s*(?:exists\?|find_by|where|findOne|findFirst|findOneBy|filter_by)\b/,
];
/** The class a `validates` line sits in, from the hunk's scope or its lines. */
const CLASS_RE = /\bclass\s+([A-Z]\w*)/;

function modelHint(text: string): string | undefined {
  for (const re of MODEL_HINTS) {
    const m = re.exec(text);
    if (m) return m[1]!;
  }
  return undefined;
}

/** A model's spellings: its class (`OrderItem`), its table (`order_item`,
 * `order_items`) and Django's `model_name` (`orderitem`). */
function modelNames(model: string): { cls: string; snake: string; plural: string; flat: string } {
  const cls = model.charAt(0).toUpperCase() + model.slice(1);
  const snake = cls
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  const plural = /(?:s|x|ch|sh)$/.test(snake)
    ? `${snake}es`
    : /[^aeiou]y$/.test(snake)
      ? `${snake.slice(0, -1)}ies`
      : `${snake}s`;
  return { cls, snake, plural, flat: snake.replace(/_/g, "") };
}

/** A line that opens some model's or table's declaration: where one model's
 * block ends. */
const ANY_DECL_RE =
  /^\s*(?:class|model)\s+[A-Z]|\bcreate_table\b|\bCREATE\s+TABLE\b|\bmigrations\.\w+\(|\bmodel_name\s*=|__tablename__|\.define\(|@Entity\b/i;

/** Whether `text` declares a unique constraint on `col` FOR `model`: inside
 * the model's own block (its class, Prisma model, `create_table`, `CREATE
 * TABLE`, Django migration operation), or on a statement that names its
 * table (`add_index :users, :email, unique: true`, `CREATE UNIQUE INDEX …
 * ON users (email)`). A constraint on a same-named column of another model
 * never backs the check. */
function uniqueForModel(text: string, model: string, col: string): boolean {
  const n = modelNames(model);
  const tables = `(?:${escapeRe(n.snake)}|${escapeRe(n.plural)})`;
  const decl = new RegExp(
    [
      `\\b(?:class|model|interface|entity)\\s+${escapeRe(n.cls)}\\b`,
      `\\bcreate_table\\s*\\(?\\s*[:"']${tables}\\b`,
      `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[\`"']?(?:\\w+\\.)?${tables}\\b`,
      `__tablename__\\s*=\\s*['"]${tables}['"]`,
      `\\bmodel_name\\s*=\\s*['"]${escapeRe(n.flat)}['"]`,
      `^\\s*name\\s*=\\s*['"]${escapeRe(n.cls)}['"]`,
      `\\.define\\(\\s*['"](?:${escapeRe(n.cls)}|${tables})['"]`,
      `@Entity\\(\\s*(?:\\{\\s*name\\s*:\\s*)?['"]${tables}['"]`,
    ].join("|"),
    "i",
  );
  const table = new RegExp(`(?:^|[^\\w.])[:"'\`]?${tables}[\`"']?(?:[^\\w]|$)`, "i");
  const lines = text.split("\n");
  const indent = (l: string): number => /^\s*/.exec(l)![0].length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (table.test(line) && hasUniqueConstraint(line, col)) return true;
    if (!decl.test(line)) continue;
    let j = i + 1;
    while (j < lines.length && !(ANY_DECL_RE.test(lines[j]!) && indent(lines[j]!) <= indent(line)))
      j++;
    if (hasUniqueConstraint(lines.slice(i, j).join("\n"), col)) return true;
  }
  return false;
}

function uniqueWithoutIndex(
  files: readonly PrFileEntry[],
  io: SecurityFactsIo | null,
): SecurityFact[] {
  const candidates: {
    file: string;
    line: number;
    column: string;
    shape: string;
    model?: string;
  }[] = [];
  for (const { file, hunks } of patchedFiles(files).patched) {
    if (file.status === "removed" || !CODE_RE.test(file.filename)) continue;
    const added = hunks
      .flatMap((h) => h.lines)
      .filter((l) => l.kind === "+" && !COMMENT_RE.test(l.text));
    const creates = added.some((l) => CREATE_RE.test(l.text));
    for (const hunk of hunks) {
      // The class the hunk's lines sit in, as far as the hunk shows it.
      let cls = CLASS_RE.exec(hunk.scope)?.[1];
      for (const l of hunk.lines) {
        if (l.kind === "-") continue;
        cls = CLASS_RE.exec(l.text)?.[1] ?? cls;
        if (l.kind !== "+" || COMMENT_RE.test(l.text)) continue;
        for (const check of UNIQUE_CHECKS) {
          const m = check.re.exec(l.text);
          if (!m || (check.needsCreate && !creates)) continue;
          const column = m[1]!;
          if (KEY_COLUMNS.has(column.toLowerCase())) continue;
          const model = check.shape.startsWith("validates") ? cls : modelHint(l.text);
          candidates.push({
            file: file.filename,
            line: l.line,
            column,
            shape: check.shape,
            ...(model !== undefined ? { model } : {}),
          });
          break;
        }
      }
    }
  }
  const check = "unique-without-index";
  if (candidates.length === 0)
    return [fact(check, "clear", "the PR adds no uniqueness check in code")];
  if (io === null) return [fact(check, "unknown", NO_IO)];
  const listing = listFiles(
    io,
    (p) => SCHEMA_PATH_RE.test(p) && SCHEMA_EXT_RE.test(p) && !isTest(p),
  );
  if (listing === null) return [fact(check, "unknown", NO_LISTING)];
  if (listing.paths.length === 0)
    return [
      fact(
        check,
        "unknown",
        "no schema, model or migration file was found in the repository to check the column against",
      ),
    ];
  const { texts, failed } = readAll(io, listing.paths);
  const found: SecurityFact[] = [];
  const clear: string[] = [];
  const unsettled: string[] = [];
  const untied: string[] = [];
  for (const c of candidates) {
    // A constraint backs the check only on the model the check queries: a
    // unique `email` on `Subscriber` says nothing of `User.email`.
    const holders = [...texts].filter(([, text]) => hasUniqueConstraint(text, c.column));
    const tied =
      c.model === undefined
        ? undefined
        : holders.find(([, text]) => uniqueForModel(text, c.model!, c.column));
    if (tied)
      clear.push(
        `${codePath(c.column)} (unique on ${codePath(modelNames(c.model!).cls)} in ${codePath(tied[0])})`,
      );
    else if (holders.length > 0)
      untied.push(
        `a unique constraint on ${codePath(c.column)} exists in ${codePath(holders[0]![0])}, but it could not be tied to ${c.model !== undefined ? codePath(modelNames(c.model).cls) : "the model the check queries"}`,
      );
    else if (failed.length || listing.capped) unsettled.push(codePath(c.column));
    else
      found.push(
        fact(
          check,
          "found",
          `checks ${codePath(c.column)} is unique in code (${c.shape}), and none of the ${texts.size} schema, model or migration file(s) declares a unique constraint or index on it: two concurrent requests can both pass the check`,
          { file: c.file, line: c.line },
        ),
      );
  }
  const out = capFound(found);
  if (unsettled.length)
    out.push(
      fact(
        check,
        "unknown",
        `no unique constraint was found for ${unsettled.join(", ")}, but ${failed.length ? `${failed.length} schema file(s) could not be read` : `the schema files were capped at ${SECURITY_FACTS_MAX_FILES}`}`,
      ),
    );
  for (const why of untied) out.push(fact(check, "unknown", why));
  if (clear.length)
    out.push(fact(check, "clear", `every other uniqueness check is backed: ${clear.join(", ")}`));
  return out;
}

// ---------------------------------------------------------------------------
// unattached-security-group

const SG_DECL_RE = /^\s*resource\s+"aws_security_group"\s+"([\w-]+)"/;
const SG_REF_RE = /\baws_security_group\.([\w-]+)\b/g;
/** Arguments that attach a security group to something that has traffic. */
const SG_ATTACH_KEY_RE = /^(?:vpc_)?security_groups?_ids$|^security_groups$|_security_group_ids$/;
/** Resources whose singular `security_group_id` attaches (not a rule's). */
const SG_ATTACH_RESOURCES = new Set(["aws_network_interface_sg_attachment"]);
/** A security group and its rules: a group they name is a source. */
const SG_SOURCE_RESOURCE_RE = /^aws_(?:vpc_)?security_group(?:_rule|_ingress_rule|_egress_rule)?$/;

/** Every security group `text` attaches, and every one it hands on through
 * an output, a module input or a local, which a line parser cannot follow. */
export function securityGroupUses(text: string): { attached: Set<string>; handedOn: Set<string> } {
  const attached = new Set<string>();
  const handedOn = new Set<string>();
  let depth = 0;
  let block: { kind: string; type: string } | null = null;
  let listKey: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/(?:^|\s)(?:#|\/\/).*$/, "");
    if (depth === 0) {
      const b = /^\s*(resource|data|module|output|locals|variable)\b\s*(?:"([^"]+)")?/.exec(line);
      block = b ? { kind: b[1]!, type: b[2] ?? "" } : null;
    }
    const kv = /^\s*([A-Za-z_][\w-]*)\s*=\s*(.*)$/.exec(line);
    const key = kv ? kv[1]! : listKey;
    for (const m of line.matchAll(SG_REF_RE)) {
      const name = m[1]!;
      // A group named inside a group or its rules is a traffic source, not
      // an attachment.
      if (block && SG_SOURCE_RESOURCE_RE.test(block.type)) continue;
      if (block && (block.kind === "output" || block.kind === "module" || block.kind === "locals"))
        handedOn.add(name);
      else if (key !== null && SG_ATTACH_KEY_RE.test(key)) attached.add(name);
      else if (key === "security_group_id" && block && SG_ATTACH_RESOURCES.has(block.type))
        attached.add(name);
    }
    if (kv) {
      const rest = kv[2]!;
      const opens = (rest.match(/\[/g) ?? []).length - (rest.match(/\]/g) ?? []).length;
      listKey = opens > 0 ? kv[1]! : null;
    } else if (listKey !== null && /\]/.test(line)) listKey = null;
    for (const ch of line) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    if (depth < 0) depth = 0;
  }
  return { attached, handedOn };
}

function unattachedSecurityGroup(
  files: readonly PrFileEntry[],
  io: SecurityFactsIo | null,
): SecurityFact[] {
  const check = "unattached-security-group";
  const tf = files.filter((f) => TF_RE.test(f.filename));
  const touched = tf.filter((f) => f.patch === undefined || /security_group/.test(f.patch));
  if (touched.length === 0)
    return [fact(check, "clear", "the PR changes no Terraform security group")];
  if (io === null) return [fact(check, "unknown", NO_IO)];
  const listing = listFiles(io, (p) => TF_RE.test(p));
  if (listing === null) return [fact(check, "unknown", NO_LISTING)];
  const { texts, failed } = readAll(io, listing.paths);
  // The groups the PR touches: declared in a changed file, or named on a
  // changed line anywhere.
  const declared = new Map<string, { file: string; line: number }>();
  for (const [path, text] of texts)
    text.split("\n").forEach((l, i) => {
      const m = SG_DECL_RE.exec(l);
      if (m && !declared.has(m[1]!)) declared.set(m[1]!, { file: path, line: i + 1 });
    });
  const names = new Set<string>();
  for (const f of touched) {
    for (const [name, at] of declared) if (at.file === f.filename) names.add(name);
    for (const l of parsePatch(f.patch ?? "").flatMap((h) => h.lines)) {
      if (l.kind === " ") continue;
      for (const m of l.text.matchAll(SG_REF_RE)) names.add(m[1]!);
      const d = SG_DECL_RE.exec(l.text);
      if (d) names.add(d[1]!);
    }
  }
  const attached = new Set<string>();
  const handedOn = new Set<string>();
  for (const text of texts.values()) {
    const uses = securityGroupUses(text);
    uses.attached.forEach((n) => attached.add(n));
    uses.handedOn.forEach((n) => handedOn.add(n));
  }
  const found: SecurityFact[] = [];
  const out: SecurityFact[] = [];
  const ok: string[] = [];
  for (const name of [...names].sort()) {
    const at = declared.get(name);
    if (!at) {
      // Declared in no file read: removed by the PR — unless the files read
      // are not all of them, when the declaration may sit past the cap or in
      // a file that could not be read.
      if (listing.capped || failed.length)
        out.push(
          fact(
            check,
            "unknown",
            `${codePath(`aws_security_group.${name}`)} is not declared in the files read, but ${failed.length ? `${failed.length} Terraform file(s) could not be read` : `the Terraform files were capped at ${SECURITY_FACTS_MAX_FILES}`}`,
          ),
        );
      continue;
    }
    if (attached.has(name)) ok.push(codePath(name));
    else if (handedOn.has(name) || failed.length || listing.capped)
      out.push(
        fact(
          check,
          "unknown",
          handedOn.has(name)
            ? `${codePath(`aws_security_group.${name}`)} is handed to an output, module or local, which the line parser cannot follow to an attachment`
            : `${codePath(`aws_security_group.${name}`)} has no attachment in the files read, but ${failed.length ? `${failed.length} Terraform file(s) could not be read` : `the Terraform files were capped at ${SECURITY_FACTS_MAX_FILES}`}`,
          at,
        ),
      );
    else
      found.push(
        fact(
          check,
          "found",
          `${codePath(`aws_security_group.${name}`)} is attached by no \`vpc_security_group_ids\`, \`security_groups\` or \`security_group_ids\` in the repository's Terraform, so its rules protect nothing`,
          at,
        ),
      );
  }
  const result = [...capFound(found), ...out];
  if (ok.length) result.push(fact(check, "clear", `attached: ${ok.join(", ")}`));
  if (result.length === 0)
    result.push(
      failed.length
        ? fact(check, "unknown", `${failed.length} Terraform file(s) could not be read`)
        : listing.capped
          ? fact(
              check,
              "unknown",
              `no security group the PR touches is declared in the files read, but they were capped at ${SECURITY_FACTS_MAX_FILES}`,
            )
          : fact(check, "clear", "no security group the PR touches is still declared"),
    );
  return result;
}

// ---------------------------------------------------------------------------
// compose-port-ufw

const COMPOSE_RE = /(?:^|\/)(?:docker-)?compose(?:[.-][\w.-]+)?\.ya?ml$/i;
/** A compose file for development or tests, not a deploy. */
const DEV_COMPOSE_RE =
  /(?:^|[./-])(?:dev|devel|development|local|test|tests|ci|e2e|override)(?:[./-]|$)/i;
/** Whitespace within one line: `\s` without the line terminators. */
const HSPACE = String.raw`[^\S\n\r\u2028\u2029]`;
/** A ufw command, the Ansible module, or a `- ufw:` task key on a line of its
 * own. It runs over whole patches a pull request's author wrote, with `m`, so
 * `^` matches after every line terminator `\s` would also match: the task
 * key's whitespace stays on its line, and only one run of it can take a
 * space, or a run of `\r` or U+2028 costs cubic time. */
const UFW_RE = new RegExp(
  String.raw`\bufw\s+(?:allow|deny|reject|limit|default|enable|route)\b|\bcommunity\.general\.ufw\b|` +
    `^${HSPACE}*(?:-${HSPACE}*)?ufw:${HSPACE}*$`,
  "m",
);
const UFW_FILE_RE =
  /\.(?:sh|bash|ya?ml|j2|tf|rules|cfg|conf|txt|tpl)$|(?:^|\/)(?:Makefile|Dockerfile[^/]*|user-data|cloud-init[^/]*)$/i;
const DOCKER_UFW_FIX_RE = /DOCKER-USER|ufw-docker|"iptables"\s*:\s*false/;
const LOOPBACK_RE = /^(?:127\.\d+\.\d+\.\d+|localhost|\[?::1\]?):/;

/** The ports a compose file publishes on every interface (`exposed`), and
 * those whose host address is an interpolation it cannot settle. */
export function composePublishedPorts(text: string): {
  exposed: { port: string; line: number }[];
  unsettled: { port: string; line: number }[];
} {
  const exposed: { port: string; line: number }[] = [];
  const unsettled: { port: string; line: number }[] = [];
  const lines = text.split("\n");
  const classify = (item: string, line: number) => {
    const port = item.trim().replace(/^["']|["']$/g, "");
    if (port === "" || LOOPBACK_RE.test(port)) return;
    // `${PORT}:80` binds every interface; `${BIND}:8080:80` names the host
    // address through a variable this parser cannot read.
    const interpolated = /^\$\{[^}]*\}(.*)$/.exec(port);
    (interpolated && interpolated[1]!.split(":").length >= 3 ? unsettled : exposed).push({
      port,
      line,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)ports:\s*(.*?)\s*(?:#.*)?$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const inline = m[2]!;
    if (inline.startsWith("[")) {
      for (const item of inline.replace(/^\[|\]$/g, "").split(",")) classify(item, i + 1);
      continue;
    }
    // A block list: short items, or long-syntax mappings.
    let long: { published: boolean; host: string | null; line: number } | null = null;
    const flushLong = () => {
      if (long?.published && (long.host === null || !LOOPBACK_RE.test(`${long.host}:`)))
        (long.host?.startsWith("${") ? unsettled : exposed).push({
          port: "published",
          line: long.line,
        });
      long = null;
    };
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "" || /^\s*#/.test(l)) continue;
      const ind = l.length - l.trimStart().length;
      if (ind < indent || (ind === indent && !/^\s*-/.test(l))) break;
      const item = /^\s*-\s*(.*?)\s*(?:#.*)?$/.exec(l);
      const body = item ? item[1]! : l.trim();
      if (item) flushLong();
      const kv = /^([\w-]+):\s*(.*)$/.exec(body);
      if (kv && !/^\d/.test(body)) {
        long ??= { published: false, host: null, line: j + 1 };
        const v = kv[2]!.replace(/^["']|["']$/g, "");
        if (kv[1] === "published") long.published = true;
        if (kv[1] === "host_ip") long.host = v;
      } else if (item) classify(body, j + 1);
    }
    flushLong();
  }
  return { exposed, unsettled };
}

function composePortUfw(files: readonly PrFileEntry[], io: SecurityFactsIo | null): SecurityFact[] {
  const check = "compose-port-ufw";
  const touched = files.some(
    (f) => COMPOSE_RE.test(f.filename) || (f.patch !== undefined && UFW_RE.test(f.patch)),
  );
  if (!touched) return [fact(check, "clear", "the PR changes no compose file and no ufw rule")];
  if (io === null) return [fact(check, "unknown", NO_IO)];
  const listing = listFiles(io, (p) => (COMPOSE_RE.test(p) || UFW_FILE_RE.test(p)) && !isTest(p));
  if (listing === null) return [fact(check, "unknown", NO_LISTING)];
  const { texts, failed } = readAll(io, listing.paths);
  const exposed: { file: string; port: string; line: number }[] = [];
  const unsettled: string[] = [];
  let ufw: { file: string; line: number } | null = null;
  let fix: string | null = null;
  for (const [path, text] of texts) {
    if (COMPOSE_RE.test(path) && !DEV_COMPOSE_RE.test(path.split("/").pop()!)) {
      const ports = composePublishedPorts(text);
      ports.exposed.forEach((p) => exposed.push({ file: path, ...p }));
      ports.unsettled.forEach((p) => unsettled.push(`${codePath(p.port)} in ${codePath(path)}`));
    }
    if (ufw === null) {
      const at = text.split("\n").findIndex((l) => UFW_RE.test(l));
      if (at >= 0) ufw = { file: path, line: at + 1 };
    }
    if (fix === null && DOCKER_UFW_FIX_RE.test(text)) fix = path;
  }
  const partial = failed.length
    ? `${failed.length} file(s) could not be read`
    : listing.capped
      ? `the files read were capped at ${SECURITY_FACTS_MAX_FILES}`
      : null;
  if (exposed.length && ufw && !fix) {
    const first = exposed[0]!;
    const ports = exposed
      .slice(0, 5)
      .map((p) => codePath(p.port))
      .join(", ");
    return [
      fact(
        check,
        "found",
        `a deploy compose file publishes ${ports}${exposed.length > 5 ? ", ..." : ""} on every interface, and ${codePath(ufw.file)} line ${ufw.line} configures ufw: Docker's published ports bypass ufw's rules, so ufw does not close them`,
        { file: first.file, line: first.line },
      ),
    ];
  }
  if (partial) return [fact(check, "unknown", partial)];
  if (unsettled.length && ufw && !fix)
    return [
      fact(
        check,
        "unknown",
        `published ports with an interpolated host address cannot be settled: ${unsettled.slice(0, 5).join(", ")}`,
      ),
    ];
  if (exposed.length && ufw && fix)
    return [
      fact(
        check,
        "clear",
        `ports are published and ufw is configured, but ${codePath(fix)} handles Docker's bypass`,
      ),
    ];
  if (!ufw)
    return [fact(check, "clear", "no ufw rule in the repository, so no ufw rule is bypassed")];
  return [fact(check, "clear", "no deploy compose file publishes a port on every interface")];
}

// ---------------------------------------------------------------------------
// networkpolicy-selector

/** A YAML document flattened to `dotted.path` → scalar (a list item is a `-`
 * segment). Line-parsed: flow mappings one level deep, no anchors, no block
 * scalars beyond skipping them. */
export function flattenYaml(lines: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const stack: { indent: number; key: string }[] = [];
  let blockScalar: number | null = null;
  for (const raw of lines) {
    if (raw.trim() === "" || /^\s*#/.test(raw)) continue;
    let indent = raw.length - raw.trimStart().length;
    if (blockScalar !== null) {
      if (indent > blockScalar) continue;
      blockScalar = null;
    }
    let content = raw.trim().replace(/\s+#.*$/, "");
    while (content.startsWith("- ") || content === "-") {
      while (
        stack.length &&
        (stack[stack.length - 1]!.indent > indent ||
          (stack[stack.length - 1]!.indent === indent && stack[stack.length - 1]!.key === "-"))
      )
        stack.pop();
      stack.push({ indent, key: "-" });
      const rest = content.slice(1);
      indent += 1 + (rest.length - rest.trimStart().length);
      content = rest.trim();
    }
    const kv = /^("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:(?:\s+(.*))?$/.exec(content);
    if (!kv) continue;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const key = kv[1]!.replace(/^["']|["']$/g, "");
    const value = (kv[2] ?? "").trim();
    const path = [...stack.map((s) => s.key), key].join(".");
    if (value === "") {
      stack.push({ indent, key });
    } else if (/^[|>][-+]?\d*$/.test(value)) {
      out.set(path, "");
      blockScalar = indent;
    } else if (value.startsWith("{") && value.endsWith("}")) {
      const inner = value.slice(1, -1).trim();
      out.set(path, inner === "" ? "{}" : value);
      for (const pair of inner.split(",")) {
        const m = /^\s*("[^"]*"|'[^']*'|[^:\s]+)\s*:\s*(.*?)\s*$/.exec(pair);
        if (m)
          out.set(
            `${path}.${m[1]!.replace(/^["']|["']$/g, "")}`,
            m[2]!.replace(/^["']|["']$/g, ""),
          );
      }
    } else out.set(path, value.replace(/^["']|["']$/g, ""));
  }
  return out;
}

const WORKLOAD_LABELS: Readonly<Record<string, string>> = {
  Deployment: "spec.template.metadata.labels.",
  StatefulSet: "spec.template.metadata.labels.",
  DaemonSet: "spec.template.metadata.labels.",
  ReplicaSet: "spec.template.metadata.labels.",
  Job: "spec.template.metadata.labels.",
  CronJob: "spec.jobTemplate.spec.template.metadata.labels.",
  Pod: "metadata.labels.",
};

function underPrefix(doc: Map<string, string>, prefix: string): Map<string, string> {
  const out = new Map<string, string>();
  // Label keys may hold dots (`app.kubernetes.io/name`): everything under
  // the prefix is one key, since a label map has no deeper level.
  for (const [k, v] of doc) if (k.startsWith(prefix)) out.set(k.slice(prefix.length), v);
  return out;
}

function networkPolicySelector(
  files: readonly PrFileEntry[],
  io: SecurityFactsIo | null,
): SecurityFact[] {
  const check = "networkpolicy-selector";
  const touched = files.some(
    (f) =>
      YAML_RE.test(f.filename) &&
      (f.patch === undefined || /NetworkPolicy|podSelector|matchLabels|\blabels\s*:/.test(f.patch)),
  );
  if (!touched) return [fact(check, "clear", "the PR changes no NetworkPolicy and no pod labels")];
  if (io === null) return [fact(check, "unknown", NO_IO)];
  const listing = listFiles(
    io,
    (p) => YAML_RE.test(p) && !p.startsWith(".github/") && !COMPOSE_RE.test(p),
  );
  if (listing === null) return [fact(check, "unknown", NO_LISTING)];
  const { texts, failed } = readAll(io, listing.paths);
  const policies: {
    file: string;
    line: number;
    name: string;
    ns: string | null;
    labels: Map<string, string> | "all" | "unsettled";
  }[] = [];
  const workloads: { ns: string | null; labels: Map<string, string> }[] = [];
  let templated = false;
  for (const [path, text] of texts) {
    if (/(?:^|\/)kustomization\.ya?ml$/.test(path) && /^\s*(?:commonLabels|labels)\s*:/m.test(text))
      templated = true;
    const all = text.split("\n");
    let start = 0;
    for (let i = 0; i <= all.length; i++) {
      if (i < all.length && !/^---/.test(all[i]!)) continue;
      const docLines = all.slice(start, i);
      const docStart = start;
      start = i + 1;
      const body = docLines.join("\n");
      const kind = /^kind:\s*["']?(\w+)/m.exec(body)?.[1];
      if (!kind) continue;
      const isTemplated = body.includes("{{");
      if (kind === "NetworkPolicy") {
        const doc = flattenYaml(docLines);
        const line = docStart + 1 + docLines.findIndex((l) => /^kind:/.test(l));
        const name = doc.get("metadata.name") ?? "(unnamed)";
        const ns = doc.get("metadata.namespace") ?? null;
        let labels: Map<string, string> | "all" | "unsettled";
        const exprs = [...doc.keys()].some((k) =>
          k.startsWith("spec.podSelector.matchExpressions"),
        );
        const sel = underPrefix(doc, "spec.podSelector.matchLabels.");
        if (isTemplated || exprs) labels = "unsettled";
        else if (sel.size > 0) labels = sel;
        else if (
          doc.get("spec.podSelector") === "{}" ||
          doc.get("spec.podSelector.matchLabels") === "{}"
        )
          labels = "all";
        else labels = "unsettled";
        policies.push({ file: path, line, name, ns, labels });
      } else if (kind in WORKLOAD_LABELS) {
        if (isTemplated) {
          templated = true;
          continue;
        }
        const doc = flattenYaml(docLines);
        workloads.push({
          ns: doc.get("metadata.namespace") ?? null,
          labels: underPrefix(doc, WORKLOAD_LABELS[kind]!),
        });
      }
    }
  }
  // No policy in the files read is no policy only when every manifest was read.
  if (policies.length === 0)
    return failed.length
      ? [fact(check, "unknown", `${failed.length} manifest file(s) could not be read`)]
      : listing.capped
        ? [
            fact(
              check,
              "unknown",
              `no NetworkPolicy in the manifests read, but they were capped at ${SECURITY_FACTS_MAX_FILES}`,
            ),
          ]
        : [fact(check, "clear", "no NetworkPolicy in the repository's manifests")];
  const found: SecurityFact[] = [];
  const out: SecurityFact[] = [];
  let matched = 0;
  const cannotSettle = templated || failed.length > 0 || listing.capped || workloads.length === 0;
  for (const p of policies) {
    const at = { file: p.file, line: p.line };
    if (p.labels === "all") {
      matched++;
      continue;
    }
    if (p.labels === "unsettled") {
      out.push(
        fact(
          check,
          "unknown",
          `NetworkPolicy ${codePath(p.name)} selects pods by a templated selector or \`matchExpressions\`, which the line parser cannot settle`,
          at,
        ),
      );
      continue;
    }
    const want = p.labels;
    const hit = workloads.some(
      (w) =>
        (p.ns === null || w.ns === null || p.ns === w.ns) &&
        [...want].every(([k, v]) => w.labels.get(k) === v),
    );
    const sel = [...want].map(([k, v]) => `${k}=${v}`).join(",");
    if (hit) matched++;
    else if (cannotSettle)
      out.push(
        fact(
          check,
          "unknown",
          `NetworkPolicy ${codePath(p.name)} selects ${codePath(sel)}, and no workload read carries it, but ${workloads.length === 0 ? "no workload manifest was found (they may be rendered by a chart)" : templated ? "some manifests are templated or kustomized" : failed.length ? `${failed.length} manifest file(s) could not be read` : `the manifests were capped at ${SECURITY_FACTS_MAX_FILES}`}`,
          at,
        ),
      );
    else
      found.push(
        fact(
          check,
          "found",
          `NetworkPolicy ${codePath(p.name)} selects ${codePath(sel)}, which no workload template in the repository carries: the policy isolates nothing`,
          at,
        ),
      );
  }
  const result = [...capFound(found), ...out];
  if (matched)
    result.push(fact(check, "clear", `${matched} NetworkPolicy selector(s) match a workload`));
  return result;
}

// ---------------------------------------------------------------------------
// route-inventory

/** Route-like files, in `glob.ts` grammar (a pattern without `/` matches at
 * any depth, and everything under a directory it names). */
const ROUTE_GLOBS = [
  "routes",
  "routers",
  "controllers",
  "api",
  "views",
  "handlers",
  "endpoints",
  "routes.*",
  "router.*",
  "route.*",
  "urls.py",
  "views.py",
  "server.*",
  "app.*",
  "main.go",
];

/** Route registrations: group `m` the method (absent: any), `p` the path. */
const ROUTE_RES: readonly RegExp[] = [
  /\b(?:app|router|server|route|routes|fastify|r|e|g|mux|v\d)\.(?<m>get|post|put|patch|delete|all|options|head|use|route)\(\s*['"`](?<p>[/*][^'"`]*)/,
  /@\w+\.(?<m>route|get|post|put|patch|delete|api_route|websocket)\(\s*['"](?<p>[^'"]+)/,
  /\b(?:path|re_path|url)\(\s*r?['"](?<p>[^'"]*)['"]\s*,/,
  /@(?<m>Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:(?:value|path)\s*=\s*)?\{?\s*"(?<p>[^"]*)"/,
  /@(?<m>Get|Post|Put|Patch|Delete|All)\(\s*(?:['"](?<p>[^'"]*)['"])?\s*\)/,
  /^\s*(?<m>get|post|put|patch|delete|match|resources?)\s+['":](?<p>[\w/:.-]+)/,
  /\.(?<m>HandleFunc|Handle|GET|POST|PUT|PATCH|DELETE|Get|Post|Put|Patch|Delete)\(\s*"(?<p>[^"]+)"/,
  /\[(?:Http(?<m>Get|Post|Put|Patch|Delete)|Route)\(\s*"(?<p>[^"]*)"/,
  /\bRoute::(?<m>get|post|put|patch|delete|any|match|resource)\(\s*['"](?<p>[^'"]+)/,
  /#\[(?<m>get|post|put|patch|delete)\(\s*"(?<p>[^"]+)"/,
  /\.route\(\s*"(?<p>[^"]+)"\s*,\s*(?<m>get|post|put|patch|delete)\b/,
];

/** The routes `text` registers, in line order. */
export function routeRegistrations(text: string): { line: number; method: string; path: string }[] {
  const out: { line: number; method: string; path: string }[] = [];
  text.split("\n").forEach((l, i) => {
    if (COMMENT_RE.test(l)) return;
    for (const re of ROUTE_RES) {
      const m = re.exec(l);
      if (!m?.groups) continue;
      // An absolute URL is an outbound call (`http.Get("https://…")`), not a route.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(m.groups.p ?? "")) break;
      const method = (m.groups.m ?? "any").replace(
        /^(?:HandleFunc|Handle|route|api_route|Request|match|use)$/i,
        "any",
      );
      out.push({ line: i + 1, method: method.toUpperCase(), path: m.groups.p ?? "" });
      break;
    }
  });
  return out;
}

/** Where a route inventory reads: a PR's files and their directories, or a
 * whole tree (a scan's stage 0), which has no PR and no changed directory. */
type InventoryScope = "pr" | "tree";

function routeInventory(
  files: readonly PrFileEntry[],
  io: SecurityFactsIo | null,
  over: InventoryScope = "pr",
): SecurityFact[] {
  const check = "route-inventory";
  if (io === null) return [fact(check, "unknown", NO_IO)];
  const code = (p: string) => CODE_RE.test(p) && !isTest(p);
  const changed = files.filter((f) => f.status !== "removed" && code(f.filename));
  const dirs = new Set(
    changed.map((f) =>
      f.filename.includes("/") ? f.filename.slice(0, f.filename.lastIndexOf("/")) : "",
    ),
  );
  const routeLike = globMatcher(ROUTE_GLOBS);
  const inDir = (p: string) => dirs.has(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const listing = listFiles(io, (p) => code(p) && (inDir(p) || routeLike(p)));
  if (listing === null) return [fact(check, "unknown", NO_LISTING)];
  // The PR's own files first, then its directories, then route-like files.
  const ordered = [
    ...listing.paths.filter((p) => changed.some((f) => f.filename === p)),
    ...listing.paths.filter((p) => inDir(p) && !changed.some((f) => f.filename === p)),
    ...listing.paths.filter((p) => !inDir(p)),
  ];
  const { texts, failed } = readAll(io, ordered);
  const addedLines = new Map<string, Set<number>>();
  for (const f of changed)
    if (f.patch !== undefined)
      addedLines.set(
        f.filename,
        new Set(
          parsePatch(f.patch).flatMap((h) =>
            h.lines.filter((l) => l.kind === "+").map((l) => l.line),
          ),
        ),
      );
  const items: string[] = [];
  let total = 0;
  let withRoutes = 0;
  for (const [path, text] of texts) {
    const routes = routeRegistrations(text);
    if (routes.length) withRoutes++;
    for (const r of routes) {
      total++;
      if (items.length >= ROUTE_INVENTORY_MAX_ENTRIES) continue;
      const mark = addedLines.get(path)?.has(r.line) ? " (added by this PR)" : "";
      items.push(`${r.method} ${codePath(r.path || "/")} at ${codePath(path)}:${r.line}${mark}`);
    }
  }
  const limits = [
    total > ROUTE_INVENTORY_MAX_ENTRIES
      ? `the first ${ROUTE_INVENTORY_MAX_ENTRIES} of ${total} are listed`
      : null,
    listing.capped ? `the files read were capped at ${SECURITY_FACTS_MAX_FILES}` : null,
    failed.length ? `${failed.length} file(s) could not be read` : null,
  ].filter((x): x is string => x !== null);
  const scope =
    over === "tree"
      ? `the ${texts.size} route-like file(s) read from the tree`
      : `the ${texts.size} file(s) read from the changed directories and route-like paths`;
  const lead =
    over === "tree"
      ? "An entry point without the guard its neighbours carry is a lead for the model"
      : "A route the PR adds or moves without the guard its neighbours carry is the lead";
  if (total === 0)
    return [
      failed.length || listing.capped
        ? fact(
            check,
            "unknown",
            `no route registration found in ${scope}, but ${limits.join("; ")}`,
          )
        : fact(check, "clear", `no route registration found in ${scope}`),
    ];
  return [
    {
      ...fact(
        check,
        "found",
        `${total} route registration(s) in ${withRoutes} of ${scope}${limits.length ? `; ${limits.join("; ")}` : ""}. ${lead}`,
      ),
      items,
    },
  ];
}

// ---------------------------------------------------------------------------
// The seam

/** The checks that can plan a lens: every check but the route inventory,
 * which lists and finds nothing (securitytriggers.ts `factHits` skips it). A
 * host computes these before the plan, and the inventory only for a round
 * whose plan has a security-family row — the only reader of its output. */
export const SECURITY_TRIGGER_CHECKS: readonly SecFactCheck[] = SEC_FACT_CHECKS.filter(
  (c) => c !== "route-inventory",
);

/**
 * The route inventory over a whole tree, worded for one — no PR, no changed
 * directory: the route-like files the listing holds (a scan's stage 0, which
 * a person starts a threat model from). Total, as `computeSecurityFacts` is.
 */
export function treeRouteInventory(io: SecurityFactsIo | null): SecurityFact[] {
  try {
    return routeInventory([], io, "tree");
  } catch {
    return [fact("route-inventory", "unknown", "the check failed on this input")];
  }
}

/**
 * Every check over a PR's files, cheapest first — or the ones `checks`
 * names, in the same order. The two diff-only checks always run; the rest
 * read the repository through `io`, and with no `io` say `unknown` whenever
 * the PR touches their subject. Total: a check that throws becomes
 * `unknown`, never a missing line.
 */
export function computeSecurityFacts(
  files: PrFileEntry[],
  io: SecurityFactsIo | null,
  checks: readonly SecFactCheck[] = SEC_FACT_CHECKS,
): SecurityFact[] {
  const run: Record<SecFactCheck, () => SecurityFact[]> = {
    "removed-guard": () => removedGuard(files),
    "role-enum-shift": () => roleEnumShift(files),
    "unique-without-index": () => uniqueWithoutIndex(files, io),
    "unattached-security-group": () => unattachedSecurityGroup(files, io),
    "compose-port-ufw": () => composePortUfw(files, io),
    "networkpolicy-selector": () => networkPolicySelector(files, io),
    "route-inventory": () => routeInventory(files, io),
  };
  return SEC_FACT_CHECKS.filter((check) => checks.includes(check)).flatMap((check) => {
    try {
      return run[check]();
    } catch {
      return [fact(check, "unknown", "the check failed on this input")];
    }
  });
}

/**
 * The facts as a task-file section: "" when there are none. Each line names
 * its status first; an `unknown` line reads `unknown — <why>`, so a check
 * that did not run is never read as one that found nothing.
 */
export function renderSecurityFacts(facts: readonly SecurityFact[]): string {
  if (facts.length === 0) return "";
  const lines = [
    `## ${SECURITY_FACTS_HEADING}`,
    "",
    "Line parsers over the repository's files, run before this pass. A `found` line is a lead to verify in the code, never a finding on its own; a `clear` line covers only what its check reads; an `unknown` line is a check that could not run, not one that found nothing.",
    "",
  ];
  for (const f of facts) {
    const at =
      f.file !== undefined
        ? ` at ${codePath(f.file)}${f.line !== undefined ? `:${f.line}` : ""}`
        : "";
    lines.push(`- \`${f.check}\` (${f.lens})${at}: ${f.status} — ${f.detail}`);
    for (const item of f.items ?? []) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}
