/*
 * Exports:
 * - WorkbenchStoredThreadTitleHistory: distinct titles for one canonical thread.
 * - WorkbenchThreadStatePersistence: selected writes and existing read/repair interface.
 * - WorkbenchThreadStateStoreDatabase: typed relational worker operations.
 * - default WorkbenchThreadStateStore: adapt consumer objects to relational persistence.
 */
import type {
  WorkbenchHarnessId, WorkbenchProjectThreadSummary, WorkbenchThreadGitCommit, WorkbenchThreadGitCommitRef,
} from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadGitCommitTime } from "./database/thread-state/WorkbenchThreadStateGitRepository";
import type { WorkbenchThreadTitleHistoryEntry } from "workbench-shared/workbench/thread/thread-title-history";
import { parseProjectDocument } from "./database/thread-state/workbench-thread-state-document-source";
import type {
  WorkbenchThreadStateProjectDocument, WorkbenchThreadStateCommit,
} from "./database/thread-state/workbench-thread-state-persistence";
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

export interface WorkbenchStoredThreadTitleHistory {
  identity: { harness: WorkbenchHarnessId; threadId: WorkbenchThreadId };
  titles: WorkbenchThreadTitleHistoryEntry[];
}

export interface WorkbenchThreadStatePersistence {
  readNavigationSummary(projectId: ProjectId): Promise<WorkbenchProjectThreadSummary>;
  writeChanges(projectId: ProjectId, changes: Omit<WorkbenchThreadStateCommit, "projectId">): Promise<void>;
  readNextArchiveEligibility(): Promise<number | null>;
  readArchiveEligible(activeBefore: number): Promise<Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }>>;
  readProject(projectId: ProjectId): Promise<unknown | null>;
  readTitleHistories(projectId: ProjectId): Promise<WorkbenchStoredThreadTitleHistory[]>;
  /** Permanent accepted commits of just these threads; project reads never carry them. */
  readGitCommits(threadIds: readonly WorkbenchThreadId[]): Promise<Array<{ commits: WorkbenchThreadGitCommit[]; threadId: WorkbenchThreadId }>>;
  /** `readGitCommits` without commit messages, for counting and grouping. */
  readGitCommitRefs(threadIds: readonly WorkbenchThreadId[]): Promise<Array<{ commits: WorkbenchThreadGitCommitRef[]; threadId: WorkbenchThreadId }>>;
  recordGitCommitTimes(threadId: WorkbenchThreadId, times: readonly WorkbenchThreadGitCommitTime[]): Promise<void>;
  writeProject(projectId: ProjectId, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]): Promise<void>;
}

export interface WorkbenchThreadStateStoreDatabase {
  readThreadStateNavigationSummary(projectId: ProjectId): Promise<WorkbenchProjectThreadSummary>;
  commitThreadState(changes: WorkbenchThreadStateCommit): Promise<void>;
  readThreadStateArchiveDeadline(): Promise<number | null>;
  readThreadStateArchiveEligible(activeBefore: number): Promise<Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }>>;
  readThreadStateProject(projectId: ProjectId): Promise<WorkbenchThreadStateProjectDocument>;
  readThreadStateTitleHistories(projectId: ProjectId): Promise<WorkbenchStoredThreadTitleHistory[]>;
  readThreadGitCommits(threadIds: readonly WorkbenchThreadId[]): Promise<Array<{ commits: WorkbenchThreadGitCommit[]; threadId: WorkbenchThreadId }>>;
  readThreadGitCommitRefs(threadIds: readonly WorkbenchThreadId[]): Promise<Array<{ commits: WorkbenchThreadGitCommitRef[]; threadId: WorkbenchThreadId }>>;
  recordThreadGitCommitTimes(threadId: WorkbenchThreadId, times: readonly WorkbenchThreadGitCommitTime[]): Promise<void>;
  writeThreadStateProject(projectId: ProjectId, document: WorkbenchThreadStateProjectDocument, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]): Promise<void>;
}

export default class WorkbenchThreadStateStore implements WorkbenchThreadStatePersistence {
  constructor(private readonly database: WorkbenchThreadStateStoreDatabase) {}

  readNavigationSummary(projectId: ProjectId) {
    return this.database.readThreadStateNavigationSummary(projectId);
  }

  writeChanges(projectId: ProjectId, changes: Omit<WorkbenchThreadStateCommit, "projectId">) {
    return this.database.commitThreadState({ ...changes, projectId });
  }

  readNextArchiveEligibility() {
    return this.database.readThreadStateArchiveDeadline();
  }

  readArchiveEligible(activeBefore: number) {
    return this.database.readThreadStateArchiveEligible(activeBefore);
  }

  readProject(projectId: ProjectId) {
    return this.database.readThreadStateProject(projectId);
  }

  async readTitleHistories(projectId: ProjectId): Promise<WorkbenchStoredThreadTitleHistory[]> {
    return this.database.readThreadStateTitleHistories(projectId);
  }

  readGitCommits(threadIds: readonly WorkbenchThreadId[]) {
    return this.database.readThreadGitCommits(threadIds);
  }

  readGitCommitRefs(threadIds: readonly WorkbenchThreadId[]) {
    return this.database.readThreadGitCommitRefs(threadIds);
  }

  recordGitCommitTimes(threadId: WorkbenchThreadId, times: readonly WorkbenchThreadGitCommitTime[]) {
    return this.database.recordThreadGitCommitTimes(threadId, times);
  }

  async writeProject(projectId: ProjectId, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    const parsed = parseProjectDocument(JSON.stringify(document), projectId);
    await this.database.writeThreadStateProject(projectId, { version: 4, ...parsed }, titleHistories);
  }
}
