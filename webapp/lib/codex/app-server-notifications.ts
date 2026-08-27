/*
 * Exports:
 * - CodexAppServerNotification: typed app-server notification union. Keywords: codex, app-server, notification, event.
 * - WorkbenchBrowseResultRecordedNotification: Workbench-owned Browse result sidecar notification. Keywords: browse, result, transcript.
 * - isCodexAppServerNotification: identify JSON-RPC app-server notifications from incoming WebSocket messages. Keywords: websocket, method, params.
 */
import type { ServerNotification } from "./generated/app-server/ServerNotification";
import type { WorkbenchUserInputRequest } from "../types";

export interface WorkbenchQuestionnaireRequestedNotification {
  method: "questionnaire/requested";
  params: {
    threadId: string;
    requestKey: string;
    turnId: string | null;
    itemId: string | null;
    request: WorkbenchUserInputRequest;
  };
}

export interface WorkbenchQuestionnaireResolvedNotification {
  method: "questionnaire/resolved";
  params: {
    threadId: string;
    requestKey: string;
  };
}

export interface WorkbenchBrowseResultRecordedNotification {
  method: "browse/result/recorded";
  params: {
    threadId: string;
    turnId: string;
  };
}

export type CodexAppServerNotification =
  | ServerNotification
  | WorkbenchBrowseResultRecordedNotification
  | WorkbenchQuestionnaireRequestedNotification
  | WorkbenchQuestionnaireResolvedNotification;

export function isCodexAppServerNotification(message: unknown): message is CodexAppServerNotification {
  return !!message
    && typeof message === "object"
    && "method" in message
    && "params" in message
    && !("id" in message);
}
