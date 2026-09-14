/*
 * Exports:
 * - WorkbenchTranscriptItemLifecycle: durable lifecycle values shared by item transforms.
 * - WorkbenchTranscriptAtomicObservation: one source-owned semantic transcript or turn-usage fact.
 * - WorkbenchTranscriptCaptureGapObservation: one closed failed-capture interval.
 * - WorkbenchTranscriptProviderTurnScopeObservation: one complete provider-owned turn replacement boundary.
 * - WorkbenchTranscriptObservation: ordered transcript input, metadata-only catalogs and restricted usage windows.
 * - NativeTranscriptAtomicObservation/NativeTranscriptObservation: provider-addressed facts before canonical mapping.
 * - WorkbenchTranscriptRecordingContext: fact ownership and provider-recovery boundary for one settlement.
 * - WorkbenchTranscriptSettlement: semantic commit result used to refresh subscriptions.
 * - WorkbenchTranscriptReadRequest: bounded relational read request.
 * - WorkbenchTranscriptSnapshot: hydrated transcript result.
 * - WorkbenchTranscriptContextSnapshot: interaction bodies with full item-order metadata.
 * - WorkbenchTranscriptSnapshotRows: typed canonical rows.
 * - WorkbenchTranscriptItemSource: provider-scoped item identity evidence.
 * - WorkbenchTranscriptItemLegacyAlias: turn-scoped reference retained from an older projection.
 * - WorkbenchTranscriptItemIdentityAdmission: one structural identity admission, independent of body recording.
 * - WorkbenchTranscriptItemIdentityLookup: public-first, thread-scoped item lookup.
 * - WorkbenchTranscriptItemIdentity: resolved public identity and private alias evidence.
 * - WorkbenchTranscriptIdentityDatabase: structural identity operations on the existing database worker.
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
import type { WorkbenchCumulativeTokenUsage } from "workbench-shared/workbench/stats/workbench-stats-usage";
import type { ThreadContextUsageSnapshot } from "workbench-shared/workbench/thread/thread-context-usage";
import type { WorkbenchTranscriptSnapshot } from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";
export type {
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

export type WorkbenchTranscriptContextSnapshot = WorkbenchTranscriptSnapshot & {
  contextItemOrder?: { turnId: string; itemIds: string[] }[];
};

import type {
  ItemReference, NativeItemId, NativeThreadId, NativeTurnId, ProjectId,
  WorkbenchItemId, WorkbenchThreadId, WorkbenchTurnId,
} from "workbench-shared/workbench/identity";

export type WorkbenchTranscriptItemLifecycle = "streaming" | "completed" | "interrupted";

export interface WorkbenchTranscriptItemSource {
  turnId: WorkbenchTurnId;
  kind: "stable" | "provisional" | "client";
  sourceId: string;
}

export interface WorkbenchTranscriptItemLegacyAlias {
  turnId: WorkbenchTurnId;
  alias: string;
}

export interface WorkbenchTranscriptItemIdentityAdmission {
  threadId: WorkbenchThreadId;
  itemId?: WorkbenchItemId;
  sources: readonly WorkbenchTranscriptItemSource[];
  legacyAliases: readonly WorkbenchTranscriptItemLegacyAlias[];
}

export interface WorkbenchTranscriptItemIdentityLookup {
  threadId: WorkbenchThreadId;
  itemId: WorkbenchItemId | NativeItemId | ItemReference;
  turnId?: WorkbenchTurnId;
}

export interface WorkbenchTranscriptItemIdentity {
  threadId: WorkbenchThreadId;
  itemId: WorkbenchItemId;
  sources: readonly WorkbenchTranscriptItemSource[];
  legacyAliases: readonly WorkbenchTranscriptItemLegacyAlias[];
}

export interface WorkbenchTranscriptIdentityDatabase {
  admitTranscriptItemIdentities(inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]): Promise<WorkbenchTranscriptItemIdentity[]>;
  resolveTranscriptItemIdentity(input: WorkbenchTranscriptItemIdentityLookup): Promise<WorkbenchTranscriptItemIdentity | null>;
}

type TranscriptEntry<Entry, ThreadId extends string, TurnId extends string> = Omit<Entry, "threadId" | "turnId"> & {
  threadId: ThreadId;
  turnId: TurnId;
};

export type WorkbenchTranscriptAtomicObservation<ThreadId extends string = WorkbenchThreadId, TurnId extends string = WorkbenchTurnId> =
  | {
    kind: "providerCursor";
    threadId: ThreadId;
    turnId: TurnId;
    previousCursor: string | null;
  }
  | {
    kind: "thread";
    threadId: ThreadId;
    projectId: ProjectId;
    projectRoot: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    activityAt: number;
  }
  | ({
    kind: "turn";
    threadId: ThreadId;
    harnessId: string;
    nativeLocation: string;
    nativeThreadId: NativeThreadId;
    state: CoreSchemaRows["threadTurns"]["state"];
    createdAt: number;
    startedAt: number | null;
    endedAt: number | null;
    durationMs: number | null;
    turnIndex?: number;
  } & (
    | { nativeTurnId: NativeTurnId; turnId: TurnId }
    | { nativeTurnId: null; turnId: WorkbenchTurnId }
  ))
  | {
    kind: "turnUsageContext";
    modelChanged?: boolean;
    model: string | null;
    observedAt: number;
    serviceTier: string | null;
    threadId: ThreadId;
    turnId: TurnId;
  }
  | {
    kind: "threadContextUsage";
    threadId: ThreadId;
    snapshot: ThreadContextUsageSnapshot;
    initialise: boolean;
  }
  | {
    kind: "turnTokenUsage";
    cumulative: WorkbenchCumulativeTokenUsage;
    observedAt: number;
    threadId: ThreadId;
    turnId: TurnId;
    usageDataVersion: number;
  }
  | {
    kind: "item";
    threadId: ThreadId;
    turnId: TurnId;
    publicItemId?: WorkbenchItemId;
    item: ThreadItem | WorkbenchFileChangeItem;
    lifecycle: WorkbenchTranscriptItemLifecycle;
    observedAt: number;
    itemPosition?: number;
    timeline?: WorkbenchThreadItemTimelineEntry;
  }
  | {
    kind: "questionnaire";
    publicItemId?: WorkbenchItemId;
    entry: TranscriptEntry<WorkbenchQuestionnaireHistoryEntry, ThreadId, TurnId>;
    observedAt: number;
    itemPosition?: number;
  }
  | {
    kind: "steer";
    publicItemId?: WorkbenchItemId;
    entry: TranscriptEntry<WorkbenchSteerHistoryEntry, ThreadId, TurnId>;
    observedAt: number;
    itemPosition?: number;
  }
  | {
    kind: "browse";
    entry: TranscriptEntry<WorkbenchBrowseResultEntry, ThreadId, TurnId>;
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
    nativeThreadId: NativeThreadId | null;
    nativeTurnId: NativeTurnId | null;
    nativeItemId: NativeItemId | null;
    nativeEventId: string | null;
    clientId: string | null;
    nativeSequence: string | null;
    recordKind: EvidenceSchemaRows["transcriptNativeRecords"]["record_kind"];
    payloadJson: string;
    recordedAt: number;
    threadId: ThreadId | null;
    turnId: TurnId | null;
    itemId: WorkbenchItemId | NativeItemId | ItemReference | null;
  };

export interface WorkbenchTranscriptCaptureGapObservation<ThreadId extends string = WorkbenchThreadId, TurnId extends string = WorkbenchTurnId> {
  closedAt: number;
  errorText: string;
  gapId: string;
  kind: "captureGap";
  openedAt: number;
  reason: string;
  state: "reconciled" | "unrecoverable";
  threadId: ThreadId;
  turnId: TurnId | null;
}

export interface WorkbenchTranscriptProviderTurnScopeObservation<ThreadId extends string = WorkbenchThreadId, TurnId extends string = WorkbenchTurnId> {
  completeTurnIds: readonly TurnId[];
  kind: "providerTurnScope";
  observations: readonly WorkbenchTranscriptAtomicObservation<ThreadId, TurnId>[];
  threadId: ThreadId;
}

export type WorkbenchTranscriptObservation<ThreadId extends string = WorkbenchThreadId, TurnId extends string = WorkbenchTurnId> =
  | WorkbenchTranscriptAtomicObservation<ThreadId, TurnId>
  | WorkbenchTranscriptCaptureGapObservation<ThreadId, TurnId>
  | WorkbenchTranscriptProviderTurnScopeObservation<ThreadId, TurnId>
  | {
    kind: "turnCatalog";
    threadId: ThreadId;
    catalog: readonly Extract<WorkbenchTranscriptAtomicObservation<ThreadId, TurnId>, { kind: "thread" | "turn" }>[];
  }
  | {
    kind: "usageWindow";
    threadId: ThreadId;
    catalog: readonly Extract<WorkbenchTranscriptAtomicObservation<ThreadId, TurnId>, { kind: "thread" | "turn" }>[];
    observations: readonly Extract<WorkbenchTranscriptAtomicObservation<ThreadId, TurnId>, { kind: "turnUsageContext" | "turnTokenUsage" }>[];
  }
  | {
    kind: "canonicalWindow";
    contentVersion: number;
    materializedTurnIds: readonly TurnId[];
    threadId: ThreadId;
    observations: readonly WorkbenchTranscriptAtomicObservation<ThreadId, TurnId>[];
  };

export type NativeTranscriptAtomicObservation = WorkbenchTranscriptAtomicObservation<NativeThreadId, NativeTurnId>;
export type NativeTranscriptObservation = WorkbenchTranscriptObservation<NativeThreadId, NativeTurnId>;

export interface WorkbenchTranscriptRecordingContext {
  recoveryBoundary?: boolean;
  source: "compatibility" | "provider" | "workbench";
}

export interface WorkbenchTranscriptSettlement {
  changedThreadIds: string[];
  changes?: {
    snapshot: WorkbenchTranscriptSnapshot;
    removedItemIds: string[];
    completedItemIds: string[];
  }[];
}
