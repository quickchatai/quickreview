// The findings the bot already posted on a PR, read from its review comments
// (the hidden `qcr:f=` markers) through the credential `qcr review` resolved,
// and the filter that keeps a local review from raising them again. Reading is
// best-effort: any failure is a warning and the review goes on without.
import { parseFindingMarker, stripFindingMarkers } from "./findingkey.js";

export interface PostedFinding {
  key: string;
  round_no: number;
  path: string | null;
  line: number | null;
  /** The comment's text without its marker. */
  text: string;
}

export interface BotFindings {
  findings: PostedFinding[];
  warning?: string;
}

const MAX_PAGES = 10;

/** Every marked review comment on the PR; never throws. */
export async function fetchBotFindings(req: {
  repo: string;
  number: number;
  token: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
}): Promise<BotFindings> {
  const fetchFn = req.fetchFn ?? fetch;
  const apiBase = req.apiBase ?? "https://api.github.com";
  const findings: PostedFinding[] = [];
  const seen = new Set<string>();
  const skipWarning = (why: string): BotFindings => ({
    findings: [],
    warning: `could not read the bot's posted findings on PR #${req.number} (${why}); reviewing without skipping them`,
  });
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await fetchFn(
        `${apiBase}/repos/${req.repo}/pulls/${req.number}/comments?per_page=100&page=${page}`,
        {
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization: `Bearer ${req.token}`,
            accept: "application/vnd.github+json",
            "x-github-api-version": "2022-11-28",
          },
        },
      );
      if (!res.ok) return skipWarning(`GitHub answered ${res.status}`);
      const body: unknown = await res.json();
      if (!Array.isArray(body)) return skipWarning("an unexpected answer");
      for (const c of body as Array<Record<string, unknown>>) {
        const text = typeof c["body"] === "string" ? c["body"] : "";
        const m = parseFindingMarker(text);
        if (!m) continue;
        const id = `${m.round_no}:${m.key}:${String(c["path"])}`;
        if (seen.has(id)) continue;
        seen.add(id);
        findings.push({
          key: m.key,
          round_no: m.round_no,
          path: typeof c["path"] === "string" ? c["path"] : null,
          line: typeof c["line"] === "number" ? c["line"] : null,
          text: stripFindingMarkers(text).trim(),
        });
      }
      if (body.length < 100) break;
    }
  } catch (err) {
    return skipWarning(String(err).slice(0, 160));
  }
  return { findings };
}

const norm = (s: string | null | undefined): string =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The finding was already posted: on the same file, its title is the bot's
 * comment's. Keys are per-round handles, so a key match proves nothing. */
const alreadyPosted = (
  f: { path: string | null; title?: string | null },
  posted: readonly PostedFinding[],
): boolean =>
  posted.some((p) => {
    if (p.path === null || p.path !== f.path) return false;
    const t = norm(f.title);
    return t !== "" && norm(p.text).includes(t);
  });

/** `findings` without those the bot already posted; `skipped` counts them. */
export function skipPosted<
  T extends {
    key?: string | null;
    path: string | null;
    title?: string | null;
    line?: number | null;
  },
>(findings: readonly T[], posted: readonly PostedFinding[]): { fresh: T[]; skipped: number } {
  if (posted.length === 0) return { fresh: [...findings], skipped: 0 };
  const fresh = findings.filter((f) => !alreadyPosted(f, posted));
  return { fresh, skipped: findings.length - fresh.length };
}
