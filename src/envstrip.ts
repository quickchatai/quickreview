// Env names that carry a GitHub credential. A process that runs a model's
// tools, or hands an env to a child that does, drops every one of these
// first: the token never reaches a process the model can read. No imports,
// so engine code, scan and the daemon can all take it.
export const GITHUB_TOKEN_ENVS = ["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;
