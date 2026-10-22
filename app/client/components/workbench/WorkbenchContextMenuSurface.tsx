/*
 * Exports:
 * - WorkbenchContextMenuSurfaceProps: active menu placement and dismissal inputs.
 * - selectWorkbenchContextMenuControl: dispatch an enabled grouped control with its dismissal policy.
 * - default WorkbenchContextMenuSurface: render action rows (optionally hold-to-confirm), separators, accessible grouped icon
 *   controls and checklist trees.
 */
"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import { getWorkbenchThreadStatusControlClassName } from "./workbench-thread-status-colors";
import HoldConfirmationRail from "../ui/HoldConfirmationRail";
import useHoldToConfirm from "../ui/use-hold-to-confirm";
import type {
  WorkbenchContextMenuAction, WorkbenchContextMenuControl, WorkbenchContextMenuControlGroup, WorkbenchContextMenuDefinition,
} from "./WorkbenchContextMenuContext";
import WorkbenchMenuSurface from "./WorkbenchMenuSurface";
import WorkbenchMenuAction from "./WorkbenchMenuAction";
import { WorkbenchCheckboxMarker } from "./WorkbenchCheckbox";

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

const controlClassName = "relative inline-flex h-12 md:h-9 min-w-0 flex-1 items-center justify-center rounded-xl border border-[color-mix(in_srgb,var(--text)_10%,transparent)] text-fg/muted transition-[background-color,border-color,color,opacity] hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:!text-fg/muted disabled:hover:!text-fg/muted data-[checked=true]:border-[color-mix(in_srgb,currentColor_55%,transparent)] data-[checked=true]:bg-[color-mix(in_srgb,currentColor_12%,transparent)] data-[checked=true]:text-accent data-[checked=true]:hover:bg-[color-mix(in_srgb,currentColor_16%,transparent)] data-[checked=true]:focus-visible:bg-[color-mix(in_srgb,currentColor_16%,transparent)]";

function getControlToneClassName(tone: WorkbenchContextMenuControl["tone"]) {
  if (tone === "danger") return "!text-danger hover:!text-danger focus-visible:!text-danger";
  if (tone === "default") return "";
  return getWorkbenchThreadStatusControlClassName(tone);
}

export function selectWorkbenchContextMenuControl(
  group: WorkbenchContextMenuControlGroup,
  control: WorkbenchContextMenuControl,
  onClose: () => void,
) {
  if (control.disabled) return;
  if (group.closeOnSelect !== false) onClose();
  control.onSelect();
}

/** Hold-to-confirm actions fill a rail along their bottom edge while held, and select only once it fills. */
function ContextMenuActionRow({ action, onClose }: { action: WorkbenchContextMenuAction; onClose: () => void }) {
  const hold = useHoldToConfirm(action.holdToConfirmMs, Boolean(action.disabled));
  const danger = action.tone === "danger";
  return (
    <WorkbenchMenuAction
      {...hold.buttonProps({
        onClick: () => {
          if (action.disabled) return;
          onClose();
          action.onSelect();
        },
      })}
      disabled={action.disabled}
      data-tone={action.tone ?? "default"}
      className={hold.enabled ? `
        relative isolate touch-none select-none overflow-hidden [-webkit-touch-callout:none]
        hold-filled:![color:var(--app-bg-solid)] hold-filled:duration-200 hold-filled:ease-hold
        ${danger
          ? "[--hold-rail-fill:var(--danger)] [--hold-rail-track:color-mix(in_srgb,var(--danger)_18%,transparent)]"
          : "[--hold-rail-fill:var(--accent)] [--hold-rail-track:color-mix(in_srgb,var(--text)_10%,transparent)]"}
      ` : ""}
    >
      {action.icon ? <span className="inline-flex size-4 shrink-0 items-center justify-center">{action.icon}</span> : null}
      <span className="min-w-0 truncate">{action.label}</span>
      {hold.enabled ? <HoldConfirmationRail holding={hold.holding !== null} progress={hold.progressProps} /> : null}
    </WorkbenchMenuAction>
  );
}

