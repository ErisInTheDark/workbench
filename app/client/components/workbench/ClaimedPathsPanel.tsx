/*
 * Exports:
 * - default ClaimedPathsPanel: one agent's claimed project paths beside a pennant, optionally under a label and title line, flush in a host's own section; long lists show their first few until expanded.
 */
"use client";

import { useState, type ReactNode } from "react";

import type { ProjectId } from "workbench-shared/workbench/identity";
import RevealChip from "../ui/RevealChip";
import ProjectFilePath from "./ProjectFilePath";
import { PennantIcon } from "./workbench-icons";

/** Enough paths to recognise the work; the rest wait behind one click so huge claims cannot bury the tooltip. */
const COLLAPSED_PATH_COUNT = 10;

/** A labelled panel gets its own header line so a long subagent title cannot shove the paths around. */
export default function ClaimedPathsPanel({ label, paths, projectId, title }: {
  label?: ReactNode;
  paths: readonly string[];
  projectId: ProjectId;
  title?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const hidden = expanded ? 0 : Math.max(0, paths.length - COLLAPSED_PATH_COUNT);
  const shown = hidden ? paths.slice(0, COLLAPSED_PATH_COUNT) : paths;
  const flag = (
    <span className="inline-flex size-5 shrink-0 items-center justify-center text-fg/muted" aria-hidden="true">
      <PennantIcon size={16} />
    </span>
  );
  return (
    <div className="flex min-w-0 flex-wrap content-start items-center gap-1">
      {label ? (
        <div className="flex w-full min-w-0 items-center gap-1 text-[0.76rem]">
          {flag}
          <span className="shrink-0 font-medium text-fg/muted">{label}</span>
          {title ? <span className="min-w-0 truncate text-fg/muted">{title}</span> : null}
        </div>
      ) : flag}
      {shown.map((filePath) => (
        <ProjectFilePath className="max-w-full shrink" disambiguationPaths={paths} key={filePath} path={filePath} projectId={projectId} />
      ))}
      {hidden ? (
        <RevealChip
          aria-label={`Show ${hidden} more claimed ${hidden === 1 ? "path" : "paths"}`}
          data-claimed-paths-more="true"
          onClick={() => setExpanded(true)}
        >
          {`+${hidden} more`}
        </RevealChip>
      ) : null}
    </div>
  );
}
