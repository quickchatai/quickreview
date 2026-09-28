I found one likely bug in this change.

- `src/init.cpp:1599` — A `-proxy` socket path that contains `=` now stops the node from starting, where it used to work. The code splits the value at its last `=` and treats whatever follows as a network name, even for `unix:` paths. For example, `-proxy=unix:/run/tor/socks=1` is read as the path `unix:/run/tor/socks` plus the network `1`, and startup fails with "Unrecognized network in -proxy=...". The earlier port check in `CheckHostPortOptions` accepts the value because it starts with `unix:`, so the failure only shows up later, in `AppInitMain`. I rated this plausible rather than confirmed: I traced it through the code but didn't run it.

Nothing else in the diff looked like a real bug. Two behaviours I looked at and chose not to report:
- **Listening:** the check that turns off `-listen`, `-natpmp` and `-discover` (`src/init.cpp:753`) still only looks at the last `-proxy` value. As far as I can tell that only ever makes it more cautious, and never turns listening back on when a proxy is still in use.
- **DNS:** `-proxy=0=ipv4` clears the DNS proxy even if an IPv6 proxy is still set, so name lookups go out through the operating system. The updated `doc/tor.md` describes this as intended.
