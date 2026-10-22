/* Exports: default WorkbenchGitTextDiff: the focused changeset file's text diff, with line picking where the changeset allows it. */
"use client";
import { useMemo } from "react";
import { describeWorkingTreeDiff } from "workbench-shared/workbench/git/working-tree-selection";
import WorkbenchDiffLines from "../diff/WorkbenchDiffLines";
import { useGitChangeset } from "./WorkbenchGitChangesetProvider";

export default function WorkbenchGitTextDiff({ mode, whitespace, onShowWhitespace }: {
  mode: "unified" | "split"; whitespace: boolean; onShowWhitespace(): void;
}) {
  const { changeset, snapshot } = useGitChangeset();
  const file = changeset.file;
  const model = useMemo(() => describeWorkingTreeDiff(snapshot.diff?.patch ?? ""), [snapshot.diff?.patch]);
  const pick = snapshot.selections.find(selection => selection.path === file?.path);
  const selected = useMemo(() => new Set(pick ? pick.lineIds ?? model.rows.filter(row => row.selectable).map(row => row.id) : []),
    [model, pick]);
  const setLines = changeset.setLines?.bind(changeset);
  // Each file mounts its own diff, so a long file's grown row budget never carries over to the next one.
  return <WorkbenchDiffLines key={file?.path} model={model} mode={mode} whitespace={whitespace} identity={file?.identity ?? ""}
    onShowWhitespace={onShowWhitespace}
    selection={setLines ? {
      selected, setLines,
      enabled: Boolean(file?.partial && !file.ownerIds?.length && !snapshot.busy),
    } : undefined} />;
}
