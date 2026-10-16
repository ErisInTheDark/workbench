/*
 * Exports:
 * - AttachmentReference: parsed numbered or removed attachment mention.
 * - AttachmentTextEdit: bounded replacement in the original text.
 * - attachmentReferences: find explicit attachment mentions.
 * - renumberAttachmentReferences: preserve attachment identity when its ordinal changes.
 * - applyAttachmentTextEdits: apply ordered, non-overlapping replacements.
 * - attachmentReferenceDragType: identify an attachment-reference drag payload.
 */
export const attachmentReferenceDragType = "application/x-workbench-attachment-reference";

export interface AttachmentReference {
  start: number;
  end: number;
  number: number | null;
  text: string;
}

export interface AttachmentTextEdit {
  start: number;
  end: number;
  text: string;
}

export function attachmentReferences(text: string): AttachmentReference[] {
  return [...text.matchAll(/#\[attach:([1-9]\d*|removed)\]/gu)].flatMap(match => {
    const number = match[1] === "removed" ? null : Number(match[1]);
    return number !== null && !Number.isSafeInteger(number) ? [] : [{
      start: match.index, end: match.index + match[0].length, number, text: match[0],
    }];
  });
}

export function renumberAttachmentReferences(
  text: string,
  previous: readonly { id: string }[],
  next: readonly { id: string }[],
): AttachmentTextEdit[] {
  const positions = new Map(next.map((attachment, index) => [attachment.id, index + 1]));
  return attachmentReferences(text).flatMap(reference => {
    if (reference.number === null) return [];
    const attachment = previous[reference.number - 1];
    if (!attachment) return [];
    const number = positions.get(attachment.id);
    const replacement = `#[attach:${number ?? "removed"}]`;
    return replacement === reference.text ? [] : [{ start: reference.start, end: reference.end, text: replacement }];
  });
}

export function applyAttachmentTextEdits(text: string, edits: readonly AttachmentTextEdit[]) {
  let cursor = 0;
  let result = "";
  for (const edit of edits) {
    if (edit.start < cursor || edit.end < edit.start || edit.end > text.length) {
      throw new Error("Text edits must be ordered, non-overlapping and inside the source.");
    }
    result += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  return result + text.slice(cursor);
}
