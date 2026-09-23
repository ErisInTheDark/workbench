/*
 * Exports:
 * - shimmerTextClassName: shared Tailwind gradient text shimmer with reduced-motion styling.
 */

export const shimmerTextClassName = [
  "w-max max-w-full bg-clip-text bg-[length:300%_100%] text-transparent",
  "[--shimmer-muted:color-mix(in_srgb,var(--text)_calc(var(--muted-strength)_*_0.78),var(--fg-bg,var(--bg)))]",
  "bg-[linear-gradient(90deg,var(--shimmer-muted)_34%,var(--accent),color-mix(in_srgb,var(--text)_86%,var(--accent)_14%),var(--accent),var(--shimmer-muted)_66%)]",
  "[-webkit-background-clip:text] [-webkit-text-fill-color:transparent]",
  "animate-shimmer motion-reduce:animate-none motion-reduce:[background-position:50%_50%]",
].join(" ");
