/*
 * Exports:
 * - WorkbenchInstructionToolDocs: rendered `<docs>` text for one set of tools.
 * - collectWorkbenchInstructionToolDocs: render instruction sources for one caller and group the text inside `<docs>` regions by their innermost tools.
 */
import { filterWorkbenchInstructionContent, type WorkbenchInstructionFilterContext } from "./instruction-context-filter";

export interface WorkbenchInstructionToolDocs {
  readonly text: string;
  readonly tools: readonly string[];
}

/**
 * Renders like a real payload, so only text this caller would receive counts: excluded harness, model and
 * workspace branches drop out, and a region nested in another belongs to the inner one alone.
 */
export function collectWorkbenchInstructionToolDocs(
  sources: readonly { readonly content: string; readonly relativePath: string }[],
  context: Omit<WorkbenchInstructionFilterContext, "field" | "onDocsLine" | "onWarning">,
): WorkbenchInstructionToolDocs[] {
  const regions = new Map<string, { lines: string[]; tools: readonly string[] }>();
  for (const source of sources) {
    filterWorkbenchInstructionContent(source.content, {
      ...context,
      field: source.relativePath,
      // Payload builds own selector diagnostics; accounting must not repeat them on every stats read.
      onWarning: () => {},
      onDocsLine: (tools, line) => {
        const key = tools.join(" ");
        const region = regions.get(key) ?? { lines: [], tools };
        region.lines.push(line);
        regions.set(key, region);
      },
    });
  }
  return [...regions.values()].map(({ lines, tools }) => ({ text: lines.join("\n"), tools }));
}
