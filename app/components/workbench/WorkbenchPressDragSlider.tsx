/*
 * Exports:
 * - default WorkbenchPressDragSlider: inline or popover numeric control with cancellable preview.
 */
"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import PressDragSliderController, { type PressDragSliderRange } from "./PressDragSliderController";
import { positionWorkbenchPopover } from "./workbench-popover-geometry";
import WorkbenchRangeInput from "./WorkbenchRangeInput";

export default function WorkbenchPressDragSlider ({
  value, min, max, step, label, format, colour, onChange, disabled = false, valueText, valueOptions, presentation = "popover",
}: PressDragSliderRange & {
  label: string;
  format: (value: number) => string;
  colour: (fraction: number) => string;
  onChange: (value: number) => void;
  disabled?: boolean;
  valueText?: string;
  valueOptions?: readonly string[];
  presentation?: "popover" | "inline";
}) {
  const [controller] = useState(() => new PressDragSliderController());
  const control = useRef<HTMLButtonElement | HTMLInputElement>(null);
  const pointer = useRef<number | null>(null);
  const touch = useRef<{ id: number; left: number; top: number } | null>(null);
  const [preview, setPreview] = useState<number | null>(null);
  const [position, setPosition] = useState<ReturnType<typeof positionWorkbenchPopover> | null>(null);
  const range = { value, min, max, step };
  const shown = preview ?? value;
  const shownText = preview === null ? valueText ?? format(value) : format(preview);
  const fraction = max === min ? 0 : Math.max(0, Math.min(1, (shown - min) / (max - min)));
  const valueLabel = <span className={`
    inline-grid text-center font-semibold capitalize tabular-nums
    ${presentation === "inline" ? "min-w-[3ch] text-xs" : ""}
  `}>
    {valueOptions?.map((option) => <span key={option} aria-hidden="true" className="pointer-events-none invisible col-start-1 row-start-1 whitespace-nowrap">{option}</span>)}
    <span className="col-start-1 row-start-1 whitespace-nowrap">{shownText}</span>
  </span>;

  function cancel () {
    controller.cancel();
    touch.current = null;
    setPreview(null);
    const id = pointer.current;
    pointer.current = null;
    if (id !== null && control.current?.hasPointerCapture(id)) control.current.releasePointerCapture(id);
  }

  useEffect(() => {
    cancel();
    return () => controller.cancel();
  }, [controller, value, min, max, step, disabled, presentation]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (pointer.current === null && touch.current === null)) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    const onScroll = () => {
      if (touch.current && !controller.isActive) {
        const box = control.current?.getBoundingClientRect();
        if (box) controller.cancelTouchHoldAfterMovement(Math.hypot(box.left - touch.current.left, box.top - touch.current.top));
        return;
      }
      cancel();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", cancel);
    window.visualViewport?.addEventListener("scroll", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", cancel);
      window.visualViewport?.removeEventListener("scroll", onScroll);
    };
  }, [controller]);

  useEffect(() => {
    if (presentation !== "popover") return;
    const element = control.current;
    // touch-action is decided before the hold completes. Cancel native scrolling
    // only after activation, using a non-passive listener rather than React's passive one.
    const preventActiveScroll = (event: Event) => {
      if (touch.current && controller.isActive && event.cancelable) event.preventDefault();
    };
    element?.addEventListener("touchmove", preventActiveScroll, { passive: false });
    return () => element?.removeEventListener("touchmove", preventActiveScroll);
  }, [controller, presentation]);

  function beginPopover(element: HTMLElement, y: number) {
    element.focus({ preventScroll: true });
    const viewport = window.visualViewport;
    const box = positionWorkbenchPopover(element.getBoundingClientRect(), { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight, left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 }, { width: 72, height: 216 });
    setPosition(box);
    controller.begin(range, y, Math.max(1, box.height - 48));
    setPreview(value);
  }

  if (presentation === "inline") return <div
    className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
    style={{ "--slider-step-color": colour(fraction) } as CSSProperties}
  >
    <WorkbenchRangeInput
      variant="bar"
      ref={(element) => { control.current = element; }}
      aria-label={label}
      aria-valuetext={shownText}
      className="h-8 min-w-0 touch-none"
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      onPointerDown={(event) => {
        if (event.button !== 0 || pointer.current !== null) return;
        controller.begin(range, 0, 1);
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        setPreview(value);
      }}
      onChange={(event) => {
        setPreview(controller.setPreview(event.currentTarget.valueAsNumber));
      }}
      onKeyDown={(event) => {
        const next = controller.keyboard(range, event.key);
        if (next === null) return;
        event.preventDefault();
        if (pointer.current !== null) return;
        if (next !== value) onChange(next);
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        controller.setPreview(event.currentTarget.valueAsNumber);
        const next = controller.commit();
        cancel();
        if (next !== null && next !== value) onChange(next);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onBlur={cancel}
    />
    {valueLabel}
  </div>;

  return <>
    <button
      ref={(element) => { control.current = element; }}
      type="button"
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={shownText}
      aria-orientation="vertical"
      disabled={disabled}
      className="relative isolate shrink-0 touch-auto select-none whitespace-nowrap bg-transparent px-2.5 py-2 text-text transition before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-40"
      onPointerDown={(event) => {
        if (event.pointerType === "touch" || event.button !== 0 || pointer.current !== null) return;
        event.preventDefault();
        beginPopover(event.currentTarget, event.clientY);
        pointer.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onTouchStart={(event) => {
        if (disabled || event.touches.length !== 1 || pointer.current !== null) { cancel(); return; }
        const contact = event.touches[0];
        const element = event.currentTarget;
        const box = element.getBoundingClientRect();
        touch.current = { id: contact.identifier, left: box.left, top: box.top };
        controller.holdTouch(contact.clientX, contact.clientY, y => beginPopover(element, y));
      }}
      onTouchMove={(event) => {
        if (event.touches.length !== 1) { cancel(); return; }
        const contact = Array.from(event.touches).find(entry => entry.identifier === touch.current?.id);
        if (contact) setPreview(controller.moveTouch(contact.clientX, contact.clientY));
      }}
      onTouchEnd={(event) => {
        const contact = Array.from(event.changedTouches).find(entry => entry.identifier === touch.current?.id);
        if (!contact) return;
        controller.moveTouch(contact.clientX, contact.clientY);
        const next = controller.commit();
        cancel();
        if (next !== null && next !== value) onChange(next);
      }}
      onTouchCancel={cancel}
      onContextMenu={(event) => { if (touch.current) event.preventDefault(); }}
      onPointerMove={(event) => {
        if (pointer.current === event.pointerId) setPreview(controller.move(event.clientY));
      }}
      onPointerUp={(event) => {
        if (pointer.current !== event.pointerId) return;
        controller.move(event.clientY);
        const next = controller.commit();
        cancel();
        if (next !== null && next !== value) onChange(next);
      }}
      onPointerCancel={(event) => { if (event.pointerType !== "touch") cancel(); }}
      onLostPointerCapture={(event) => { if (event.pointerType !== "touch") cancel(); }}
      onBlur={cancel}
      onKeyDown={(event) => {
        if (pointer.current !== null || touch.current !== null) return;
        const next = controller.keyboard(range, event.key);
        if (next === null) return;
        event.preventDefault();
        if (next !== value) onChange(next);
      }}
    >{valueLabel}</button>
    {preview !== null && position ? createPortal(
      <div aria-hidden="true" style={position} className="pointer-events-none fixed z-[60] flex flex-col items-center gap-3 rounded-xl bg-bg p-3 text-text shadow-xl ring-1 ring-[color-mix(in_srgb,var(--text)_10%,transparent)]">
        <span className="text-xs font-semibold capitalize">{format(shown)}</span>
        <div className="relative min-h-0 w-5 flex-1 rounded-full" style={{ background: colour(fraction) }}>
          <div className="absolute inset-x-0 inset-y-0.5">
            <span className="absolute left-0.5 size-4 rounded-full bg-white shadow" style={{ bottom: `calc(${fraction * 100}% - ${fraction}rem)` }} />
          </div>
        </div>
      </div>, document.body,
    ) : null}
  </>;
}
