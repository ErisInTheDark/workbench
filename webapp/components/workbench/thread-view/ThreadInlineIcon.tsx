/*
 * Exports:
 * - default ThreadInlineIcon: resolve and render one supported agent-authored inline icon marker. Keywords: thread, markdown, icon, registry, alert.
 */

import type { ComponentType } from "react";

import { getWorkbenchThreadStatusClassName, type WorkbenchThreadStatusTone } from "../workbench-thread-status-colors";
import { CircleAlertIcon } from "../workbench-icons";

type InlineIconComponent = ComponentType<{ className?: string }>;

const THREAD_INLINE_ICON_REGISTRY = new Map<string, InlineIconComponent>([
  ["alert", CircleAlertIcon],
]);

const THREAD_INLINE_ICON_COLOR_TONES = new Map<string, WorkbenchThreadStatusTone>([
  ["blue", "working"],
  ["green", "completed"],
  ["purple", "needs-attention"],
  ["red", "stopped"],
  ["yellow", "needs-attention-active"],
]);

export default function ThreadInlineIcon ({ color, iconType, source }: {
  color: string;
  iconType: string;
  source: string;
}) {
  const Icon = THREAD_INLINE_ICON_REGISTRY.get(iconType);
  const tone = THREAD_INLINE_ICON_COLOR_TONES.get(color);
  if (!Icon || !tone) {
    return source;
  }

  return (
    <span
      aria-label={`${color} ${iconType} marker`}
      className={`inline-flex size-[1em] align-[-0.12em] ${getWorkbenchThreadStatusClassName(tone)}`}
      data-thread-inline-icon={iconType}
      data-thread-inline-icon-color={color}
      role="img"
    >
      <Icon className="size-full" />
    </span>
  );
}
