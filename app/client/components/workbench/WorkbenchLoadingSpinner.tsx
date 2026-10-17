/*
 * Exports:
 * - default WorkbenchLoadingSpinner: a large spinner centred in the area a view will fill once its content loads.
 */
"use client";

import LoaderIcon from "./LoaderIcon";

export default function WorkbenchLoadingSpinner({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex min-h-[50vh] w-full flex-1 items-center justify-center text-fg/muted">
      <LoaderIcon size={32} />
    </div>
  );
}
