// What the reviewer learned, loaded once and read by four surfaces.
//
// split the old `[2]` tab into `memory`, `digest`, `tickets` and
// `feedback`. The DATA behind them did not split the same way: the memory
// entries feed the memory timeline AND the feedback inbox (a signal is a
// `#feedback` entry), the tracker tickets feed their own tab AND the
// feedback tab's FILED summary, and the loaders carry discipline no tab should
// re-implement — in-flight guards, the forward-before-store ordering, the
// defect auto-filer that runs off a fresh read, the honest-unknown states.
// So the loaders live here, ONCE, and the tabs are renderers plus verbs over
// this store. `installLearningTabs` wires the four together.
//
// Every read here is total and three-state where it can fail:
// `undefined` / `unread` means nobody has asked, an error field means the
// ask failed, and only a real answer sets a list. An empty list from a dead
// store and an empty list from an empty store must never look alike.
import type { App } from "./app.js";
import type { IssueSink } from "./issuesink.js";
import type { ForwardStatus } from "./memforward.js";
import {
  defectEntries,
  storeHealth,
  tuiMemoryStore,
  type MemoryEntry,
  type MemoryStore,
} from "./memory.js";
import type { TrackerTicket } from "./trackertickets.js";
import {
  SshDigestFetcher,
  currentDigestFile,
  type DigestFetcher,
  type DigestState,
} from "./digesttab.js";
import {
  acceptProposal,
  improvementsArgv,
  listRubricProposals,
  parseImprovements,
  readRubricFile,
  removeRubricDir,
  type AcceptDeps,
  type ImprovementItem,
  type RubricProposal,
} from "./proposals.js";
import { installMemoryTab, type MemoryTabState } from "./memtab.js";
import { installDigestTab } from "./digesttab.js";
import { installTicketsTab, type TicketsTabState } from "./ticketstab.js";
import {
  installFeedbackTab,
  type ChangeRegisterSource,
  type FeedbackTabState,
} from "./feedbacktab.js";

/**
 * The tracker projection, as a fact about the READ rather than a list.
 *
 * `unread` is the normal state at startup: the scan is a filesystem walk and
 * runs behind the first frame. `unconfigured` is a system with no
 * tracker at all (`[sink] kind = "none"`) — not an empty tracker.
 * `unreadable` is a scan that threw; it must not latch as "read, empty", which
 * is how a missing directory once became a confident "0 tickets" that never
 * retried.
 */
export type TicketsRead =
  | { kind: "unread" }
  | { kind: "unconfigured" }
  | { kind: "unreadable"; reason: string }
  | { kind: "read"; tickets: TrackerTicket[] };

export type LearningPart = "memory" | "proposals" | "digest" | "tickets";

export interface LearningDeps {
  memory?: MemoryStore;
  digestFetcher?: DigestFetcher;
  /** Fetch rubric slugs + heads and gh improvements; injectable for tests. */
  fetchProposals?: (
    app: App,
  ) => Promise<{ proposals: RubricProposal[]; improvements: ImprovementItem[] | undefined }>;
  accept?: (app: App, slug: string) => Promise<{ ok: boolean; message: string }>;
  reject?: (app: App, slug: string, reason: string) => Promise<{ ok: boolean; message: string }>;
  /**: the configured issue sink the defect auto-filer writes through
   * (wayfinder tracker, gated github command channel, or none). Absent ⇒
   * auto-filing is off, exactly like kind "none". */
  sink?: IssueSink;
  /** Read-only tracker-ticket projection for the configured effort (:
   * the effort is config, not a literal — index.ts wires this from
   * `ticketProjection`). Absent ⇒ no tracker is configured, and the tickets
   * tab says so rather than showing an empty list. */
  readTickets?: () => TrackerTicket[];
  /** The effort the projection reads — for the tickets tab's title only. */
  ticketsEffort?: string;
  /** The change register the feedback tab's CHANGED section reads and reverts
   * through (src/tui/changelog-store.ts `ChangeLog`). */
  changes: ChangeRegisterSource;
  gitRun?: AcceptDeps["git"]["run"];
  /** The canonical repo root the accept path applies/ratifies/commits in —
   * NOT process.cwd(): `qcr` runs from anywhere. */
  repoRoot?: string;
  /** The live config.toml the install locator resolved — where an
   * accepted CONFIG proposal lands. Absent = `<repoRoot>/config.toml`. */
  configPath?: string;
  /**: the TUI-owned memory forward. Structural on purpose — tests
   * hand in a stub and never spawn ssh. Absent = the memory tab paints
   * "starting…" and offers no Studio link, which is the honest state for a
   * TUI that was built without one. */
  forward?: { view(): ForwardStatus; ensure(): Promise<ForwardStatus> };
  now?: () => Date;
}

