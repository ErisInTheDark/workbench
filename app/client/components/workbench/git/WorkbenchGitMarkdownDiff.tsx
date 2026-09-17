/* Exports: default WorkbenchGitMarkdownDiff: render safe markdown versions and highlighted change excerpts. */
"use client";
import { useMemo } from "react";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import ThreadMarkdown from "../thread-view/ThreadMarkdown";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitMarkdownDiff() {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  const changes = useMemo(() => {
    const groups: Array<{ type: "addition" | "deletion"; text: string }> = [];
    for (const row of describeWorkingTreeDiff(snapshot.diff?.patch ?? "").rows) {
      if (row.type !== "addition" && row.type !== "deletion") continue;
      const last = groups.at(-1);
      if (last?.type === row.type) last.text += `\n${row.text}`;
      else groups.push({ type: row.type, text: row.text });
    }
    return groups;
  }, [snapshot.diff?.patch]);
  if (!snapshot.preview) return <p className="p-4 text-sm text-fg/muted">{snapshot.contentError ? "Markdown preview unavailable." : "Loading markdown preview..."}</p>;
  if (snapshot.preview.unavailable) return <p className="p-4 text-sm text-fg/muted">{snapshot.preview.unavailable}</p>;
  return <div className="space-y-6 px-4 pb-4">
    <section className="space-y-2">
      <h3 className="text-sm font-medium">Changed passages</h3>
      {changes.map((change, index) => <div key={index} className={`
        rounded-lg px-3 py-2
        ${change.type === "addition" ? "bg-emerald-500/10" : "bg-red-500/10"}
      `}>
        <span className="text-xs text-fg/muted">{change.type === "addition" ? "Added" : "Removed"}</span>
        <ThreadMarkdown markdown={change.text} projectId={state.projectId} />
      </div>)}
    </section>
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {(["before", "after"] as const).map(side => <section key={side} className="min-w-0">
        <h3 className="text-sm font-medium">{side === "before" ? "Before" : "After"}</h3>
        <ThreadMarkdown markdown={snapshot.preview![side] ?? "*File does not exist in this version.*"} projectId={state.projectId} />
      </section>)}
    </div>
  </div>;
}
