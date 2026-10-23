// Disk-logging SessionHooks stub: the daemon's default when no real session
// manager (sessions.ts) is wired in, used by tests and CLI operations. Every
// round order, injection and archive request is written under state/ where
// the caller can read it back.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RoundOrder, SessionHooks } from "@quickchatai/pi-quickreview/src/types.js";

let written = 0;

/** A filename stamp: the time, then a per-process sequence, so two requests
 * in one millisecond land in two files rather than one overwriting the other
 * (and names still sort in write order). */
function stamp(): string {
  const seq = String(written++).padStart(6, "0");
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${seq}`;
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

export function stubSessionHooks(
  root: string,
  log: (msg: string, extra?: unknown) => void = () => {},
): SessionHooks {
  const paths = stubHookPaths(root);
  return {
    async dispatchRound(order: RoundOrder, renderedPrompt: string): Promise<void> {
      const path = writeJson(paths.roundOrders, `${order.pr}-${order.round_no}.json`, {
        order,
        prompt: renderedPrompt,
      });
      log(
        `[stub] dispatchRound #${order.pr} round ${order.round_no} (${order.round_type}) → ${path}`,
      );
    },
    async inject(pr: number, message: string): Promise<void> {
      const path = writeJson(paths.injections, `pr-${pr}-${stamp()}.json`, { pr, message });
      log(`[stub] inject #${pr} → ${path}`);
    },
    async archiveAndClose(pr: number): Promise<void> {
      const path = writeJson(paths.archives, `pr-${pr}-${stamp()}.json`, {
        pr,
        requested_at: new Date().toISOString(),
      });
      log(`[stub] archiveAndClose #${pr} → ${path}`);
    },
  };
}
