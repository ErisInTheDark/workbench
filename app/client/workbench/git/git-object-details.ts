/*
 * Exports:
 * - readGitObjectDetail: a commit's or stash's message, files and committing threads, read once per folder and sha for
 *   hovers and menus. Objects are addressed by sha, so what they hold never changes; a failed read is retried next time.
 */
import type WorkbenchDaemonClient from "workbench-shared/workbench/daemon/WorkbenchDaemonClient";
import type { GitObjectDetail, GitObjectRef } from "workbench-shared/workbench/git/git-object-contracts";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";

const reads = new Map<string, Promise<GitObjectDetail>>();

export function readGitObjectDetail(daemon: WorkbenchDaemonClient, location: ProjectLocationReference, object: GitObjectRef) {
  const key = `${location.daemonId}/${location.projectId}/${object.kind}/${object.sha}`;
  const known = reads.get(key);
  if (known) return known;
  const read = daemon.git.object.read({ projectId: location.projectId, object });
  reads.set(key, read);
  read.catch(() => reads.delete(key));
  return read;
}
