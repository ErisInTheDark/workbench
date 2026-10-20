/*
 * Exports:
 * - threadStateRequests: database requests for relational thread state (project and global documents, records, drafts, profiles, layouts,
 *   archive facts, Git commits) and subagent relationships; each runs in its own transaction.
 */
import type { WorkbenchSubagentRelationship } from "workbench-shared/types";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { WorkbenchSubagentReservation } from "../../workbench-subagent-record.ts";
import type { WorkbenchStoredThreadTitleHistory } from "../../WorkbenchThreadStateStore.ts";
import WorkbenchSubagentRelationshipRepository from "../thread-state/WorkbenchSubagentRelationshipRepository.ts";
import type { WorkbenchThreadGitCommitTime } from "../thread-state/WorkbenchThreadStateGitRepository.ts";
import type { WorkbenchThreadLayoutOwner } from "../thread-state/WorkbenchThreadStateLayoutRepository.ts";
import type {
  WorkbenchSubagentRelationshipRead,
  WorkbenchThreadRecordQuery,
  WorkbenchThreadStateCommit,
  WorkbenchThreadStateGlobalDocument,
  WorkbenchThreadStateProjectDocument,
} from "../thread-state/workbench-thread-state-persistence.ts";
import { defineDatabaseRequest, type WorkbenchDatabaseWorkerContext } from "./define-database-request.ts";

type ThreadState = WorkbenchDatabaseWorkerContext["threadState"];

function inTransaction<Result>(context: WorkbenchDatabaseWorkerContext, run: (threadState: ThreadState) => Result) {
  return context.database.transaction(() => run(context.threadState))();
}

function subagents<Result>(context: WorkbenchDatabaseWorkerContext, run: (repository: WorkbenchSubagentRelationshipRepository) => Result) {
  const repository = new WorkbenchSubagentRelationshipRepository(context.database);
  return context.database.transaction(() => run(repository))();
}

const stateRead = { read: "core", ordering: "threadStateRead" } as const;

export const threadStateRequests = {
  readThreadStateNavigationSummary: defineDatabaseRequest({
    ...stateRead, run: (context, projectId: ProjectId) => inTransaction(context, state => state.readNavigationSummary(projectId)),
  }),
  readThreadStateProject: defineDatabaseRequest({
    ...stateRead, run: (context, projectId: ProjectId) => inTransaction(context, state => state.readProject(projectId)),
  }),
  readThreadStateTitleHistories: defineDatabaseRequest({
    ...stateRead, run: (context, projectId: ProjectId) => inTransaction(context, state => state.readTitleHistories(projectId)),
  }),
  readThreadStateGlobal: defineDatabaseRequest({
    ...stateRead, run: (context, documentId: WorkbenchThreadStateGlobalDocument["id"]) => inTransaction(context, state => state.readGlobal(documentId)),
  }),
  readThreadStateRecords: defineDatabaseRequest({
    ...stateRead, run: (context, query: WorkbenchThreadRecordQuery) => inTransaction(context, state => state.readRecords(query)),
  }),
  readThreadStateDrafts: defineDatabaseRequest({
    ...stateRead, run: (context, projectId: ProjectId) => inTransaction(context, state => state.readDrafts(projectId)),
  }),
  readThreadStateProfile: defineDatabaseRequest({
    ...stateRead, run: (context, projectId: ProjectId) => inTransaction(context, state => state.readProjectProfile(projectId)),
  }),
  readThreadStateLayout: defineDatabaseRequest({
    ...stateRead, run: (context, owner: WorkbenchThreadLayoutOwner) => inTransaction(context, state => state.readLayout(owner)),
  }),
  readThreadStatePinnedImports: defineDatabaseRequest({
    ...stateRead, run: context => inTransaction(context, state => state.readPinnedImports()),
  }),
  readThreadStateArchiveDeadline: defineDatabaseRequest({
    ...stateRead, run: context => inTransaction(context, state => state.readNextArchiveEligibility()),
  }),
  readThreadStateActivity: defineDatabaseRequest({
    ...stateRead, run: (context, projectId: ProjectId) => inTransaction(context, state => state.readProjectActivity(projectId)),
  }),
  readThreadStateArchiveEligible: defineDatabaseRequest({
    ...stateRead, run: (context, activeBefore: number) => inTransaction(context, state => state.readArchiveEligible(activeBefore)),
  }),
  writeThreadStateProject: defineDatabaseRequest({
    ordering: "threadStateWrite",
    run: (context, projectId: ProjectId, document: WorkbenchThreadStateProjectDocument, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) => {
      inTransaction(context, state => state.writeProject(projectId, document, titleHistories));
    },
  }),
  writeThreadStateGlobal: defineDatabaseRequest({
    ordering: "threadStateWrite",
    run: (context, document: WorkbenchThreadStateGlobalDocument) => { inTransaction(context, state => state.writeGlobal(document)); },
  }),
  commitThreadState: defineDatabaseRequest({
    ordering: "threadStateWrite",
    run: (context, changes: WorkbenchThreadStateCommit) => { inTransaction(context, state => state.commit(changes)); },
  }),
  readThreadGitCommits: defineDatabaseRequest({
    read: "core",
    run: (context, threadIds: readonly WorkbenchThreadId[]) => inTransaction(context, state => state.readGitCommits(threadIds)),
    local: threadIds => threadIds.length ? undefined : { value: [] },
  }),
  recordThreadGitCommitTimes: defineDatabaseRequest({
    run: (context, threadId: WorkbenchThreadId, times: readonly WorkbenchThreadGitCommitTime[]) => {
      inTransaction(context, state => state.recordGitCommitTimes(threadId, times));
    },
    local: (_threadId, times) => times.length ? undefined : { value: undefined },
  }),
  findThreadGitCommitOwners: defineDatabaseRequest({
    read: "core",
    run: (context, projectId: ProjectId, commitSha: string) => inTransaction(context, state => state.findGitCommitOwners(projectId, commitSha)),
  }),
  readSubagents: defineDatabaseRequest({
    read: "core",
    run: (context, query: WorkbenchSubagentRelationshipRead) => subagents(context, repository => {
      const records = repository.read(query);
      if (records === null) throw new Error("Unexpected subagent list response.");
      return records;
    }),
  }),
  readOwnedSubagents: defineDatabaseRequest({
    read: "core",
    run: (context, parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadIds: readonly WorkbenchThreadId[]) => (
      subagents(context, repository => repository.getOwnedMany(parentThreadId, projectId, threadIds))
    ),
  }),
  reserveSubagent: defineDatabaseRequest({
    run: (context, record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">) => subagents(context, repository => repository.reserve(record)),
  }),
  activateSubagent: defineDatabaseRequest({
    run: (context, parentThreadId: WorkbenchThreadId, reservationId: string, record: WorkbenchSubagentRelationship) => {
      subagents(context, repository => repository.activate(parentThreadId, reservationId, record));
    },
  }),
  removeSubagent: defineDatabaseRequest({
    run: (context, parentThreadId: WorkbenchThreadId, identifier: string) => {
      subagents(context, repository => repository.remove(parentThreadId, identifier));
    },
  }),
};
