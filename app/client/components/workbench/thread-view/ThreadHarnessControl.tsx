/*
 * Exports:
 * - default ThreadHarnessControl: render the immutable provider identity, inline or standalone.
 */
"use client";

import type { WorkbenchHarness } from "workbench-shared/types";
import { HarnessIcon } from "../workbench-icons";
import { formatHarnessLabel } from "./harness-label";

export default function ThreadHarnessControl({ harness, inline = false }: {
  harness: WorkbenchHarness;
  inline?: boolean;
}) {
  return <span className={`
    inline-flex font-semibold
    ${inline ? "items-baseline gap-0.5 align-baseline" : "items-center gap-2 text-text"}
  `}><HarnessIcon className={inline ? "shrink-0 self-center" : undefined} harness={harness} size={16} /><span>{formatHarnessLabel(harness)}</span></span>;
}
