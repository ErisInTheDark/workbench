/*
 * Exports:
 * - WorkbenchDropTargetRegistration/WorkbenchDropTargetHandle/WorkbenchDropTargetSnapshot: target registration and scoped live-selection contracts. Keywords: drag, drop, pointer, target.
 * - WorkbenchDragActivitySnapshot/WorkbenchDragSnapshot: stable lifecycle and live-coordinate snapshots. Keywords: drag, activity, pointer, snapshot.
 * - default WorkbenchDragController: own pointer threshold, cached target resolution, scoped notifications, body state, click suppression, and cleanup. Keywords: controller, lifecycle, boundary.
 */
import type { WorkbenchDragPayload, WorkbenchThreadDragPreview } from "./workbench-drag";

export interface WorkbenchDropTargetRegistration {
  boundary: HTMLElement | null;
  dropTargetId: string;
  element: HTMLElement;
  enabled?: (payload: WorkbenchDragPayload) => boolean;
  onDrop: (payload: WorkbenchDragPayload, point: { x: number; y: number }) => void;
  preview?: (payload: WorkbenchDragPayload) => WorkbenchThreadDragPreview | null;
  range?: { x?: number; y?: number };
  selectionPriority?: number;
}

export interface WorkbenchDropTargetSnapshot {
  selected: boolean;
  x: number;
  y: number;
}

export interface WorkbenchDropTargetHandle {
  getSnapshot: () => WorkbenchDropTargetSnapshot;
  registrationId: number;
  subscribe: (listener: () => void) => () => void;
  unregister: () => void;
}

export interface WorkbenchDragActivitySnapshot {
  active: boolean;
  label: string;
  payload: WorkbenchDragPayload | null;
}

export interface WorkbenchDragSnapshot {
  active: boolean;
  label: string;
  payload: WorkbenchDragPayload | null;
  selectedRegistrationId: number | null;
  targetPreview: WorkbenchThreadDragPreview | null;
  x: number;
  y: number;
}

interface RegisteredTarget extends WorkbenchDropTargetRegistration {
  listeners: Set<() => void>;
  registrationId: number;
  snapshot: WorkbenchDropTargetSnapshot;
}

interface TargetGeometry {
  rect: DOMRect;
  target: RegisteredTarget;
}

const IDLE_ACTIVITY_SNAPSHOT: WorkbenchDragActivitySnapshot = { active: false, label: "", payload: null };
const IDLE_SNAPSHOT: WorkbenchDragSnapshot = { active: false, label: "", payload: null, selectedRegistrationId: null, targetPreview: null, x: 0, y: 0 };
const IDLE_TARGET_SNAPSHOT: WorkbenchDropTargetSnapshot = { selected: false, x: 0, y: 0 };

export default class WorkbenchDragController {
  private activitySnapshot = IDLE_ACTIVITY_SNAPSHOT;
  private allowedTargetIds = new Set<string>();
  private bodyState: Record<"cursor" | "userSelect", string> | null = null;
  private geometryCache: TargetGeometry[] | null = null;
  private nextRegistrationId = 1;
  private pending: { label: string; payload: WorkbenchDragPayload; startX: number; startY: number } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private snapshot = IDLE_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private readonly targets = new Map<number, RegisteredTarget>();

  readonly getActivitySnapshot = () => this.activitySnapshot;
  readonly getSnapshot = () => this.snapshot;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  registerTarget(target: WorkbenchDropTargetRegistration): WorkbenchDropTargetHandle {
    const registrationId = this.nextRegistrationId++;
    const registeredTarget: RegisteredTarget = {
      ...target,
      listeners: new Set(),
      registrationId,
      snapshot: IDLE_TARGET_SNAPSHOT,
    };
    this.targets.set(registrationId, registeredTarget);
    this.invalidateGeometry();
    if (this.snapshot.active) this.refreshGeometryObservation();
    let registered = true;
    return {
      getSnapshot: () => registeredTarget.snapshot,
      registrationId,
      subscribe: (listener) => {
        registeredTarget.listeners.add(listener);
        return () => { registeredTarget.listeners.delete(listener); };
      },
      unregister: () => {
        if (!registered) return;
        registered = false;
        if (this.snapshot.selectedRegistrationId === registrationId) {
          this.update({ ...this.snapshot, selectedRegistrationId: null });
        }
        this.targets.delete(registrationId);
        registeredTarget.listeners.clear();
        this.invalidateGeometry();
        if (this.snapshot.active) this.refreshGeometryObservation();
      },
    };
  }

  begin(event: { button: number; clientX: number; clientY: number; pointerType?: string }, options: { dropTargetIds: readonly string[]; label: string; payload: WorkbenchDragPayload }) {
    if (event.button !== 0 || event.pointerType === "touch" || this.pending || this.snapshot.active) return false;
    this.allowedTargetIds = new Set(options.dropTargetIds);
    this.pending = { label: options.label, payload: options.payload, startX: event.clientX, startY: event.clientY };
    window.addEventListener("pointermove", this.handlePointerMove, { passive: false });
    window.addEventListener("pointerup", this.handlePointerUp, { once: true });
    window.addEventListener("pointercancel", this.handlePointerCancel, { once: true });
    return true;
  }

  cancel() { this.finish(); }

