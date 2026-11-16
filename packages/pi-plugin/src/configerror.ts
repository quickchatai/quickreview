// The refusal a config file raises when it does not load: one line that names
// the file and what in it is wrong (the key, or the place a TOML syntax error
// is), so the `qcr` bin prints it as `qcr <verb>: <message>` instead of a
// stack. A leaf, so the bin's front door can recognise it without loading the
// config modules.

/** A config file that does not load: its path, and one line saying why. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(
    readonly file: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The one line `err` says about the config file `file`. A parser's message
 * names the file generically (`config.toml [review]: …`), so the path takes
 * that word's place; a TOML syntax error keeps its first line and says where
 * it is; anything else is put after the path. */
export function configErrorAt(file: string, err: unknown): ConfigError {
  if (err instanceof ConfigError) return err;
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split("\n", 1)[0]!.trim();
  const at = err as { line?: unknown; column?: unknown } | null;
  const where =
    typeof at?.line === "number" && typeof at.column === "number"
      ? ` (line ${at.line}, column ${at.column})`
      : "";
  const named = /^config\.toml(?=[\s:]|$)/.exec(first);
  const said =
    named !== null ? `${file}${first.slice(named[0].length)}` : `${file}: ${first}${where}`;
  return new ConfigError(file, said, { cause: err });
}
