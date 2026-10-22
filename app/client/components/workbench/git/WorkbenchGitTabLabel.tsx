/*
 * Exports:
 * - default WorkbenchGitTabLabel: a git tab naming what it shows (changes, a commit's subject or a stash's message, and
 *   its focused file) under its folder's project row, with the full sha and path in its tooltip.
 * - rememberGitObjectSubject: record an object's subject once a view has read it, so its tab names it without a read.
 */
"use client";
import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WorkbenchGitObject } from "workbench-shared/workbench/navigation/git-route-target";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { useWorkbenchWorkspace } from "../WorkbenchWorkspaceContext";
import WorkbenchClientContext from "../workbench-client-context";
import { GitArcCleanClaimIcon, GitArcDirtyClaimIcon, GitCommitIcon, GitStashIcon } from "../workbench-icons";
import FileKindIcon from "../file-kind-icon";
import useWorkspaceObservation from "../../../workbench/app/use-workspace-observation";

const subjects = new Map<string, string>();
const subjectKey = (location: ProjectLocationReference, sha: string) => `${location.daemonId}/${location.projectId}/${sha}`;

export function rememberGitObjectSubject(location: { daemonId: string | null; projectId: string }, sha: string, subject: string) {
  if (location.daemonId) subjects.set(`${location.daemonId}/${location.projectId}/${sha}`, subject);
}

/** A commit's subject never changes, so one read per tab (or none, once its view has loaded) is enough. */
function useObjectSubject(location: ProjectLocationReference | null, object: WorkbenchGitObject) {
  const mounted = useContext(WorkbenchClientContext)?.mounted;
  const sha = object.kind === "changes" ? null : object.sha;
  const key = location && sha ? subjectKey(location, sha) : null;
  const [subject, setSubject] = useState(() => key ? subjects.get(key) ?? null : null);
  useEffect(() => {
    if (!key || !location || !sha || object.kind === "changes") return;
    const known = subjects.get(key);
    if (known !== undefined) { setSubject(known); return; }
    const daemon = mounted?.workspace.daemon({ kind: "folder", location });
    if (!daemon) return;
    let live = true;
    void daemon.git.object.read({ projectId: location.projectId, object: { kind: object.kind, sha } })
      .then(detail => { subjects.set(key, detail.subject); if (live) setSubject(detail.subject); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [key, location, mounted, object.kind, sha]);
  return subject;
}

function useUnclaimed(location: ProjectLocationReference | null) {
  const workspace = useWorkbenchWorkspace();
  const query = useMemo(() => location ? { kind: "workingTreeSummary" as const, location } : null, [location]);
  const summary = useWorkspaceObservation(workspace, query).value?.data;
  return summary?.repositories.reduce((total, repository) => total + (repository.unclaimed ?? (repository.dirty ? 1 : 0)), 0) ?? 0;
}

export default function WorkbenchGitTabLabel({ location, object, path, render }: {
  location: ProjectLocationReference | null;
  object: WorkbenchGitObject;
  path: string | null;
  render(tab: { icon: ReactNode; label: ReactNode; tooltip: ReactNode }): ReactNode;
}) {
  const subject = useObjectSubject(location, object);
  const unclaimed = useUnclaimed(object.kind === "changes" ? location : null);
  const file = path ? path.slice(path.lastIndexOf("/") + 1) : null;
  if (object.kind === "changes") {
    const Icon = unclaimed ? GitArcDirtyClaimIcon : GitArcCleanClaimIcon;
    const label = unclaimed ? `${unclaimed} change${unclaimed === 1 ? "" : "s"}` : "No changes";
    return render({
      icon: <Icon size={14} />,
      label: file ?? label,
      tooltip: <div className="max-w-96 space-y-0.5"><div>{label}</div>{path ? <div className="break-all text-fg/muted">{path}</div> : null}</div>,
    });
  }
  const Icon = object.kind === "commit" ? GitCommitIcon : GitStashIcon;
  const name = subject === null ? object.sha.slice(0, 7)
    : subject || <em className="text-fg/muted">{object.kind === "stash" ? "unnamed stash" : "no message"}</em>;
  return render({
    icon: file ? <FileKindIcon path={path!} size={14} /> : <Icon size={14} />,
    label: file ? <>{file}<span className="ml-1 font-mono text-[0.85em] text-fg/muted">{object.sha.slice(0, 7)}</span></> : name,
    tooltip: <div className="max-w-96 space-y-0.5">
      <div className="flex items-center gap-1.5"><Icon size={14} className="shrink-0 text-fg/muted" />{name}</div>
      <div className="font-mono text-xs text-fg/muted">{object.sha}</div>
      {path ? <div className="break-all text-fg/muted">{path}</div> : null}
    </div>,
  });
}
