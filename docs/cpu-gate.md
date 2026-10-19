# Offline CPU and RSS gate

Can N review sessions share one node event loop on a 2-vCPU host? The in-process
SDK runtime (`src/engine/sdkruntime.ts`) puts every session on one JS thread,
which is what CPU forced the 10-08 cut over. This records what that costs against
the process runtime doing the same work, at $0: no model, no network.

The measurement is `scripts/cpu-gate.mjs` (run it after `npm run build`; it needs
`taskset`). `tests/cpu-gate.test.ts` pins its arithmetic and runs a tiny version
end to end.

## The gate

D6: provisional **p99 event-loop lag <= 200 ms at 12 sessions on 2 vCPUs**,
adjustable once the numbers are in. The in-process (sdk) runtime at 12 sessions,
steady state, three full runs on a loaded desktop:

| run | p99 lag at 12 sessions (sdk) | limit | verdict |
|---|---|---|---|
| 1 | 40.5 ms | 200 ms | pass |
| 2 | 7 ms | 200 ms | pass |
| 3 | 38.3 ms | 200 ms | pass |

The gate passes with a wide margin, and it does so with the host fighting for
the same cores (the "pinned busy" column below is everything running on the two
cores, ours included). What the single number hides is in finding 4.

## What was measured

- **sdk**: N faux sessions in one process, `sdkRuntime` over `PiHost`, file-backed.
- **proc**: N children, each one process hosting one faux session of the same
  code and printing the `pi --mode json` event stream; `procRuntime` reads them.
  The parent's loop only parses lines, as it does for real pi children. Each child
  is a node process that loads the pi SDK, the same footprint class as a pi CLI.
- **Workload**: one lens-shaped turn per session, started all at once (a wave):
  a one-line thought, then a `read` or `bash` call, repeated (the real tools run
  on a real file tree). Responses stream at 100 tokens/s per session. No turn
  finishes inside the window.
- **Pinning**: every cell runs under `taskset -c 0,1`, in a fresh process. On
  this machine cpu 0 and cpu 1 are the two hyperthreads of one core, which is
  what two cloud vCPUs usually are.
- **Lag**: a 10 ms timer in the measuring process; a sample is how late it fired.
  15 s steady window after 3 s of warm-up (about 1,500 samples). "Ticks > 200 ms"
  counts samples over the gate's limit.
- **RSS and PSS**: peak over the window, summed over the process and all its
  descendants. RSS counts the node binary's shared pages once per process, so
  PSS (shared pages divided among the processes using them) is the fairer sum.
- **CPU**: "our CPU %" is our processes' share of the two cores over the window;
  "pinned busy %" is everything running on them. The gap is other load on the
  host.
- **Abort latency**: from `abort()` to the turn settling, for three sessions one
  at a time while the rest stream, then for all the rest at once.

Machine: 12th Gen Intel Core i5-1240P (16 threads), Node v26.10.0, pi 1.3.0, commit 0826b96d plus this
script. The desktop was running other jobs throughout (load average at the
start of each run is in its table), so these numbers are pessimistic for a quiet
VM and vary run to run; the three runs are all kept.

## Findings

1. **The gate passes, and the margin is large.** sdk p99 lag at 12 sessions was
   below 41 ms in all three runs, and at 20 sessions below 55 ms. The loop is
   not CPU-bound at faux pace: the sessions used 9 to 26 percent of the two
   cores in the sdk cells.
2. **Memory: one process is about ten times lighter than twelve.** At 12 sessions
   the sdk cell held 188 to 203 MB RSS (138 to 159 MB PSS); the proc cell held
   about 2.0 GB RSS (1.4 GB PSS), because each child carries its own copy of the
   SDK. At 20 sessions: sdk 240 to 400 MB, proc 3.3 GB. sdk RSS rises with
   transcript length (the 400 tokens/s cells below).
3. **Abort is as fast or faster in process.** One session aborted while the rest
   stream: 3 to 99 ms in sdk, 18 to 138 ms in proc. All at once, the slowest
   settle: 43 to 151 ms in sdk at 12 sessions, 179 to 273 ms in proc.
