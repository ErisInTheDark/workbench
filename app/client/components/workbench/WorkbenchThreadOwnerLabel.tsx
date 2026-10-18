/*
 * Exports:
 * - default WorkbenchThreadOwnerLabel: the project icon and host path of the folder a thread or launching draft runs in.
 */
"use client";

import type { WorkbenchLocationOwner } from "../../WorkbenchClient";
import type { WorkbenchThreadProject } from "../../workbench/WorkbenchThreadClient";
import WorkbenchProjectIcon from "./WorkbenchProjectIcon";
import WorkbenchProjectLocationLabel from "./WorkbenchProjectLocationLabel";
import { ProjectIcon } from "./workbench-icons";

export default function WorkbenchThreadOwnerLabel({ owner, project }: {
  owner: WorkbenchLocationOwner;
  project: WorkbenchThreadProject | null | undefined;
}) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 text-fg/muted" title={`${owner.hostname}: ${owner.rootPath}`}>
      {project && "kind" in project
        ? <WorkbenchProjectIcon project={project} variant="thread" />
        : <ProjectIcon className="shrink-0" size={16} />}
      <span className="min-w-0 truncate">
        <WorkbenchProjectLocationLabel displayPath={owner.displayPath} hostname={owner.hostname} />
      </span>
    </span>
  );
}
