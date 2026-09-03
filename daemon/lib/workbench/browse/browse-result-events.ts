/*
 * Exports:
 * - WorkbenchBrowseResultEvent: Browse-owned result data keyed only by the owning thread id. Keywords: browse, result, thread, event, sidecar.
 * - WorkbenchBrowseResultSink: thread-boundary sink for deferred result recording and explicit screenshot steering. Keywords: browse, result, steer, ownership.
 */
import type {
  WorkbenchBrowseAgentActionName,
  WorkbenchBrowseResultEntryDetailKind,
  WorkbenchBrowseResultEntryState,
} from "workbench-shared/types";

export interface WorkbenchBrowseResultEvent {
  action: WorkbenchBrowseAgentActionName | string;
  actionIndex: number;
  assetUrl: string | null;
  detailKind: WorkbenchBrowseResultEntryDetailKind | null;
  detailLabel: string | null;
  detailText: string | null;
  durationMs: number | null;
  session: string | null;
  state: WorkbenchBrowseResultEntryState;
  threadId: string;
}

export interface WorkbenchBrowseResultSink {
  record(event: WorkbenchBrowseResultEvent): void;
  steerScreenshot(threadId: string, imageUrl: string): Promise<string>;
  waitForIdle(): Promise<void>;
}
