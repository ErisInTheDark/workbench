/*
 * Exports:
 * - default WorkbenchPopover: own non-modal anchored popup positioning, dismissal and focus restoration.
 */
"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { positionWorkbenchPopover } from "./workbench-popover-geometry";

export default function WorkbenchPopover({
  anchor, trigger = anchor, children, label, onClose, width = 440, height = 560,
}: {
  anchor: HTMLElement;
  trigger?: HTMLElement;
  children: ReactNode;
  label: string;
  onClose: () => void;
  width?: number;
  height?: number;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof positionWorkbenchPopover> | null>(null);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let bounds = anchor.getBoundingClientRect();
    const update = () => {
      if (anchor.isConnected) bounds = anchor.getBoundingClientRect();
      setPosition(positionWorkbenchPopover(bounds, { width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight, left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0 }, { width, height, align: "end" }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [anchor, width, height]);

  useLayoutEffect(() => {
    const popup = element.current;
    popup?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup?.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
      if (document.activeElement === document.body || popup?.contains(document.activeElement)) {
        const target = trigger.isConnected ? trigger : anchor.querySelector<HTMLElement>("button:not(:disabled)");
        if (target?.isConnected) target.focus({ preventScroll: true });
      }
    };
  }, [anchor, trigger, onClose]);

  return createPortal(
    <div
      ref={element}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      style={position ?? { visibility: "hidden" }}
      className="fixed z-50 grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-[1.1rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,black_5%,color-mix(in_srgb,var(--shell-fade-bg),transparent_20%))] text-text shadow-float backdrop-blur-xl focus:outline-none"
    >
      {children}
    </div>,
    document.body,
  );
}
