/*
 * Exports:
 * - WorkbenchBrowseResultEvent: Browse-owned action result data.
 * - WorkbenchBrowseResultOrigin: invocation identity captured before browser work.
 * - WorkbenchBrowseResultSink: capture invocation ownership, record results, and deliver explicit screenshots.
 * - WorkbenchBrowseScreenshotDelivery: native queue acceptance or legacy steer result.
 */
import type {
  WorkbenchBrowseAgentActionName,
  WorkbenchBrowseResultEntryDetailKind,
  WorkbenchBrowseResultEntryState,
  WorkbenchHarness,
} from "workbench-shared/types";

export interface WorkbenchBrowseResultOrigin {
  commandItemId: string | null;
  harness: WorkbenchHarness;
  turnId: string;
}

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
  captureOrigin(threadId: string): Promise<WorkbenchBrowseResultOrigin | null>;
  record(event: WorkbenchBrowseResultEvent, origin: WorkbenchBrowseResultOrigin | null): void;
  deliverScreenshot(threadId: string, imageUrl: string, origin?: WorkbenchBrowseResultOrigin | null): Promise<WorkbenchBrowseScreenshotDelivery>;
  waitForIdle(): Promise<void>;
}

export type WorkbenchBrowseScreenshotDelivery =
  | { kind: "injected"; acceptedAt: number; turnId: string }
  | { kind: "steered"; turnId: string };
