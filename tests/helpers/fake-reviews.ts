// A reviews port with no reviewer behind it, for home tests about something
// else (the switches, the label): nothing is reviewed, every action refuses,
// and a status is unknown.
import type { Known, ReviewsPort } from "../../src/home/ports.js";

const known = <T>(value: T): Known<T> => ({ kind: "known", value });

export function idleReviews(): ReviewsPort {
  const no = async (): Promise<{ ok: false; why: string }> => ({
    ok: false,
    why: "no reviewer in this test",
  });
  return {
    latest: async () => known(new Map()),
    autoRounds: async () => known(new Map()),
    preview: no,
    start: no,
    stop: no,
    post: no,
    status: async () => ({ kind: "unknown", why: "no reviewer in this test" }),
    runs: async () => known([]),
    dryRun: async () => known(true),
  };
}
