/*
 * Exports:
 * - default WorkbenchProjectIcon: render a concrete or logical project's discovered asset, stable theme-aware initial, computer glyph for daemon projects, or generic glyph fallback.
 */
"use client";

import { useContext, useEffect, useState } from "react";

import type { WorkbenchLogicalProject, WorkbenchProjectOption } from "workbench-shared/types";
import { getIdentityAccentHue, type IdentityAccentStyle } from "../../workbench/identity-accent-color";
import { ComputerIcon, ProjectIcon } from "./workbench-icons";
import {
  resolveWorkbenchDaemonAssetOrigin, WorkbenchDaemonAssetOriginContext,
  type WorkbenchDaemonAssetSource,
  getWorkbenchProjectIconUrl,
} from "./WorkbenchWorkspaceContext";

const VARIANT_CLASS_NAMES = {
  card: {
    glyph: 16,
    max: "max-h-5 max-w-5",
    size: "size-5",
    text: "text-[0.68rem]",
  },
  heading: {
    glyph: 20,
    max: "max-h-7 max-w-7",
    size: "size-7",
    text: "text-[0.82rem]",
  },
  thread: {
    glyph: 16,
    max: "max-h-4 max-w-4",
    size: "size-4",
    text: "text-[0.56rem]",
  },
} as const;

function projectInitial (project: WorkbenchProjectOption) {
  return Array.from((project.name || project.id).trim())[0]?.toLocaleUpperCase() || "?";
}

/** Pick the folder that represents a logical project's icon, preferring one with a discovered asset. */
function logicalIconFolder (project: WorkbenchLogicalProject) {
  const folders = [
    ...project.locations.flatMap(location => location.project ? [{ daemonId: location.daemonId, project: location.project }] : []),
    ...project.observedLocations ?? [],
  ];
  const folder = folders.find(item => item.project.icon) ?? folders[0];
  return folder ? { project: folder.project, assetSource: { kind: "source" as const, daemonId: folder.daemonId } } : null;
}

export default function WorkbenchProjectIcon ({
  project: target,
  assetSource: explicitSource,
  variant = "card",
}: {
  project: WorkbenchProjectOption | WorkbenchLogicalProject;
  assetSource?: WorkbenchDaemonAssetSource;
  variant?: keyof typeof VARIANT_CLASS_NAMES;
}) {
  const folder = "matchKey" in target ? logicalIconFolder(target) : { project: target, assetSource: explicitSource };
  const project = folder?.project ?? null;
  const assetKey = project?.icon ? `${project.id}:${project.icon.rootId}:${project.icon.path}` : project?.id ?? "";
  const contextSource = useContext(WorkbenchDaemonAssetOriginContext);
  const origin = resolveWorkbenchDaemonAssetOrigin(folder?.assetSource ?? contextSource);
  const assetUrl = project ? getWorkbenchProjectIconUrl(project.id, assetKey, origin) : null;
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [assetKey, assetUrl]);
  const className = `inline-flex shrink-0 rounded-[0.3rem] items-center justify-center overflow-hidden font-semibold leading-none`;

  if (!project) return <ProjectIcon aria-hidden="true" className="shrink-0" size={VARIANT_CLASS_NAMES[variant].glyph} />;
  if (project.kind === "daemon") return <ComputerIcon aria-hidden="true" className="shrink-0" size={VARIANT_CLASS_NAMES[variant].glyph} />;

  if (project.icon && assetUrl && !loadFailed) {
    return (
      <span aria-hidden="true" className={`${className} ${VARIANT_CLASS_NAMES[variant].max}`}>
        <img
          alt=""
          className="max-h-full max-w-full object-contain"
          src={assetUrl}
          onError={() => setLoadFailed(true)}
        />
      </span>
    );
  }

  const accentStyle: IdentityAccentStyle = {
    "--identity-hue": getIdentityAccentHue(project.id),
    "--hue-chroma": "72%",
  };
  return (
    <span
      aria-hidden="true"
      className={`
        ${className} ${VARIANT_CLASS_NAMES[variant].size} ${VARIANT_CLASS_NAMES[variant].text}
        text-hue-(--identity-hue) bg-hue-(--identity-hue)/22
      `}
      style={accentStyle}
    >
      {projectInitial(project)}
    </span>
  );
}
