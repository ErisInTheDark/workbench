/*
 * Exports:
 * - default PressDragMenu: fit-content anchored menu (centred by default, opening above or below by room) with press-drag, click, touch and keyboard selection, and an optional heading.
 * - PressDragMenuItem/PressDragMenuGroup: stable action and optional grouped navigation content.
 * - getPressDragGroupItems: items available from a saved-open group.
 */
"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ChevronIcon from "../workbench/ChevronIcon";
import { transitionPressDragMenu, type PressDragMenuEvent, type PressDragMenuState } from "./press-drag-menu-state";
import { positionWorkbenchPopover } from "../workbench/workbench-popover-geometry";
import WorkbenchMenuAction from "../workbench/WorkbenchMenuAction";
import WorkbenchMenuSurface from "../workbench/WorkbenchMenuSurface";

export interface PressDragMenuItem {
  id: string;
  content: ReactNode;
  checked?: boolean;
}

export interface PressDragMenuGroup {
  id: string;
  label: string;
  navigation?: ReactNode;
  open?: boolean;
  items: readonly PressDragMenuItem[];
}

export function getPressDragGroupItems (group: PressDragMenuGroup): readonly PressDragMenuItem[] {
  return group.open === false ? [] : group.items;
}

const menuMaxWidth = 440;
const menuMaxHeight = 480;

function viewportBounds () {
  const viewport = window.visualViewport;
  return {
    width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
    left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
  };
}

type MenuPlacement = { style: CSSProperties; below: boolean };

