/*
 * Exports:
 * - requestCodexAppServer: open a typed WebSocket request against the local Codex app-server. Keywords: codex, websocket, json-rpc.
 * - toThreadSummary: normalize a raw thread into the workbench sidebar summary shape. Keywords: thread, summary, sidebar.
 * - renderThreadMarkdown: flatten a raw thread into markdown for legacy thread rendering. Keywords: thread, markdown, legacy.
 * - listCodexThreads: fetch recent Codex threads ordered by newest activity. Keywords: thread list, updated_at, ordering.
 * - readCodexThread: fetch a single Codex thread with turns for detailed rendering. Keywords: thread read, turns.
 * - resumeCodexThread: load a persisted Codex thread into the active app-server session. Keywords: thread, resume, loaded.
 * - sendCodexThreadMessage: continue an existing Codex thread with user inputs and return the refreshed thread. Keywords: thread, turn, steer, send, image.
 */
import type { ClientRequest } from "./generated/app-server/ClientRequest";
import type { Thread } from "./generated/app-server/v2/Thread";
import type { ThreadListResponse } from "./generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "./generated/app-server/v2/ThreadReadResponse";
import type { ThreadResumeResponse } from "./generated/app-server/v2/ThreadResumeResponse";
import type { TurnStartResponse } from "./generated/app-server/v2/TurnStartResponse";
import type { TurnSteerResponse } from "./generated/app-server/v2/TurnSteerResponse";
import type { UserInput } from "./generated/app-server/v2/UserInput";
import { isPathWithinRoot, projectRoot } from "../project";
import type { ThreadSummary } from "../types";
import { getCurrentInProgressTurn, getCurrentTurn } from "./thread-state";
import type {
  CodexAppServerNotification,
  CodexAppServerNotificationHandling,
} from "./app-server-notifications";
import {
  classifyCodexAppServerNotification,
  isCodexAppServerNotification,
} from "./app-server-notifications";
import {
  getCodexAppServerUrl,
} from "./config";
import {
  createTextInput,
  createInitializeCapabilities,
  createInitializeRequest,
  createInitializedNotification,
  isCodexJsonRpcFailure,
  isCodexJsonRpcSuccess,
} from "./protocol";

const APP_SERVER_TIMEOUT_MS = 5000;
const DEFAULT_TURN_REASONING_SUMMARY = "detailed" as const;

interface CodexServerError extends Error {
  detail?: string;
  phase?: "connect" | "initialize" | "request";
  status?: number;
}

interface RequestCodexAppServerOptions {
  onNotification?: (
    notification: CodexAppServerNotification,
    handling: CodexAppServerNotificationHandling,
  ) => void;
}

function createCodexServerError(
  message: string,
  {
    detail,
    phase,
    status,
  }: {
    detail?: string;
    phase?: "connect" | "initialize" | "request";
    status?: number;
  } = {},
) {
  const error = new Error(message) as CodexServerError;
  error.detail = detail;
  error.phase = phase;
  error.status = status;
  return error;
}

export async function requestCodexAppServer<TResponse>(
  request: Omit<ClientRequest, "id"> & { id?: number },
  options: RequestCodexAppServerOptions = {},
): Promise<TResponse> {
  const url = getCodexAppServerUrl();
  const initializeRequest = createInitializeRequest(0, {
    capabilities: createInitializeCapabilities({
      experimentalApi: true,
    }),
  });

  return await new Promise<TResponse>((resolve, reject) => {
    let settled = false;
    let initializeComplete = false;
    const requestId = request.id ?? 1;
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      settleReject(createCodexServerError(
        "Timed out waiting for the Codex app-server.",
        {
          detail: `No response received within ${APP_SERVER_TIMEOUT_MS}ms from ${url}.`,
          phase: initializeComplete ? "request" : "connect",
        },
      ));
    }, APP_SERVER_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close();
      } catch {}
    }

    function settleReject(error: Error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    }

    function settleResolve(value: TResponse) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(value);
    }

    socket.onopen = () => {
      socket.send(JSON.stringify(initializeRequest));
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));

        if (typeof message !== "object" || message === null || !("id" in message)) {
          if (isCodexAppServerNotification(message)) {
            options.onNotification?.(message, classifyCodexAppServerNotification(message));
          }
          return;
        }

        if (message.id === 0) {
          if (isCodexJsonRpcFailure(message)) {
            settleReject(createCodexServerError(
              "The Codex app-server rejected initialize.",
              {
                detail: message.error.data
                  ? `${message.error.message} (${JSON.stringify(message.error.data)})`
                  : message.error.message,
                phase: "initialize",
              },
            ));
            return;
          }

          if (isCodexJsonRpcSuccess(message)) {
            initializeComplete = true;
            socket.send(JSON.stringify(createInitializedNotification()));
            socket.send(JSON.stringify({
              ...request,
              id: requestId,
            }));
          }
          return;
        }

        if (message.id !== requestId) {
          return;
        }

        if (isCodexJsonRpcFailure(message)) {
          settleReject(createCodexServerError(
            "The Codex app-server request failed.",
            {
              detail: message.error.data
                ? `${message.error.message} (${JSON.stringify(message.error.data)})`
                : message.error.message,
              phase: "request",
            },
          ));
          return;
        }

        if (isCodexJsonRpcSuccess(message)) {
          settleResolve(message.result as TResponse);
        }
      } catch (error) {
        settleReject(createCodexServerError(
          "Received an invalid response from the Codex app-server.",
          {
            detail: error instanceof Error ? error.message : String(error),
            phase: initializeComplete ? "request" : "initialize",
          },
        ));
      }
    };

    socket.onerror = () => {
      settleReject(createCodexServerError(
        "Could not connect to the Codex app-server.",
        {
          detail: `The WebSocket connection to ${url} failed.`,
          phase: "connect",
        },
      ));
    };

    socket.onclose = (event) => {
      settleReject(createCodexServerError(
        "The Codex app-server connection closed unexpectedly.",
        {
          detail: event.reason
            ? `Close code ${event.code}: ${event.reason}`
            : `Close code ${event.code}.`,
          phase: initializeComplete ? "request" : "connect",
        },
      ));
    };
  });
}

