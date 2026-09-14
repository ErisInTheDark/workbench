/*
 * Keywords: draft, React, hydration, lifecycle.
 * Exports:
 * - useDraftSession: bind a keyed form to its shared editing session.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

import DraftSessionController, { type DraftSessionContent, type DraftSessionPorts } from "./DraftSessionController";

export function useDraftSession<Draft extends DraftSessionContent>(draft: Draft, ports: DraftSessionPorts<Draft>) {
  const [session] = useState(() => new DraftSessionController(draft, ports));
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  useEffect(() => {
    session.attach();
    return () => session.detach();
  }, [session]);
  useEffect(() => { session.receive(draft); }, [draft, session]);
  return { session, ...snapshot };
}
