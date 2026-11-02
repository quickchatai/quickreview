# Architecture decisions

The decisions that shape this repository and would surprise a reader of the
code without their reasons. Each record is short: what was decided, why, and
what was rejected. A record's front matter says whether the tree already
matches it (`built:`). New records take the next number; a reversed decision
keeps its file and is marked `superseded by` the record that replaced it.

| ADR                                 | Decision                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [0001](0001-plugin-and-app-nest.md) | The plugin and the app nest: the plugin is what plain pi needs to review, the app is the managed product around it, and each works without the one outside it. Amended: one skill source renders the plugin's skills and every host plugin's, and host plugins run `qcr`, installed from npm. |

The structural invariants that code and tests enforce are listed in
[`AGENTS.md`](../../AGENTS.md#invariants-an-agent-must-never-break); the words
these records use are defined in [`CONTEXT.md`](../../CONTEXT.md).
