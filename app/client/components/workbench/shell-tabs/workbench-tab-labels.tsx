/*
 * Exports:
 * - WorkbenchTabKindProps: the destination of one tab and the strip's frame facts.
 * - workbenchTabKinds: per-view tab renderers naming the destination with its icon, live state, project row and extra
 *   actions.
 */
"use client";

import { useContext, useEffect, useState, useSyncExternalStore, type ComponentProps, type ComponentType } from "react";
import type { IconProps } from "../OutlinedIcon";

import type { WorkbenchRoute, WorkbenchRouteView } from "workbench-shared/workbench/navigation/workbench-route";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import { describeThreadEntry } from "../thread-entry-presentation";
import ThreadTitleInput from "../ThreadTitleInput";
import { useProject } from "../use-projects";
import { useThread } from "../use-thread";
import WorkbenchProjectLabel from "../WorkbenchProjectLabel";
import WorkbenchClientContext from "../workbench-client-context";
import {
  DraftThreadIcon, FolderClosedIcon, GearIcon, GitGraphIcon, StatsIcon,
} from "../workbench-icons";
import FileKindIcon from "../file-kind-icon";
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
  return project ? <WorkbenchProjectLabel project={project} source={location ?? undefined} variant="thread" /> : null;
}

/** A file tab shows its draft's unsaved asterisk, and a preview tab with unsaved work keeps itself open. */
function FileTab({ frame, route }: WorkbenchTabKindProps) {
  const mounted = useContext(WorkbenchClientContext)?.mounted;
  const location = mounted?.projectNavigator.fileLocationFor(route) ?? null;
  const drafts = location ? mounted?.files.draftsFor(location) ?? null : null;
  const path = route.filePath;
  const dirty = useSyncExternalStore(drafts?.subscribe ?? noSubscription,
    () => drafts?.getBuffer(path)?.dirty ?? false, () => false);
  const { onKeepOpen, preview } = frame;
  useEffect(() => { if (dirty && preview) onKeepOpen(); }, [dirty, onKeepOpen, preview]);
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

function ThreadTab({ frame, route }: WorkbenchTabKindProps) {
  const target = route.threadTarget;
  const threadId = target?.kind === "provider" || target?.kind === "subagent" ? target.threadId : null;
  const thread = useThread.summary(threadId);
  const controls = useContext(WorkbenchClientContext)?.controls ?? null;
  const [renaming, setRenaming] = useState(false);
  const entry = thread?.summary.row ?? null;
  const shown = entry ? describeThreadEntry(entry, { facts: thread?.summary.facts }) : null;
  const title = entry?.title || (target?.kind === "draft" ? "Draft" : target?.kind === "new" ? "New thread" : "Thread");
  const identity = entry?.identity ?? null;
  const rename = identity && controls ? async (nextTitle: string) => await controls.setThreadTitle({
    harness: identity.harness, threadId: identity.threadId, title: nextTitle,
  }) : null;
  const Icon = shown?.Icon ?? DraftThreadIcon;
  const projectId = thread?.location.projectId ?? null;
  return (
    <WorkbenchShellTab
      {...frame}
      actions={rename ? [{ id: "rename", label: "Rename", onSelect: () => setRenaming(true) }] : []}
      icon={<Icon className={shown?.statusClassName} size={ICON_SIZE} />}
      label={renaming && rename
        ? <ThreadTitleInput className="w-[12rem]" onDone={() => setRenaming(false)} onSave={rename} title={title} />
        : title}
      onSelectedActivate={rename ? () => setRenaming(true) : undefined}
      project={thread ? <TabProjectRow location={thread.location} /> : null}
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
