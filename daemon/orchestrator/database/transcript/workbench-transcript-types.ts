/*
 * Keywords: transcript, observation, catalog, usage, recording, recovery.
 * Exports:
 * - WorkbenchTranscriptItemLifecycle: durable lifecycle values shared by item transforms. Keywords: transcript, item, lifecycle.
 * - WorkbenchTranscriptAtomicObservation: one source-owned semantic transcript or turn-usage fact. Keywords: transcript, observation, atomic, stats.
 * - WorkbenchTranscriptCaptureGapObservation: one closed failed-capture interval. Keywords: transcript, capture gap, recovery.
 * - WorkbenchTranscriptProviderTurnScopeObservation: one complete provider-owned turn replacement boundary. Keywords: transcript, provider, replacement.
 * - WorkbenchTranscriptObservation: ordered transcript input, metadata-only catalogs and restricted usage windows.
 * - WorkbenchTranscriptRecordingContext: fact ownership and provider-recovery boundary for one settlement. Keywords: transcript, recording, recovery.
 * - WorkbenchTranscriptSettlement: semantic commit result used to refresh subscriptions. Keywords: transcript, settlement, subscription.
 * - WorkbenchTranscriptReadRequest: bounded relational read request.
 * - WorkbenchTranscriptSnapshot: hydrated transcript result.
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
export type {
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "workbench-shared/workbench/database/transcript/workbench-transcript-contract";

export type WorkbenchTranscriptItemLifecycle = "streaming" | "completed" | "interrupted";

export interface WorkbenchTranscriptItemSource {
  turnId: string;
  kind: "stable" | "provisional" | "client";
  sourceId: string;
}

export interface WorkbenchTranscriptItemLegacyAlias {
  turnId: string;
  alias: string;
}

export interface WorkbenchTranscriptItemIdentityAdmission {
  threadId: string;
  itemId?: string;
  sources: readonly WorkbenchTranscriptItemSource[];
  legacyAliases: readonly WorkbenchTranscriptItemLegacyAlias[];
}

export interface WorkbenchTranscriptItemIdentityLookup {
  threadId: string;
  itemId: string;
  turnId?: string;
}

export interface WorkbenchTranscriptItemIdentity {
  threadId: string;
  itemId: string;
  sources: readonly WorkbenchTranscriptItemSource[];
  legacyAliases: readonly WorkbenchTranscriptItemLegacyAlias[];
}

export interface WorkbenchTranscriptIdentityDatabase {
  admitTranscriptItemIdentities(inputs: readonly WorkbenchTranscriptItemIdentityAdmission[]): Promise<WorkbenchTranscriptItemIdentity[]>;
  resolveTranscriptItemIdentity(input: WorkbenchTranscriptItemIdentityLookup): Promise<WorkbenchTranscriptItemIdentity | null>;
}

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
    kind: "turnUsageContext";
    modelChanged?: boolean;
    model: string | null;
    observedAt: number;
    serviceTier: string | null;
    threadId: string;
    turnId: string;
  }
  | {
    kind: "turnTokenUsage";
    cumulative: WorkbenchCumulativeTokenUsage;
    observedAt: number;
    threadId: string;
    turnId: string;
    usageDataVersion: number;
  }
  | {
    kind: "item";
    threadId: string;
    turnId: string;
    publicItemId?: string;
    item: ThreadItem | WorkbenchFileChangeItem;
    lifecycle: WorkbenchTranscriptItemLifecycle;
    observedAt: number;
    itemPosition?: number;
    timeline?: WorkbenchThreadItemTimelineEntry;
  }
  | {
    kind: "questionnaire";
    publicItemId?: string;
    entry: WorkbenchQuestionnaireHistoryEntry;
    observedAt: number;
    itemPosition?: number;
  }
  | {
    kind: "steer";
    publicItemId?: string;
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
    kind: "turnCatalog";
    threadId: string;
    catalog: readonly Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" | "turn" }>[];
  }
  | {
    kind: "usageWindow";
    threadId: string;
    catalog: readonly Extract<WorkbenchTranscriptAtomicObservation, { kind: "thread" | "turn" }>[];
    observations: readonly Extract<WorkbenchTranscriptAtomicObservation, { kind: "turnUsageContext" | "turnTokenUsage" }>[];
  }
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
