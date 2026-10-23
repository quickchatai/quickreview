import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** The newline policy of a wake or command payload: exactly one trailing
 * newline is guaranteed, an existing one is kept. Both the direct inject files
 * and the durable worker commands write their bytes through it. */
export function messagePayload(message: string): string {
  return message.endsWith("\n") ? message : `${message}\n`;
}

/** A session command's saved payload, checked against the sha256 recorded at
 * dispatch — or why it cannot be replayed (unreadable, or not the bytes that
 * were dispatched). Every recovery route reads its payload through here and
 * decides its own outcome. */
export function verifiedPayload(
  command: {
    payload_path: string;
    payload_sha256: string;
  },
  label = `payload ${command.payload_path}`,
): { ok: true; payload: Buffer } | { ok: false; why: string } {
  let payload: Buffer;
  try {
    payload = readFileSync(command.payload_path);
  } catch (err) {
    return { ok: false, why: `${label} unreadable: ${String(err)}` };
  }
  const hash = createHash("sha256").update(payload).digest("hex");
  if (hash !== command.payload_sha256)
    return {
      ok: false,
      why: `${label} hash ${hash} != ${command.payload_sha256}`,
    };
  return { ok: true, payload };
}
