/*
 * Exports:
 * - default WorkbenchConnectionSpinner: red loader beside the sidebar wordmark while the tab has no live app socket.
 */
"use client";

import { useWorkbenchAppConnectionInterrupted } from "../../workbench/app/WorkbenchAppRpcContext";
import LoaderIcon from "./LoaderIcon";

// Observations hold their last values through a drop, so this is the one place an outage is announced.
// The fade-in delay keeps sub-second blips (and a fast first connect) from flashing it.
export default function WorkbenchConnectionSpinner() {
  const interrupted = useWorkbenchAppConnectionInterrupted();
  if (!interrupted) return null;
  return (
    <span
      className="inline-flex shrink-0 animate-delayed-fade-in text-danger motion-reduce:animate-none"
      role="status"
      title="Reconnecting to Workbench…"
    >
      <LoaderIcon size={16} />
      <span className="sr-only">Reconnecting to Workbench</span>
    </span>
  );
}
