#!/usr/bin/env python3
"""Run an interactive wizard on a pty and answer its prompts by pattern (P8.20).

  answer.py [--timeout S] --on REGEX=>ANSWER ... -- CMD...

Each --on rule fires once, when REGEX appears in what the command printed since the last answer; ANSWER (with
\\n for Enter) is typed. Nothing is typed until a prompt shows, so a child that reads its stdin (ssh, the
CLI's docker exec) finds nothing to eat. Prints the output (ANSI stripped) and exits with the command's
status; 124 when it was idle for TIMEOUT seconds.
"""
import argparse, os, pty, re, select, signal, sys, time

ap = argparse.ArgumentParser()
ap.add_argument("--timeout", type=float, default=900.0)
ap.add_argument("--on", action="append", default=[])
ap.add_argument("cmd", nargs=argparse.REMAINDER)
a = ap.parse_args()
cmd = a.cmd[1:] if a.cmd and a.cmd[0] == "--" else a.cmd
rules = []
for r in a.on:
    pat, _, ans = r.partition("=>")
    rules.append((re.compile(pat), ans.encode().decode("unicode_escape")))

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(cmd[0], cmd)

import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 220, 0, 0))
out = b""
pending = ""
last = time.time()
used = [0] * len(rules)
status = None
while True:
    r, _, _ = select.select([fd], [], [], 0.5)
    if fd in r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            d = b""
        if not d:
            break
        out += d
        pending += d.decode("utf8", "replace")
        last = time.time()
        clean = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", pending)
        for i, (pat, ans) in enumerate(rules):
            m = pat.search(clean)
            if m and used[i] == 0:
                time.sleep(0.2)
                os.write(fd, ans.encode())
                used[i] = 1
                pending = clean[m.end():]
                break
    elif time.time() - last > a.timeout:
        os.kill(pid, signal.SIGKILL)
        status = 124
        break
    try:
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            # drain the rest
            try:
                while select.select([fd], [], [], 0.3)[0]:
                    d = os.read(fd, 65536)
                    if not d:
                        break
                    out += d
            except OSError:
                pass
            status = os.waitstatus_to_exitcode(st)
            break
    except ChildProcessError:
        break
if status is None:
    try:
        _, st = os.waitpid(pid, 0)
        status = os.waitstatus_to_exitcode(st)
    except ChildProcessError:
        status = 0
sys.stdout.write(re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", out.decode("utf8", "replace")).replace("\r", ""))
sys.exit(status)
