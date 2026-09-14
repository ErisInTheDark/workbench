/*
 * Exports:
 * - default ThreadHarnessControl: render a harness rotator or immutable ribbon/inline identity.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import { HarnessIcon } from "../workbench-icons";
import WorkbenchRotatorButton from "../WorkbenchRotatorButton";
import { formatHarnessLabel } from "./harness-label";

export default function ThreadHarnessControl({ canToggle = false, harness, onToggle, inline = false }: {
  canToggle?: boolean;
  harness: WorkbenchHarness;
  onToggle?: () => void;
  inline?: boolean;
}) {
  const label = formatHarnessLabel(harness);
  const inlineIdentity = inline && !canToggle;
  const content = <><HarnessIcon className={inlineIdentity ? "shrink-0 self-center" : undefined} harness={harness} size={16} /><span>{label}</span></>;
  return canToggle ? (
    <WorkbenchRotatorButton
      ariaLabel={`Current harness: ${label}. Click to use the next harness.`}
      onRotate={() => onToggle?.()}
      title={label}
    >
      {content}
    </WorkbenchRotatorButton>
  ) : <span className={`
    inline-flex font-semibold
    ${inlineIdentity ? "items-baseline gap-0.5 align-baseline" : "items-center gap-2 text-text"}
  `}>{content}</span>;
}
