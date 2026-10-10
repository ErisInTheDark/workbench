/*
 * Exports:
 * - default Tooltip: clone a trigger without wrapper DOM and own a delayed portal tooltip, opening right of or above it.
 *   Tooltips on triggers nested inside another trigger stack in the outermost tooltip's panel; tooltips on triggers
 *   inside tooltip content open one layer higher. Open state, exclusivity and pointer safety live in tooltip-layers.
 */
"use client";

import {
  cloneElement,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  getTooltipPosition,
  isTooltipPointerSupported,
  isPointWithinTooltipArea,
  type TooltipPlacement,
} from "./tooltip-geometry";
import { tooltipLayers } from "./tooltip-layers";

const DEFAULT_DELAY_MS = 500;
const DEFAULT_HOVER_DISTANCE_PX = 12;
const BASE_LAYER_Z_INDEX = 90;

interface TooltipPosition {
  left: number;
  maxHeight: number;
  maxWidth: number;
  ready: boolean;
  top: number;
}

interface TooltipTriggerProps {
  "aria-controls"?: string;
  "aria-describedby"?: string;
  "aria-expanded"?: boolean;
  "aria-haspopup"?: "dialog";
  onPointerEnter?: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: ReactPointerEvent<HTMLElement>) => void;
  ref?: Ref<HTMLElement>;
}

/** The tooltip whose trigger encloses this one; a nested tooltip renders into its parent's panel. */
interface TooltipNesting {
  id: symbol;
  /** Where nested children portal their sections; null until the parent's panel is mounted. */
  slot: HTMLElement | null;
  showNow: () => void;
}

/** The layer a tooltip opens on, and which tooltip's content holds its trigger. */
interface TooltipLayer {
  layer: number;
  owner: symbol | null;
}

const TooltipNestingContext = createContext<TooltipNesting | null>(null);
const TooltipLayerContext = createContext<TooltipLayer>({ layer: 0, owner: null });

const layerHosts = new Map<number, HTMLElement>();

