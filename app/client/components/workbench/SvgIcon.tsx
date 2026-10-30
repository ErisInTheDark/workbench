/*
 * Exports:
 * - IconProps: shared icon size and SVG attributes.
 * - SvgIconMode: how an icon's shapes paint: stroked outlines (Workbench's own icons) or filled (brand glyphs).
 * - default SvgIcon: consistent icon sizing for any viewBox, outlined or filled, with optional scale-preserving viewport
 *   padding; outlines keep one line weight whatever the box's units.
 */
import type { ComponentPropsWithoutRef } from "react";

type IconSize = 12 | 14 | 16 | 18 | 20 | 22 | 32;

/** SVG's own `mode` (a blend filter attribute) gives way to the icon's paint mode. */
export type IconProps = Omit<ComponentPropsWithoutRef<"svg">, "height" | "mode" | "strokeWidth" | "width"> & {
  size?: IconSize;
};

export type SvgIconMode = "stroke" | "fill";

/** Line weight in rendered pixels per icon pixel; at 16px a 24-unit outline is 2 units wide. */
const STROKE_PIXELS = 32;

export default function SvgIcon({ mode = "stroke", size = 16, viewBox = "0 0 24 24", viewportPadding = 0, ...props }: IconProps & {
  mode?: SvgIconMode;
  /** Padding around the box in 24ths of its width, keeping the drawing's scale. */
  viewportPadding?: number;
}) {
  const [x = 0, y = 0, width = 24, height = width] = viewBox.trim().split(/[\s,]+/u).map(Number);
  const unit = width / 24;
  const pad = viewportPadding * unit;
  const scale = size / width;
  const paint = mode === "fill"
    ? { fill: "currentColor", stroke: "none" }
    : { fill: "none", stroke: "currentColor", strokeLinecap: "round" as const, strokeLinejoin: "round" as const, strokeWidth: STROKE_PIXELS / size * unit };
  return (
    <svg
      {...props}
      {...paint}
      aria-hidden="true"
      height={(height + pad * 2) * scale}
      viewBox={`${x - pad} ${y - pad} ${width + pad * 2} ${height + pad * 2}`}
      width={(width + pad * 2) * scale}
      xmlns="http://www.w3.org/2000/svg"
    />
  );
}
