"""Keep one owned Node child unreaped to test genuine /proc zombie recovery."""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys

node, holder, state = sys.argv[1:]
child = subprocess.Popen(
    [node, '--experimental-transform-types', holder, state],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    text=True,
)

def emit(value):
    print(json.dumps(value), flush=True)

def terminate(_signum, _frame):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, terminate)
try:
    assert json.loads(child.stdout.readline())['event'] == 'ready'
    child.stdin.write('go\n')
    child.stdin.flush()
    assert json.loads(child.stdout.readline())['event'] == 'acquired'
    emit({'event': 'acquired', 'pid': child.pid})
    if sys.stdin.readline().strip() == 'kill':
        os.kill(child.pid, signal.SIGKILL)
        # A multithreaded Node leader can become Z before its final worker
        # exits and releases file descriptors. WNOWAIT waits for actual
        # whole-process exit while deliberately leaving the child unreaped.
        os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOWAIT)
        proc_state = Path(f'/proc/{child.pid}/stat').read_text().rsplit(') ', 1)[1][0]
        assert proc_state == 'Z'
        emit({'event': 'zombie', 'pid': child.pid, 'state': proc_state})
        sys.stdin.readline()  # test releases us only after competing acquisition
finally:
    try:
        os.kill(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()
    emit({'event': 'reaped', 'pid': child.pid})