/** Each layer is one fixed, pointer-transparent host stacked above the layer below it. */
function getLayerHost(layer: number) {
  const existing = layerHosts.get(layer);
  if (existing?.isConnected) return existing;
  const host = document.createElement("div");
  host.dataset.tooltipLayer = String(layer);
  host.style.cssText = `position:fixed;inset:0;pointer-events:none;z-index:${BASE_LAYER_Z_INDEX + layer}`;
  document.body.append(host);
  layerHosts.set(layer, host);
  return host;
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function viewport() {
  return {
    viewportHeight: window.visualViewport?.height ?? document.documentElement.clientHeight ?? window.innerHeight,
    viewportWidth: window.visualViewport?.width ?? document.documentElement.clientWidth ?? window.innerWidth,
  };
}

export default function Tooltip({
  children,
  content,
  delayMs = DEFAULT_DELAY_MS,
  enabled = true,
  hoverDistancePx = DEFAULT_HOVER_DISTANCE_PX,
  interactive = false,
  placement = "right",
}: {
  children: ReactElement<TooltipTriggerProps>;
  content: ReactNode;
  delayMs?: number;
  enabled?: boolean;
  hoverDistancePx?: number;
  interactive?: boolean;
  placement?: TooltipPlacement;
}) {
  const ownerRef = useRef(Symbol("workbench-tooltip"));
  const id = ownerRef.current;
  const parent = useContext(TooltipNestingContext);
  const { layer, owner } = useContext(TooltipLayerContext);
  const triggerRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const showTimerRef = useRef<number | null>(null);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<TooltipPosition | null>(null);
  const [trackingPointer, setTrackingPointer] = useState(false);
  const [visible, setVisible] = useState(false);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const tooltipId = useId();
  // Disabled parents pass their own parent through, so this is the nearest tooltip able to host a panel.
  const nestedIn = parent;
  const isRoot = nestedIn === null;

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current === null) return;
    window.clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  /** Called by the registry once this tooltip and everything it held open are closed. */
  const reset = useCallback(() => {
    clearShowTimer();
    setPosition(null);
    setTrackingPointer(false);
    setVisible(false);
  }, [clearShowTimer]);

  const hide = useCallback(() => {
    if (tooltipLayers.isOpen(id)) tooltipLayers.close(id);
    else reset();
  }, [id, reset]);

  const isPointerLocallySafe = useCallback((x: number, y: number) => {
    const trigger = triggerRef.current;
    if (!trigger) return false;
    return isPointWithinTooltipArea(
      x,
      y,
      trigger.getBoundingClientRect(),
      surfaceRef.current?.getBoundingClientRect() ?? null,
      Math.max(0, hoverDistancePx),
      interactive,
    );
  }, [hoverDistancePx, interactive]);

  const show = useCallback(() => {
    if (!enabled || !triggerRef.current) return;
    clearShowTimer();
    if (tooltipLayers.isOpen(id)) return;
    nestedIn?.showNow();
    tooltipLayers.open({ id, layer, owner, parent: nestedIn?.id ?? null }, { close: reset, isPointerLocallySafe });
    if (!nestedIn) {
      setPosition({
        ...getTooltipPosition({ placement, tooltipHeight: 0, triggerRect: triggerRef.current.getBoundingClientRect(), ...viewport() }),
        ready: false,
      });
    }
    setTrackingPointer(true);
    setVisible(true);
  }, [clearShowTimer, enabled, id, isPointerLocallySafe, layer, nestedIn, owner, placement, reset]);

  const beginShowing = useCallback(() => {
    if (!enabled) return;
    setTrackingPointer(true);
    if (visible || showTimerRef.current !== null) return;
    showTimerRef.current = window.setTimeout(show, Math.max(0, delayMs));
  }, [delayMs, enabled, show, visible]);

  const reconcilePointer = useCallback((x: number, y: number) => {
    if (tooltipLayers.isOpen(id) ? !tooltipLayers.isPointerSafe(id, x, y) : !isPointerLocallySafe(x, y)) hide();
  }, [hide, id, isPointerLocallySafe]);

  useEffect(() => {
    setMounted(true);
    return () => {
      clearShowTimer();
      if (tooltipLayers.isOpen(id)) tooltipLayers.close(id);
    };
  }, [clearShowTimer, id]);

  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);

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

  useEffect(() => {
    if (!visible || !interactive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [hide, interactive, visible]);

  // Only the outermost tooltip positions; nested sections grow its panel, which the resize observer follows.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const panel = surfaceRef.current;
    if (!visible || !isRoot || !trigger || !panel) return;

    const updatePosition = () => {
      const measured = panel.getBoundingClientRect();
      setPosition({
        ...getTooltipPosition({
          placement,
          tooltipHeight: measured.height,
          tooltipWidth: measured.width,
          triggerRect: trigger.getBoundingClientRect(),
          ...viewport(),
        }),
        ready: true,
      });
    };

    updatePosition();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    resizeObserver?.observe(panel);
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
  }, [isRoot, placement, visible]);

  const childProps = children.props;
  const childRef = childProps.ref;
  const setTriggerRef = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    assignRef(childRef, node);
  }, [childRef]);
  const describedBy = [childProps["aria-describedby"], enabled && visible && !interactive ? tooltipId : null].filter(Boolean).join(" ") || undefined;
  const controlledBy = [childProps["aria-controls"], enabled && visible && interactive ? tooltipId : null].filter(Boolean).join(" ") || undefined;
  const trigger = cloneElement(children, {
    "aria-controls": controlledBy,
    "aria-describedby": describedBy,
    "aria-expanded": enabled && interactive ? visible : childProps["aria-expanded"],
    "aria-haspopup": enabled && interactive ? "dialog" : childProps["aria-haspopup"],
    onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => {
      childProps.onPointerEnter?.(event);
      if (isTooltipPointerSupported(event.pointerType)) beginShowing();
    },
    onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => {
      childProps.onPointerLeave?.(event);
      if (isTooltipPointerSupported(event.pointerType)) reconcilePointer(event.clientX, event.clientY);
    },
    ref: setTriggerRef,
  });

  // Nested children see this tooltip only while it can host them; a disabled tooltip passes its own parent through.
  const nesting = useMemo<TooltipNesting | null>(
    () => enabled ? { id, slot: visible ? slot : null, showNow: show } : parent,
    [enabled, id, parent, show, slot, visible],
  );

  const section = (
    <div className={nestedIn ? `mt-2 border-t border-fg/10 pt-2 ${interactive ? "pointer-events-auto" : ""}` : undefined} ref={nestedIn ? surfaceRef : undefined}>
      <TooltipNestingContext.Provider value={null}>
        <TooltipLayerContext.Provider value={{ layer: layer + 1, owner: id }}>
          {content}
        </TooltipLayerContext.Provider>
      </TooltipNestingContext.Provider>
      <div className="flex flex-col" ref={setSlot} />
    </div>
  );

  const tooltipStyle: CSSProperties | undefined = position ? {
    left: position.left,
    maxHeight: position.maxHeight,
    maxWidth: position.maxWidth,
    top: position.top,
    visibility: position.ready ? "visible" : "hidden",
  } : undefined;

  let tooltip: ReactNode = null;
  if (enabled && visible && mounted) {
    if (nestedIn) {
      tooltip = nestedIn.slot ? createPortal(<div id={tooltipId} role={interactive ? "dialog" : "tooltip"}>{section}</div>, nestedIn.slot) : null;
    } else if (position) {
      tooltip = createPortal(
        <div
          id={tooltipId}
          ref={surfaceRef}
          role={interactive ? "dialog" : "tooltip"}
          aria-modal={interactive ? false : undefined}
          className={`
            fixed flex w-max flex-col overflow-x-hidden overflow-y-auto rounded-[1.1rem] border border-[color-mix(in srgb, var(--text) 10%, transparent)] bg-overlay-glass px-3 py-2.5 text-sm text-text shadow-float backdrop-blur-xl
            ${interactive ? "pointer-events-auto" : "pointer-events-none"}
          `}
          style={tooltipStyle}
        >
          {section}
        </div>,
        getLayerHost(layer),
      );
    }
  }

  return (
    <>
      <TooltipNestingContext.Provider value={nesting}>{trigger}</TooltipNestingContext.Provider>
      {tooltip}
    </>
  );
}
