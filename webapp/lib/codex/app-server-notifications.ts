/*
 * Exports:
 * - CodexAppServerNotification: typed app-server notification union. Keywords: codex, app-server, notification, event.
 * - CodexAppServerNotificationHandling: normalized handling metadata for app-server notifications. Keywords: codex, event, refresh, scope.
 * - classifyCodexAppServerNotification: exhaustively map documented notification method ids to workbench handling hints. Keywords: switch, no default, exhaustive.
 * - isCodexAppServerNotification: identify JSON-RPC app-server notifications from incoming WebSocket messages. Keywords: websocket, method, params.
 */
import type { ServerNotification } from "./generated/app-server/ServerNotification";

export type CodexAppServerNotification = ServerNotification;

export type CodexAppServerNotificationScope =
  | "account"
  | "app"
  | "filesystem"
  | "search"
  | "server-request"
  | "thread"
  | "turn"
  | "warning";

export interface CodexAppServerNotificationHandling {
  method: CodexAppServerNotification["method"];
  refreshThread: boolean;
  refreshThreads: boolean;
  scope: CodexAppServerNotificationScope;
}

function createHandling(
  notification: CodexAppServerNotification,
  scope: CodexAppServerNotificationScope,
  {
    refreshThread = false,
    refreshThreads = false,
  }: {
    refreshThread?: boolean;
    refreshThreads?: boolean;
  } = {},
): CodexAppServerNotificationHandling {
  return {
    method: notification.method,
    refreshThread,
    refreshThreads,
    scope,
  };
}

export function classifyCodexAppServerNotification(
  notification: CodexAppServerNotification,
): CodexAppServerNotificationHandling {
  switch (notification.method) {
    case "error":
    case "warning":
    case "guardianWarning":
    case "deprecationNotice":
    case "configWarning":
    case "windows/worldWritableWarning":
    case "windowsSandbox/setupCompleted":
      return createHandling(notification, "warning");

    case "thread/started":
    case "thread/status/changed":
    case "thread/archived":
    case "thread/unarchived":
    case "thread/closed":
    case "thread/name/updated":
    case "thread/tokenUsage/updated":
    case "thread/compacted":
      return createHandling(notification, "thread", {
        refreshThread: true,
        refreshThreads: true,
      });

    case "turn/started":
    case "hook/started":
    case "turn/completed":
    case "hook/completed":
    case "turn/diff/updated":
    case "turn/plan/updated":
    case "item/started":
    case "item/autoApprovalReview/started":
    case "item/autoApprovalReview/completed":
    case "item/completed":
    case "rawResponseItem/completed":
    case "item/agentMessage/delta":
    case "item/plan/delta":
    case "command/exec/outputDelta":
    case "item/commandExecution/outputDelta":
    case "item/commandExecution/terminalInteraction":
    case "item/fileChange/outputDelta":
    case "item/fileChange/patchUpdated":
    case "item/mcpToolCall/progress":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/textDelta":
    case "model/rerouted":
    case "model/verification":
      return createHandling(notification, "turn", {
        refreshThread: true,
        refreshThreads: notification.method === "turn/completed",
      });

    case "serverRequest/resolved":
      return createHandling(notification, "server-request", {
        refreshThread: true,
      });

    case "skills/changed":
    case "mcpServer/oauthLogin/completed":
    case "mcpServer/startupStatus/updated":
    case "account/updated":
    case "account/rateLimits/updated":
    case "account/login/completed":
      return createHandling(notification, "account");

    case "app/list/updated":
    case "externalAgentConfig/import/completed":
      return createHandling(notification, "app");

    case "fs/changed":
      return createHandling(notification, "filesystem");

    case "fuzzyFileSearch/sessionUpdated":
    case "fuzzyFileSearch/sessionCompleted":
      return createHandling(notification, "search");

    case "thread/realtime/started":
    case "thread/realtime/itemAdded":
    case "thread/realtime/transcript/delta":
    case "thread/realtime/transcript/done":
    case "thread/realtime/outputAudio/delta":
    case "thread/realtime/sdp":
    case "thread/realtime/error":
    case "thread/realtime/closed":
      return createHandling(notification, "thread", {
        refreshThread: true,
      });
  }

  const unhandledNotification: never = notification;
  return unhandledNotification;
}

export function isCodexAppServerNotification(message: unknown): message is CodexAppServerNotification {
  return !!message
    && typeof message === "object"
    && "method" in message
    && "params" in message
    && !("id" in message);
}
