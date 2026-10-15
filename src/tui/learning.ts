// What the reviewer learned, loaded once and read by four surfaces.
//
// The surfaces are `memory`, `digest`, `tickets` and `feedback`, but the data
// behind them does not split the same way: the memory entries feed the memory
// timeline and the feedback inbox (a signal is a `#feedback` entry), the
// tracker tickets feed their own tab and the feedback tab's FILED summary,
// and the loaders carry discipline no tab should
// re-implement — in-flight guards, the forward-before-store ordering, the
// defect auto-filer that runs off a fresh read, the honest-unknown states.
// So the loaders live here, once, and the tabs are renderers plus verbs over
// this store. `installLearningTabs` wires the four together.
//
// Every read here is total and three-state where it can fail:
// `undefined` / `unread` means nobody has asked, an error field means the
// ask failed, and only a real answer sets a list. An empty list from a dead
// store and an empty list from an empty store must never look alike.
import { join } from "node:path";
import { proposalKey, type PinProposalsRead } from "../setup/pins.js";
import type { App } from "./app.js";
import type { IssueSink } from "./issuesink.js";
import type { ForwardStatus } from "./memforward.js";
import {
  defectEntries,
  splitNsId,
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
  rubricDir,
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
 * The tracker projection, as a fact about the read rather than a list.
 *
 * `unread` is the normal state at startup: the scan is a filesystem walk and
 * runs behind the first frame. `unconfigured` is a system with no tracker at
 * all (`[sink] kind = "none"`) — not an empty tracker. `unreadable` is a scan
 * that threw; it must not latch as "read, empty", or a missing directory
 * becomes a confident "0 tickets" that never retries.
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
  fetchProposals?: (app: App) => Promise<ProposalsFetch>;
  accept?: (app: App, slug: string) => Promise<{ ok: boolean; message: string }>;
  reject?: (app: App, slug: string, reason: string) => Promise<{ ok: boolean; message: string }>;
  /** The configured issue sink the defect auto-filer writes through
   * (wayfinder tracker, gated github command channel, or none). Absent ⇒
   * auto-filing is off, exactly like kind "none". */
  sink?: IssueSink;
  /** `github.issue_label` — the label the gh issue read filters on, so the
   * feedback tab lists the issues this reviewer actually files. Absent = the
   * shipped default. */
  issueLabel?: string;
  /** Read-only tracker-ticket projection for the configured effort (index.ts
   * wires this from `ticketProjection`). Absent ⇒ no tracker is configured,
   * and the tickets tab says so rather than showing an empty list. */
  readTickets?: () => TrackerTicket[];
  /** The effort the projection reads — for the tickets tab's title only. */
  ticketsEffort?: string;
  /** The change register the feedback tab's CHANGED section reads and reverts
   * through (src/tui/changelog-store.ts `ChangeLog`). */
  changes: ChangeRegisterSource;
  gitRun?: AcceptDeps["git"]["run"];
  /** The canonical repo root the accept path applies/ratifies/commits in —
   * not process.cwd(): `qcr` runs from anywhere. */
  repoRoot?: string;
  /** The live config.toml the install locator resolved — where an accepted
   * config proposal lands. Absent = `<repoRoot>/config.toml`. */
  configPath?: string;
  /** The TUI-owned memory forward. Structural on purpose — tests
   * hand in a stub and never spawn ssh. Absent = the memory tab paints
   * "starting…" and offers no Studio link, which is the honest state for a
   * TUI that was built without one. */
  forward?: { view(): ForwardStatus; ensure(): Promise<ForwardStatus> };
  /** The entries setup's companion proposed to pin
   * (`<state home>/setup/pin-proposals.json`) — re-read with memory. Absent =
   * no proposals channel; the memory tab marks nothing. */
  readPinProposals?: () => PinProposalsRead;
  now?: () => Date;
}

