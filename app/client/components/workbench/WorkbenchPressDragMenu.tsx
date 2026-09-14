/*
 * Exports:
 * - default WorkbenchPressDragMenu: anchored menu with press-drag, click, touch and keyboard selection.
 * - PressDragMenuItem: stable action identity and its display content.
 */
"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { transitionPressDragMenu, type PressDragMenuEvent, type PressDragMenuState } from "./press-drag-menu-state";
import { positionWorkbenchPopover } from "./workbench-popover-geometry";
import WorkbenchMenuSurface from "./WorkbenchMenuSurface";
import WorkbenchMenuAction from "./WorkbenchMenuAction";

export interface PressDragMenuItem {
  id: string;
  content: ReactNode;
  checked?: boolean;
}

export default function WorkbenchPressDragMenu({
  children, label, getItems, onOpen, onSelect, onActivate,
}: {
  children: ReactNode;
  label: string;
  getItems: () => readonly PressDragMenuItem[];
  onOpen: () => void;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
  onActivate: (trigger: HTMLButtonElement) => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const [menu, setMenu] = useState<{ interaction: PressDragMenuState; items: readonly PressDragMenuItem[] }>({
    interaction: { kind: "closed" }, items: [],
  });
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const open = menu.interaction.kind !== "closed";
  const activeId = menu.interaction.kind === "closed" ? null : menu.interaction.activeId;
  const activeIndex = menu.items.findIndex(item => item.id === activeId);

  useLayoutEffect(() => {
    if (menu.interaction.kind === "open" && position?.visibility !== "hidden") popup.current?.focus({ preventScroll: true });
  }, [menu.interaction.kind, position?.visibility]);

  function releaseCapture() {
    if (menu.interaction.kind === "dragging" && trigger.current?.hasPointerCapture(menu.interaction.pointerId)) {
      trigger.current.releasePointerCapture(menu.interaction.pointerId);
    }
  }

  function dispatch(event: PressDragMenuEvent) {
    const result = transitionPressDragMenu(menu.interaction, event);
    setMenu(current => ({ ...current, interaction: result.state }));
    if (result.state.kind !== "dragging") releaseCapture();
    if (result.selectedId !== null && trigger.current) {
      if (event.kind !== "release") trigger.current.focus({ preventScroll: true });
      onSelect(result.selectedId, trigger.current);
    }
    if (result.activate && trigger.current) onActivate(trigger.current);
  }

  function begin(event: Extract<PressDragMenuEvent, { kind: "press" | "open" }>) {
    if (!trigger.current) return;
    // Blur before opening so its cancellation cannot close the new drag.
    // Pointer capture owns drag input; focus could inherit the editor's focus-visible state.
    if (event.kind === "press") trigger.current.blur();
    const items = getItems();
    const viewport = window.visualViewport;
    const bounds = positionWorkbenchPopover(trigger.current.getBoundingClientRect(), {
      width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
      left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
    }, { width: 440, height: 480, align: "end" });
    setPosition({ ...bounds, height: "auto", maxHeight: bounds.height, visibility: "hidden" });
    setMenu({ interaction: transitionPressDragMenu(menu.interaction, event).state, items });
    if (event.kind === "open") trigger.current.focus({ preventScroll: true });
    onOpen();
  }

  function hit(x: number, y: number) {
    const target = document.elementFromPoint(x, y);
    const row = target?.closest<HTMLElement>("[data-menu-row]");
    return row && popup.current?.contains(row) ? row.dataset.menuRow ?? null : null;
  }

  function keyboard(event: ReactKeyboardEvent<HTMLElement>) {
    if (!["ArrowUp", "ArrowDown", "Home", "End", "Enter", " ", "Escape", "Tab"].includes(event.key)) return;
    if (event.key !== "Tab") event.preventDefault();
    if (!open && event.key !== "Escape" && event.key !== "Tab") {
      if (event.key === "Enter" || event.key === " ") {
        if (trigger.current) onActivate(trigger.current);
        return;
      }
      const items = getItems();
      begin({ kind: "open", activeId: event.key === "ArrowUp" || event.key === "End" ? items.at(-1)?.id ?? null : items[0]?.id ?? null });
      return;
    }
    const action = { kind: "key" as const, key: event.key, ids: menu.items.map(item => item.id) };
    dispatch(action);
    if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
      const next = transitionPressDragMenu(menu.interaction, action).state;
      const index = next.kind === "closed" ? -1 : menu.items.findIndex(item => item.id === next.activeId);
      popup.current?.children[index]?.scrollIntoView({ block: "nearest" });
    }
  }

  useLayoutEffect(() => {
    if (!open || !popup.current) return;
    if (position?.visibility === "hidden" && trigger.current) {
      const viewport = window.visualViewport;
      const rect = popup.current.getBoundingClientRect();
      setPosition(positionWorkbenchPopover(trigger.current.getBoundingClientRect(), {
        width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight,
        left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
      }, { width: rect.width, height: rect.height, align: "end" }));
      return;
    }
    popup.current.scrollTop = popup.current.scrollHeight;
    if (activeIndex >= 0) popup.current.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [open, menu.items, position?.visibility]);

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
      aria-haspopup={open ? "menu" : "dialog"}
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      className={`
        enabled:cursor-pointer relative isolate inline-flex min-w-0 items-center justify-center gap-2 rounded-lg touch-none select-none bg-transparent px-2.5 py-2 text-fg/muted outline-none transition hover:text-text
        before:pointer-events-none before:absolute before:inset-1 before:-z-10 before:rounded-lg before:transition-colors before:content-[''] enabled:hover:before:bg-button-hover
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
        onActivate(event.currentTarget);
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
      style={{ ...position, zIndex: 60 }}
      className="overflow-y-auto overscroll-contain outline-none"
    >
      {menu.items.map((item, index) => <WorkbenchMenuAction
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
      ><span className="block w-full min-w-0">{item.content}</span></WorkbenchMenuAction>)}
    </WorkbenchMenuSurface>, document.body) : null}
  </>;
}
