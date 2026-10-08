/**
 * Agent-owned workspace directories. Creation claims a new directory;
 * rollback and deletion require its persisted token and inode. Pre-existing
 * directories are never borrowed or automatically removed.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AgentRegistryError } from "./agents.ts";

/** Sibling of the workspaces root that is not itself a workspace. */
export const DELIVERIES_DIR_NAME = ".deliveries";

export interface WorkspaceDirectoryInfo {
  directoryName: string;
  totalSizeBytes: number;
  lastModified: string;
  fileCount: number;
}

export interface AgentWorkspaceSeedFile {
  relativePath: string;
  content: string;
}

const OWNER_FILE = ".raftd-owner.json";
export interface WorkspaceOwnership { token: string; device: string; inode: string }

// One process can have multiple API calls (or daemon instances) operating on
// the same path. Serialize the entire check/remove and claim/seed sequence:
// an inode check alone does not protect a successor from a delayed remover.
const workspaceOperations = new Map<string, Promise<void>>();
async function withWorkspaceOperation<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const parent = await realpath(path.dirname(target)).catch(() => path.resolve(path.dirname(target)));
  const key = path.join(parent, path.basename(target));
  const previous = workspaceOperations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const holding = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => holding);
  workspaceOperations.set(key, tail);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (workspaceOperations.get(key) === tail) workspaceOperations.delete(key);
  }
}

async function sameDirectory(target: string, owner: WorkspaceOwnership): Promise<boolean> {
  const info = await lstat(target).catch(() => undefined);
  return !!info?.isDirectory() && !info.isSymbolicLink() && String(info.dev) === owner.device && String(info.ino) === owner.inode;
}

/** Reject aliases of the workspace root as well as aliases of its children. */
export async function ensureWorkspaceRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AgentRegistryError("workspaces root must be a real directory", "invalid");
}

export async function initializeAgentWorkspace(
  workspacePath: string,
  initialMemoryMd: string,
  seedFiles: AgentWorkspaceSeedFile[],
): Promise<WorkspaceOwnership> {
  await ensureWorkspaceRoot(path.dirname(workspacePath));
  return withWorkspaceOperation(workspacePath, () => initializeOwnedWorkspace(workspacePath, initialMemoryMd, seedFiles));
}

