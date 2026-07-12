/*
 * Exports:
 * - default WorkbenchBrowseRequestHandler: execute typed Browse actions, BrowseMD scripts, sessions, streaming sequences, screenshots, and transcript recording for the orchestrator-owned Browse lifecycle. Keywords: browse, browsemd, orchestrator, request, streaming.
 * - WorkbenchBrowseSerializedRunner: orchestrator-owned FIFO callback used to serialize command producers only. Keywords: browse, queue, serialization, streaming.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { normalizeRelativePath, projectRoot, safeResolveProjectPath } from "../../project";
import type {
  WorkbenchBrowseAgentAction,
  WorkbenchBrowseAgentResponse,
  WorkbenchBrowseAgentScriptRequest,
  WorkbenchBrowseAgentSequenceRequest,
  WorkbenchBrowseAgentSequenceProgressEvent,
  WorkbenchBrowseAgentSequenceResponse,
  WorkbenchBrowseCommandRequest,
  WorkbenchBrowseCommandResponse,
  WorkbenchBrowseResultEntryDetailKind,
  WorkbenchBrowseSessionControlRequest,
  WorkbenchBrowseSessionControlResponse,
  WorkbenchBrowseSessionListRequest,
  WorkbenchBrowseSessionListResponse,
  WorkbenchHarness,
  WorkbenchBrowseSessionMode,
} from "../../types";
import WorkbenchBrowseCli from "./WorkbenchBrowseCli";
import WorkbenchBrowseSessionController from "./WorkbenchBrowseSessionController";
import { normalizeWorkbenchBrowseAgentRequest } from "./browse-agent-requests";
import { compileWorkbenchBrowseMarkdown, tokenizeWorkbenchBrowseMarkdownLine } from "./browse-markdown";
import WorkbenchBrowseDownloadMonitor from "./WorkbenchBrowseDownloadMonitor";
import {
  createBrowseAgentSequenceProgressResponse,
  createBrowseAgentSequenceResponse,
  createBrowseCommandResponse,
} from "./browse-command-runtime";
import {
  getBrowseMarkdownAssignmentShapeError,
  getBrowseMarkdownHelperDisplay,
  getBrowseMarkdownWriteDisplay,
  isBrowseMarkdownFileCommand,
  resolveBrowseMarkdownWorkspacePath as resolveBrowseMarkdownWorkspaceRuntimePath,
  runBrowseMarkdownDownloadCommand as executeBrowseMarkdownDownloadCommand,
  runBrowseMarkdownFileCommand as executeBrowseMarkdownFileCommand,
  serializeBrowseMarkdownTokens,
} from "./browse-markdown-runtime";
import { resolveAgentEndpointProjectFromCwd } from "../project/agent-endpoint-project";
import WorkbenchServerSettings from "../settings/WorkbenchServerSettings";
import { createAgentScreenshotSteerText } from "../thread/thread-steer-markers";
import type WorkbenchBrowseTranscriptAdapter from "../../../orchestrator/WorkbenchBrowseTranscriptAdapter";

const DEFAULT_BROWSE_TIMEOUT_MS = 120_000;
const MAX_BROWSE_TIMEOUT_MS = 10 * 60_000;
const MAX_BROWSE_ARGS = 128;
const MAX_BROWSE_ARG_LENGTH = 16_384;
const MAX_BROWSE_STDIN_LENGTH = 2 * 1024 * 1024;
const MAX_BROWSE_MARKDOWN_SCRIPT_LENGTH = 2 * 1024 * 1024;
const MAX_BROWSE_MARKDOWN_VARIABLES = 64;
const MAX_BROWSE_MARKDOWN_VARIABLE_VALUE_LENGTH = 16_384;
const MAX_BROWSE_AGENT_SEQUENCE_ACTIONS = 50;
const BROWSE_SCREENSHOT_ASSET_THREAD_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BROWSE_SCREENSHOT_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/iu;
const BROWSE_SCREENSHOT_BASE64_PATTERN = /^[a-z0-9+/=\s]+$/iu;
const BROWSE_MARKDOWN_FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+\.browsemd$/u;
const BROWSE_MARKDOWN_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const BROWSE_MARKDOWN_VARIABLE_REFERENCE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const browseCli = new WorkbenchBrowseCli();
const browseSessionController = new WorkbenchBrowseSessionController({ cli: browseCli });

export type WorkbenchBrowseSerializedRunner = <TValue>(task: () => Promise<TValue>) => Promise<TValue>;

interface WorkbenchBrowseExecutionContext {
  signal: AbortSignal;
  transcripts: WorkbenchBrowseTranscriptAdapter;
}
const browseCommandResponse = createBrowseCommandResponse;
const browseAgentSequenceResponse = createBrowseAgentSequenceResponse;
const browseAgentSequenceProgressResponse = createBrowseAgentSequenceProgressResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizePositiveInteger(value: unknown, fallback: number, maximum: number) {
  const numericValue = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.min(Math.trunc(numericValue), maximum);
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBrowseArgs(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_BROWSE_ARGS) {
    return null;
  }

  const args: string[] = [];
  for (const arg of value) {
    if (typeof arg !== "string" || arg.includes("\0") || arg.length > MAX_BROWSE_ARG_LENGTH) {
      return null;
    }
    args.push(arg);
  }
  return args;
}

function normalizeThreadId(value: unknown) {
  const threadId = normalizeString(value);
  return threadId && BROWSE_SCREENSHOT_ASSET_THREAD_PATTERN.test(threadId) ? threadId : "";
}

function normalizeBrowseRequest(value: unknown): WorkbenchBrowseCommandRequest | null {
  if (!isRecord(value)) {
    return null;
  }

  const args = normalizeBrowseArgs(value.args);
  if (!args) {
    return null;
  }

  const stdin = typeof value.stdin === "string" ? value.stdin : null;
  if (stdin !== null && stdin.length > MAX_BROWSE_STDIN_LENGTH) {
    return null;
  }

  const threadId = normalizeThreadId(value.threadId);
  if (!threadId) {
    return null;
  }

  return {
    args,
    cwd: normalizeString(value.cwd) || null,
    projectId: normalizeString(value.projectId) || null,
    stdin,
    threadId,
    timeoutMs: normalizePositiveInteger(value.timeoutMs, DEFAULT_BROWSE_TIMEOUT_MS, MAX_BROWSE_TIMEOUT_MS),
  };
}

function normalizeMode(value: unknown): WorkbenchBrowseSessionMode | null {
  return value === "headed" || value === "headless" ? value : null;
}

function normalizeBrowseMarkdownVariables(value: unknown) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_BROWSE_MARKDOWN_VARIABLES) {
    return null;
  }

  const variables: Record<string, string> = {};
  for (const [name, variableValue] of entries) {
    if (!BROWSE_MARKDOWN_VARIABLE_PATTERN.test(name)
      || typeof variableValue !== "string"
      || variableValue.includes("\0")
      || variableValue.length > MAX_BROWSE_MARKDOWN_VARIABLE_VALUE_LENGTH) {
      return null;
    }
    variables[name] = variableValue;
  }
  return variables;
}

function normalizeBrowseMarkdownRequest(value: Record<string, unknown>): WorkbenchBrowseAgentScriptRequest | null {
  const threadId = normalizeThreadId(value.threadId);
  const cwd = normalizeString(value.cwd);
  if (!threadId || !cwd) {
    return null;
  }

  const script = typeof value.script === "string" ? value.script : null;
  const scriptPath = typeof value.scriptPath === "string" ? normalizeString(value.scriptPath) : null;
  if ((script ? 1 : 0) + (scriptPath ? 1 : 0) !== 1) {
    return null;
  }
  if (script !== null && script.length > MAX_BROWSE_MARKDOWN_SCRIPT_LENGTH) {
    return null;
  }
  const vars = normalizeBrowseMarkdownVariables(value.vars);
  if (value.vars !== undefined && value.vars !== null && !vars) {
    return null;
  }

  const base = {
    cwd,
    mode: normalizeMode(value.mode),
    session: normalizeString(value.session) || null,
    streamProgress: value.streamProgress === true,
    summary: normalizeString(value.summary) || null,
    stopOnError: value.stopOnError === false ? false : true,
    threadId,
    timeoutMs: normalizePositiveInteger(value.timeoutMs, DEFAULT_BROWSE_TIMEOUT_MS, MAX_BROWSE_TIMEOUT_MS),
    vars,
  };

  return script !== null
    ? { ...base, script }
    : { ...base, scriptPath: scriptPath ?? "" };
}

function normalizeBrowseMarkdownFileName(value: string) {
  const normalizedPath = value.replace(/\\/gu, "/").replace(/^\/+/u, "").trim();
  if (!normalizedPath || normalizedPath.includes("/") || normalizedPath === "." || normalizedPath === ".." || normalizedPath.includes("..")) {
    return null;
  }
  const fileName = normalizedPath.endsWith(".browsemd") ? normalizedPath : `${normalizedPath}.browsemd`;
  return BROWSE_MARKDOWN_FILE_NAME_PATTERN.test(fileName) ? fileName : null;
}

interface BrowseMarkdownRuntimeContext {
  activeThread: {
    commandItemId: string | null;
    harness: WorkbenchHarness;
    turnId: string;
  } | null;
  cwd: string;
  downloadMonitor: WorkbenchBrowseDownloadMonitor;
  execution: WorkbenchBrowseExecutionContext;
  signal: AbortSignal;
  scriptRequest: WorkbenchBrowseAgentScriptRequest;
  variables: Map<string, string>;
  workspaceRootPaths: string[];
}

interface BrowseMarkdownCommandResult extends WorkbenchBrowseCommandResponse {
  browseResultAction?: string | null;
  browseResultDetail?: {
    detailKind: WorkbenchBrowseResultEntryDetailKind | null;
    detailLabel: string | null;
    detailText: string | null;
  } | null;
  outputRedirected?: boolean;
}

interface BrowseMarkdownStatement {
  kind: "command" | "javascript";
  lineNumber: number;
  text: string;
}

function normalizeBrowseMarkdownIncludeName(value: string) {
  const normalizedPath = value.replace(/\\/gu, "/").replace(/^\/+/u, "").trim();
  if (!normalizedPath || normalizedPath === "." || normalizedPath.includes("..")) {
    return null;
  }
  return normalizedPath.endsWith(".browsemd") ? normalizedPath : `${normalizedPath}.browsemd`;
}

async function readBrowseMarkdownSource(request: WorkbenchBrowseAgentScriptRequest) {
  const resolution = await resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "BrowseMD" });
  if (!("scriptPath" in request)) {
    return {
      baseDirectoryPath: resolution.cwd,
      workspaceRootPaths: resolution.project.roots.map((root) => root.root),
      script: request.script,
    };
  }

  const fileName = normalizeBrowseMarkdownFileName(request.scriptPath);
  if (!fileName) {
    throw new Error("BrowseMD scriptPath must name a .browsemd file directly inside .workbench/browse.");
  }

  const scriptsDirectoryPath = path.join(resolution.root.root, ".workbench", "browse");
  const scriptFilePath = safeResolveProjectPath(scriptsDirectoryPath, fileName);
  const script = await fs.readFile(scriptFilePath, "utf8");
  if (script.length > MAX_BROWSE_MARKDOWN_SCRIPT_LENGTH) {
    throw new Error("BrowseMD script file is too large.");
  }
  return {
    baseDirectoryPath: path.dirname(scriptFilePath),
    workspaceRootPaths: resolution.project.roots.map((root) => root.root),
    script,
  };
}

function isPathInside(parentPath: string, childPath: string) {
  const relativePath = path.relative(parentPath, childPath);
  return !relativePath || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

async function resolveBrowseMarkdownIncludePath(
  request: WorkbenchBrowseAgentScriptRequest,
  currentBaseDirectoryPath: string,
  includeTarget: string,
) {
  const target = includeTarget.trim();
  const resolution = await resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "BrowseMD" });
  if (target.startsWith("~/")) {
    const includeName = normalizeBrowseMarkdownIncludeName(target.slice(2));
    if (!includeName) {
      throw new Error(`Invalid BrowseMD include target: ${includeTarget}`);
    }
    return path.join(os.homedir(), ".workbench", "browse", includeName);
  }

  const projectMatch = /^([^:]+):(.+)$/u.exec(target);
  if (projectMatch) {
    const rootName = projectMatch[1]?.trim() ?? "";
    const includeName = normalizeBrowseMarkdownIncludeName(projectMatch[2] ?? "");
    const root = resolution.project.roots.find((candidate) => candidate.id === rootName || candidate.name === rootName);
    if (!root || !includeName) {
      throw new Error(`BrowseMD include target ${includeTarget} does not match a root in the current workspace.`);
    }
    return path.join(root.root, ".workbench", "browse", includeName);
  }

  const includeName = normalizeBrowseMarkdownIncludeName(target);
  if (!includeName) {
    throw new Error(`Invalid BrowseMD include target: ${includeTarget}`);
  }
  if (target.startsWith(".") || target.includes("/")) {
    const includePath = path.resolve(currentBaseDirectoryPath, includeName);
    if (!resolution.project.roots.some((root) => isPathInside(root.root, includePath))) {
      throw new Error(`BrowseMD include ${includeTarget} resolved outside the current workspace.`);
    }
    return includePath;
  }

  return path.join(resolution.root.root, ".workbench", "browse", includeName);
}

async function expandBrowseMarkdownIncludes(
  request: WorkbenchBrowseAgentScriptRequest,
  script: string,
  baseDirectoryPath: string,
  stack: string[] = [],
) {
  const outputLines: string[] = [];
  const lines = script.replace(/\r\n?/gu, "\n").split("\n");
  for (const [index, line] of lines.entries()) {
    const includeMatch = line.trim().match(/^@include\s+(.+)$/u);
    if (!includeMatch) {
      outputLines.push(line);
      continue;
    }

    const includePath = await resolveBrowseMarkdownIncludePath(request, baseDirectoryPath, includeMatch[1] ?? "");
    const includeKey = normalizeRelativePath(path.resolve(includePath));
    if (stack.includes(includeKey)) {
      throw new Error(`BrowseMD include cycle detected at ${includeKey}.`);
    }
    let includeScript = "";
    try {
      includeScript = await fs.readFile(includePath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read BrowseMD include on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    outputLines.push(await expandBrowseMarkdownIncludes(request, includeScript, path.dirname(includePath), [...stack, includeKey]));
  }
  return outputLines.join("\n");
}

function readBrowseMarkdownStatements(script: string) {
  const statements: BrowseMarkdownStatement[] = [];
  const lines = script.replace(/\r\n?/gu, "\n").split("\n");
  let fenceStartLine: number | null = null;
  let fenceLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (fenceStartLine !== null) {
      fenceLines.push(line);
      if (/^```+\s*$/u.test(line.trim())) {
        statements.push({ kind: "javascript", lineNumber: fenceStartLine, text: fenceLines.join("\n") });
        fenceStartLine = null;
        fenceLines = [];
      }
      continue;
    }

    if (/^```+\s*(?:js|javascript)\s*$/iu.test(line.trim())) {
      fenceStartLine = lineNumber;
      fenceLines = [line];
      continue;
    }

    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine === "---" || trimmedLine.startsWith("# ") || trimmedLine.startsWith("## ") || trimmedLine.startsWith("### ") || trimmedLine.startsWith("// ")) {
      continue;
    }
    statements.push({ kind: "command", lineNumber, text: line });
  }

  if (fenceStartLine !== null) {
    throw new Error(`BrowseMD line ${fenceStartLine}: Unclosed fenced code block.`);
  }
  return statements;
}

function splitBrowseMarkdownPipeline(line: string) {
  return splitBrowseMarkdownOutsideQuotes(line, "|").map((segment) => segment.trim()).filter(Boolean);
}

function splitBrowseMarkdownOutsideQuotes(line: string, separator: string) {
  const segments: string[] = [];
  let segment = "";
  let quote: string | null = null;
  let escaped = false;
  for (const character of line) {
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === "\"" || character === "`") {
      segment += character;
      quote = character;
      continue;
    }
    if (character === separator) {
      segments.push(segment);
      segment = "";
      continue;
    }
    segment += character;
  }
  segments.push(segment);
  return segments;
}

function expandBrowseMarkdownVariables(line: string, variables: ReadonlyMap<string, string>) {
  let output = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] ?? "";
    if (character === "\\" && line[index + 1] === "$") {
      output += "$";
      index += 1;
      continue;
    }
    if (character !== "$") {
      output += character;
      continue;
    }

    const reference = readBrowseMarkdownVariableReference(line, index);
    if (!reference) {
      output += character;
      continue;
    }
    output += variables.get(reference.name) ?? "";
    index = reference.endIndex - 1;
  }
  return output;
}

function readBrowseMarkdownVariableReference(line: string, startIndex: number) {
  if (line[startIndex + 1] === "{") {
    const closingIndex = line.indexOf("}", startIndex + 2);
    if (closingIndex < 0) {
      return null;
    }
    const name = line.slice(startIndex + 2, closingIndex);
    return BROWSE_MARKDOWN_VARIABLE_REFERENCE_NAME_PATTERN.test(name)
      ? { endIndex: closingIndex + 1, name }
      : null;
  }

  const match = line.slice(startIndex + 1).match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/u);
  const name = match?.[0] ?? "";
  return name ? { endIndex: startIndex + 1 + name.length, name } : null;
}

function parseBrowseMarkdownAssignment(line: string) {
  const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=\$\(([\s\S]*)\)$/u);
  return match ? { command: match[2]?.trim() ?? "", name: match[1] ?? "" } : null;
}

function setBrowseMarkdownVariable(variables: Map<string, string>, name: string, stdout: string) {
  const value = stdout.replace(/\r?\n$/u, "");
  variables.set(name, value);

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return;
  }
  if (!isRecord(parsed)) {
    return;
  }

  for (const [fieldName, fieldValue] of Object.entries(parsed)) {
    if (!BROWSE_MARKDOWN_VARIABLE_PATTERN.test(fieldName)) {
      continue;
    }
    const stringValue = stringifyBrowseMarkdownVariableField(fieldValue);
    if (stringValue !== null) {
      variables.set(`${name}.${fieldName}`, stringValue);
    }
  }
}

function stringifyBrowseMarkdownVariableField(value: unknown) {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function removeBrowseMarkdownRedirections(tokens: string[]) {
  let outputPath: string | null = null;
  let append = false;
  let inputPath: string | null = null;
  const commandTokens: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token === ">" || token === ">>" || token === "<") {
      const target = tokens[index + 1]?.trim();
      if (!target) {
        throw new Error(`BrowseMD redirection ${token} requires a file path.`);
      }
      if (token === "<") {
        inputPath = target;
      } else {
        outputPath = target;
        append = token === ">>";
      }
      index += 1;
      continue;
    }
    commandTokens.push(token);
  }
  return { append, commandTokens, inputPath, outputPath };
}

async function runBrowseMarkdownBrowseCommand(
  context: BrowseMarkdownRuntimeContext,
  line: string,
  actionIndex: number,
  lineNumber: number,
): Promise<BrowseMarkdownCommandResult> {
  const sequence = compileWorkbenchBrowseMarkdown(line, {
    cwd: context.scriptRequest.cwd,
    lineNumberOffset: lineNumber - 1,
    mode: context.scriptRequest.mode ?? null,
    session: context.scriptRequest.session ?? null,
    streamProgress: false,
    summary: null,
    stopOnError: true,
    threadId: context.scriptRequest.threadId,
    timeoutMs: context.scriptRequest.timeoutMs ?? null,
  });
  if (sequence.actions.length !== 1) {
    return {
      durationMs: 0,
      error: "BrowseMD pipeline segments must compile to exactly one Browse command.",
      exitCode: 1,
      ok: false,
      stderr: "BrowseMD pipeline segments must compile to exactly one Browse command.\n",
      stdout: "",
    };
  }
  return await runBrowseAgentCommand(context.execution, sequence.actions[0] as WorkbenchBrowseAgentAction, { actionIndex });
}

async function runBrowseMarkdownPipeline(
  context: BrowseMarkdownRuntimeContext,
  line: string,
  actionIndex: number,
  lineNumber: number,
) {
  const expandedLine = expandBrowseMarkdownVariables(line, context.variables);
  const segments = splitBrowseMarkdownPipeline(expandedLine);
  let stdin = "";
  let finalResult: BrowseMarkdownCommandResult = { durationMs: 0, exitCode: 0, ok: true, stderr: "", stdout: "" };
  for (const [segmentIndex, segment] of segments.entries()) {
    const tokens = tokenizeWorkbenchBrowseMarkdownLine(segment, lineNumber);
    const { append, commandTokens, inputPath, outputPath } = removeBrowseMarkdownRedirections(tokens);
    if (inputPath) {
      stdin = await fs.readFile(resolveBrowseMarkdownWorkspaceRuntimePath(context, inputPath), "utf8");
    }
    const executableTokens = commandTokens[0]?.toLowerCase() === "browse" ? commandTokens.slice(1) : commandTokens;
    const command = executableTokens[0]?.toLowerCase() ?? "";
    const args = executableTokens.slice(1);
    if (command === "wait" && args[0]?.toLowerCase() === "download") {
      finalResult = {
        ...await executeBrowseMarkdownDownloadCommand(context, args),
        browseResultAction: "Wait for download",
        browseResultDetail: {
          detailKind: "text",
          detailLabel: null,
          detailText: "download",
        },
      };
    } else if (isBrowseMarkdownFileCommand(command)) {
      const display = getBrowseMarkdownHelperDisplay(command, args);
      finalResult = {
        ...await executeBrowseMarkdownFileCommand(context, command, args, stdin),
        browseResultAction: display.action,
        browseResultDetail: {
          detailKind: display.detailText ? "text" : null,
          detailLabel: null,
          detailText: display.detailText,
        },
      };
    } else {
      finalResult = await runBrowseMarkdownBrowseCommand(context, serializeBrowseMarkdownTokens(executableTokens), actionIndex, lineNumber);
    }
    if (!finalResult.ok) {
      return finalResult;
    }
    stdin = finalResult.stdout;
    if (segmentIndex === segments.length - 1 && outputPath) {
      const resolvedOutputPath = resolveBrowseMarkdownWorkspaceRuntimePath(context, outputPath);
      await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
      if (append) {
        await fs.appendFile(resolvedOutputPath, finalResult.stdout);
      } else {
        await fs.writeFile(resolvedOutputPath, finalResult.stdout);
      }
      const display = getBrowseMarkdownWriteDisplay(outputPath, append);
      finalResult = {
        ...finalResult,
        browseResultAction: display.action,
        browseResultDetail: {
          detailKind: "text",
          detailLabel: null,
          detailText: display.detailText,
        },
        outputRedirected: true,
        stdout: "",
      };
    }
  }
  return finalResult;
}

function isBrowseMarkdownHelpStatement(statement: BrowseMarkdownStatement) {
  if (statement.kind === "javascript") {
    return false;
  }
  const tokens = tokenizeWorkbenchBrowseMarkdownLine(statement.text, statement.lineNumber);
  return tokens.some((token) => token === "--help" || token === "-h");
}

async function runBrowseMarkdownRequest(execution: WorkbenchBrowseExecutionContext, scriptRequest: WorkbenchBrowseAgentScriptRequest): Promise<WorkbenchBrowseCommandResponse> {
  const startedAt = Date.now();
  const source = await readBrowseMarkdownSource(scriptRequest);
  const script = await expandBrowseMarkdownIncludes(scriptRequest, source.script, source.baseDirectoryPath);
  if (script.length > MAX_BROWSE_MARKDOWN_SCRIPT_LENGTH) {
    throw new Error("BrowseMD script is too large after includes.");
  }
  const statements = readBrowseMarkdownStatements(script);
  if (!statements.length) {
    throw new Error("BrowseMD script did not contain any commands.");
  }
  if (statements.length > MAX_BROWSE_AGENT_SEQUENCE_ACTIONS) {
    throw new Error(`BrowseMD scripts can include at most ${MAX_BROWSE_AGENT_SEQUENCE_ACTIONS} commands after includes.`);
  }

  const downloadMonitor = new WorkbenchBrowseDownloadMonitor({
    cwd: scriptRequest.cwd,
    timeoutMs: scriptRequest.timeoutMs ?? DEFAULT_BROWSE_TIMEOUT_MS,
    workspaceRootPaths: source.workspaceRootPaths,
  });
  await downloadMonitor.initialize();

  const context: BrowseMarkdownRuntimeContext = {
    activeThread: await execution.transcripts.readActiveThread(scriptRequest.threadId, false),
    cwd: scriptRequest.cwd,
    downloadMonitor,
    execution,
    signal: execution.signal,
    scriptRequest,
    variables: new Map(Object.entries(scriptRequest.vars ?? {})),
    workspaceRootPaths: source.workspaceRootPaths,
  };
  const helpStatements = statements.filter(isBrowseMarkdownHelpStatement);
  if (helpStatements.length) {
    throw new Error(getUnsupportedBrowseHelpError());
  }

  let stdout = "";
  let stderr = "";
  for (const [index, statement] of statements.entries()) {
    const assignmentShapeError = statement.kind === "command" ? getBrowseMarkdownAssignmentShapeError(statement.text) : null;
    if (assignmentShapeError) {
      throw new Error(`BrowseMD line ${statement.lineNumber}: ${assignmentShapeError}`);
    }
    const assignment = statement.kind === "command" ? parseBrowseMarkdownAssignment(statement.text) : null;
    const result = statement.kind === "javascript"
      ? await runBrowseMarkdownBrowseCommand(context, statement.text, index, statement.lineNumber)
      : assignment
        ? await runBrowseMarkdownPipeline(context, assignment.command, index, statement.lineNumber)
        : await runBrowseMarkdownPipeline(context, statement.text, index, statement.lineNumber);
    stderr += result.stderr;
    if (result.browseResultAction && context.activeThread) {
      await recordAutomaticBrowseResult(execution.transcripts, {
        action: result.browseResultAction,
        actionIndex: index,
        assetUrl: null,
        commandItemId: context.activeThread.commandItemId,
        detailOverride: result.browseResultDetail,
        result,
        session: scriptRequest.session ?? null,
        threadId: scriptRequest.threadId,
        turnId: context.activeThread.turnId,
      }).catch(() => undefined);
    }
    if (!result.ok) {
      return {
        durationMs: Date.now() - startedAt,
        error: result.error ?? `BrowseMD line ${statement.lineNumber} failed.`,
        exitCode: result.exitCode ?? 1,
        ok: false,
        stderr,
        stdout,
      };
    }
    if (assignment) {
      if (!BROWSE_MARKDOWN_VARIABLE_PATTERN.test(assignment.name)) {
        throw new Error(`Invalid BrowseMD variable name: ${assignment.name}`);
      }
      setBrowseMarkdownVariable(context.variables, assignment.name, result.stdout);
    } else if (!result.outputRedirected) {
      stdout += result.stdout;
    }
  }
  return {
    durationMs: Date.now() - startedAt,
    exitCode: 0,
    ok: true,
    stderr,
    stdout,
  };
}

function hasBrowseFlag(args: readonly string[], flag: string) {
  return args.some((arg) => arg === flag);
}

function hasBrowseHelpFlag(args: readonly string[]) {
  return args.some((arg) => arg === "--help" || arg === "-h");
}

function getUnsupportedBrowseHelpError() {
  return "Browse endpoint help mode is not supported. Use the /browse skill instructions as the Workbench Browse contract.";
}

function getRawBrowseArgsError(args: readonly string[]) {
  const command = args[0]?.toLowerCase() ?? "";
  if (hasBrowseHelpFlag(args)) {
    return getUnsupportedBrowseHelpError();
  }
  if (command === "snapshot" && args.some((arg, index) => index > 0 && arg.toLowerCase() === "compact")) {
    return "Raw Browse args use CLI flags: use `snapshot --compact`. BrowseMD scripts also support `snapshot --compact`; bare `snapshot compact` is only kept as a BrowseMD compatibility alias.";
  }
  return null;
}

function normalizeScreenshotSteerArgs(args: readonly string[]) {
  if (args[0] !== "screenshot") {
    throw new Error("Screenshots can only be captured through the browse screenshot command.");
  }
  if (hasBrowseFlag(args, "--path") || hasBrowseFlag(args, "-p")) {
    throw new Error("Workbench Browse screenshots are steered into the thread and do not allow --path.");
  }
  return hasBrowseFlag(args, "--base64")
    ? [...args]
    : [...args, "--base64"];
}

async function runBrowseCommand(request: WorkbenchBrowseCommandRequest, signal: AbortSignal): Promise<WorkbenchBrowseCommandResponse> {
  return await browseCli.run(request, signal);
}

interface ScreenshotImagePayload {
  mimeType: string;
  payload: string;
}

interface StoredScreenshotAsset {
  assetUrl: string;
}

function parseScreenshotBase64(stdout: string): ScreenshotImagePayload {
  const parsed = JSON.parse(stdout) as unknown;
  if (!isRecord(parsed) || typeof parsed.base64 !== "string") {
    throw new Error("Browse screenshot output did not contain a base64 image payload.");
  }
  const base64 = parsed.base64.trim();
  const dataUrlMatch = BROWSE_SCREENSHOT_DATA_URL_PATTERN.exec(base64);
  if (dataUrlMatch) {
    const [, mimeType, payload] = dataUrlMatch;
    return { mimeType, payload };
  }
  if (!BROWSE_SCREENSHOT_BASE64_PATTERN.test(base64)) {
    throw new Error("Browse screenshot output was not valid base64 image data.");
  }
  return { mimeType: "image/png", payload: base64 };
}

function createScreenshotDataUrl(image: ScreenshotImagePayload) {
  return `data:${image.mimeType};base64,${image.payload.replace(/\s+/gu, "")}`;
}

function extensionForScreenshotMimeType(mimeType: string) {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return null;
  }
}

async function writeScreenshotTranscriptAsset(threadId: string, image: ScreenshotImagePayload) {
  const extension = extensionForScreenshotMimeType(image.mimeType);
  if (!extension) {
    throw new Error(`Unsupported screenshot image type: ${image.mimeType}.`);
  }

  const bytes = Buffer.from(image.payload.replace(/\s+/gu, ""), "base64");
  if (!bytes.length) {
    throw new Error("Browse screenshot output was empty.");
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  const fileName = `${digest}.${extension}`;
  const assetsDirectoryPath = path.join(projectRoot, ".workbench", "transcripts", "codex", "threads", threadId, "assets");
  const assetPath = path.join(assetsDirectoryPath, fileName);
  await fs.mkdir(assetsDirectoryPath, { recursive: true });
  await fs.writeFile(assetPath, bytes, { flag: "wx" }).catch((error) => {
    if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
      throw error;
    }
  });

  return `/api/transcript-assets/codex/${encodeURIComponent(threadId)}/${encodeURIComponent(fileName)}`;
}

async function captureBrowseSessionScreenshotAsset(
  request: WorkbenchBrowseCommandRequest,
  signal: AbortSignal,
): Promise<StoredScreenshotAsset | null> {
  const sessionIndex = request.args.findIndex((arg) => arg === "--session");
  const session = sessionIndex >= 0 ? request.args[sessionIndex + 1] : "";
  if (!session) {
    return null;
  }

  const screenshotResult = await runBrowseCommand({
    args: ["screenshot", "--base64", "--session", session],
    cwd: request.cwd ?? null,
    projectId: request.projectId ?? null,
    threadId: request.threadId,
    timeoutMs: request.timeoutMs ?? null,
  }, signal);
  if (!screenshotResult.ok) {
    return null;
  }

  const image = parseScreenshotBase64(screenshotResult.stdout);
  return {
    assetUrl: await writeScreenshotTranscriptAsset(request.threadId, image),
  };
}

async function steerScreenshotAsset(
  transcripts: WorkbenchBrowseTranscriptAdapter,
  threadId: string,
  steerImageUrl: string,
) {
  const activeThread = await transcripts.readActiveThread(threadId, true);
  if (!activeThread) {
    throw new Error("Unable to steer screenshot because the target thread has no active turn.");
  }
  const input = [
    { type: "text" as const, text: createAgentScreenshotSteerText(), text_elements: [] },
    { type: "image" as const, url: steerImageUrl },
  ];
  return await transcripts.steerScreenshot(activeThread.harness, threadId, activeThread.turnId, input);
}

function shouldSteerScreenshot(args: readonly string[]) {
  return args[0] === "screenshot";
}

async function runBrowseCommandAndMaybeSteerScreenshot(
  execution: WorkbenchBrowseExecutionContext,
  payload: WorkbenchBrowseCommandRequest,
) {
  const shouldSteer = shouldSteerScreenshot(payload.args);
  const commandPayload = shouldSteer
    ? { ...payload, args: normalizeScreenshotSteerArgs(payload.args) }
    : payload;
  const result = await runBrowseCommand(commandPayload, execution.signal);
  if (!shouldSteer || !result.ok) {
    return result;
  }

  const image = parseScreenshotBase64(result.stdout);
  await writeScreenshotTranscriptAsset(payload.threadId, image);
  const steerTurnId = await steerScreenshotAsset(execution.transcripts, payload.threadId, createScreenshotDataUrl(image));
  return {
    ...result,
    stdout: JSON.stringify({
      screenshot: "captured",
      steered: true,
    }, null, 2),
    steered: true,
    steerTurnId,
  };
}

function shouldAutoCaptureScreenshot(action: WorkbenchBrowseAgentAction["action"]) {
  return action === "open"
    || action === "click"
    || action === "cursor"
    || action === "fill"
    || action === "type"
    || action === "key"
    || action === "mouseClick"
    || action === "mouseDrag"
    || action === "mouseHover"
    || action === "mouseScroll"
    || action === "select"
    || action === "wait"
    || action === "back"
    || action === "eval"
    || action === "forward"
    || action === "highlight"
    || action === "reload"
    || action === "viewport";
}

function truncateBrowseResultDetail(value: string) {
  const trimmedValue = value.trim();
  return trimmedValue.length > 4000 ? `${trimmedValue.slice(0, 3997)}...` : trimmedValue;
}

function getBrowseResultDetail(result: WorkbenchBrowseAgentResponse) {
  if (!result.ok) {
    return {
      detailKind: "error",
      detailLabel: result.error ? "Error" : "stderr",
      detailText: truncateBrowseResultDetail(result.error || result.stderr || "Browse command failed."),
    } as const;
  }

  if (result.stdout.trim()) {
    return {
      detailKind: "result",
      detailLabel: "stdout",
      detailText: truncateBrowseResultDetail(result.stdout),
    } as const;
  }

  if (result.stderr.trim()) {
    return {
      detailKind: "text",
      detailLabel: "stderr",
      detailText: truncateBrowseResultDetail(result.stderr),
    } as const;
  }

  return {
    detailKind: null,
    detailLabel: null,
    detailText: null,
  };
}

interface BrowseResultDetailInput {
  detailKind: WorkbenchBrowseResultEntryDetailKind | null;
  detailLabel: string | null;
  detailText: string | null;
}

async function recordAutomaticBrowseResult(
  transcripts: WorkbenchBrowseTranscriptAdapter,
  {
    action,
    actionIndex,
    commandItemId,
    result,
    session,
    threadId,
    turnId,
    assetUrl,
    detailOverride,
  }: {
    action: WorkbenchBrowseAgentAction["action"] | string;
    actionIndex: number;
    result: WorkbenchBrowseAgentResponse;
    commandItemId: string | null;
    session: string | null;
    threadId: string;
    turnId: string;
    assetUrl: string | null;
    detailOverride?: BrowseResultDetailInput | null;
  },
) {
  const detail = result.ok && detailOverride ? detailOverride : getBrowseResultDetail(result);
  await transcripts.recordResult({
      action,
      actionIndex,
      assetUrl,
      commandItemId,
      detailKind: detail.detailKind,
      detailLabel: detail.detailLabel,
      detailText: detail.detailText,
      durationMs: result.durationMs,
      entryKey: createHash("sha256")
        .update([threadId, turnId, commandItemId ?? "", session ?? "", action, String(actionIndex)].join("\0"))
        .digest("hex"),
      recordedAt: Date.now(),
      session,
      state: result.ok ? "completed" : "failed",
      threadId,
      turnId,
  });
}

async function runBrowseAgentCommand(
  execution: WorkbenchBrowseExecutionContext,
  payload: WorkbenchBrowseAgentAction,
  { actionIndex = 0 }: { actionIndex?: number } = {},
): Promise<WorkbenchBrowseAgentResponse> {
  const startedAt = Date.now();
  if (payload.action === "sessions") {
    const listResponse = await browseSessionController.listSessions({
      cwd: payload.cwd ?? null,
      includeRuntime: payload.includeRuntime,
      projectId: payload.projectId ?? null,
      threadId: null,
      timeoutMs: payload.timeoutMs ?? null,
    }, execution.signal);
    return {
      action: "sessions",
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      ok: true,
      stderr: "",
      stdout: JSON.stringify(listResponse, null, 2),
    };
  }

  const normalized = normalizeWorkbenchBrowseAgentRequest(payload);
  if (normalized.ok === false) {
    return {
      durationMs: Date.now() - startedAt,
      error: normalized.error,
      exitCode: null,
      ok: false,
      stderr: "",
      stdout: "",
    };
  }

  if (normalized.command.action === "cleanup") {
    void startedAt;
    return await browseSessionController.cleanupThreadSessions(normalized.command, execution.signal);
  }

  if (normalized.command.action === "forget") {
    const activeThread = await execution.transcripts.readActiveThread(normalized.command.threadId, false);
    const result = await browseSessionController.forgetPersistentSession(normalized.command, execution.signal);
    if (activeThread) {
      await recordAutomaticBrowseResult(execution.transcripts, {
        action: "forget",
        actionIndex,
        assetUrl: null,
        commandItemId: activeThread.commandItemId,
        result,
        session: normalized.command.session,
        threadId: normalized.command.threadId,
        turnId: activeThread.turnId,
      }).catch(() => undefined);
    }
    return result;
  }

  const executionContext = await browseCli.resolveExecutionContext(normalized.command.commandRequest);
  const activeThread = await execution.transcripts.readActiveThread(normalized.command.commandRequest.threadId, false);
  const result = await runBrowseCommandAndMaybeSteerScreenshot(execution, normalized.command.commandRequest);
  const autoScreenshot = result.ok && normalized.command.session && shouldAutoCaptureScreenshot(normalized.command.action)
    ? await captureBrowseSessionScreenshotAsset(normalized.command.commandRequest, execution.signal).catch(() => null)
    : null;
  if (activeThread) {
    await recordAutomaticBrowseResult(execution.transcripts, {
      action: normalized.command.action,
      actionIndex,
      assetUrl: autoScreenshot?.assetUrl ?? result.assetUrl ?? null,
      commandItemId: activeThread.commandItemId,
      result,
      session: normalized.command.session ?? null,
      threadId: normalized.command.commandRequest.threadId,
      turnId: activeThread.turnId,
    }).catch(() => undefined);
  }
  if (result.ok && normalized.command.session) {
    if (normalized.command.action === "stop") {
      await browseSessionController.forgetSession(normalized.command.session);
    } else {
      await browseSessionController.rememberSession({
        cwd: executionContext.cwd,
        mode: normalized.command.mode,
        name: normalized.command.session,
        projectId: executionContext.projectId,
        projectRootPath: executionContext.projectRootPath,
        threadId: normalized.command.commandRequest.threadId,
      });
    }
  }

  return {
    ...result,
    action: normalized.command.action,
    args: normalized.command.commandRequest.args,
    session: normalized.command.session ?? undefined,
  };
}

async function runBrowseAgentCommandSequence(
  execution: WorkbenchBrowseExecutionContext,
  payload: WorkbenchBrowseAgentSequenceRequest,
  {
    emitProgress,
  }: {
    emitProgress?: (event: WorkbenchBrowseAgentSequenceProgressEvent) => void;
  } = {},
): Promise<WorkbenchBrowseAgentSequenceResponse> {
  const startedAt = Date.now();
  const stopOnError = payload.stopOnError !== false;
  const results: WorkbenchBrowseAgentResponse[] = [];
  let stoppedAtIndex: number | null = null;

  emitProgress?.({
    startedAt,
    summary: payload.summary?.trim() || null,
    totalActions: payload.actions.length,
    type: "browse-sequence-start",
  });

  for (const [index, action] of payload.actions.entries()) {
    emitProgress?.({
      action: action.action,
      index,
      session: "session" in action ? action.session ?? null : null,
      startedAt: Date.now(),
      type: "browse-action-start",
    });
    if (execution.signal.aborted) {
      throw execution.signal.reason;
    }
    const result = await runBrowseAgentCommand(execution, action, { actionIndex: index });
    results.push(result);
    emitProgress?.({
      action: result.action ?? action.action,
      index,
      result,
      type: "browse-action-complete",
    });
    if (!result.ok && stopOnError) {
      stoppedAtIndex = index;
      break;
    }
  }

  const ok = results.length === payload.actions.length && results.every((result) => result.ok);
  const sequenceResponse = {
    durationMs: Date.now() - startedAt,
    error: ok ? undefined : results.find((result) => !result.ok)?.error ?? "A Browse action failed.",
    ok,
    results,
    stoppedAtIndex,
  };
  emitProgress?.({
    ...sequenceResponse,
    type: "browse-sequence-complete",
  });
  return sequenceResponse;
}

export default class WorkbenchBrowseRequestHandler {
  private readonly transcripts: WorkbenchBrowseTranscriptAdapter;

  constructor(transcripts: WorkbenchBrowseTranscriptAdapter) {
    this.transcripts = transcripts;
  }

  async handle(body: Buffer, signal: AbortSignal, runSerialized: WorkbenchBrowseSerializedRunner) {
    const startedAt = Date.now();
    const execution: WorkbenchBrowseExecutionContext = { signal, transcripts: this.transcripts };
    try {
    const requestBody = (() => {
      try {
        return JSON.parse(body.toString("utf8")) as unknown;
      } catch {
        return null;
      }
    })();
    if (isRecord(requestBody) && ("script" in requestBody || "scriptPath" in requestBody)) {
      const scriptRequest = normalizeBrowseMarkdownRequest(requestBody);
      if (!scriptRequest) {
        return browseCommandResponse({
          durationMs: Date.now() - startedAt,
          exitCode: null,
          error: "A valid BrowseMD request requires exactly one of script or scriptPath, plus cwd and threadId.",
          ok: false,
          stderr: "",
          stdout: "",
        }, { status: 400 });
      }

      try {
        return browseCommandResponse(await runSerialized(async () => await runBrowseMarkdownRequest(execution, scriptRequest)));
      } catch (error) {
        return browseCommandResponse({
          durationMs: Date.now() - startedAt,
          exitCode: null,
          error: error instanceof Error ? error.message : "Unable to compile BrowseMD script.",
          ok: false,
          stderr: "",
          stdout: "",
        }, { status: 400 });
      }
    }

    if (isRecord(requestBody) && Array.isArray(requestBody.actions)) {
      if (requestBody.actions.length > MAX_BROWSE_AGENT_SEQUENCE_ACTIONS) {
        return browseAgentSequenceResponse({
          durationMs: Date.now() - startedAt,
          error: `Browse action sequences can include at most ${MAX_BROWSE_AGENT_SEQUENCE_ACTIONS} actions.`,
          ok: false,
          results: [],
          stoppedAtIndex: null,
        }, { status: 400 });
      }

      const sequenceRequest = {
        actions: requestBody.actions as WorkbenchBrowseAgentAction[],
        streamProgress: requestBody.streamProgress === true,
        summary: normalizeString(requestBody.summary) || null,
        stopOnError: requestBody.stopOnError === false ? false : true,
      } satisfies WorkbenchBrowseAgentSequenceRequest;
      if (sequenceRequest.streamProgress) {
        return browseAgentSequenceProgressResponse(async (emitProgress) => {
          await runSerialized(async () => {
            await runBrowseAgentCommandSequence(execution, sequenceRequest, { emitProgress });
          });
        });
      }

      return browseAgentSequenceResponse(await runSerialized(async () => await runBrowseAgentCommandSequence(execution, sequenceRequest)));
    }

    if (Array.isArray(requestBody)) {
      if (requestBody.length > MAX_BROWSE_AGENT_SEQUENCE_ACTIONS) {
        return browseAgentSequenceResponse({
          durationMs: Date.now() - startedAt,
          error: `Browse action sequences can include at most ${MAX_BROWSE_AGENT_SEQUENCE_ACTIONS} actions.`,
          ok: false,
          results: [],
          stoppedAtIndex: null,
        }, { status: 400 });
      }

      return browseAgentSequenceResponse(await runSerialized(async () => await runBrowseAgentCommandSequence(execution, {
        actions: requestBody as WorkbenchBrowseAgentAction[],
        streamProgress: false,
        stopOnError: true,
      })));
    }

    if (isRecord(requestBody) && typeof requestBody.action === "string") {
      return browseCommandResponse(await runSerialized(async () => await runBrowseAgentCommand(execution, requestBody as unknown as WorkbenchBrowseAgentAction)));
    }

    const payload = normalizeBrowseRequest(requestBody);
    if (!payload) {
      return browseCommandResponse({
        durationMs: Date.now() - startedAt,
        error: "A valid browse command request is required.",
        exitCode: null,
        ok: false,
        stderr: "",
        stdout: "",
      }, { status: 400 });
    }

    const rawArgsError = getRawBrowseArgsError(payload.args);
    if (rawArgsError) {
      return browseCommandResponse({
        durationMs: Date.now() - startedAt,
        error: rawArgsError,
        exitCode: null,
        ok: false,
        stderr: "",
        stdout: "",
      }, { status: 400 });
    }

    const settings = new WorkbenchServerSettings();
    const localCapabilities = await settings.readLocalCapabilities();
    if (!localCapabilities.browseRawCommandsEnabled) {
      return browseCommandResponse({
        disabled: true,
        durationMs: Date.now() - startedAt,
        error: "Raw Browse CLI-args passthrough is disabled. Use typed Browse API actions, or ask the user to enable raw Browse commands in Workbench Settings before sending raw args.",
        exitCode: null,
        ok: false,
        stderr: "",
        stdout: "",
      }, { status: 403 });
    }

      return browseCommandResponse(await runSerialized(async () => await runBrowseCommandAndMaybeSteerScreenshot(execution, payload)));
    } catch (error) {
      return browseCommandResponse({
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unable to run browse command.",
        exitCode: null,
        ok: false,
        stderr: "",
        stdout: "",
      }, { status: 400 });
    }
  }

  async findStaleInactiveSessionStops(options: Parameters<WorkbenchBrowseSessionController["findStaleInactiveSessionStops"]>[0]) {
    return await browseSessionController.findStaleInactiveSessionStops(options);
  }

  async listSessions(request: WorkbenchBrowseSessionListRequest, signal?: AbortSignal): Promise<WorkbenchBrowseSessionListResponse> {
    return await browseSessionController.listSessions(request, signal);
  }

  async controlSession(request: WorkbenchBrowseSessionControlRequest, signal?: AbortSignal): Promise<WorkbenchBrowseSessionControlResponse> {
    return request.action === "forget"
      ? await browseSessionController.stopSession({ ...request, action: "forget" }, signal)
      : await browseSessionController.stopSession(request, signal);
  }
}
