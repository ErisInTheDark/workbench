/*
 * Exports:
 * - WorkbenchDropTargetRegistration/WorkbenchDragSnapshot: reusable target and observable drag lifecycle contracts. Keywords: drag, drop, pointer, target.
 * - default WorkbenchDragController: own pointer threshold, target resolution, global listeners, body state, click suppression, and cleanup. Keywords: controller, lifecycle, boundary.
 */
import type { WorkbenchDragPayload } from "./workbench-drag";

export interface WorkbenchDropTargetRegistration {
  boundary: HTMLElement | null;
  dropTargetId: string;
  element: HTMLElement;
  enabled?: (payload: WorkbenchDragPayload) => boolean;
  onDrop: (payload: WorkbenchDragPayload, point: { x: number; y: number }) => void;
  range?: { x?: number; y?: number };
}

interface RegisteredTarget extends WorkbenchDropTargetRegistration { registrationId: number }
export interface WorkbenchDragSnapshot {
  active: boolean;
  label: string;
  payload: WorkbenchDragPayload | null;
  selectedRegistrationId: number | null;
  x: number;
  y: number;
}

const IDLE_SNAPSHOT: WorkbenchDragSnapshot = { active: false, label: "", payload: null, selectedRegistrationId: null, x: 0, y: 0 };

export default class WorkbenchDragController {
  private allowedTargetIds = new Set<string>();
  private nextRegistrationId = 1;
  private pending: { label: string; payload: WorkbenchDragPayload; startX: number; startY: number } | null = null;
  private snapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly targets = new Map<number, RegisteredTarget>();
  private bodyState: Record<"cursor" | "overflow" | "overscrollBehavior" | "touchAction" | "userSelect", string> | null = null;

  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  registerTarget(target: WorkbenchDropTargetRegistration) {
    const registrationId = this.nextRegistrationId++;
    this.targets.set(registrationId, { ...target, registrationId });
    return {
      registrationId,
      unregister: () => {
        this.targets.delete(registrationId);
        if (this.snapshot.selectedRegistrationId === registrationId) this.update({ ...this.snapshot, selectedRegistrationId: null });
      },
    };
  }

  begin(event: { button: number; clientX: number; clientY: number }, options: { dropTargetIds: readonly string[]; label: string; payload: WorkbenchDragPayload }) {
    if (event.button !== 0 || this.pending || this.snapshot.active) return false;
    this.allowedTargetIds = new Set(options.dropTargetIds);
    this.pending = { label: options.label, payload: options.payload, startX: event.clientX, startY: event.clientY };
    window.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    window.addEventListener("pointerup", this.handlePointerUp, { once: true });
    window.addEventListener("pointercancel", this.handlePointerCancel, { once: true });
    return true;
  }

  cancel() { this.finish(null); }

  dispose() {
    this.finish(null);
    this.targets.clear();
    this.listeners.clear();
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.pending) return;
    if (!this.snapshot.active && Math.hypot(event.clientX - this.pending.startX, event.clientY - this.pending.startY) < 5) return;
    event.preventDefault();
    if (!this.snapshot.active) this.installBodyState();
    const selected = this.resolveTarget(event.clientX, event.clientY);
    this.update({
      active: true,
      label: this.pending.label,
      payload: this.pending.payload,
      selectedRegistrationId: selected?.registrationId ?? null,
      x: event.clientX,
      y: event.clientY,
    });
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    const wasActive = this.snapshot.active;
    if (wasActive) event.preventDefault();
    const target = wasActive ? this.resolveTarget(event.clientX, event.clientY) : null;
    const payload = this.pending?.payload ?? null;
    this.finish(target);
    if (target && payload) target.onDrop(payload, { x: event.clientX, y: event.clientY });
    if (wasActive) window.addEventListener("click", this.suppressClick, { capture: true, once: true });
  };

  private readonly handlePointerCancel = () => { this.finish(null); };
  private readonly suppressClick = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };

  private resolveTarget(x: number, y: number) {
    const hit = document.elementFromPoint(x, y);
    return [...this.targets.values()].filter((target) => {
      if (!this.pending || !this.allowedTargetIds.has(target.dropTargetId) || target.enabled?.(this.pending.payload) === false) return false;
      const rect = target.element.getBoundingClientRect();
      const direct = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (direct) return true;
      const boundaryHit = target.boundary
        ? hit?.closest<HTMLElement>("[data-workbench-drop-target-boundary]") === target.boundary
        : true;
      if (!boundaryHit) return false;
      const rangeX = target.range?.x ?? 0;
      const rangeY = target.range?.y ?? 0;
      return x >= rect.left - rangeX && x <= rect.right + rangeX && y >= rect.top - rangeY && y <= rect.bottom + rangeY;
    }).sort((left, right) => {
      const distance = (target: RegisteredTarget) => {
        const rect = target.element.getBoundingClientRect();
        const dx = Math.max(rect.left - x, 0, x - rect.right);
        const dy = Math.max(rect.top - y, 0, y - rect.bottom);
        return Math.hypot(dx, dy);
      };
      return distance(left) - distance(right) || left.registrationId - right.registrationId;
    })[0] ?? null;
  }

  private finish(_target: RegisteredTarget | null) {
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    this.pending = null;
    this.allowedTargetIds.clear();
    this.restoreBodyState();
    this.update(IDLE_SNAPSHOT);
  }

  private installBodyState() {
    this.bodyState = {
      cursor: document.body.style.cursor,
      overflow: document.body.style.overflow,
      overscrollBehavior: document.body.style.overscrollBehavior,
      touchAction: document.body.style.touchAction,
      userSelect: document.body.style.userSelect,
    };
    Object.assign(document.body.style, { cursor: "grabbing", overflow: "hidden", overscrollBehavior: "none", touchAction: "none", userSelect: "none" });
  }

  private restoreBodyState() {
    if (!this.bodyState) return;
    Object.assign(document.body.style, this.bodyState);
    this.bodyState = null;
  }

  private update(snapshot: WorkbenchDragSnapshot) {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
}
