/*
 * Exports:
 * - WorkbenchEventMap: coarse non-authoritative workbench notifications shared across subclients. Keywords: workbench, events, notifications, coarse.
 * - WorkbenchEventType: event names emitted on the workbench-scoped event bus. Keywords: workbench, events, types.
 * - WorkbenchEventListener: subscriber signature for one coarse workbench event type. Keywords: workbench, events, subscribe.
 * - WorkbenchEventBus: small workbench-scoped event surface for cross-client notifications that do not own state. Keywords: workbench, event bus, cross-client.
 * - default WorkbenchEventBus: create the coarse event bus used by the coordinator and subclients. Keywords: workbench, event bus, create, default export.
 */

import type { SaveConflictPayload } from "../types";

export interface WorkbenchEventMap {
  fileOpened: {
    path: string;
    source: "draft" | "disk";
  };
  saveCompleted: {
    path: string;
    updatedAt: string;
  };
  saveConflictCleared: {
    path: string;
  };
  saveConflictSurfaced: SaveConflictPayload;
}

export type WorkbenchEventType = keyof WorkbenchEventMap;

export type WorkbenchEventListener<TEventType extends WorkbenchEventType> = (
  payload: WorkbenchEventMap[TEventType],
) => void;

interface WorkbenchEventBus {
  emit: <TEventType extends WorkbenchEventType>(
    type: TEventType,
    payload: WorkbenchEventMap[TEventType],
  ) => void;
  subscribe: <TEventType extends WorkbenchEventType>(
    type: TEventType,
    listener: WorkbenchEventListener<TEventType>,
  ) => () => void;
}

function WorkbenchEventBus(): WorkbenchEventBus {
  const listeners: {
    [TEventType in WorkbenchEventType]: Set<WorkbenchEventListener<TEventType>>;
  } = {
    fileOpened: new Set(),
    saveCompleted: new Set(),
    saveConflictCleared: new Set(),
    saveConflictSurfaced: new Set(),
  };

  return {
    emit: (type, payload) => {
      for (const listener of listeners[type]) {
        listener(payload);
      }
    },
    subscribe: (type, listener) => {
      listeners[type].add(listener);
      return () => {
        listeners[type].delete(listener);
      };
    },
  };
}

export default WorkbenchEventBus;