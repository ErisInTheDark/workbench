/* Exports: default WorkbenchGitObjectView: one commit or stash: its header, its files and the focused file's read-only diff. */
"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { GitObjectRef } from "workbench-shared/workbench/git/git-object-contracts";
import WorkbenchGitObjectState from "../../../workbench/git/WorkbenchGitObjectState";
import PrimaryButton from "../../ui/PrimaryButton";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import WorkbenchGitChangesetProvider from "./WorkbenchGitChangesetProvider";
import WorkbenchGitDiffView from "./WorkbenchGitDiffView";
import WorkbenchGitFileRow, { WorkbenchGitFileTotals } from "./WorkbenchGitFileRow";
import WorkbenchGitObjectHeader from "./WorkbenchGitObjectHeader";
import WorkbenchGitSplitPane from "./WorkbenchGitSplitPane";
import { rememberGitObjectSubject } from "./WorkbenchGitTabLabel";
import { WorkbenchGitLoading } from "./WorkbenchWorkingTreeView";
import { useWorkingTree, useWorkingTreeDaemonId } from "./WorkbenchWorkingTreeProvider";

export default function WorkbenchGitObjectView({ object, path, onPath, onLeave }: {
  object: GitObjectRef;
  path: string | null;
  /** The focused file changed; the route records it so the tab names it. */
  onPath(path: string): void;
  onLeave(): void;
}) {
  const daemon = useWorkbenchDaemonClient();
  const projectId = useWorkingTree().projectId;
  const daemonId = useWorkingTreeDaemonId();
  const state = useMemo(() => new WorkbenchGitObjectState({ daemonId, projectId }, object, daemon.git.object, path),
    // A new path selects within the same object instead of reloading it.
    [daemon, daemonId, projectId, object.kind, object.sha]);
  useEffect(() => { void state.load(); return () => state.dispose(); }, [state]);
  useEffect(() => { if (path) state.selectFile(path); }, [path, state]);
  const snapshot = useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
  const [showDetail, setShowDetail] = useState(Boolean(path));
  const subject = snapshot.detail?.subject;
  useEffect(() => { if (subject !== undefined) rememberGitObjectSubject({ daemonId, projectId }, object.sha, subject); },
    [daemonId, object.sha, projectId, subject]);
  if (snapshot.status === "error") return <div className="flex flex-col items-start gap-3 py-4">
    <p role="alert" className="m-0 text-sm text-danger">{snapshot.error}</p>
    <PrimaryButton onClick={() => { void state.load(); }}>Retry</PrimaryButton>
  </div>;
  const detail = snapshot.detail;
  if (!detail) return <WorkbenchGitLoading />;
  return <WorkbenchGitChangesetProvider changeset={state}><div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
    <div className="px-1"><WorkbenchGitObjectHeader detail={detail} onLeave={onLeave} /></div>
    <WorkbenchGitSplitPane showDetail={showDetail} onShowFiles={() => setShowDetail(false)} files={<>
      <div className="flex items-center px-1 pb-1">
        <span className="flex-1 text-xs tabular-nums text-fg/muted">{detail.files.length}</span>
        <WorkbenchGitFileTotals files={detail.files} />
      </div>
      <div data-git-file-list className="scrollbar-hover-reveal min-h-0 flex-1 overflow-y-auto">
        {detail.files.map(file => <WorkbenchGitFileRow key={file.path} file={file} active={snapshot.path === file.path}
          onSelect={() => { state.selectFile(file.path); onPath(file.path); setShowDetail(true); }} />)}
      </div>
    </>}>
      <WorkbenchGitDiffView />
    </WorkbenchGitSplitPane>
  </div></WorkbenchGitChangesetProvider>;
}
