/*
 * Exports:
 * - default TooltipIconButton: an IconButton that names itself in a Workbench tooltip instead of a browser title.
 */
"use client";
import type { ComponentProps, ReactNode } from "react";
import IconButton from "./IconButton";
import Tooltip from "./Tooltip";

export default function TooltipIconButton({ tooltip, placement = "top", ...props }: ComponentProps<typeof IconButton> & {
  /** Richer tooltip content than the label; defaults to the label. */
  tooltip?: ReactNode;
  placement?: ComponentProps<typeof Tooltip>["placement"];
}) {
  return <Tooltip content={tooltip ?? props.label} placement={placement}>
    <IconButton display="hover-border" {...props} title="" />
  </Tooltip>;
}
