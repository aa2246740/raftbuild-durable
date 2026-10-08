export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const booleans = new Set(["no-wait", "raw", "help", ...(argv[0] === "delete" ? ["workspace"] : [])]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") { positional.push(...argv.slice(i + 1)); break; }
    if (arg === "-h") { flags.help = true; continue; }
    if (arg === "-m") {
      const value = argv[++i];
      if (!value || value.startsWith("-")) throw new Error("-m needs a file path");
      flags.m = value;
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(2, eq > 0 ? eq : undefined);
      if (booleans.has(key) || (key === "workspace" && positional[0] === "delete")) {
        if (eq > 0) throw new Error(`--${key} does not take a value`);
        flags[key] = true;
      } else {
        const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
        if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new Error(`--${key} needs a value`);
        flags[key] = value;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** No timeout by default; a bare number is seconds. Zero explicitly means unlimited. */
export function timeoutFrom(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === "0") return undefined;
  if (typeof value !== "string") throw new Error("--timeout needs a duration (for example 30s or 5m)");
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value);
  if (!m) throw new Error("--timeout must be a positive duration (30s, 5m), or 0 for unlimited");
  const n = Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"]!);
  if (!Number.isFinite(n) || n <= 0 || n > 2_147_483_647) throw new Error("--timeout is out of range");
  return n;
}

export class RemoteApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function waitForRemoteAnswer(
  call: (route: string, timeoutMs: number) => Promise<any>,
  agent: string,
  submissionId: string,
  timeoutMs?: number,
): Promise<any> {
  const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
  const timedOut = () => new Error(`submission ${submissionId} is still running; resume with: raftd wait ${JSON.stringify(agent)} ${submissionId} (use the same --state directory)`);
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw timedOut();
    const seconds = Math.min(110, Math.max(1, Math.ceil(remaining / 1000)));
    try {
      return await call(`agents/${encodeURIComponent(agent)}/answer?submissionId=${encodeURIComponent(submissionId)}&timeout=${seconds}`,
        Math.min(remaining, seconds * 1000 + 10_000));
    } catch (error) {
      if (Date.now() >= deadline) throw timedOut();
      if (!(error instanceof RemoteApiError) || error.status !== 504) throw error;
      // A server/proxy may return 504 immediately. Avoid an unbounded busy loop.
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  }
}
