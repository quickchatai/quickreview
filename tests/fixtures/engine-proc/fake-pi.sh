#!/bin/sh
# A fake pi for the process runtime's event-stream golden: reads the prompt off
# stdin, answers with the recorded stdout, and one stderr line.
dir="$(dirname "$0")"
cat > /dev/null
cat "$dir/pi-stdout.jsonl"
echo "pi: warning fixture" >&2
