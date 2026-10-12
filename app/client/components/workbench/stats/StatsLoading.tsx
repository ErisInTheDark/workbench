/*
 * Exports:
 * - default StatsLoading: a small spinner and label beside a panel heading while its shown figures are still incomplete.
 */
import { LoaderIcon } from "../workbench-icons";

export default function StatsLoading() {
  return (
    <span aria-live="polite" className="inline-flex items-center gap-1 text-[0.72rem] text-fg/muted">
      <LoaderIcon size={12} />loading
    </span>
  );
}
