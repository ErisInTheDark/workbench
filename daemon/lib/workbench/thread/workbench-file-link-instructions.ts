/*
 * Exports:
 * - WORKBENCH_FILE_LINK_INSTRUCTIONS: shared agent-facing guidance for clickable Workbench file links. Keywords: thread markdown, file links, paths.
 */

export const WORKBENCH_FILE_LINK_INSTRUCTIONS = [
  "## Workbench File Links:",
  "Options for referencing files in the active project:",
  "- Prefer #[path/to/file.ts] or #[path/to/file.ts:123] for simple paths; Workbench resolves project-relative, absolute, and unique suffix paths, and displays the shortest disambiguated filename as a clickable link.",
  "- If you need a custom label, use [label](path/to/file.ts:123).",
  "- In a multi-root workspace project, add the project prefix like #[project-name:path/to/file.ts:123] or #[project-name:path/to/file.ts].",
  "- Do not use backticks around file links, as they will prevent Workbench from rendering them as clickable links.",
  "  Bad: `#[path/to/file.ts]` or `[label](path/to/file.ts)` — this will render the link text but it will not be clickable.",
  "  Good: #[path/to/file.ts] or [label](path/to/file.ts) — the user can click the link to open the file in their editor!",
].join("\n");
