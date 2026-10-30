/*
 * Exports:
 * - default WorkbenchInaccessibleProjectSettings: list this daemon's projects gone from disk that still own threads, and merge
 *   each one's threads into a chosen catalogued project.
 */
"use client";

import { useEffect, useState } from "react";
import type { InaccessibleProjects } from "workbench-shared/workbench/project/project-merge";
import PressDragMenu from "../ui/PressDragMenu";
import PrimaryButton from "../ui/PrimaryButton";
import { useWorkbenchDaemonClient } from "./WorkbenchWorkspaceContext";
import { FolderOpenIcon } from "./workbench-icons";

const MERGE_HOLD_MS = 1_000;

function threadCountLabel (count: number) {
  return count === 1 ? "1 thread" : `${count} threads`;
}

export default function WorkbenchInaccessibleProjectSettings () {
  const daemon = useWorkbenchDaemonClient();
  const [projects, setProjects] = useState<InaccessibleProjects | null>(null);
  const [chosenTargets, setChosenTargets] = useState<Record<string, string>>({});
  const [mergingId, setMergingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    setProjects(null);
    setError("");
    void daemon.projectMerging.readInaccessible().then(next => {
      if (!cancelled) setProjects(next);
    }, (failure: Error) => {
      if (!cancelled) setError(failure.message);
    });
    return () => { cancelled = true; };
  }, [daemon]);

  async function merge (sourceId: string, targetId: string, sourceName: string) {
    setMergingId(sourceId);
    setError("");
    setStatus("");
    try {
      const { threadCount } = await daemon.projectMerging.merge({ sourceId, targetId });
      const target = projects?.targets.find(item => item.id === targetId);
      setStatus(`Moved ${threadCountLabel(threadCount)} from ${sourceName} into ${target?.name ?? "the chosen project"}.`);
      setProjects(await daemon.projectMerging.readInaccessible());
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to merge the project.");
    } finally {
      setMergingId(null);
    }
  }

  if (!projects) {
    return error
      ? <p role="alert" className="m-0 text-[0.8rem] text-danger">{error}</p>
      : <p className="m-0 text-detail text-fg/muted">Checking for inaccessible projects…</p>;
  }

  return (
    <section className="space-y-3 py-1">
      {projects.data.length ? <ul className="m-0 list-none space-y-3 p-0">
        {projects.data.map(project => {
          const targetId = chosenTargets[project.id] ?? project.suggestedTargetId;
          const target = projects.targets.find(item => item.id === targetId) ?? null;
          return (
            <li key={project.id} className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="flex min-w-0 flex-1 basis-56 flex-col">
                <span className="truncate text-[0.84rem] text-text">{project.name}</span>
                <span className="truncate text-[0.72rem] text-fg/muted" title={project.rootPaths.join("\n")}>
                  {project.rootPaths[0] ?? ""} · {threadCountLabel(project.threadCount)}
                </span>
              </span>
              <PressDragMenu
                label={`Merge ${project.name} into`}
                heading="Merge into"
                disabled={mergingId !== null || !projects.targets.length}
                items={projects.targets.map(item => ({
                  id: item.id,
                  checked: item.id === targetId,
                  content: (
                    <span className="flex min-w-0 flex-col text-left">
                      <span className="truncate">{item.name}</span>
                      <span className="truncate text-[0.72em] text-fg/muted">{item.rootPath}</span>
                    </span>
                  ),
                }))}
                onSelect={id => setChosenTargets(current => ({ ...current, [project.id]: id }))}
              >
                <FolderOpenIcon className="shrink-0" size={16} />
                <span className="min-w-0 max-w-52 truncate" title={target?.rootPath}>{target?.name ?? "Choose project"}</span>
              </PressDragMenu>
              <PrimaryButton
                shape="compact"
                holdToConfirmMs={MERGE_HOLD_MS}
                disabled={!target || mergingId !== null}
                pendingHalo={mergingId === project.id}
                onClick={() => { if (target) void merge(project.id, target.id, project.name); }}
              >Merge threads</PrimaryButton>
            </li>
          );
        })}
      </ul> : <p className="m-0 text-detail text-fg/muted">No inaccessible projects hold threads.</p>}
      {error ? <p role="alert" className="m-0 text-[0.8rem] text-danger">{error}</p> : null}
      {status ? <p role="status" className="m-0 text-[0.8rem] text-fg/muted">{status}</p> : null}
    </section>
  );
}
