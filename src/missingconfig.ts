// The refusal `loadConfig` raises when the live config does not exist: its
// message already says where it looked and what writes one, so the `qcr` bin
// prints it as one line (`qcr <verb>: <message>`) instead of a stack. A leaf,
// so the bin's front door can recognise it without loading the config module.
export class MissingConfigError extends Error {
  override readonly name = "MissingConfigError";
}
