/*
 * Exports:
 * - formatBrowseMarkdownPrintf: render the allowlisted BrowseMD printf subset. Keywords: browsemd, printf, pipeline.
 * - getBrowseMarkdownAssignmentShapeError: diagnose quoted command-substitution assignments. Keywords: browsemd, assignment, validation.
 * - getBrowseMarkdownHelperDisplay: describe allowlisted BrowseMD file-helper execution. Keywords: browsemd, helper, display.
 * - getBrowseMarkdownWriteDisplay: describe BrowseMD output redirection. Keywords: browsemd, redirect, display.
 * - serializeBrowseMarkdownTokens: serialize parsed pipeline tokens back into safe BrowseMD command text. Keywords: browsemd, token, serialization.
 * - isBrowseMarkdownFileCommand: identify allowlisted workspace file helpers. Keywords: browsemd, file, allowlist.
 * - resolveBrowseMarkdownWorkspacePath: keep file helpers inside active workspace roots. Keywords: browsemd, path, workspace, security.
 * - runBrowseMarkdownFileCommand: execute allowlisted file and text helpers. Keywords: browsemd, file, process, pipeline.
 * - runBrowseMarkdownDownloadCommand: wait for one managed browser download. Keywords: browsemd, download, wait.
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import type { WorkbenchBrowseCommandResponse } from "../../types";
import type WorkbenchBrowseDownloadMonitor from "./WorkbenchBrowseDownloadMonitor";
import { killProcessTree } from "../../../orchestrator/process-helpers";

const BROWSE_MARKDOWN_FILE_COMMANDS = new Set(["cat", "cp", "echo", "grep", "jq", "ls", "mkdir", "mv", "printf", "pwd", "rm"]);

export interface BrowseMarkdownFileRuntimeContext {
  cwd: string;
  downloadMonitor: WorkbenchBrowseDownloadMonitor;
  signal: AbortSignal;
  workspaceRootPaths: readonly string[];
}

export function isBrowseMarkdownFileCommand(command: string) {
  return BROWSE_MARKDOWN_FILE_COMMANDS.has(command);
}

function isPathInside(parentPath: string, childPath: string) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function resolveBrowseMarkdownWorkspacePath(context: BrowseMarkdownFileRuntimeContext, targetPath: string) {
  if (path.isAbsolute(targetPath) || targetPath.includes("\0")) {
    throw new Error("BrowseMD file commands require project-relative paths.");
  }
  const absolutePath = path.resolve(context.cwd, targetPath);
  if (!context.workspaceRootPaths.some((rootPath) => isPathInside(rootPath, absolutePath))) {
    throw new Error(`BrowseMD path escapes the active workspace roots: ${targetPath}`);
  }
  return absolutePath;
}

function joinBrowseMarkdownDisplayArgs(args: readonly string[]) {
  return args.length ? args.join(" ") : null;
}

export function getBrowseMarkdownHelperDisplay(command: string, args: readonly string[]) {
  const target = joinBrowseMarkdownDisplayArgs(args);
  switch (command) {
    case "cat": return { action: "Read file", detailText: target };
    case "cp": return { action: "Copy file", detailText: args.length >= 2 ? `${args[0]} → ${args[1]}` : target };
    case "echo":
    case "printf": return { action: "Print text", detailText: target };
    case "grep": return { action: "Filter text", detailText: target };
    case "jq": return { action: "Transform JSON", detailText: target };
    case "ls": return { action: "List files", detailText: target ?? "." };
    case "mkdir": return { action: "Create directory", detailText: args.at(-1) ?? target };
    case "mv": return { action: "Move file", detailText: args.length >= 2 ? `${args[0]} → ${args[1]}` : target };
    case "pwd": return { action: "Print working directory", detailText: null };
    case "rm": return { action: "Remove file", detailText: target };
    default: return { action: command, detailText: target };
  }
}

export function getBrowseMarkdownWriteDisplay(outputPath: string, append: boolean) {
  return {
    action: append ? "Append file" : "Write file",
    detailText: outputPath,
  };
}

function readBrowseMarkdownPrintfEscape(value: string) {
  switch (value) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "\\": return "\\";
    case "\"": return "\"";
    case "'": return "'";
    default: return value;
  }
}

export function formatBrowseMarkdownPrintf(args: readonly string[]) {
  const format = args[0] ?? "";
  const values = args.slice(1);
  let output = "";
  let valueIndex = 0;
  for (let index = 0; index < format.length; index += 1) {
    const character = format[index] ?? "";
    if (character === "\\") {
      const escaped = format[index + 1];
      if (!escaped) {
        output += "\\";
        continue;
      }
      output += readBrowseMarkdownPrintfEscape(escaped);
      index += 1;
      continue;
    }
    if (character !== "%") {
      output += character;
      continue;
    }
    const conversion = format[index + 1] ?? "";
    if (!conversion) {
      return { error: "printf format cannot end with a bare %.", ok: false as const };
    }
    if (conversion === "%") {
      output += "%";
      index += 1;
      continue;
    }
    if (conversion !== "s") {
      return { error: `printf only supports %s and %% conversions, not %${conversion}.`, ok: false as const };
    }
    output += values[valueIndex] ?? "";
    valueIndex += 1;
    index += 1;
  }
  return { ok: true as const, output };
}

export function getBrowseMarkdownAssignmentShapeError(line: string) {
  const trimmedLine = line.trim();
  return /^[A-Za-z_][A-Za-z0-9_]*\s*=\s*["'`]\s*\$\(/u.test(trimmedLine)
    ? "BrowseMD assignments use `name=$(command)` without quotes around the command substitution."
    : null;
}

export function serializeBrowseMarkdownTokens(tokens: readonly string[]) {
  return tokens.map((token) => {
    if (!token || /[\s"'`\\]/u.test(token)) {
      return `"${token.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
    }
    return token;
  }).join(" ");
}

async function runBrowseMarkdownProcess(
  command: string,
  args: string[],
  stdin: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
) {
  const startedAt = Date.now();
  return await new Promise<WorkbenchBrowseCommandResponse>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let aborted = signal.aborted;
    let settled = false;
    let timedOut = false;
    const abort = () => {
      aborted = true;
      killProcessTree(child.pid);
    };
    signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve({ durationMs: Date.now() - startedAt, error: aborted ? `${command} cancelled.` : error.message, exitCode: null, ok: false, stderr, stdout, timedOut });
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      resolve({
        durationMs: Date.now() - startedAt,
        error: aborted ? `${command} cancelled.` : timedOut ? `${command} timed out after ${timeoutMs}ms.` : undefined,
        exitCode,
        ok: exitCode === 0 && !timedOut && !aborted,
        stderr,
        stdout,
        timedOut: timedOut || undefined,
      });
    });
    if (aborted) abort();
    child.stdin.end(stdin);
  });
}

async function waitWithAbort<TValue>(promise: Promise<TValue>, signal: AbortSignal) {
  if (signal.aborted) throw signal.reason;
  return await new Promise<TValue>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}

export async function runBrowseMarkdownFileCommand(
  context: BrowseMarkdownFileRuntimeContext,
  command: string,
  args: string[],
  stdin: string,
): Promise<WorkbenchBrowseCommandResponse> {
  const startedAt = Date.now();
  const ok = (stdout = "", stderr = "") => ({ durationMs: Date.now() - startedAt, exitCode: 0, ok: true, stderr, stdout });
  const fail = (message: string) => ({ durationMs: Date.now() - startedAt, error: message, exitCode: 1, ok: false, stderr: `${message}\n`, stdout: "" });
  try {
    switch (command) {
      case "echo": return ok(`${args.join(" ")}\n`);
      case "printf": {
        const result = formatBrowseMarkdownPrintf(args);
        return result.ok ? ok(result.output) : fail(result.error);
      }
      case "pwd": return ok(`${context.cwd}\n`);
      case "cat": {
        if (!args.length) return ok(stdin);
        const contents = await Promise.all(args.map(async (arg) => await fs.readFile(resolveBrowseMarkdownWorkspacePath(context, arg), "utf8")));
        return ok(contents.join(""));
      }
      case "ls": {
        const entries = await fs.readdir(resolveBrowseMarkdownWorkspacePath(context, args[0] ?? "."));
        return ok(`${entries.sort((left, right) => left.localeCompare(right)).join("\n")}${entries.length ? "\n" : ""}`);
      }
      case "mkdir":
        await fs.mkdir(resolveBrowseMarkdownWorkspacePath(context, args.at(-1) ?? ""), { recursive: args.includes("-p") });
        return ok();
      case "cp":
        if (args.length < 2) return fail("cp requires source and destination.");
        await fs.copyFile(resolveBrowseMarkdownWorkspacePath(context, args[0] ?? ""), resolveBrowseMarkdownWorkspacePath(context, args[1] ?? ""));
        return ok();
      case "mv": {
        if (args.length < 2) return fail("mv requires source and destination.");
        const sourcePath = resolveBrowseMarkdownWorkspacePath(context, args[0] ?? "");
        const destinationPath = resolveBrowseMarkdownWorkspacePath(context, args[1] ?? "");
        await fs.mkdir(path.dirname(destinationPath), { recursive: true });
        await fs.rename(sourcePath, destinationPath);
        return ok();
      }
      case "rm": {
        const targets = args.filter((arg) => !arg.startsWith("-"));
        if (!targets.length) return fail("rm requires at least one target.");
        for (const target of targets) {
          const absoluteTarget = resolveBrowseMarkdownWorkspacePath(context, target);
          let stats;
          try {
            stats = await fs.lstat(absoluteTarget);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (stats.isDirectory()) return fail(`rm only supports files: ${target}`);
          await fs.rm(absoluteTarget, { force: true });
        }
        return ok();
      }
      case "grep":
      case "jq": return await runBrowseMarkdownProcess(command, args, stdin, context.cwd, 30_000, context.signal);
      default: return fail(`Unsupported BrowseMD file command: ${command}`);
    }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export async function runBrowseMarkdownDownloadCommand(context: BrowseMarkdownFileRuntimeContext, args: string[]): Promise<WorkbenchBrowseCommandResponse> {
  const startedAt = Date.now();
  const fail = (message: string) => ({ durationMs: Date.now() - startedAt, error: message, exitCode: 1, ok: false, stderr: `${message}\n`, stdout: "" });
  if (args.length !== 1 || args[0]?.toLowerCase() !== "download") {
    return fail("wait download does not support additional arguments.");
  }
  try {
    const download = await waitWithAbort(context.downloadMonitor.waitForDownload(), context.signal);
    return { durationMs: Date.now() - startedAt, exitCode: 0, ok: true, stderr: "", stdout: `${JSON.stringify(download)}\n` };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}
