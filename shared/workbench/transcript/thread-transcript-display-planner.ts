/*
 * CanonicalTranscriptItem/CanonicalTranscriptVirtualItem: durable indexed and explicit live-tail presentation inputs. Keywords: transcript, item, order.
 * CanonicalTranscriptSegment/CanonicalTranscriptDisplayPlan: validated adjacent-turn display sequence with stable segment ownership. Keywords: transcript, display, grouping, terminal.
 * planCanonicalTranscriptDisplay: validate canonical ancestry, sort once by itemIndex, place empty turns, and isolate virtual head/tail items. Keywords: transcript, order, validation.
 */
export interface CanonicalTranscriptPayload {
  id: string;
}

export interface CanonicalTranscriptItem<Payload extends CanonicalTranscriptPayload = CanonicalTranscriptPayload> {
  itemId: string;
  itemIndex: number;
  payload: Payload;
  turnId: string;
}

export interface CanonicalTranscriptVirtualItem<Payload extends CanonicalTranscriptPayload = CanonicalTranscriptPayload> {
  payload: Payload;
  turnId: string;
}

export interface CanonicalTranscriptTurn {
  turnId: string;
  turnIndex: number;
}

export interface CanonicalTranscriptSegment<Payload extends CanonicalTranscriptPayload = CanonicalTranscriptPayload> {
  id: string;
  isFirstForTurn: boolean;
  isLastForTurn: boolean;
  items: Payload[];
  kind: "canonical" | "virtual";
  ownsCanonicalTerminal: boolean;
  turnId: string;
}

export interface CanonicalTranscriptDisplayPlan<Payload extends CanonicalTranscriptPayload = CanonicalTranscriptPayload> {
  orderedItems: CanonicalTranscriptItem<Payload>[];
  segments: CanonicalTranscriptSegment<Payload>[];
}

interface DisplayGroup<Payload extends CanonicalTranscriptPayload> {
  items: Payload[];
  kind: CanonicalTranscriptSegment["kind"];
  turnId: string;
}

