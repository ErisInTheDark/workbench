/*
 * Exports:
 * - WorkbenchThreadStateGlobalDocumentId: existing global layout document names.
 * - WorkbenchStoredThreadTitleHistory: distinct titles for one canonical thread.
 * - WorkbenchThreadStatePersistence: existing consumer document interface.
 * - WorkbenchThreadStateStoreDatabase: typed relational worker operations.
 * - default WorkbenchThreadStateStore: adapt consumer objects to relational persistence.
 */
import { z } from "zod";
import type { WorkbenchHarnessId } from "workbench-shared/workbench/thread/thread-state";
import type { WorkbenchThreadTitleHistoryEntry } from "workbench-shared/workbench/thread/thread-title-history";
import { ThreadDisplayLayoutSchema } from "workbench-shared/workbench/thread/thread-display-layout";
import { parseProjectDocument } from "./database/thread-state/workbench-thread-state-document-source";
import type {
  WorkbenchThreadStateProjectDocument, WorkbenchThreadStateGlobalDocument,
} from "./database/thread-state/workbench-thread-state-persistence";
import type { WorkbenchThreadStateRecord } from "./workbench-thread-state-record";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

export type WorkbenchThreadStateGlobalDocumentId = "homeDisplayOrder" | "pinnedLayout";

export interface WorkbenchStoredThreadTitleHistory {
  identity: { harness: WorkbenchHarnessId; threadId: WorkbenchThreadId };
  titles: WorkbenchThreadTitleHistoryEntry[];
}

export interface WorkbenchThreadStatePersistence {
  readNextArchiveEligibility(): Promise<number | null>;
  readArchiveEligible(activeBefore: number): Promise<Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }>>;
  readGlobal(id: WorkbenchThreadStateGlobalDocumentId): Promise<unknown | null>;
  readProject(projectId: ProjectId): Promise<unknown | null>;
  readTitleHistories(projectId: ProjectId): Promise<WorkbenchStoredThreadTitleHistory[]>;
  writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object): Promise<void>;
  writeProject(projectId: ProjectId, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]): Promise<void>;
}

export interface WorkbenchThreadStateStoreDatabase {
  readThreadStateArchiveDeadline(): Promise<number | null>;
  readThreadStateArchiveEligible(activeBefore: number): Promise<Array<{ projectId: ProjectId; record: WorkbenchThreadStateRecord }>>;
  readThreadStateProject(projectId: ProjectId): Promise<WorkbenchThreadStateProjectDocument>;
  readThreadStateTitleHistories(projectId: ProjectId): Promise<WorkbenchStoredThreadTitleHistory[]>;
  writeThreadStateProject(projectId: ProjectId, document: WorkbenchThreadStateProjectDocument, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]): Promise<void>;
  readThreadStateGlobal(id: WorkbenchThreadStateGlobalDocumentId): Promise<WorkbenchThreadStateGlobalDocument | null>;
  writeThreadStateGlobal(document: WorkbenchThreadStateGlobalDocument): Promise<void>;
}

const GlobalDocumentSchema = z.discriminatedUnion("id", [
  z.object({
    id: z.literal("homeDisplayOrder"), version: z.literal(1),
    revision: z.number().int().nonnegative(), displayOrder: ThreadDisplayLayoutSchema,
  }).strict(),
  z.object({
    id: z.literal("pinnedLayout"), version: z.literal(1),
    revision: z.number().int().nonnegative(), displayOrder: ThreadDisplayLayoutSchema,
    importedProjectIds: z.array(z.string().min(1).brand<"ProjectId">()),
  }).strict(),
]);

export default class WorkbenchThreadStateStore implements WorkbenchThreadStatePersistence {
  constructor(private readonly database: WorkbenchThreadStateStoreDatabase) {}

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

  async writeProject(projectId: ProjectId, document: object, titleHistories?: readonly WorkbenchStoredThreadTitleHistory[]) {
    const parsed = parseProjectDocument(JSON.stringify(document), projectId);
    await this.database.writeThreadStateProject(projectId, { version: 4, ...parsed }, titleHistories);
  }

  async readGlobal(id: WorkbenchThreadStateGlobalDocumentId) {
    const document = await this.database.readThreadStateGlobal(id);
    if (!document) return null;
    const { id: _id, ...body } = document;
    return body;
  }

  async writeGlobal(id: WorkbenchThreadStateGlobalDocumentId, document: object) {
    await this.database.writeThreadStateGlobal(GlobalDocumentSchema.parse({ ...document, id }));
  }
}
