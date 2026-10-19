// Entry point of the memory image (docker/memory/): `node dist/src/openviking/
// sidecar-main.js`, started by docker/memory/entrypoint.sh once the boot
// steps have run. Reads the same config.toml the daemon reads ($QCR_CONFIG)
// and serves until SIGTERM.
import { loadConfig } from "../config.js";
import { startSidecar } from "./sidecar.js";

const log = (msg: string, extra?: unknown): void => {
  if (extra === undefined) console.log(msg);
  else console.log(`${msg} ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`);
};

const cfg = loadConfig().openviking;
if (!cfg.enabled) {
  log("openviking: memory is disabled in config.toml — the sidecar idles");
  setInterval(() => undefined, 1 << 30);
} else {
  const bindHost = process.env.QCR_OPENVIKING_BIND_HOST ?? "0.0.0.0";
  const sidecar = startSidecar({
    cfg,
    repoRoot: process.env.QCR_APP_ROOT ?? "/opt/qcr",
    secretsDir: process.env.QCR_SECRETS ?? "/opt/quickreview/secrets",
    bindHost,
    log,
  });
  log(
    `openviking: memory sidecar up — serving :${cfg.port} on ${bindHost} for endpoint = remote daemons`,
  );
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`openviking: ${signal} — stopping the sidecar`);
    void sidecar.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
