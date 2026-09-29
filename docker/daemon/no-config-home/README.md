# no-config-home

The default source of the daemon container's read-only `config-home` mount
(`docker-compose.yml`) when `.env` names no `QCR_CONFIG_HOME` — a
compose run by hand, before the onboarding bring-up step has written one.

It deliberately holds no `config.toml`. The container reads no other config —
the sandbox's own `config.toml` stopped being a fallback with — so a
stack started on this default fails its boot naming the missing file, which
is the honest answer: set `QCR_CONFIG_HOME` in `.env` (or run the wizard's
bring-up step). Defaulting to `~/.config/qcr/default` instead would have Docker
create that directory, owned by root, on every host that does not have it yet
— and a root-owned config home then refuses `qcr install migrate` and the
wizard's own writes.
