/*
 * Exports:
 * - default MobilePaneTrack: present finger-follow navigation between the mobile explorer and editor panes.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Touch as ReactTouch, type TouchEvent } from "react";
import type { WorkbenchRoute } from "workbench-shared/workbench/navigation/workbench-route";
import MobilePaneSwipeController from "../../workbench/navigation/MobilePaneSwipeController";
import { getPreferredMobilePane, type MobilePane } from "../../workbench/state/mobile-pane-url-state";

const BLOCKED_TARGETS = "input,textarea,select,button,a,label,summary,[contenteditable],[role='button'],[role='link'],[role='textbox'],[role='combobox'],[role='slider'],[role='spinbutton'],[role='switch']";

interface Motion {
  dragging: boolean;
  positionPx: number;
  targetPane: MobilePane | null;
}

function canStartSwipe(target: EventTarget | null, boundary: HTMLElement) {
  if (!(target instanceof Element) || target.closest(BLOCKED_TARGETS)) return false;
  let current: Element | null = target;
  while (current && current !== boundary) {
    if (current instanceof HTMLElement) {
      const style = getComputedStyle(current);
      if (style.touchAction === "none") return false;
      if (current.scrollWidth > current.clientWidth + 1
        && (style.overflowX === "auto" || style.overflowX === "scroll")) return false;
    }
    current = current.parentElement;
  }
  return current === boundary;
}

function touchPoint(touch: ReactTouch, timeMs: number) {
  return {
    touchId: touch.identifier,
    touchCount: 1,
    x: touch.clientX,
    y: touch.clientY,
    timeMs,
  };
}

function clampPosition(positionPx: number, width: number) {
  return Math.min(0, Math.max(-width, positionPx));
}

export default function MobilePaneTrack({ browseProjectId, children, isMobile, navigateToRoute, pane, route }: {
  browseProjectId: string;
  children: ReactNode;
  isMobile: boolean;
  navigateToRoute: (destination: WorkbenchRoute) => void;
  pane: MobilePane;
  route: WorkbenchRoute;
}) {
  const [controller] = useState(() => new MobilePaneSwipeController());
  const [motion, setMotion] = useState<Motion | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragOriginX = useRef<number | null>(null);
  const gestureStarted = useRef(false);
  const pendingNavigation = useRef<WorkbenchRoute | null>(null);
  const pendingNavigationFrame = useRef<number | null>(null);
  const previousRoute = useRef(route);

  const cancelPendingNavigation = () => {
    pendingNavigation.current = null;
    if (pendingNavigationFrame.current !== null) {
      window.cancelAnimationFrame(pendingNavigationFrame.current);
      pendingNavigationFrame.current = null;
    }
  };
  const commitPendingNavigation = () => {
    const destination = pendingNavigation.current;
    if (!destination) return;
    cancelPendingNavigation();
    const previousHref = window.location.href;
    navigateToRoute(destination);
    if (window.location.href === previousHref) setMotion(null);
  };

  useLayoutEffect(() => {
    controller.observeRoute(route);
    if (previousRoute.current !== route) {
      cancelPendingNavigation();
      dragOriginX.current = null;
      gestureStarted.current = false;
      const destinationPane = getPreferredMobilePane(true, route);
      setMotion(current => current?.targetPane === destinationPane ? current : null);
      previousRoute.current = route;
    }
  }, [controller, route]);
  useEffect(() => {
    if (!motion?.targetPane || motion.targetPane !== pane) return;
    const target = pane === "explorer" ? 0 : -window.innerWidth;
    if (Math.abs((trackRef.current?.getBoundingClientRect().left ?? target) - target) < 1) {
      setMotion(null);
    }
  }, [motion?.targetPane, pane]);
  useEffect(() => {
    const cancel = () => {
      controller.cancel();
      cancelPendingNavigation();
      dragOriginX.current = null;
      gestureStarted.current = false;
      setMotion(null);
    };
    window.addEventListener("resize", cancel);
    return () => window.removeEventListener("resize", cancel);
  }, [controller]);
  useEffect(() => () => {
    cancelPendingNavigation();
    controller.dispose();
  }, [controller]);

  const stop = () => {
    controller.cancel();
    cancelPendingNavigation();
    dragOriginX.current = null;
    gestureStarted.current = false;
    setMotion(null);
  };
  const move = (touch: ReactTouch, timeMs: number) => {
    const progress = controller.move(touchPoint(touch, timeMs));
    if (progress === null) {
      if (dragOriginX.current !== null) stop();
      return;
    }
    if (dragOriginX.current === null) {
      dragOriginX.current = trackRef.current?.getBoundingClientRect().left ?? (pane === "explorer" ? 0 : -window.innerWidth);
    }
    setMotion({
      dragging: true,
      positionPx: clampPosition(dragOriginX.current + progress, window.innerWidth),
      targetPane: null,
    });
  };
  const onTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    if (!isMobile || event.touches.length !== 1) {
      if (gestureStarted.current) stop();
      return;
    }
    if (motion?.targetPane && motion.targetPane !== pane) {
      controller.cancel();
      return;
    }
    const touch = event.touches[0]!;
    gestureStarted.current = controller.start({
      ...touchPoint(touch, event.timeStamp),
      browseProjectId,
      eligibleTarget: canStartSwipe(event.target, event.currentTarget),
      pane,
      route,
      viewportWidth: window.innerWidth,
    });
  };
  const onTouchMove = (event: TouchEvent<HTMLDivElement>) => {
    if (!gestureStarted.current) return;
    if (!isMobile || event.touches.length !== 1) {
      stop();
      return;
    }
    move(event.touches[0]!, event.timeStamp);
  };
  const onTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    if (!gestureStarted.current) return;
    if (!isMobile || event.touches.length !== 0 || event.changedTouches.length !== 1) {
      stop();
      return;
    }
    const touch = event.changedTouches[0]!;
    move(touch, event.timeStamp);
    const destination = controller.finish(touchPoint(touch, event.timeStamp));
    dragOriginX.current = null;
    gestureStarted.current = false;
    if (!destination) {
      setMotion(null);
      return;
    }
    const targetPane: MobilePane = pane === "editor" ? "explorer" : "editor";
    setMotion({
      dragging: false,
      positionPx: targetPane === "explorer" ? 0 : -window.innerWidth,
      targetPane,
    });
    pendingNavigation.current = destination;
    const targetPosition = targetPane === "explorer" ? 0 : -window.innerWidth;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches
      || Math.abs((trackRef.current?.getBoundingClientRect().left ?? targetPosition) - targetPosition) < 1) {
      commitPendingNavigation();
      return;
    }
    // Let the released transform paint once before fallback navigation.
    pendingNavigationFrame.current = window.requestAnimationFrame(() => {
      pendingNavigationFrame.current = window.requestAnimationFrame(() => {
        pendingNavigationFrame.current = null;
        commitPendingNavigation();
      });
    });
  };

  const transform = motion
    ? `translateX(${motion.positionPx}px)`
    : pane === "explorer" ? "translateX(0)" : "translateX(-50%)";
  return (
    <div
      ref={trackRef}
      className={`
        mobile-workbench-track flex h-dvh w-[200vw] overflow-hidden transition-transform duration-200 ease-out motion-reduce:transition-none
        md:contents md:h-auto md:w-auto md:overflow-visible md:transform-none
        ${motion?.dragging ? "transition-none" : ""}
        ${motion ? "will-change-transform" : ""}
      `}
      style={isMobile ? { transform } : undefined}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => { if (gestureStarted.current) stop(); }}
      onTransitionStart={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "transform"
          && motion?.targetPane) commitPendingNavigation();
      }}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && event.propertyName === "transform"
          && motion?.targetPane === pane) setMotion(null);
      }}
    >
      {children}
    </div>
  );
}
