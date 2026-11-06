/*
 * Exports:
 * - default AutoCompactSendMenu: touch control for a send, answer or resume that would compact context first; pressing opens a
 *   press-drag menu choosing to compact first (nearest the thumb) or act directly, so a tap never sends.
 */
"use client";

import type { ComponentType } from "react";
import type { ThreadAutoCompactCause } from "workbench-shared/workbench/settings/thread-auto-compact";
import PressDragMenu, { type PressDragMenuItem } from "../../ui/PressDragMenu";
import PrimaryButton from "../../ui/PrimaryButton";
import { CompactIcon, SendHorizontalIcon, type IconProps } from "../workbench-icons";
import AutoCompactSendBadge, { autoCompactSendLabel } from "./AutoCompactSendBadge";

type Choice = "direct" | "compact";

function ChoiceLabel ({ choice, label, Icon }: { choice: Choice; label: string; Icon: ComponentType<IconProps> }) {
  return <span className="flex min-w-0 items-center gap-2.5 text-text">
    {choice === "compact" ? <CompactIcon className="shrink-0" size={16} /> : <Icon className="shrink-0" size={16} />}
    <span className="min-w-0 truncate">
      {choice === "compact" ? `Compact and ${label.toLowerCase()}` : `${label} directly`}
    </span>
  </span>;
}

/** `label` names the action, such as "Send" or "Resume", and `Icon` draws it; `onSend` receives whether to skip compaction. */
export default function AutoCompactSendMenu ({ label, cause, Icon = SendHorizontalIcon, iconSize = 20, onSend }: {
  label: string;
  cause: ThreadAutoCompactCause;
  Icon?: ComponentType<IconProps>;
  iconSize?: IconProps["size"];
  onSend: (skipAutoCompact: boolean) => void;
}) {
  // The menu opens above the composer's bottom-edge controls, so the compacting choice lands closest to the press.
  const items: PressDragMenuItem[] = (["direct", "compact"] as const).map(choice => ({
    id: choice, content: <ChoiceLabel choice={choice} label={label} Icon={Icon} />,
  }));

  return <PressDragMenu
    label={autoCompactSendLabel(label, cause)}
    align="end"
    items={items}
    triggerAppearance="plain"
    triggerClassName={`
      ${PrimaryButton.className("circle")}
      [-webkit-touch-callout:none]
      aria-expanded:[--primary-button-bg:var(--primary-button-hover)]
    `}
    onSelect={id => onSend(id === "direct")}
  >
    <PrimaryButton.Face>
      <Icon size={iconSize} />
      <AutoCompactSendBadge cause={cause} />
    </PrimaryButton.Face>
  </PressDragMenu>;
}
