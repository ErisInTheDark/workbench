/*
 * WorkbenchProjectedTranscriptTurn/WorkbenchTranscriptProjection: canonical transcript values reconstructed from relational rows.
 * WorkbenchTranscriptProjectionResult: complete hydration-bounded projection or one bounded relational-integrity failure. Keywords: transcript, projection, validation.
 * projectWorkbenchTranscript: reconstruct turns, Browse facts, item timing, and display segments from canonical item projection. Keywords: transcript, browser, canonical, parity.
 * Re-exports: shared canonical item projection values from the lower database transcript owner. Keywords: transcript, projection, item, database.
 */
import type { Turn } from "../../codex/generated/app-server/v2/Turn.ts";
import type {
  WorkbenchBrowseResultEntry,
  WorkbenchThreadTurnHistoryEntry,
} from "../../types.ts";
import type { WorkbenchThreadItemTimelineEntry } from "../thread/thread-item-timeline.ts";
import {
  projectWorkbenchTranscriptItems,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchTranscriptProjectionIssue,
} from "../database/transcript/workbench-transcript-item-projection.ts";
import type { WorkbenchTranscriptSnapshot } from "../database/transcript/workbench-transcript-contract.ts";
import {
  planCanonicalTranscriptDisplay,
  type CanonicalTranscriptDisplayPlan,
} from "./thread-transcript-display-planner.ts";

export {
  projectWorkbenchTranscriptItems,
  type WorkbenchProjectedInteractionItem,
  type WorkbenchProjectedTranscriptItem,
  type WorkbenchProjectedGenericItem,
  type WorkbenchTranscriptItemProjectionResult,
  type WorkbenchTranscriptItemProjectionRow,
  type WorkbenchTranscriptProjectionIssue,
} from "../database/transcript/workbench-transcript-item-projection.ts";

export interface WorkbenchProjectedTranscriptTurn extends Omit<Turn, "items"> {
  itemTimeline: WorkbenchThreadItemTimelineEntry[];
  items: WorkbenchProjectedTranscriptItem[];
  turnIndex: number;
}

export interface WorkbenchTranscriptProjection {
  browseResultEntries: WorkbenchBrowseResultEntry[];
  display: CanonicalTranscriptDisplayPlan<WorkbenchProjectedTranscriptItem>;
  hasPreviousTurns: boolean;
  thread: {
    activityAt: number;
    createdAt: number;
    id: string;
    projectId: string;
    projectRoot: string;
    title: string;
    updatedAt: number;
  };
  turnHistory: WorkbenchThreadTurnHistoryEntry[];
  turns: WorkbenchProjectedTranscriptTurn[];
}

export type WorkbenchTranscriptProjectionResult =
  | { data: WorkbenchTranscriptProjection; success: true }
  | { issues: WorkbenchTranscriptProjectionIssue[]; success: false };

class ProjectionFailure extends Error {
  readonly issue: WorkbenchTranscriptProjectionIssue;

  constructor(issue: WorkbenchTranscriptProjectionIssue) {
    super(`${issue.code} in ${issue.table}`);
    this.issue = issue;
  }
}

type Rows = WorkbenchTranscriptSnapshot["rows"];

function fail(
  code: WorkbenchTranscriptProjectionIssue["code"],
  table: string,
  itemId?: string,
): never {
  throw new ProjectionFailure({ code, table, ...(itemId ? { itemId: itemId.slice(0, 200) } : {}) });
}

function turnStatus(state: WorkbenchTranscriptSnapshot["turns"][number]["state"]): Turn["status"] {
  return state === "admitted" ? "inProgress" : state;
}

function seconds(value: number | null) {
  return value === null ? null : value / 1_000;
}

