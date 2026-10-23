#!/usr/bin/env python3
"""Drive a command in a real pty: type into it and wait for what it prints.

  pty-drive.py [--send TEXT]... [--expect REGEX] [--settle S] [--timeout S] [--detach] -- CMD...

Starts CMD on a pty (so `docker exec -it ... tmux attach` is the interactive session an
operator gets), waits SETTLE seconds for the screen to appear, types each --send (then
Enter), waits until REGEX matches the output (or TIMEOUT), optionally detaches tmux
(Ctrl-b d), and prints the last screenful of what it saw, ANSI-stripped, to stdout. Exit 0
when REGEX matched (or none was given), 1 when it did not.
"""
import argparse, os, pty, re, select, signal, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--send", action="append", default=[])
ap.add_argument("--expect")
ap.add_argument("--settle", type=float, default=3.0)
ap.add_argument("--timeout", type=float, default=60.0)
ap.add_argument("--detach", action="store_true")
ap.add_argument("cmd", nargs=argparse.REMAINDER)
a = ap.parse_args()
cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)

import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 160, 0, 0))
buf = b""

def pump(seconds):
    global buf
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if fd in r:
            try:
                d = os.read(fd, 65536)
            except OSError:
                return False
            if not d:
                return False
            buf += d
    return True

ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Za-z0-9]|\x1b[=>]")
def text():
    return ANSI.sub(b"", buf).decode("utf8", "replace")

pump(a.settle)
for s in a.send:
    os.write(fd, s.encode() + b"\r")
    pump(1.0)
ok = True
if a.expect:
    rx = re.compile(a.expect, re.S)
    end = time.time() + a.timeout
    ok = bool(rx.search(text()))
    while not ok and time.time() < end:
        pump(0.5)
        ok = bool(rx.search(text()))
if a.detach:
    os.write(fd, b"\x02d")
    pump(1.0)
try:
    os.kill(pid, signal.SIGTERM)
except ProcessLookupError:
    pass
try:
    os.waitpid(pid, 0)
except ChildProcessError:
    pass
lines = [l.rstrip() for l in text().replace("\r", "\n").split("\n") if l.strip()]
print("\n".join(lines[-40:]))
sys.exit(0 if ok else 1)
