/*
 * Exports:
 * - default WorkbenchSubagentStore: own parent-scoped durable subagent metadata, legacy migration, activity transitions, and bounded cursor pages. Keywords: subagent, store, parent, activity, pagination, migration.
 */
import fs from "node:fs/promises";
import path from "node:path";

import type {
  WorkbenchHarness,
  WorkbenchSubagentPage,
  WorkbenchSubagentRelationship,
  WorkbenchSubagentSummary,
} from "../lib/types";
import AtomicJsonStore from "./AtomicJsonStore";
import type { HarnessKind, JsonRpcNotification } from "./bridge-types";
import { encodeTranscriptPathSegment } from "./codex-transcript-normalizers";

interface StoredParentSubagents {
  nextDirectSubagentIndex: number;
  parentThreadId: string;
  schemaVersion: 3;
  subagents: Record<string, WorkbenchSubagentRelationship>;
}

type WorkbenchSubagentReservation = Omit<WorkbenchSubagentRelationship, "directSubagentIndex">;

interface SubagentCursor {
  activityStatus: WorkbenchSubagentSummary["activityStatus"];
  createdAt: number;
  lastActivityAt: number;
  parentThreadId: string;
  projectId: string;
  threadId: string;
  version: 1;
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 20;
const LOAD_CONCURRENCY = 8;
const ACTIVITY_WRITE_COALESCE_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeActivityStatus(value: unknown): WorkbenchSubagentRelationship["activityStatus"] {
  return value === "active" || value === "inactive" ? value : "unknown";
}

function normalizeSummary(value: unknown): WorkbenchSubagentRelationship | null {
  if (!isRecord(value)) return null;
  const harness = value.harness === "codex" || value.harness === "copilot" || value.harness === "opencode"
    ? value.harness
    : null;
  const strings = ["cwd", "name", "parentThreadId", "profileId", "profileName", "projectId", "threadId", "title"] as const;
  if (!harness || strings.some((key) => typeof value[key] !== "string" || !String(value[key]).trim())) return null;
  const createdAt = finiteNumber(value.createdAt, 0);
  const updatedAt = finiteNumber(value.updatedAt, createdAt);
  return {
    activityStatus: normalizeActivityStatus(value.activityStatus),
    createdAt,
    cwd: String(value.cwd),
    directSubagentIndex: Number.isSafeInteger(value.directSubagentIndex) && Number(value.directSubagentIndex) >= 0
      ? Number(value.directSubagentIndex)
      : -1,
    harness,
    lastActivityAt: finiteNumber(value.lastActivityAt, updatedAt),
    name: String(value.name),
    parentThreadId: String(value.parentThreadId),
    profileId: String(value.profileId),
    profileName: String(value.profileName),
    projectId: String(value.projectId),
    threadId: String(value.threadId),
    title: String(value.title),
    updatedAt,
  };
}

function activityRank(status: WorkbenchSubagentRelationship["activityStatus"]) {
  return status === "active" ? 0 : status === "unknown" ? 1 : 2;
}

function compareSubagents(left: WorkbenchSubagentRelationship, right: WorkbenchSubagentRelationship) {
  return activityRank(left.activityStatus) - activityRank(right.activityStatus)
    || right.lastActivityAt - left.lastActivityAt
    || right.createdAt - left.createdAt
    || left.threadId.localeCompare(right.threadId);
}

function compareSubagentToCursor(record: WorkbenchSubagentRelationship, cursor: SubagentCursor) {
  return activityRank(record.activityStatus) - activityRank(cursor.activityStatus)
    || cursor.lastActivityAt - record.lastActivityAt
    || cursor.createdAt - record.createdAt
    || record.threadId.localeCompare(cursor.threadId);
}

function encodeCursor(record: WorkbenchSubagentRelationship): string {
  const cursor: SubagentCursor = {
    activityStatus: record.activityStatus,
    createdAt: record.createdAt,
    lastActivityAt: record.lastActivityAt,
    parentThreadId: record.parentThreadId,
    projectId: record.projectId,
    threadId: record.threadId,
    version: 1,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function stabilizeDirectSubagentIndexes(records: readonly WorkbenchSubagentRelationship[]) {
  const sorted = records.slice().sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId));
  const validIndexes = sorted
    .map(({ directSubagentIndex }) => directSubagentIndex)
    .filter((index) => index >= 0);
  let nextIndex = validIndexes.length ? Math.max(...validIndexes) + 1 : 0;
  const seenIndexes = new Set<number>();
  const recordsByThreadId = new Map<string, WorkbenchSubagentRelationship>();
  for (const record of sorted) {
    const directSubagentIndex = record.directSubagentIndex >= 0 && !seenIndexes.has(record.directSubagentIndex)
      ? record.directSubagentIndex
      : nextIndex++;
    seenIndexes.add(directSubagentIndex);
    recordsByThreadId.set(record.threadId, { ...record, directSubagentIndex });
  }
  return {
    nextDirectSubagentIndex: Math.max(nextIndex, ...Array.from(seenIndexes, (index) => index + 1), 0),
    records: records.map((record) => recordsByThreadId.get(record.threadId)!),
  };
}

function decodeCursor(value: string, parentThreadId: string, projectId: string): SubagentCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid subagent list cursor.");
  }
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || parsed.parentThreadId !== parentThreadId
    || parsed.projectId !== projectId
    || typeof parsed.threadId !== "string"
    || !parsed.threadId
    || (parsed.activityStatus !== "active" && parsed.activityStatus !== "inactive" && parsed.activityStatus !== "unknown")
    || typeof parsed.createdAt !== "number"
    || !Number.isFinite(parsed.createdAt)
    || typeof parsed.lastActivityAt !== "number"
    || !Number.isFinite(parsed.lastActivityAt)
  ) {
    throw new Error("Invalid subagent list cursor.");
  }
  return parsed as unknown as SubagentCursor;
}