const failingGit = (): Promise<string> => Promise.reject(new Error("local git runner not wired"));

export class LearningStore {
  // ---- memory --------------------------------------------------------------
  entries: MemoryEntry[] = [];
  memLoaded = false;
  /** Set when NO memory namespace answered — the tab paints an explicit
   * failure banner instead of an empty timeline. */
  memError?: string;
  /** Set when memory answered but partially: one of the two user trees is
   * down, or entries were listed and not readable. */
  memWarn?: string;
  /** One-line status of the last verb (also mirrored to app.notice). */
  status?: string;
  filedTotal = 0;
  /**: where the memory forward stands. */
  forward?: ForwardStatus;

  // ---- tickets -------------------------------------------------------------
  tickets: TicketsRead;

  // ---- proposals + bot PRs ---------------------------------------------------
  proposals: RubricProposal[] = [];
  /** `undefined` = the gh read was skipped or failed, NOT "no bot PRs"
   *: the fetch needs `view.repo`, which is not always set. */
  improvements: ImprovementItem[] | undefined;
  propLoaded = false;
  /** Whether the last proposals load ran with `view.repo` known. `false` means
   * the gh half was SKIPPED and is worth exactly one retry once it arrives. */
  improvementsTriedWithRepo?: boolean;

  // ---- digest ----------------------------------------------------------------
  digest: DigestState = { back: 0, scroll: 0 };

  readonly memory: MemoryStore;
  readonly now: () => Date;
  private readonly digestFetcher: DigestFetcher;
  private readonly listeners = new Set<(part: LearningPart) => void>();
  /** Per-part in-flight guards: a paint during a load never stacks a second. */
  private readonly busy = { digest: false, memory: false, proposals: false };

  constructor(
    private readonly app: App,
    private readonly deps: LearningDeps,
  ) {
    this.memory = deps.memory ?? tuiMemoryStore();
    this.digestFetcher = deps.digestFetcher ?? new SshDigestFetcher(app.cfg, app.ssh);
    this.now = deps.now ?? (() => new Date());
    this.tickets = deps.readTickets ? { kind: "unread" } : { kind: "unconfigured" };
    if (deps.forward) this.forward = deps.forward.view();
  }

  /** Called after each part finishes loading — the tabs re-bind selections. */
  onLoaded(fn: (part: LearningPart) => void): void {
    this.listeners.add(fn);
  }

  private loaded(part: LearningPart): void {
    for (const fn of this.listeners) fn(part);
    this.app.repaint();
  }

  private guard(key: keyof LearningStore["busy"], run: () => Promise<void>): void {
    if (this.busy[key]) return;
    this.busy[key] = true;
    void run().finally(() => {
      this.busy[key] = false;
    });
  }

  // ---- memory --------------------------------------------------------------

  /** Load memory if it has never been read; a paint-path call. */
  ensureMemory(): void {
    if (!this.memLoaded) this.guard("memory", () => this.loadMemoryPart());
  }

  reloadMemory(): void {
    this.memLoaded = false;
    this.guard("memory", () => this.loadMemoryPart());
  }

