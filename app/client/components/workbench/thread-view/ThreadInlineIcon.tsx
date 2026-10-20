/*
 * Exports:
 * - default ThreadInlineIcon: render one resolved agent-authored inline icon marker; a streamed label eases into its colour.
 */

import { useLayoutEffect, useRef, type ComponentType, type ReactNode } from "react";

import type { ThreadEmphasisColor, ThreadIconType } from "../../../workbench/markdown/thread-emphasis-markup";
import { AsteriskIcon, CheckIcon, CircleAlertIcon, type IconProps, XIcon } from "../workbench-icons";
import { getThreadMarkdownEmphasisColors } from "./thread-markdown-emphasis-colors";

const THREAD_INLINE_ICON_REGISTRY = {
  alert: CircleAlertIcon,
  asterisk: AsteriskIcon,
  check: CheckIcon,
  x: XIcon,
} satisfies Record<ThreadIconType, ComponentType<IconProps>>;
const LABEL_TINT_DURATION_MS = 400;

/** When a label appears, its text eases from the surrounding text colour into the marker colour. */
function useLabelTint(tinted: boolean) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const label = ref.current;
    const surrounding = label?.parentElement?.parentElement;
    if (!tinted || !label?.animate || !surrounding) return;
    const animation = label.animate(
      [{ color: getComputedStyle(surrounding).color }, { color: getComputedStyle(label).color }],
      { duration: LABEL_TINT_DURATION_MS, easing: "ease-out" },
    );
    return () => animation.cancel();
  }, [tinted]);
  return ref;
}

export default function ThreadInlineIcon ({ animateLabelTint = false, color, iconType, label }: {
  /** Streaming: label text was visible uncoloured until its closing tag arrived, so its colour eases in. */
  animateLabelTint?: boolean;
  color: ThreadEmphasisColor | null;
  iconType: ThreadIconType;
  label: ReactNode | null;
}) {
  const Icon = THREAD_INLINE_ICON_REGISTRY[iconType];
  const colors = color === null ? null : getThreadMarkdownEmphasisColors(color);
  const labelRef = useLabelTint(animateLabelTint && label !== null && colors !== null);

  return (
    <span
      aria-label={label ? undefined : color === null ? `${iconType} marker` : `${color} ${iconType} marker`}
      className={label ? colors?.text : `inline-flex size-[1em] align-[-0.12em]${colors ? ` ${colors.text}` : ""}`}
      data-thread-inline-icon={iconType}
      data-thread-inline-icon-color={color ?? undefined}
      role={label ? undefined : "img"}
    >
      <Icon className={label ? "mr-[0.25em] inline-block align-[-0.12em]" : undefined} size={16} />
      {label === null ? null : <span ref={labelRef}>{label}</span>}
    </span>
  );
}
