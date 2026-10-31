/*
 * Exports:
 * - default ThreadVisPage: one vis document (a session's live render or a stored snapshot) framed from the vis origin;
 *   a large document waits behind a load button until the user asks for it.
 */
"use client";

import { useState } from "react";
import { isLargeVis, type VisControls } from "workbench-shared/workbench/vis/vis-contract";
import type { VisVariant } from "workbench-shared/workbench/vis/vis-url";
import useVisFrameUrl from "../../../workbench/app/use-vis-frame-url";
import PrimaryButton from "../../ui/PrimaryButton";
import ThreadVisFrame from "./ThreadVisFrame";

/** Documents the user chose to load in this tab, so a rebuild or remount never asks again. */
const loadedLargeDocuments = new Set<string>();

const megabytes = new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });

const placeholderClassName = "h-48 animate-pulse rounded-[0.65rem] bg-fg/4 motion-reduce:animate-none";

export default function ThreadVisPage({
  bytes, controls, fullscreen, onControl, onExitFullscreen, path, revision, sessionId, threadId, title, variant,
}: {
  bytes: number;
  controls?: VisControls;
  fullscreen?: boolean;
  onControl?: (id: string, value: string) => void;
  onExitFullscreen?: () => void;
  path: string;
  /** Changes with each render; snapshots never change. */
  revision: number;
  sessionId: string;
  threadId: string;
  title: string;
  variant: VisVariant;
}) {
  const key = `${sessionId}:${variant}`;
  const [loaded, setLoaded] = useState(() => !isLargeVis(bytes) || loadedLargeDocuments.has(key));
  const src = useVisFrameUrl(threadId, sessionId, variant, revision);
  if (!loaded && isLargeVis(bytes)) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-[0.65rem] bg-fg/4 text-[0.78rem] text-fg/muted">
        <span className="max-w-full truncate px-3">{path} is a large vis</span>
        <PrimaryButton
          onClick={() => {
            loadedLargeDocuments.add(key);
            setLoaded(true);
          }}
          shape="compact"
        >
          Load vis ({megabytes.format(bytes / (1024 * 1024))})
        </PrimaryButton>
      </div>
    );
  }
  if (!src) return <div aria-hidden="true" className={placeholderClassName} />;
  return (
    <ThreadVisFrame
      className="rounded-[0.65rem] bg-canvas"
      controls={controls}
      fullscreen={fullscreen}
      onControl={onControl}
      onExitFullscreen={onExitFullscreen}
      page={{ src }}
      title={title}
    />
  );
}
