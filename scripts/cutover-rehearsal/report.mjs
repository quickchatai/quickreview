#!/usr/bin/env node
// Render docs/cutover-rehearsal.md from a run: report.mjs <results.tsv> <facts.tsv> <out.md> <sha> <findings.md>
// The findings and the limits are written by hand in findings.md beside this file and carried in as they
// are; everything else is this run's.
import { readFileSync, writeFileSync } from "node:fs";

const [resultsPath, factsPath, out, sha, findingsPath] = process.argv.slice(2);
const rows = readFileSync(resultsPath, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const facts = new Map(
  readFileSync(factsPath, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")).map(([k, ...v]) => [k, v.join("\t")]),
);
const passed = rows.filter((r) => r[1] === "pass").length;
const failed = rows.length - passed;
const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const date = new Date().toISOString().slice(0, 10);
const worker = (id) => /^(WEBHOOK|RESUME|WAVE|PERMIT|POST|ANSWER|TAKEOVER|DEBUG|RESTART|BREAKER|LOGIN-1|BUSY|TREE-1|STATUS|NETCAP)/.test(id);
const table = (list) => {
  const md = ["| | check | result | evidence |", "|---|---|---|---|"];
  for (const [id, status, title, detail] of list)
    md.push(`| ${id} | ${cell(title)} | ${status === "pass" ? "pass" : "**FAIL**"} | ${cell(detail)} |`);
  return md;
};

const md = [];
md.push("# Cutover rehearsal", "");
md.push(
  `P8.20. The real cutover tooling, end to end, against a throwaway legacy-shaped host: \`scripts/cutover.sh\` (the P8.21a wizard) driving \`scripts/deploy.sh\`, ssh, \`deploy/qcr-update.sh\`, a registry and the release and memory images built from this tree, over a host directory a LEGACY build wrote. Four failures are injected before the clean run; the clean run goes through the point of no return, verify, the first reconcile under the operator's hold and the owner's lift, and then the P8.20a worker checks run on the release boot the updater made.`,
  "",
  `Run ${date} on ${sha.slice(0, 8)}. **${passed} of ${rows.length} checks passed, ${failed} failed.** Cost: $0 (no model, no GitHub, no ghcr; the containers sit on an internal docker network with a scripted stub).`,
  "",
  "Re-run it: `scripts/cutover-rehearsal.sh` (about 25 minutes with the images built; `--work DIR` reuses the registry, the pushed images and the pristine legacy host; `--fresh`, `--keep` and `--skip-worker` are in the script's header). It exits 0 only when every check passed, and a full run rewrites this file. The images come from `scripts/worker-rehearsal/build-images.sh` (the same tooling as P8.20a).",
  "",
  "## What is real and what stands in",
  "",
  "Real: `scripts/cutover.sh`, `scripts/deploy.sh` (provision, `--dry-run release`, `release`, `verify`), ssh to a throwaway sshd, `deploy/qcr-update.sh` itself (lock, drain check, layout check, `docker pull` BY DIGEST from a registry, label checks, `qcr config check` and `daemon --preflight` of the NEW image on the staged config and a snapshot of the legacy state, the store copy and its checksum verification, the config swap, the sidecar, the recreate, the rescue), the release and memory images, the release daemon's first boot over a state.db the legacy build (8169df6f) wrote, the migrations, the hold, the login refresher, the entrypoint's login mode.",
  "",
  "Stands in (a test tool; none of it ships): see Limits.",
  "",
  "## The world",
  "",
  `- **Images** from this tree: release \`${(facts.get("release_image") ?? "?").split(" ")[0].slice(0, 19)}\`, memory \`${(facts.get("memory_image") ?? "?").split(" ")[0].slice(0, 19)}\`; build stamp ${facts.get("build_sha") ?? "?"}.`,
  `- **Registry**: ${facts.get("registry") ?? "?"}.`,
  `- **The legacy store**: ${facts.get("legacy_store") ?? "?"}.`,
  "",
  "## Results: the cutover",
  "",
  ...table(rows.filter((r) => !worker(r[0]))),
  "",
  "## Results: the worker checks on the release boot (scripts/worker-rehearsal.sh --adopt)",
  "",
  ...table(rows.filter((r) => worker(r[0]))),
  "",
  "## Run notes",
  "",
);
for (const k of ["wizard_a", "backups", "update_log", "trigger_under_hold", "login_refresh", "process_tree", "worker_run", "ssh_commands"])
  if (facts.has(k)) md.push(`- **${k.replaceAll("_", " ")}**: \`${facts.get(k)}\``);
md.push("");
md.push(readFileSync(findingsPath, "utf8").trim(), "");
writeFileSync(out, md.join("\n"));
