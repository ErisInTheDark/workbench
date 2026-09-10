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

export type WorkbenchThreadStateProjectDocument = ProjectDocument & { version: 4 };
export type WorkbenchThreadStateGlobalDocument =
  | { id: "homeDisplayOrder"; version: 1; revision: number; displayOrder: ThreadDisplayLayout }
  | { id: "pinnedLayout"; version: 1; revision: number; displayOrder: ThreadDisplayLayout; importedProjectIds: string[] };

export interface WorkbenchSubagentRelationshipRead {
  projectId: string;
  parentThreadId?: string;
  after?: { createdAt: number; threadId: string };
  limit?: number;
}

export interface WorkbenchSubagentPersistence {
  readSubagents(query: WorkbenchSubagentRelationshipRead): Promise<WorkbenchSubagentRelationship[]>;
  readOwnedSubagents(parentThreadId: string, projectId: string, threadIds: readonly string[]): Promise<WorkbenchSubagentRelationship[] | null>;
  reserveSubagent(record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">): Promise<WorkbenchSubagentReservation>;
  activateSubagent(parentThreadId: string, reservationId: string, record: WorkbenchSubagentRelationship): Promise<void>;
  removeSubagent(parentThreadId: string, identifier: string): Promise<void>;
}

export interface WorkbenchStoredThreadDraft {
  draft: WorkbenchThreadDraft;
  pinned: boolean;
  snoozed: boolean;
}

export interface WorkbenchThreadStateCommit {
  records?: readonly WorkbenchThreadStateRecord[];
  deletedThreadIds?: readonly string[];
  drafts?: readonly WorkbenchStoredThreadDraft[];
  deletedDraftIds?: readonly string[];
  projectProfiles?: readonly { projectId: string; profile: WorkbenchComposerProfileSelectionState | null }[];
  layouts?: readonly { owner: WorkbenchThreadLayoutOwner; revision: number; displayOrder: ThreadDisplayLayout }[];
  pinnedImports?: readonly string[];
}

export type WorkbenchThreadRecordQuery =
  | { selection: "live"; projectId: string }
  | { selection: "threads"; threadIds: readonly string[]; projectId?: string }
  | { selection: "children"; parentThreadId: string }
  | { selection: "parentStatus"; parentThreadIds: readonly string[] }
  | { selection: "gitRetention"; projectId: string; settledBefore: number }
  | { selection: "project"; projectId: string };

export interface WorkbenchThreadStatePersistence {
  readRecords(query: WorkbenchThreadRecordQuery): Promise<WorkbenchThreadStateRecord[]>;
  readProjectActivity(projectId: string): Promise<number | null>;
  readSnoozeSources(targetThreadId: string): Promise<Array<{ projectId: string; threadId: string }>>;
  readDrafts(projectId: string): Promise<WorkbenchStoredThreadDraft[]>;
  readProjectProfile(projectId: string): Promise<WorkbenchComposerProfileSelectionState | null>;
  readLayout(owner: WorkbenchThreadLayoutOwner): Promise<{ revision: number; displayOrder: ThreadDisplayLayout } | null>;
  readPinnedImports(): Promise<string[]>;
  readNextArchiveEligibility(): Promise<number | null>;
  readArchiveEligible(activeBefore: number): Promise<Array<{ projectId: string; record: WorkbenchThreadStateRecord }>>;
  commit(changes: WorkbenchThreadStateCommit): Promise<void>;
}
