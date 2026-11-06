/*
 * Exports:
 * - default AutoCompactSendBadge: corner badge on a send button whose next turn compacts context first, amber when the cache expired.
 * - autoCompactSendLabel: suffix a send button's label with why that send compacts context first.
 */
import type { ThreadAutoCompactCause } from "workbench-shared/workbench/settings/thread-auto-compact";
import { CompactIcon } from "../workbench-icons";
import SendActionBadge from "./SendActionBadge";

const causeLabels: Record<ThreadAutoCompactCause, string> = {
  noCache: "compacts first, cache expired",
  tooMuchContext: "compacts first, context too large",
};

export function autoCompactSendLabel(label: string, cause: ThreadAutoCompactCause | null) {
  return cause ? `${label} (${causeLabels[cause]})` : label;
}

export default function AutoCompactSendBadge({ cause }: { cause: ThreadAutoCompactCause }) {
  return (
    <SendActionBadge tone={cause === "noCache" ? "warning" : "plain"}>
      <CompactIcon size={12} />
    </SendActionBadge>
  );
}
