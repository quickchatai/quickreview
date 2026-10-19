// The engine's side of the LiveEvent log (src/live/): which directory a round
// writes to, and how a `launch_plan` call is resolved into the tasks it
// launches. The writer itself knows nothing of the lens tool or the task dirs
// (so a daemon-side reader can import src/live/ without the engine); this is
// the one place they meet.
import { liveRoundDir } from "../live/events.js";
import { createLiveWriter, type LiveSink, type LiveWriter } from "../live/writer.js";
import { planLaunch } from "./lens/launch-plan.js";

/** Where a round's LiveEvent logs go: `<root>/state/live/<key>/r<round>/`. */
export interface RoundLive {
  /** The state-bearing directory (a run dir on the one-shot routes). */
  root: string;
  /** `pr-<n>` on the bot; the review's name on a one-shot. */
  key: string;
  round: number;
}

/** The writer for one round. `env` is the session's environment: a launch plan
 * resolves its task dirs against it, as the lens tool does. */
export function roundLiveWriter(
  live: RoundLive,
  env: Readonly<Record<string, string | undefined>>,
  warn?: (message: string) => void,
): LiveWriter {
  return createLiveWriter({
    dir: liveRoundDir(live.root, live.key, live.round),
    env,
    ...(warn ? { warn } : {}),
    launchExecutions: (args, planEnv) => {
      const plan = planLaunch(args, { ...planEnv });
      return plan.ok ? plan.units.map(({ agent, phase }) => ({ agent, phase })) : [];
    },
  });
}

/** The main session's sink for a round, started with its identity. */
export function openRoundSink(
  live: RoundLive,
  who: { pr: number; session: string },
  env: Readonly<Record<string, string | undefined>>,
  warn?: (message: string) => void,
): LiveSink {
  return roundLiveWriter(live, env, warn).main({
    key: live.key,
    round: live.round,
    pr: who.pr,
    session: who.session,
  });
}
