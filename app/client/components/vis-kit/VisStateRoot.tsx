/*
 * Exports:
 * - default VisStateRoot: the root a vis build mounts every page under, so id'd controls and `useVisState` read and
 *   write the frame's synced `wb.state`.
 */
import type { ReactNode } from "react";
import { ControlStateContext } from "../ui/control-state";
import "./vis-bridge";

export default function VisStateRoot({ children }: { children: ReactNode }) {
  return <ControlStateContext.Provider value={window.wb?.state ?? null}>{children}</ControlStateContext.Provider>;
}
