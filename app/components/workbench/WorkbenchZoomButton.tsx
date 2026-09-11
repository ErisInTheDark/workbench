/*
 * Exports:
 * - default WorkbenchZoomButton: icon-triggered downward text-size press-drag slider.
 */
"use client";

import type { Ref } from "react";
import WorkbenchPressDragSlider from "./WorkbenchPressDragSlider";
import { ZoomInIcon } from "./workbench-icons";

export default function WorkbenchZoomButton({
  ref, label = "Text size", disabled = false, min, max, step = 0.08, value, format = value => `${value.toFixed(2)}rem`, onChange, onPreview,
}: {
  ref?: Ref<HTMLButtonElement>;
  label?: string;
  disabled?: boolean;
  min: number;
  max: number;
  step?: number;
  value: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
  onPreview?: (value: number | null) => void;
}) {
  return <WorkbenchPressDragSlider
    ref={ref}
    label={label}
    disabled={disabled}
    min={min}
    max={max}
    step={step}
    value={value}
    format={format}
    colour={() => "color-mix(in srgb, var(--text) 22%, var(--bg))"}
    icon={<ZoomInIcon />}
    side="below"
    onChange={onChange}
    onPreview={onPreview}
  />;
}
