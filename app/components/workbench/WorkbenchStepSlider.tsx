/*
 * Exports:
 * - default WorkbenchStepSlider: reusable stepped range slider with tick marks and responsive labels. Keywords: settings, slider, steps, mobile.
 */

"use client";

type WorkbenchStepSliderProps<T extends number> = {
  ariaLabel: string;
  disabled?: boolean;
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

export default function WorkbenchStepSlider<T extends number> ({
  ariaLabel,
  disabled = false,
  onChange,
  steps,
  value,
}: WorkbenchStepSliderProps<T>) {
  const activeIndex = getClosestStepIndex(steps, value);
  const maxIndex = Math.max(0, steps.length - 1);

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
        <input
          type="range"
          aria-label={ariaLabel}
          className={`
            relative z-10 h-20 -mt-6 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none disabled:cursor-not-allowed
            [&::-webkit-slider-runnable-track]:h-[0.28rem]
            [&::-webkit-slider-runnable-track]:rounded-full
            [&::-webkit-slider-runnable-track]:bg-[var(--slider-step-color)]
            [&::-webkit-slider-thumb]:mt-[-0.36rem]
            [&::-webkit-slider-thumb]:h-4
            [&::-webkit-slider-thumb]:w-4
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:border
            [&::-webkit-slider-thumb]:border-[color-mix(in_srgb,var(--text)_28%,transparent)]
            [&::-webkit-slider-thumb]:bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]
            [&::-webkit-slider-thumb]:transition
            hover:[&::-webkit-slider-thumb]:scale-110
            focus-visible:[&::-webkit-slider-thumb]:scale-110
            focus-visible:[&::-webkit-slider-thumb]:ring-2
            focus-visible:[&::-webkit-slider-thumb]:ring-accent-soft
            [&::-moz-range-track]:h-[0.28rem]
            [&::-moz-range-track]:rounded-full
            [&::-moz-range-track]:border-0
            [&::-moz-range-track]:bg-[var(--slider-step-color)]
            [&::-moz-range-thumb]:h-4
            [&::-moz-range-thumb]:w-4
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:border
            [&::-moz-range-thumb]:border-[color-mix(in_srgb,var(--text)_28%,transparent)]
            [&::-moz-range-thumb]:bg-[color-mix(in_srgb,var(--text)_86%,var(--bg)_14%)]
            [&::-moz-range-thumb]:transition
            hover:[&::-moz-range-thumb]:scale-110
            focus-visible:[&::-moz-range-thumb]:scale-110
            focus-visible:[&::-moz-range-thumb]:ring-2
            focus-visible:[&::-moz-range-thumb]:ring-accent-soft
          `}
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
          className="pointer-events-none absolute right-1.5 bottom-3.5 left-1.5 hidden justify-between font-mono text-[0.9rem] font-medium leading-none text-muted md:flex"
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
