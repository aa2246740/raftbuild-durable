import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** CLI discovery never creates credentials: only a host may initialize them. */
export async function readApiKey(stateDir: string): Promise<string | undefined> {
  const configured = process.env.RAFTD_KEY?.trim();
  if (configured) return configured;
  if (process.env.RAFTD_INSECURE === "1") return undefined;
  try {
    const token = (await readFile(path.join(stateDir, "raftd.token"), "utf8")).trim();
    if (!token) throw new Error("raftd.token is empty; restore or remove it before starting the host");
    return token;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Default authentication also protects loopback listeners from browser requests. */
export async function resolveApiKey(stateDir: string): Promise<string | undefined> {
  if (process.env.RAFTD_KEY?.trim() || process.env.RAFTD_INSECURE === "1") return readApiKey(stateDir);
  await mkdir(stateDir, { recursive: true });
  const file = path.join(stateDir, "raftd.token");
  if (!await readApiKey(stateDir)) {
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      // Publishing a complete file without overwriting another initializer
      // prevents a concurrent reader from observing an empty/partial token.
      try { await link(temporary, file); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await chmod(file, 0o600);
  return readApiKey(stateDir);
}

export function validBearer(header: string | undefined, key: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  // Hash to fixed-length buffers so both differing lengths and content use
  // timingSafeEqual. The plaintext secret never appears in an error response.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(key));
}