export default function WorkbenchContextMenuSurface({
  generation,
  menu,
  onClose,
  x,
  y,
}: WorkbenchContextMenuSurfaceProps) {
  const backdropRef = useRef<HTMLButtonElement>(null);
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
      const target = event.target as Node;
      if (backdropRef.current?.contains(target)) return;
      if (!menuRef.current?.contains(target)) onClose();
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

  return (
    <>
      <button
        ref={backdropRef}
        type="button"
        aria-label="Close context menu"
        className="pointer-events-none fixed inset-0 z-50 cursor-default border-0 bg-transparent p-0 coarse-touch:pointer-events-auto coarse-touch:[background: color-mix(in srgb, var(--app-bg-solid), transparent 10%)]"
        tabIndex={-1}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <WorkbenchMenuSurface
        ref={menuRef}
        aria-label={menu.label}
        className={`
          left-(--context-menu-left) top-(--context-menu-top)
          min-w-48 max-w-[min(18rem,calc(100vw-1rem))]
          pb-[calc(0.25rem+min(0.75rem,var(--workbench-safe-area-bottom,0px)))]
          coarse-touch:bottom-0 coarse-touch:left-0 coarse-touch:right-0 coarse-touch:top-auto
          coarse-touch:w-full coarse-touch:max-h-[50dvh] coarse-touch:max-w-none
          coarse-touch:overflow-y-auto coarse-touch:overscroll-contain coarse-touch:rounded-b-none
        `}
        style={{
          "--context-menu-left": `${position.left}px`,
          "--context-menu-top": `${position.top}px`,
        } as CSSProperties}
      >
      {menu.items.map((item) => {
        if (item.kind === "separator") {
          return <div key={item.id} role="separator" className="mx-2 my-1 border-t border-[color-mix(in_srgb,var(--text)_10%,transparent)]" />;
        }

        if (item.kind === "checklist-tree") {
          return (
            <div key={item.id} className="py-1" role="group" aria-label={item.label}>
              <div className="px-3 pb-1 pt-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-fg/muted">{item.label}</div>
              <div className="scrollbar-hover-reveal max-h-60 overflow-y-auto overscroll-contain">
                {item.groups.map((group) => {
                  const enabled = group.items.filter((entry) => !entry.disabled);
                  const checkedCount = group.items.filter((entry) => entry.checked).length;
                  const groupChecked = checkedCount === group.items.length;
                  const mixed = checkedCount > 0 && !groupChecked;
                  // Ticking a group shows every folder; unticking hides only what may be hidden.
                  const targets = (groupChecked ? enabled.filter((entry) => entry.checked) : group.items.filter((entry) => !entry.checked))
                    .map((entry) => entry.id);
                  return (
                    <div key={group.id}>
                      <WorkbenchMenuAction
                        role="menuitemcheckbox"
                        aria-checked={mixed ? "mixed" : groupChecked}
                        disabled={!targets.length}
                        className="!py-1.5"
                        onClick={() => item.onToggle(targets, !groupChecked)}
                      >
                        <WorkbenchCheckboxMarker checked={groupChecked} indeterminate={mixed} disabled={!targets.length} />
                        <span className="min-w-0 flex-1 truncate font-medium text-text">{group.label}</span>
                      </WorkbenchMenuAction>
                      {group.items.map((entry) => (
                        <WorkbenchMenuAction
                          key={entry.id}
                          role="menuitemcheckbox"
                          aria-checked={entry.checked}
                          disabled={entry.disabled}
                          title={entry.title ?? entry.label}
                          className="!py-1.5 pl-9"
                          onClick={() => { if (!entry.disabled) item.onToggle([entry.id], !entry.checked); }}
                        >
                          <WorkbenchCheckboxMarker checked={entry.checked} disabled={entry.disabled} />
                          <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                          {entry.note ? <span className="shrink-0 text-[0.7rem] text-fg/muted">{entry.note}</span> : null}
                        </WorkbenchMenuAction>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        if (item.kind === "control-group") {
          const role = item.presentation === "actions" ? "menuitem" : item.presentation === "connected" ? "menuitemradio" : "menuitemcheckbox";
          return (
            <div key={item.id} className="px-2 py-1.5" role="group" aria-label={item.label}>
              <div className="mb-1 px-1 text-[0.65rem] font-semibold uppercase tracking-[0.16em] text-fg/muted">{item.label}</div>
              <div className="flex w-full items-center gap-1">
                {item.controls.map((control) => (
                  <button
                    key={control.id}
                    type="button"
                    role={role}
                    aria-checked={item.presentation === "actions" ? undefined : control.checked}
                    aria-label={control.label}
                    title={control.label}
                    disabled={control.disabled}
                    data-checked={control.checked}
                    data-tone={control.tone ?? "default"}
                    className={`enabled:cursor-pointer ${controlClassName} ${getControlToneClassName(control.tone)}`}
                    onClick={() => selectWorkbenchContextMenuControl(item, control, onClose)}
                  >
                    <span className="inline-flex size-4 items-center justify-center">{control.icon}</span>
                  </button>
                ))}
              </div>
            </div>
          );
        }

        return <ContextMenuActionRow key={item.id} action={item} onClose={onClose} />;
      })}
      </WorkbenchMenuSurface>
    </>
  );
}