  /** Transport first, then the store. Every path that reads memory goes
   * through THIS — a read that skips the forward reports "unreachable" for a
   * transport nobody tried to start. */
  private async loadMemoryPart(): Promise<void> {
    if (this.deps.forward) {
      this.forward = await this.deps.forward.ensure();
      this.app.repaint();
    }
    const wasError = this.memError;
    this.entries = await this.memory.read();
    this.memLoaded = true;
    // Reachability is a property of the READ, not of the result: an empty
    // array from a dead store and an empty array from an empty store are the
    // same array. The store says which one it was.
    const health = storeHealth(this.memory);
    this.memError = health?.error;
    this.memWarn = health?.warning;
    if (this.memError && this.memError !== wasError)
      this.app.notice(`✖ memory unreachable: ${this.memError}`);
    else if (!this.memError && wasError) this.app.notice("memory reachable again");
    if (this.deps.sink && !this.memError) {
      // The sink holds the same store the verbs use (it stamps `filed=` back
      // onto each entry), so "already filed" stays a property of the memory.
      const report = await this.deps.sink.file(
        defectEntries(this.entries),
        this.now().toISOString(),
      );
      if (report.filed.length > 0) {
        const ids = report.filed.map((f) => f.id).join(", ");
        this.status = `auto-filed ${ids}`;
        this.app.notice(`memory: auto-filed ${report.filed.length} defect(s): ${ids}`);
      }
      // A refusal is a real answer (a cap, a dead channel) and the operator
      // must see it — the wayfinder sink's quiet-skip simply never sets one.
      if (report.refused !== undefined) this.status = `issue sink: ${report.refused}`;
      this.filedTotal += report.filed.length;
    }
    this.loaded("memory");
  }

  // ---- tickets -------------------------------------------------------------

  /** Run the tracker scan. Called by the TUI's bring-up and by `r`, never on
   * the paint path — it is a filesystem walk. */
  reloadTickets(): void {
    const read = this.deps.readTickets;
    if (!read) return; // unconfigured stays unconfigured
    try {
      this.tickets = { kind: "read", tickets: read() };
    } catch (err) {
      // A FAILED read is not an empty tracker: say so, and let the
      // next `r` try again instead of latching a confident zero.
      this.tickets = {
        kind: "unreadable",
        reason: String(err instanceof Error ? err.message : err),
      };
      this.app.notice(
        "✖ the tracker could not be read — the ticket panes stay unknown (r retries)",
      );
    }
    this.loaded("tickets");
  }

  // ---- proposals -----------------------------------------------------------

  /** Load proposals if never read — and re-attempt ONCE when the repo turns
   * up after a load that could not use it. Bounded on purpose:
   * `improvementsTriedWithRepo` latches on the attempt, not on its result, so
   * a failing gh read costs one retry and then waits for `r`. */
  ensureProposals(): void {
    const repoKnown = (this.app.view.repo ?? "") !== "";
    if (!this.propLoaded || (this.improvementsTriedWithRepo === false && repoKnown)) {
      this.guard("proposals", () => this.loadProposals());
    }
  }

  reloadProposals(): void {
    this.propLoaded = false;
    this.guard("proposals", () => this.loadProposals());
  }

  private async loadProposals(): Promise<void> {
    // Remember whether the gh read was even POSSIBLE at the time: it needs
    // `view.repo`, which arrives with the first snapshot — and
    // instant first frame makes opening the tab before that snapshot the
    // normal case, which used to park the pane on "not read" all session.
    const hadRepo = (this.app.view.repo ?? "") !== "";
    const { proposals, improvements } = await (
      this.deps.fetchProposals ?? this.defaultFetchProposals
    )(this.app);
    this.proposals = proposals;
    this.improvements = improvements;
    this.propLoaded = true;
    this.improvementsTriedWithRepo = hadRepo;
    this.loaded("proposals");
  }

  private readonly defaultFetchProposals = async (
    app: App,
  ): Promise<{ proposals: RubricProposal[]; improvements: ImprovementItem[] | undefined }> => {
    // Proposals are LOCAL (producer change: the companion's `land`
    // skill writes state/rubric/ in this repo — no ssh, no VM path).
    const root = this.deps.repoRoot ?? process.cwd();
    const proposals: RubricProposal[] = listRubricProposals(root).map((slug) => ({
      slug,
      head: (readRubricFile(root, slug, "PROPOSAL.md") ?? "")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(0, 3),
    }));
    // A skipped or failed gh read stays UNDEFINED — "we did not ask" and
    // "there are none" are different answers.
    const repo = app.view.repo ?? "";
    let improvements: ImprovementItem[] | undefined;
    if (repo) {
      const res = await app.ssh(app.cfg.ssh_host, improvementsArgv(app.cfg, repo), {
        timeoutMs: 20_000,
      });
      if (res.ok) improvements = parseImprovements(res.stdout);
    }
    return { proposals, improvements };
  };

