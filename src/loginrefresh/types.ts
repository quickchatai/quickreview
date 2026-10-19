// The refresher's published state. Its own module, so `src/state.ts` can type
// the heartbeat block without importing the supervisor.

/** What the refresher writes into its status file (and the daemon folds into
 * status.json `login_refresh`). Never a token. */
export interface LoginRefreshFileStatus {
  pid: number;
  started_at: string;
  /** The earliest OAuth expiry in auth.json, ISO; null when there is none (or no login yet). */
  expires_at: string | null;
  /** The provider that expiry belongs to. */
  provider: string | null;
  /** The last successful refresh, ISO; null before the first. */
  last_refresh: string | null;
  /** The last failure's text while the failure lasts; null after a success. */
  last_error: string | null;
  /** When the current failure began (one anomaly per such episode). */
  error_since: string | null;
  /** True while a login holds the handover: no refresh, no write, lock kept. */
  paused: boolean;
  /** The last time the refresher looked at the login, ISO. */
  checked_at: string | null;
}

/** The daemon's view: the supervised process plus the file it publishes. */
export interface LoginRefreshStatus {
  state: "off" | "unavailable" | "supervised";
  reason?: string;
  running: boolean;
  restarts: number;
  /** The last exit of the refresher process. */
  last_exit?: { code: number | null; signal: string | null; at: string };
  /** The refresher's own file, absent until it has written one. */
  login?: LoginRefreshFileStatus;
}
