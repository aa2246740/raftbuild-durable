// e2e fixture: claims the takeover mutex the same way withTakeoverMutex()
// does (atomic mkdir + owner.json identity), then holds it. The parent test
// SIGSTOPs/SIGKILLs this process to exercise the live-holder invariants.
// Usage: node lock-mutex-holder.mjs <mutexDir>
import { mkdir, stat, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
await mkdir(dir);
const ino = (await stat(dir)).ino;
const pidStart = (() => {
  try {
    const s = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
})();
await writeFile(
  path.join(dir, "owner.json"),
  JSON.stringify({ pid: process.pid, token: "e2e-holder", pidStart }),
);
if ((await stat(dir).catch(() => null))?.ino !== ino) process.exit(2);
console.log("CLAIMED");
setTimeout(() => {}, 3_600_000);