  // ---- digest --------------------------------------------------------------

  ensureDigest(): void {
    if (this.digest.files === undefined && this.digest.listError === undefined)
      this.guard("digest", () => this.loadDigest());
  }

  reloadDigest(): void {
    this.digest.files = undefined;
    this.digest.listError = undefined;
    this.guard("digest", () => this.loadDigest());
  }

  private async loadDigest(): Promise<void> {
    const listed = await this.digestFetcher.list();
    if (listed === undefined) {
      // The ls itself failed — the difference between "no digest has been
      // written" and "I could not look" is the whole.
      this.digest.listError = "the digest directory could not be listed over ssh";
      this.digest.files = undefined;
    } else {
      this.digest.listError = undefined;
      this.digest.files = listed;
      this.digest.back = Math.min(this.digest.back, Math.max(0, listed.length - 1));
    }
    await this.loadDigestContent();
    this.loaded("digest");
  }

  private async loadDigestContent(): Promise<void> {
    const file = currentDigestFile(this.digest);
    this.digest.content = file ? await this.digestFetcher.read(file) : undefined;
  }

  /** Page the digest by `dir` days (+1 older, −1 newer). False at a boundary. */
  pageDigest(dir: 1 | -1): boolean {
    const files = this.digest.files ?? [];
    const next = this.digest.back + dir;
    if (next < 0 || next >= files.length) return false;
    this.digest.back = next;
    this.digest.scroll = 0;
    this.digest.content = undefined;
    void this.loadDigestContent().then(() => this.app.repaint());
    return true;
  }

  // ---- verbs ---------------------------------------------------------------

  reloadAll(): void {
    this.reloadTickets();
    this.reloadDigest();
    this.reloadMemory();
    this.reloadProposals();
  }

  /** Run a memory / proposal verb and fold its answer into the status line,
   * then re-read the parts it could have changed. */
  verb(p: Promise<{ ok: boolean; message: string }>): void {
    void p.then((res) => {
      this.status = `${res.ok ? "✓" : "✖"} ${res.message}`;
      this.app.notice(this.status);
      this.reloadMemory();
      this.reloadProposals();
    });
  }

  accept(slug: string): Promise<{ ok: boolean; message: string }> {
    if (this.deps.accept) return this.deps.accept(this.app, slug);
    return acceptProposal(
      {
        git: { run: this.deps.gitRun ?? failingGit },
        repoRoot: this.deps.repoRoot ?? process.cwd(),
        today: () => this.now().toISOString().slice(0, 10),
        ...(this.deps.configPath ? { configPath: this.deps.configPath } : {}),
      },
      slug,
    );
  }

  async reject(slug: string, reason: string): Promise<{ ok: boolean; message: string }> {
    if (this.deps.reject) return this.deps.reject(this.app, slug, reason);
    try {
      removeRubricDir(this.deps.repoRoot ?? process.cwd(), slug);
    } catch {
      return { ok: false, message: `could not remove state/rubric/${slug}` };
    }
    // The sweep's never-re-propose contract rides this memory entry.
    const mem = await this.memory.apply({
      op: "add",
      text: `#rejected-proposal ${slug} — ${reason}`,
    });
    return {
      ok: mem.ok,
      message: mem.ok
        ? `rejected '${slug}' — recorded`
        : `rejected '${slug}' but the memory record failed: ${mem.message}`,
    };
  }
}

/** The four learning surfaces and the store behind them — what index.ts
 * hands to the companion action driver. */
export interface LearningTabs {
  store: LearningStore;
  memory: MemoryTabState;
  tickets: TicketsTabState;
  feedback: FeedbackTabState;
}

/** Install `memory`, `digest`, `tickets` and `feedback` over ONE store. */
export function installLearningTabs(app: App, deps: LearningDeps): LearningTabs {
  const store = new LearningStore(app, deps);
  installDigestTab(app, store); // the digest's state IS the store's `digest`
  return {
    store,
    memory: installMemoryTab(app, store),
    tickets: installTicketsTab(app, store, deps.ticketsEffort),
    feedback: installFeedbackTab(app, store, deps.changes),
  };
}
