// The private team's GitHub handles, as sha256 digests of the lower-cased
// handle, so a file that ships publicly can check for them without naming
// anyone. A text "carries" a handle when one of its words (a run of letters,
// digits and dashes, lower-cased) hashes to a listed digest.
import { createHash } from "node:crypto";

const HANDLE_SHA256 = new Set([
  "08a5fe2ed185892427026912a15847b377260bdf0d561b57d3a7bc3d33dcd554",
  "d2d92295bb52e8470ee69ec3e7a0f35b10023e188ea45237b72721b43f7709e9",
  "6fd9ee6d18d0b65afb5ec3742a59f520ac634d714c06223d4487bffcae3cf79c",
  "d1789a71e11bd6074c3a9d4d2562289130afcc9e2d920eee438b97c6a696e05d",
  "1f370074e6a26a84521980187fd86a413e350e35ee7c116d2649d3da9467cc2e",
]);

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** The 1-based line numbers of `text` that carry a private handle. */
export function privateHandleLines(text: string): number[] {
  const hits: number[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const words = lines[i]!.toLowerCase().match(/[a-z0-9][a-z0-9-]*/g) ?? [];
    if (words.some((w) => HANDLE_SHA256.has(sha256(w)))) hits.push(i + 1);
  }
  return hits;
}
