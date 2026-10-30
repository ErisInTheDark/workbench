/*
 * Exports:
 * - default WorkbenchSubagentStore: own durable reservations, exhaustive scoped relationship reads, remote children's reported
 *   settlement and remote-parented children's sibling rosters.
 */
import { z } from "zod";
import type { DaemonId, ProjectId, WorkbenchThreadId } from "workbench-shared/workbench/identity";
import type { SiblingRosterEntry } from "workbench-shared/workbench/network/network-remote-calls";

import type {
  WorkbenchSubagentRelationship,
} from "workbench-shared/types";
import {
  type WorkbenchSubagentReservation,
} from "./workbench-subagent-record";
import type { WorkbenchSubagentPersistence } from "../database/thread-state/workbench-thread-state-persistence";

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

  /** Records what a remote child's daemon last reported about its settlement, freeing its name once settled. */
  setRemoteSettled(parentThreadId: WorkbenchThreadId, threadId: WorkbenchThreadId, settledAt: number | null) {
    return this.persistence.setRemoteSubagentSettled(parentThreadId, threadId, settledAt);
  }

  writeRoster(threadId: WorkbenchThreadId, siblings: readonly SiblingRosterEntry[]) {
    return this.persistence.writeSubagentRoster(threadId, siblings);
  }

  readRoster(threadId: WorkbenchThreadId) {
    return this.persistence.readSubagentRoster(threadId);
  }

  /** Local parents of a child that lives on `daemonId`. */
  parentsOfRemoteChild(daemonId: DaemonId, threadId: WorkbenchThreadId) {
    return this.persistence.readRemoteSubagentParents(daemonId, threadId);
  }
}

