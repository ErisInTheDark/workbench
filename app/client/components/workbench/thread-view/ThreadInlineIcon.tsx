/*
 * Exports:
 * - default ThreadInlineIcon: render one resolved agent-authored inline icon marker.
 */

import type { ComponentType, ReactNode } from "react";

import type { ThreadEmphasisColor, ThreadIconType } from "../../../workbench/markdown/thread-icon-marker";
import { AsteriskIcon, CheckIcon, CircleAlertIcon, type IconProps, XIcon } from "../workbench-icons";
import { getThreadMarkdownEmphasisColors } from "./thread-markdown-emphasis-colors";

const THREAD_INLINE_ICON_REGISTRY = {
  alert: CircleAlertIcon,
  asterisk: AsteriskIcon,
  check: CheckIcon,
  x: XIcon,
} satisfies Record<ThreadIconType, ComponentType<IconProps>>;

export default function ThreadInlineIcon ({ color, iconType, label }: {
  color: ThreadEmphasisColor | null;
  iconType: ThreadIconType;
  label: ReactNode | null;
}) {
  const Icon = THREAD_INLINE_ICON_REGISTRY[iconType];
  const colors = color === null ? null : getThreadMarkdownEmphasisColors(color);

  return (
    <span
      aria-label={label ? undefined : color === null ? `${iconType} marker` : `${color} ${iconType} marker`}
      className={label ? colors?.text : `inline-flex size-[1em] align-[-0.12em]${colors ? ` ${colors.text}` : ""}`}
      data-thread-inline-icon={iconType}
      data-thread-inline-icon-color={color ?? undefined}
      role={label ? undefined : "img"}
    >
      <Icon className={label ? "mr-[0.25em] inline-block align-[-0.12em]" : undefined} size={16} />
      {label}
    </span>
  );
}