function formatSessionSource(source: Thread["source"]) {
  return typeof source === "string"
    ? source
    : "subAgent" in source
      ? `subAgent:${source.subAgent}`
      : "unknown";
}

export function toThreadSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    name: thread.name,
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: formatThreadStatus(thread.status),
    cwd: thread.cwd,
    source: formatSessionSource(thread.source),
    path: thread.path,
  };
}

function formatThreadStatus(status: Thread["status"]) {
  switch (status.type) {
    case "notLoaded":
      return "notLoaded";
    case "idle":
      return "idle";
    case "systemError":
      return "systemError";
    case "active":
      return status.activeFlags.length
        ? `active:${status.activeFlags.join(",")}`
        : "active";
    default:
      return "unknown";
  }
}

function isProjectThread(thread: Pick<Thread, "cwd">, rootPath = projectRoot) {
  return isPathWithinRoot(thread.cwd, rootPath);
}

function formatUserInput(input: UserInput) {
  switch (input.type) {
    case "text":
      return input.text;
    case "image":
      return `![image](${input.url})`;
    case "localImage":
      return `![local image](${input.path})`;
    case "skill":
      return `Skill: ${input.name} (${input.path})`;
    case "mention":
      return `Mention: ${input.name} (${input.path})`;
    default:
      return JSON.stringify(input);
  }
}

