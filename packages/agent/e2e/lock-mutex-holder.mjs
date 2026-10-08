// Hold a real machine lock while the parent tests SIGSTOP/SIGKILL behavior.
// Usage: node --experimental-transform-types lock-mutex-holder.mjs <stateDir>
import { MachineLock } from "../src/machineLock.ts";

const lock = await MachineLock.acquire(process.argv[2]);
console.log("ACQUIRED");
setInterval(() => {}, 60_000);
process.once("SIGTERM", () => {
  void lock.release().finally(() => process.exit(0));
});
