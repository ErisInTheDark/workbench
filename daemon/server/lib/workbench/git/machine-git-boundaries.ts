/*
 * Exports:
 * - MachineBoundaryFile: one file Workbench found under a boundary scope, with the Git mode it stages as.
 * - nestedRepositoryScopes: scopes lying inside a nested repository below a machine worktree root.
 * - listBoundaryFiles: files under boundary scopes, walked without following symlinks or entering `.git` folders.
 * Git stops walking at a nested `.git`, so files another repository ignores stay invisible to a machine repository's
 * `ls-files`/`add` even though tracked entries there diff, restore and restage normally. Workbench owns discovery for
 * those scopes; staging stays with the repository.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface MachineBoundaryFile {
  mode: "100644" | "100755" | "120000";
  path: string;
}

function isMissing(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"));
}

async function hasGitMarker(directory: string) {
  try {
    await fs.lstat(path.join(directory, ".git"));
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** A scope is a boundary scope when any directory between it and the root (exclusive) holds a `.git` marker. */
export async function nestedRepositoryScopes(root: string, scopes: readonly string[]) {
  const markers = new Map<string, Promise<boolean>>();
  const marked = (relative: string) => {
    let known = markers.get(relative);
    if (!known) markers.set(relative, known = hasGitMarker(path.join(root, ...relative.split("/"))));
    return known;
  };
  const boundary: string[] = [];
  for (const scope of scopes) {
    if (!scope || scope === ".") continue;
    const segments = scope.split("/");
    for (let length = segments.length; length > 0; length -= 1) {
      if (await marked(segments.slice(0, length).join("/"))) {
        boundary.push(scope);
        break;
      }
    }
  }
  return boundary;
}

function fileMode(stat: import("node:fs").Stats): MachineBoundaryFile["mode"] {
  if (stat.isSymbolicLink()) return "120000";
  return process.platform !== "win32" && (stat.mode & 0o111) !== 0 ? "100755" : "100644";
}

export async function listBoundaryFiles(root: string, scopes: readonly string[]) {
  const files = new Map<string, MachineBoundaryFile>();
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, ...relative.split("/"));
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stat.isFile() || stat.isSymbolicLink()) {
      files.set(relative, { mode: fileMode(stat), path: relative });
      return;
    }
    if (!stat.isDirectory()) return;
    for (const entry of await fs.readdir(absolute)) {
      if (entry !== ".git") await visit(`${relative}/${entry}`);
    }
  };
  for (const scope of scopes) await visit(scope);
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}