function browseEntries(
  snapshot: WorkbenchTranscriptSnapshot,
  itemRootsById: ReadonlyMap<number, Rows["threadItems"][number]>,
): WorkbenchBrowseResultEntry[] {
  const assetsByDigest = new Map(snapshot.rows.transcriptAssets.map((asset) => [asset.digest, asset]));
  if (assetsByDigest.size !== snapshot.rows.transcriptAssets.length) {
    return fail("duplicateRow", "transcriptAssets");
  }
  return [...snapshot.rows.threadBrowseEntries]
    .sort((left, right) => left.recorded_at - right.recorded_at || left.action_index - right.action_index)
    .map((entry) => {
      const root = itemRootsById.get(entry.item_id);
      if (!root) return fail("invalidReference", "threadBrowseEntries", String(entry.item_id));
      const asset = entry.asset_digest ? assetsByDigest.get(entry.asset_digest) : null;
      if (entry.asset_digest && !asset) {
        return fail("invalidReference", "threadBrowseEntries", entry.entry_key);
      }
      return {
        action: entry.action,
        actionIndex: entry.action_index,
        assetUrl: asset && snapshot.thread.identity_origin === "workbench"
          ? asset.storage_key.replace(/^\/api\/transcript-assets\/codex\/[^/]+\//u, `/api/transcript-assets/codex/${encodeURIComponent(snapshot.thread.id)}/`)
          : asset?.storage_key ?? null,
        commandItemId: root.public_id ?? root.source_id,
        detailKind: entry.detail_kind,
        detailLabel: entry.detail_label,
        detailText: entry.detail_text,
        durationMs: entry.duration_ms,
        entryKey: entry.entry_key,
        recordedAt: entry.recorded_at,
        session: entry.session_name,
        state: entry.state,
        threadId: snapshot.thread.id,
        turnId: root.turn_id,
      };
    });
}

export function projectWorkbenchTranscript(
  snapshot: WorkbenchTranscriptSnapshot,
): WorkbenchTranscriptProjectionResult {
  try {
    const loadedTurnIds = new Set(snapshot.loadedTurnIds);
    if (loadedTurnIds.size !== snapshot.loadedTurnIds.length) fail("duplicateRow", "loadedTurnIds");
    const turnsById = new Map(snapshot.turns.map((turn) => [turn.id, turn]));
    if (turnsById.size !== snapshot.turns.length) fail("duplicateRow", "turns");
    for (const turnId of loadedTurnIds) if (!turnsById.has(turnId)) fail("invalidReference", "loadedTurnIds", turnId);

    const itemRootsById = new Map(snapshot.rows.threadItems.map((item) => [item.id, item]));
    if (itemRootsById.size !== snapshot.rows.threadItems.length) fail("duplicateRow", "threadItems");
    for (const root of snapshot.rows.threadItems) {
      if (!loadedTurnIds.has(root.turn_id)) fail("invalidReference", "threadItems", root.source_id);
      if (root.thread_id !== snapshot.thread.id) fail("invalidReference", "threadItems", root.source_id);
    }
    const itemProjection = projectWorkbenchTranscriptItems(snapshot.rows);
    if ("issues" in itemProjection) {
      return { issues: itemProjection.issues, success: false };
    }
    const publicIdsByItemId = new Map(itemProjection.data.map(({ item, root }) => [root.id, item.id]));
    const projectedItems = itemProjection.data
      .map(({ item, root }) => ({ payload: item, root }))
      .sort((left, right) => (
        turnsById.get(left.root.turn_id)!.turn_index - turnsById.get(right.root.turn_id)!.turn_index
        || left.root.item_position - right.root.item_position
      ));
    const projectedItemsByTurn = new Map<string, WorkbenchProjectedTranscriptItem[]>();
    for (const { payload, root } of projectedItems) {
      const turnItems = projectedItemsByTurn.get(root.turn_id) ?? [];
      turnItems.push(payload);
      projectedItemsByTurn.set(root.turn_id, turnItems);
    }

    const timelinesByItemId = new Map<string, Rows["threadItemTimelines"][number]>();
    for (const entry of snapshot.rows.threadItemTimelines) {
      const sourceId = publicIdsByItemId.get(entry.item_id);
      if (!sourceId) fail("invalidReference", "threadItemTimelines", String(entry.item_id));
      if (timelinesByItemId.has(sourceId)) fail("duplicateRow", "threadItemTimelines", sourceId);
      timelinesByItemId.set(sourceId, entry);
    }
    const aliasesByItemId = new Map<string, string[]>();
    for (const entry of snapshot.rows.threadItemTimelineAliases) {
      const sourceId = publicIdsByItemId.get(entry.item_id);
      if (!sourceId) fail("invalidReference", "threadItemTimelineAliases", String(entry.item_id));
      const aliases = aliasesByItemId.get(sourceId) ?? [];
      aliases.push(entry.alias);
      aliasesByItemId.set(sourceId, aliases);
    }
    const orderedTurns = [...snapshot.turns].sort((left, right) => left.turn_index - right.turn_index);
    const projectedTurns: WorkbenchProjectedTranscriptTurn[] = orderedTurns
      .filter(({ id }) => loadedTurnIds.has(id))
      .map((turn) => {
        if (turn.thread_id !== snapshot.thread.id) fail("invalidReference", "turns", turn.id);
        const items = projectedItemsByTurn.get(turn.id) ?? [];
        const itemTimeline = items.flatMap<WorkbenchThreadItemTimelineEntry>((item) => {
          const timeline = timelinesByItemId.get(item.id);
          if (!timeline) return [];
          const aliases = aliasesByItemId.get(item.id) ?? [];
          return [{
            ...(aliases.length ? { aliases } : {}),
            completedAt: timeline.completed_at,
            firstSeenAt: timeline.first_seen_at,
            itemId: item.id,
            lastSeenAt: timeline.last_seen_at,
            startedAt: timeline.started_at,
          }];
        });
        return {
          completedAt: seconds(turn.ended_at),
          durationMs: turn.duration_ms,
          error: null,
          id: turn.id,
          items,
          itemsView: "full",
          itemTimeline,
          startedAt: seconds(turn.started_at),
          status: turnStatus(turn.state),
          turnIndex: turn.turn_index,
        };
      });
    const projectedTurnById = new Map(projectedTurns.map((turn) => [turn.id, turn]));
    const turnHistory = orderedTurns.map<WorkbenchThreadTurnHistoryEntry>((turn) => {
      const projected = projectedTurnById.get(turn.id);
      return {
        completedAt: seconds(turn.ended_at),
        durationMs: turn.duration_ms,
        itemCount: projected?.items.length ?? 0,
        ...(projected ? {
          itemIds: projected.items.map(({ id }) => id),
          itemTimeline: projected.itemTimeline,
        } : {}),
        loadState: projected ? "loaded" : "unloaded",
        startedAt: seconds(turn.started_at),
        status: turnStatus(turn.state),
        turnId: turn.id,
      };
    });
    const display = planCanonicalTranscriptDisplay({
      items: projectedItems.map(({ payload, root }, itemIndex) => ({
        itemId: payload.id,
        itemIndex,
        payload,
        turnId: root.turn_id,
      })),
      turns: orderedTurns
        .filter(({ id }) => loadedTurnIds.has(id))
        .map(({ id, turn_index }) => ({ turnId: id, turnIndex: turn_index })),
    });

    return {
      data: {
        browseResultEntries: browseEntries(snapshot, itemRootsById),
        display,
        hasPreviousTurns: snapshot.hasPreviousTurns,
        thread: {
          activityAt: snapshot.thread.activity_at,
          createdAt: snapshot.thread.created_at,
          id: snapshot.thread.id,
          projectId: snapshot.thread.project_id,
          projectRoot: snapshot.thread.project_root,
          title: snapshot.thread.title,
          updatedAt: snapshot.thread.updated_at,
        },
        turnHistory,
        turns: projectedTurns,
      },
      success: true,
    };
  } catch (error) {
    if (error instanceof ProjectionFailure) return { issues: [error.issue], success: false };
    throw error;
  }
}
