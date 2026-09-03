/*
 * Exports:
 * - default ThreadHarnessControl: render a mutable harness rotator or immutable harness identity. Keywords: thread, composer, harness, control.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import { HarnessIcon } from "../workbench-icons";
import WorkbenchRotatorButton from "../WorkbenchRotatorButton";
import { formatHarnessLabel } from "./harness-label";

export default function ThreadHarnessControl({ canToggle = false, harness, onToggle }: {
  canToggle?: boolean;
  harness: WorkbenchHarness;
  onToggle?: () => void;
}) {
  const label = formatHarnessLabel(harness);
  const content = <><HarnessIcon className="size-4" harness={harness} /><span>{label}</span></>;
  return canToggle ? (
    <WorkbenchRotatorButton
      ariaLabel={`Current harness: ${label}. Click to use the next harness.`}
      onRotate={() => onToggle?.()}
      title={label}
    >
      {content}
    </WorkbenchRotatorButton>
  ) : <span className="inline-flex items-center gap-2 font-semibold text-text">{content}</span>;
}
