/*
 * Exports:
 * - default WorkbenchHomeDraftProjectControl: the home draft composer's project pill; choosing a project moves the draft (and its
 *   open editor session) there, reporting failures through the shell error banner.
 */
"use client";

import { useState, type RefObject } from "react";

import type {
  ThreadPayload,
  WorkbenchComposerInputDraft,
  WorkbenchLogicalProject,
  WorkbenchProjectOption,
} from "workbench-shared/types";
import { DraftIdSchema } from "workbench-shared/workbench/identity";
import {
  createHomeThreadRoute,
  createLogicalThreadRoute,
  isSameDraftRouteIntent,
  type WorkbenchRoute,
} from "workbench-shared/workbench/navigation/workbench-route";
import { useWorkbenchNavigate } from "../../workbench/navigation/use-workbench-project-navigation";
import type DraftSessionController from "./thread-view/DraftSessionController";
import { draftSessionOwner } from "./thread-view/DraftSessionController";
import { useWorkbenchClientController } from "./workbench-client-context";
import { useWorkbenchShellError } from "./workbench-shell-error-context";
import WorkbenchProjectControl from "./WorkbenchProjectControl";

type DraftProject = WorkbenchProjectOption | WorkbenchLogicalProject;

export default function WorkbenchHomeDraftProjectControl ({
  draftSession, project, projects, route, routeRef, thread,
}: {
  draftSession: RefObject<DraftSessionController<WorkbenchComposerInputDraft> | null>;
  /** The project the draft lives in now. */
  project: DraftProject;
  /** The sidebar's selected projects: logical projects on logical routes, physical ones otherwise. */
  projects: readonly DraftProject[];
  /** The route the draft is open under. */
  route: WorkbenchRoute;
  /** The latest route; a move the user navigated away from is dropped. */
  routeRef: RefObject<WorkbenchRoute>;
  thread: ThreadPayload | null;
}) {
  const client = useWorkbenchClientController();
  const navigateToRoute = useWorkbenchNavigate();
  const reportError = useWorkbenchShellError();
  const [isPending, setIsPending] = useState(false);

  const moveDraft = async (nextProjectId: string) => {
    const controls = client.controls;
    const nextProject = projects.find(({ id }) => id === nextProjectId);
    if (!controls || !nextProject || nextProject.id === project.id) return;
    setIsPending(true);
    reportError?.("");
    try {
      const target = route.threadTarget;
      if (route.logical) {
        const destination = "matchKey" in nextProject ? nextProject.locations.find(item => item.project)?.target : undefined;
        if (!("matchKey" in nextProject) || !destination) throw new Error("That project's daemon folder is unavailable.");
        const session = draftSession.current;
        const draftId = target?.kind === "draft" ? target.draftId
          : thread?.isDraft ? DraftIdSchema.parse(thread.id) : null;
        const owner = client.mounted?.presentationClient;
        if (!session || !draftId || !owner) throw new Error("The draft editor is unavailable.");
        await session.retarget(draftSessionOwner(destination.projectId, draftId), async () => {
          if (!isSameDraftRouteIntent(route, routeRef.current, draftId)) return false;
          const draft = owner.draft(draftId);
          if (draft) await controls.retargetPresentationDraft(draftId, destination, nextProject.id);
          if (!isSameDraftRouteIntent(route, routeRef.current, draftId)) return false;
          navigateToRoute(createLogicalThreadRoute(null, nextProject.id, draft ? null : destination,
            draft ? { kind: "draft", draftId } : { kind: "new" }), { replace: Boolean(draft) });
          return true;
        });
        return;
      }
      if ("matchKey" in project || "matchKey" in nextProject) return;
      if (target?.kind === "draft") {
        await controls.moveThreadDraft(project.id, nextProject.id, target.draftId);
        navigateToRoute(createHomeThreadRoute(nextProject.id, target));
      } else {
        navigateToRoute(createHomeThreadRoute(nextProject.id, { kind: "new" }));
      }
    } catch (error) {
      reportError?.((error instanceof Error ? error.message : "Unable to move this draft.").slice(0, 500));
    } finally {
      setIsPending(false);
    }
  };

  return (
    <WorkbenchProjectControl
      disabled={isPending || projects.length < 2}
      onSelect={nextProjectId => { void moveDraft(nextProjectId); }}
      project={project}
      projects={projects}
    />
  );
}
