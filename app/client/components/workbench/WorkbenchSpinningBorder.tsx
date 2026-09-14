/*
 * Exports:
 * - default WorkbenchSpinningBorder: render two opposed gradient trails around a rounded border motion path. Keywords: workbench, pending, border, gradient, motion path.
 */
"use client";

import type { CSSProperties } from "react";

type SpinningBorderStyle = CSSProperties & {
  "--workbench-spinning-border-radius": string;
};

export default function WorkbenchSpinningBorder({
  radius,
}: {
  radius: string;
}) {
  const style: SpinningBorderStyle = {
    "--workbench-spinning-border-radius": radius,
  };

  return (
    <span
      aria-hidden="true"
      className="workbench-spinning-border-host"
      style={style}
    >
      <span className="workbench-spinning-border" data-workbench-spinning-border="true">
        <span className="workbench-spinning-border-trail workbench-spinning-border-trail-first" data-workbench-spinning-border-trail="true" />
        <span className="workbench-spinning-border-trail workbench-spinning-border-trail-second" data-workbench-spinning-border-trail="true" />
      </span>
    </span>
  );
}
