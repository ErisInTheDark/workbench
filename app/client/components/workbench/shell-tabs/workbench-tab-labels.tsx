/*
 * Exports:
 * - WorkbenchTabKindProps: the destination of one tab and the strip's frame facts.
 * - workbenchTabKinds: per-view tab renderers naming the destination with its icon, live state, project row and extra
 *   actions; draft tabs name their prompt and folder like their sidebar row, reading as working while they launch.
 */
"use client";

import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ComponentType } from "react";
import type { IconProps } from "../OutlinedIcon";

import type { DraftId } from "workbench-shared/workbench/identity";
import type { WorkbenchRoute, WorkbenchRouteView } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { createDraftTitle } from "workbench-shared/workbench/thread/thread-state";
import { describeThreadEntry } from "../thread-entry-presentation";
import { getWorkbenchThreadStatusClassName } from "../workbench-thread-status-colors";
import ThreadTitleInput from "../ThreadTitleInput";
import { useProject } from "../use-projects";
import { useThread } from "../use-thread";
import WorkbenchProjectLabel from "../WorkbenchProjectLabel";
import WorkbenchClientContext from "../workbench-client-context";
import {
  BookBookmarkIcon, DraftThreadIcon, FolderClosedIcon, GearIcon, GitGraphIcon, StatsIcon, WorkingThreadIcon,
} from "../workbench-icons";
import FileKindIcon from "../file-kind-icon";
import { folderOf } from "../../../workbench/file/use-folder-entries";
import WorkbenchThreadHoverTooltip from "../WorkbenchThreadHoverTooltip";
import WorkbenchShellTab, { type WorkbenchShellTabFrameProps } from "./WorkbenchShellTab";

export interface WorkbenchTabKindProps {
  frame: WorkbenchShellTabFrameProps;
  route: WorkbenchRoute;
}

const ICON_SIZE = 14;
type TooltipTrigger = ComponentProps<typeof WorkbenchThreadHoverTooltip>["children"];
const noSubscription = () => () => {};

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1) || path;
}

function staticTab(label: string, Icon: ComponentType<IconProps>) {
  return function StaticTab({ frame }: WorkbenchTabKindProps) {
    return <WorkbenchShellTab {...frame} icon={<Icon size={ICON_SIZE} />} label={label} />;
  };
}

/** The tiny project row a tab shows under its label, the same one sidebar thread rows carry. */
function TabProjectRow({ location }: { location: ProjectLocationReference | null }) {
  const project = useProject.forLocation(location);
  return project ? <WorkbenchProjectLabel project={project} source={location ?? undefined} variant="tab" /> : null;
}

/**
 * A file tab shows its draft's unsaved asterisk, and a preview tab with unsaved work keeps itself open. Turned into its
 * folder index, it names the folder instead.
 */
function FileTab({ frame, route }: WorkbenchTabKindProps) {
  const mounted = useContext(WorkbenchClientContext)?.mounted;
  const location = mounted?.projectNavigator.fileLocationFor(route) ?? null;
  const drafts = location ? mounted?.files.draftsFor(location) ?? null : null;
  const path = route.filePath;
  const dirty = useSyncExternalStore(drafts?.subscribe ?? noSubscription,
    () => drafts?.getBuffer(path)?.dirty ?? false, () => false);
  const { onKeepOpen, preview } = frame;
  useEffect(() => { if (dirty && preview) onKeepOpen(); }, [dirty, onKeepOpen, preview]);
  if (route.fileIndex) {
    const folder = folderOf(path);
    return (
      <WorkbenchShellTab
        {...frame}
        icon={<BookBookmarkIcon size={ICON_SIZE} />}
        label={folder ? fileName(folder) : "index"}
        project={<TabProjectRow location={location} />}
        title={`Index of ${folder || "the project"}`}
      />
    );
  }
  return (
    <WorkbenchShellTab
      {...frame}
      dirty={dirty}
      icon={<FileKindIcon path={path} size={ICON_SIZE} />}
      label={fileName(path)}
      project={<TabProjectRow location={location} />}
      title={path}
    />
  );
}

