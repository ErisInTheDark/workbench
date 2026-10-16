/*
 * Exports:
 * - default WorkbenchSubagentStore: own durable reservations and exhaustive scoped relationship reads.
 */
import { z } from "zod";
import type { ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";

import type {
  WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import {
  type WorkbenchSubagentReservation,
} from "./workbench-subagent-record";
import type { WorkbenchSubagentPersistence } from "./database/thread-state/workbench-thread-state-persistence";

export default class WorkbenchSubagentStore {
  constructor(private readonly persistence: WorkbenchSubagentPersistence) {}

  async list({ parentThreadId, projectId }: {
    parentThreadId?: WorkbenchThreadId | null;
    projectId: ProjectId;
  }) {
    return {
      subagents: await this.persistence.readSubagents({
        projectId, ...(parentThreadId ? { parentThreadId } : {}),
      }),
    };
  }

  reserve(record: Omit<WorkbenchSubagentReservation, "directSubagentIndex">) {
    z.uuid().parse(record.reservationId);
    return this.persistence.reserveSubagent(record);
  }

  replace(parentThreadId: WorkbenchThreadId, reservationId: string, record: WorkbenchSubagentRelationship) {
    return this.persistence.activateSubagent(parentThreadId, reservationId, record);
  }

  remove(parentThreadId: WorkbenchThreadId, identifier: string) {
    return this.persistence.removeSubagent(parentThreadId, identifier);
  }

  async getOwned(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadId: WorkbenchThreadId) {
    return (await this.persistence.readOwnedSubagents(parentThreadId, projectId, [threadId]))?.[0] ?? null;
  }

  getOwnedMany(parentThreadId: WorkbenchThreadId, projectId: ProjectId, threadIds: readonly WorkbenchThreadId[]) {
    return this.persistence.readOwnedSubagents(parentThreadId, projectId, threadIds);
  }
}

