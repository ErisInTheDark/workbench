/* Exports: default WorkbenchGitRefreshButton: expose Git refresh through the shared shell action. */
"use client";
import WorkbenchIconButton from "../WorkbenchIconButton";
import { RefreshCwIcon } from "../workbench-icons";
import { useWorkingTree, useWorkingTreeSnapshot } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitRefreshButton() {
  const state = useWorkingTree();
  const snapshot = useWorkingTreeSnapshot();
  return <WorkbenchIconButton display="hover-border"
    label={snapshot.refreshing ? "Refreshing working tree" : "Refresh working tree"}
    disabled={snapshot.busy || snapshot.refreshing || snapshot.status === "idle"} aria-busy={snapshot.refreshing}
    onClick={() => { void state.refresh(); }}>
    <RefreshCwIcon size={20} className={snapshot.refreshing ? "animate-spin motion-reduce:animate-none" : ""} />
  </WorkbenchIconButton>;
}
