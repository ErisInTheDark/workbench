/*
 * Exports:
 * - default VisProviders: give real Workbench components in a vis mockup the contexts they read (workspace client,
 *   mounted Workbench client, memory app state, context menus), all answered from one VisWorld on a fake app socket.
 *   Render any real component inside it; the strip above names queries or commands the world does not model yet.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { WorkbenchClient } from "../../WorkbenchClient";
import { createWorkspaceClientFixture, type WorkspaceTestSocket } from "../../workbench/app/workspace-client-fixture";
import WorkbenchClientStateController from "../../workbench/state/WorkbenchClientStateController";
import WorkbenchClientProvider from "../workbench/WorkbenchClientProvider";
import WorkbenchClientStateProvider from "../workbench/WorkbenchClientStateProvider";
import WorkbenchContextMenuProvider from "../workbench/WorkbenchContextMenuProvider";
import WorkbenchWorkspaceContext, { WorkbenchOperationsContext } from "../workbench/WorkbenchWorkspaceContext";
import type { ProjectLocationReference } from "workbench-shared/workbench/project/project-location";
import VisAppServer from "./vis-app-server";
import type VisWorld from "./vis-world";

const NONE: readonly string[] = [];
const noSubscription = () => () => {};

function mount(world: VisWorld) {
  const fixture = createWorkspaceClientFixture({ linger: expire => { const timer = setTimeout(expire, 5_000); return () => clearTimeout(timer); } });
  const state = new WorkbenchClientStateController({ mode: "memory", schemaVersion: world.appState(1).schemaVersion });
  const client = WorkbenchClient({ workspace: fixture.workspace, clientStateController: state });
  let server: VisAppServer | null = null;
  const ready = fixture.open().then((socket: WorkspaceTestSocket) => { server = new VisAppServer(socket, world); });
  return {
    fixture, state, client, ready, server: () => server,
    dispose() { client.dispose(); state.dispose(); server?.dispose(); fixture.dispose(); },
  };
}

function Unhandled({ server }: { server: VisAppServer | null }) {
  const unhandled = useSyncExternalStore(server?.subscribe ?? noSubscription, server?.getUnhandled ?? (() => NONE));
  if (!unhandled.length) return null;
  return <div role="status" className="mb-2 rounded-md bg-amber-500/10 px-2 py-1 text-[0.72rem] text-amber-700 dark:text-amber-300">
    Not modelled by this vis world: {unhandled.join(", ")}
  </div>;
}

/** `folder` scopes daemon operations (menus, hover cards) to that folder, as the git sidebar does. */
export default function VisProviders({ world, folder, children }: { world: VisWorld; folder?: string; children: ReactNode }) {
  const [mounted, setMounted] = useState<ReturnType<typeof mount> | null>(null);
  const [server, setServer] = useState<VisAppServer | null>(null);
  useEffect(() => {
    const next = mount(world);
    let live = true;
    void next.ready.then(() => { if (live) { setServer(next.server()); setMounted(next); } });
    return () => { live = false; next.dispose(); };
  }, [world]);
  if (!mounted) return null;
  const location: ProjectLocationReference | null = folder ? world.location(folder) : null;
  const operations = location ? mounted.fixture.workspace.daemon({ kind: "folder", location }) : null;
  return <>
    <Unhandled server={server} />
    <WorkbenchWorkspaceContext.Provider value={mounted.fixture.workspace}>
      <WorkbenchClientStateProvider controller={mounted.state}>
        <WorkbenchClientProvider client={{ controls: null, mounted: mounted.client }}>
          <WorkbenchOperationsContext.Provider value={operations}>
            <WorkbenchContextMenuProvider>{children}</WorkbenchContextMenuProvider>
          </WorkbenchOperationsContext.Provider>
        </WorkbenchClientProvider>
      </WorkbenchClientStateProvider>
    </WorkbenchWorkspaceContext.Provider>
  </>;
}