async function mapWithConcurrency<T>(values: readonly T[], concurrency: number, operation: (value: T) => Promise<void>) {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex++];
      if (value !== undefined) await operation(value);
    }
  }));
}

export default class WorkbenchSubagentStore {
  private readonly childParents = new Map<string, string>();
  private readonly directoryPath: string;
  private initializationPromise: Promise<void> | null = null;
  private readonly jsonStore: AtomicJsonStore;
  private readonly legacyPath: string;
  private readonly nextDirectSubagentIndexes = new Map<string, number>();
  private readonly parents = new Map<string, Map<string, WorkbenchSubagentRelationship>>();

  constructor(storageRoot: string, jsonStore = new AtomicJsonStore()) {
    const runtimePath = path.join(storageRoot, ".workbench", "runtime");
    this.directoryPath = path.join(runtimePath, "subagents");
    this.legacyPath = path.join(runtimePath, "subagents.json");
    this.jsonStore = jsonStore;
  }

  initialize() {
    this.initializationPromise ??= this.initializeStore();
    return this.initializationPromise;
  }

  async list({
    cursor,
    limit,
    parentThreadId,
    projectId,
  }: {
    cursor?: string | null;
    limit?: number | null;
    parentThreadId?: string | null;
    projectId: string;
  }): Promise<WorkbenchSubagentPage> {
    await this.initialize();
    const normalizedParentThreadId = parentThreadId?.trim() ?? "";
    if (!normalizedParentThreadId) {
      if (cursor || limit !== null && limit !== undefined) throw new Error("Subagent pagination requires parentThreadId.");
      const subagents = Array.from(this.parents.values())
        .flatMap((records) => Array.from(records.values()))
        .filter((record) => record.projectId === projectId && !record.threadId.startsWith("pending:"))
        .sort((left, right) => left.createdAt - right.createdAt || left.threadId.localeCompare(right.threadId));
      return { nextCursor: null, subagents };
    }

    const pageLimit = limit ?? DEFAULT_PAGE_LIMIT;
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > MAX_PAGE_LIMIT) {
      throw new Error(`Subagent list limit must be between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    const records = Array.from(this.parents.get(normalizedParentThreadId)?.values() ?? [])
      .filter((record) => record.projectId === projectId && !record.threadId.startsWith("pending:"))
      .sort(compareSubagents);
    const decodedCursor = cursor?.trim() ? decodeCursor(cursor.trim(), normalizedParentThreadId, projectId) : null;
    const startIndex = decodedCursor
      ? (() => {
        const index = records.findIndex((record) => compareSubagentToCursor(record, decodedCursor) > 0);
        return index < 0 ? records.length : index;
      })()
      : 0;
    const subagents = records.slice(startIndex, startIndex + pageLimit);
    const hasMore = startIndex + subagents.length < records.length;
    return {
      nextCursor: hasMore && subagents.length ? encodeCursor(subagents[subagents.length - 1]!) : null,
      subagents,
    };
  }

  async reserve(record: WorkbenchSubagentReservation) {
    await this.initialize();
    const records = this.parentRecords(record.parentThreadId);
    if (Array.from(records.values()).some((entry) => entry.name.toLocaleLowerCase() === record.name.toLocaleLowerCase())) {
      throw new Error(`Subagent name is already in use by this parent: ${record.name}`);
    }
    const indexedRecord: WorkbenchSubagentRelationship = {
      ...record,
      directSubagentIndex: this.nextDirectSubagentIndex(record.parentThreadId),
    };
    records.set(record.threadId, indexedRecord);
    this.childParents.set(record.threadId, record.parentThreadId);
    await this.persistParent(record.parentThreadId);
    return indexedRecord;
  }

  async replace(parentThreadId: string, previousThreadId: string, record: WorkbenchSubagentRelationship) {
    await this.initialize();
    const records = this.parentRecords(parentThreadId);
    records.delete(previousThreadId);
    this.childParents.delete(previousThreadId);
    records.set(record.threadId, record);
    this.childParents.set(record.threadId, parentThreadId);
    await this.persistParent(parentThreadId);
  }

  async remove(parentThreadId: string, threadId: string) {
    await this.initialize();
    const records = this.parents.get(parentThreadId);
    if (!records?.delete(threadId)) return;
    this.childParents.delete(threadId);
    await this.persistParent(parentThreadId);
  }

  async getOwned(parentThreadId: string, projectId: string, threadId: string) {
    await this.initialize();
    const record = this.parents.get(parentThreadId)?.get(threadId) ?? null;
    return record?.projectId === projectId ? record : null;
  }

  async getOwnedMany(parentThreadId: string, projectId: string, threadIds: readonly string[]) {
    const records = await Promise.all(threadIds.map((threadId) => this.getOwned(parentThreadId, projectId, threadId)));
    return records.every((record): record is WorkbenchSubagentRelationship => Boolean(record)) ? records : null;
  }

  async markActivity(
    threadId: string,
    activityStatus: WorkbenchSubagentRelationship["activityStatus"],
    now = Date.now(),
    harness?: WorkbenchHarness,
  ) {
    await this.initialize();
    const parentThreadId = this.childParents.get(threadId);
    if (!parentThreadId) return false;
    const records = this.parents.get(parentThreadId);
    const record = records?.get(threadId);
    if (!record || harness && record.harness !== harness) return false;
    if (record.activityStatus === activityStatus && now - record.lastActivityAt < ACTIVITY_WRITE_COALESCE_MS) return false;
    records!.set(threadId, { ...record, activityStatus, lastActivityAt: now, updatedAt: Math.max(record.updatedAt, now) });
    await this.persistParent(parentThreadId);
    return true;
  }

  async observeNotification(harness: HarnessKind, notification: JsonRpcNotification, now = Date.now()) {
    const params = isRecord(notification.params) ? notification.params : null;
    const turn = isRecord(params?.turn) ? params.turn : null;
    const threadId = typeof params?.threadId === "string"
      ? params.threadId
      : typeof turn?.threadId === "string" ? turn.threadId : null;
    if (!threadId) return false;
    if (notification.method === "turn/started") return await this.markActivity(threadId, "active", now, harness);
    if (notification.method === "turn/completed") return await this.markActivity(threadId, "inactive", now, harness);
    if (notification.method !== "thread/status/changed") return false;
    const status = isRecord(params?.status) ? params.status.type : null;
    return await this.markActivity(
      threadId,
      status === "active" ? "active" : status === "notLoaded" ? "unknown" : "inactive",
      now,
      harness,
    );
  }

  waitForIdle() {
    return this.jsonStore.waitForIdle();
  }

  private async initializeStore() {
    await fs.mkdir(this.directoryPath, { recursive: true });
    const entries = await fs.readdir(this.directoryPath, { withFileTypes: true });
    const fileNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name);
    await mapWithConcurrency(fileNames, LOAD_CONCURRENCY, async (fileName) => {
      const raw = await this.jsonStore.read<unknown>(path.join(this.directoryPath, fileName), null);
      const stored = this.normalizeParent(raw);
      if (stored) {
        this.installParent(stored.parentThreadId, Object.values(stored.subagents), stored.nextDirectSubagentIndex);
        if (!isRecord(raw) || raw.schemaVersion !== 3) await this.persistParent(stored.parentThreadId);
      }
    });
    await this.migrateLegacyStore();

    const activeParents: string[] = [];
    for (const [parentThreadId, records] of this.parents) {
      let changed = false;
      for (const [threadId, record] of records) {
        if (record.activityStatus !== "active") continue;
        records.set(threadId, { ...record, activityStatus: "unknown" });
        changed = true;
      }
      if (changed) activeParents.push(parentThreadId);
    }
    await mapWithConcurrency(activeParents, LOAD_CONCURRENCY, async (parentThreadId) => await this.persistParent(parentThreadId));
  }

  private async migrateLegacyStore() {
    const raw = await this.jsonStore.read<unknown>(this.legacyPath, null);
    if (!isRecord(raw) || !isRecord(raw.subagents)) return;
    const grouped = new Map<string, WorkbenchSubagentRelationship[]>();
    for (const value of Object.values(raw.subagents)) {
      const record = normalizeSummary(value);
      if (!record) continue;
      grouped.set(record.parentThreadId, [...(grouped.get(record.parentThreadId) ?? []), record]);
    }
    for (const [parentThreadId, records] of grouped) {
      const existing = new Map(this.parentRecords(parentThreadId));
      for (const record of records) {
        const previous = existing.get(record.threadId);
        if (!previous || record.updatedAt >= previous.updatedAt) existing.set(record.threadId, record);
      }
      const stabilized = stabilizeDirectSubagentIndexes(Array.from(existing.values()));
      this.installParent(parentThreadId, stabilized.records, Math.max(
        this.nextDirectSubagentIndexes.get(parentThreadId) ?? 0,
        stabilized.nextDirectSubagentIndex,
      ));
      await this.persistParent(parentThreadId);
    }
    await fs.rm(this.legacyPath, { force: true });
  }

  private normalizeParent(value: unknown): StoredParentSubagents | null {
    if (!isRecord(value) || typeof value.parentThreadId !== "string" || !value.parentThreadId.trim() || !isRecord(value.subagents)) return null;
    const normalizedRecords = Object.values(value.subagents)
      .flatMap((entry) => normalizeSummary(entry) ?? [])
      .filter((record) => record.parentThreadId === value.parentThreadId);
    const stabilized = stabilizeDirectSubagentIndexes(normalizedRecords);
    const storedNextIndex = Number.isSafeInteger(value.nextDirectSubagentIndex) && Number(value.nextDirectSubagentIndex) >= 0
      ? Number(value.nextDirectSubagentIndex)
      : 0;
    return {
      nextDirectSubagentIndex: Math.max(storedNextIndex, stabilized.nextDirectSubagentIndex),
      parentThreadId: value.parentThreadId,
      schemaVersion: 3,
      subagents: Object.fromEntries(stabilized.records.map((record) => [record.threadId, record])),
    };
  }

  private installParent(parentThreadId: string, summaries: readonly WorkbenchSubagentRelationship[], nextDirectSubagentIndex?: number) {
    const records = new Map(summaries.map((record) => [record.threadId, record]));
    this.parents.set(parentThreadId, records);
    this.nextDirectSubagentIndexes.set(parentThreadId, Math.max(
      nextDirectSubagentIndex ?? 0,
      ...summaries.map(({ directSubagentIndex }) => directSubagentIndex + 1),
    ));
    for (const record of records.values()) this.childParents.set(record.threadId, parentThreadId);
  }

  private nextDirectSubagentIndex(parentThreadId: string) {
    const index = this.nextDirectSubagentIndexes.get(parentThreadId) ?? 0;
    this.nextDirectSubagentIndexes.set(parentThreadId, index + 1);
    return index;
  }

  private parentRecords(parentThreadId: string) {
    let records = this.parents.get(parentThreadId);
    if (!records) {
      records = new Map();
      this.parents.set(parentThreadId, records);
    }
    return records;
  }

  private parentPath(parentThreadId: string) {
    return path.join(this.directoryPath, `${encodeTranscriptPathSegment(parentThreadId)}.json`);
  }

  private async persistParent(parentThreadId: string) {
    const records = this.parentRecords(parentThreadId);
    const stored: StoredParentSubagents = {
      nextDirectSubagentIndex: this.nextDirectSubagentIndexes.get(parentThreadId) ?? 0,
      parentThreadId,
      schemaVersion: 3,
      subagents: Object.fromEntries(records),
    };
    await this.jsonStore.update(this.parentPath(parentThreadId), {
      nextDirectSubagentIndex: 0,
      parentThreadId,
      schemaVersion: 3,
      subagents: {},
    }, () => stored);
  }
}
