/*
 * Exports:
 * - statsRevealClassName: fade-and-settle entry for a panel's content once its data arrives; size never changes, so nothing reflows.
 * - statsReloadingClassName: dim retained figures while a changed request loads.
 * - default Skeleton: one shimmering placeholder block sized like the content it stands in for.
 */
import type { CSSProperties } from "react";

export const statsRevealClassName = `
  transition-[opacity,translate] duration-300 ease-out
  starting:(opacity-0 translate-y-1)
  motion-reduce:transition-none
`;

export function statsReloadingClassName(reloading: boolean) {
  return `transition-opacity duration-200 ${reloading ? "opacity-60" : ""}`;
}

export default function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden="true" className={`block rounded-md workbench-skeleton ${className}`} style={style} />;
}
