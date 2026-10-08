#!/usr/bin/env python3
"""e2e fixture: leaves a ZOMBIE MachineLock owner.

Spawns a node process that acquires the real lock, SIGKILLs it, and then
refuses to wait() — the child stays Z-state until this script exits.
Prints "READY" once the zombie exists; blocks on stdin so the parent test
controls when the zombie is reaped (closing stdin exits the script, which
reaps the zombie via interpreter shutdown → init reparenting).
"""
import os
import signal
import subprocess
import sys
import time

state_dir = sys.argv[1]
repo_agent = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")

holder = subprocess.Popen(
    [
        "node", "--input-type=module", "-e",
        f'import {{MachineLock}} from "{repo_agent}/src/index.ts";'
        f'const l = await MachineLock.acquire("{state_dir}");'
        'console.log("HELD");'
        "setTimeout(()=>{},3600000);",
    ],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
held = False
for _ in range(90):
    line = holder.stdout.readline()
    if b"HELD" in line:
        held = True
        break
    if holder.poll() is not None:
        break
if not held:
    print("FAILED_TO_ACQUIRE", flush=True)
    sys.exit(1)
holder.send_signal(signal.SIGKILL)
time.sleep(0.4)
state = open(f"/proc/{holder.pid}/stat").read().rsplit(")", 1)[-1].split()[0]
print(f"READY state={state} pid={holder.pid}", flush=True)
# No wait() — holder stays a zombie until we exit.
sys.stdin.readline()