4. **Session birth stalls the loop, and the steady-state p99 does not see it.**
   Creating a wave of sessions in one process blocks the loop for the whole
   creation: lag max during start-up was 0.7 to 2.5 s at 8 to 20 sessions
   (0.4 s at the faster cell). Nothing else in the process runs through that
   stall (heartbeats, timers, other sessions' streams, an abort). A proc wave
   does not stall the parent (start-up lag max 71 to 500 ms) but takes 9 to 27
   seconds to get every child streaming. If waves of lenses are started in one
   process, session creation should be staggered or moved off the hot path; the
   gate does not cover it and the owner may want a start-up bound in D6.
   Answered by the central permit broker (P8.10, `src/ipc/permits.ts`): lens
   sessions in bot workers are granted FIFO across workers under
   `[daemon] lens_permits` (20), at least `lens_grant_stagger_ms` (250) apart,
   so a full wave of 20 is created over about 5 s and never in one burst
   (`tests/permit-broker.test.ts` measures the loop lag against the D6 bar).
5. **Proc is worse for the parent's loop under 2 cores.** With 12 to 20 children
   competing for the same two cores, the parent's lag p99 was 32 to 193 ms,
   higher than sdk's in every pair of cells, with ticks over 200 ms at 20 sessions
   in two of three runs. The parent does little work per line, so the scheduler
   handing the cores to the children is the likely cause.

## Limits of this measurement

- The faux provider hands over parsed messages. Provider TLS and SSE parsing, and
  the real model's tokens-per-second, are not here; real sessions cost more CPU
  per token. The 400 tokens/s cells below are a sensitivity check (four times the
  event rate), not a substitute.
- The proc children are our SDK in a child process, not the real pi CLI. Real pi
  adds its own startup (extensions, resource discovery) on top.
- Descendants that start and exit inside the window (the model's bash calls) are
  in neither CPU column; their memory is in the peak only if sampled alive.
- One desktop, three runs. Run it again on the target VM before relying on the
  margin.

## Run 1

Steady window 15 s after 3 s of warm-up, pinned to cpus 0,1, faux pace 100 tokens/s per session, load average at start 4.17 7.87 8.78.

| runtime | sessions | lag p50 ms | lag p99 ms | lag max ms | ticks >200 ms | RSS MB | PSS MB | procs | our CPU % | pinned busy % |
|---|---|---|---|---|---|---|---|---|---|---|
| sdk | 8 | 0.3 | 6.7 | 12.3 | 0 | 182 | 133 | 2 | 9.1 | 28 |
| proc | 8 | 0.2 | 115.8 | 209.3 | 1 | 1369 | 917 | 10 | 30.7 | 98.7 |
| sdk | 12 | 1.1 | 40.5 | 63.2 | 0 | 188 | 138 | 4 | 20.9 | 98.3 |
| proc | 12 | 0.3 | 185.9 | 310.5 | 5 | 2041 | 1388 | 14 | 40.1 | 98.7 |
| sdk | 20 | 2.3 | 54.3 | 97.4 | 0 | 242 | 191 | 5 | 26.1 | 97.3 |
| proc | 20 | 0.1 | 177.6 | 267.1 | 6 | 3318 | 2264 | 23 | 52.2 | 75.3 |

| runtime | sessions | start-up ms | start-up lag p99 | start-up lag max | abort one, ms (3 probes) | abort all p50 | abort all max | lag max during abort all |
|---|---|---|---|---|---|---|---|---|
| sdk | 8 | 272 | 719 | 719 | 6 / 43 / 33 | 30 | 33 | 4.5 |
| proc | 8 | 8938 | 5.8 | 76.4 | 81 / 138 / 68 | 153 | 160 | 19.6 |
| sdk | 12 | 546 | 2454.7 | 2454.7 | 21 / 45 / 23 | 150 | 151 | 98.2 |
| proc | 12 | 16700 | 6.2 | 210.3 | 85 / 122 / 85 | 234 | 245 | 10.6 |
| sdk | 20 | 527 | 2285.2 | 2285.2 | 99 / 69 / 67 | 96 | 104 | 41.2 |
| proc | 20 | 27271 | 10 | 499.4 | 54 / 34 / 46 | 237 | 249 | 12.4 |

## Run 2

Steady window 15 s after 3 s of warm-up, pinned to cpus 0,1, faux pace 100 tokens/s per session, load average at start 20.36 16.07 11.90.

| runtime | sessions | lag p50 ms | lag p99 ms | lag max ms | ticks >200 ms | RSS MB | PSS MB | procs | our CPU % | pinned busy % |
|---|---|---|---|---|---|---|---|---|---|---|
| sdk | 8 | 0.3 | 9 | 31.3 | 0 | 183 | 135 | 3 | 10.8 | 41.1 |
| proc | 8 | 0.1 | 25.9 | 41.3 | 0 | 1382 | 950 | 10 | 18.3 | 36.1 |
| sdk | 12 | 0.3 | 7 | 13.5 | 0 | 203 | 159 | 2 | 12.8 | 30 |
| proc | 12 | 0.1 | 31.8 | 42.8 | 0 | 2045 | 1403 | 13 | 24.6 | 38.8 |
| sdk | 20 | 0.4 | 13.8 | 30.4 | 0 | 396 | 351 | 4 | 23.6 | 49.4 |
| proc | 20 | 0.2 | 193.1 | 332.5 | 7 | 3352 | 2284 | 22 | 53.9 | 76.5 |

| runtime | sessions | start-up ms | start-up lag p99 | start-up lag max | abort one, ms (3 probes) | abort all p50 | abort all max | lag max during abort all |
|---|---|---|---|---|---|---|---|---|
| sdk | 8 | 339 | 1253.8 | 1253.8 | 11 / 40 / 29 | 17 | 51 | 1.9 |
| proc | 8 | 8820 | 4.5 | 71.1 | 60 / 57 / 50 | 63 | 80 | 1.5 |
| sdk | 12 | 274 | 722.3 | 722.3 | 39 / 26 / 9 | 34 | 43 | 2.1 |
| proc | 12 | 11111 | 5.5 | 133.2 | 48 / 51 / 60 | 176 | 179 | 8.9 |
| sdk | 20 | 380 | 1063.2 | 1063.2 | 7 / 13 / 22 | 36 | 49 | 3.4 |
| proc | 20 | 16368 | 8.2 | 239.4 | 86 / 96 / 114 | 426 | 434 | 37.1 |

## Run 3

Steady window 15 s after 3 s of warm-up, pinned to cpus 0,1, faux pace 100 tokens/s per session, load average at start 15.00 14.30 11.81.

| runtime | sessions | lag p50 ms | lag p99 ms | lag max ms | ticks >200 ms | RSS MB | PSS MB | procs | our CPU % | pinned busy % |
|---|---|---|---|---|---|---|---|---|---|---|
| sdk | 8 | 0.7 | 27.9 | 48.7 | 0 | 180 | 130 | 3 | 17.5 | 97.4 |
| proc | 8 | 0.1 | 68.5 | 133.9 | 0 | 1382 | 934 | 9 | 27.8 | 83 |
| sdk | 12 | 0.9 | 38.3 | 82 | 0 | 190 | 140 | 5 | 19.8 | 91.8 |
| proc | 12 | 0.2 | 139.6 | 213.7 | 2 | 2040 | 1388 | 14 | 40 | 96.7 |
| sdk | 20 | 0.3 | 14.5 | 20.4 | 0 | 398 | 358 | 2 | 20.5 | 39.3 |
| proc | 20 | 0.1 | 49.8 | 69.9 | 0 | 3352 | 2308 | 21 | 32.6 | 41.6 |

| runtime | sessions | start-up ms | start-up lag p99 | start-up lag max | abort one, ms (3 probes) | abort all p50 | abort all max | lag max during abort all |
|---|---|---|---|---|---|---|---|---|
| sdk | 8 | 402 | 2120.8 | 2120.8 | 25 / 33 / 29 | 45 | 54 | 19.4 |
| proc | 8 | 11425 | 5.2 | 150.6 | 70 / 104 / 80 | 128 | 136 | 1.8 |
| sdk | 12 | 528 | 2031.9 | 2031.9 | 33 / 22 / 78 | 56 | 65 | 21.9 |
| proc | 12 | 16094 | 5.7 | 172.3 | 82 / 124 / 88 | 270 | 273 | 9.7 |
| sdk | 20 | 387 | 1709.8 | 1709.8 | 14 / 40 / 3 | 46 | 51 | 17 |
| proc | 20 | 14895 | 9.8 | 270.5 | 27 / 39 / 18 | 144 | 161 | 11.4 |

## Sensitivity: four times the event rate (400 tokens/s)

sdk only, one run.

Steady window 15 s after 3 s of warm-up, pinned to cpus 0,1, faux pace 400 tokens/s per session, load average at start 16.73 17.07 13.41.

| runtime | sessions | lag p50 ms | lag p99 ms | lag max ms | ticks >200 ms | RSS MB | PSS MB | procs | our CPU % | pinned busy % |
|---|---|---|---|---|---|---|---|---|---|---|
| sdk | 12 | 0.9 | 12.3 | 17.3 | 0 | 589 | 559 | 4 | 42 | 55.4 |
| sdk | 20 | 2.2 | 20.6 | 28.5 | 0 | 675 | 645 | 7 | 46.8 | 61.6 |

| runtime | sessions | start-up ms | start-up lag p99 | start-up lag max | abort one, ms (3 probes) | abort all p50 | abort all max | lag max during abort all |
|---|---|---|---|---|---|---|---|---|
| sdk | 12 | 113 | 432.2 | 432.2 | 12 / 7 / 20 | 80 | 81 | 35.6 |
| sdk | 20 | 116 | 430.8 | 430.8 | 12 / 37 / 56 | 69 | 70 | 40.4 |