function normalizeThreadMessageInput(input: UserInput[]) {
  const normalized: UserInput[] = [];

  for (const entry of input) {
    switch (entry.type) {
      case "text": {
        const text = entry.text.trim();
        if (text) {
          normalized.push(createTextInput(text));
        }
        break;
      }
      case "image": {
        const url = entry.url.trim();
        if (url) {
          normalized.push({
            type: "image",
            url,
          });
        }
        break;
      }
      case "localImage": {
        const path = entry.path.trim();
        if (path) {
          normalized.push({
            type: "localImage",
            path,
          });
        }
        break;
      }
      case "skill": {
        const name = entry.name.trim();
        const path = entry.path.trim();
        if (name && path) {
          normalized.push({
            type: "skill",
            name,
            path,
          });
        }
        break;
      }
      case "mention": {
        const name = entry.name.trim();
        const path = entry.path.trim();
        if (name && path) {
          normalized.push({
            type: "mention",
            name,
            path,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  return normalized;
}

function renderThreadItemMarkdown(item: Thread["turns"][number]["items"][number]) {
  switch (item.type) {
    case "userMessage":
      return [
        "### User",
        item.content.map((content) => formatUserInput(content)).join("\n\n"),
      ].join("\n\n");
    case "agentMessage":
      return [
        "### Assistant",
        item.text || "_No text captured._",
      ].join("\n\n");
    case "plan":
      return [
        "### Plan",
        item.text || "_No plan text captured._",
      ].join("\n\n");
    case "reasoning":
      return [
        "### Reasoning",
        item.summary.join("\n"),
        item.content.join("\n"),
      ].filter(Boolean).join("\n\n");
    case "commandExecution":
      return [
        "### Command",
        `- Status: ${item.status}`,
        `- CWD: ${item.cwd}`,
        "",
        "```sh",
        item.command,
        "```",
        item.aggregatedOutput
          ? ["```text", item.aggregatedOutput.trimEnd(), "```"].join("\n")
          : "_No captured output._",
      ].join("\n");
    case "fileChange":
      return [
        "### File change",
        item.changes.length
          ? item.changes.map((change) => `- ${change.path}`).join("\n")
          : "_No captured file paths._",
      ].join("\n\n");
    case "mcpToolCall":
      return [
        "### MCP tool call",
        `- ${item.server} / ${item.tool}`,
        `- Status: ${item.status}`,
        "",
        "```json",
        JSON.stringify(item.arguments, null, 2),
        "```",
      ].join("\n");
    case "dynamicToolCall":
      return [
        "### Tool call",
        `- ${item.tool}`,
        `- Status: ${item.status}`,
        "",
        "```json",
        JSON.stringify(item.arguments, null, 2),
        "```",
      ].join("\n");
    case "webSearch":
      return [
        "### Web search",
        item.query,
      ].join("\n\n");
    case "imageView":
      return [
        "### Image view",
        item.path,
      ].join("\n\n");
    case "enteredReviewMode":
    case "exitedReviewMode":
      return [
        `### ${item.type === "enteredReviewMode" ? "Entered" : "Exited"} review mode`,
        item.review,
      ].join("\n\n");
    case "contextCompaction":
      return "### Context compaction";
    case "collabAgentToolCall":
      return [
        "### Collaboration",
        `- Tool: ${item.tool}`,
        `- Status: ${item.status}`,
        item.prompt ? `- Prompt: ${item.prompt}` : "",
      ].filter(Boolean).join("\n");
  }
}

export function renderThreadMarkdown(thread: Thread) {
  const title = thread.name || thread.preview || thread.id;
  const lines = [
    `# ${title}`,
    "",
    `- ID: \`${thread.id}\``,
    `- Status: ${thread.status}`,
    `- Updated: ${new Date(thread.updatedAt * 1000).toLocaleString()}`,
    `- Source: ${formatSessionSource(thread.source)}`,
    `- CWD: \`${thread.cwd}\``,
  ];

  if (thread.path) {
    lines.push(`- Path: \`${thread.path}\``);
  }

  if (thread.preview && thread.preview !== title) {
    lines.push("", "## Preview", "", thread.preview);
  }

  if (thread.turns.length) {
    lines.push("", "## Turns");
    thread.turns.forEach((turn, index) => {
      lines.push("", `## Turn ${index + 1} · ${turn.status}`);
      for (const item of turn.items) {
        lines.push("", renderThreadItemMarkdown(item));
      }
    });
  }

  return `${lines.join("\n").trim()}\n`;
}

export async function listCodexThreads(rootPath = projectRoot) {
  const response = await requestCodexAppServer<ThreadListResponse>({
    method: "thread/list",
    params: {
      archived: false,
      limit: 50,
      sortKey: "updated_at",
    },
  });

  return response.data
    .filter((thread) => isProjectThread(thread, rootPath))
    .map((thread) => toThreadSummary(thread))
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }

      return left.id.localeCompare(right.id);
    });
}

export async function readCodexThread(threadId: string, rootPath = projectRoot) {
  const response = await requestCodexAppServer<ThreadReadResponse>({
    method: "thread/read",
    params: {
      threadId,
      includeTurns: true,
    },
  });

  if (!isProjectThread(response.thread, rootPath)) {
    throw createCodexServerError("That Codex thread doesn't belong to this project.", {
      phase: "request",
      status: 404,
    });
  }

  return response.thread;
}

export async function resumeCodexThread(threadId: string, rootPath = projectRoot) {
  const response = await requestCodexAppServer<ThreadResumeResponse>({
    method: "thread/resume",
    params: {
      persistExtendedHistory: true,
      threadId,
    },
  });

  if (!isProjectThread(response.thread, rootPath)) {
    throw createCodexServerError("That Codex thread doesn't belong to this project.", {
      phase: "request",
      status: 404,
    });
  }

  return response.thread;
}

export async function sendCodexThreadMessage(
  threadId: string,
  input: UserInput[],
  rootPath = projectRoot,
) {
  const normalizedInput = normalizeThreadMessageInput(input);
  if (!threadId.trim()) {
    throw createCodexServerError("Missing thread id.", {
      phase: "request",
      status: 400,
    });
  }

  if (!normalizedInput.length) {
    throw createCodexServerError("Message input cannot be empty.", {
      phase: "request",
      status: 400,
    });
  }

  const readableThread = await readCodexThread(threadId, rootPath);
  const thread = await resumeCodexThread(threadId, rootPath);
  const currentInProgressTurn = getCurrentInProgressTurn(thread);
  const visibleCurrentTurn = getCurrentTurn(readableThread);

  if (
    visibleCurrentTurn?.status === "completed"
    && currentInProgressTurn
    && currentInProgressTurn.id !== visibleCurrentTurn.id
  ) {
    throw createCodexServerError("This thread is out of sync with the app-server.", {
      detail: "New messages are disabled here for now.",
      phase: "request",
      status: 409,
    });
  }

  if (currentInProgressTurn) {
    await requestCodexAppServer<TurnSteerResponse>({
      method: "turn/steer",
      params: {
        expectedTurnId: currentInProgressTurn.id,
        input: normalizedInput,
        threadId,
      },
    });
  } else {
    await requestCodexAppServer<TurnStartResponse>({
      method: "turn/start",
      params: {
        input: normalizedInput,
        summary: DEFAULT_TURN_REASONING_SUMMARY,
        threadId,
      },
    });
  }

  return await readCodexThread(threadId, rootPath);
}
