/*
 * Exports:
 * - default WorkbenchNativeFileController: own validated editor, file-manager, and external-link-root OS operations. Keywords: native, file, editor, reveal.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveExternalFileLinkRoot, resolveProjectFilePath } from "../lib/project";
import type {
  OpenFileInEditorRequest,
  ResolveExternalFileLinkRootsRequest,
  RevealProjectEntryRequest,
} from "../lib/types";
import type WorkbenchProjectCatalogController from "./WorkbenchProjectCatalogController";

function isLocalAbsolutePath(filePath: string) {
  const normalized = filePath.replace(/\\/gu, "/");
  return /^[A-Za-z]:\//u.test(normalized) || (normalized.startsWith("/") && !normalized.startsWith("//"));
}

async function spawnDetached(command: string, args: string[], detached = process.platform !== "win32") {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached, shell: false, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export default class WorkbenchNativeFileController {
  constructor(private readonly catalog: Pick<WorkbenchProjectCatalogController, "resolveProjectById">) {}

  async open(request: OpenFileInEditorRequest) {
    const project = request.absolutePath ? null : await this.catalog.resolveProjectById(request.projectId);
    const file = project ? resolveProjectFilePath(project, request.path) : null;
    const absolutePath = request.absolutePath ?? file?.absolutePath;
    if (!absolutePath || !isLocalAbsolutePath(absolutePath)) throw new Error("The requested path must be a local absolute file path.");
    if (!(await fs.stat(absolutePath)).isFile()) throw new Error("The requested path is not a file.");
    const target = request.lineNumber
      ? `${absolutePath}:${Math.trunc(request.lineNumber)}${request.columnNumber ? `:${Math.trunc(request.columnNumber)}` : ""}`
      : absolutePath;
    if (process.platform === "win32") {
      await spawnDetached(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `code --goto "${target.replace(/"/gu, "\\\"")}"`], false);
    } else {
      await spawnDetached("code", ["--goto", target]);
    }
    return { ok: true as const, path: file?.displayPath ?? absolutePath.replace(/\\/gu, "/"), projectId: project?.id ?? null, target };
  }

  async reveal(request: RevealProjectEntryRequest) {
    const project = await this.catalog.resolveProjectById(request.projectId);
    const entry = resolveProjectFilePath(project, request.path);
    const stats = await fs.stat(entry.absolutePath);
    if (process.platform === "win32") {
      await spawnDetached("explorer.exe", stats.isDirectory() ? [entry.absolutePath] : [`/select,${entry.absolutePath}`], false);
    } else if (process.platform === "darwin") {
      await spawnDetached("open", stats.isDirectory() ? [entry.absolutePath] : ["-R", entry.absolutePath]);
    } else {
      await spawnDetached("xdg-open", [stats.isDirectory() ? entry.absolutePath : path.dirname(entry.absolutePath)]);
    }
    return { ok: true as const, path: entry.displayPath, projectId: project.id };
  }

  async linkRoots(request: ResolveExternalFileLinkRootsRequest) {
    const roots = new Map<string, { id: string; openPathMode: "absolute"; rootPath: string }>();
    for (const filePath of [...new Set(request.paths.map((value) => value.trim()).filter(Boolean))].slice(0, 80)) {
      const root = await resolveExternalFileLinkRoot(filePath);
      if (root) roots.set(root.rootPath.toLowerCase(), { id: root.id, openPathMode: "absolute", rootPath: root.rootPath });
    }
    return { roots: [...roots.values()] };
  }
}
