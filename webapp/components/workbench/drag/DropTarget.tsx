/*
 * Exports:
 * - default DropTarget: register one typed target with optional proximity range and selected-state rendering. Keywords: drop, target, range, selected.
 */
"use client";

import { useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";

import type { WorkbenchDragPayload } from "../../../lib/workbench/layout/workbench-drag";
import { DropTargetBoundaryContext, useWorkbenchDragController } from "./workbench-drag-context";

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
  const [registrationId, setRegistrationId] = useState<number | null>(null);
  const enabledRef = useRef(enabled);
  const onDropRef = useRef(onDrop);
  enabledRef.current = enabled;
  onDropRef.current = onDrop;
  const rangeX = range?.x;
  const rangeY = range?.y;
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
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
    setRegistrationId(registration.registrationId);
    return registration.unregister;
  }, [boundary, controller, dropTargetId, element, rangeX, rangeY]);
  const rendered = typeof children === "function"
    ? children({ selected: snapshot.selectedRegistrationId === registrationId, x: snapshot.x, y: snapshot.y })
    : children;
  const Element = as;
  return <Element className={className} ref={setElement} style={style}>{rendered}</Element>;
}
