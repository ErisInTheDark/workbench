/*
 * Exports:
 * - IconProps: shared icon size and SVG attributes.
 * - default OutlinedIcon: consistent outlined SVG sizing, stroke and optional scale-preserving viewport padding.
 */
import type { ComponentPropsWithoutRef } from "react";

type IconSize = 12 | 14 | 16 | 18 | 20 | 22 | 32;

export type IconProps = Omit<ComponentPropsWithoutRef<"svg">, "height" | "strokeWidth" | "width"> & {
  size?: IconSize;
};

export default function OutlinedIcon({ size = 16, viewportPadding = 0, ...props }: IconProps & { viewportPadding?: number }) {
  const extent = 24 + viewportPadding * 2;
  const renderedSize = size * extent / 24;
  return <svg {...props} aria-hidden="true" fill="none" height={renderedSize} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={32 / size} viewBox={`${-viewportPadding} ${-viewportPadding} ${extent} ${extent}`} width={renderedSize} xmlns="http://www.w3.org/2000/svg" />;
}
