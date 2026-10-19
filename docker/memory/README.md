# Memory sidecar image

OpenViking, its venv, llama-cpp-python and the pinned GGUF in a container of
their own. The daemon keeps `[openviking] endpoint = "local"` (supervising the
same pair in-container) until the VM flips; this image is what
`endpoint = "remote"` points at, and what `qcr memory on` runs on a laptop.

```sh
docker build -f docker/memory/Dockerfile -t qcr-memory .   # from the repo root
```

## What it does at boot

`entrypoint.sh` runs the memory half of `docker/daemon/entrypoint.sh`, then
execs `src/openviking/sidecar-main.ts`:

1. renders `ov.conf` (`scripts/openviking-ov-conf.mjs`, the same document the
   daemon entrypoints render; `tests/memory-image.test.ts` holds them equal);
2. `openviking-reembed.mjs prepare`: a store built under another embedder has
   its vector collection moved ASIDE (never deleted) and is journalled for
   re-embedding;
3. `openviking-provision.mjs`: creates missing users, never rotates a key;
4. supervises the server and the local embedder (the daemon's own classes, so
   the start gate, restart ladder and logs are the same) and drives the
   re-embed once `/ready` passes.

The GGUF is in the image, so the sidecar boots offline under the local embedder.

## Wiring it to a daemon

The daemon's config.toml and the sidecar's are the same file (mount the config
home read-only into both). On the daemon side:

```toml
[openviking]
endpoint = "remote"
host = "qcr-memory"   # the sidecar's name on the container network
```

Mount into the sidecar: the config home (read-only), the secrets dir
(read-only, holding `openviking_root_key` and `openviking_reviewer_key`), and
the OpenViking state at `/opt/quickreview/state/openviking` (the same volume the
daemon wrote its store to, so the first flip reuses the store; the image's
user is uid 1001 like the daemon's). Never publish port 1933 to a host.

The re-embed journal, `provision.json` and `ov.conf` live in that state
directory. The daemon no longer runs the re-embed driver under `remote`; the
sidecar does.
