/*
 * Exports:
 * - default WorkbenchEnvironmentSettings: edit one folder's encrypted store values and its .env files.
 */
"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { DaemonId, ProjectId } from "workbench-shared/workbench/identity";
import { isEnvironmentFile } from "workbench-shared/workbench/project/tree-utils";
import EnvironmentFilesController from "../../../workbench/environment/EnvironmentFilesController";
import ProjectStoreRowsController from "../../../workbench/environment/ProjectStoreRowsController";
import { createInitialEditHistory } from "../../../workbench/state/edit-history";
import FileDraftStore from "../../../workbench/state/FileDraftStore";
import InputList from "../InputList";
import { useWorkbenchClientStateController, useWorkbenchClientStateSnapshot } from "../workbench-client-state-context";
import { useWorkbenchDaemonClient } from "../WorkbenchWorkspaceContext";
import WorkbenchEnvironmentFile from "./WorkbenchEnvironmentFile";

function useStoreRows(projectId: ProjectId) {
  const daemon = useWorkbenchDaemonClient();
  const controller = useMemo(() => new ProjectStoreRowsController({
    read: () => daemon.projectStore.read({ projectId }),
    update: (upserts, removals) => daemon.projectStore.update({ projectId, upserts, removals }),
  }), [daemon, projectId]);
  useEffect(() => {
    void controller.load();
    return () => controller.dispose();
  }, [controller]);
  return { controller, state: useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot) };
}

function useEnvironmentFiles(daemonId: DaemonId, projectId: ProjectId, onDraftError: (message: string) => void) {
  const daemon = useWorkbenchDaemonClient();
  const clientState = useWorkbenchClientStateController();
  const registrationId = useWorkbenchClientStateSnapshot().registrations.find(item => item.daemonId === daemonId)?.id ?? null;
  const controller = useMemo(() => {
    // Without a daemon registration, drafts stay in memory for this page only.
    const drafts = FileDraftStore(() => projectId, undefined, registrationId ? clientState : undefined, onDraftError, () => registrationId ?? "");
    const hydrated = drafts.hydratePersistedDrafts();
    return new EnvironmentFilesController({
      listPaths: async () => (await daemon.projects.fileIndex({ projectId })).candidates
        .map(candidate => candidate.path).filter(isEnvironmentFile),
      read: async path => {
        const file = await daemon.projects.files.read({ projectId, path });
        return { content: file.content, mtimeMs: file.mtimeMs };
      },
      save: async (path, content, mtimeMs) => {
        const result = await daemon.projects.files.save({ projectId, path, content, expectedMtimeMs: mtimeMs, force: true });
        if ("actualMtimeMs" in result) throw new Error(result.error);
        return { mtimeMs: result.mtimeMs };
      },
      drafts: {
        read: async path => {
          await hydrated;
          return drafts.getBuffer(path)?.content ?? null;
        },
        write: (path, { baseline, content, mtimeMs }) => drafts.setBuffer(path, {
          baselineContent: baseline, content, dirty: true, editorState: content, expectedMtimeMs: mtimeMs, headContent: null,
          history: createInitialEditHistory(content), mode: "plain", pendingWriteConflict: null, saveIssue: null,
        }),
        clear: path => drafts.clearBuffer(path),
      },
    });
  }, [clientState, daemon, onDraftError, projectId, registrationId]);
  useEffect(() => {
    void controller.discover();
    return () => controller.dispose();
  }, [controller]);
  return { controller, state: useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot) };
}

export default function WorkbenchEnvironmentSettings({ daemonId, projectId }: { daemonId: DaemonId; projectId: ProjectId }) {
  const [draftError, setDraftError] = useState("");
  const store = useStoreRows(projectId);
  const files = useEnvironmentFiles(daemonId, projectId, setDraftError);
  return <div className="space-y-5 py-3">
    <section className="space-y-2">
      <h3 className="m-0 text-sm font-semibold text-text">Store</h3>
      <p className="m-0 text-[0.8rem] leading-5 text-fg/muted">Encrypted for this folder on its device. Reference values as <code>{"${wb:KEY}"}</code> in .env files.</p>
      <InputList kind="pairs" idPrefix="project-store" rowLabel="Store entry" keyPlaceholder="KEY" placeholder="value"
        disabled={store.state.status === "loading"} errors={store.state.issues}
        rows={store.state.rows} onRowsChange={rows => store.controller.setRows(rows)} />
      <div className="flex min-h-5 items-center gap-2 text-xs">
        {store.state.status === "loading" ? <p role="status" className="m-0 text-fg/muted">Loading store...</p> : null}
        {store.state.status === "saving" ? <p role="status" className="m-0 text-fg/muted">Saving...</p> : null}
        {store.state.status === "failed" ? <>
          <p role="alert" className="m-0 text-danger">{store.state.error}</p>
          <button type="button" className="rounded-lg px-2 py-1 text-accent hover:bg-accent-soft" onClick={() => store.controller.retry()}>Retry</button>
        </> : null}
      </div>
    </section>
    <section className="space-y-2">
      <h3 className="m-0 text-sm font-semibold text-text">Files</h3>
      {files.state.status === "loading" ? <p role="status" className="m-0 text-xs text-fg/muted">Finding .env files...</p> : null}
      {files.state.status === "failed" ? <p role="alert" className="m-0 text-xs text-danger">{files.state.error}</p> : null}
      {files.state.status === "ready" && !files.state.files.length
        ? <p role="status" className="m-0 text-xs text-fg/muted">No .env files in this folder.</p> : null}
      {draftError ? <p role="alert" className="m-0 text-xs text-danger">{draftError}</p> : null}
      <div className="space-y-0.5">
        {files.state.files.map(file => <WorkbenchEnvironmentFile key={file.path} controller={files.controller}
          file={file} savedStoreKeys={store.state.savedKeys} />)}
      </div>
    </section>
  </div>;
}
