/*
 * Exports:
 * - CodexAppServerNotification: typed app-server notification union.
 * - WorkbenchQuestionnaireRequestedNotification: provider questionnaire publication.
 * - WorkbenchQuestionnaireResolvedNotification: resolution with optional successful-answer evidence.
 * - WorkbenchBrowseResultRecordedNotification: Workbench-owned Browse result sidecar notification.
 * - WorkbenchSteerHistoryChangedNotification: a held steer was admitted or changed outside the transcript stream.
 * - isCodexAppServerNotification: identify JSON-RPC app-server notifications from incoming WebSocket messages.
 */
import type { ServerNotification } from "./generated/app-server/ServerNotification.ts";
import type { WorkbenchUserInputRequest } from "../types.ts";

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
    answered?: true;
  };
}

export interface WorkbenchBrowseResultRecordedNotification {
  method: "browse/result/recorded";
  params: {
    threadId: string;
    turnId: string;
  };
}

export interface WorkbenchSteerHistoryChangedNotification {
  method: "steer/history/changed";
  params: {
    threadId: string;
    turnId: string;
  };
}

export type CodexAppServerNotification =
  | ServerNotification
  | WorkbenchBrowseResultRecordedNotification
  | WorkbenchSteerHistoryChangedNotification
  | WorkbenchQuestionnaireRequestedNotification
  | WorkbenchQuestionnaireResolvedNotification;

export function isCodexAppServerNotification(message: unknown): message is CodexAppServerNotification {
  return !!message
    && typeof message === "object"
    && "method" in message
    && "params" in message
    && !("id" in message);
}
