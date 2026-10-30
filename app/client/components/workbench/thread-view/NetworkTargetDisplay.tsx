/*
 * Exports:
 * - default NetworkTargetDisplay: draw a network target with the app's own displays: a thread as its sidebar row (project and
 *   device eyebrow unless compact), a folder or feedback channel as its project label; plain text until the app knows it.
 */
"use client";

import type { NetworkTarget } from "workbench-shared/workbench/network/network-grants";
import { createLogicalExistingThreadRoute } from "workbench-shared/workbench/navigation/workbench-route";
import { ProjectIdSchema } from "workbench-shared/workbench/identity";
import { useWorkbenchProjectNavigation } from "../../../workbench/navigation/use-workbench-project-navigation";
import { useProject } from "../use-projects";
import { useThread } from "../use-thread";
import WorkbenchProjectLabel from "../WorkbenchProjectLabel";
import WorkbenchThreadListItem from "../WorkbenchThreadListItem";
import { NetworkIcon } from "../workbench-icons";

/** Before the app reads the target, or when it cannot reach the target's device: the stored name and its host. */
function PlainTarget({ name, hostname }: { name: string; hostname: string }) {
  return <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-text">
    <NetworkIcon className="shrink-0 text-fg/muted" size={16} />
    <span className="min-w-0 flex-1 truncate">{name}</span>
    <span className="shrink-0 text-[0.72rem] text-fg/muted">{hostname}</span>
  </div>;
}

function ThreadTarget({ target, compact }: { target: Extract<NetworkTarget, { kind: "thread" }>; compact: boolean }) {
  const located = useThread.summary(target.threadId);
  const project = useProject.forLocation(located?.location);
  const projectHref = useWorkbenchProjectNavigation();
  if (!located) return <PlainTarget hostname={target.hostname} name={target.title} />;
  const row = located.summary.row;
  const href = projectHref(createLogicalExistingThreadRoute(located.logicalProjectId, {
    harness: row.identity.harness, kind: "provider", threadId: row.identity.threadId,
  }));
  return <ul className="m-0 list-none p-0">
    <WorkbenchThreadListItem
      compact={compact}
      entry={row}
      href={href}
      project={compact ? undefined : project ?? undefined}
      projectId={ProjectIdSchema.parse(located.location.projectId)}
      projectSource={located.location}
      showTooltip={false}
    />
  </ul>;
}

function FolderTarget({ target }: { target: Extract<NetworkTarget, { kind: "folder" | "feedback" }> }) {
  const location = target.projectId ? { daemonId: target.daemonId, projectId: target.projectId } : null;
  const project = useProject.forLocation(location);
  if (!project || !location) {
    const name = target.rootPath ?? "All projects";
    return <PlainTarget hostname={target.hostname} name={target.kind === "feedback" ? `Feedback: ${name}` : name} />;
  }
  return <div className="px-2 py-1.5"><WorkbenchProjectLabel project={project} source={location} /></div>;
}

export default function NetworkTargetDisplay({ target, compact = false }: { target: NetworkTarget; compact?: boolean }) {
  return target.kind === "thread" ? <ThreadTarget compact={compact} target={target} /> : <FolderTarget target={target} />;
}
