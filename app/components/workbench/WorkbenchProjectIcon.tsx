/*
 * Exports:
 * - default WorkbenchProjectIcon: render one discovered project asset or a stable theme-aware initial fallback. Keywords: project, icon, favicon, fallback, color.
 */
"use client";

import { useEffect, useState, type CSSProperties } from "react";

import { getWorkbenchProjectIconUrl } from "workbench-shared/codex/config";
import type { WorkbenchProjectOption } from "workbench-shared/types";
import { getIdentityAccentColor } from "../../workbench/identity-accent-color";

const VARIANT_CLASS_NAMES = {
  card: {
    max: "max-h-5 max-w-5",
    size: "size-5",
    text: "text-[0.68rem]",
  },
  heading: {
    max: "max-h-7 max-w-7",
    size: "size-7",
    text: "text-[0.82rem]",
  },
  thread: {
    max: "max-h-4 max-w-4",
    size: "size-4",
    text: "text-[0.56rem]",
  },
} as const;

function projectInitial (project: WorkbenchProjectOption) {
  return Array.from((project.name || project.id).trim())[0]?.toLocaleUpperCase() || "?";
}

export default function WorkbenchProjectIcon ({
  project,
  variant = "card",
}: {
  project: WorkbenchProjectOption;
  variant?: keyof typeof VARIANT_CLASS_NAMES;
}) {
  const assetKey = project.icon ? `${project.id}:${project.icon.rootId}:${project.icon.path}` : project.id;
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [assetKey]);
  const className = `inline-flex shrink-0 rounded-[0.3rem] items-center justify-center overflow-hidden font-semibold leading-none`;

  if (project.icon && !loadFailed) {
    return (
      <span aria-hidden="true" className={`${className} ${VARIANT_CLASS_NAMES[variant].max}`}>
        <img
          alt=""
          className="max-h-full max-w-full object-contain"
          src={getWorkbenchProjectIconUrl(project.id, assetKey)}
          onError={() => setLoadFailed(true)}
        />
      </span>
    );
  }

  const accentColor = getIdentityAccentColor(project.id, 72);
  return (
    <span
      aria-hidden="true"
      className={`${className} ${VARIANT_CLASS_NAMES[variant].size} ${VARIANT_CLASS_NAMES[variant].text}`}
      style={{
        backgroundColor: `color-mix(in srgb, ${accentColor} 22%, transparent)`,
        color: accentColor,
      } satisfies CSSProperties}
    >
      {projectInitial(project)}
    </span>
  );
}
