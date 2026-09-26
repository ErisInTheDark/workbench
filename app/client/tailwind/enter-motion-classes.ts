/*
 * Exports:
 * - enterMotionClassName: shared Tailwind entry transition with starting and reduced-motion states.
 */

export const enterMotionClassName = `
  h-auto overflow-visible opacity-100 transform-[translateY(0)]
  [interpolate-size:allow-keywords] [transition-behavior:allow-discrete]
  [transition:
    height 220ms cubic-bezier(0.16,1,0.3,1),
    opacity 220ms cubic-bezier(0.16,1,0.3,1),
    transform 220ms cubic-bezier(0.16,1,0.3,1),
    overflow 0s linear 220ms
  ]
  starting:(h-0 overflow-clip opacity-0 transform-[translateY(0.35rem)])
  motion-reduce:(overflow-visible opacity-100 transform-none [transition:none])
`;
