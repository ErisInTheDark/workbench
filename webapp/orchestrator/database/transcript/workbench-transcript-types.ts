/*
 * WorkbenchTranscriptObservation: harness-neutral durable transcript input accepted in queue order. Keywords: transcript, observation, recorder.
 * WorkbenchTranscriptSettlement: semantic commit result used to refresh subscriptions. Keywords: transcript, settlement, subscription.
 * WorkbenchTranscriptReadRequest/WorkbenchTranscriptSnapshot/WorkbenchTranscriptSnapshotRows: shared hydration-bounded relational read contract re-exports. Keywords: transcript, snapshot, hydration.
 */
import type { ThreadItem } from "../../../lib/codex/generated/app-server/v2/ThreadItem.ts";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchQuestionnaireHistoryEntry,
  WorkbenchSteerHistoryEntry,
} from "../../../lib/types.ts";
import type { WorkbenchThreadItemTimelineEntry } from "../../../lib/workbench/thread/thread-item-timeline.ts";
import type { WorkbenchFileChangeItem } from "../../../lib/workbench/thread/workbench-file-change.ts";
import type { CoreSchemaRows } from "../../../lib/workbench/database/schema/core-schema.ts";
import type { EvidenceSchemaRows } from "../../../lib/workbench/database/schema/evidence-schema.ts";
export type {
  WorkbenchTranscriptReadRequest,
  WorkbenchTranscriptSnapshot,
  WorkbenchTranscriptSnapshotRows,
} from "../../../lib/workbench/database/transcript/workbench-transcript-contract.ts";

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
    itemIndex?: number;
    timeline?: WorkbenchThreadItemTimelineEntry;
  }
  | {
    kind: "questionnaire";
    entry: WorkbenchQuestionnaireHistoryEntry;
    observedAt: number;
    itemIndex?: number;
  }
  | {
    kind: "steer";
    entry: WorkbenchSteerHistoryEntry;
    observedAt: number;
    itemIndex?: number;
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

export type WorkbenchTranscriptObservation =
  | WorkbenchTranscriptAtomicObservation
  | {
    kind: "canonicalSnapshot";
    contentVersion: number;
    threadId: string;
    observations: readonly WorkbenchTranscriptAtomicObservation[];
  };

export interface WorkbenchTranscriptSettlement {
  changedThreadIds: string[];
}