export default function PressDragMenu ({
  children, label, heading, getItems, items: suppliedItems, groups, groupNavigationLabel = "Menu sections", onOpen, onSelect, onActivate, triggerAppearance = "default", triggerClassName, align = "center", disabled = false,
}: {
  children: ReactNode;
  label: string;
  /** Title shown above an ungrouped item list. */
  heading?: string;
  align?: "center" | "end";
  disabled?: boolean;
  getItems?: () => readonly PressDragMenuItem[];
  items?: readonly PressDragMenuItem[];
  groups?: readonly PressDragMenuGroup[];
  groupNavigationLabel?: string;
  onOpen?: () => void;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
  onActivate?: (trigger: HTMLButtonElement) => void;
  triggerAppearance?: "default" | "plain";
  triggerClassName?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const hoveredGroup = useRef<string | null>(null);
  const menuId = useId();
  const [menu, setMenu] = useState<{ interaction: PressDragMenuState; items: readonly PressDragMenuItem[] }>({
    interaction: { kind: "closed" }, items: [],
  });
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);
  const open = menu.interaction.kind !== "closed";
  const items = useMemo(() => groups?.flatMap(getPressDragGroupItems) ?? suppliedItems ?? menu.items,
    [groups, suppliedItems, menu.items]);
  const activeId = menu.interaction.kind === "closed" ? null : menu.interaction.activeId;
  const activeIndex = items.findIndex(item => item.id === activeId);

  useLayoutEffect(() => {
    if (menu.interaction.kind === "open" && placement?.style.visibility !== "hidden") popup.current?.focus({ preventScroll: true });
  }, [menu.interaction.kind, placement?.style.visibility]);

  function place (trigger: HTMLButtonElement, natural: { width: number; height: number }): MenuPlacement {
    const anchor = trigger.getBoundingClientRect();
    const viewport = viewportBounds();
    const bounds = positionWorkbenchPopover(anchor, viewport, { ...natural, align, side: "auto" });
    return {
      style: {
        left: bounds.left, top: bounds.top, maxHeight: bounds.height,
        width: "max-content", maxWidth: Math.min(menuMaxWidth, viewport.width - 24),
      },
      below: bounds.top >= anchor.top + anchor.height,
    };
  }

  function releaseCapture () {
    if (menu.interaction.kind === "dragging" && trigger.current?.hasPointerCapture(menu.interaction.pointerId)) {
      trigger.current.releasePointerCapture(menu.interaction.pointerId);
    }
  }

  function dispatch (event: PressDragMenuEvent) {
    const result = transitionPressDragMenu(menu.interaction, event, onActivate ? "action" : "menu");
    setMenu(current => ({ ...current, interaction: result.state }));
    if (result.state.kind !== "dragging") releaseCapture();
    if (result.selectedId !== null && items.some(item => item.id === result.selectedId) && trigger.current) {
      if (event.kind !== "release") trigger.current.focus({ preventScroll: true });
      onSelect(result.selectedId, trigger.current);
    }
    if (result.activate && trigger.current) onActivate?.(trigger.current);
  }

  function begin (event: Extract<PressDragMenuEvent, { kind: "press" | "open" }>) {
    if (!trigger.current) return;
    // Blur before opening so its cancellation cannot close the new drag.
    // Pointer capture owns drag input; focus could inherit the editor's focus-visible state.
    if (event.kind === "press") trigger.current.blur();
    const items = groups?.flatMap(getPressDragGroupItems) ?? suppliedItems ?? getItems?.() ?? [];
    // Render unplaced and hidden first; the layout effect measures natural size, then places it.
    setPlacement({ style: { left: 0, top: 0, width: "max-content", maxWidth: Math.min(menuMaxWidth, viewportBounds().width - 24), maxHeight: menuMaxHeight, visibility: "hidden" }, below: false });
    setMenu({ interaction: transitionPressDragMenu(menu.interaction, event).state, items });
    hoveredGroup.current = null;
    if (event.kind === "open") trigger.current.focus({ preventScroll: true });
    onOpen?.();
  }

  function hit (x: number, y: number) {
    const target = document.elementFromPoint(x, y);
    const row = target?.closest<HTMLElement>("[data-menu-row]");
    return row && popup.current?.contains(row) ? row.dataset.menuRow ?? null : null;
  }

  function scrollToGroup (id: string) {
    const scroll = popup.current;
    const section = [...(scroll?.querySelectorAll<HTMLElement>("[data-menu-section]") ?? [])]
      .find(candidate => candidate.dataset.menuSection === id);
    if (scroll && section) scroll.scrollTop += section.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  }

  function hoverGroup (x: number, y: number) {
    const target = document.elementFromPoint(x, y);
    const button = target?.closest<HTMLElement>("[data-menu-group]");
    const id = button && popup.current?.contains(button) ? button.dataset.menuGroup ?? null : null;
    if (id && id !== hoveredGroup.current) scrollToGroup(id);
    hoveredGroup.current = id;
  }

  function keyboard (event: ReactKeyboardEvent<HTMLElement>) {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter", " ", "Escape", "Tab"].includes(event.key)) return;
    if (event.key !== "Tab") event.preventDefault();
    if (!open && event.key !== "Escape" && event.key !== "Tab") {
      if (onActivate && (event.key === "Enter" || event.key === " ")) {
        if (trigger.current) onActivate(trigger.current);
        return;
      }
      const items = groups?.flatMap(getPressDragGroupItems) ?? suppliedItems ?? getItems?.() ?? [];
      begin({ kind: "open", activeId: event.key === "ArrowUp" || event.key === "End" ? items.at(-1)?.id ?? null : items[0]?.id ?? null });
      return;
    }
    const action = { kind: "key" as const, key: event.key, ids: items.map(item => item.id) };
    dispatch(action);
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
      const next = transitionPressDragMenu(menu.interaction, action).state;
      const index = next.kind === "closed" ? -1 : items.findIndex(item => item.id === next.activeId);
      popup.current?.querySelectorAll<HTMLElement>("[data-menu-row]")[index]?.scrollIntoView({ block: "nearest" });
    }
  }

  useLayoutEffect(() => {
    const element = popup.current;
    if (!open || !element) return;
    const unplaced = placement?.style.visibility === "hidden";
    let below = placement?.below ?? false;
    // Live catalogues can arrive after an initially empty menu, so supplied
    // items are re-placed from their natural size rather than the first box.
    if ((unplaced || suppliedItems || groups) && trigger.current) {
      const next = place(trigger.current, {
        width: element.getBoundingClientRect().width,
        height: Math.min(menuMaxHeight, element.scrollHeight),
      });
      below = next.below;
      setPlacement(next);
    }
    // Start at the end nearest the trigger.
    if (!groups || unplaced) element.scrollTop = below ? 0 : element.scrollHeight;
    if (activeIndex >= 0) element.querySelectorAll<HTMLElement>("[data-menu-row]")[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, items, placement?.style.visibility]);

  useEffect(() => {
    if (!open) return;
    const cancel = () => {
      setMenu(current => ({ ...current, interaction: { kind: "closed" } }));
      releaseCapture();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !popup.current?.contains(event.target) && !trigger.current?.contains(event.target)) cancel();
    };
    const scroll = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        trigger.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("scroll", scroll, true);
    window.visualViewport?.addEventListener("resize", cancel);
    window.visualViewport?.addEventListener("scroll", cancel);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("scroll", scroll, true);
      window.visualViewport?.removeEventListener("resize", cancel);
      window.visualViewport?.removeEventListener("scroll", cancel);
    };
  }, [open, menu.interaction]);

  return <>
    <button
      ref={trigger}
      type="button"
      aria-label={label}
      title={label}
      aria-haspopup={open || !onActivate ? "menu" : "dialog"}
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      disabled={disabled}
      className={`
        enabled:cursor-pointer relative isolate inline-flex min-w-0 items-center touch-none select-none outline-none transition
        ${triggerAppearance === "default" ? `
          justify-center gap-2 rounded-lg bg-transparent px-2.5 py-2 hover:text-text
          before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover
        ` : ""}
        ${triggerClassName ?? "text-fg/muted"}
        ${menu.interaction.kind === "dragging" ? "" : "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-soft"}
      `}
      onPointerDown={event => {
        if (event.button !== 0 || menu.interaction.kind === "dragging") return;
        event.preventDefault();
        begin({ kind: "press", pointerId: event.pointerId, x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        if (menu.interaction.kind !== "dragging") return;
        if (groups) hoverGroup(event.clientX, event.clientY);
        dispatch({ kind: "move", pointerId: event.pointerId, x: event.clientX, y: event.clientY, id: hit(event.clientX, event.clientY) });
      }}
      onPointerUp={event => {
        const box = event.currentTarget.getBoundingClientRect();
        dispatch({
          kind: "release", pointerId: event.pointerId, x: event.clientX, y: event.clientY, id: hit(event.clientX, event.clientY),
          onTrigger: event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom,
        });
      }}
      onPointerCancel={event => {
        if (menu.interaction.kind === "dragging" && menu.interaction.pointerId === event.pointerId) dispatch({ kind: "cancel" });
      }}
      onLostPointerCapture={event => {
        // Functional update observes the completed release before the browser's capture-loss event.
        const pointerId = event.pointerId;
        setMenu(current => current.interaction.kind === "dragging" && current.interaction.pointerId === pointerId ? { ...current, interaction: { kind: "closed" } } : current);
      }}
      onClick={event => {
        // Physical clicks already completed on pointerup; retain assistive click activation.
        if (event.detail !== 0) return;
        dispatch({ kind: "cancel" });
        if (onActivate) onActivate(event.currentTarget);
        else begin({ kind: "open", activeId: null });
      }}
      onBlur={event => {
        if (!(event.relatedTarget instanceof Node) || !popup.current?.contains(event.relatedTarget)) dispatch({ kind: "cancel" });
      }}
      onKeyDown={keyboard}
    >{children}</button>
    {open ? createPortal(<WorkbenchMenuSurface
      ref={popup}
      id={menuId}
      tabIndex={-1}
      aria-label={label}
      aria-activedescendant={activeIndex >= 0 ? `${menuId}-${activeIndex}` : undefined}
      onKeyDown={keyboard}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && (popup.current?.contains(event.relatedTarget) || trigger.current?.contains(event.relatedTarget))) return;
        dispatch({ kind: "cancel" });
      }}
      style={{ ...placement?.style, zIndex: 60 }}
      className={groups ? "scrollbar-hover-reveal grid min-h-0 grid-cols-[2.5rem_minmax(0,1fr)] items-start overflow-y-auto overscroll-contain outline-none" : "overflow-y-auto overscroll-contain outline-none"}
    >
      {groups ? <>
        <div className="h-[calc(100%+var(--spacing)*4)] bg-fg/3 -ml-1 -my-2 col-1 row-1"></div>
        <nav aria-label={groupNavigationLabel} className="col-1 row-1 scrollbar-hover-reveal sticky bottom-0 flex max-h-[min(30rem,calc(100vh-1.5rem))] flex-col items-center self-end overflow-y-auto overscroll-contain">
          {groups.filter(group => group.navigation !== undefined).map(group => <button
            key={group.id}
            type="button"
            data-menu-group={group.id}
            tabIndex={-1}
            aria-label={group.label}
            title={group.label}
            className="enabled:cursor-pointer flex size-9 shrink-0 items-center justify-center rounded-lg text-fg/muted hover:bg-button-hover hover:text-text"
            onPointerDown={event => event.preventDefault()}
            onPointerMove={() => { if (menu.interaction.kind === "open") scrollToGroup(group.id); }}
            onClick={() => scrollToGroup(group.id)}
          >{group.navigation}</button>)}
        </nav>
        <div className="min-w-0">
          {groups.map(group => <section key={group.id} data-menu-section={group.id} role="group" aria-label={group.label} className="pb-2 last:-mb-2">
            {group.open === false ? null : getPressDragGroupItems(group).length ? getPressDragGroupItems(group).map(item => {
              const index = items.findIndex(candidate => candidate.id === item.id);
              return <WorkbenchMenuAction
                key={item.id}
                id={`${menuId}-${index}`}
                data-menu-row={item.id}
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                tabIndex={-1}
                highlighted={activeId === item.id}
                onPointerDown={event => { if (event.pointerType !== "touch") event.preventDefault(); }}
                onPointerMove={event => { if (event.pointerType !== "touch" && menu.interaction.kind === "open") dispatch({ kind: "highlight", id: item.id }); }}
                onClick={() => dispatch({ kind: "select", id: item.id })}
              ><span className="block w-full min-w-0">{item.content}</span></WorkbenchMenuAction>;
            }) : <p className="m-0 px-3 py-2 text-xs text-fg/muted">No models here yet.</p>}
            <div className="flex items-center gap-2 px-3 py-2 text-[0.68rem] font-semibold uppercase tracking-widest text-fg/muted">
              {typeof group.open === "boolean" ? <ChevronIcon
                aria-hidden="true"
                className={`shrink-0 ${group.open ? "rotate-180" : "-rotate-90"}`}
                size={16}
              /> : null}
              <span>{group.label}</span><span className="h-px min-w-2 flex-1 bg-[color-mix(in_srgb,var(--text)_12%,transparent)]" />
            </div>
          </section>)}
        </div>
      </> : <>{heading ? <p className="m-0 px-3 py-2 text-[0.68rem] font-semibold uppercase tracking-widest text-fg/muted">{heading}</p> : null}
      {items.map((item, index) => <WorkbenchMenuAction
        key={item.id}
        id={`${menuId}-${index}`}
        data-menu-row={item.id}
        role={item.checked === undefined ? "menuitem" : "menuitemradio"}
        aria-checked={item.checked}
        tabIndex={-1}
        highlighted={activeId === item.id}
        onPointerDown={event => { if (event.pointerType !== "touch") event.preventDefault(); }}
        onPointerMove={event => { if (event.pointerType !== "touch" && menu.interaction.kind === "open") dispatch({ kind: "highlight", id: item.id }); }}
        onClick={() => dispatch({ kind: "select", id: item.id })}
      ><span className="block w-full min-w-0">{item.content}</span></WorkbenchMenuAction>)}</>}
    </WorkbenchMenuSurface>, document.body) : null}
  </>;
}
