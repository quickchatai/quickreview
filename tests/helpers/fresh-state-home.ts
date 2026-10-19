// Each test gets its own state home (a subdir of the file's temp root). The
// review store keys a repo by origin and root commit, so two fixture repos that
// share an origin and a root commit — the same `o/r` built twice in one second
// — would otherwise share one review history across tests.
import { join } from "node:path";
import { beforeEach } from "vitest";

export function freshStateHomePerTest(): void {
  let n = 0;
  beforeEach(() => {
    process.env.XDG_STATE_HOME = join(process.env.QCR_TEST_TEMP_ROOT!, `state-${++n}`);
  });
}
