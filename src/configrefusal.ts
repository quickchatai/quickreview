// A config that does not load, at a process's entry: one line on stderr and
// exit 1, never a stack. The `qcr` bin's front door (src/qcrbin.ts `runBin`)
// prints it that way; so do the two entries that bypass it, the daemon
// (`node dist/src/wire.js`, docker/entrypoint.sh) and the image's `qcr`
// wrapper (`node dist/src/cli.js`). A leaf over the two refusal classes, so an
// entry can recognise a refusal without loading the config modules.
import { ConfigError } from "@quickchatai/pi-quickreview/src/configerror.js";
import { MissingConfigError } from "./missingconfig.js";

/** Is `err` a config refusal: no live config, or one that does not load?
 * Its message is already the one line to print. */
export function isConfigRefusal(err: unknown): err is MissingConfigError | ConfigError {
  return err instanceof MissingConfigError || err instanceof ConfigError;
}

export interface EntryIo {
  say: (line: string) => void;
  exit: (code: number) => void;
}

const PROCESS_IO: EntryIo = {
  say: (line) => console.error(line),
  // Exit outright: an entry that refused its config has nothing to finish,
  // and a handle it opened first must not keep the process up.
  exit: (code) => process.exit(code),
};

/** Run an entry's `main`; a config refusal it throws becomes
 * `<prefix>: <message>` on stderr and exit 1. Anything else propagates. */
export async function runRefusingConfig(
  prefix: string,
  main: () => Promise<void>,
  io: EntryIo = PROCESS_IO,
): Promise<void> {
  try {
    await main();
  } catch (err) {
    if (!isConfigRefusal(err)) throw err;
    io.say(`${prefix}: ${err.message}`);
    io.exit(1);
  }
}
