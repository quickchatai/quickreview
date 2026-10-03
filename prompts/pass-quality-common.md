## Who owns which quality concern

Each concern has one owner. Report yours; route the rest to its owner.

- **Where** the code lives, against the repo's existing homes: `pass-placement`.
- **Boundaries, levels and generality** — an interface at the wrong level, a
  new interface exposing its implementation, speculative generality:
  `pass-abstraction`.
- **Less mechanism** — a simpler shape, a guard that provably cannot fire:
  `pass-simplicity`.
- **The same knowledge written twice**: `pass-duplication`.
- **One of several alike members treated differently**: `pass-consistency`.
- **Cost to the next reader or changer** — names, stale prose outside the
  changed lines, traps: `pass-maintainability`.
- **The repo's written style guide**: `pass-style`.
- **A rule a CI-run linter or formatter enforces**: `pass-lint-conformance`,
  as a build defect.

Formatting, whitespace, import order and naming conventions belong only to the
last two. A correctness defect you notice along the way belongs to the lens
that owns it: report it as ONE `P3` question naming the concern, and that lens
judges it at full severity.
