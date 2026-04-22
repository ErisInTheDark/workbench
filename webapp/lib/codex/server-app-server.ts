import type { ClientRequest } from "./generated/app-server/ClientRequest";
import type { Thread } from "./generated/app-server/v2/Thread";
import type { ThreadListResponse } from "./generated/app-server/v2/ThreadListResponse";
import type { ThreadReadResponse } from "./generated/app-server/v2/ThreadReadResponse";
import type { UserInput } from "./generated/app-server/v2/UserInput";
import type { ThreadSummary } from "../types";
import {
  getCodexAppServerUrl,
} from "./config";
import {
  createInitializeRequest,
  createInitializedNotification,
  isCodexJsonRpcFailure,
  isCodexJsonRpcSuccess,
} from "./protocol";

const APP_SERVER_TIMEOUT_MS = 5000;

interface CodexServerError extends Error {
  detail?: string;
  phase?: "connect" | "initialize" | "request";
}

function createCodexServerError(
  message: string,
  {
    detail,
    phase,
  }: {
    detail?: string;
    phase?: "connect" | "initialize" | "request";
  } = {},
) {
  const error = new Error(message) as CodexServerError;
  error.detail = detail;
  error.phase = phase;
  return error;
}

export async function requestCodexAppServer<TResponse>(
  request: Omit<ClientRequest, "id"> & { id?: number },
): Promise<TResponse> {
  const url = getCodexAppServerUrl();

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
      socket.send(JSON.stringify(createInitializeRequest(0)));
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data));

        if (typeof message !== "object" || message === null || !("id" in message)) {
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

export async function listCodexThreads() {
  const response = await requestCodexAppServer<ThreadListResponse>({
    method: "thread/list",
    params: {
      archived: false,
      limit: 50,
    },
  });

  return response.data.map((thread) => toThreadSummary(thread));
}

export async function readCodexThread(threadId: string) {
  const response = await requestCodexAppServer<ThreadReadResponse>({
    method: "thread/read",
    params: {
      threadId,
      includeTurns: true,
    },
  });

  return response.thread;
}
