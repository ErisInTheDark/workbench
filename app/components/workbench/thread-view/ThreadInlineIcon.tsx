/*
 * Exports:
 * - default ThreadInlineIcon: resolve and render one supported agent-authored inline icon marker.
 */

import type { ComponentType } from "react";

import { CircleAlertIcon, type IconProps } from "../workbench-icons";
import { getThreadMarkdownEmphasisColors } from "./thread-markdown-emphasis-colors";

type InlineIconComponent = ComponentType<IconProps>;

const THREAD_INLINE_ICON_REGISTRY = new Map<string, InlineIconComponent>([
  ["alert", CircleAlertIcon],
]);

export default function ThreadInlineIcon ({ color, iconType, source }: {
  color: string;
  iconType: string;
  source: string;
}) {
  const Icon = THREAD_INLINE_ICON_REGISTRY.get(iconType);
  const colors = getThreadMarkdownEmphasisColors(color);
  if (!Icon || !colors) {
    return source;
  }

  return (
    <span
      aria-label={`${color} ${iconType} marker`}
      className={`inline-flex size-[1em] align-[-0.12em] ${colors.text}`}
      data-thread-inline-icon={iconType}
      data-thread-inline-icon-color={color}
      role="img"
    >
      <Icon size={16} />
    </span>
  );
}
