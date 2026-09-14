/*
 * Exports:
 * - default Draggable: declare a payload, ghost label, and accepted drop-target ids around arbitrary children. Keywords: drag, pointer, wrapper.
 */
"use client";

import type { DragEvent, DragEventHandler, PointerEvent, PointerEventHandler, ReactNode } from "react";

import type { WorkbenchDragPayload } from "../../../workbench/layout/workbench-drag";
import { useOptionalWorkbenchDragController } from "./workbench-drag-context";

export default function Draggable({ children, disabled = false, dropTargetIds, label, payload }: {
  children: ReactNode | ((props: {
    draggable: false;
    onDragStart: DragEventHandler<HTMLElement>;
    onPointerDown: PointerEventHandler<HTMLElement>;
  }) => ReactNode);
  disabled?: boolean;
  dropTargetIds: readonly string[];
  label: string;
  payload: WorkbenchDragPayload;
}) {
  const controller = useOptionalWorkbenchDragController();
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return;
    if (event.target instanceof HTMLElement && event.target.closest("button,input,textarea,select,[contenteditable='true']")) return;
    controller?.begin(event, { dropTargetIds, label, payload });
  };
  const onDragStart = (event: DragEvent<HTMLElement>) => { event.preventDefault(); };
  if (typeof children === "function") return children({ draggable: false, onDragStart, onPointerDown });
  return <div className="contents" draggable={false} onDragStart={onDragStart} onPointerDown={onPointerDown}>{children}</div>;
}
