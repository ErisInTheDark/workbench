/*
 * Exports:
 * - WorkbenchContextMenuItem: menu item contract for document context menu actions. Keywords: context menu, item, action.
 * - WorkbenchContextMenuDefinition: menu definition opened by context-menu capabilities. Keywords: context menu, definition.
 * - WorkbenchContextMenuRequest: pointer-positioned menu open request. Keywords: context menu, position, request.
 * - useWorkbenchContextMenu: read the document context menu controller from React context. Keywords: context menu, hook, controller.
 * - default WorkbenchContextMenuProvider: own and render the active document context menu. Keywords: context menu, provider, document.
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const CONTEXT_MENU_VIEWPORT_PADDING = 8;

export interface WorkbenchContextMenuItem {
  disabled?: boolean;
  icon?: ReactNode;
  id: string;
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
}

export interface WorkbenchContextMenuDefinition {
  id: string;
  items: WorkbenchContextMenuItem[];
  label: string;
}

export interface WorkbenchContextMenuRequest {
  menu: WorkbenchContextMenuDefinition;
  x: number;
  y: number;
}

interface ActiveWorkbenchContextMenu extends WorkbenchContextMenuRequest {
  generation: number;
}

interface WorkbenchContextMenuController {
  closeContextMenu: () => void;
  openContextMenu: (request: WorkbenchContextMenuRequest) => void;
}

const WorkbenchContextMenuContext = createContext<WorkbenchContextMenuController | null>(null);

function clampMenuPosition(value: number, size: number, viewportSize: number) {
  return Math.max(
    CONTEXT_MENU_VIEWPORT_PADDING,
    Math.min(value, viewportSize - size - CONTEXT_MENU_VIEWPORT_PADDING),
  );
}

function WorkbenchContextMenuSurface ({
  menu,
  onClose,
}: {
  menu: ActiveWorkbenchContextMenu;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) {
      setPosition({ left: menu.x, top: menu.y });
      return;
    }

    const rect = element.getBoundingClientRect();
    setPosition({
      left: clampMenuPosition(menu.x, rect.width, window.innerWidth),
      top: clampMenuPosition(menu.y, rect.height, window.innerHeight),
    });
  }, [menu.generation, menu.x, menu.y]);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    function handleScrollIntent(event: TouchEvent | WheelEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return;
      }

      onClose();
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
    <div
      ref={menuRef}
      role="menu"
      aria-label={menu.menu.label}
      className="fixed z-50 min-w-48 max-w-[min(18rem,calc(100vw-1rem))] rounded-[1.25rem] bg-[color-mix(in_srgb,var(--bg)_90%,transparent)] p-1 text-sm shadow-float backdrop-blur-xl"
      style={{ left: position.left, top: position.top }}
    >
      {menu.menu.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          data-tone={item.tone ?? "default"}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-muted transition hover:bg-accent-soft hover:text-accent focus-visible:bg-accent-soft focus-visible:text-accent focus-visible:outline-none disabled:cursor-default disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted data-[tone=danger]:text-danger data-[tone=danger]:hover:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[tone=danger]:hover:text-danger data-[tone=danger]:focus-visible:bg-[color-mix(in_srgb,var(--danger)_14%,transparent)] data-[tone=danger]:focus-visible:text-danger"
          onClick={() => {
            if (item.disabled) {
              return;
            }

            onClose();
            item.onSelect();
          }}
        >
          {item.icon ? <span className="inline-flex size-4 shrink-0 items-center justify-center">{item.icon}</span> : null}
          <span className="min-w-0 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}

export function useWorkbenchContextMenu() {
  const controller = useContext(WorkbenchContextMenuContext);
  if (!controller) {
    throw new Error("useWorkbenchContextMenu must be used inside WorkbenchContextMenuProvider.");
  }

  return controller;
}

export default function WorkbenchContextMenuProvider ({ children }: { children: ReactNode }) {
  const generationRef = useRef(0);
  const [activeContextMenu, setActiveContextMenu] = useState<ActiveWorkbenchContextMenu | null>(null);

  const closeContextMenu = useCallback(() => {
    setActiveContextMenu(null);
  }, []);

  const openContextMenu = useCallback((request: WorkbenchContextMenuRequest) => {
    generationRef.current += 1;
    setActiveContextMenu({
      ...request,
      generation: generationRef.current,
    });
  }, []);

  const controller: WorkbenchContextMenuController = {
    closeContextMenu,
    openContextMenu,
  };

  return (
    <WorkbenchContextMenuContext.Provider value={controller}>
      {children}
      {activeContextMenu ? <WorkbenchContextMenuSurface menu={activeContextMenu} onClose={closeContextMenu} /> : null}
    </WorkbenchContextMenuContext.Provider>
  );
}