/** One proposals load: the local rubric dirs and the remote gh read. */
export interface ProposalsFetch {
  proposals: RubricProposal[];
  /** `undefined` = the gh read was skipped or failed outright. */
  improvements: ImprovementItem[] | undefined;
  /** Lists whose gh call failed while the other one answered. */
  improvementsFailed?: Array<"pr" | "issue">;
}

const failingGit = (): Promise<string> => Promise.reject(new Error("local git runner not wired"));

export class LearningStore {
  // ---- memory --------------------------------------------------------------
  entries: MemoryEntry[] = [];
  memLoaded = false;
  /** Set when no memory namespace answered — the tab paints an explicit
   * failure banner instead of an empty timeline. */
  memError?: string;
  /** Set when memory answered but partially: one of the two user trees is
   * down, or entries were listed and not readable. */
  memWarn?: string;
  /** One-line status of the last verb (also mirrored to app.notice). */
  status?: string;
  filedTotal = 0;
  /** Where the memory forward stands — read from the forward at every paint,
   * never kept from the last memory reload: an owned forward's row carries
   * its relay counts, which move between reloads. No forward = undefined,
   * which the tab paints as "starting…". */
  get forward(): ForwardStatus | undefined {
    return this.deps.forward?.view();
  }
  /** Entry key (memtab `entryKey`) → why setup proposes pinning it.
   * Only proposals whose entry still holds the proposed content count. */
  pinProposals = new Map<string, string>();
  /** Set when the proposals file exists and cannot be read. */
  pinProposalsError?: string;

  // ---- tickets -------------------------------------------------------------
  tickets: TicketsRead;