function assertUnique(values: readonly (number | string)[], label: string) {
  const seen = new Set<number | string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Canonical transcript repeats ${label} ${value}.`);
    seen.add(value);
  }
}

function groupAdjacentItems<Payload extends CanonicalTranscriptPayload>(
  items: readonly { payload: Payload; turnId: string }[],
  kind: DisplayGroup<Payload>["kind"],
) {
  const groups: DisplayGroup<Payload>[] = [];
  for (const item of items) {
    const previous = groups.at(-1);
    if (previous?.turnId === item.turnId) previous.items.push(item.payload);
    else groups.push({ items: [item.payload], kind, turnId: item.turnId });
  }
  return groups;
}

function insertEmptyTurns<Payload extends CanonicalTranscriptPayload>(
  groups: readonly DisplayGroup<Payload>[],
  turns: readonly CanonicalTranscriptTurn[],
  occupiedTurnIds: ReadonlySet<string>,
) {
  const turnIndexById = new Map(turns.map(({ turnId, turnIndex }) => [turnId, turnIndex]));
  const result = [...groups];
  for (const turn of turns
    .filter(({ turnId }) => !occupiedTurnIds.has(turnId))
    .sort((left, right) => left.turnIndex - right.turnIndex)) {
    const insertionIndex = result.findIndex((group) => (
      (turnIndexById.get(group.turnId) ?? Number.MAX_SAFE_INTEGER) > turn.turnIndex
    ));
    result.splice(insertionIndex < 0 ? result.length : insertionIndex, 0, {
      items: [],
      kind: "canonical",
      turnId: turn.turnId,
    });
  }
  return result;
}

function insertVirtualHeads<Payload extends CanonicalTranscriptPayload>(
  groups: readonly DisplayGroup<Payload>[],
  virtualHead: readonly CanonicalTranscriptVirtualItem<Payload>[],
) {
  const itemsByTurnId = new Map<string, Payload[]>();
  for (const { payload, turnId } of virtualHead) {
    const items = itemsByTurnId.get(turnId);
    if (items) items.push(payload);
    else itemsByTurnId.set(turnId, [payload]);
  }
  const insertedTurnIds = new Set<string>();
  return groups.flatMap((group) => {
    const items = itemsByTurnId.get(group.turnId);
    if (!items || insertedTurnIds.has(group.turnId)) return [group];
    insertedTurnIds.add(group.turnId);
    return [{ items, kind: "virtual" as const, turnId: group.turnId }, group];
  });
}

function finalizeSegments<Payload extends CanonicalTranscriptPayload>(groups: readonly DisplayGroup<Payload>[]) {
  const firstSegmentByTurn = new Map<string, number>();
  const lastSegmentByTurn = new Map<string, number>();
  const canonicalTerminalByTurn = new Map<string, number>();
  groups.forEach((group, index) => {
    if (!firstSegmentByTurn.has(group.turnId)) firstSegmentByTurn.set(group.turnId, index);
    lastSegmentByTurn.set(group.turnId, index);
    if (group.kind === "canonical") canonicalTerminalByTurn.set(group.turnId, index);
  });

  const occurrenceByTurn = new Map<string, number>();
  return groups.map<CanonicalTranscriptSegment<Payload>>((group, index) => {
    const occurrence = occurrenceByTurn.get(group.turnId) ?? 0;
    occurrenceByTurn.set(group.turnId, occurrence + 1);
    return {
      id: `${group.turnId}:display:${occurrence}`,
      isFirstForTurn: firstSegmentByTurn.get(group.turnId) === index,
      isLastForTurn: lastSegmentByTurn.get(group.turnId) === index,
      items: group.items,
      kind: group.kind,
      ownsCanonicalTerminal: canonicalTerminalByTurn.get(group.turnId) === index,
      turnId: group.turnId,
    };
  });
}

export function planCanonicalTranscriptDisplay<Payload extends CanonicalTranscriptPayload>({
  items,
  turns,
  virtualHead = [],
  virtualTail = [],
}: {
  items: readonly CanonicalTranscriptItem<Payload>[];
  turns: readonly CanonicalTranscriptTurn[];
  virtualHead?: readonly CanonicalTranscriptVirtualItem<Payload>[];
  virtualTail?: readonly CanonicalTranscriptVirtualItem<Payload>[];
}): CanonicalTranscriptDisplayPlan<Payload> {
  assertUnique(turns.map(({ turnId }) => turnId), "turn id");
  assertUnique(turns.map(({ turnIndex }) => turnIndex), "turn index");
  assertUnique(items.map(({ itemId }) => itemId), "item id");
  assertUnique(items.map(({ itemIndex }) => itemIndex), "item index");

  const turnIds = new Set(turns.map(({ turnId }) => turnId));
  for (const item of items) {
    if (!turnIds.has(item.turnId)) {
      throw new Error(`Canonical transcript item ${item.itemId} references missing turn ${item.turnId}.`);
    }
    if (item.payload.id !== item.itemId) {
      throw new Error(`Canonical transcript item ${item.itemId} payload id is ${item.payload.id}.`);
    }
  }
  for (const item of [...virtualHead, ...virtualTail]) {
    if (!turnIds.has(item.turnId)) {
      throw new Error(`Virtual transcript item ${item.payload.id} references missing turn ${item.turnId}.`);
    }
  }
  assertUnique([
    ...items.map(({ itemId }) => itemId),
    ...virtualHead.map(({ payload }) => payload.id),
    ...virtualTail.map(({ payload }) => payload.id),
  ], "visible item id");

  const orderedItems = [...items].sort((left, right) => left.itemIndex - right.itemIndex);
  const occupiedTurnIds = new Set(orderedItems.map(({ turnId }) => turnId));
  const canonicalGroups = insertEmptyTurns(
    groupAdjacentItems(orderedItems, "canonical"),
    turns,
    occupiedTurnIds,
  );
  const groupsWithVirtualHeads = insertVirtualHeads(canonicalGroups, virtualHead);
  const virtualGroups = groupAdjacentItems(virtualTail, "virtual");
  return {
    orderedItems,
    segments: finalizeSegments([...groupsWithVirtualHeads, ...virtualGroups]),
  };
}
