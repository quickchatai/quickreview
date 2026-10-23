// Env names that carry a GitHub credential. A process that runs a model's
// tools, or hands an env to a child that does, drops every one of these
// first: the token never reaches a process the model can read. And git's
// isolation, which every such env carries. No imports, so engine code, scan
// and the daemon can all take it.
export const GITHUB_TOKEN_ENVS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;

/** Git without any system or global config and never prompting: every
 * environment a reviewer's model or a harness git call runs in carries it. */
export const GIT_ISOLATION_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
} as const;
