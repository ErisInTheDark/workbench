/*
 * Exports:
 * - WorkbenchTranscriptItemLifecycle: durable lifecycle values shared by item transforms.
 * - WorkbenchTranscriptAtomicObservation: one source-owned semantic transcript or turn-usage fact.
 * - WorkbenchTranscriptCaptureGapObservation: one turn-anchored failed capture opening, or re-read anchors reconciling it.
 * - WorkbenchTranscriptProviderTurnScopeObservation: one complete provider-owned turn replacement boundary.
 * - WorkbenchTranscriptContextCompactionObservation: one provider report that context compaction started or ended.
 * - WorkbenchTranscriptAbandonedHoldsObservation: cold-start retirement of held steers and compactions a previous daemon left on settled turns.
 * - WorkbenchTranscriptObservation: ordered transcript input, metadata-only catalogs and restricted usage windows.
 * - NativeTranscriptAtomicObservation/NativeTranscriptObservation: provider-addressed facts before canonical mapping.
 * - WorkbenchTranscriptRecordingContext: fact ownership and provider-recovery boundary for one settlement.
 * - WorkbenchTranscriptSettlement: semantic commit result used to refresh subscriptions.
 * - WorkbenchTranscriptReadRequest: bounded relational read request.
 * - WorkbenchTranscriptSnapshot: hydrated transcript result.
 * - WorkbenchTranscriptContextSnapshot: interaction bodies with full item-order metadata.
 * - WorkbenchTranscriptSnapshotRows: typed canonical rows.
 * - WorkbenchTranscriptItemSource: provider-scoped item identity evidence with relational component coordinates.
 * - WorkbenchTranscriptItemIdentityAdmission: one structural identity admission, independent of body recording.
 * - WorkbenchTranscriptItemIdentityLookup: public-first, thread-scoped item lookup.
 * - WorkbenchTranscriptItemIdentity: resolved public identity and private alias evidence.
 * - WorkbenchTranscriptIdentityDatabase: structural identity operations on the existing database worker.
 */
import type { ThreadItem } from "workbench-shared/workbench/thread/workbench-thread-items";
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
  reference: string;
  component?: {
    kind: "item" | "text" | "reasoning";
    index: number;
  };
}

export interface WorkbenchTranscriptItemIdentityAdmission {
  threadId: WorkbenchThreadId;
  itemId?: WorkbenchItemId;
  sources: readonly WorkbenchTranscriptItemSource[];
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

export type WorkbenchTranscriptCaptureGapObservation<ThreadId extends string = WorkbenchThreadId, TurnId extends string = WorkbenchTurnId> = {
  errorText: string;
  gapId: string;
  kind: "captureGap";
  openedAt: number;
  reason: string;
  threadId: ThreadId;
  /**
   * Opening: turns the failed capture named; stored turns among them anchor the gap, else the thread's latest turn does.
   * Reconciling: turns a provider window just re-read; matching anchors reconcile, and the gap closes once none remain.
   */
  turnIds: readonly TurnId[];
} & ({ state: "open"; closedAt: null } | { state: "reconciled" | "unrecoverable"; closedAt: number });

/**
 * A provider's live report that context compaction started or ended. Workbench owns the resulting item: it
 * resolves the thread's open compaction, its status and its timeline; native echoes fold into it by reference.
 */
export interface WorkbenchTranscriptContextCompactionObservation<ThreadId extends string = WorkbenchThreadId, TurnId extends string = WorkbenchTurnId> {
  kind: "contextCompaction";
  /** Canonical marker selected by Workbench before provider execution. */
  itemId?: WorkbenchItemId;
  threadId: ThreadId;
  turnId: TurnId;
  phase: "started" | "completed" | "failed";
  observedAt: number;
  /** The provider's own compaction id, when it has one; echoes with this id are the same compaction. */
  reference: string | null;
  /** Provider-measured duration; dates the start when Workbench never saw one. */
  durationMs?: number | null;
  /** Native maintenance execution evidence; it never becomes a canonical conversation turn. */
  execution?: {
    harnessId: string;
    nativeLocation: string;
    nativeThreadId: NativeThreadId;
    nativeTurnId: NativeTurnId;
  };
}

/**
 * A cold start's retirement of what a previous daemon left waiting on settled turns: pending held steers become
 * undelivered and running compactions interrupted. Only holds created before `before` count, so live work survives.
 * `compactionQueue` retires only compaction-queue holds no owner delivers, whatever questionnaire waits.
 */
export interface WorkbenchTranscriptAbandonedHoldsObservation<ThreadId extends string = WorkbenchThreadId> {
  kind: "abandonedHolds";
  threadId: ThreadId;
  before: number;
  endedAt: number;
  scope?: "compactionQueue";
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
  | WorkbenchTranscriptContextCompactionObservation<ThreadId, TurnId>
  | WorkbenchTranscriptAbandonedHoldsObservation<ThreadId>
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
/** Abandoned-hold retirement is Workbench-owned; providers never report it. */
export type NativeTranscriptObservation = Exclude<WorkbenchTranscriptObservation<NativeThreadId, NativeTurnId>, { kind: "abandonedHolds" }>;

export interface WorkbenchTranscriptRecordingContext {
  /** `explicit`: a caller demanded these turns by name, so turns expired by retention are recovered too. */
  recovery?: { gapIds: readonly string[]; explicit?: true };
  source: "compatibility" | "provider" | "workbench";
}

/** `explicitRecovery` replays like `replay`, and first lifts retention tombstones from the turns its windows re-read. */
export type WorkbenchTranscriptSettlementMode = "live" | "replay" | "explicitRecovery";

export interface WorkbenchTranscriptCompactionCompletion {
  itemId: WorkbenchItemId;
  threadId: WorkbenchThreadId;
  turnId: WorkbenchTurnId;
  usage: ThreadContextUsageSnapshot | null;
}

export interface WorkbenchTranscriptSettlement {
  changedThreadIds: string[];
  /** Present on real repository settlements; optional for compatibility with older reload generations and test ports. */
  compactionCompletions?: WorkbenchTranscriptCompactionCompletion[];
  changes?: {
    snapshot: WorkbenchTranscriptSnapshot;
    removedItemIds: string[];
    completedItemIds: string[];
    /** Latest observed time among thread items this settlement newly admitted; null when none were. */
    itemActivityAt: number | null;
  }[];
}
