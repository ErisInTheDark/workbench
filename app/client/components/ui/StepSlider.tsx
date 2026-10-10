/*
 * Exports:
 * - default StepSlider: stepped settings range, with optional compact track/value presentation.
 */

"use client";

import WorkbenchRangeInput from "../workbench/WorkbenchRangeInput";

type StepSliderProps<T extends number> = {
  ariaLabel: string;
  disabled?: boolean;
  compact?: boolean;
  onChange: (value: T) => void;
  steps: Array<{
    label: string;
    value: T;
  }>;
  value: T;
};

function getClosestStepIndex<T extends number> (steps: Array<{ value: T }>, value: T) {
  return steps.reduce((closestIndex, step, index) => (
    Math.abs(step.value - value) < Math.abs(steps[closestIndex].value - value)
      ? index
      : closestIndex
  ), 0);
}

export default function StepSlider<T extends number> ({
  ariaLabel,
  disabled = false,
  compact = false,
  onChange,
  steps,
  value,
}: StepSliderProps<T>) {
  const activeIndex = getClosestStepIndex(steps, value);
  const maxIndex = Math.max(0, steps.length - 1);

  if (compact) return <div className="flex min-w-0 items-center gap-2" title={ariaLabel}>
    <WorkbenchRangeInput
      aria-label={ariaLabel}
      aria-valuetext={steps[activeIndex].label}
      className="h-8 w-24 min-w-0 sm:w-28"
      disabled={disabled}
      min={0} max={maxIndex} step={1} value={activeIndex}
      onChange={event => onChange((steps[Number.parseInt(event.target.value, 10)] ?? steps[activeIndex]).value)}
    />
    <span aria-hidden="true" className="min-w-[5ch] text-right font-mono text-xs tabular-nums text-fg/muted">
      {steps[activeIndex].label}
    </span>
  </div>;

  return (
    <div
      className={`[--slider-step-color:color-mix(in_srgb,var(--text)_24%,var(--bg)_76%)] rounded-[0.95rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] px-3 transition hover:[--slider-step-color:color-mix(in_srgb,var(--text)_34%,var(--bg)_66%)] [&:has(input:focus-visible)]:[--slider-step-color:color-mix(in_srgb,var(--text)_42%,var(--bg)_58%)]${disabled
        ? " opacity-45"
        : " hover:bg-[color-mix(in_srgb,var(--text)_3%,transparent)]"}`}
    >
      <div className="relative px-1 pt-1">
        <div className="pointer-events-none absolute right-1 left-1 top-[0.9rem] flex justify-between">
          {steps.map((step, index) => (
            <span
              key={step.value}
              aria-hidden="true"
              className="h-3 w-3 rounded-full bg-[var(--slider-step-color)]"
            />
          ))}
        </div>
        <WorkbenchRangeInput
          aria-label={ariaLabel}
          className="h-20 -mt-6"
          disabled={disabled}
          max={maxIndex}
          min={0}
          step={1}
          value={activeIndex}
          onChange={(event) => {
            const nextStep = steps[Number.parseInt(event.target.value, 10)] ?? steps[activeIndex];
            onChange(nextStep.value);
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-1.5 bottom-3.5 left-1.5 hidden justify-between font-mono text-[0.9rem] font-medium leading-none text-fg/muted md:flex"
        >
          {steps.map((step, index) => (
            <span
              key={step.value}
              className={index === activeIndex ? "text-text" : ""}
            >
              {step.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
