/*
 * Exports:
 * - WorkbenchStoredThreadDraft: draft body and its persistent sidebar flags.
 * - WorkbenchThreadStateCommit: changed facts committed together before publication.
 * - WorkbenchThreadRecordQuery: project-qualified live, history or explicit-record selection.
 * - WorkbenchThreadStateProjectDocument/WorkbenchThreadStateGlobalDocument: assembled consumer documents, never stored JSON blobs.
 * - WorkbenchThreadStatePersistence: typed worker boundary; all thread and turn references are canonical.
 * - WorkbenchSubagentRelationshipRead/WorkbenchSubagentPersistence: scoped membership reads and atomic parent allocation.
 */
import type {
  WorkbenchComposerProfileSelectionState, WorkbenchThreadDraft,
} from "workbench-shared/workbench/thread/thread-state";
import type { ThreadDisplayLayout } from "workbench-shared/workbench/thread/thread-display-layout";
import type { WorkbenchThreadStateRecord } from "../../workbench-thread-state-record";
import type { WorkbenchThreadLayoutOwner } from "./WorkbenchThreadStateLayoutRepository";
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { WorkbenchSubagentReservation } from "../../workbench-subagent-record";
import type { ProjectDocument } from "./workbench-thread-state-document-source";
import type { DraftId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

export type WorkbenchThreadStateProjectDocument = ProjectDocument & { version: 4 };
export type WorkbenchThreadStateGlobalDocument =
  | { id: "homeDisplayOrder"; version: 1; revision: number; displayOrder: ThreadDisplayLayout }
  | { id: "pinnedLayout"; version: 1; revision: number; displayOrder: ThreadDisplayLayout; importedProjectIds: ProjectId[] };

export interface WorkbenchSubagentRelationshipRead {
  projectId: ProjectId;
  parentThreadId?: WorkbenchThreadId;
  after?: { createdAt: number; threadId: WorkbenchThreadId };
  limit?: number;
}

export interface WorkbenchSubagentPersistence {
  readSubagents(query: WorkbenchSubagentRelationshipRead): Promise<WorkbenchSubagentRelationship[]>;
  readOwnedSubagents(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadIds: readonly WorkbenchThreadId[]): Promise<WorkbenchSubagentRelationship[] | null>;
  reserveSubagent(record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">): Promise<WorkbenchSubagentReservation>;
  activateSubagent(parentThreadId: WorkbenchThreadId, reservationId: string, record: WorkbenchSubagentRelationship): Promise<void>;
  removeSubagent(parentThreadId: WorkbenchThreadId, identifier: string): Promise<void>;
}

export interface WorkbenchStoredThreadDraft {
  draft: WorkbenchThreadDraft;
  pinned: boolean;
  snoozed: boolean;
}

export interface WorkbenchThreadStateCommit {
  projectId?: ProjectId;
  records?: readonly WorkbenchThreadStateRecord[];
  deletedThreadIds?: readonly WorkbenchThreadId[];
  drafts?: readonly WorkbenchStoredThreadDraft[];
  deletedDraftIds?: readonly DraftId[];
  projectProfiles?: readonly { projectId: ProjectId; profile: WorkbenchComposerProfileSelectionState | null }[];
  layouts?: readonly { owner: WorkbenchThreadLayoutOwner; revision: number; displayOrder: ThreadDisplayLayout }[];
  pinnedImports?: readonly ProjectId[];
}

export type WorkbenchThreadRecordQuery =
  | { selection: "live"; projectId: ProjectId }
  | { selection: "threads"; threadIds: readonly WorkbenchThreadId[]; projectId?: ProjectId }
  | { selection: "children"; parentThreadId: WorkbenchThreadId }
  | { selection: "parentStatus"; parentThreadIds: readonly WorkbenchThreadId[] }
  | { selection: "gitRetention"; projectId: ProjectId; settledBefore: number }
  | { selection: "project"; projectId: ProjectId };

export interface WorkbenchThreadStatePersistence {
  readRecords(query: WorkbenchThreadRecordQuery): Promise<WorkbenchThreadStateRecord[]>;
  readProjectActivity(projectId: ProjectId): Promise<number | null>;
  readSnoozeSources(targetThreadId: WorkbenchThreadId): Promise<Array<{ projectId: ProjectId; threadId: WorkbenchThreadId }>>;
  readDrafts(projectId: ProjectId): Promise<WorkbenchStoredThreadDraft[]>;
  readProjectProfile(projectId: ProjectId): Promise<WorkbenchComposerProfileSelectionState | null>;
  readLayout(owner: WorkbenchThreadLayoutOwner): Promise<{ revision: number; displayOrder: ThreadDisplayLayout } | null>;
  readPinnedImports(): Promise<ProjectId[]>;
  readNextArchiveEligibility(): Promise<number | null>;
  readArchiveEligible(activeBefore: number): Promise<Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }>>;
  commit(changes: WorkbenchThreadStateCommit): Promise<void>;
}
