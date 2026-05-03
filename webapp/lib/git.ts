import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { ChangeSummary } from "./types";

const execFileAsync = promisify(execFile);
const ignoredNames = new Set([".git", ".codex", ".vscode", ".workbench", "node_modules", ".next"]);

function normalizeDiffPath(rawPath: string) {
  let normalized = rawPath.trim();

  const braceRename = normalized.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (braceRename) {
    normalized = `${braceRename[1]}${braceRename[3]}${braceRename[4]}`;
  } else if (normalized.includes(" => ")) {
    normalized = normalized.split(" => ").at(-1);
  }

  return normalized.replace(/\\/g, "/");
}

function mergeChange(
  map: Map<string, ChangeSummary>,
  filePath: string,
  additions: number,
  deletions: number,
) {
  const existing = map.get(filePath) ?? { additions: 0, deletions: 0 };
  existing.additions += additions;
  existing.deletions += deletions;
  map.set(filePath, existing);
}

function countLines(contents: string) {
  if (!contents) {
    return 0;
  }

  return contents.split(/\r?\n/).length;
}

async function runGit(rootDir: string, args: string[]) {
  return execFileAsync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
}

async function hasHeadCommit(rootDir: string) {
  try {
    await runGit(rootDir, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

function isVisibleGitPath(filePath: string) {
  return filePath && !filePath.split("/").some((segment) => ignoredNames.has(segment));
}

export async function getGitChanges(rootDir: string): Promise<Record<string, ChangeSummary>> {
  const changes = new Map<string, ChangeSummary>();
  const diffArgs = (await hasHeadCommit(rootDir))
    ? ["diff", "--numstat", "HEAD", "--"]
    : ["diff", "--numstat", "--"];

  try {
    const { stdout } = await runGit(rootDir, diffArgs);

    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      const parts = line.split("\t");
      if (parts.length < 3) {
        continue;
      }

      const additions = Number.parseInt(parts[0], 10) || 0;
      const deletions = Number.parseInt(parts[1], 10) || 0;
      const filePath = normalizeDiffPath(parts.slice(2).join("\t"));

      if (!isVisibleGitPath(filePath)) {
        continue;
      }

      mergeChange(changes, filePath, additions, deletions);
    }
  } catch {
    return {};
  }

  try {
    const { stdout } = await runGit(rootDir, ["ls-files", "--others", "--exclude-standard", "--"]);

    for (const line of stdout.split(/\r?\n/)) {
      const filePath = line.trim().replace(/\\/g, "/");
      if (!isVisibleGitPath(filePath)) {
        continue;
      }

      const absolutePath = path.resolve(rootDir, filePath);

      try {
        const contents = await fs.readFile(absolutePath, "utf8");
        mergeChange(changes, filePath, countLines(contents), 0);
      } catch {
        mergeChange(changes, filePath, 1, 0);
      }
    }
  } catch {
    return Object.fromEntries(changes);
  }

  return Object.fromEntries(changes);
}

export async function getHeadFileContent(rootDir: string, filePath: string): Promise<string | null> {
  if (!(await hasHeadCommit(rootDir))) {
    return null;
  }

  try {
    const { stdout } = await runGit(rootDir, ["show", `HEAD:${filePath.replace(/\\/g, "/")}`]);
    return stdout;
  } catch {
    return null;
  }
}
