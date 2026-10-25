/*
 * Exports:
 * - default AutoCompactSendMenu: touch send control for a send that would compact context first; pressing opens a
 *   press-drag menu choosing to compact first (nearest the thumb) or send directly, so a tap never sends.
 */
"use client";

import PressDragMenu, { type PressDragMenuItem } from "../../ui/PressDragMenu";
import PrimaryButton from "../../ui/PrimaryButton";
import { CompactIcon, SendHorizontalIcon } from "../workbench-icons";
import AutoCompactSendBadge, { autoCompactSendLabel } from "./AutoCompactSendBadge";

type Choice = "direct" | "compact";

function ChoiceLabel ({ choice, label }: { choice: Choice; label: string }) {
  return <span className="flex min-w-0 items-center gap-2.5 text-text">
    {choice === "compact" ? <CompactIcon className="shrink-0" size={16} /> : <SendHorizontalIcon className="shrink-0" size={16} />}
    <span className="min-w-0 truncate">
      {choice === "compact" ? `Compact and ${label.toLowerCase()}` : `${label} directly`}
    </span>
  </span>;
}

/** `label` names the action, such as "Send" or "Submit"; `onSend` receives whether to skip compaction. */
export default function AutoCompactSendMenu ({ label, onSend }: {
  label: string;
  onSend: (skipAutoCompact: boolean) => void;
}) {
  // The menu opens above the composer's bottom-edge controls, so the compacting choice lands closest to the press.
  const items: PressDragMenuItem[] = (["direct", "compact"] as const).map(choice => ({
    id: choice, content: <ChoiceLabel choice={choice} label={label} />,
  }));

  return <PressDragMenu
    label={autoCompactSendLabel(label, true)}
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
      <SendHorizontalIcon size={20} />
      <AutoCompactSendBadge />
    </PrimaryButton.Face>
  </PressDragMenu>;
}
