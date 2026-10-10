// The concurrency lens's content trigger: pass-concurrency has no PATH
// predicate, but a diff that touches synchronisation in its own language, or a
// PR whose text says it is about a race or a lock, plans it through
// SUBLENS_TRIGGERS. Every
// spelling below is pinned in both directions: it fires in its language, and
// a near-miss (another language, a lockfile, a test file) does not.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { buildPassPlan } from "../src/dispatch.js";
import type { PrFileEntry } from "../src/github.js";
import {
  SUBLENS_PASSES,
  SUBLENS_TRIGGERS,
  selectSubLenses,
  type PrFile,
} from "../src/heuristics.js";
import { ALL_PASSES } from "../src/passes.js";
import { addendaForPass, buildAgents, PASS_ADDENDA } from "../src/include.js";
import { mkdtempSync, readFileSync as rf, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONC = "pass-concurrency";

const changed = (filename: string, lines: string[], sign: "+" | "-" = "+"): PrFile => ({
  filename,
  additions: sign === "+" ? lines.length : 0,
  deletions: sign === "-" ? lines.length : 0,
  status: "modified",
  patch: ["@@ -1,1 +1,2 @@", ...lines.map((l) => `${sign}${l}`)].join("\n"),
});

function concurrencyWhy(
  files: PrFile[],
  text: { title?: string; body?: string } = {},
): string | null {
  return selectSubLenses(files, text).find((s) => s.lens === CONC)?.why ?? null;
}

describe("pass-concurrency content trigger — synchronisation spellings, per language", () => {
  const FIRES: Array<[string, string]> = [
    // Go
    ["pkg/assets.go", "var mu sync.RWMutex"],
    ["pkg/assets.go", "\tmu.Lock()"],
    ["pkg/assets.go", "\tdefer mu.RUnlock()"],
    ["pkg/assets.go", "atomic.AddInt64(&n, 1)"],
    ["pkg/assets.go", "var hits atomic.Int64"],
    ["pkg/assets.go", "go func() { work() }()"],
    ["pkg/assets.go", "go worker(ctx, jobs)"],
    ["pkg/assets.go", "jobs := make(chan Job, 8)"],
    ["pkg/assets.go", "v := <-results"],
    ["pkg/assets.go", "var once sync.Once"],
    // Java / Kotlin
    ["src/main/java/Cache.java", "public synchronized void put(K k, V v) {"],
    ["src/main/java/Cache.java", "private volatile boolean ready;"],
    ["src/main/java/Cache.java", "private final ReentrantLock lock = new ReentrantLock();"],
    ["src/main/java/Cache.java", "Map<K, V> m = new ConcurrentHashMap<>();"],
    ["src/main/java/Cache.java", "private final AtomicInteger count = new AtomicInteger();"],
    ["src/main/java/Cache.java", "lock.lock();"],
    ["src/main/java/Cache.java", "CompletableFuture.supplyAsync(() -> load());"],
    ["app/src/Repo.kt", "@Synchronized fun bump() {"],
    // Rust
    ["src/pool.rs", "let state = Arc::new(Mutex::new(State::default()));"],
    ["src/pool.rs", "let m: RwLock<HashMap<u32, Conn>> = RwLock::new(HashMap::new());"],
    ["src/pool.rs", "static HITS: AtomicUsize = AtomicUsize::new(0);"],
    ["src/pool.rs", "let guard = state.lock().unwrap();"],
    ["src/pool.rs", "std::thread::spawn(move || run());"],
    ["src/pool.rs", "use tokio::sync::Semaphore;"],
    ["src/pool.rs", "HITS.fetch_add(1, Ordering::SeqCst);"],
    // C / C++
    ["src/queue.cpp", "std::mutex m_;"],
    ["src/queue.cpp", "std::lock_guard<std::mutex> g(m_);"],
    ["src/queue.cpp", "std::atomic<int> n{0};"],
    ["src/queue.c", "pthread_mutex_lock(&q->lock);"],
    ["src/queue.c", "atomic_fetch_add(&q->n, 1);"],
    ["src/queue.h", "volatile int flag;"],
    // C#
    ["src/Store.cs", "lock (_sync) {"],
    ["src/Store.cs", "Interlocked.Increment(ref _count);"],
    ["src/Store.cs", "var d = new ConcurrentDictionary<string, int>();"],
    // Python
    ["app/cache.py", "_lock = threading.Lock()"],
    ["app/cache.py", "from threading import RLock"],
    ["app/cache.py", "lock = asyncio.Lock()"],
    ["app/cache.py", "    with self._lock:"],
    ["app/cache.py", "with ThreadPoolExecutor(max_workers=4) as ex:"],
    ["app/cache.py", "row = Order.objects.select_for_update().get(pk=pk)"],
    ["app/cache.py", "results = await asyncio.gather(*tasks)"],
    // Ruby / Swift
    ["lib/cache.rb", "@mutex = Mutex.new"],
    ["lib/cache.rb", "@mutex.synchronize do"],
    ["Sources/Cache.swift", 'let q = DispatchQueue(label: "cache")'],
    ["Sources/Cache.swift", "actor Counter {"],
    ["Sources/Alert.swift", "func show(completion: @escaping @MainActor @Sendable () -> Void) {"],
    ["Sources/Gen.swift", "nonisolated(unsafe) static var generator = Generator()"],
    ["Sources/Flow.swift", "Task { await self.advance() }"],
    ["Sources/Flow.swift", "Task.detached { work() }"],
    // JS / TS
    ["src/worker.ts", "const w = new Worker(new URL('./w.js', import.meta.url));"],
    ["src/worker.ts", "Atomics.add(view, 0, 1);"],
    ["src/worker.ts", "this.token = await refresh();"],
    ["src/worker.js", "import { Mutex } from 'async-mutex';"],
  ];

  for (const [path, line] of FIRES)
    it(`fires on ${path}: ${line}`, () => {
      const why = concurrencyWhy([changed(path, [line])]);
      expect(why).toMatch(new RegExp(`synchronisation in ${path.replace(/[.]/g, "\\.")}`));
    });

  it("a REMOVED lock fires too — dropping synchronisation is a concurrency change", () => {
    expect(concurrencyWhy([changed("pkg/assets.go", ["\tmu.Lock()"], "-")])).not.toBeNull();
  });

  it("JS/TS: a member bumped in place fires only when the changed lines also await", () => {
    expect(
      concurrencyWhy([changed("src/svc.ts", ["const r = await fetch(u);", "this.count += 1;"])]),
    ).toMatch(/this\.count \+=/);
    expect(concurrencyWhy([changed("src/svc.ts", ["this.count += 1;"])])).toBeNull();
  });

  const SILENT: Array<[string, string]> = [
    // another language's spelling
    ["src/app.ts", "let ch = chan;"],
    ["src/app.ts", "x <- y"],
    ["app/views.py", "volatile = True"],
    ["src/main/java/A.java", "go(fn);"],
    ["src/main.go", "synchronized := true"],
    // ordinary code
    ["src/app.ts", "const total = items.reduce((n, i) => n + i.price, 0);"],
    ["app/views.py", "def get(self, request): return Response(self.data)"],
    ["pkg/assets.go", "func Name() string { return n }"],
    ["src/main/java/A.java", "public int size() { return items.size(); }"],
    ["Sources/Model.swift", "let task = TaskItem(title: name)"],
    ["Sources/Model.swift", "func sendable() -> Bool { true }"],
  ];
  for (const [path, line] of SILENT)
    it(`stays silent on ${path}: ${line}`, () => {
      expect(concurrencyWhy([changed(path, [line])])).toBeNull();
    });

  it("a test file's synchronisation never fires (tests are not the code under review)", () => {
    expect(concurrencyWhy([changed("pkg/assets_test.go", ["var mu sync.Mutex"])])).toBeNull();
    expect(
      concurrencyWhy([changed("tests/test_cache.py", ["_lock = threading.Lock()"])]),
    ).toBeNull();
  });

  it("prose files never fire", () => {
    expect(concurrencyWhy([changed("docs/locking.md", ["Use sync.Mutex here"])])).toBeNull();
  });
});

describe("pass-concurrency content trigger — the PR text", () => {
  const FIRES = [
    "fix data race in the config loader",
    "Avoid race condition when two workers claim a job",
    "Handle concurrent updates to the counter",
    "Make the registry thread-safe",
    "Make the registry threadsafe",
    "Fix deadlock on shutdown",
    "Guard the map with a mutex",
    "Take a row lock before the read",
    "Locking around the refresh",
    "This makes the writes concurrently safe",
  ];
  for (const title of FIRES)
    it(`fires on "${title}"`, () => {
      expect(concurrencyWhy([], { title })).toMatch(/^the PR text says "/);
    });

  const SILENT = [
    "Update package-lock.json",
    "Regenerate the lock file",
    "Bump yarn lockfile",
    "Add tracing to the importer",
    "Block users who embrace spam",
    "Clock skew in the scheduler",
    "Unlock the settings page for admins",
  ];
  for (const title of SILENT)
    it(`stays silent on "${title}"`, () => {
      expect(concurrencyWhy([], { title })).toBeNull();
    });

  it("reads the body as well as the title", () => {
    expect(
      concurrencyWhy([], {
        title: "Assets",
        body: "Readers could see a half-built map; this is a data race.",
      }),
    ).not.toBeNull();
  });
});

describe("pass-concurrency in the plan", () => {
  const cfg: Config = parseConfig(
    readFileSync(resolve(process.cwd(), "tests/fixtures/config.toml"), "utf8"),
  );
  const withSub = (on: boolean): Config => {
    const c = structuredClone(cfg);
    c.review = { ...c.review, sublenses: on };
    return c;
  };
  const files = [
    changed("pkg/assets.go", ["\tmu.RLock()", "\tv, ok := cache[k]"]),
  ] as unknown as PrFileEntry[];

  it("is in the sub-lens registry, first, and in ALL_PASSES in the same order", () => {
    expect(SUBLENS_TRIGGERS[0]?.lens).toBe(CONC);
    expect(ALL_PASSES.filter((p) => SUBLENS_PASSES.includes(p))).toEqual([...SUBLENS_PASSES]);
  });

  it("planned with its reason when the trigger fires and sub-lenses are on", () => {
    const { pass_plan, addable_lenses } = buildPassPlan(withSub(true), files);
    const row = pass_plan.find((p) => p.lens === CONC);
    expect(row?.why).toBe("the diff touches synchronisation in pkg/assets.go (`mu.RLock()`)");
    expect(addable_lenses).not.toContain(CONC);
  });

  it("stays addable, not planned, when the trigger does not fire", () => {
    const { pass_plan, addable_lenses } = buildPassPlan(withSub(true), [
      changed("pkg/assets.go", ["func Name() string { return n }"]),
    ] as unknown as PrFileEntry[]);
    expect(pass_plan.map((p) => p.lens)).not.toContain(CONC);
    expect(addable_lenses).toContain(CONC);
  });

  it("follows the sub-lens lever: off ⇒ addable only", () => {
    const { pass_plan, addable_lenses } = buildPassPlan(withSub(false), files);
    expect(pass_plan.map((p) => p.lens)).not.toContain(CONC);
    expect(addable_lenses).toContain(CONC);
  });
});

describe("the concurrency-planned addendum", () => {
  it("is composed on pass-concurrency in PR builds only, after the on-demand trigger", () => {
    const ids = addendaForPass(CONC).map((a) => a.id);
    expect(ids.indexOf("concurrency-planned")).toBeGreaterThan(ids.indexOf("concurrency-trigger"));
    expect(addendaForPass(CONC, PASS_ADDENDA, "django", "scan").map((a) => a.id)).not.toContain(
      "concurrency-planned",
    );
    for (const pass of ["pass-baseline", "pass-validate", "pass-statelessness"])
      expect(addendaForPass(pass).map((a) => a.id)).not.toContain("concurrency-planned");
  });

  it("makes a planned row's reason the anchor, and keeps the four parts", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-conc-planned-"));
    try {
      buildAgents(resolve(process.cwd(), "agents"), dir, { root: process.cwd() });
      const body = rf(join(dir, `${CONC}--sol-med.md`), "utf8");
      expect(body).toContain("When the plan PLANNED you");
      expect(body).toContain("NOT the missing anchor");
      expect(body).toContain("four parts");
      expect(body.indexOf("When the plan PLANNED you")).toBeGreaterThan(
        body.indexOf("You were added on demand"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