  dispose() {
    this.finish();
    for (const target of this.targets.values()) target.listeners.clear();
    this.targets.clear();
    this.listeners.clear();
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    if (!this.pending) return;
    if (!this.snapshot.active && Math.hypot(event.clientX - this.pending.startX, event.clientY - this.pending.startY) < 5) return;
    event.preventDefault();
    if (!this.snapshot.active) {
      this.installBodyState();
      this.installGeometryInvalidation();
    }
    const selected = this.resolveTarget(event.clientX, event.clientY);
    this.update({
      active: true,
      label: this.pending.label,
      payload: this.pending.payload,
      selectedRegistrationId: selected?.registrationId ?? null,
      targetPreview: selected?.preview?.(this.pending.payload) ?? null,
      x: event.clientX,
      y: event.clientY,
    });
  };

  private readonly handlePointerUp = (event: PointerEvent) => {
    const wasActive = this.snapshot.active;
    if (wasActive) event.preventDefault();
    const target = wasActive ? this.resolveTarget(event.clientX, event.clientY, true) : null;
    const payload = this.pending?.payload ?? null;
    this.finish();
    if (target && payload) target.onDrop(payload, { x: event.clientX, y: event.clientY });
    if (wasActive) window.addEventListener("click", this.suppressClick, { capture: true, once: true });
  };

  private readonly handlePointerCancel = () => { this.finish(); };
  private readonly invalidateGeometry = () => { this.geometryCache = null; };
  private readonly suppressClick = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };

  private resolveTarget(x: number, y: number, refresh = false) {
    if (refresh) this.invalidateGeometry();
    const geometry = this.getTargetGeometry();
    const hit = document.elementFromPoint(x, y);
    const closestBoundary = hit?.closest<HTMLElement>("[data-workbench-drop-target-boundary]") ?? null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestPriority = Number.NEGATIVE_INFINITY;
    let selected: RegisteredTarget | null = null;
    for (const { rect, target } of geometry) {
      if (!this.pending || target.enabled?.(this.pending.payload) === false) continue;
      const direct = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (!direct) {
        if (target.boundary && closestBoundary !== target.boundary) continue;
        const rangeX = target.range?.x ?? 0;
        const rangeY = target.range?.y ?? 0;
        if (x < rect.left - rangeX || x > rect.right + rangeX || y < rect.top - rangeY || y > rect.bottom + rangeY) continue;
      }
      const dx = Math.max(rect.left - x, 0, x - rect.right);
      const dy = Math.max(rect.top - y, 0, y - rect.bottom);
      const distance = Math.hypot(dx, dy);
      const priority = target.selectionPriority ?? 0;
      if (
        priority > bestPriority
        || (priority === bestPriority && distance < bestDistance)
        || (priority === bestPriority && distance === bestDistance && target.registrationId < (selected?.registrationId ?? Number.POSITIVE_INFINITY))
      ) {
        bestPriority = priority;
        bestDistance = distance;
        selected = target;
      }
    }
    return selected;
  }

  private finish() {
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    window.removeEventListener("pointercancel", this.handlePointerCancel);
    window.removeEventListener("resize", this.invalidateGeometry);
    window.removeEventListener("scroll", this.invalidateGeometry, true);
    this.pending = null;
    this.allowedTargetIds.clear();
    this.geometryCache = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.restoreBodyState();
    this.update(IDLE_SNAPSHOT);
  }

  private getTargetGeometry() {
    if (this.geometryCache) return this.geometryCache;
    this.geometryCache = [...this.targets.values()]
      .filter((target) => this.allowedTargetIds.has(target.dropTargetId))
      .map((target) => ({ rect: target.element.getBoundingClientRect(), target }));
    return this.geometryCache;
  }

  private installGeometryInvalidation() {
    this.invalidateGeometry();
    window.addEventListener("resize", this.invalidateGeometry);
    window.addEventListener("scroll", this.invalidateGeometry, true);
    this.refreshGeometryObservation();
  }

  private refreshGeometryObservation() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(this.invalidateGeometry);
    const observed = new Set<HTMLElement>();
    for (const target of this.targets.values()) {
      if (!observed.has(target.element)) {
        observed.add(target.element);
        this.resizeObserver.observe(target.element);
      }
      if (target.boundary && !observed.has(target.boundary)) {
        observed.add(target.boundary);
        this.resizeObserver.observe(target.boundary);
      }
    }
  }

  private installBodyState() {
    this.bodyState = {
      cursor: document.body.style.cursor,
      userSelect: document.body.style.userSelect,
    };
    Object.assign(document.body.style, { cursor: "grabbing", userSelect: "none" });
  }

  private restoreBodyState() {
    if (!this.bodyState) return;
    Object.assign(document.body.style, this.bodyState);
    this.bodyState = null;
  }

  private update(snapshot: WorkbenchDragSnapshot) {
    const previousSelectedRegistrationId = this.snapshot.selectedRegistrationId;
    this.snapshot = snapshot;
    this.activitySnapshot = snapshot.active && snapshot.payload
      ? this.activitySnapshot.active
        ? this.activitySnapshot
        : { active: true, label: snapshot.label, payload: snapshot.payload }
      : IDLE_ACTIVITY_SNAPSHOT;
    if (previousSelectedRegistrationId !== snapshot.selectedRegistrationId) {
      this.updateTargetSnapshot(previousSelectedRegistrationId, IDLE_TARGET_SNAPSHOT);
    }
    if (snapshot.selectedRegistrationId !== null) {
      this.updateTargetSnapshot(snapshot.selectedRegistrationId, {
        selected: true,
        x: snapshot.x,
        y: snapshot.y,
      });
    }
    for (const listener of this.listeners) listener();
  }

  private updateTargetSnapshot(registrationId: number | null, snapshot: WorkbenchDropTargetSnapshot) {
    if (registrationId === null) return;
    const target = this.targets.get(registrationId);
    if (!target) return;
    target.snapshot = snapshot;
    for (const listener of target.listeners) listener();
  }
}
