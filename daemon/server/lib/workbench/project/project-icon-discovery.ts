/*
 * Exports:
 * - discoverWorkbenchProjectIcon: choose one existing Git-visible PNG or ICO across ordered project roots.
 * - selectWorkbenchProjectIcon: deterministically rank already-listed icon candidates.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { WorkbenchProjectIcon, WorkbenchProjectRoot } from "workbench-shared/types";
import { listGitVisibleFiles } from "../../git";

const PROJECT_ICON_PATHSPECS = [
  ":(glob,icase)**/favicon.png",
  ":(glob,icase)**/favicon[_ -]*.png",
  ":(glob,icase)**/icon.png",
  ":(glob,icase)**/icon[_ -]*.png",
  ":(glob,icase)**/favicon.ico",
  ":(glob,icase)**/favicon[_ -]*.ico",
  ":(glob,icase)**/icon.ico",
  ":(glob,icase)**/icon[_ -]*.ico",
  ":(glob,icase)**/icon/default.png",
  ":(glob,icase)**/icons/default.png",
  ":(glob,icase)**/icon/main.png",
  ":(glob,icase)**/icons/main.png",
] as const;

interface ProjectIconCandidate extends WorkbenchProjectIcon {
  depth: number;
  preference: number;
  rootIndex: number;
}

async function hasGitMarker(rootPath: string) {
  try {
    const stats = await fs.lstat(path.join(rootPath, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function iconPreference(filePath: string) {
  const segments = filePath.toLowerCase().split("/");
  const fileName = segments.at(-1) ?? "";
  const parentName = segments.at(-2) ?? "";
  if (fileName === "favicon.png") return 0;
  if (/^favicon[_ -].*\.png$/u.test(fileName)) return 1;
  if (fileName === "icon.png") return 2;
  if (/^icon[_ -].*\.png$/u.test(fileName)) return 3;
  if (fileName === "favicon.ico") return 4;
  if (/^favicon[_ -].*\.ico$/u.test(fileName)) return 5;
  if (fileName === "icon.ico") return 6;
  if (/^icon[_ -].*\.ico$/u.test(fileName)) return 7;
  if ((parentName === "icon" || parentName === "icons") && fileName === "default.png") return 8;
  if ((parentName === "icon" || parentName === "icons") && fileName === "main.png") return 9;
  return null;
}

export function selectWorkbenchProjectIcon(
  roots: readonly Pick<WorkbenchProjectRoot, "id">[],
  pathsByRoot: readonly (readonly string[])[],
): WorkbenchProjectIcon | null {
  const candidates = pathsByRoot.flatMap((paths, rootIndex) => paths.flatMap((rawPath) => {
    const path = rawPath.replace(/\\/gu, "/").replace(/^\/+/u, "");
    const preference = iconPreference(path);
    if (preference === null || !roots[rootIndex]) return [];
    return [{
      depth: path.split("/").length,
      path,
      preference,
      rootId: roots[rootIndex].id,
      rootIndex,
    } satisfies ProjectIconCandidate];
  }));
  candidates.sort((left, right) => (
    left.preference - right.preference
    || left.rootIndex - right.rootIndex
    || left.depth - right.depth
    || left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
  ));
  const selected = candidates[0];
  return selected ? { path: selected.path, rootId: selected.rootId } : null;
}

export async function discoverWorkbenchProjectIcon(
  roots: readonly Pick<WorkbenchProjectRoot, "id" | "rootPath">[],
) {
  const pathsByRoot = await Promise.all(
    roots.map(async ({ rootPath }) => {
      if (!await hasGitMarker(rootPath)) return [];
      const candidates = await listGitVisibleFiles(rootPath, PROJECT_ICON_PATHSPECS);
      const existing = [];
      for (const candidate of candidates) {
        try {
          if ((await fs.stat(path.join(rootPath, candidate))).isFile()) existing.push(candidate);
        } catch (error) {
          // Git still lists deleted tracked paths until their deletion is staged.
          if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
      }
      return existing;
    }),
  );
  return selectWorkbenchProjectIcon(roots, pathsByRoot);
}
