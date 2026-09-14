/*
 * Exports:
 * - WorkbenchBrowseResultEvent: Browse-owned result data keyed only by the owning thread id. Keywords: browse, result, thread, event, sidecar.
 * - WorkbenchBrowseResultSink: thread-boundary sink for deferred results and explicit screenshots. Keywords: browse, result, context, ownership.
 * - WorkbenchBrowseScreenshotDelivery: native queue acceptance or legacy steer result.
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
  deliverScreenshot(threadId: string, imageUrl: string): Promise<WorkbenchBrowseScreenshotDelivery>;
  waitForIdle(): Promise<void>;
}

export type WorkbenchBrowseScreenshotDelivery =
  | { kind: "injected"; acceptedAt: number; turnId: string }
  | { kind: "steered"; turnId: string };
