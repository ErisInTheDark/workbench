/*
 * Exports:
 * - shimmerTextClassName: shared Tailwind gradient text shimmer with reduced-motion styling.
 */

export const shimmerTextClassName = `
  w-max max-w-full bg-clip-text bg-[length:300% 100%] text-transparent
  [--shimmer-muted: color-mix(in srgb,
    var(--text) calc(var(--muted-strength) * 0.78),
    var(--fg-bg, var(--bg))
  )]
  bg-[linear-gradient(90deg,
    var(--shimmer-muted) 34%,
    var(--accent),
    color-mix(in srgb, var(--text) 86%, var(--accent) 14%),
    var(--accent),
    var(--shimmer-muted) 66%
  )]
  [-webkit-background-clip:text] [-webkit-text-fill-color:transparent]
  animate-shimmer motion-reduce:(animate-none [background-position:50% 50%])
`;
