/*
 * Exports:
 * - default ThreadPreviewFrame: render shared edge-framed previews for bulky thread content. Keywords: workbench, thread, preview, scroll, frame.
 */
"use client";

import type { CSSProperties, ReactNode } from "react";

type ThreadPreviewFrameMode = "panel" | "scroll";
type ThreadPreviewFrameEdgeBleed = "none" | "wide";
type ThreadPreviewFrameEdgeOffset = "left" | "none";
type ThreadPreviewFrameContentPadding = "none" | "normal";

interface ThreadPreviewFrameProps {
  backgroundClassName?: string;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  contentPadding?: ThreadPreviewFrameContentPadding;
  edgeBleed?: ThreadPreviewFrameEdgeBleed;
  edgeOffset?: ThreadPreviewFrameEdgeOffset;
  height?: string;
  mode?: ThreadPreviewFrameMode;
  scale?: number;
}

function joinClasses (...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

function getEdgeBleedClassName (edgeBleed: ThreadPreviewFrameEdgeBleed) {
  return edgeBleed === "wide" ? "before:-mx-8" : "";
}

function scaleCssLength (value: string, multiplier: number) {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)([a-z%]+)$/i);
  if (!match) {
    return `calc(${value} * ${multiplier})`;
  }

  return `${Number(match[1]) * multiplier}${match[2]}`;
}

export default function ThreadPreviewFrame ({
  backgroundClassName = "before:bg-[linear-gradient(to_right,transparent,#0008_10%,#0008_90%,transparent)]",
  children,
  className,
  contentClassName,
  contentPadding = "normal",
  edgeBleed = "none",
  edgeOffset = "left",
  height = "22rem",
  mode = "scroll",
  scale = 1,
}: ThreadPreviewFrameProps) {
  const normalizedScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const frameClassName = joinClasses(
    "relative min-w-0 max-w-full before:absolute before:inset-0 before:-z-1 before:hidden before:content-[''] before:border-y before:border-[color-mix(in_srgb,var(--text)_10%,transparent)] md:before:block",
    backgroundClassName,
    getEdgeBleedClassName(edgeBleed),
    edgeOffset === "left" && "-ml-8",
    mode === "scroll" && "flex overflow-hidden",
    className,
  );

  if (mode === "panel") {
    return (
      <div className={frameClassName}>
        <div className={joinClasses("min-w-0 max-w-full", contentClassName)}>
          {children}
        </div>
      </div>
    );
  }

  const outerStyle: CSSProperties = {
    height: scaleCssLength(height, normalizedScale),
  };
  const contentStyle: CSSProperties = {
    height,
    marginBottom: normalizedScale === 1 ? undefined : scaleCssLength(height, (normalizedScale - 1) * 0.5),
    marginTop: normalizedScale === 1 ? undefined : scaleCssLength(height, (normalizedScale - 1) * 0.5),
    transform: normalizedScale === 1 ? undefined : `scale(${normalizedScale})`,
    transformOrigin: "top left",
    width: normalizedScale === 1 ? undefined : `${100 / normalizedScale}%`,
  };

  return (
    <div className={frameClassName} style={outerStyle}>
      <div
        className={joinClasses(
          "explorer-scrollbar min-w-0 max-w-full overflow-y-auto",
          contentPadding === "normal" && "py-2",
          contentClassName,
        )}
        style={contentStyle}
      >
        {children}
      </div>
    </div>
  );
}
