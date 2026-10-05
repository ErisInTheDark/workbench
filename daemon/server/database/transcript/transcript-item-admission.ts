/*
 * Exports:
 * - TranscriptItemAdmission: placement of one missing item, never a move of an admitted item.
 * - planTranscriptItemAdmissions: admit missing evidence into proven empty gaps, otherwise append.
 */
export interface TranscriptItemAdmission {
  itemId: string;
  beforeItemId: string | null;
}

export function planTranscriptItemAdmissions(
  admittedItemIds: readonly string[],
  evidenceItemIds: readonly string[],
): TranscriptItemAdmission[] {
  const positions = new Map(admittedItemIds.map((id, index) => [id, index]));
  if (positions.size !== admittedItemIds.length) throw new Error("Admission list contains duplicate identities.");
  const admissions: TranscriptItemAdmission[] = [];
  let previousPosition = -1;
  let pending: string[] = [];
  for (const itemId of new Set(evidenceItemIds)) {
    const position = positions.get(itemId);
    if (position === undefined) {
      pending.push(itemId);
      continue;
    }
    const beforeItemId = position === previousPosition + 1 ? itemId : null;
    admissions.push(...pending.map(id => ({ itemId: id, beforeItemId })));
    pending = [];
    previousPosition = position;
  }
  admissions.push(...pending.map(itemId => ({ itemId, beforeItemId: null })));
  return admissions;
}