async function initializeOwnedWorkspace(
  workspacePath: string,
  initialMemoryMd: string,
  seedFiles: AgentWorkspaceSeedFile[],
): Promise<WorkspaceOwnership> {
  const root = path.dirname(workspacePath);
  await ensureWorkspaceRoot(root);
  // mkdir without recursive is the atomic claim. An existing directory,
  // file or symbolic link belongs to someone else, including another agent.
  try {
    await mkdir(workspacePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AgentRegistryError(`workspace already exists: ${path.basename(workspacePath)}`, "name_taken");
    }
    throw err;
  }
  const info = await lstat(workspacePath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new AgentRegistryError("workspace changed during creation", "invalid");
  const owner: WorkspaceOwnership = { token: randomUUID(), device: String(info.dev), inode: String(info.ino) };
  try {
    await writeFile(path.join(workspacePath, OWNER_FILE), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    await writeFile(path.join(workspacePath, "MEMORY.md"), initialMemoryMd, { flag: "wx" });
    await mkdir(path.join(workspacePath, "notes"));
    for (const { relativePath, content } of seedFiles) {
      const fullPath = path.resolve(workspacePath, relativePath);
      if (!fullPath.startsWith(workspacePath + path.sep) || fullPath === path.join(workspacePath, OWNER_FILE)) {
        throw new AgentRegistryError(`invalid workspace seed path: ${relativePath}`, "invalid");
      }
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, { flag: "wx" });
    }
    return owner;
  } catch (error) {
    // Initialization may fail before the owner file exists. The directory
    // inode from our successful mkdir is still required for rollback.
    if (await sameDirectory(workspacePath, owner)) await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}

// Containment, not a blocklist. Resolving the path and asserting it is
// strictly below `dataDir` rejects the whole class of traversal inputs —
// including the members nobody has thought of yet (see the original comment).
export function resolveWorkspaceDirectoryPath(dataDir: string, directoryName: string): string | null {
  if (typeof directoryName !== "string" || !directoryName || path.isAbsolute(directoryName)
    || directoryName.includes("/") || directoryName.includes("\\") || directoryName.includes("\0")) return null;
  const root = path.resolve(dataDir);
  const target = path.resolve(root, directoryName);
  // Exactly one level below the root: rejects the root itself ("." and ""),
  // anything above it ("..", "../x"), and any nested path ("nested/agent-1").
  if (path.dirname(target) !== root) {
    return null;
  }
  return target;
}

interface WorkspaceDirectorySummary {
  totalSizeBytes: number;
  fileCount: number;
  latestMtime: Date;
}

function emptyWorkspaceDirectorySummary(latestMtime = new Date(0)): WorkspaceDirectorySummary {
  return { totalSizeBytes: 0, fileCount: 0, latestMtime };
}

function mergeWorkspaceDirectorySummaries(
  base: WorkspaceDirectorySummary,
  next: WorkspaceDirectorySummary,
): WorkspaceDirectorySummary {
  return {
    totalSizeBytes: base.totalSizeBytes + next.totalSizeBytes,
    fileCount: base.fileCount + next.fileCount,
    latestMtime: next.latestMtime > base.latestMtime ? next.latestMtime : base.latestMtime,
  };
}

async function summarizeWorkspaceEntry(
  entryPath: string,
  entry: { isDirectory(): boolean; isFile(): boolean },
): Promise<WorkspaceDirectorySummary> {
  try {
    const info = await stat(entryPath);
    if (entry.isDirectory()) {
      return summarizeWorkspaceDirectory(entryPath);
    }
    if (entry.isFile()) {
      return { totalSizeBytes: info.size, fileCount: 1, latestMtime: info.mtime };
    }
    return emptyWorkspaceDirectorySummary(info.mtime);
  } catch {
    return emptyWorkspaceDirectorySummary();
  }
}

async function summarizeWorkspaceDirectory(dirPath: string): Promise<WorkspaceDirectorySummary> {
  let summary = emptyWorkspaceDirectorySummary();
  try {
    const rootInfo = await stat(dirPath);
    summary = emptyWorkspaceDirectorySummary(rootInfo.mtime);
  } catch {
    return summary;
  }

  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return summary;
  }

  const childSummaries = await Promise.all(
    entries.map((entry) => summarizeWorkspaceEntry(path.join(dirPath, entry.name), entry)),
  );
  for (const childSummary of childSummaries) {
    summary = mergeWorkspaceDirectorySummaries(summary, childSummary);
  }
  return summary;
}

export async function scanWorkspaceDirectories(dataDir: string): Promise<WorkspaceDirectoryInfo[]> {
  let entries;
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || entry.name === DELIVERIES_DIR_NAME) {
        return null;
      }
      const dirPath = path.join(dataDir, entry.name);
      try {
        const summary = await summarizeWorkspaceDirectory(dirPath);
        return {
          directoryName: entry.name,
          totalSizeBytes: summary.totalSizeBytes,
          lastModified: summary.latestMtime.toISOString(),
          fileCount: summary.fileCount,
        } satisfies WorkspaceDirectoryInfo;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((entry): entry is WorkspaceDirectoryInfo => entry !== null);
}

export async function deleteWorkspaceDirectory(dataDir: string, directoryName: string, owner?: WorkspaceOwnership): Promise<boolean> {
  const targetDir = resolveWorkspaceDirectoryPath(dataDir, directoryName);
  if (!targetDir || !owner) {
    return false;
  }
  return withWorkspaceOperation(targetDir, () => removeOwnedWorkspace(dataDir, targetDir, owner));
}

async function removeOwnedWorkspace(dataDir: string, targetDir: string, owner: WorkspaceOwnership): Promise<boolean> {
  try {
    const root = await lstat(dataDir);
    if (!root.isDirectory() || root.isSymbolicLink() || !await sameDirectory(targetDir, owner)) return false;
    const markerPath = path.join(targetDir, OWNER_FILE);
    const markerStat = await lstat(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) return false;
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as WorkspaceOwnership;
    if (marker.token !== owner.token || marker.device !== owner.device || marker.inode !== owner.inode) return false;
    await rm(targetDir, { recursive: true, force: true });
    console.info(`[Workspace] Deleted directory: ${targetDir}`);
    return true;
  } catch (err) {
    console.error(`[Workspace] Failed to delete directory ${targetDir}`, err);
    return false;
  }
}