/** A draft tab names its saved prompt like its sidebar row, and reads as working while its launch connects. */
function useDraftTab(draftId: DraftId | null) {
  const mounted = useContext(WorkbenchClientContext)?.mounted;
  const presentation = mounted?.presentationClient ?? null;
  const read = useCallback(() => draftId ? presentation?.draft(draftId) ?? null : null, [draftId, presentation]);
  const current = useSyncExternalStore(presentation?.subscribe ?? noSubscription, read, read);
  // An accepted launch leaves the presentation a moment before its route moves on to the thread.
  const retained = useRef(current);
  if (current) retained.current = current;
  const draft = current ?? (retained.current?.id === draftId ? retained.current : null);
  const location = draft?.target ?? (draftId ? mounted?.draftLocationFor(draftId) : null) ?? null;
  // Read without a lease: the tab must not start the draft's feed, and its document stays current regardless.
  const store = draftId && location ? mounted?.getThreadStore(location.projectId, { kind: "draft", draftId }) ?? null : null;
  const subscribe = useCallback((listener: () => void) => store?.subscribe("summary", listener) ?? (() => {}), [store]);
  const readLaunching = useCallback(() => store?.getSlice("summary").head?.status === "active", [store]);
  const launching = useSyncExternalStore(subscribe, readLaunching, readLaunching);
  return draftId ? { title: draft ? createDraftTitle(draft.prompt) : "Draft", location, launching } : null;
}

function ThreadTab({ frame, route }: WorkbenchTabKindProps) {
  const target = route.threadTarget;
  const threadId = target?.kind === "provider" || target?.kind === "subagent" ? target.threadId : null;
  const thread = useThread.summary(threadId);
  const draft = useDraftTab(target?.kind === "draft" ? target.draftId : null);
  const controls = useContext(WorkbenchClientContext)?.controls ?? null;
  const [renaming, setRenaming] = useState(false);
  const entry = thread?.summary.row ?? null;
  const shown = entry ? describeThreadEntry(entry, { facts: thread?.summary.facts }) : null;
  const title = entry?.title || draft?.title || (target?.kind === "new" ? "New thread" : "Thread");
  const identity = entry?.identity ?? null;
  const rename = identity && controls ? async (nextTitle: string) => await controls.setThreadTitle({
    harness: identity.harness, threadId: identity.threadId, title: nextTitle,
  }) : null;
  const Icon = shown?.Icon ?? (draft?.launching ? WorkingThreadIcon : DraftThreadIcon);
  const iconClassName = shown?.statusClassName ?? (draft?.launching ? getWorkbenchThreadStatusClassName("working") : undefined);
  const projectId = thread?.location.projectId ?? null;
  const location = thread?.location ?? draft?.location ?? null;
  return (
    <WorkbenchShellTab
      {...frame}
      actions={rename ? [{ id: "rename", label: "Rename", onSelect: () => setRenaming(true) }] : []}
      icon={<Icon className={iconClassName} size={ICON_SIZE} />}
      label={renaming && rename
        ? <ThreadTitleInput className="w-[12rem]" onDone={() => setRenaming(false)} onSave={rename} title={title} />
        : title}
      onSelectedActivate={rename ? () => setRenaming(true) : undefined}
      project={location ? <TabProjectRow location={location} /> : null}
      wrap={identity && projectId && !renaming ? (element: TooltipTrigger) => (
        <WorkbenchThreadHoverTooltip thread={{ harness: identity.harness, projectId, threadId: identity.threadId }} title={title}>
          {element}
        </WorkbenchThreadHoverTooltip>
      ) : undefined}
    />
  );
}

/** Views that are tabs; home and project views are the selection itself, and mosaic has no address. */
export const workbenchTabKinds: Partial<Record<WorkbenchRouteView, ComponentType<WorkbenchTabKindProps>>> = {
  file: FileTab,
  git: staticTab("Git", GitGraphIcon),
  "new-project": staticTab("New project", FolderClosedIcon),
  settings: staticTab("Settings", GearIcon),
  stats: staticTab("Statistics", StatsIcon),
  thread: ThreadTab,
};
