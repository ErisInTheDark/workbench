/*
 * Exports:
 * - createFirstTurnItemOwners: assign each Codex item id to its first ordered turn. Keywords: codex, transcript, item, owner, turn.
 */

export function createFirstTurnItemOwners(
  turns: readonly {
    itemIds?: readonly string[];
    turnId: string;
  }[],
) {
  const owners = new Map<string, string>();
  for (const turn of turns) {
    for (const itemId of turn.itemIds ?? []) {
      if (!owners.has(itemId)) {
        owners.set(itemId, turn.turnId);
      }
    }
  }
  return owners;
}
