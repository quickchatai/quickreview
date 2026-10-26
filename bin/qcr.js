#!/usr/bin/env node
// The `qcr` command as a package's bin. A package manager links it under the
// name `qcr`, so the CLI module cannot recognise itself by its file name: this
// file imports the bin's front door and calls it explicitly. The front door
// (src/qcrbin.ts) runs the verbs an npm install needs without the state
// database's native driver, opens the home on a bare `qcr`, and hands
// every other verb to the app's `main` (src/cli.ts). The image's
// `node /opt/qcr/dist/src/cli.js` is the app's entry, run directly.
import { runBin } from "../dist/src/qcrbin.js";

await runBin(process.argv.slice(2));
