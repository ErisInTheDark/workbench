/*
 * Exports:
 * - default ClaimedPathsPanel: one agent's claimed project paths beside a pennant, optionally under a label and title line, as a card or flush in a host's own section.
 */
"use client";

import type { ReactNode } from "react";

import type { ProjectId } from "workbench-shared/workbench/identity";
import ProjectFilePath from "./ProjectFilePath";
import { PennantIcon } from "./workbench-icons";

/** A labelled panel gets its own header line so a long subagent title cannot shove the paths around. */
export default function ClaimedPathsPanel({ chrome = "card", label, paths, projectId, title }: {
  /** Flush drops the card background and padding for hosts that separate their own sections. */
  chrome?: "card" | "flush";
  label?: ReactNode;
  paths: readonly string[];
  projectId: ProjectId;
  title?: string;
}) {
  const flag = (
    <span className="inline-flex size-5 shrink-0 items-center justify-center text-fg/muted" aria-hidden="true">
      <PennantIcon size={16} />
    </span>
  );
  return (
    <div className={`
      scrollbar-hover-reveal flex max-h-56 min-h-0 flex-wrap content-start items-center gap-1 overflow-y-auto
      ${chrome === "card" ? "rounded-[0.65rem] bg-fg/4 p-2" : ""}
    `}>
      <div className="contents">
        {label ? (
          <div className="flex w-full min-w-0 items-center gap-1 text-[0.76rem]">
            {flag}
            <span className="shrink-0 font-medium text-fg/muted">{label}</span>
            {title ? <span className="min-w-0 truncate text-fg/muted">{title}</span> : null}
          </div>
        ) : flag}
        {paths.map((filePath) => (
          <ProjectFilePath className="max-w-full shrink" disambiguationPaths={paths} key={filePath} path={filePath} projectId={projectId} />
        ))}
      </div>
    </div>
  );
}
