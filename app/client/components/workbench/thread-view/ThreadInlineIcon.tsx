/*
 * Exports:
 * - default ThreadInlineIcon: resolve and render one supported agent-authored inline icon marker.
 */

import type { ComponentType, ReactNode } from "react";

import { AsteriskIcon, CheckIcon, CircleAlertIcon, type IconProps, XIcon } from "../workbench-icons";
import { getThreadMarkdownEmphasisColors } from "./thread-markdown-emphasis-colors";

type InlineIconComponent = ComponentType<IconProps>;

const THREAD_INLINE_ICON_REGISTRY = new Map<string, InlineIconComponent>([
  ["alert", CircleAlertIcon],
  ["check", CheckIcon],
  ["asterisk", AsteriskIcon],
  ["x", XIcon],
]);

export default function ThreadInlineIcon ({ color, iconType, label, source }: {
  color: string | null;
  iconType: string;
  label: ReactNode | null;
  source: string;
}) {
  const Icon = THREAD_INLINE_ICON_REGISTRY.get(iconType);
  const colors = color === null ? null : getThreadMarkdownEmphasisColors(color);
  if (!Icon || (color !== null && !colors)) {
    return source;
  }

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
