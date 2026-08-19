/*
 * Exports:
 * - default WorkbenchTooltip: clone a trigger without wrapper DOM and own delayed exclusive portal tooltip lifecycle. Keywords: tooltip, portal, hover, coordinator.
 */
"use client";

import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";

import {
  getWorkbenchTooltipPosition,
  isPointWithinWorkbenchTooltipArea,
} from "./workbench-tooltip-geometry";

const DEFAULT_DELAY_MS = 500;
const DEFAULT_HOVER_DISTANCE_PX = 12;

interface ActiveTooltip {
  close: () => void;
  owner: symbol;
}

interface TooltipPosition {
  left: number;
  maxHeight: number;
  maxWidth: number;
  ready: boolean;
  top: number;
}

interface WorkbenchTooltipTriggerProps {
  "aria-describedby"?: string;
  onMouseEnter?: (event: MouseEvent<HTMLElement>) => void;
  onMouseLeave?: (event: MouseEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
}

let activeTooltip: ActiveTooltip | null = null;

function claimActiveTooltip(owner: symbol, close: () => void) {
  const previous = activeTooltip;
  activeTooltip = { close, owner };
  if (previous && previous.owner !== owner) previous.close();
}

function releaseActiveTooltip(owner: symbol) {
  if (activeTooltip?.owner === owner) activeTooltip = null;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export default function WorkbenchTooltip({
  children,
  content,
  delayMs = DEFAULT_DELAY_MS,
  hoverDistancePx = DEFAULT_HOVER_DISTANCE_PX,
  interactive = false,
}: {
  children: ReactElement<WorkbenchTooltipTriggerProps>;
  content: ReactNode;
  delayMs?: number;
  hoverDistancePx?: number;
  interactive?: boolean;
}) {
  const ownerRef = useRef(Symbol("workbench-tooltip"));
  const triggerRef = useRef<HTMLElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [trackingPointer, setTrackingPointer] = useState(false);
  const [visible, setVisible] = useState(false);
  const tooltipId = useId();

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current === null) return;
    window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const hide = useCallback(() => {
    clearShowTimer();
    releaseActiveTooltip(ownerRef.current);
    setPosition(null);
    setTrackingPointer(false);
    setVisible(false);
  }, [clearShowTimer]);

  const show = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    clearShowTimer();
    claimActiveTooltip(ownerRef.current, hide);
    const triggerRect = trigger.getBoundingClientRect();
    const viewportHeight = window.visualViewport?.height ?? document.documentElement.clientHeight ?? window.innerHeight;
    const viewportWidth = window.visualViewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth;
    setPosition({
      ...getWorkbenchTooltipPosition({ tooltipHeight: 0, triggerRect, viewportHeight, viewportWidth }),
      ready: false,
    });
    setTrackingPointer(true);
    setVisible(true);
  }, [clearShowTimer, hide]);

  const beginShowing = useCallback(() => {
    setTrackingPointer(true);
    if (visible || showTimerRef.current !== null) return;
    showTimerRef.current = window.setTimeout(show, Math.max(0, delayMs));
  }, [delayMs, show, visible]);

  const pointerIsSafe = useCallback((x: number, y: number) => {
    const trigger = triggerRef.current;
    if (!trigger) return false;
    return isPointWithinWorkbenchTooltipArea(
      x,
      y,
      trigger.getBoundingClientRect(),
      tooltipRef.current?.getBoundingClientRect() ?? null,
      Math.max(0, hoverDistancePx),
      interactive,
    );
  }, [hoverDistancePx, interactive]);

  const reconcilePointer = useCallback((x: number, y: number) => {
    if (!pointerIsSafe(x, y)) hide();
  }, [hide, pointerIsSafe]);

  useEffect(() => {
    setPortalHost(document.body);
    return () => {
      clearShowTimer();
      releaseActiveTooltip(ownerRef.current);
    };
  }, [clearShowTimer]);

  useEffect(() => {
    if (!trackingPointer) return;
    const handleMouseMove = (event: globalThis.MouseEvent) => reconcilePointer(event.clientX, event.clientY);
    document.addEventListener("mousemove", handleMouseMove, { passive: true });
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("blur", hide);
    };
  }, [hide, reconcilePointer, trackingPointer]);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!visible || !trigger || !tooltip) return;

    const updatePosition = () => {
      const viewportHeight = window.visualViewport?.height ?? document.documentElement.clientHeight ?? window.innerHeight;
      const viewportWidth = window.visualViewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth;
      setPosition({
        ...getWorkbenchTooltipPosition({
          tooltipHeight: tooltip.getBoundingClientRect().height,
          triggerRect: trigger.getBoundingClientRect(),
          viewportHeight,
          viewportWidth,
        }),
        ready: true,
      });
    };

    updatePosition();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    resizeObserver?.observe(tooltip);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [visible]);

  const childProps = children.props;
  const childRef = childProps.ref;
  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    assignRef(childRef, node);
  }, [childRef]);
  const describedBy = [childProps["aria-describedby"], visible ? tooltipId : null].filter(Boolean).join(" ") || undefined;
  const trigger = cloneElement(children, {
    "aria-describedby": describedBy,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      childProps.onMouseEnter?.(event);
      beginShowing();
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      childProps.onMouseLeave?.(event);
      reconcilePointer(event.clientX, event.clientY);
    },
    ref: setTriggerRef,
  });

  const tooltipStyle: CSSProperties | undefined = position ? {
    left: position.left,
    maxHeight: position.maxHeight,
    maxWidth: position.maxWidth,
    top: position.top,
    visibility: position.ready ? "visible" : "hidden",
  } : undefined;
  const tooltip = visible && portalHost && position ? createPortal(
    <div
      id={tooltipId}
      ref={tooltipRef}
      role="tooltip"
      className={`fixed z-[90] w-max overflow-x-hidden overflow-y-auto rounded-[1.1rem] border border-[color-mix(in_srgb,var(--text)_10%,transparent)] bg-[color:color-mix(in_srgb,black_5%,color-mix(in_srgb,var(--shell-fade-bg),transparent_20%))] px-3 py-2.5 text-sm text-text shadow-float backdrop-blur-xl ${interactive ? "pointer-events-auto" : "pointer-events-none"}`}
      style={tooltipStyle}
    >
      {content}
    </div>,
    portalHost,
  ) : null;

  return (
    <>
      {trigger}
      {tooltip}
    </>
  );
}
