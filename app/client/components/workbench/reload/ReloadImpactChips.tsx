/*
 * Exports:
 * - default ReloadImpactChips: tiny glyph chips for what a reload or update does that needs a warning: a red restart glyph
 *   per restarted process and a grey database glyph when a store migrates.
 */
"use client";

import Tooltip from "../../ui/Tooltip";
import { DatabaseArrowUpIcon, ResetIcon } from "../workbench-icons";
import type { ReloadImpact } from "./reload-device";

export default function ReloadImpactChips({ impact, named = true }: {
  impact: ReloadImpact;
  /** Tree nodes name their scope already, so their restart glyph stands alone. */
  named?: boolean;
}) {
  if (!impact.restarts.length && !impact.migrates) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[0.7rem] font-semibold leading-none">
      {(named ? impact.restarts : impact.restarts.slice(0, 1)).map(name => (
        <Tooltip key={name} content={named ? `Restarts ${name}` : "Restarts its process"}>
          <span className="inline-flex items-center gap-0.5 text-danger">
            <ResetIcon size={12} />{named ? name : null}
          </span>
        </Tooltip>
      ))}
      {impact.migrates ? (
        <Tooltip content="Migrates a database">
          <span className="inline-flex items-center text-fg/muted"><DatabaseArrowUpIcon size={12} /></span>
        </Tooltip>
      ) : null}
    </span>
  );
}
