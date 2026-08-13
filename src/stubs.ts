// Disk-logging SessionHooks stub. B3 owns the real tmux/pi session manager;
// until it lands the daemon runs end-to-end against this: every round order,
// injection and archive request is written under state/ where the tests and
// the dry-run acceptance run can read it back.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoundOrder, SessionHooks } from "./types.js";

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function writeJson(dir: string, name: string, data: unknown): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

export interface StubHookPaths {
  roundOrders: string;
  injections: string;
  archives: string;
}

export function stubHookPaths(root: string): StubHookPaths {
  const state = join(root, "state");
  return {
    roundOrders: join(state, "round-orders"),
    injections: join(state, "injections"),
    archives: join(state, "archive-requests"),
  };
}

export function stubSessionHooks(root: string, log: (msg: string, extra?: unknown) => void = () => {}): SessionHooks {
  const paths = stubHookPaths(root);
  return {
    async dispatchRound(order: RoundOrder, renderedPrompt: string): Promise<void> {
      const path = writeJson(paths.roundOrders, `${order.pr}-${order.round_no}.json`, { order, prompt: renderedPrompt });
      log(`[stub] dispatchRound #${order.pr} round ${order.round_no} (${order.round_type}) → ${path}`);
    },
    async inject(pr: number, message: string): Promise<void> {
      const path = writeJson(paths.injections, `pr-${pr}-${stamp()}.json`, { pr, message });
      log(`[stub] inject #${pr} → ${path}`);
    },
    async injectOverseer(message: string): Promise<void> {
      const path = writeJson(paths.injections, `overseer-${stamp()}.json`, { message });
      log(`[stub] injectOverseer → ${path}`);
    },
    async archiveAndClose(pr: number): Promise<void> {
      const path = writeJson(paths.archives, `pr-${pr}-${stamp()}.json`, { pr, requested_at: new Date().toISOString() });
      log(`[stub] archiveAndClose #${pr} → ${path}`);
    },
  };
}
