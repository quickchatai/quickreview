// The env shim for ledger-pin: the one place the process's env and cwd become
// its config (extensions/ledger-pin.ts).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createLedgerPin, ledgerPinConfigFromEnv } from "../ledger-pin.js";

export default function activate(pi: ExtensionAPI): void {
  void createLedgerPin(ledgerPinConfigFromEnv(process.env, process.cwd()))(pi);
}
