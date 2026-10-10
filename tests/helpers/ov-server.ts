// A small in-memory OpenViking for suites that drive the real
// `OpenVikingStore` + `OpenVikingClient`. The batch-write rules
// are 0.4.15's (storage/content_write.py), as `tests/memory-layout.test.ts`
// pins them: a root must be an existing directory INSIDE a memory area, every
// target sits under it, every precondition is checked before the first write
// (so a refused batch writes nothing), and identical bytes are `unchanged`.
// There is no delete route.
import { OpenVikingClient, type HttpFetch } from "../../src/openviking/client.js";
import {
  BATCH_MAX_OPERATIONS,
  OpenVikingStore,
  sha256Prefixed,
} from "../../src/openviking/store.js";

export const OV_BASE = "http://127.0.0.1:1933";
export const OV_KEY = "test-reviewer-key";
export const OV_ROOT = "viking://user/reviewer/memories";

export interface OvCall {
  method: string;
  path: string;
  uri?: string;
  body?: Record<string, unknown>;
}

export interface OvOp {
  uri: string;
  content: string;
  precondition: { kind: string; base_hash?: string };
}

function ok(result: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify({ status: "ok", result })),
  });
}

function err(status: number, code: string, message: string) {
  return Promise.resolve({
    ok: false,
    status,
    text: () =>
      Promise.resolve(JSON.stringify({ status: "error", result: null, error: { code, message } })),
  });
}

export class OvServer {
  files = new Map<string, string>();
  dirs = new Set<string>([OV_ROOT]);
  calls: OvCall[] = [];

  readonly fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const body =
      init.body === undefined ? undefined : (JSON.parse(init.body) as Record<string, unknown>);
    const uri = u.searchParams.get("uri") ?? undefined;
    this.calls.push({
      method: init.method,
      path: u.pathname,
      ...(uri ? { uri } : {}),
      ...(body ? { body } : {}),
    });
    if (u.pathname === "/api/v1/fs/ls") return this.ls(uri ?? "");
    if (u.pathname === "/api/v1/content/read") {
      const v = this.files.get(uri ?? "");
      return v === undefined ? err(404, "NOT_FOUND", uri ?? "") : ok(v);
    }
    if (u.pathname === "/api/v1/content/batch-write") return this.batch(body as never);
    if (u.pathname === "/api/v1/fs/mkdir") {
      const raw = body?.["uri"];
      const d = (typeof raw === "string" ? raw : "").replace(/\/+$/, "");
      if (this.isDir(d)) return err(409, "CONFLICT", `already exists: ${d}`);
      this.dirs.add(d);
      return ok({ uri: d });
    }
    if (u.pathname === "/api/v1/fs/attrs/set_tags") return ok({});
    return err(404, "NOT_FOUND", `no route ${u.pathname}`);
  };

  isDir(d: string): boolean {
    if (this.dirs.has(d)) return true;
    for (const k of this.files.keys()) if (k.startsWith(`${d}/`)) return true;
    return false;
  }

  private ls(uri: string) {
    const dir = uri.replace(/\/+$/, "");
    if (!this.isDir(dir)) return err(404, "NOT_FOUND", `no such directory ${dir}`);
    const rows = new Map<string, Record<string, unknown>>();
    const prefix = `${dir}/`;
    for (const [k, v] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const cut = rest.indexOf("/");
      if (cut < 0)
        rows.set(rest, {
          uri: k,
          name: rest,
          isDir: false,
          size: Buffer.byteLength(v),
          modTime: `2026-10-07T00:00:${String(v.length % 60).padStart(2, "0")}.000Z`,
        });
      else
        rows.set(rest.slice(0, cut), {
          uri: `${prefix}${rest.slice(0, cut)}`,
          name: rest.slice(0, cut),
          isDir: true,
          size: 0,
          modTime: "",
        });
    }
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      if (rest !== "" && !rest.includes("/"))
        rows.set(rest, { uri: d, name: rest, isDir: true, size: 0, modTime: "" });
    }
    return ok([...rows.values()]);
  }

  private batch(req: { root_uri: string; operations: OvOp[] }) {
    const root = req.root_uri.replace(/\/+$/, "");
    if (!root.startsWith(`${OV_ROOT}/`))
      return err(
        400,
        "INVALID_ARGUMENT",
        "batch-write root must be inside a memory type directory",
      );
    if (!this.isDir(root))
      return err(404, "NOT_FOUND", `batch-write root must be an existing directory: ${root}`);
    if (req.operations.length > BATCH_MAX_OPERATIONS)
      return err(429, "RESOURCE_EXHAUSTED", "too many operations");
    const unchanged: string[] = [];
    const pending: OvOp[] = [];
    for (const op of req.operations) {
      if (!op.uri.startsWith(`${root}/`))
        return err(400, "INVALID_ARGUMENT", `batch-write target is outside root_uri: ${op.uri}`);
      const cur = this.files.get(op.uri);
      if (cur !== undefined && cur === op.content) {
        unchanged.push(op.uri);
        continue;
      }
      if (op.precondition.kind === "create_if_absent" && cur !== undefined)
        return err(
          409,
          "CONFLICT",
          "Batch write create precondition failed; target already exists.",
        );
      if (op.precondition.kind === "replace_if_hash") {
        if (cur === undefined)
          return err(
            409,
            "CONFLICT",
            "Batch write replace precondition failed; target does not exist.",
          );
        if (sha256Prefixed(cur) !== op.precondition.base_hash)
          return err(
            409,
            "CONFLICT",
            "Batch write replace precondition failed; content hash changed.",
          );
      }
      pending.push(op);
    }
    const created: string[] = [];
    const updated: string[] = [];
    for (const op of pending) {
      (this.files.has(op.uri) ? updated : created).push(op.uri);
      this.files.set(op.uri, op.content);
    }
    return ok({ root_uri: root, created, updated, unchanged });
  }

  /** Every batch-write the client SENT, in order. */
  batches(): Array<{ root: string; ops: OvOp[] }> {
    return this.calls
      .filter((c) => c.path === "/api/v1/content/batch-write")
      .map((c) => ({ root: String(c.body!["root_uri"]), ops: c.body!["operations"] as OvOp[] }));
  }
}

/** A real store over `fetchFn` (the server's, or a wrapper around it). */
export function ovStore(fetchFn: HttpFetch, now = () => new Date("2026-10-07T10:00:00.000Z")) {
  return new OpenVikingStore({
    client: new OpenVikingClient({
      baseUrl: OV_BASE,
      apiKey: OV_KEY,
      user: "reviewer",
      fetchFn,
      sleep: async () => {},
    }),
    now,
    cacheTtlMs: 0,
    fullRefreshMs: 0,
  });
}