  // ---- proposals + bot PRs ---------------------------------------------------
  proposals: RubricProposal[] = [];
  /** `undefined` = the gh read was skipped or failed, not "no bot PRs": the
   * fetch needs `view.repo`, which is not always set. */
  improvements: ImprovementItem[] | undefined;
  /** The gh lists that failed while `improvements` holds the other one: a
   * partial read, and the pane says which half it could not see. */
  improvementsFailed: Array<"pr" | "issue"> = [];
  propLoaded = false;
  /** Whether the last proposals load ran with `view.repo` known. `false` means
   * the gh half was skipped and is worth exactly one retry once it arrives. */
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
  }

  /** Called after each part finishes loading — the tabs re-bind selections. */
  onLoaded(fn: (part: LearningPart) => void): void {
    this.listeners.add(fn);
  }

  private loaded(part: LearningPart): void {
    for (const fn of this.listeners) fn(part);
    this.app.repaint();
  }

  /** Start one part's load unless it is already running. The load starts
   * after the current synchronous turn, never inside it: the `ensure*` calls
   * come from a tab's paint, and a TUI resumed on that tab paints it as its
   * first frame — nothing external (an ssh fetch, a directory scan) may run
   * before that frame is written. */
  private guard(key: keyof LearningStore["busy"], run: () => Promise<void>): void {
    if (this.busy[key]) return;
    this.busy[key] = true;
    queueMicrotask(() => {
      void run().finally(() => {
        this.busy[key] = false;
      });
    });
  }

  // ---- memory --------------------------------------------------------------

  /** Match setup's pin proposals to the entries just read: a proposal whose
   * entry is gone, already pinned, or edited since is not shown. Setup
   * proposes against the REVIEWER's store, by its own ids; the TUI's merged
   * store prefixes every id with its user (`reviewer:<id>`), so a proposal
   * matches the reviewer's entry of that id — or, from a store that does not
   * namespace, the entry of the bare id. Keyed by the entry as the tab
   * addresses it (`entryKey`). */
  private loadPinProposals(): void {
    this.pinProposals = new Map();
    this.pinProposalsError = undefined;
    const read = this.deps.readPinProposals?.();
    if (!read || read.state === "absent") return;
    if (read.state === "unreadable") {
      this.pinProposalsError = read.error;
      return;
    }
    for (const p of read.file.entries) {
      const e = this.entries.find((x) => {
        const { user, id } = splitNsId(x.id);
        return (
          (user === "" || user === "reviewer") &&
          proposalKey({ id, ts: x.ts, block: x.block }) === proposalKey(p)
        );
      });
      if (e && !e.pinned && e.hash === p.hash) this.pinProposals.set(proposalKey(e), p.why);
    }
  }

  /** Load memory if it has never been read; a paint-path call. */
  ensureMemory(): void {
    if (!this.memLoaded) this.guard("memory", () => this.loadMemoryPart());
  }

  reloadMemory(): void {
    this.memLoaded = false;
    this.guard("memory", () => this.loadMemoryPart());
  }

  /** Transport first, then the store. Every path that reads memory goes
   * through this — a read that skips the forward reports "unreachable" for a
   * transport nobody tried to start. */
  private async loadMemoryPart(): Promise<void> {
    if (this.deps.forward) {
      await this.deps.forward.ensure();
      this.app.repaint();
    }
    const wasError = this.memError;
    this.entries = await this.memory.read();
    this.memLoaded = true;
    this.loadPinProposals();
    // Reachability is a property of the read, not of the result: an empty
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
      // A failed read is not an empty tracker: say so, and let the
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

  /** Load proposals if never read — and re-attempt once when the repo turns
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
    // Remember whether the gh read was even possible at the time: it needs
    // `view.repo`, which arrives with the first snapshot — and the instant
    // first frame makes opening the tab before that snapshot the normal case,
    // which would otherwise park the pane on "not read" all session.
    const hadRepo = (this.app.view.repo ?? "") !== "";
    const { proposals, improvements, improvementsFailed } = await (
      this.deps.fetchProposals ?? this.defaultFetchProposals
    )(this.app);
    this.proposals = proposals;
    this.improvements = improvements;
    this.improvementsFailed = improvements === undefined ? [] : (improvementsFailed ?? []);
    this.propLoaded = true;
    this.improvementsTriedWithRepo = hadRepo;
    this.loaded("proposals");
  }

  private readonly defaultFetchProposals = async (app: App): Promise<ProposalsFetch> => {
    // Proposals are local: the companion's `land` skill writes state/rubric/
    // in this repo — no ssh, no VM path.
    const root = this.repoRoot;
    const proposals: RubricProposal[] = listRubricProposals(root).map((slug) => ({
      slug,
      head: (readRubricFile(root, slug, "PROPOSAL.md") ?? "")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .slice(0, 3),
    }));
    // A skipped or failed gh read stays undefined — "we did not ask" and
    // "there are none" are different answers.
    const repo = app.view.repo ?? "";
    let improvements: ImprovementItem[] | undefined;
    let improvementsFailed: Array<"pr" | "issue"> = [];
    if (repo) {
      const res = await app.ssh(
        app.cfg.ssh_host,
        improvementsArgv(app.cfg, repo, this.deps.issueLabel),
        {
          timeoutMs: 20_000,
        },
      );
      if (res.ok) {
        // gh fails per list inside a successful shell: both failing is an
        // unread pane, one failing is a partial read that says so.
        const read = parseImprovements(res.stdout);
        if (read.failed.length < 2) {
          improvements = read.items;
          improvementsFailed = read.failed;
        }
      }
    }
    return { proposals, improvements, improvementsFailed };
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
      // The ls itself failed — "no digest has been written" and "I could not
      // look" must never look alike.
      this.digest.listError = "the digest directory could not be listed over ssh";
      this.digest.files = undefined;
    } else {
      this.digest.listError = undefined;
      this.digest.files = listed;
      this.digest.back = Math.min(this.digest.back, Math.max(0, listed.length - 1));
    }
    // The listing may have moved the selection to another day: the text on
    // hand belongs to the day it was read for, never under another heading.
    if (currentDigestFile(this.digest) !== this.digestContentFile) {
      this.digest.content = undefined;
      this.digest.contentError = undefined;
    }
    await this.loadDigestContent();
    this.loaded("digest");
  }

  /** Bumped per content read; only the newest read's answer may land. */
  private digestReadSeq = 0;
  /** The file `digest.content` / `contentError` were read for. */
  private digestContentFile: string | undefined;

  private async loadDigestContent(): Promise<void> {
    const file = currentDigestFile(this.digest);
    const seq = ++this.digestReadSeq;
    this.digest.contentError = undefined;
    const content = file ? await this.digestFetcher.read(file) : undefined;
    // Paging does not cancel a read in flight: only the latest read may land,
    // or a slow read lands under another heading — or, paged away and back,
    // a stale failure overwrites the fresh text of the same day.
    if (seq !== this.digestReadSeq || currentDigestFile(this.digest) !== file) return;
    this.digestContentFile = file;
    this.digest.content = content;
    if (file && content === undefined)
      this.digest.contentError = `${file} could not be read over ssh`;
  }

  /** Page the digest by `dir` days (+1 older, −1 newer). False at a boundary. */
  pageDigest(dir: 1 | -1): boolean {
    const files = this.digest.files ?? [];
    const next = this.digest.back + dir;
    if (next < 0 || next >= files.length) return false;
    this.digest.back = next;
    this.digest.scroll = 0;
    this.digest.content = undefined;
    this.digest.contentError = undefined;
    this.digestContentFile = undefined;
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

  /** The checkout the proposals live in — listing, accepting and rejecting
   * all address the same one. */
  private get repoRoot(): string {
    return this.deps.repoRoot ?? process.cwd();
  }

  /** One accept at a time: each is several awaited git subprocesses in the
   * one shared checkout, and two interleaved would commit each other's
   * staged files. A second request while one runs is refused, not queued —
   * the operator presses A again once the first has answered. Holds the
   * slug being accepted, so a rejection of that same proposal waits too. */
  private accepting: string | undefined;

  accept(slug: string): Promise<{ ok: boolean; message: string }> {
    if (this.accepting !== undefined)
      return Promise.resolve({
        ok: false,
        message: `an accept is already running — '${slug}' not started; press A again once it answers`,
      });
    this.accepting = slug;
    // Async so a synchronous throw still reaches `.finally` — a latch that
    // never clears would refuse every accept for the rest of the session.
    const run = (async () =>
      this.deps.accept
        ? this.deps.accept(this.app, slug)
        : acceptProposal(
            {
              git: { run: this.deps.gitRun ?? failingGit },
              repoRoot: this.repoRoot,
              today: () => this.now().toISOString().slice(0, 10),
              ...(this.deps.configPath ? { configPath: this.deps.configPath } : {}),
            },
            slug,
          ))();
    return run
      .catch((err: unknown) => ({
        ok: false,
        message: `accept failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      }))
      .finally(() => {
        this.accepting = undefined;
      });
  }

  async reject(slug: string, reason: string): Promise<{ ok: boolean; message: string }> {
    if (this.deps.reject) return this.deps.reject(this.app, slug, reason);
    // An accept of this proposal already holds its patch and is committing
    // it: a rejection now would record a verdict the commit contradicts.
    if (this.accepting === slug)
      return {
        ok: false,
        message: `'${slug}' is being accepted — not rejected; press x again once the accept answers`,
      };
    // The sweep's never-re-propose contract rides this memory entry, so it
    // is written first: the proposal is removed only once the rejection is
    // on record, and a refused record leaves it in place to reject again.
    const mem = await this.memory.apply({
      op: "add",
      text: `#rejected-proposal ${slug} — ${reason}`,
    });
    if (!mem.ok)
      return {
        ok: false,
        message: `'${slug}' not rejected — the memory record failed, the proposal stays: ${mem.message}`,
      };
    try {
      removeRubricDir(this.repoRoot, slug);
    } catch (err) {
      return {
        ok: false,
        message: `rejection of '${slug}' recorded, but ${join(rubricDir(this.repoRoot), slug)} could not be removed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
      };
    }
    return { ok: true, message: `rejected '${slug}' — recorded` };
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

/** Install `memory`, `digest`, `tickets` and `feedback` over one store. */
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
