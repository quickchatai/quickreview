// Production assembly of quickreviewd: createDaemon() with the real pi session
// manager, the round-template renderer, the agents build step, the EOD timer,
// the overseer command executor, and the weekly overseer rotation. `npm run
// daemon` runs this; createDaemon() alone (src/daemon.ts) stays the
// stub-wired, test-friendly core.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, sandboxRoot, type Config } from "./config.js";
import { CommandWatcher, type CommandDeps } from "./commands.js";
import { createDaemon, type Daemon } from "./daemon.js";
import { latestDigestHeadline } from "./digest.js";
import { promptReader, startEodTimer, type EodTimer } from "./eod.js";
import { MutationGate, type MutationIntent } from "./gate.js";
import { GitHubAdapter } from "./github.js";
import { TokenMinter } from "./githubAuth.js";
import { buildAgents } from "./include.js";
import { fileImprovementPr, fileIssue, type Run } from "./improvements.js";
import { PiSessionManager } from "./sessions.js";
import { renderRoundPrompt, roundTemplateFile } from "./templates.js";
import { nodeExec } from "./tmux.js";
import type { RoundOrder } from "./types.js";

export interface ProductionParts {
  cfg: Config;
  root: string;
  minter: TokenMinter;
  gate: MutationGate;
  adapter: GitHubAdapter;
  sessions: PiSessionManager;
}

export function buildParts(root = sandboxRoot(), cfg = loadConfig()): ProductionParts {
  const minter = new TokenMinter(cfg.github.secrets_dir);
  const gate: MutationGate = new MutationGate(cfg.dry_run, join(root, "state", "dryrun"), (intent: MutationIntent) =>
    adapter.executeMutation(intent),
  );
  const adapter: GitHubAdapter = new GitHubAdapter(cfg, minter, gate);
  const sessions = new PiSessionManager({ cfg, root });
  return { cfg, root, minter, gate, adapter, sessions };
}

const gitRun: Run = async (args, cwd) => (await nodeExec("git", args, cwd ? { cwd } : {})).stdout;

export function createProductionDaemon(parts: ProductionParts = buildParts()): Daemon {
  const { cfg, root, gate, adapter, sessions } = parts;
  const log = (msg: string, extra?: unknown) => console.log(`[quickreviewd] ${msg}`, extra ?? "");

  const renderPrompt = (order: RoundOrder): string =>
    renderRoundPrompt(readFileSync(join(root, "prompts", roundTemplateFile(order.round_type)), "utf8"), order);

  let eod: EodTimer | null = null;
  let commands: CommandWatcher | null = null;

  const daemon = createDaemon({
    cfg,
    root,
    adapter,
    hooks: sessions,
    renderPrompt,
    log,
    digestHeadline: () => latestDigestHeadline(join(root, "digest")),

    async onStart(d) {
      // Lens agents: expand {{include:...}} + per-pass model overrides into the
      // build dir pi-subagents is pointed at (.pi/subagents.config.json).
      const built = buildAgents(join(root, "agents"), join(root, "state", "agents"), { root, models: cfg.models.passes });
      log(`built ${built.length} pass agents into state/agents`);

      // Adopt live sessions + sweep stale worktrees (never kills a live session).
      const active = d.store.allPrs().filter((p) => p.state !== "closed").map((p) => p.number);
      const pre = await sessions.preflight(active);
      log(`preflight: adopted=${pre.adoption.adopted.join(",") || "none"} swept-worktrees=${pre.sweptWorktrees.join(",") || "none"}`);

      // The overseer must exist from boot — lazily spawning it on the first
      // anomaly left `tmux attach -t overseer` dead after every restart.
      try {
        await sessions.ensureOverseerSession();
        log("overseer session ready");
      } catch (err) {
        log("overseer spawn failed (will retry on first wake)", err);
      }

      // Overseer command files → validated execution (whitelist + caps).
      const commandDeps: CommandDeps = {
        async rerunRound(pr) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.upsertPr({ ...row, state: "queued", trigger_ts: new Date().toISOString() });
          await d.pump();
          return { ok: true, requeued: pr };
        },
        async restartSession(target) {
          if (target === "overseer") {
            const name = await sessions.rotateOverseer();
            return { ok: true, respawned: name };
          }
          // Kill the tmux session; the next dispatched round rebirths it fresh.
          await sessions.tmux.killSession(`pr-${target}`).catch(() => {});
          const row = d.store.getPr(target);
          if (row && row.state !== "closed") {
            d.store.upsertPr({ ...row, state: "queued", trigger_ts: new Date().toISOString() });
            await d.pump();
          }
          return { ok: true, restarted: `pr-${target}` };
        },
        markEscalationWorthy(pr, reason) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.upsertPr({ ...row, escalation_worthy: 1 });
          d.store.logEvent("marked_escalation_worthy", pr, { reason });
          return { ok: true };
        },
        pausePr(pr, reason) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.setPaused(pr, true);
          d.store.logEvent("pr_paused", pr, { reason });
          return { ok: true, paused: pr };
        },
        async resumePr(pr) {
          const row = d.store.getPr(pr);
          if (!row) return { ok: false, reason: `unknown PR #${pr}` };
          d.store.setPaused(pr, false);
          d.store.logEvent("pr_resumed", pr, {});
          await d.pump();
          return { ok: true, resumed: pr };
        },
        flagOwnerLegacy(message) {
          const flags = join(root, "state", "flags");
          mkdirSync(flags, { recursive: true });
          appendFileSync(join(flags, "owner-legacy.log"), `${new Date().toISOString()} ${message}\n`);
          d.store.logEvent("flag_owner_legacy", null, { message });
          return { ok: true };
        },
        fileImprovementPr(payload) {
          return fileImprovementPr(payload, {
            cfg,
            adapter,
            gate,
            store: d.store,
            run: gitRun,
            scratchDir: join(root, "state", "scratch-improve"),
          });
        },
        fileIssue(payload) {
          return fileIssue(payload, { cfg, adapter, gate, store: d.store });
        },
      };
      commands = new CommandWatcher({ dir: join(root, "commands"), deps: commandDeps, store: d.store, log: (l) => log(l) });
      await commands.start();

      // Daemon-clock EOD (Warsaw wall time; pi schedulers deliberately unused).
      eod = startEodTimer({
        timeHHMM: cfg.eod.time,
        timeZone: cfg.eod.timezone,
        readPrompt: promptReader(join(root, "prompts", "eod-sweep.md")),
        injectOverseer: (m) => sessions.injectOverseer(m),
        onFire: (date) => log(`EOD sweep injected for ${date}`),
        onError: (err) => log("EOD injection failed", err),
      });
      log(`EOD timer armed for ${eod.nextFire().toISOString()}`);

      // Weekly overseer rotation, checked hourly.
      const rotation = setInterval(() => {
        void sessions.rotateOverseerIfDue().then((rotated) => {
          if (rotated) log("overseer rotated (weekly)");
        }).catch((err) => log("overseer rotation failed", err));
      }, 3600_000);
      rotation.unref?.();
    },

    async onStop() {
      eod?.stop();
      commands?.stop();
    },
  });

  return daemon;
}

async function main(): Promise<void> {
  const daemon = createProductionDaemon();
  const shutdown = (sig: string) => {
    void (async () => {
      console.log(`[quickreviewd] ${sig} — shutting down`);
      await daemon.stop();
      process.exit(0);
    })();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  await daemon.start();
}

if (process.argv[1]?.endsWith("wire.js")) {
  void main();
}
