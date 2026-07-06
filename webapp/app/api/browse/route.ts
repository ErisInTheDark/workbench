/*
 * Exports:
 * - runtime/dynamic: force raw browse command execution onto the Node.js runtime without static caching. Keywords: browse, api, command, node runtime.
 * - POST: run typed Workbench Browse actions, action sequences, or raw project-local browse CLI arguments and optionally steer completed screenshots into the active Codex turn. Keywords: browse, typed action, sequence, raw command, local capability, screenshot, steer.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { CodexAppServerClient } from "../../../lib/codex/app-server-client";
import {
  DEFAULT_CODEX_APP_SERVER_URL,
  getCodexAppServerUrl,
} from "../../../lib/codex/config";
import { sendServerWorkbenchBridgeRequest } from "../../../lib/codex/server-bridge";
import type { ThreadReadResponse } from "../../../lib/codex/generated/app-server/v2/ThreadReadResponse";
import type { TurnSteerResponse } from "../../../lib/codex/generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "../../../lib/codex/generated/app-server/v2/UserInput";
import { getCurrentInProgressTurn, hasThreadActiveFlag } from "../../../lib/codex/thread-state";
import { isCodexJsonRpcFailure } from "../../../lib/codex/protocol";
import { appRoot, resolveProjectRoot } from "../../../lib/project";
import { projectRoot } from "../../../lib/project";
import type {
  WorkbenchBrowseAgentAction,
  WorkbenchBrowseAgentResponse,
  WorkbenchBrowseAgentSequenceRequest,
  WorkbenchBrowseAgentSequenceProgressEvent,
  WorkbenchBrowseAgentSequenceResponse,
  WorkbenchBrowseCommandRequest,
  WorkbenchBrowseCommandResponse,
  WorkbenchHarness,
} from "../../../lib/types";
import WorkbenchBrowseSessionRegistry from "../../../lib/workbench/browse/WorkbenchBrowseSessionRegistry";
import { normalizeWorkbenchBrowseAgentRequest } from "../../../lib/workbench/browse/browse-agent-requests";
import { resolveAgentEndpointProjectFromCwd } from "../../../lib/workbench/project/agent-endpoint-project";
import WorkbenchServerSettings from "../../../lib/workbench/settings/WorkbenchServerSettings";
import { createAgentScreenshotSteerText } from "../../../lib/workbench/thread/thread-steer-markers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_BROWSE_TIMEOUT_MS = 120_000;
const MAX_BROWSE_TIMEOUT_MS = 10 * 60_000;
const MAX_BROWSE_ARGS = 128;
const MAX_BROWSE_ARG_LENGTH = 16_384;
const MAX_BROWSE_STDIN_LENGTH = 2 * 1024 * 1024;
const MAX_BROWSE_AGENT_SEQUENCE_ACTIONS = 50;
const BROWSE_SCREENSHOT_ASSET_THREAD_PATTERN = /^[A-Za-z0-9_-]+$/u;
const BROWSE_SCREENSHOT_DATA_URL_PATTERN = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([a-z0-9+/=\s]+)$/iu;
const BROWSE_SCREENSHOT_BASE64_PATTERN = /^[a-z0-9+/=\s]+$/iu;
const BROWSE_SESSION_CLEANUP_POLL_MS = 3 * 60_000;
const BROWSE_SESSION_INACTIVE_CLEANUP_MS = 30 * 60_000;
const VALID_HARNESSES: readonly WorkbenchHarness[] = ["codex", "copilot", "opencode"];
let browseCleanupPoller: NodeJS.Timeout | null = null;
let browseCleanupPollInFlight = false;

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

function browseCommandResponse(payload: WorkbenchBrowseCommandResponse, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

function browseAgentSequenceResponse(payload: WorkbenchBrowseAgentSequenceResponse, init?: ResponseInit) {
  return NextResponse.json(payload, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...init?.headers,
    },
  });
}

function browseAgentSequenceProgressResponse(
  runSequence: (emitProgress: (event: WorkbenchBrowseAgentSequenceProgressEvent) => void) => Promise<void>,
) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    async start(controller) {
      const emitProgress = (event: WorkbenchBrowseAgentSequenceProgressEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        await runSequence(emitProgress);
      } catch (error) {
        emitProgress({
          durationMs: 0,
          ok: false,
          results: [{
            durationMs: 0,
            error: error instanceof Error ? error.message : "Unable to run Browse sequence.",
            exitCode: null,
            ok: false,
            stderr: "",
            stdout: "",
          }],
          stoppedAtIndex: null,
          type: "browse-sequence-complete",
        });
      } finally {
        controller.close();
      }
    },
  }), {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/x-ndjson; charset=utf-8",
    },
  });
}

async function resolveBrowseEntrypoint() {
  const entrypoint = path.join(appRoot, "lib", "workbench", "browse", "run-browse-cli.mjs");
  const browseEntrypoint = path.join(appRoot, "node_modules", "browse", "bin", "run.js");
  try {
    await fs.access(entrypoint);
    await fs.access(browseEntrypoint);
  } catch {
    throw new Error("The project-local browse CLI entrypoint was not found. Install the browse dependency in webapp before using /api/browse.");
  }
  return entrypoint;
}

async function resolveBrowseCwd(request: WorkbenchBrowseCommandRequest) {
  if (request.cwd) {
    return (await resolveAgentEndpointProjectFromCwd(request.cwd, { endpointName: "Browse" })).cwd;
  }

  return path.resolve((await resolveProjectRoot(request.projectId)).root);
}

function hasBrowseFlag(args: readonly string[], flag: string) {
  return args.some((arg) => arg === flag);
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

async function runBrowseCommand(request: WorkbenchBrowseCommandRequest): Promise<WorkbenchBrowseCommandResponse> {
  const startedAt = Date.now();
  const browseEntrypoint = await resolveBrowseEntrypoint();
  const cwd = await resolveBrowseCwd(request);
  const timeoutMs = request.timeoutMs ?? DEFAULT_BROWSE_TIMEOUT_MS;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [browseEntrypoint, ...request.args], {
      cwd,
      env: {
        ...process.env,
        BROWSERBASE_TELEMETRY_DISABLED: "1",
        BROWSE_DISABLE_UPDATE_CHECK: "1",
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        durationMs: Date.now() - startedAt,
        error: error.message,
        exitCode: null,
        ok: false,
        stderr,
        stdout,
        timedOut,
      });
    });
    child.once("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        durationMs: Date.now() - startedAt,
        error: timedOut ? `browse command timed out after ${timeoutMs}ms.` : undefined,
        exitCode,
        ok: exitCode === 0 && !timedOut,
        stderr,
        stdout,
        timedOut: timedOut || undefined,
      });
    });

    if (request.stdin) {
      child.stdin.end(request.stdin);
    } else {
      child.stdin.end();
    }
  });
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
  });
  if (!screenshotResult.ok) {
    return null;
  }

  const image = parseScreenshotBase64(screenshotResult.stdout);
  return {
    assetUrl: await writeScreenshotTranscriptAsset(request.threadId, image),
  };
}

function findLatestBrowseCommandItemId(response: ThreadReadResponse) {
  const turn = getCurrentInProgressTurn(response.thread) ?? response.thread.turns.at(-1) ?? null;
  if (!turn) {
    return null;
  }

  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (
      item.type === "commandExecution"
      && item.status === "inProgress"
      && item.command.includes("/api/browse")
    ) {
      return item.id;
    }
  }

  return null;
}

function getCurrentInProgressTurnId(response: ThreadReadResponse) {
  return getCurrentInProgressTurn(response.thread)?.id ?? null;
}

function getAutomaticBrowseScreenshotTurnId(response: ThreadReadResponse) {
  return getCurrentInProgressTurn(response.thread)?.id ?? response.thread.turns.at(-1)?.id ?? null;
}

async function readActiveThreadForScreenshot(request: NextRequest, threadId: string) {
  let lastError: unknown = null;
  for (const harness of VALID_HARNESSES) {
    try {
      const response = await sendServerWorkbenchBridgeRequest<ThreadReadResponse>(request, harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId,
        },
        workbenchThreadHydration: { mode: "latest" },
      });
      const turnId = getCurrentInProgressTurnId(response);
      if (turnId) {
        return { commandItemId: findLatestBrowseCommandItemId(response), harness, turnId };
      }
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Unable to steer screenshot because the target thread has no active turn. Last thread lookup error: ${lastError.message}`);
  }
  throw new Error("Unable to steer screenshot because the target thread has no active turn.");
}

async function readThreadForAutomaticBrowseScreenshot(request: NextRequest, threadId: string) {
  for (const harness of VALID_HARNESSES) {
    try {
      const response = await sendServerWorkbenchBridgeRequest<ThreadReadResponse>(request, harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId,
        },
        workbenchThreadHydration: { mode: "latest" },
      });
      const turnId = getAutomaticBrowseScreenshotTurnId(response);
      if (turnId) {
        return { commandItemId: findLatestBrowseCommandItemId(response), harness, turnId };
      }
    } catch {
      // Try the next harness; automatic screenshots are best-effort transcript metadata.
    }
  }

  return null;
}

async function steerScreenshotAsset(
  request: NextRequest,
  threadId: string,
  steerImageUrl: string,
) {
  const { harness, turnId } = await readActiveThreadForScreenshot(request, threadId);
  const input: UserInput[] = [
    { type: "text" as const, text: createAgentScreenshotSteerText(), text_elements: [] },
    { type: "image" as const, url: steerImageUrl },
  ];
  const response = await sendServerWorkbenchBridgeRequest<TurnSteerResponse>(request, harness, {
    method: "turn/steer",
    params: {
      expectedTurnId: turnId,
      input,
      threadId,
    },
  });

  return response.turnId || turnId;
}

function shouldSteerScreenshot(args: readonly string[]) {
  return args[0] === "screenshot";
}

async function runBrowseCommandAndMaybeSteerScreenshot(
  request: NextRequest,
  payload: WorkbenchBrowseCommandRequest,
) {
  const shouldSteer = shouldSteerScreenshot(payload.args);
  const commandPayload = shouldSteer
    ? { ...payload, args: normalizeScreenshotSteerArgs(payload.args) }
    : payload;
  const result = await runBrowseCommand(commandPayload);
  if (!shouldSteer || !result.ok) {
    return result;
  }

  const image = parseScreenshotBase64(result.stdout);
  await writeScreenshotTranscriptAsset(payload.threadId, image);
  const steerTurnId = await steerScreenshotAsset(request, payload.threadId, createScreenshotDataUrl(image));
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
    || action === "fill"
    || action === "type"
    || action === "key"
    || action === "select"
    || action === "wait"
    || action === "back"
    || action === "eval"
    || action === "forward"
    || action === "highlight"
    || action === "reload"
    || action === "viewport";
}

async function recordAutomaticBrowseScreenshot(
  request: NextRequest,
  {
    action,
    actionIndex,
    commandItemId,
    session,
    threadId,
    turnId,
    assetUrl,
  }: {
    action: WorkbenchBrowseAgentAction["action"];
    actionIndex: number;
    commandItemId: string | null;
    session: string;
    threadId: string;
    turnId: string;
    assetUrl: string;
  },
) {
  await sendServerWorkbenchBridgeRequest(request, "codex", {
    method: "browse/screenshot/record",
    params: {
      action,
      actionIndex,
      assetUrl,
      commandItemId,
      entryKey: createHash("sha256")
        .update([threadId, turnId, commandItemId ?? "", session, action, String(actionIndex), assetUrl].join("\0"))
        .digest("hex"),
      recordedAt: Date.now(),
      session,
      threadId,
      turnId,
    },
  });
}

async function runBrowseAgentCommand(
  request: NextRequest,
  payload: WorkbenchBrowseAgentAction,
  { actionIndex = 0 }: { actionIndex?: number } = {},
): Promise<WorkbenchBrowseAgentResponse> {
  const startedAt = Date.now();
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

  const registry = new WorkbenchBrowseSessionRegistry();
  if (normalized.command.action === "cleanup") {
    return runBrowseAgentCleanupCommand(normalized.command, registry, startedAt);
  }

  const activeThread = shouldAutoCaptureScreenshot(normalized.command.action)
    ? await readThreadForAutomaticBrowseScreenshot(request, normalized.command.commandRequest.threadId)
    : null;
  const result = await runBrowseCommandAndMaybeSteerScreenshot(request, normalized.command.commandRequest);
  if (result.ok && activeThread && normalized.command.session && shouldAutoCaptureScreenshot(normalized.command.action)) {
    const autoScreenshot = await captureBrowseSessionScreenshotAsset(normalized.command.commandRequest).catch(() => null);
    if (autoScreenshot) {
      await recordAutomaticBrowseScreenshot(request, {
        action: normalized.command.action,
        actionIndex,
        assetUrl: autoScreenshot.assetUrl,
        commandItemId: activeThread.commandItemId,
        session: normalized.command.session,
        threadId: normalized.command.commandRequest.threadId,
        turnId: activeThread.turnId,
      }).catch(() => undefined);
    }
  }
  if (result.ok && normalized.command.session) {
    if (normalized.command.action === "stop") {
      await registry.forget(normalized.command.session);
    } else {
      await registry.remember({
        mode: normalized.command.mode,
        name: normalized.command.session,
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
  request: NextRequest,
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
    const result = await runBrowseAgentCommand(request, action, { actionIndex: index });
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

async function runBrowseAgentCleanupCommand(
  command: {
    action: "cleanup";
    cwd?: string | null;
    force: boolean;
    projectId?: string | null;
    sessions: string[] | null;
    threadId: string;
    timeoutMs?: number | null;
  },
  registry: WorkbenchBrowseSessionRegistry,
  startedAt: number,
): Promise<WorkbenchBrowseAgentResponse> {
  const registeredSessions = command.sessions ?? (await registry.list())
    .filter((session) => session.threadId === command.threadId)
    .map((session) => session.name);
  const sessions = [...new Set(registeredSessions)];
  const cleanupResults: WorkbenchBrowseCommandResponse[] = [];

  for (const session of sessions) {
    const args = ["stop", "--session", session];
    if (command.force) {
      args.push("--force");
    }
    const result = await runBrowseCommand({
      args,
      cwd: command.cwd ?? null,
      projectId: command.projectId ?? null,
      threadId: command.threadId,
      timeoutMs: command.timeoutMs ?? null,
    });
    cleanupResults.push(result);
    if (result.ok) {
      await registry.forget(session);
    }
  }

  const ok = cleanupResults.every((result) => result.ok);
  return {
    action: "cleanup",
    cleanupResults,
    durationMs: Date.now() - startedAt,
    exitCode: ok ? 0 : null,
    ok,
    stderr: cleanupResults.map((result) => result.stderr).filter(Boolean).join("\n"),
    stdout: JSON.stringify({
      cleanedSessions: cleanupResults.filter((result) => result.ok).length,
      sessions,
    }, null, 2),
  };
}

function normalizeWebSocketUrl(url: string) {
  const parsedUrl = new URL(url);
  parsedUrl.pathname = "";
  parsedUrl.search = "";
  parsedUrl.hash = "";
  return parsedUrl.toString().replace(/\/$/u, "");
}

function getBackgroundBridgeUrls() {
  return Array.from(new Set([
    getCodexAppServerUrl().replace("://0.0.0.0", "://127.0.0.1"),
    DEFAULT_CODEX_APP_SERVER_URL,
  ].map(normalizeWebSocketUrl)));
}

async function sendBackgroundBridgeRequest<TResponse>(
  harness: WorkbenchHarness,
  bridgeRequest: { id?: number; method: string; params?: unknown } & Record<string, unknown>,
) {
  let lastError: unknown = null;
  for (const candidateUrl of getBackgroundBridgeUrls()) {
    const client = new CodexAppServerClient();
    try {
      await client.connect(candidateUrl);
      const response = await client.sendRequest<TResponse>({
        ...bridgeRequest,
        workbenchHarness: harness,
      });
      if (isCodexJsonRpcFailure(response)) {
        const detail = response.error.data ? ` ${JSON.stringify(response.error.data)}` : "";
        throw new Error(`${response.error.message}${detail}`);
      }

      client.close();
      return response.result;
    } catch (error) {
      lastError = error;
      client.close();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Unable to reach the local Codex bridge.");
}

function isThreadActiveForBrowseCleanup(thread: ThreadReadResponse["thread"]) {
  return getCurrentInProgressTurn(thread) !== null
    || hasThreadActiveFlag(thread.status, "waitingOnUserInput")
    || hasThreadActiveFlag(thread.status, "waitingOnApproval");
}

async function readThreadActiveForBrowseCleanup(threadId: string) {
  for (const harness of VALID_HARNESSES) {
    try {
      const response = await sendBackgroundBridgeRequest<ThreadReadResponse>(harness, {
        method: "thread/read",
        params: {
          includeTurns: true,
          threadId,
        },
        workbenchThreadHydration: { mode: "latest" },
      });
      return isThreadActiveForBrowseCleanup(response.thread);
    } catch {
      // Try the next harness; preserve sessions if no harness can read the thread.
    }
  }

  return null;
}

async function pollBrowseSessionCleanup() {
  if (browseCleanupPollInFlight) {
    return;
  }

  browseCleanupPollInFlight = true;
  try {
    const registry = new WorkbenchBrowseSessionRegistry();
    const threadIds = await registry.listOwnedThreadIds();
    for (const threadId of threadIds) {
      const active = await readThreadActiveForBrowseCleanup(threadId);
      if (active === null) {
        continue;
      }

      if (active) {
        await registry.markThreadActive(threadId);
      } else {
        await registry.markThreadInactive(threadId);
      }
    }

    const staleSessions = await registry.listStaleInactiveSessions({
      olderThanMs: BROWSE_SESSION_INACTIVE_CLEANUP_MS,
    });
    for (const session of staleSessions) {
      if (!session.threadId) {
        continue;
      }

      const result = await runBrowseCommand({
        args: ["stop", "--session", session.name, "--force"],
        cwd: null,
        projectId: null,
        threadId: session.threadId,
        timeoutMs: DEFAULT_BROWSE_TIMEOUT_MS,
      });
      if (result.ok) {
        await registry.forget(session.name);
      }
    }
  } finally {
    browseCleanupPollInFlight = false;
  }
}

function ensureBrowseSessionCleanupPoller() {
  if (browseCleanupPoller) {
    return;
  }

  browseCleanupPoller = setInterval(() => {
    void pollBrowseSessionCleanup().catch(() => {
      // Best-effort background cleanup must not disturb foreground Browse requests.
    });
  }, BROWSE_SESSION_CLEANUP_POLL_MS);
  browseCleanupPoller.unref?.();
  void pollBrowseSessionCleanup().catch(() => {
    // Best-effort background cleanup must not disturb foreground Browse requests.
  });
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  try {
    ensureBrowseSessionCleanupPoller();

    const requestBody = await request.json().catch(() => null);
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
          await runBrowseAgentCommandSequence(request, sequenceRequest, { emitProgress });
        });
      }

      return browseAgentSequenceResponse(await runBrowseAgentCommandSequence(request, sequenceRequest));
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

      return browseAgentSequenceResponse(await runBrowseAgentCommandSequence(request, {
        actions: requestBody as WorkbenchBrowseAgentAction[],
        streamProgress: false,
        stopOnError: true,
      }));
    }

    if (isRecord(requestBody) && typeof requestBody.action === "string") {
      return browseCommandResponse(await runBrowseAgentCommand(request, requestBody as unknown as WorkbenchBrowseAgentAction));
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

    return browseCommandResponse(await runBrowseCommandAndMaybeSteerScreenshot(request, payload));
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
