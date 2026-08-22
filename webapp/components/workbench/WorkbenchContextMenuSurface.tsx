/*
 * Exports:
 * - WorkbenchContextMenuSurfaceProps: active menu placement and dismissal inputs. Keywords: context menu, placement, dismissal.
 * - default WorkbenchContextMenuSurface: render action rows, separators, and accessible grouped icon controls. Keywords: context menu, checkbox, radio, controls.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { getWorkbenchThreadStatusControlClassName } from "./workbench-thread-status-colors";
import type { WorkbenchContextMenuControl, WorkbenchContextMenuDefinition } from "./WorkbenchContextMenuContext";

const CONTEXT_MENU_VIEWPORT_PADDING = 8;

export interface WorkbenchContextMenuSurfaceProps {
  generation: number;
  menu: WorkbenchContextMenuDefinition;
  onClose: () => void;
  x: number;
  y: number;
}

function clampMenuPosition(value: number, size: number, viewportSize: number) {
  return Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    Math.min(value, viewportSize - size - CONTEXT_MENU_VIEWPORT_PADDING),
  );
}

const actionClassName = "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted data-[tone=danger]:text-danger data-[tone=danger]:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[tone=danger]:hover:text-danger data-[tone=danger]:focus-visible:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[tone=danger]:focus-visible:text-danger";
const controlClassName = "relative inline-flex h-9 min-w-0 flex-1 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-muted transition-[background-color,border-color,color,opacity] hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:!text-muted disabled:hover:!text-muted data-[checked=true]:border-[color-mix(in_srgb,currentColor_55%,transparent)] data-[checked=true]:bg-[color-mix(in_srgb,currentColor_12%,transparent)] data-[checked=true]:text-accent data-[checked=true]:hover:bg-[color-mix(in_srgb,currentColor_16%,transparent)] data-[checked=true]:focus-visible:bg-[color-mix(in_srgb,currentColor_16%,transparent)]";

function getControlToneClassName(tone: WorkbenchContextMenuControl["tone"]) {
  if (tone === "danger") return "!text-danger hover:!text-danger focus-visible:!text-danger";
  if (tone === "default") return "";
  return getWorkbenchThreadStatusControlClassName(tone);
}

export default function WorkbenchContextMenuSurface({
  generation,
  menu,
  onClose,
  x,
  y,
}: WorkbenchContextMenuSurfaceProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      setPosition({ left: x, top: y });
      return;
    }

    const rect = element.getBoundingClientRect();
    setPosition({
      left: clampMenuPosition(x, rect.width, window.innerWidth),
      top: clampMenuPosition(y, rect.height, window.innerHeight),
    });
  }, [generation, x, y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    function handleScrollIntent(event: TouchEvent | WheelEvent) {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    }

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", onClose);
    window.addEventListener("touchmove", handleScrollIntent, { capture: true, passive: true });
    window.addEventListener("wheel", handleScrollIntent, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("touchmove", handleScrollIntent, true);
      window.removeEventListener("wheel", handleScrollIntent, true);
    };
  }, [onClose]);

  const select = (disabled: boolean | undefined, onSelect: () => void) => {
    if (disabled) return;
    onClose();
    onSelect();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={menu.label}
      className="fixed z-50 min-w-48 max-w-[min(18rem,calc(100vw-1rem))] rounded-[1.25rem] bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] p-1 text-sm shadow-float backdrop-blur-xl"
      style={{ left: position.left, top: position.top }}
    >
      {menu.items.map((item) => {
        if (item.kind === "separator") {
          return <div key={item.id} role="separator" className="mx-2 my-1 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]" />;
        }

        if (item.kind === "control-group") {
          const role = item.presentation === "connected" ? "menuitemradio" : "menuitemcheckbox";
          return (
            <div key={item.id} className="px-2 py-1.5" role="group" aria-label={item.label}>
              <div className="mb-1 px-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-muted">{item.label}</div>
              <div className="flex w-full items-center gap-1">
                {item.controls.map((control) => (
                  <button
                    key={control.id}
                    type="button"
                    role={role}
                    aria-checked={control.checked}
                    aria-label={control.label}
                    title={control.label}
                    disabled={control.disabled}
                    data-checked={control.checked}
                    data-tone={control.tone ?? "default"}
                    className={`${controlClassName} ${getControlToneClassName(control.tone)}`}
                    onClick={() => select(control.disabled, control.onSelect)}
                  >
                    <span className="inline-flex size-4 items-center justify-center">{control.icon}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        }

        return (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            data-tone={item.tone ?? "default"}
            className={actionClassName}
            onClick={() => select(item.disabled, item.onSelect)}
          >
            {item.icon ? <span className="inline-flex size-4 shrink-0 items-center justify-center">{item.icon}</span> : null}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
