/*
 * Exports:
 * - default DropTarget: register one typed target with optional proximity range and selected-state rendering. Keywords: drop, target, range, selected.
 */
"use client";

import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import type { WorkbenchDropTargetHandle, WorkbenchDropTargetSnapshot } from "../../../workbench/layout/WorkbenchDragController";
import type { WorkbenchDragPayload } from "../../../workbench/layout/workbench-drag";
import { DropTargetBoundaryContext, useWorkbenchDragController } from "./workbench-drag-context";

const IDLE_TARGET_SNAPSHOT: WorkbenchDropTargetSnapshot = { selected: false, x: 0, y: 0 };
const EMPTY_UNSUBSCRIBE = () => undefined;

export default function DropTarget({ as = "div", children, className, dropTargetId, enabled, onDrop, range, style }: {
  as?: "div" | "li";
  children: ReactNode | ((state: { selected: boolean; x: number; y: number }) => ReactNode);
  className?: string;
  dropTargetId: string;
  enabled?: (payload: WorkbenchDragPayload) => boolean;
  onDrop: (payload: WorkbenchDragPayload, point: { x: number; y: number }) => void;
  range?: { x?: number; y?: number };
  style?: CSSProperties;
}) {
  const controller = useWorkbenchDragController();
  const boundary = useContext(DropTargetBoundaryContext);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [registration, setRegistration] = useState<WorkbenchDropTargetHandle | null>(null);
  const enabledRef = useRef(enabled);
  const onDropRef = useRef(onDrop);
  enabledRef.current = enabled;
  onDropRef.current = onDrop;
  const rangeX = range?.x;
  const rangeY = range?.y;
  useEffect(() => {
    if (!element) return;
    const registration = controller.registerTarget({
      boundary,
      dropTargetId,
      element,
      enabled: (payload) => enabledRef.current?.(payload) ?? true,
      onDrop: (payload, point) => onDropRef.current(payload, point),
      range: { x: rangeX, y: rangeY },
    });
    setRegistration(registration);
    return () => { registration.unregister(); };
  }, [boundary, controller, dropTargetId, element, rangeX, rangeY]);
  const subscribe = useCallback((listener: () => void) => registration?.subscribe(listener) ?? EMPTY_UNSUBSCRIBE, [registration]);
  const getSnapshot = useCallback(() => registration?.getSnapshot() ?? IDLE_TARGET_SNAPSHOT, [registration]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const rendered = typeof children === "function" ? children(snapshot) : children;
  const Element = as;
  return <Element className={className} ref={setElement} style={style}>{rendered}</Element>;
}
