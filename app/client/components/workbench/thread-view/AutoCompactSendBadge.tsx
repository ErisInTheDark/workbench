/*
 * Exports:
 * - default AutoCompactSendBadge: corner badge on a send button whose next turn compacts context first.
 * - autoCompactSendLabel: suffix a send button's label when that send compacts context first.
 */
import { CompactIcon } from "../workbench-icons";
import SendActionBadge from "./SendActionBadge";

export function autoCompactSendLabel(label: string, willAutoCompact: boolean) {
  return willAutoCompact ? `${label} (compacts context first)` : label;
}

export default function AutoCompactSendBadge() {
  return (
    <SendActionBadge>
      <CompactIcon size={12} />
    </SendActionBadge>
  );
}
