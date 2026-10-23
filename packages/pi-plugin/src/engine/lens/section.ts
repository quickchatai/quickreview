// The words an engine-route round order carries beyond the seeded round template.
// Pure, and apart from packages/pi-plugin/src/engine/prompts.ts (whose closure reaches the state
// store) so the bot worker can append the same section the one-shot round does.

/** What the engine launched at round start: the task directory and the agents of
 * its rows, in row order. */
export interface EngineWaveNote {
  dir: string;
  agents: readonly string[];
}

/**
 * The words an engine-route round order carries beyond the seeded round
 * template (rule 6: the template is frozen and names `subagent` and
 * `launch_plan`; packages/pi-plugin/src/engine/lens/tool.ts names `lens` and `lens_wave`). Engine
 * code, never `prompts/round-*.md`: it is appended to the order by the round
 * (round.ts) only when the runtime hosts the engine's lens tools.
 *
 * `wave` present: the engine started the planned discovery rows (pass-validate
 * never among them) and the session collects them. Absent: the session launches
 * the planned rows itself, through `lens_wave` over the task directory.
 */
export function engineLensSection(taskDir: string, wave: EngineWaveNote | null): string {
  const lines = [
    "## ENGINE LENS ROUTE (overrides the lens tool names above)",
    "",
    "The lens tools on this route are `lens` and `lens_wave`. Wherever this order says `subagent`, call " +
      "`lens`; wherever it says `launch_plan`, call `lens_wave`. A lens pass cannot launch anything.",
    "",
  ];
  if (wave) {
    lines.push(
      `The engine started the planned discovery wave when this round began, from the task files in ${wave.dir} ` +
        `(${wave.agents.length} rows: ${wave.agents.join(", ")}). Those lenses are already running: do not ` +
        "launch them again, and do not read their task files in their place.",
      "",
      "Collect the wave with ONE `lens_wave` call and no arguments: it returns every row that has finished " +
        "and waits for the rest. Read the diff and the context while the wave runs, then call it. It never " +
        "launches a row twice, and its `extra` and `skip` do not apply to rows the engine started.",
      "",
      "Everything else is yours to launch with `lens`, several passes in ONE call so they run together: a row " +
        "you raise to a higher tier (it runs in addition to the planned row, which has already started), a lens " +
        "you add, the optional rows, the sweep and the validator.",
    );
  } else {
    lines.push(
      `Launch the planned discovery rows with ONE \`lens_wave\` call: \`dirs\` is [${JSON.stringify(taskDir)}] ` +
        "(plus the optional and sweep directories when this order names them). It starts every row and " +
        "waits for the results, and takes the same `extra` and `skip` as `launch_plan` does. Rows you raise, " +
        "lenses you add and the validator go through `lens`.",
    );
  }
  return lines.join("\n");
}
