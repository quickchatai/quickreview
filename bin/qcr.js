#!/usr/bin/env node
// The `qcr` command as a package's bin. A package manager links it under the
// name `qcr`, so the CLI module cannot recognise itself by its file name: this
// file imports it and calls `main` explicitly. The image's
// `node /opt/qcr/dist/src/cli.js` is the same entry, run directly.
import { main } from "../dist/src/cli.js";

await main(process.argv.slice(2));
