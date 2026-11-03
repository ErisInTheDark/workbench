/*
 * Exports:
 * - listMarkdownComponentInvocations: the component invocations thread markdown draws as blocks, inside notices,
 *   details, plans and lists too, so a component body can resolve them before it is shown.
 */
import { parseBlocks, type ParsedBlock } from "./markdown-parse";

export function listMarkdownComponentInvocations(markdown: string): string[] {
  const invocations = new Set<string>();
  const walk = (blocks: readonly ParsedBlock[]) => {
    for (const block of blocks) {
      if (block.type === "component") invocations.add(block.text);
      else if (block.type === "notice" || block.type === "details" || block.type === "plan") walk(parseBlocks(block.text, { profile: "thread" }));
      else if (block.type === "ul" || block.type === "ol") for (const item of block.items) walk(item.children);
    }
  };
  walk(parseBlocks(markdown, { profile: "thread" }));
  return [...invocations];
}
