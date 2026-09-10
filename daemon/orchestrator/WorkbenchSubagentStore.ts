/*
 * Exports:
 * - default WorkbenchSubagentStore: own durable relationships, reservations and cursor pages.
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

interface SubagentCursor {
  createdAt: number;
  parentThreadId: WorkbenchThreadId;
  projectId: ProjectId;
  threadId: WorkbenchThreadId;
  version: 2;
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function encodeCursor(record: WorkbenchSubagentRelationship): string {
  const cursor: SubagentCursor = {
    createdAt: record.createdAt,
    parentThreadId: record.parentThreadId,
    projectId: record.projectId,
    threadId: record.threadId,
    version: 2,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string, parentThreadId: WorkbenchThreadId, projectId: ProjectId): SubagentCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid subagent list cursor.");
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 2
    || parsed.parentThreadId !== parentThreadId
    || parsed.projectId !== projectId
    || typeof parsed.threadId !== "string"
    || !parsed.threadId
    || typeof parsed.createdAt !== "number"
    || !Number.isFinite(parsed.createdAt)
  ) {
    throw new Error("Invalid subagent list cursor.");
  }
  return {
    createdAt: parsed.createdAt, parentThreadId, projectId,
    threadId: z.string().brand<"WorkbenchThreadId">().parse(parsed.threadId), version: 2,
  };
}

export default class WorkbenchSubagentStore {
  constructor(private readonly persistence: WorkbenchSubagentPersistence) {}

  async list({ cursor, limit, parentThreadId, projectId }: {
    cursor?: string | null;
    limit?: number | null;
    parentThreadId?: WorkbenchThreadId | null;
    projectId: ProjectId;
  }) {
    const parent = parentThreadId ?? null;
    if (!parent) {
      if (cursor || limit != null) throw new Error("Subagent pagination requires parentThreadId.");
      return { nextCursor: null, subagents: await this.persistence.readSubagents({ projectId }) };
    }
    const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_PAGE_LIMIT) {
      throw new Error(`Subagent list limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    const after = cursor?.trim() ? decodeCursor(cursor.trim(), parent, projectId) : undefined;
    const records = await this.persistence.readSubagents({
      projectId, parentThreadId: parent, limit: pageLimit + 1,
      ...(after ? { after: { createdAt: after.createdAt, threadId: after.threadId } } : {}),
    });
    const subagents = records.slice(0, pageLimit);
    return {
      subagents,
      nextCursor: records.length > pageLimit ? encodeCursor(subagents[subagents.length - 1]!) : null,
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

