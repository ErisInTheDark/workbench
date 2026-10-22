/* Exports: default WorkbenchGitMarkdownDiff: a markdown file rendered as it now reads, its changes marked in place and flagged in the margin. */
"use client";
import { useMemo } from "react";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import { buildMarkdownDiff } from "../../../workbench/git/markdown-diff";
import MarkdownRender from "../../ui/MarkdownRender";
import ContextualProjectProvider from "../ContextualProjectProvider";
import { useGitChangeset } from "./WorkbenchGitChangesetProvider";
import { useWorkingTree } from "./WorkbenchWorkingTreeProvider";

/**
 * Blocks holding an insertion, a deletion or both get a green, red or amber bar in the pane's left margin, level with the
 * block's first line: the bar is absolute with no offset of its own, so it keeps the block's static position.
 */
const MARGIN_BARS = `
  relative
  [&_:is(p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th):is(:has(ins),:has(del))]:before:(absolute left-0 h-[1lh] w-1 rounded-full content-[''])
  [&_:is(p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th):has(ins)]:before:bg-[var(--success)]
  [&_:is(p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th):has(del)]:before:bg-[var(--danger)]
  [&_:is(p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th):has(ins):has(del)]:before:bg-amber-500
`;

export default function WorkbenchGitMarkdownDiff() {
  const { snapshot } = useGitChangeset();
  const projectId = useWorkingTree().projectId;
  const preview = snapshot.preview;
  const patch = snapshot.diff?.patch ?? "";
  const marked = useMemo(() => {
    if (!preview || preview.unavailable) return null;
    // A deleted file has no new text, so it reads as wholly removed.
    if (preview.after === null) return preview.before === null ? "" : `<del>\n\n${preview.before}\n\n</del>`;
    return buildMarkdownDiff(preview.after, describeWorkingTreeDiff(patch));
  }, [patch, preview]);
  if (!preview) return null;
  if (preview.unavailable) return <p className="py-4 text-sm text-fg/muted">{preview.unavailable}</p>;
  return <ContextualProjectProvider id={projectId}>
    <div className={`pb-6 pl-4 ${MARGIN_BARS}`}><MarkdownRender markdown={marked ?? ""} /></div>
  </ContextualProjectProvider>;
}
