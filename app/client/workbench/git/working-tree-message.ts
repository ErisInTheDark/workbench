/*
 * Exports:
 * - WORKING_TREE_SUBJECT_LIMIT: commit subject budget, including an overflow ellipsis.
 * - editWorkingTreeMessage: split a commit subject into its description without losing text.
 */
export const WORKING_TREE_SUBJECT_LIMIT = 72;

export function editWorkingTreeMessage(title: string, description: string) {
  const normalized = title.replace(/\r\n?/gu, "\n");
  const [first = "", ...lines] = normalized.split("\n");
  const continuing = first.endsWith("\u2026") && description.startsWith("\u2026");
  const subject = continuing ? first.slice(0, -1) : first;
  const characters = Array.from(subject);
  let split = characters.length;
  if (characters.length + (continuing ? 1 : 0) > WORKING_TREE_SUBJECT_LIMIT) {
    split = WORKING_TREE_SUBJECT_LIMIT - 1;
    const wordBoundary = characters.slice(0, split + 1).findLastIndex(character => /\s/u.test(character));
    if (wordBoundary >= WORKING_TREE_SUBJECT_LIMIT - 20) split = wordBoundary;
    // Keep combining marks/emoji modifiers with their preceding character.
    while (split > 0 && /[\p{Mark}\p{Emoji_Modifier}\u200d]/u.test(characters[split] ?? "")) split--;
    while (split > 0 && characters[split - 1] === "\u200d") split -= Math.min(2, split);
  }
  const overflow = characters.slice(split).join("").trimStart();
  const moved = [overflow ? `\u2026${overflow}` : "", ...lines].filter((line, index) => index > 0 || line).join("\n");
  if (!moved) return { title: first, description, focusOffset: null as number | null };
  const nextDescription = continuing && overflow
    ? `${moved} ${description.slice(1)}`
    : `${moved}${description ? `\n\n${description}` : ""}`;
  return {
    title: overflow ? `${characters.slice(0, split).join("").trimEnd()}\u2026` : first,
    description: nextDescription,
    focusOffset: moved.length,
  };
}
