/*
 * Exports:
 * - default AutoCompactSendBadge: corner badge on a send button whose next turn compacts context first.
 * - autoCompactSendLabel: suffix a send button's label when that send compacts context first.
 */
import { CompactIcon } from "../workbench-icons";

export function autoCompactSendLabel(label: string, willAutoCompact: boolean) {
  return willAutoCompact ? `${label} (compacts context first)` : label;
}

export default function AutoCompactSendBadge() {
  return (
    <span
      aria-hidden="true"
      className="
        absolute -right-2.5 -bottom-2.5 inline-flex size-3.5 items-center justify-center rounded-full
        bg-[color:var(--text)] text-[color:var(--app-bg-solid)]
        ring-2 ring-[color:var(--app-bg-solid)]
      "
    >
      <CompactIcon size={12} />
    </span>
  );
}
