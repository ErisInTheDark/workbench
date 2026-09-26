/*
 * Exports:
 * - default WorkbenchSpinningBorder: render two opposed gradient trails around a rounded border motion path.
 */
"use client";

import type { CSSProperties } from "react";

type SpinningBorderStyle = CSSProperties & {
  "--workbench-spinning-border-radius": string;
};

const spinningBorderHostClassName = "pointer-events-none absolute inset-0 z-0 [container-type: size]";

const spinningBorderClassName = `
  absolute inset-0 overflow-hidden
  [--workbench-spinning-border-width: 2px]
  [--workbench-spinning-border-inner-radius: max(
    0px,
    calc(var(--workbench-spinning-border-radius) - var(--workbench-spinning-border-width))
  )]
  [border-radius: var(--workbench-spinning-border-radius)]
  [clip-path: shape(
    evenodd from var(--workbench-spinning-border-radius) 0,
    hline to calc(100% - var(--workbench-spinning-border-radius)),
    arc to 100% var(--workbench-spinning-border-radius) of var(--workbench-spinning-border-radius) cw,
    vline to calc(100% - var(--workbench-spinning-border-radius)),
    arc to calc(100% - var(--workbench-spinning-border-radius)) 100% of var(--workbench-spinning-border-radius) cw,
    hline to var(--workbench-spinning-border-radius),
    arc to 0 calc(100% - var(--workbench-spinning-border-radius)) of var(--workbench-spinning-border-radius) cw,
    vline to var(--workbench-spinning-border-radius),
    arc to var(--workbench-spinning-border-radius) 0 of var(--workbench-spinning-border-radius) cw,
    close,
    move to calc(var(--workbench-spinning-border-width) + var(--workbench-spinning-border-inner-radius)) var(--workbench-spinning-border-width),
    hline to calc(100% - var(--workbench-spinning-border-width) - var(--workbench-spinning-border-inner-radius)),
    arc to calc(100% - var(--workbench-spinning-border-width)) calc(var(--workbench-spinning-border-width) + var(--workbench-spinning-border-inner-radius)) of var(--workbench-spinning-border-inner-radius) cw,
    vline to calc(100% - var(--workbench-spinning-border-width) - var(--workbench-spinning-border-inner-radius)),
    arc to calc(100% - var(--workbench-spinning-border-width) - var(--workbench-spinning-border-inner-radius)) calc(100% - var(--workbench-spinning-border-width)) of var(--workbench-spinning-border-inner-radius) cw,
    hline to calc(var(--workbench-spinning-border-width) + var(--workbench-spinning-border-inner-radius)),
    arc to var(--workbench-spinning-border-width) calc(100% - var(--workbench-spinning-border-width) - var(--workbench-spinning-border-inner-radius)) of var(--workbench-spinning-border-inner-radius) cw,
    vline to calc(var(--workbench-spinning-border-width) + var(--workbench-spinning-border-inner-radius)),
    arc to calc(var(--workbench-spinning-border-width) + var(--workbench-spinning-border-inner-radius)) var(--workbench-spinning-border-width) of var(--workbench-spinning-border-inner-radius) cw,
    close
  )]
  [contain: paint] [container-type: size]
`;

const spinningBorderTrailClassName = `
  absolute opacity-[0.92]
  [--workbench-spinning-border-color: color-mix(in srgb, var(--text), var(--accent) 50%)]
  [--workbench-spinning-border-motion-outset: calc(min(100cqi, 100cqb) / 4)]
  [--workbench-spinning-border-long-side: max(100cqi, 100cqb)]
  [--workbench-spinning-border-short-side: min(100cqi, 100cqb)]
  [--workbench-spinning-border-squareness-boost: calc(
    var(--workbench-spinning-border-short-side) * var(--workbench-spinning-border-short-side)
    / var(--workbench-spinning-border-long-side)
  )]
  [width: calc(var(--workbench-spinning-border-long-side) + var(--workbench-spinning-border-squareness-boost))]
  [height: calc(
    (
      var(--workbench-spinning-border-long-side)
      + var(--workbench-spinning-border-short-side)
      + var(--workbench-spinning-border-squareness-boost)
    ) / 2
  )]
  [background: radial-gradient(var(--workbench-spinning-border-color), transparent 50%)]
  [offset-path: inset(
    calc(var(--workbench-spinning-border-motion-outset) * -1)
    round calc(var(--spacing) * 20)
  ) border-box]
  [offset-anchor: 50% 50%] [offset-rotate: auto]
  [@container (width > 20rem)]:[animation-duration: 8s]
  [@container (width > 36rem)]:[animation-duration: 12s]
  motion-reduce:(animate-none [background-position: 50% 50%])
`;

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
      className={spinningBorderHostClassName}
      style={style}
    >
      <span className={spinningBorderClassName} data-workbench-spinning-border="true">
        <span
          className={`${spinningBorderTrailClassName} [offset-distance: 0%] [animation: workbench-spinning-border-first 3.6s linear infinite]`}
          data-workbench-spinning-border-trail="true"
        />
        <span
          className={`${spinningBorderTrailClassName} [offset-distance: 50%] [animation: workbench-spinning-border-second 3.6s linear infinite]`}
          data-workbench-spinning-border-trail="true"
        />
      </span>
    </span>
  );
}
