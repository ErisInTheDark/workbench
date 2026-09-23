/*
 * Exports:
 * - enterMotionClassName: shared Tailwind entry transition with starting and reduced-motion states.
 */

export const enterMotionClassName = [
  "h-auto overflow-visible opacity-100 transform-[translateY(0)]",
  "[interpolate-size:allow-keywords] [transition-behavior:allow-discrete]",
  "[transition:height_220ms_cubic-bezier(0.16,1,0.3,1),opacity_220ms_cubic-bezier(0.16,1,0.3,1),transform_220ms_cubic-bezier(0.16,1,0.3,1),overflow_0s_linear_220ms]",
  "starting:h-0 starting:overflow-clip starting:opacity-0 starting:transform-[translateY(0.35rem)]",
  "motion-reduce:overflow-visible motion-reduce:opacity-100 motion-reduce:transform-none motion-reduce:[transition:none]",
].join(" ");
