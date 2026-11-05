## Which qcr to run

Every call here is written `qcr --schema {{schema}} …`. `--schema {{schema}}` asks qcr for contract {{schema}}, the JSON this skill was written for: every payload leads with the `schema_version` the contract names, and the flag implies `--json`. Never call qcr without it, and never read fields from a payload you did not get this way.

Before the first call, check the qcr on this machine:

```sh
qcr --schema {{schema}} version
```

If it exits 0 and prints JSON, run `qcr` as written. If `qcr` is not found, exits nonzero or prints anything but JSON, it is missing or does not speak this contract (a qcr that does not print the contract exits 3 with nothing on stdout; one from before the flag exits nonzero with no JSON). Then run the release this skill came from in its place, with the same arguments after it:

```sh
{{npx}} --schema {{schema}} version
```

If that fails too, report its error as printed, stop, and use the setup skill ({{invoke:setup}}).
