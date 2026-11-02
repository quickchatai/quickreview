## Network access, asked once

qcr needs the network (GitHub and the model provider) and writes its own state outside this workspace, and `npx` writes its cache under `~/.npm`. Codex's default sandbox blocks both. Before the first qcr call, ask the user once to run qcr's commands with escalated permissions (`sandbox_permissions: "require_escalated"`), saying why in one line, and run every qcr call in this skill that way. Do not ask again at each step.
