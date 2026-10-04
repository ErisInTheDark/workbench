/*
 * Exports:
 * - default MobilePaneSwipeController: recognise guarded mobile pane swipes and remember the last editor route.
 */

import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import {
  getMobileExplorerRoute,
  getPreferredMobilePane,
  type MobilePane,
} from "../state/mobile-pane-url-state";

interface SwipePoint {
  touchId: number;
  touchCount: number;
  x: number;
  y: number;
  timeMs: number;
}

interface SwipeStart extends SwipePoint {
  browseProjectId: string;
  eligibleTarget: boolean;
  pane: MobilePane;
  route: WorkbenchRoute;
  viewportWidth: number;
}

interface ActiveSwipe extends SwipeStart {
  horizontal: boolean;
}

const DWELL_CANCEL_MS = 400;
const START_DISTANCE_PX = 8;
const COMPLETE_FRACTION = 0.25;
const HORIZONTAL_DOMINANCE = 1.5;

export default class MobilePaneSwipeController {
  private currentRoute: WorkbenchRoute | null = null;
  private lastEditorRoute: WorkbenchRoute | null = null;
  private active: ActiveSwipe | null = null;

  observeRoute(route: WorkbenchRoute) {
    if (this.currentRoute !== route) this.cancel();
    this.currentRoute = route;
    if (getPreferredMobilePane(true, route) === "editor") this.lastEditorRoute = route;
  }

  start(start: SwipeStart) {
    this.cancel();
    if (!start.eligibleTarget || start.touchCount !== 1 || start.viewportWidth <= 0) return false;
    if (start.pane === "editor" && start.x > start.viewportWidth * 0.6) return false;
    if (start.pane === "explorer" && (start.x < start.viewportWidth * 0.4 || !this.lastEditorRoute)) return false;
    this.active = { ...start, horizontal: false };
    return true;
  }

  move(point: SwipePoint): number | null {
    const active = this.active;
    if (!active) return null;
    if (point.touchCount !== 1 || point.touchId !== active.touchId) {
      this.cancel();
      return null;
    }
    if (!active.horizontal) {
      if (point.timeMs - active.timeMs >= DWELL_CANCEL_MS) {
        this.cancel();
        return null;
      }
      const dx = Math.abs(point.x - active.x);
      const dy = Math.abs(point.y - active.y);
      if (Math.hypot(dx, dy) < START_DISTANCE_PX) return null;
      if (dy >= START_DISTANCE_PX && dy >= dx * HORIZONTAL_DOMINANCE) {
        this.cancel();
        return null;
      }
      if (dx < START_DISTANCE_PX || dx < dy * HORIZONTAL_DOMINANCE) return null;
      active.horizontal = true;
    }
    const delta = point.x - active.x;
    return active.pane === "editor"
      ? Math.min(active.viewportWidth, Math.max(0, delta))
      : Math.max(-active.viewportWidth, Math.min(0, delta));
  }

  finish(point: SwipePoint): WorkbenchRoute | null {
    this.move(point);
    const active = this.active;
    this.cancel();
    if (!active?.horizontal) return null;
    const dx = point.x - active.x;
    const dy = Math.abs(point.y - active.y);
    if (Math.abs(dx) < active.viewportWidth * COMPLETE_FRACTION
      || Math.abs(dx) < dy * HORIZONTAL_DOMINANCE) return null;
    if (active.pane === "editor" && dx > 0) {
      return getMobileExplorerRoute(active.route, active.browseProjectId);
    }
    if (active.pane === "explorer" && dx < 0) return this.lastEditorRoute;
    return null;
  }

  cancel() { this.active = null; }

  dispose() {
    this.cancel();
    this.currentRoute = null;
    this.lastEditorRoute = null;
  }
}
