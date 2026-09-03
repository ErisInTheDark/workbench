/*
 * Exports:
 * - WorkbenchTranscriptItemLifecycle: durable lifecycle values shared by item transforms. Keywords: transcript, item, lifecycle.
 * - WorkbenchTranscriptAtomicObservation: one source-owned semantic transcript fact. Keywords: transcript, observation, atomic.
 * - WorkbenchTranscriptCaptureGapObservation: one closed failed-capture interval. Keywords: transcript, capture gap, recovery.
 * - WorkbenchTranscriptProviderTurnScopeObservation: one complete provider-owned turn replacement boundary. Keywords: transcript, provider, replacement.
 * - WorkbenchTranscriptObservation: harness-neutral durable transcript input accepted in queue order. Keywords: transcript, observation, recorder.
 * - WorkbenchTranscriptRecordingContext: fact ownership and provider-recovery boundary for one settlement. Keywords: transcript, recording, recovery.
 * - WorkbenchTranscriptSettlement: semantic commit result used to refresh subscriptions. Keywords: transcript, settlement, subscription.
 * - WorkbenchTranscriptReadRequest/WorkbenchTranscriptSnapshot/WorkbenchTranscriptSnapshotRows: shared hydration-bounded relational read contract re-exports. Keywords: transcript, snapshot, hydration.
 */
import type { ThreadItem } from "workbench-shared/codex/generated/app-server/v2/ThreadItem";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
} from "workbench-shared/types";
import type { WorkbenchThreadItemTimelineEntry } from "workbench-shared/workbench/thread/thread-item-timeline";
import type { WorkbenchFileChangeItem } from "workbench-shared/workbench/thread/workbench-file-change";
import type { CoreSchemaRows } from "workbench-shared/workbench/database/schema/core-schema";
import type { EvidenceSchemaRows } from "workbench-shared/workbench/database/schema/evidence-schema";
export type {
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

export type WorkbenchTranscriptItemLifecycle = "streaming" | "completed" | "interrupted";

export type WorkbenchTranscriptAtomicObservation =
  | {
    kind: "thread";
    threadId: string;
    projectId: string;
    projectRoot: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    activityAt: number;
  }
  | {
    kind: "turn";
    threadId: string;
    turnId: string;
    harnessId: string;
    nativeLocation: string;
    nativeThreadId: string;
    nativeTurnId: string | null;
    state: CoreSchemaRows["threadTurns"]["state"];
    createdAt: number;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
    turnIndex?: number;
  }
  | {
    kind: "item";
    threadId: string;
    turnId: string;
    item: ThreadItem | WorkbenchFileChangeItem;
    lifecycle: WorkbenchTranscriptItemLifecycle;
    observedAt: number;
    itemPosition?: number;
    timeline?: WorkbenchThreadItemTimelineEntry;
  }
  | {
    kind: "questionnaire";
    entry: WorkbenchQuestionnaireHistoryEntry;
    observedAt: number;
    itemPosition?: number;
  }
  | {
    kind: "steer";
    entry: WorkbenchSteerHistoryEntry;
    observedAt: number;
    itemPosition?: number;
  }
  | {
    kind: "browse";
    entry: WorkbenchBrowseResultEntry;
    asset?: {
      byteLength: number;
      digest: string;
      mimeType: string;
      storageKey: string;
    };
  }
  | {
    kind: "nativeEvidence";
    harnessId: string;
    nativeLocation: string;
    nativeThreadId: string | null;
    nativeTurnId: string | null;
    nativeItemId: string | null;
    nativeEventId: string | null;
    clientId: string | null;
    nativeSequence: string | null;
    recordKind: EvidenceSchemaRows["transcriptNativeRecords"]["record_kind"];
    payloadJson: string;
    recordedAt: number;
    threadId: string | null;
    turnId: string | null;
    itemId: string | null;
  };

export interface WorkbenchTranscriptCaptureGapObservation {
  closedAt: number;
  errorText: string;
  gapId: string;
  kind: "captureGap";
  openedAt: number;
  reason: string;
  state: "reconciled" | "unrecoverable";
  threadId: string;
  turnId: string | null;
}

export interface WorkbenchTranscriptProviderTurnScopeObservation {
  completeTurnIds: readonly string[];
  kind: "providerTurnScope";
  observations: readonly WorkbenchTranscriptAtomicObservation[];
  threadId: string;
}

export type WorkbenchTranscriptObservation =
  | WorkbenchTranscriptAtomicObservation
  | WorkbenchTranscriptCaptureGapObservation
  | WorkbenchTranscriptProviderTurnScopeObservation
  | {
    kind: "canonicalWindow";
    contentVersion: number;
    materializedTurnIds: readonly string[];
    threadId: string;
    observations: readonly WorkbenchTranscriptAtomicObservation[];
  };

export interface WorkbenchTranscriptRecordingContext {
  recoveryBoundary?: boolean;
  source: "compatibility" | "provider" | "workbench";
}

export interface WorkbenchTranscriptSettlement {
  changedThreadIds: string[];
}
